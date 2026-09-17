import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { after, test } from 'node:test';
import { UploadError } from '../src/storage/local-storage.js';
import { TypeSniffer } from '../src/storage/type-sniffer.js';
import { UrlSigner } from '../src/url-signer.js';
import { SIGNING_SECRET, streamOf, tempDir, testImage, testStorage } from './helpers.js';

/**
 * LocalStorage-specific behavior: its actual on-disk layout, sharding, and the low-level upload
 * mechanics (limits, empty/broken streams). Observable cross-backend semantics belong in
 * `storage-contract.test.js` instead — this file only tests what genuinely differs by backend.
 */
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

test('LocalStorage writeTemp receives, hashes, limits and commits into a sharded object path', async () => {
  const storage = await testStorage(join(dir, 's1'));
  const data = await testImage();
  const r = await storage.writeTemp(streamOf(data), { maxBytes: data.length });
  assert.equal(r.size, data.length);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(TypeSniffer.sniff(r.head), 'image/jpeg');
  assert.equal(r.head.length, TypeSniffer.HEAD_BYTES);
  const key = { kind: /** @type {const} */ ('object'), sha256: r.sha256 };
  assert.equal(await storage.commit(r.key, key), true);
  assert.equal(await storage.exists(key), true);
  const objectPath = /** @type {string} */ (await storage.localPath(key));
  assert.ok(readFileSync(objectPath).equals(data));
  assert.match(objectPath, new RegExp(`objects/${r.sha256.slice(0, 2)}/${r.sha256.slice(2, 4)}/${r.sha256}$`), 'sharded two levels deep, LocalStorage-specific layout');

  const again = await storage.writeTemp(streamOf(data), { maxBytes: data.length });
  assert.equal(again.sha256, r.sha256);
  assert.equal(await storage.commit(again.key, key), false, 'deduped');
  assert.equal(readdirSync(join(dir, 's1', 'tmp')).length, 1, 'Stage 8.1: a deduped temp is left for the caller, not auto-cleaned');
  await storage.discard(again.key);
  assert.equal(readdirSync(join(dir, 's1', 'tmp')).length, 0, 'temp files cleaned once the caller discards');

  await assert.rejects(storage.writeTemp(streamOf(data), { maxBytes: data.length - 1 }), (e) => e instanceof UploadError && e.code === 'TOO_LARGE');
  await assert.rejects(storage.writeTemp(streamOf(Buffer.alloc(0)), { maxBytes: 10 }), (e) => e instanceof UploadError && e.code === 'EMPTY');
  const broken = new Readable({ read() { this.destroy(new Error('socket hang up')); } });
  await assert.rejects(storage.writeTemp(broken, { maxBytes: 10 }), (e) => e instanceof UploadError && e.code === 'STREAM_ERROR');
  assert.equal(readdirSync(join(dir, 's1', 'tmp')).length, 0, 'failed uploads leave nothing behind');

  await storage.writeAtomic({ kind: 'variant', sha256: r.sha256, name: 'thumb' }, Buffer.from('v'));
  assert.ok(await storage.exists({ kind: 'variant', sha256: r.sha256, name: 'thumb' }));
  await assert.rejects(storage.open({ kind: 'variant', sha256: r.sha256, name: '../etc' }));
  await assert.rejects(storage.open({ kind: 'object', sha256: 'nope' }));
  await storage.remove(key);
  assert.equal(await storage.exists(key), false);
  assert.equal(await storage.stat({ kind: 'variant', sha256: r.sha256, name: 'thumb' }), null, 'variant dir removed with the object');
});

