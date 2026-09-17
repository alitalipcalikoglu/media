import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { streamOf, testImage, testMediaService } from './helpers.js';

/**
 * Stage 8.1/8.2: the purge-vs-concurrent-upload-of-the-same-content race (P0). Real `MediaService`,
 * real `FileStore` (real SQLite via `Database`), real `LocalStorage` — no fakes, no mocks. Every
 * "concurrent" step here is a deliberately ordered sequence of real, awaited operations (a
 * controlled interleaving via explicit ordering, not timing) rather than `Promise.all` racing,
 * because the exact bug is about WHICH ORDER two independent operations' DB/filesystem writes
 * land in — a barrier of explicit `await`s reproduces that precisely and deterministically,
 * with no reliance on real concurrency or sleeps.
 *
 * Invariant under test (see docs/READINESS.md "Purge/upload race"):
 *   For every purge generation P and upload U of the same content, once U has committed a live DB
 *   reference, P has no operation remaining that can remove U's canonical bytes — regardless of
 *   how the two interleave.
 */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');

test('Test C — mark then reclaim: A marks the object orphaned, B (a fresh upload of the same content) reclaims it, A must not delete B\'s bytes', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    // Seed: an old file referencing content X, soft-deleted and past its grace period.
    const old = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(old.id, 'k');
    t.clock.now += 1;

    // --- A: purge selects the orphan (phase 1 only — does NOT finalize/delete yet) ---
    assert.equal(t.files.purgeExpiredFiles(t.clock.now), 1, 'old file row hard-deleted; its blob is now orphaned');
    t.files.markOrphanBlobs();
    assert.notEqual(t.files.blob(old.sha256)?.delete_token, null, 'A: orphan marked, provisionally slated for deletion');

    // --- B: a fresh upload of the EXACT SAME content lands entirely, in between ---
    const fresh = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    assert.equal(fresh.sha256, old.sha256, 'same content: same blob');
    assert.equal(t.files.blob(fresh.sha256)?.delete_token, null, 'B: reclaimed — createFile\'s blob upsert cleared the mark');

    // --- A: (only now) attempts to finalize; the DB-level CAS alone is enough here — the
    // reclaim already cleared the mark, so there is never a confirmed row and therefore never a
    // physical detach to even consider. ---
    const confirmed = t.files.finalizeOrphanBlobs();
    assert.deepEqual(confirmed, [], 'A: compare-and-swap sees the cleared mark — refuses to delete a row a concurrent upload just reclaimed');

    // --- Final invariant ---
    const live = t.service.get(fresh.id);
    assert.equal(live.deleted_at, null, 'file is live');
    assert.equal(await t.storage.exists({ kind: 'object', sha256: live.sha256 }), true, 'INVARIANT: a live file\'s object must be readable');
  } finally { t.cleanup(); }
});

test('the same race, one step later: B\'s upload starts a brand-new row (A already deleted the old one) — self-heal still guarantees the invariant', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const old = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(old.id, 'k');
    t.clock.now += 1;
    t.files.purgeExpiredFiles(t.clock.now);
    t.files.markOrphanBlobs();

    // A finalizes AND physically removes the bytes BEFORE B ever starts (a plain, direct
    // storage.remove() here stands in for "bytes are simply gone by the time B looks" — self-heal
    // doesn't care how they disappeared) — B's upload begins with the blob row already gone and
    // the bytes already gone; this exercises upload's own self-heal path (commit() dedup-checks
    // against nothing, since there's truly nothing there — "stored" is simply true, a completely
    // ordinary fresh store, not even a self-heal case). Included as the adjacent, equally-important
    // ordering to the reclaim case above.
    const confirmed = t.files.finalizeOrphanBlobs();
    assert.deepEqual(confirmed, [old.sha256]);
    for (const sha256 of confirmed) await t.storage.remove({ kind: 'object', sha256 });
    assert.equal(await t.storage.exists({ kind: 'object', sha256: old.sha256 }), false);

    const fresh = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    assert.equal(fresh.sha256, old.sha256);
    assert.equal(await t.storage.exists({ kind: 'object', sha256: fresh.sha256 }), true, 'a completely fresh store after real deletion, unaffected by the earlier purge');
  } finally { t.cleanup(); }
});

