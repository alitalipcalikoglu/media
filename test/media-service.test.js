import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import sharp from 'sharp';
import { MediaError } from '../src/domain/errors.js';
import { streamOf, testImage, testMediaService } from './helpers.js';

/** @param {Promise<unknown>} p @param {string} code */
const rejectsWith = (p, code) => assert.rejects(p, (e) => e instanceof MediaError && e.code === code ? true : (console.error(e), false));

test('upload sniffs type, normalises images, dedupes blobs and exposes urls', async () => {
  const t = await testMediaService();
  try {
    const src = await sharp(await testImage({ width: 400, height: 300, withExif: true })).withMetadata({ orientation: 6 }).toBuffer();
    const f = await t.service.upload(streamOf(src), { apiKeyId: 'k', name: 'holiday.exe', visibility: 'public' });
    assert.equal(f.mime, 'image/jpeg');
    assert.equal(f.name, 'holiday.jpg');
    assert.deepEqual([f.width, f.height], [300, 400], 'orientation applied');
    assert.notEqual(f.size, src.length, 're-encoded');
    const stored = readFileSync(t.storage.objectPath(f.sha256));
    assert.equal((await sharp(stored).metadata()).exif, undefined, 'EXIF stripped from stored original');

    const dup = await t.service.upload(streamOf(src), { apiKeyId: 'k', visibility: 'private' });
    assert.equal(dup.sha256, f.sha256, 'same bytes → same blob');
    assert.notEqual(dup.id, f.id);
    assert.equal(t.files.stats().blobs, 1);

    const urls = t.service.urls(f);
    assert.equal(urls.original.url, `https://media.test.local/files/${f.id}/original`);
    assert.equal(urls.thumb.url, `https://media.test.local/files/${f.id}/thumb`);
    assert.equal(urls.original.expiresAt, null);
    const priv = t.service.urls(dup);
    assert.match(priv.original.url, new RegExp(`^https://media.test.local/files/${dup.id}/original\\?exp=\\d+&sig=`));
    assert.ok(priv.original.expiresAt);
    const q = Object.fromEntries(new URL(priv.medium.url).searchParams);
    assert.equal(t.service.authorize(dup, 'medium', q), true);
    assert.equal(t.service.authorize(dup, 'thumb', q), false, 'signature bound to variant');
    assert.equal(t.service.authorize(f, 'thumb', {}), true, 'public needs no signature');
    t.clock.now += 901_000;
    assert.equal(t.service.authorize(dup, 'medium', q), false, 'expired');

    const pdf = await t.service.upload(streamOf('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF'), { apiKeyId: 'k', name: 'doc' });
    assert.equal(pdf.mime, 'application/pdf');
    assert.equal(pdf.name, 'doc.pdf');
    assert.equal(pdf.width, null);
    assert.deepEqual(Object.keys(t.service.urls(pdf)), ['original'], 'no variants for documents');
  } finally {
    t.cleanup();
  }
});

test('upload rejects unknown types, disallowed types, oversized and broken images, leaving no files', async () => {
  const t = await testMediaService({ ALLOWED_TYPES: 'image/png,application/pdf', MAX_UPLOAD_BYTES: '5000', MAX_IMAGE_PIXELS: '100000' });
  try {
    await rejectsWith(t.service.upload(streamOf('<html>'), { apiKeyId: 'k' }), 'UNSUPPORTED_TYPE');
    await rejectsWith(t.service.upload(streamOf(await testImage({ width: 32, height: 32, format: 'jpeg' })), { apiKeyId: 'k' }), 'UNSUPPORTED_TYPE');
    await rejectsWith(t.service.upload(streamOf(Buffer.alloc(6000, 1)), { apiKeyId: 'k' }), 'TOO_LARGE');
    await rejectsWith(t.service.upload(streamOf(''), { apiKeyId: 'k' }), 'EMPTY');
    const bomb = await testImage({ width: 400, height: 400, format: 'png' });
    assert.ok(bomb.length < 5000);
    await rejectsWith(t.service.upload(streamOf(bomb), { apiKeyId: 'k' }), 'INVALID_IMAGE');
    const truncated = (await testImage({ width: 64, height: 64, format: 'png' })).subarray(0, 40);
    await rejectsWith(t.service.upload(streamOf(truncated), { apiKeyId: 'k' }), 'INVALID_IMAGE');
    assert.equal(t.files.stats().files, 0);
    assert.equal((await import('node:fs')).readdirSync(`${t.dir}/tmp`).length, 0, 'no temp leftovers');
    assert.equal((await import('node:fs')).readdirSync(`${t.dir}/objects`).length, 0, 'no objects stored');
  } finally {
    t.cleanup();
  }
});

