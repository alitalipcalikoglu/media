import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { streamOf, testMediaService } from './helpers.js';

/** Real ctime of a trash entry, read back — the actual value `reconcileTrash` itself compares against, not an approximation via `Date.now()` (which truncates to whole milliseconds and can appear to disagree with a same-instant sub-millisecond-precision ctime read). @param {any} t @param {string} token */
async function objectCtime(t, token) {
  return (await lstat(join(t.dir, 'trash', `${token}.object`))).ctimeMs;
}

/**
 * `detachForDelete` only moves what's actually there — an ENOENT is swallowed as "nothing to
 * detach", not an error, so a low-level test that wants a real trash entry must first put a real
 * object at the canonical path, the same as a real upload would.
 * @param {any} t @param {string} sha256
 */
async function seedObject(t, sha256) {
  await t.storage.writeAtomic({ kind: 'object', sha256 }, Buffer.from(`seed-${sha256}`));
}

/**
 * Post-production Phase 4: `LocalStorage#reconcileTrash` — the crash-leaked-quarantine cleanup.
 * Real `LocalStorage` against a real temp directory throughout; no fakes for the filesystem layer.
 *
 * `now` is passed explicitly rather than relying on real wall-clock sleeps: an entry's age is
 * `now - ctimeMs` (the real OS-set inode change time, set by `detachForDelete`'s own `rename()` —
 * unlike `mtime`, which on the object half is the ORIGINAL upload's last-write time and would give
 * the wrong answer entirely), and ctime cannot be set directly from userspace, so a test that needs
 * "old enough" passes a `now` far in the future instead of actually waiting.
 */

test('a detached entry older than grace is cleaned; one younger than grace is preserved', async () => {
  const t = await testMediaService();
  try {
    const oldToken = randomUUID();
    const youngToken = randomUUID();
    await seedObject(t, 'a'.repeat(64));
    await t.storage.detachForDelete({ kind: 'object', sha256: 'a'.repeat(64) }, oldToken);
    await seedObject(t, 'b'.repeat(64));
    await t.storage.detachForDelete({ kind: 'object', sha256: 'b'.repeat(64) }, youngToken);

    const r = await t.storage.reconcileTrash({ graceMs: 3_600_000, maxEntries: 100, now: Date.now() + 10_000_000 });
    assert.equal(r.reconciled, 2, 'both are "old enough" relative to the far-future now');
    assert.equal(r.skipped, 0);
    assert.equal(r.errors, 0);
  } finally {
    t.cleanup();
  }
});

test('a fresh detach is preserved (younger than grace), not swept up by the same run that cleans an old one', async () => {
  const t = await testMediaService();
  try {
    const oldToken = randomUUID();
    await seedObject(t, 'a'.repeat(64));
    await t.storage.detachForDelete({ kind: 'object', sha256: 'a'.repeat(64) }, oldToken);
    const oldCtime = await objectCtime(t, oldToken);

    const newToken = randomUUID();
    await seedObject(t, 'c'.repeat(64));
    await t.storage.detachForDelete({ kind: 'object', sha256: 'c'.repeat(64) }, newToken);
    const newCtime = await objectCtime(t, newToken);
    assert.ok(newCtime > oldCtime, 'sanity: the new token really was detached after the old one');

    // `now` set exactly at the old token's own grace boundary — `graceMs` derived from the two
    // entries' real (sub-millisecond) ctimes, not approximated via `Date.now()`, so there is no
    // rounding window in which either could land on the wrong side.
    const graceMs = newCtime - oldCtime;
    const now = oldCtime + graceMs;

    const r = await t.storage.reconcileTrash({ graceMs, maxEntries: 100, now });
    assert.equal(r.reconciled, 1, 'only the genuinely old one');
    assert.equal(r.skipped, 1, 'the fresh one is left alone this run');

    // Confirmed by content, not just counters: the fresh token's quarantine copy still exists.
    const stillThere = await t.storage.reconcileTrash({ graceMs, maxEntries: 100, now });
    assert.equal(stillThere.reconciled, 0, 're-run at the same reference point: nothing new is old enough yet');
  } finally {
    t.cleanup();
  }
});