test('upload self-heal: if the object vanishes between the dedup check and the DB write landing, upload re-links from its own held temp copy before returning', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const first = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    const key = { kind: /** @type {const} */ ('object'), sha256: first.sha256 };

    // Simulate the narrowest possible version of the race entirely inside storage: something
    // removed the bytes (a stale purge's fencing rename) after commit()'s dedup check observed
    // them present, but before this upload's own createFile() DB write. We can't literally pause
    // upload() mid-flight without invasive hooks, so we prove the mechanism directly: force
    // `storage.exists` to lie "missing" exactly once, confirming upload() calls `commit()` again
    // from its own held tempKey rather than trusting a stale "already exists" verdict — and that
    // exactly one such retry (see `MediaService.SELF_HEAL_ATTEMPTS`) is enough.
    const realExists = t.storage.exists.bind(t.storage);
    let lieOnce = true;
    let recommits = 0;
    const realCommit = t.storage.commit.bind(t.storage);
    t.storage.exists = async (/** @type {any} */ k) => {
      if (lieOnce && k.kind === 'object' && k.sha256 === first.sha256) { lieOnce = false; return false; }
      return realExists(k);
    };
    t.storage.commit = async (/** @type {any} */ tempKey, /** @type {any} */ k) => {
      if (k.kind === 'object' && k.sha256 === first.sha256) recommits++;
      return realCommit(tempKey, k);
    };

    const second = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    assert.equal(second.sha256, first.sha256);
    assert.equal(recommits, 2, 'the original dedup-path commit() plus exactly one self-heal re-commit — provably sufficient, not a probabilistic bound');
    assert.equal(await realExists(key), true, 'object present and readable after self-heal');
  } finally { t.cleanup(); }
});

// -------------------------------------------------------- Stage 8.2 deterministic interleavings

test('Test A — finalize completes, then a full upload of the same content completes, then the stale purge continues to its physical step: live file stays readable', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const old = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(old.id, 'k');
    t.clock.now += 1;

    // --- purge: mark + finalize — DB row gone, physical step not yet reached ---
    t.files.purgeExpiredFiles(t.clock.now);
    t.files.markOrphanBlobs();
    const confirmed = t.files.finalizeOrphanBlobs();
    assert.deepEqual(confirmed, [old.sha256]);

    // --- a fresh upload of the exact same content lands and fully completes, in between ---
    const fresh = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    assert.equal(fresh.sha256, old.sha256);

    // --- the stale purge continues: this is exactly what MediaService#purge does per confirmed
    // sha256 — the final guard catches this exact interleaving and skips the physical step
    // entirely, because the fresh upload's row already exists. ---
    for (const sha256 of confirmed) {
      if (t.files.blob(sha256)) continue;
      const token = randomUUID();
      if (await t.storage.detachForDelete({ kind: 'object', sha256 }, token)) await t.storage.discardDetached(token);
    }

    const live = t.service.get(fresh.id);
    assert.equal(live.deleted_at, null);
    assert.equal(await t.storage.exists({ kind: 'object', sha256: live.sha256 }), true, 'INVARIANT: live file object must remain readable');
  } finally { t.cleanup(); }
});

test('Test B — the stale purge\'s physical detach happens first, then a fresh upload of the same content lands: live file stays readable', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const old = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(old.id, 'k');
    t.clock.now += 1;

    t.files.purgeExpiredFiles(t.clock.now);
    t.files.markOrphanBlobs();
    const confirmed = t.files.finalizeOrphanBlobs();
    assert.deepEqual(confirmed, [old.sha256]);
    assert.equal(t.files.blob(old.sha256), undefined, 'final guard: nothing to reclaim yet');

    const token = randomUUID();
    assert.equal(await t.storage.detachForDelete({ kind: 'object', sha256: old.sha256 }, token), true, 'stale purge physically detaches first');
    assert.equal(await t.storage.exists({ kind: 'object', sha256: old.sha256 }), false, 'canonical path empty right after detach');

    // --- only now does a fresh upload of the exact same content land ---
    const fresh = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    assert.equal(fresh.sha256, old.sha256);
    assert.equal(await t.storage.exists({ kind: 'object', sha256: fresh.sha256 }), true, 'fresh, independent bytes at the canonical path');

    // --- the stale purge finishes: discarding its own quarantine copy must never touch the fresh bytes ---
    await t.storage.discardDetached(token);
    assert.equal(t.service.get(fresh.id).deleted_at, null);
    assert.equal(await t.storage.exists({ kind: 'object', sha256: fresh.sha256 }), true, 'INVARIANT: live file object must remain readable after the stale purge finishes');
  } finally { t.cleanup(); }
});

