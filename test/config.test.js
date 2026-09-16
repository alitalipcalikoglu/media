import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError, VariantPreset } from '../src/config.js';
import { fullEnv, testConfig } from './helpers.js';

test('defaults apply, required values enforced', () => {
  const c = testConfig();
  assert.equal(c.port, 3003);
  assert.deepEqual(c.allowedTypes, ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'application/pdf']);
  assert.deepEqual(c.variants.map((v) => v.name), ['thumb', 'small', 'medium', 'large']);
  assert.deepEqual(c.variants[0], { name: 'thumb', width: 200, height: 200, fit: 'cover' });
  assert.deepEqual(c.variants[1], { name: 'small', width: 400, height: null, fit: 'inside' });
  assert.deepEqual(c.corsOrigins, []);
  for (const missing of ['MEDIA_API_KEYS', 'PUBLIC_BASE_URL', 'SIGNING_SECRET']) {
    assert.throws(() => Config.fromEnv({ ...fullEnv(), [missing]: '' }), ConfigError, missing);
  }
});

test('rejects malformed values', () => {
  const bad = [
    { PUBLIC_BASE_URL: 'https://media.test.local/path' }, { SIGNING_SECRET: 'short' }, { ALLOWED_TYPES: 'image/jpeg,text/html' },
    { VARIANTS: 'thumb:200,thumb:300' }, { VARIANTS: 'original:200' }, { VARIANTS: 'big:5000' }, { VARIANTS: 'Thumb:200' },
    { CORS_ORIGINS: 'https://a.com/path' }, { MAX_UPLOAD_BYTES: '10' }, { TLS_CERT_PATH: '/c.pem' }, { VARIANT_QUALITY: '0' },
  ];
  for (const o of bad) assert.throws(() => Config.fromEnv({ ...fullEnv(), ...o }), ConfigError, JSON.stringify(o));
  assert.deepEqual(VariantPreset.parse('hero:1200x600:inside'), { name: 'hero', width: 1200, height: 600, fit: 'inside' });
  assert.deepEqual(testConfig({ CORS_ORIGINS: 'https://app.test.local, *' }).corsOrigins, ['https://app.test.local', '*']);
  assert.deepEqual(testConfig({ ALLOWED_TYPES: '' }).allowedTypes, [], 'explicit empty list allowed (no uploads)');
});