test('LocalStorage: concurrent same-SHA commit leaves zero files behind in tmp/ once both sides discard (Stage 8.1)', async () => {
  const storage = await testStorage(join(dir, 's1b'));
  const data = Buffer.from('same content, two uploads racing, checking tmp/ afterward');
  const [a, b] = await Promise.all([storage.writeTemp(streamOf(data), { maxBytes: 1_000 }), storage.writeTemp(streamOf(data), { maxBytes: 1_000 })]);
  const key = { kind: /** @type {const} */ ('object'), sha256: a.sha256 };
  const [wonA, wonB] = await Promise.all([storage.commit(a.key, key), storage.commit(b.key, key)]);
  assert.equal(Number(wonA) + Number(wonB), 1);
  // The winner's temp is already gone (consumed by link()+unlink() inside commit()); the loser's
  // is real content still sitting in tmp/ until whoever called commit() discards it — this is the
  // caller's job, not something a correctness fix should ever leave undone.
  await storage.discard(a.key);
  await storage.discard(b.key);
  assert.equal(readdirSync(join(dir, 's1b', 'tmp')).length, 0, 'no leftover temp file from either side of the race');
});

test('LocalStorage.prepare clears interrupted uploads from tmp', async () => {
  const storage = await testStorage(join(dir, 's2'));
  const r = await storage.writeTemp(streamOf('leftover'), { maxBytes: 100 });
  assert.equal(readdirSync(join(dir, 's2', 'tmp')).length, 1);
  await storage.prepare();
  assert.equal(readdirSync(join(dir, 's2', 'tmp')).length, 0);
  void r;
});

test('LocalStorage.check never touches tmp contents (safe for readiness probes)', async () => {
  const storage = await testStorage(join(dir, 's3'));
  const r = await storage.writeTemp(streamOf('in-flight upload'), { maxBytes: 100 });
  assert.equal(readdirSync(join(dir, 's3', 'tmp')).length, 1);
  await storage.check();
  await storage.check();
  assert.equal(readdirSync(join(dir, 's3', 'tmp')).length, 1, 'check() must not remove an in-flight upload');
  assert.equal(await storage.commit(r.key, { kind: 'object', sha256: r.sha256 }), true, 'the upload can still be committed after check()');
});

test('LocalStorage.open supports byte ranges (the HTTP delivery contract)', async () => {
  const storage = await testStorage(join(dir, 's4'));
  const key = { kind: /** @type {const} */ ('object'), sha256: 'f'.repeat(64) };
  await storage.writeAtomic(key, Buffer.from('0123456789'));
  assert.equal((await streamToBuffer(await storage.open(key, { start: 2, end: 5 }))).toString(), '2345');
  assert.equal((await streamToBuffer(await storage.open(key))).toString(), '0123456789');
});

test('UrlSigner: current-only, rotation grace with previous, and rejection once previous is dropped', () => {
  const now = 1_700_000_000_000;
  const exp = Math.floor(now / 1000) + 60;

  const k1Only = new UrlSigner(SIGNING_SECRET);
  const sigK1 = k1Only.sign('f1', 'thumb', exp);
  assert.equal(k1Only.verify({ fileId: 'f1', variant: 'thumb', exp, sig: sigK1 }, now), true);

  const K2 = 'k'.repeat(40);
  const rotating = new UrlSigner(K2, SIGNING_SECRET);
  assert.equal(rotating.verify({ fileId: 'f1', variant: 'thumb', exp, sig: sigK1 }, now), true, 'old K1 URL verifies during grace');
  const sigK2 = rotating.sign('f1', 'thumb', exp);
  assert.notEqual(sigK2, sigK1);
  assert.equal(rotating.verify({ fileId: 'f1', variant: 'thumb', exp, sig: sigK2 }, now), true, 'new URLs are signed with current (K2)');

  const graceOver = new UrlSigner(K2);
  assert.equal(graceOver.verify({ fileId: 'f1', variant: 'thumb', exp, sig: sigK1 }, now), false, 'K1 rejected once previous is removed');
  assert.equal(graceOver.verify({ fileId: 'f1', variant: 'thumb', exp, sig: sigK2 }, now), true, 'K2 URL keeps working');

  assert.equal(rotating.verify({ fileId: 'f1', variant: 'thumb', exp, sig: 'tampered' }, now), false);
  assert.equal(rotating.verify({ fileId: 'f1', variant: 'thumb', exp, sig: sigK1 }, exp * 1000), false, 'expired, independent of rotation');
});

test('UrlSigner: variant/file binding, expiry and constant-time compare (no rotation)', () => {
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