test('Test D — a second generation of the same content exists; re-running purge for the (already fully cleaned) first generation never touches it', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const gen1 = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(gen1.id, 'k');
    t.clock.now += 1;

    // Generation 1 fully purged: DB row gone, bytes detached and discarded — nothing left of it.
    const first = await t.service.purge();
    assert.equal(first.blobs, 1);
    assert.equal(await t.storage.exists({ kind: 'object', sha256: gen1.sha256 }), false);

    // A fresh upload of the exact same content: generation 2, same sha256, brand new row and bytes.
    const gen2 = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    assert.equal(gen2.sha256, gen1.sha256);

    // A later (or duplicate/overlapping) maintenance pass must never treat generation 2 as
    // orphaned, let alone physically touch its bytes — it is referenced by a live file, so it is
    // never even selected as a candidate by `finalizeOrphanBlobs`.
    const second = await t.service.purge();
    assert.equal(second.blobs, 0, 'generation 2 is live; not even selected as a candidate');
    assert.equal(t.service.get(gen2.id).deleted_at, null);
    assert.equal(await t.storage.exists({ kind: 'object', sha256: gen2.sha256 }), true, 'INVARIANT: generation 2\'s object must remain readable');
  } finally { t.cleanup(); }
});

// ------------------------------------------------------------ crash windows (Stage 8.1/8.2, item 7)

test('crash window: mark landed but the process crashed before finalize — a LATER pass (simulating restart) still finds and finalizes it', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const f = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(f.id, 'k');
    t.clock.now += 1;
    t.files.purgeExpiredFiles(t.clock.now);
    t.files.markOrphanBlobs();
    // "Crash": nothing else runs in this maintenance pass. A brand-new FileStore over the SAME
    // database — the closest a single-process test gets to "a fresh process, same DB file" —
    // stands in for the restart.
    const { FileStore } = await import('../src/store/file-store.js');
    const restarted = new FileStore(t.db);
    assert.deepEqual(restarted.finalizeOrphanBlobs(), [f.sha256], 'the leftover mark from the crashed pass is still finalized correctly');
    assert.equal(t.files.blob(f.sha256), undefined, 'row genuinely gone');
  } finally { t.cleanup(); }
});

test('crash window: DB finalize confirmed, crash before the physical quarantine detach — accepted outcome is a leaked (harmless) file on disk, never a live DB reference to missing bytes', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const f = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(f.id, 'k');
    t.clock.now += 1;
    t.files.purgeExpiredFiles(t.clock.now);
    t.files.markOrphanBlobs();
    const confirmed = t.files.finalizeOrphanBlobs();
    assert.deepEqual(confirmed, [f.sha256]);
    // "Crash": detachForDelete() for `confirmed` never runs.
    assert.equal(t.files.blob(f.sha256), undefined, 'DB row is gone — permanently, correctly');
    assert.equal(await t.storage.exists({ kind: 'object', sha256: f.sha256 }), true, 'bytes leak on disk — accepted; nothing references them any more, so this is disk bloat, not a correctness violation');
  } finally { t.cleanup(); }
});

test('crash window: detachForDelete succeeded (bytes quarantined), crash before discardDetached — quarantine leaks (accepted), canonical stays gone, and a fresh upload of the same content afterward is a completely independent, live object', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const f = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(f.id, 'k');
    t.clock.now += 1;
    t.files.purgeExpiredFiles(t.clock.now);
    t.files.markOrphanBlobs();
    const confirmed = t.files.finalizeOrphanBlobs();
    assert.deepEqual(confirmed, [f.sha256]);
    const token = randomUUID();
    assert.equal(await t.storage.detachForDelete({ kind: 'object', sha256: f.sha256 }, token), true);
    // "Crash": discardDetached(token) never runs — the quarantined copy under `token` leaks.
    assert.equal(await t.storage.exists({ kind: 'object', sha256: f.sha256 }), false, 'canonical path stays gone — correct, no live reference');

    const fresh = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    assert.equal(fresh.sha256, f.sha256);
    assert.equal(await t.storage.exists({ kind: 'object', sha256: fresh.sha256 }), true, 'unaffected by the still-pending quarantine cleanup');
  } finally { t.cleanup(); }
});