test('tickets: constrained single-use upload with release on failure', async () => {
  const t = await testMediaService();
  try {
    assert.throws(() => t.service.createTicket({ apiKeyId: 'k', maxBytes: 999_999_999 }), (e) => e instanceof MediaError && e.code === 'INVALID_ARGUMENT');
    assert.throws(() => t.service.createTicket({ apiKeyId: 'k', allowedTypes: ['text/html'] }), (e) => e instanceof MediaError && e.code === 'INVALID_ARGUMENT');
    const ticket = t.service.createTicket({ apiKeyId: 'k', visibility: 'public', maxBytes: 100_000, allowedTypes: ['image/png'], name: 'avatar' });
    assert.equal(ticket.uploadUrl, `https://media.test.local/v1/uploads/${ticket.token}`);
    assert.deepEqual(ticket.allowedTypes, ['image/png']);

    await rejectsWith(t.service.uploadWithTicket(ticket.token, streamOf(await testImage({ format: 'jpeg' }))), 'UNSUPPORTED_TYPE');
    const f = await t.service.uploadWithTicket(ticket.token, streamOf(await testImage({ format: 'png', width: 50, height: 50 })), {});
    assert.equal(f.api_key_id, 'k');
    assert.equal(f.visibility, 'public');
    assert.equal(f.name, 'avatar.png');
    await rejectsWith(t.service.uploadWithTicket(ticket.token, streamOf(await testImage({ format: 'png' }))), 'INVALID_TICKET');
    await rejectsWith(t.service.uploadWithTicket('nope', streamOf('x')), 'INVALID_TICKET');
    const expiring = t.service.createTicket({ apiKeyId: 'k' });
    t.clock.now += 901_000;
    await rejectsWith(t.service.uploadWithTicket(expiring.token, streamOf('x')), 'INVALID_TICKET');
  } finally {
    t.cleanup();
  }
});

test('variants are generated once and cached; delete, restore and purge remove bytes after grace', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '1' });
  try {
    const f = await t.service.upload(streamOf(await testImage({ width: 800, height: 600 })), { apiKeyId: 'k', visibility: 'public' });
    const [a, b] = await Promise.all([t.service.resolve(f, 'thumb'), t.service.resolve(f, 'thumb')]);
    assert.equal(a.path, b.path);
    assert.equal(a.mime, 'image/webp');
    const meta = await sharp(a.path).metadata();
    assert.deepEqual([meta.width, meta.height], [200, 200]);
    const orig = await t.service.resolve(f, 'original');
    assert.equal(orig.mime, 'image/jpeg');
    assert.equal(orig.size, f.size);
    await rejectsWith(t.service.resolve(f, 'giant'), 'UNKNOWN_VARIANT');
    const pdf = await t.service.upload(streamOf('%PDF-1.4 x'), { apiKeyId: 'k' });
    await rejectsWith(t.service.resolve(pdf, 'thumb'), 'NOT_AN_IMAGE');

    assert.equal(t.service.list('k', { limit: 10 }).length, 2);
    assert.equal(t.service.update(f.id, 'k', { visibility: 'private', name: 'renamed.txt' }).name, 'renamed.jpg');
    assert.throws(() => t.service.get(f.id, 'other'), (e) => e instanceof MediaError && e.code === 'NOT_FOUND');
    t.service.delete(f.id, 'k');
    assert.throws(() => t.service.get(f.id), (e) => e instanceof MediaError && e.code === 'NOT_FOUND');
    assert.equal(t.service.restore(f.id, 'k').id, f.id);
    t.service.delete(f.id, 'k');
    assert.deepEqual(await t.service.purge(), { files: 0, blobs: 0, tickets: 0 }, 'inside grace period');
    assert.equal(await t.storage.exists(f.sha256), true);
    t.clock.now += 86_400_001;
    assert.deepEqual(await t.service.purge(), { files: 1, blobs: 1, tickets: 0 });
    assert.equal(await t.storage.exists(f.sha256), false);
    assert.equal(await t.storage.statPath(a.path), null, 'variants removed with the blob');
    assert.equal(await t.storage.exists(pdf.sha256), true, 'live file untouched');
  } finally {
    t.cleanup();
  }
});
