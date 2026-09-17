import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaError } from '../src/domain/errors.js';
import { streamOf, testImage, testMediaService } from './helpers.js';

/** Controllable stand-in for ImageProcessor: fixed cheap inspect/normalize, `variant()` timing and outcome fully under test control. */
class FakeImages {
  constructor() {
    this.active = 0;
    this.maxActive = 0;
    this.calls = 0;
    /** @type {(spec: import('../src/types.js').VariantSpec) => Promise<Buffer>} */
    this.impl = async () => Buffer.from('variant-bytes');
  }

  async inspect() { return { width: 100, height: 100, format: 'jpeg', pages: 1 }; }

  async normalize() { return { buffer: Buffer.from('normalized-original'), width: 100, height: 100 }; }

  /** @param {string|Buffer} input @param {import('../src/types.js').VariantSpec} spec */
  async variant(input, spec) {
    this.calls++;
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      void input;
      return await this.impl(spec);
    } finally {
      this.active--;
    }
  }
}

/** A promise plus its resolve/reject, for hand-controlled timing in tests. */
function deferred() {
  /** @type {(v?: any) => void} */ let resolve = () => {};
  /** @type {(e: unknown) => void} */ let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('variant generation: success is cached, and a concurrent duplicate request shares the one generation (Stage 8)', async () => {
  const images = new FakeImages();
  const t = await testMediaService({ STRIP_IMAGE_METADATA: 'false' }, { images });
  try {
    const f = await t.service.upload(streamOf(await testImage()), { apiKeyId: 'k', visibility: 'public' });
    const [a, b] = await Promise.all([t.service.resolve(f, 'thumb'), t.service.resolve(f, 'thumb')]);
    assert.deepEqual(a.key, b.key);
    assert.equal(images.calls, 1, 'two concurrent requests for the same (object, variant) share one generation, not two');
    assert.equal(t.service.inflight.size, 0, 'settled generation leaves nothing behind in the in-flight map');
    assert.equal(t.service.semaphore.active, 0, 'slot released after success');
    await t.service.resolve(f, 'thumb');
    assert.equal(images.calls, 1, 'already on disk: no regeneration on a later, separate request');
  } finally { t.cleanup(); }
});

test('variant generation: a thrown error propagates, releases its semaphore slot, leaves no poisoned cache entry, and a later request can retry', async () => {
  const images = new FakeImages();
  let shouldFail = true;
  images.impl = async () => { if (shouldFail) throw new Error('encoder blew up'); return Buffer.from('ok'); };
  const t = await testMediaService({ STRIP_IMAGE_METADATA: 'false' }, { images });
  try {
    const f = await t.service.upload(streamOf(await testImage()), { apiKeyId: 'k', visibility: 'public' });
    await assert.rejects(t.service.resolve(f, 'thumb'), /encoder blew up/);
    assert.equal(t.service.semaphore.active, 0, 'failed generation still releases its slot');
    assert.equal(t.service.inflight.size, 0, 'failure never leaves a poisoned in-flight entry');
    assert.equal(await t.storage.stat({ kind: 'variant', sha256: f.sha256, name: 'thumb' }), null, 'no partial/corrupt variant under the final key');

    shouldFail = false;
    const r = await t.service.resolve(f, 'thumb');
    assert.equal(images.calls, 2, 'the next request genuinely retries, it does not reuse a failed result');
    assert.ok((await t.storage.stat(r.key))?.size);
  } finally { t.cleanup(); }
});

test('variant generation: a storage write failure surfaces, releases the slot, and leaves nothing under the final key', async () => {
  const images = new FakeImages();
  const t = await testMediaService({ STRIP_IMAGE_METADATA: 'false' }, { images });
  try {
    const f = await t.service.upload(streamOf(await testImage()), { apiKeyId: 'k', visibility: 'public' });
    const realWriteAtomic = t.storage.writeAtomic.bind(t.storage);
    let failNext = true;
    t.storage.writeAtomic = async (/** @type {any} */ key, /** @type {any} */ data) => {
      if (failNext && key.kind === 'variant') { failNext = false; throw new Error('disk full'); }
      return realWriteAtomic(key, data);
    };
    await assert.rejects(t.service.resolve(f, 'thumb'), /disk full/);
    assert.equal(t.service.semaphore.active, 0);
    assert.equal(await t.storage.stat({ kind: 'variant', sha256: f.sha256, name: 'thumb' }), null, 'atomic write failure never leaves a partial variant visible under its final key');
    const r = await t.service.resolve(f, 'thumb');
    assert.ok((await t.storage.stat(r.key))?.size, 'retried successfully once the write stops failing');
  } finally { t.cleanup(); }
});

test('variant generation: MAX_CONCURRENT_VARIANTS bounds truly distinct generations, never exceeded', async () => {
  const images = new FakeImages();
  const gates = [0, 1, 2, 3, 4].map(() => deferred());
  let i = 0;
  images.impl = async () => { const my = i++; await gates[my].promise; return Buffer.from(`v${my}`); };
  const t = await testMediaService(
    { STRIP_IMAGE_METADATA: 'false', MAX_CONCURRENT_VARIANTS: '2', VARIANTS: 'v0:100,v1:110,v2:120,v3:130,v4:140' },
    { images },
  );
  try {
    const f = await t.service.upload(streamOf(await testImage()), { apiKeyId: 'k', visibility: 'public' });
    const names = ['v0', 'v1', 'v2', 'v3', 'v4'];
    const pending = names.map((n) => t.service.resolve(f, n));
    // Give every microtask a chance to reach either "generating" or "queued" before releasing any.
    await new Promise((r) => setImmediate(r));
    assert.ok(images.active <= 2, `at most MAX_CONCURRENT_VARIANTS=2 active at once, got ${images.active}`);
    assert.ok(images.maxActive <= 2, `never exceeded 2 concurrently even with 5 unique variants requested at once, got ${images.maxActive}`);
    for (const g of gates) g.resolve();
    await Promise.all(pending);
    assert.equal(images.calls, 5, 'all five, genuinely distinct, eventually ran');
  } finally { t.cleanup(); }
});

test('variant generation: a waiting request\'s own AbortSignal stops that request without cancelling the shared generation for anyone else', async () => {
  const images = new FakeImages();
  const gate = deferred();
  images.impl = async (/** @type {any} */ spec) => { if (spec.name === 'slow') await gate.promise; return Buffer.from('ok'); };
  const t = await testMediaService(
    { STRIP_IMAGE_METADATA: 'false', MAX_CONCURRENT_VARIANTS: '1', VARIANTS: 'slow:100,queued:110' },
    { images },
  );
  try {
    const f = await t.service.upload(streamOf(await testImage()), { apiKeyId: 'k', visibility: 'public' });
    const first = t.service.resolve(f, 'slow'); // takes the one slot, blocks on `gate`
    await new Promise((r) => setImmediate(r));

    const ac = new AbortController();
    const waiting = t.service.resolve(f, 'queued', { signal: ac.signal }); // queues behind the slot
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await assert.rejects(waiting, /aborted|AbortError/i);

    gate.resolve();
    const r = await first;
    assert.ok((await t.storage.stat(r.key))?.size, 'the generation the aborted caller was waiting on still completed');
    // The abandoned wait's own generation is still queued behind it internally (the abort only
    // stopped THIS caller's own wait, see MediaService#resolve doc) — let it finish too before
    // cleanup tears down the data directory out from under it.
    await t.service.resolve(f, 'queued');
  } finally { t.cleanup(); }
});

test('variant generation: one deduped caller\'s abort never fails the others sharing the same generation', async () => {
  const images = new FakeImages();
  const gate = deferred();
  images.impl = async () => { await gate.promise; return Buffer.from('ok'); };
  const t = await testMediaService({ STRIP_IMAGE_METADATA: 'false' }, { images });
  try {
    const f = await t.service.upload(streamOf(await testImage()), { apiKeyId: 'k', visibility: 'public' });
    const ac = new AbortController();
    const aborting = t.service.resolve(f, 'thumb', { signal: ac.signal });
    const healthy = t.service.resolve(f, 'thumb'); // dedupes onto the same generation
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await assert.rejects(aborting, /aborted|AbortError/i);
    gate.resolve();
    const r = await healthy; // must NOT be rejected by the other caller's abort
    assert.equal(images.calls, 1);
    assert.ok((await t.storage.stat(r.key))?.size);
  } finally { t.cleanup(); }
});