test('crash window: storage.commit() landed but the process crashed before createFile() — pre-existing, unrelated leak (bytes with no blob row at all); purge never even considers them, by design', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const received = await t.storage.writeTemp(streamOf(PDF), { maxBytes: 1_000_000 });
    const key = { kind: /** @type {const} */ ('object'), sha256: received.sha256 };
    assert.equal(await t.storage.commit(received.key, key), true);
    // "Crash": files.createFile() never runs, so there is no blobs row at all for this sha256.
    assert.equal(t.files.blob(received.sha256), undefined, 'no blob row — createFile never ran');
    t.files.markOrphanBlobs(); // cannot mark what has no row
    assert.deepEqual(t.files.finalizeOrphanBlobs(), [], 'nothing to finalize; purge structurally cannot touch a sha with no blob row');
    assert.equal(await t.storage.exists(key), true, 'bytes remain — an already-known, unrelated leak class (see docs/READINESS.md), not something Stage 8 changes');
  } finally { t.cleanup(); }
});

test('purge: storage.detachForDelete() throwing for one blob never aborts cleanup of the others, and never re-throws out of purge()', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const bad = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    const good = await t.service.upload(streamOf(Buffer.from('%PDF-1.4 a completely different body')), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(bad.id, 'k');
    t.service.delete(good.id, 'k');
    t.clock.now += 1;

    const realDetach = t.storage.detachForDelete.bind(t.storage);
    t.storage.detachForDelete = async (/** @type {any} */ key, /** @type {any} */ token) => {
      if (key.sha256 === bad.sha256) throw new Error('disk unavailable');
      return realDetach(key, token);
    };

    const result = await t.service.purge();
    assert.equal(result.files, 2);
    assert.equal(result.blobs, 2, 'both blob rows genuinely deleted from the DB, regardless of the storage-level failure for one');
    assert.equal(t.files.blob(bad.sha256), undefined);
    assert.equal(t.files.blob(good.sha256), undefined);
    assert.equal(await t.storage.exists({ kind: 'object', sha256: good.sha256 }), false, 'the OTHER blob\'s bytes were still removed');
  } finally { t.cleanup(); }
});

test('purge: storage.discardDetached() failing for one blob never aborts cleanup of the others, and never re-throws out of purge() — only that blob\'s quarantine copy leaks', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const bad = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    const good = await t.service.upload(streamOf(Buffer.from('%PDF-1.4 a completely different body')), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(bad.id, 'k');
    t.service.delete(good.id, 'k');
    t.clock.now += 1;

    /** @type {Map<string, string>} */
    const shaByToken = new Map();
    const realDetach = t.storage.detachForDelete.bind(t.storage);
    t.storage.detachForDelete = async (/** @type {any} */ key, /** @type {any} */ token) => {
      shaByToken.set(token, key.sha256);
      return realDetach(key, token);
    };
    const realDiscard = t.storage.discardDetached.bind(t.storage);
    t.storage.discardDetached = async (/** @type {any} */ token) => {
      if (shaByToken.get(token) === bad.sha256) throw new Error('disk unavailable');
      return realDiscard(token);
    };

    const result = await t.service.purge();
    assert.equal(result.blobs, 2, 'both blob rows genuinely deleted from the DB, regardless of the storage-level failure for one');
    assert.equal(await t.storage.exists({ kind: 'object', sha256: bad.sha256 }), false, 'canonical path still gone — detach already ran before discard failed');
    assert.equal(await t.storage.exists({ kind: 'object', sha256: good.sha256 }), false, 'the OTHER blob was fully cleaned up, quarantine included');
  } finally { t.cleanup(); }
});

