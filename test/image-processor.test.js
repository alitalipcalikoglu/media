import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import sharp from 'sharp';
import { MediaError } from '../src/domain/errors.js';
import { FileName } from '../src/domain/file-name.js';
import { ImageProcessor } from '../src/domain/image-processor.js';
import { tempDir, testImage } from './helpers.js';

const { dir, cleanup } = tempDir();
after(cleanup);
const proc = new ImageProcessor({ maxPixels: 1_000_000, quality: 80 });

test('inspect returns oriented dimensions and rejects junk and oversized images', async () => {
  const jpg = await testImage({ width: 400, height: 300 });
  assert.deepEqual(await proc.inspect(jpg), { width: 400, height: 300, format: 'jpeg', pages: 1 });
  const rotated = await sharp(jpg).withMetadata({ orientation: 6 }).toBuffer();
  const meta = await proc.inspect(rotated);
  assert.deepEqual([meta.width, meta.height], [300, 400], 'EXIF orientation 6 swaps dimensions');
  await assert.rejects(proc.inspect(Buffer.from('not an image')), (e) => e instanceof MediaError && e.code === 'INVALID_IMAGE');
  const huge = await testImage({ width: 2000, height: 2000, format: 'png' });
  await assert.rejects(proc.inspect(huge), (e) => e instanceof MediaError && /pixel/.test(e.message));
});

test('normalize strips EXIF, applies orientation and keeps the format', async () => {
  const src = await sharp(await testImage({ width: 400, height: 300, withExif: true })).withMetadata({ orientation: 6 }).toBuffer();
  assert.ok((await sharp(src).metadata()).exif, 'source carries EXIF');
  const p = join(dir, 'src.jpg');
  writeFileSync(p, src);
  const out = await proc.normalize(p, 'image/jpeg');
  assert.deepEqual([out.width, out.height], [300, 400]);
  const meta = await sharp(out.buffer).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.exif, undefined, 'EXIF gone');
  assert.equal(meta.orientation, undefined);

  for (const format of /** @type {const} */ (['png', 'webp', 'gif'])) {
    const f = join(dir, `src.${format}`);
    writeFileSync(f, await testImage({ width: 64, height: 32, format }));
    const n = await proc.normalize(f, `image/${format}`);
    assert.equal((await sharp(n.buffer).metadata()).format, format);
    assert.deepEqual([n.width, n.height], [64, 32]);
  }
  await assert.rejects(proc.normalize(p, 'application/pdf'), (e) => e instanceof MediaError && e.code === 'NOT_AN_IMAGE');
});

test('variant resizes to the preset without enlarging and outputs metadata-free WebP', async () => {
  const p = join(dir, 'v.jpg');
  writeFileSync(p, await testImage({ width: 800, height: 600 }));
  const cover = await sharp(await proc.variant(p, { name: 'thumb', width: 200, height: 200, fit: 'cover' })).metadata();
  assert.deepEqual([cover.format, cover.width, cover.height], ['webp', 200, 200]);
  const inside = await sharp(await proc.variant(p, { name: 'small', width: 400, height: null, fit: 'inside' })).metadata();
  assert.deepEqual([inside.width, inside.height], [400, 300]);
  const big = await sharp(await proc.variant(p, { name: 'large', width: 1600, height: null, fit: 'inside' })).metadata();
  assert.deepEqual([big.width, big.height], [800, 600], 'never enlarges');
  assert.equal(big.exif, undefined);
});

test('FileName sanitises names and fixes the extension to the sniffed type', () => {
  assert.equal(FileName.sanitize('../../etc/passwd', 'image/png'), 'passwd.png');
  assert.equal(FileName.sanitize('photo.exe', 'image/jpeg'), 'photo.jpg');
  assert.equal(FileName.sanitize('  "quoted"<x>.PNG ', 'image/png'), 'quotedx.png');
  assert.equal(FileName.sanitize('', 'application/pdf'), 'file.pdf');
  assert.equal(FileName.sanitize(null, 'image/webp'), 'file.webp');
  assert.equal(FileName.sanitize('.hidden', 'image/gif'), 'hidden.gif');
  assert.equal(FileName.sanitize('ç\u0000ay fotoğrafı.jpeg', 'image/jpeg'), 'çay fotoğrafı.jpg');
  assert.ok(FileName.sanitize('x'.repeat(500), 'image/png').length <= FileName.MAX_LENGTH);
  assert.equal(FileName.disposition('inline', 'çay.jpg'), `inline; filename="_ay.jpg"; filename*=UTF-8''%C3%A7ay.jpg`);
  assert.equal(FileName.disposition('attachment', 'a"b.pdf'), `attachment; filename="a_b.pdf"; filename*=UTF-8''a%22b.pdf`);
});