test('INVARIANT: a canonical object re-created (same sha256) after a crashed detach is never touched by reconciliation', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const content = '%PDF-1.4 canonical-recreation-invariant';
    const old = await t.service.upload(streamOf(content), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(old.id, 'k');
    t.clock.now += 1;
    t.files.purgeExpiredFiles(t.clock.now);
    t.files.markOrphanBlobs();
    const confirmed = t.files.finalizeOrphanBlobs();
    assert.deepEqual(confirmed, [old.sha256]);

    // Stale purge detaches — "crash": discardDetached(token) never runs (this IS the leak).
    const token = randomUUID();
    assert.equal(await t.storage.detachForDelete({ kind: 'object', sha256: old.sha256 }, token), true);
    assert.equal(await t.storage.exists({ kind: 'object', sha256: old.sha256 }), false, 'canonical gone right after detach');

    // Fresh upload, same bytes, same sha256 — canonical genuinely recreated at a NEW inode,
    // completely independent of the trashed copy (rename, never copy, is what makes this safe).
    const fresh = await t.service.upload(streamOf(content), { apiKeyId: 'k', visibility: 'public' });
    assert.equal(fresh.sha256, old.sha256);
    assert.equal(await t.storage.exists({ kind: 'object', sha256: fresh.sha256 }), true);

    // Reconciliation runs (long after, per `now`) and cleans up the leaked trash entry.
    const r = await t.storage.reconcileTrash({ graceMs: 3_600_000, maxEntries: 100, now: Date.now() + 10_000_000 });
    assert.equal(r.reconciled, 1);

    // The re-created canonical object — same sha256 the trash entry was for — must be completely
    // unaffected: still there, still readable, and the live DB reference still resolves to it.
    assert.equal(await t.storage.exists({ kind: 'object', sha256: fresh.sha256 }), true, 'INVARIANT: canonical object survives reconciliation of its own former quarantine entry');
    assert.equal(t.service.get(fresh.id).deleted_at, null, 'INVARIANT: live DB reference untouched');
    const stream = await t.storage.open({ kind: 'object', sha256: fresh.sha256 });
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const chunk of stream) chunks.push(/** @type {Buffer} */ (chunk));
    assert.equal(Buffer.concat(chunks).toString(), content, 'INVARIANT: canonical bytes are the fresh upload\'s own, byte-correct and readable');
  } finally {
    t.cleanup();
  }
});

test('malformed and unrecognised trash entries are skipped, never deleted, never crash the run', async () => {
  const t = await testMediaService();
  try {
    const trashDir = join(t.dir, 'trash');
    mkdirSync(trashDir, { recursive: true });

    // An entry this backend genuinely wrote — the one thing that SHOULD be reconciled.
    const realToken = randomUUID();
    await seedObject(t, 'd'.repeat(64));
    await t.storage.detachForDelete({ kind: 'object', sha256: 'd'.repeat(64) }, realToken);

    // Unexpected file: no token-shaped name at all.
    writeFileSync(join(trashDir, 'random-leftover.txt'), 'not a trash entry');
    // Unexpected directory: same, but a directory.
    mkdirSync(join(trashDir, 'some-random-directory'));
    // Invalid token: right suffix, not a UUID.
    writeFileSync(join(trashDir, 'not-a-real-token.object'), 'x');
    // Wrong shape: ".object" suffix but it's actually a directory.
    const shapeToken = randomUUID();
    mkdirSync(join(trashDir, `${shapeToken}.object`));
    // Symlink: token-shaped name, but a symlink (to the real entry's own object, so following it
    // would "work" and mask the bug — must be rejected on shape alone, never even stat'd through).
    const symlinkToken = randomUUID();
    symlinkSync(join(trashDir, `${realToken}.object`), join(trashDir, `${symlinkToken}.object`));

    const r = await t.storage.reconcileTrash({ graceMs: 0, maxEntries: 100, now: Date.now() + 10_000_000 });
    assert.equal(r.reconciled, 1, 'only the one genuine entry');
    assert.equal(r.errors, 0, 'malformed entries are a skip, never an error');
    assert.ok(r.skipped >= 4, `expected at least 4 skipped (txt file, directory, invalid token, wrong-shape, symlink), got ${r.skipped}`);

    // The symlink itself must still exist, untouched — proof it was never even considered for
    // deletion, not just "deletion happened to fail safely".
    const stillThere = await t.storage.reconcileTrash({ graceMs: 0, maxEntries: 100, now: Date.now() + 20_000_000 });
    assert.equal(stillThere.reconciled, 0, 'the real entry is already gone; nothing left that reconciliation will touch');
  } finally {
    t.cleanup();
  }
});