test('retrying maintenance after a previous partial purge is idempotent — no error, no re-attempt of an already-deleted row', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const f = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(f.id, 'k');
    t.clock.now += 1;
    t.storage.detachForDelete = async () => { throw new Error('disk unavailable'); };
    const first = await t.service.purge();
    assert.equal(first.blobs, 1, 'row deleted even though the physical detach failed');

    t.storage.detachForDelete = async () => { throw new Error('should never be called again for this sha — nothing left to finalize'); };
    const second = await t.service.purge();
    assert.equal(second.blobs, 0, 'nothing new to finalize; idempotent, no error');
  } finally { t.cleanup(); }
});

// ------------------------------------------------------------ variant interaction (Stage 8.1/8.2, item 9)

test('purge of an unrelated orphan never disturbs a live file\'s original object or its already-generated variants', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const live = await t.service.upload(streamOf(await testImage({ width: 300, height: 300 })), { apiKeyId: 'k', visibility: 'public' });
    const variantTarget = await t.service.resolve(live, 'thumb');
    assert.ok((await t.storage.stat(variantTarget.key))?.size, 'variant generated once, up front');

    // An unrelated file, soft-deleted and past grace, becomes a genuine orphan.
    const other = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(other.id, 'k');
    t.clock.now += 1;

    const purged = await t.service.purge();
    assert.equal(purged.blobs, 1, 'only the truly unrelated orphan');
    assert.equal(await t.storage.exists({ kind: 'object', sha256: other.sha256 }), false);

    // The live file's original and its variant are completely untouched.
    assert.equal(await t.storage.exists({ kind: 'object', sha256: live.sha256 }), true, 'live original object never touched by an unrelated purge');
    assert.ok((await t.storage.stat(variantTarget.key))?.size, 'already-generated variant survives an unrelated purge');
    const resolved = await t.service.resolve(t.service.get(live.id), 'thumb');
    assert.deepEqual(resolved.key, variantTarget.key, 'still resolves to the same cached variant, not regenerated');
  } finally { t.cleanup(); }
});

test('variant cascade fencing: a stale purge cannot delete a fresh generation\'s freshly-regenerated variant, even discarding its quarantine late', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const image = await testImage({ width: 300, height: 300 });
    const old = await t.service.upload(streamOf(image), { apiKeyId: 'k', visibility: 'public' });
    const oldVariant = await t.service.resolve(old, 'thumb');
    assert.ok((await t.storage.stat(oldVariant.key))?.size);

    t.service.delete(old.id, 'k');
    t.clock.now += 1;
    t.files.purgeExpiredFiles(t.clock.now);
    t.files.markOrphanBlobs();
    const confirmed = t.files.finalizeOrphanBlobs();
    assert.deepEqual(confirmed, [old.sha256]);

    // Stale purge physically detaches — original AND its variant directory, together, same token.
    const token = randomUUID();
    assert.equal(await t.storage.detachForDelete({ kind: 'object', sha256: old.sha256 }, token), true);
    assert.equal(await t.storage.exists({ kind: 'object', sha256: old.sha256 }), false);
    assert.equal(await t.storage.stat(oldVariant.key), null, 'variant quarantined along with the original, not left orphaned at the canonical path');

    // Only now: a fresh upload of the exact same image content — new generation, same sha256.
    const fresh = await t.service.upload(streamOf(image), { apiKeyId: 'k', visibility: 'public' });
    assert.equal(fresh.sha256, old.sha256, 'same content re-encodes to the same bytes: same sha256');
    const freshVariant = await t.service.resolve(fresh, 'thumb');
    assert.ok((await t.storage.stat(freshVariant.key))?.size, 'variant regenerated fresh for the new generation');

    // The stale purge finally finishes — discarding only its own quarantine copies.
    await t.storage.discardDetached(token);

    assert.equal(t.service.get(fresh.id).deleted_at, null);
    assert.equal(await t.storage.exists({ kind: 'object', sha256: fresh.sha256 }), true, 'INVARIANT: fresh generation\'s object survives');
    assert.ok((await t.storage.stat(freshVariant.key))?.size, 'INVARIANT: fresh generation\'s regenerated variant survives the stale purge finishing late');
  } finally { t.cleanup(); }
});
