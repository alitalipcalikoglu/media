import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { UploadError } from '../src/storage/local-storage.js';
import { TypeSniffer } from '../src/storage/type-sniffer.js';
import { UrlSigner } from '../src/url-signer.js';
import { SIGNING_SECRET, streamOf, tempDir, testImage, testStorage } from './helpers.js';

const { dir, cleanup } = tempDir();
after(cleanup);

test('TypeSniffer recognises supported formats by magic bytes', async () => {
  assert.equal(TypeSniffer.sniff(await testImage({ format: 'jpeg' })), 'image/jpeg');
  assert.equal(TypeSniffer.sniff(await testImage({ format: 'png' })), 'image/png');
  assert.equal(TypeSniffer.sniff(await testImage({ format: 'webp' })), 'image/webp');
  assert.equal(TypeSniffer.sniff(await testImage({ format: 'gif' })), 'image/gif');
  assert.equal(TypeSniffer.sniff(await testImage({ format: 'avif', width: 64, height: 64 })), 'image/avif');
  assert.equal(TypeSniffer.sniff(Buffer.from('%PDF-1.7\n%âãÏÓ')), 'application/pdf');
  assert.equal(TypeSniffer.sniff(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
  assert.equal(TypeSniffer.sniff(Buffer.from('  <svg viewBox="0 0 1 1"/>')), 'image/svg+xml');
  assert.equal(TypeSniffer.sniff(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.equal(TypeSniffer.sniff(Buffer.from('MZ\x90\x00')), null);
  assert.equal(TypeSniffer.sniff(Buffer.alloc(0)), null);
  assert.equal(TypeSniffer.extension('image/jpeg'), 'jpg');
  assert.equal(TypeSniffer.extension('application/octet-stream'), 'bin');
  assert.equal(TypeSniffer.isImage('image/svg+xml'), false);
  assert.equal(TypeSniffer.isRasterImage('image/gif'), true);
});

test('LocalStorage receives, hashes, limits, dedupes and removes objects', async () => {
  const storage = await testStorage(join(dir, 's1'));
  const data = await testImage();
  const r = await storage.receive(streamOf(data), { maxBytes: data.length });
  assert.equal(r.size, data.length);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(TypeSniffer.sniff(r.head), 'image/jpeg');
  assert.equal(r.head.length, TypeSniffer.HEAD_BYTES);
  assert.equal(await storage.commit(r.tmpPath, r.sha256), true);
  assert.equal(await storage.exists(r.sha256), true);
  assert.ok(readFileSync(storage.objectPath(r.sha256)).equals(data));
  assert.match(storage.objectPath(r.sha256), new RegExp(`objects/${r.sha256.slice(0, 2)}/${r.sha256.slice(2, 4)}/${r.sha256}$`));

  const again = await storage.receive(streamOf(data), { maxBytes: data.length });
  assert.equal(again.sha256, r.sha256);
  assert.equal(await storage.commit(again.tmpPath, again.sha256), false, 'deduped');
  assert.equal(readdirSync(join(dir, 's1', 'tmp')).length, 0, 'temp files cleaned');

  await assert.rejects(storage.receive(streamOf(data), { maxBytes: data.length - 1 }), (e) => e instanceof UploadError && e.code === 'TOO_LARGE');
  await assert.rejects(storage.receive(streamOf(Buffer.alloc(0)), { maxBytes: 10 }), (e) => e instanceof UploadError && e.code === 'EMPTY');
  const broken = new Readable({ read() { this.destroy(new Error('socket hang up')); } });
  await assert.rejects(storage.receive(broken, { maxBytes: 10 }), (e) => e instanceof UploadError && e.code === 'STREAM_ERROR');
  assert.equal(readdirSync(join(dir, 's1', 'tmp')).length, 0, 'failed uploads leave nothing behind');

  await storage.writeAtomic(storage.variantPath(r.sha256, 'thumb'), Buffer.from('v'));
  assert.ok((await storage.statPath(storage.variantPath(r.sha256, 'thumb')))?.isFile());
  assert.throws(() => storage.variantPath(r.sha256, '../etc'), /invalid variant/);
  assert.throws(() => storage.objectPath('nope'), /invalid sha256/);
  await storage.remove(r.sha256);
  assert.equal(await storage.exists(r.sha256), false);
  assert.equal(await storage.statPath(storage.variantDir(r.sha256)), null);
});

test('LocalStorage.prepare clears interrupted uploads from tmp', async () => {
  const storage = await testStorage(join(dir, 's2'));
  const r = await storage.receive(streamOf('leftover'), { maxBytes: 100 });
  assert.equal(readdirSync(join(dir, 's2', 'tmp')).length, 1);
  await storage.prepare();
  assert.equal(readdirSync(join(dir, 's2', 'tmp')).length, 0);
  void r;
});

test('LocalStorage.check never touches tmp contents (safe for readiness probes)', async () => {
  const storage = await testStorage(join(dir, 's3'));
  const r = await storage.receive(streamOf('in-flight upload'), { maxBytes: 100 });
  assert.equal(readdirSync(join(dir, 's3', 'tmp')).length, 1);
  await storage.check();
  await storage.check();
  assert.equal(readdirSync(join(dir, 's3', 'tmp')).length, 1, 'check() must not remove an in-flight upload');
  assert.equal(await storage.commit(r.tmpPath, r.sha256), true, 'the upload can still be committed after check()');
});

test('UrlSigner signs and verifies with expiry and constant-time compare', () => {
  const s = new UrlSigner(SIGNING_SECRET);
  const now = 1_700_000_000_000;
  const exp = Math.floor(now / 1000) + 60;
  const sig = s.sign('f1', 'thumb', exp);
  assert.equal(s.verify({ fileId: 'f1', variant: 'thumb', exp, sig }, now), true);
  assert.equal(s.verify({ fileId: 'f1', variant: 'thumb', exp: String(exp), sig }, now), true);
  assert.equal(s.verify({ fileId: 'f1', variant: 'original', exp, sig }, now), false, 'variant bound');
  assert.equal(s.verify({ fileId: 'f2', variant: 'thumb', exp, sig }, now), false, 'file bound');
  assert.equal(s.verify({ fileId: 'f1', variant: 'thumb', exp: exp + 1, sig }, now), false, 'expiry bound');
  assert.equal(s.verify({ fileId: 'f1', variant: 'thumb', exp, sig }, exp * 1000), false, 'expired');
  assert.equal(s.verify({ fileId: 'f1', variant: 'thumb', exp, sig: 'x' }, now), false);
  assert.equal(s.verify({ fileId: 'f1', variant: 'thumb', exp: undefined, sig }, now), false);
  assert.equal(new UrlSigner('t'.repeat(40)).verify({ fileId: 'f1', variant: 'thumb', exp, sig }, now), false);
  assert.match(s.query('f1', 'thumb', exp), /^exp=\d+&sig=[A-Za-z0-9_%-]+$/);
});
