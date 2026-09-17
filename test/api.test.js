import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import sharp from 'sharp';
import { MediaApi } from '../src/http/media-api.js';
import { API_KEY, OTHER_KEY, silentLog, testImage, testMediaService } from './helpers.js';

/** @type {Awaited<ReturnType<typeof testMediaService>>} */
let t;
/** @type {import('fastify').FastifyInstance} */
let app;
const auth = { authorization: `Bearer ${API_KEY}` };

/** @param {string} method @param {string} url @param {{ payload?: any, headers?: Record<string, string> }} [o] */
const call = (method, url, { payload, headers = {} } = {}) => app.inject({ method: /** @type {any} */ (method), url, payload, headers: { ...auth, ...headers } });

before(async () => {
  t = await testMediaService({ CORS_ORIGINS: 'https://app.test.local', RATE_LIMIT_MAX: '500' });
  app = await new MediaApi({ config: t.config, service: t.service, db: t.db, files: t.files, logger: silentLog }).build();
  await app.ready();
});
after(async () => { await app.close(); t.cleanup(); });

test('probes are public; /v1 and /metrics need an API key', async () => {
  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal((await app.inject('/ready')).statusCode, 200);
  for (const url of ['/v1/files', '/metrics']) {
    const res = await app.inject({ url });
    assert.equal(res.statusCode, 401, url);
  }
  assert.equal((await app.inject({ url: '/nope', headers: auth })).statusCode, 404);
});

test('/ready never disturbs an upload that is still streaming into tmp', async () => {
  const { streamOf } = await import('./helpers.js');
  const receiving = t.service.storage.receive(streamOf(Buffer.from('in-flight upload bytes')), { maxBytes: 1_000_000 });
  assert.equal((await app.inject('/ready')).statusCode, 200, 'first poll (may run storage.check())');
  assert.equal((await app.inject('/ready')).statusCode, 200);
  const received = await receiving;
  assert.equal(await t.service.storage.commit(received.tmpPath, received.sha256), true, 'the upload that was in flight during /ready still commits');
});

test('PUT /v1/files stores a raw body, GET/PATCH/DELETE/restore manage it', async () => {
  const jpg = await testImage({ width: 800, height: 600 });
  let res = await call('PUT', '/v1/files?visibility=public', { payload: jpg, headers: { 'content-type': 'image/jpeg', 'x-file-name': encodeURIComponent('tatil fotoğrafı.JPG') } });
  assert.equal(res.statusCode, 201, res.body);
  const { file } = res.json();
  assert.equal(file.mime, 'image/jpeg');
  assert.equal(file.name, 'tatil fotoğrafı.jpg');
  assert.deepEqual([file.width, file.height], [800, 600]);
  assert.equal(file.urls.original.url, `https://media.test.local/files/${file.id}/original`);
  assert.ok(file.urls.thumb);
  assert.equal(res.headers.location, `/v1/files/${file.id}`);

  res = await call('PUT', '/v1/files', { payload: Buffer.from('<html>hi</html>'), headers: { 'content-type': 'image/png' } });
  assert.equal(res.statusCode, 415, 'declared type ignored, sniffed type rules');
  assert.equal(res.json().error.code, 'UNSUPPORTED_TYPE');
  res = await call('PUT', '/v1/files', { payload: Buffer.alloc(0) });
  assert.equal(res.statusCode, 400);
  assert.equal((await call('PUT', '/v1/files?visibility=secret', { payload: jpg })).statusCode, 400);

  res = await call('GET', `/v1/files/${file.id}`);
  assert.equal(res.json().file.id, file.id);
  assert.equal((await app.inject({ url: `/v1/files/${file.id}`, headers: { authorization: `Bearer ${OTHER_KEY}` } })).statusCode, 404, 'owner scoped');
  res = await call('GET', '/v1/files?limit=1');
  assert.equal(res.json().items.length, 1);

  res = await call('PATCH', `/v1/files/${file.id}`, { payload: { visibility: 'private', name: 'renamed' } });
  assert.equal(res.json().file.visibility, 'private');
  assert.equal(res.json().file.name, 'renamed.jpg');
  assert.match(res.json().file.urls.original.url, /\?exp=\d+&sig=/);
  assert.equal((await call('PATCH', `/v1/files/${file.id}`, { payload: {} })).statusCode, 400);

  res = await call('POST', `/v1/files/${file.id}/urls?ttl=60`);
  const exp = Number(new URL(res.json().urls.original.url).searchParams.get('exp'));
  assert.ok(exp * 1000 - t.clock.now <= 60_000 && exp * 1000 - t.clock.now > 50_000);

  assert.equal((await call('DELETE', `/v1/files/${file.id}`)).statusCode, 204);
  assert.equal((await call('GET', `/v1/files/${file.id}`)).statusCode, 404);
  assert.equal((await app.inject(`/files/${file.id}/original`)).statusCode, 404, 'deleted files are not served');
  res = await call('POST', `/v1/files/${file.id}/restore`);
  assert.equal(res.statusCode, 200);
  assert.equal((await call('GET', `/v1/files/${file.id}`)).statusCode, 200);
});

