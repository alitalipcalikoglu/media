import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamOf, testImage, testMediaService } from './helpers.js';

/**
 * Stage 8.1: the purge-vs-concurrent-upload-of-the-same-content race (P0). Real `MediaService`,
 * real `FileStore` (real SQLite via `Database`), real `LocalStorage` — no fakes, no mocks. Every
 * "concurrent" step here is a deliberately ordered sequence of real, awaited operations (a
 * controlled interleaving via explicit ordering, not timing) rather than `Promise.all` racing,
 * because the exact bug is about WHICH ORDER two independent operations' DB/filesystem writes
 * land in — a barrier of explicit `await`s reproduces that precisely and deterministically,
 * with no reliance on real concurrency or sleeps.
 *
 * Invariant under test (see docs/READINESS.md "Purge/upload race"):
 *   For every committed live file row, its referenced content-addressed object must be readable
 *   after every completed upload/purge operation. Purge and upload concurrency must never break
 *   this — regardless of which one's steps happen to interleave with the other's.
 */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');

test('the exact bug interleaving: A marks the object orphaned, B (a fresh upload of the same content) reclaims it, A must not delete B\'s bytes', async () => {
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

    // --- A: (only now) attempts to finalize + physically delete ---
    const confirmed = t.files.finalizeOrphanBlobs();
    assert.deepEqual(confirmed, [], 'A: compare-and-swap sees the cleared mark — refuses to delete a row a concurrent upload just reclaimed');
    for (const sha256 of confirmed) await t.storage.remove({ kind: 'object', sha256 });

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

    // A finalizes AND physically deletes BEFORE B ever starts — B's upload begins with the blob
    // row already gone and the bytes already gone; this exercises upload's own self-heal path
    // (commit() dedup-checks against nothing, since there's truly nothing there — "stored" is
    // simply true, a completely ordinary fresh store, not even a self-heal case). Included as the
    // adjacent, equally-important ordering to the reclaim case above.
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
    // removed the bytes (a stale purge) after commit()'s dedup check observed them present, but
    // before this upload's own createFile() DB write. We can't literally pause upload() mid-flight
    // without invasive hooks, so we prove the mechanism directly: force `storage.exists` to lie
    // "missing" exactly once, confirming upload() calls `commit()` again from its own held tempKey
    // rather than trusting a stale "already exists" verdict.
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
    assert.ok(recommits >= 2, 'the original dedup-path commit() plus at least one self-heal re-commit');
    assert.equal(await realExists(key), true, 'object present and readable after self-heal');
  } finally { t.cleanup(); }
});

// ------------------------------------------------------------ crash windows (Stage 8.1, item 7)

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

test('crash window: DB row deleted, crash before the physical unlink — accepted outcome is a leaked (harmless) file on disk, never a live DB reference to missing bytes', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const f = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(f.id, 'k');
    t.clock.now += 1;
    t.files.purgeExpiredFiles(t.clock.now);
    t.files.markOrphanBlobs();
    const confirmed = t.files.finalizeOrphanBlobs();
    assert.deepEqual(confirmed, [f.sha256]);
    // "Crash": the physical storage.remove() for `confirmed` never runs.
    assert.equal(t.files.blob(f.sha256), undefined, 'DB row is gone — permanently, correctly');
    assert.equal(await t.storage.exists({ kind: 'object', sha256: f.sha256 }), true, 'bytes leak on disk — accepted; nothing references them any more, so this is disk bloat, not a correctness violation');
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
    assert.equal(await t.storage.exists(key), true, 'bytes remain — an already-known, unrelated leak class (see docs/READINESS.md), not something Stage 8.1 changes');
  } finally { t.cleanup(); }
});

test('purge.storage.remove() throwing for one blob never aborts cleanup of the others, and never re-throws out of purge()', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const bad = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    const good = await t.service.upload(streamOf(Buffer.from('%PDF-1.4 a completely different body')), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(bad.id, 'k');
    t.service.delete(good.id, 'k');
    t.clock.now += 1;

    const realRemove = t.storage.remove.bind(t.storage);
    t.storage.remove = async (/** @type {any} */ key) => {
      if (key.sha256 === bad.sha256) throw new Error('disk unavailable');
      return realRemove(key);
    };

    const result = await t.service.purge();
    assert.equal(result.files, 2);
    assert.equal(result.blobs, 2, 'both blob rows genuinely deleted from the DB, regardless of the storage-level failure for one');
    assert.equal(t.files.blob(bad.sha256), undefined);
    assert.equal(t.files.blob(good.sha256), undefined);
    assert.equal(await t.storage.exists({ kind: 'object', sha256: good.sha256 }), false, 'the OTHER blob\'s bytes were still removed');
  } finally { t.cleanup(); }
});

test('retrying maintenance after a previous partial purge is idempotent — no error, no re-attempt of an already-deleted row', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const f = await t.service.upload(streamOf(PDF), { apiKeyId: 'k', visibility: 'public' });
    t.service.delete(f.id, 'k');
    t.clock.now += 1;
    t.storage.remove = async () => { throw new Error('disk unavailable'); };
    const first = await t.service.purge();
    assert.equal(first.blobs, 1, 'row deleted even though the physical remove failed');

    t.storage.remove = async () => { throw new Error('should never be called again for this sha — nothing left to finalize'); };
    const second = await t.service.purge();
    assert.equal(second.blobs, 0, 'nothing new to finalize; idempotent, no error');
  } finally { t.cleanup(); }
});

// ------------------------------------------------------------ variant interaction (Stage 8.1, item 9)

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