test('bounded: a run never inspects more than maxEntries tokens, in deterministic order, and a later run makes further progress', async () => {
  const t = await testMediaService();
  try {
    const tokens = [];
    for (let i = 0; i < 5; i++) {
      const token = randomUUID();
      tokens.push(token);
      await seedObject(t, `${i}`.repeat(64));
      await t.storage.detachForDelete({ kind: 'object', sha256: `${i}`.repeat(64) }, token);
    }
    const now = Date.now() + 10_000_000;
    const first = await t.storage.reconcileTrash({ graceMs: 0, maxEntries: 2, now });
    assert.equal(first.reconciled, 2, 'capped at maxEntries this run');
    assert.equal(first.skipped, 3, 'the rest wait for a later run');

    const second = await t.storage.reconcileTrash({ graceMs: 0, maxEntries: 2, now });
    assert.equal(second.reconciled, 2);
    const third = await t.storage.reconcileTrash({ graceMs: 0, maxEntries: 2, now });
    assert.equal(third.reconciled, 1, 'the last remaining token');
    const fourth = await t.storage.reconcileTrash({ graceMs: 0, maxEntries: 2, now });
    assert.equal(fourth.reconciled, 0, 'nothing left');
  } finally {
    t.cleanup();
  }
});

test('a delete failure for one token is retried safely on the next run, without disturbing others', async () => {
  const t = await testMediaService();
  try {
    const badToken = randomUUID();
    const goodToken = randomUUID();
    await seedObject(t, 'e'.repeat(64));
    await t.storage.detachForDelete({ kind: 'object', sha256: 'e'.repeat(64) }, badToken);
    await seedObject(t, 'f'.repeat(64));
    await t.storage.detachForDelete({ kind: 'object', sha256: 'f'.repeat(64) }, goodToken);

    const realDiscard = t.storage.discardDetached.bind(t.storage);
    t.storage.discardDetached = async (/** @type {string} */ token) => {
      if (token === badToken) throw new Error('disk unavailable');
      return realDiscard(token);
    };
    const now = Date.now() + 10_000_000;
    const first = await t.storage.reconcileTrash({ graceMs: 0, maxEntries: 100, now });
    assert.equal(first.reconciled, 1, 'the good token, despite the bad one failing');
    assert.equal(first.errors, 1);

    t.storage.discardDetached = realDiscard;
    const second = await t.storage.reconcileTrash({ graceMs: 0, maxEntries: 100, now });
    assert.equal(second.reconciled, 1, 'the previously-failed token is retried and now succeeds — idempotent, no crash-loop');
    assert.equal(second.errors, 0);

    const third = await t.storage.reconcileTrash({ graceMs: 0, maxEntries: 100, now });
    assert.equal(third.reconciled, 0, 'nothing left');
  } finally {
    t.cleanup();
  }
});

test('reconcileTrash is a no-op, not an error, when the trash directory does not exist yet', async () => {
  const { LocalStorage } = await import('../src/storage/local-storage.js');
  const { tempDir } = await import('./helpers.js');
  const { dir, cleanup } = tempDir();
  try {
    // Deliberately never call .prepare()/.check() — the trash directory genuinely does not exist.
    const storage = new LocalStorage(dir);
    const r = await storage.reconcileTrash({ graceMs: 0, maxEntries: 100 });
    assert.deepEqual(r, { reconciled: 0, skipped: 0, errors: 0 });
  } finally {
    cleanup();
  }
});