test('delivery: public direct, private signed, ETag, Range, HEAD, variants, security headers', async () => {
  const png = await testImage({ width: 600, height: 400, format: 'png' });
  const pub = (await call('PUT', '/v1/files?visibility=public&name=pic', { payload: png })).json().file;
  let res = await app.inject(`/files/${pub.id}/original`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(String(res.headers['content-disposition']), /^inline; filename="pic.png"/);
  assert.match(String(res.headers['content-security-policy']), /sandbox/);
  assert.equal(Number(res.headers['content-length']), pub.size);
  assert.equal(res.rawPayload.length, pub.size);
  const etag = String(res.headers.etag);
  assert.equal((await app.inject({ url: `/files/${pub.id}/original`, headers: { 'if-none-match': etag } })).statusCode, 304);

  res = await app.inject({ url: `/files/${pub.id}/original`, headers: { range: 'bytes=0-9' } });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-range'], `bytes 0-9/${pub.size}`);
  assert.equal(res.rawPayload.length, 10);
  assert.ok(res.rawPayload.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
  res = await app.inject({ url: `/files/${pub.id}/original`, headers: { range: 'bytes=-5' } });
  assert.equal(res.headers['content-range'], `bytes ${pub.size - 5}-${pub.size - 1}/${pub.size}`);
  res = await app.inject({ url: `/files/${pub.id}/original`, headers: { range: `bytes=${pub.size}-` } });
  assert.equal(res.statusCode, 416);
  res = await app.inject({ method: 'HEAD', url: `/files/${pub.id}/original` });
  assert.equal(res.statusCode, 200);
  assert.equal(Number(res.headers['content-length']), pub.size);
  assert.equal(res.rawPayload.length, 0);

  res = await app.inject(`/files/${pub.id}/thumb`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.match(String(res.headers['content-disposition']), /filename="pic-thumb.webp"/);
  const meta = await sharp(res.rawPayload).metadata();
  assert.deepEqual([meta.width, meta.height], [200, 200]);
  assert.equal((await app.inject(`/files/${pub.id}/nope`)).statusCode, 404);
  assert.equal((await app.inject(`/files/${pub.id}/Thumb`)).statusCode, 400);

  const priv = (await call('PUT', '/v1/files?visibility=private', { payload: png })).json().file;
  res = await app.inject(`/files/${priv.id}/original`);
  assert.equal(res.statusCode, 403);
  const signed = new URL(priv.urls.medium.url);
  res = await app.inject(`${signed.pathname}${signed.search}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'private, max-age=0, no-store');
  assert.equal((await app.inject(`/files/${priv.id}/thumb${signed.search}`)).statusCode, 403, 'signature bound to variant');

  const pdf = (await call('PUT', '/v1/files?visibility=public&name=report', { payload: Buffer.from('%PDF-1.4\n%%EOF') })).json().file;
  res = await app.inject(`/files/${pdf.id}/original`);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(String(res.headers['content-disposition']), /^attachment; filename="report.pdf"/);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal((await app.inject(`/files/${pdf.id}/thumb`)).statusCode, 400);
});

test('upload tickets let a browser PUT directly, once, within constraints, with CORS', async () => {
  let res = await call('POST', '/v1/uploads', { payload: { visibility: 'public', maxBytes: 100_000, allowedTypes: ['image/png'], name: 'avatar' } });
  assert.equal(res.statusCode, 201);
  const ticket = res.json();
  assert.equal(ticket.method, 'PUT');
  assert.match(ticket.uploadUrl, new RegExp(`/v1/uploads/${ticket.token}$`));
  const path = new URL(ticket.uploadUrl).pathname;

  const pre = await app.inject({ method: 'OPTIONS', url: path, headers: { origin: 'https://app.test.local', 'access-control-request-method': 'PUT' } });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], 'https://app.test.local');
  assert.match(String(pre.headers['access-control-allow-methods']), /PUT/);
  const denied = await app.inject({ method: 'OPTIONS', url: path, headers: { origin: 'https://evil.test' } });
  assert.equal(denied.headers['access-control-allow-origin'], undefined);

  res = await app.inject({ method: 'PUT', url: path, payload: await testImage({ format: 'jpeg' }), headers: { origin: 'https://app.test.local' } });
  assert.equal(res.statusCode, 415, 'ticket restricts types');
  res = await app.inject({ method: 'PUT', url: path, payload: await testImage({ format: 'png', width: 100, height: 100 }), headers: { origin: 'https://app.test.local' } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.headers['access-control-allow-origin'], 'https://app.test.local');
  assert.equal(res.json().file.name, 'avatar.png');
  assert.equal(res.json().file.visibility, 'public');
  res = await app.inject({ method: 'PUT', url: path, payload: await testImage({ format: 'png' }) });
  assert.equal(res.statusCode, 401, 'single use');
  assert.equal((await app.inject({ method: 'PUT', url: `/v1/uploads/${'x'.repeat(43)}`, payload: 'x' })).statusCode, 401);
  assert.equal((await call('POST', '/v1/uploads', { payload: { maxBytes: 10 ** 9 } })).statusCode, 400);

  const metrics = await call('GET', '/metrics');
  assert.match(metrics.body, /media_files \d+/);
  assert.match(metrics.body, /media_uploads_total [1-9]\d*/);
  assert.match(metrics.body, /media_downloads_total [1-9]\d*/);
});
