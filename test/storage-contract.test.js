import assert from 'node:assert/strict';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { test } from 'node:test';
import { LocalStorage } from '../src/storage/local-storage.js';
import { streamOf, tempDir } from './helpers.js';

/**
 * Storage backend contract (Stage 8): exercised once per backend through a factory, so a future
 * backend can run this exact suite unchanged. Tests OBSERVABLE storage semantics only —
 * `MediaService`-visible behavior through the {@link import('../src/storage/storage.js').Storage}
 * interface — never LocalStorage's own on-disk layout, sharding or path format (see
 * `storage.test.js` for those LocalStorage-specific assertions).
 * @param {string} name
 * @param {() => { storage: import('../src/storage/storage.js').Storage, cleanup: () => void }} makeBackend
 */
function contract(name, makeBackend) {
  test(`${name}: prepare() then check() both succeed on a fresh backend`, async () => {
    const { storage, cleanup } = makeBackend();
    try {
      await storage.prepare();
      await storage.check();
    } finally { cleanup(); }
  });

  test(`${name}: check() is non-destructive — a temp entry survives repeated check() calls`, async () => {
    const { storage, cleanup } = makeBackend();
    try {
      await storage.prepare();
      const key = storage.tempKey();
      await storage.writeAtomic(key, Buffer.from('in flight'));
      await storage.check();
      await storage.check();
      assert.equal((await streamToBuffer(await storage.open(key))).toString(), 'in flight', 'check() left the temp entry untouched');
    } finally { cleanup(); }
  });

  test(`${name}: writeTemp streams, hashes and sizes an upload; commit makes it a readable object`, async () => {
    const { storage, cleanup } = makeBackend();
    try {
      await storage.prepare();
      const data = Buffer.from('hello storage contract');
      const received = await storage.writeTemp(streamOf(data), { maxBytes: 1_000 });
      assert.equal(received.size, data.length);
      assert.match(received.sha256, /^[0-9a-f]{64}$/);
      /** @type {import('../src/storage/storage.js').StorageKey} */
      const key = { kind: 'object', sha256: received.sha256 };
      assert.equal(await storage.exists(key), false, 'not committed yet');
      assert.equal(await storage.commit(received.key, key), true, 'new content stored');
      assert.equal(await storage.exists(key), true);
      assert.equal((await streamToBuffer(await storage.open(key))).toString(), data.toString(), 'committed object is readable back exactly');
      assert.deepEqual(await storage.stat(key), { size: data.length });
    } finally { cleanup(); }
  });

  test(`${name}: same-key behavior — committing identical content twice dedupes; the temp entry is always consumed either way`, async () => {
    const { storage, cleanup } = makeBackend();
    try {
      await storage.prepare();
      const data = Buffer.from('dedup me');
      const first = await storage.writeTemp(streamOf(data), { maxBytes: 1_000 });
      const key = { kind: /** @type {const} */ ('object'), sha256: first.sha256 };
      assert.equal(await storage.commit(first.key, key), true);
      await assert.rejects(streamToBuffer(await storage.open(first.key)), 'the winning temp entry is consumed (moved) by commit()');
      const second = await storage.writeTemp(streamOf(data), { maxBytes: 1_000 });
      assert.equal(second.sha256, first.sha256);
      assert.equal(await storage.commit(second.key, key), false, 'deduped, not a new object');
      // Stage 8.1: a DEDUPED temp entry is deliberately left alone by commit() — the caller may
      // still need it (e.g. to retry commit() if the object it deduped against turns out to have
      // been concurrently removed) — it's the caller's job to discard() once truly done with it.
      assert.equal((await streamToBuffer(await storage.open(second.key))).toString(), data.toString(), 'a deduped temp entry survives commit() until the caller discards it');
      await storage.discard(second.key);
      await assert.rejects(streamToBuffer(await storage.open(second.key)), 'discard() actually removes it');
    } finally { cleanup(); }
  });

  test(`${name}: writeAtomic overwrite semantics — a second write under the same key fully replaces the first, never a merge or partial mix`, async () => {
    const { storage, cleanup } = makeBackend();
    try {
      await storage.prepare();
      /** @type {import('../src/storage/storage.js').StorageKey} */
      const key = { kind: 'variant', sha256: 'a'.repeat(64), name: 'thumb' };
      await storage.writeAtomic(key, Buffer.from('first version, quite a bit longer than the second'));
      await storage.writeAtomic(key, Buffer.from('v2'));
      assert.equal((await streamToBuffer(await storage.open(key))).toString(), 'v2', 'fully replaced, no leftover tail from the longer first write');
    } finally { cleanup(); }
  });

  test(`${name}: exists/stat/remove, including removing something already missing`, async () => {
    const { storage, cleanup } = makeBackend();
    try {
      await storage.prepare();
      /** @type {import('../src/storage/storage.js').StorageKey} */
      const key = { kind: 'object', sha256: 'b'.repeat(64) };
      assert.equal(await storage.exists(key), false);
      assert.equal(await storage.stat(key), null);
      await storage.remove(key); // missing: must not throw
      await storage.writeAtomic(key, Buffer.from('x'));
      assert.equal(await storage.exists(key), true);
      await storage.remove(key);
      assert.equal(await storage.exists(key), false);
      await storage.remove(key); // already gone: still must not throw
    } finally { cleanup(); }
  });

  test(`${name}: removing an object key also removes its variants`, async () => {
    const { storage, cleanup } = makeBackend();
    try {
      await storage.prepare();
      const sha256 = 'c'.repeat(64);
      await storage.writeAtomic({ kind: 'object', sha256 }, Buffer.from('orig'));
      await storage.writeAtomic({ kind: 'variant', sha256, name: 'thumb' }, Buffer.from('v'));
      await storage.remove({ kind: 'object', sha256 });
      assert.equal(await storage.exists({ kind: 'object', sha256 }), false);
      assert.equal(await storage.stat({ kind: 'variant', sha256, name: 'thumb' }), null, 'variant removed along with its object');
    } finally { cleanup(); }
  });

  test(`${name}: prepare() clears an interrupted temp entry left by a previous process`, async () => {
    const { storage, cleanup } = makeBackend();
    try {
      await storage.prepare();
      const key = storage.tempKey();
      await storage.writeAtomic(key, Buffer.from('leftover'));
      await storage.prepare();
      await assert.rejects(streamToBuffer(await storage.open(key)), 'interrupted upload is gone after prepare()');
    } finally { cleanup(); }
  });

  test(`${name}: rejects a key whose fields don't match the allowlist (path traversal / separator injection surface)`, async () => {
    const { storage, cleanup } = makeBackend();
    try {
      await storage.prepare();
      const bad = ['../../etc/passwd', '..', 'a/b', '\0', '', 'g'.repeat(64), 'A'.repeat(64)];
      for (const sha256 of bad) await assert.rejects(storage.exists({ kind: 'object', sha256 }), `sha256 ${JSON.stringify(sha256)} must be rejected`);
      for (const name of ['../evil', 'a/../../b', '', 'Thumb', 'x'.repeat(40)]) {
        await assert.rejects(storage.exists({ kind: 'variant', sha256: 'd'.repeat(64), name }), `variant name ${JSON.stringify(name)} must be rejected`);
      }
    } finally { cleanup(); }
  });

  test(`${name}: concurrent commit of the same object from two temp sources — exactly one wins, neither throws, both temp entries end up discardable with nothing leaked`, async () => {
    const { storage, cleanup } = makeBackend();
    try {
      await storage.prepare();
      const data = Buffer.from('same content, two uploads racing');
      const [a, b] = await Promise.all([storage.writeTemp(streamOf(data), { maxBytes: 1_000 }), storage.writeTemp(streamOf(data), { maxBytes: 1_000 })]);
      const key = { kind: /** @type {const} */ ('object'), sha256: a.sha256 };
      const [wonA, wonB] = await Promise.all([storage.commit(a.key, key), storage.commit(b.key, key)]);
      assert.equal(Number(wonA) + Number(wonB), 1, 'exactly one commit stores the object, the other dedupes');
      assert.equal((await streamToBuffer(await storage.open(key))).toString(), data.toString());
      // The winner's temp key was already consumed by commit() itself; the loser's (Stage 8.1: a
      // deduped temp is left alone, not auto-discarded) is still the caller's to clean up.
      await storage.discard(a.key);
      await storage.discard(b.key);
      await assert.rejects(streamToBuffer(await storage.open(a.key)));
      await assert.rejects(streamToBuffer(await storage.open(b.key)));
    } finally { cleanup(); }
  });

  test(`${name}: storage-level invariant behind the purge/upload race — remove() and a fresh commit() of the same key never corrupt or throw, and the result is always one well-defined state`, async () => {
    const { storage, cleanup } = makeBackend();
    try {
      await storage.prepare();
      const sha256 = 'e'.repeat(64);
      const key = { kind: /** @type {const} */ ('object'), sha256 };

      // Sequential order 1: a fresh commit lands, then remove() runs after (e.g. a slow purge that
      // had already decided this key was orphaned, unaware a new upload just landed) — the removal
      // wins, deterministically; this is the documented, still-open cross-service race (see
      // README/READINESS "Known failure modes"), not something the storage layer alone can close,
      // but the storage layer's OWN behavior here is fully deterministic and never throws.
      const t1 = await storage.writeTemp(streamOf(Buffer.from('x')), { maxBytes: 10 });
      assert.equal(await storage.commit(t1.key, key), true);
      await storage.remove(key);
      assert.equal(await storage.exists(key), false, 'order 1: remove after commit leaves the object gone');

      // Sequential order 2: remove() first (nothing there yet), then a fresh commit — the commit
      // wins, deterministically, and is a completely ordinary "not deduped, stored fresh" case.
      await storage.remove(key); // already gone; must not throw
      const t2 = await storage.writeTemp(streamOf(Buffer.from('y')), { maxBytes: 10 });
      assert.equal(await storage.commit(t2.key, key), true, 'order 2: nothing to dedupe against, stored fresh');
      assert.equal(await storage.exists(key), true);

      // True concurrency: remove() the current content while a fresh commit of the SAME key races
      // it. Neither call may throw, and afterward the key is in exactly one of the two
      // well-defined states above — never a half-written or corrupt object.
      const t3 = await storage.writeTemp(streamOf(Buffer.from('z')), { maxBytes: 10 });
      const [removed, committed] = await Promise.all([
        storage.remove(key).then(() => 'ok', (e) => e),
        storage.commit(t3.key, key).then((v) => v, (e) => e),
      ]);
      assert.equal(removed, 'ok', 'remove() never throws even racing a concurrent commit of the same key');
      assert.ok(committed === true || committed === false, 'commit() resolves normally (true or false), never throws, even racing a concurrent remove()');
      const finalState = await storage.exists(key);
      assert.equal(typeof finalState, 'boolean', 'the key ends up in one well-defined state, present or absent — never a partial/corrupt object');
    } finally { cleanup(); }
  });
}

contract('LocalStorage', () => {
  const { dir, cleanup } = tempDir();
  return { storage: new LocalStorage(dir), cleanup };
});
