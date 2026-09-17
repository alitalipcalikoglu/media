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

test('Stage 8: STORAGE_DRIVER — only "local" is valid, unknown fails fast at startup', () => {
  assert.equal(testConfig().storageDriver, 'local', 'default, backward compatible');
  assert.equal(testConfig({ STORAGE_DRIVER: 'local' }).storageDriver, 'local');
  assert.throws(() => Config.fromEnv({ ...fullEnv(), STORAGE_DRIVER: 's3' }), (e) => e instanceof ConfigError && /STORAGE_DRIVER/.test(e.message));
});

test('Stage 8: SIGNING_SECRET_PREVIOUS — optional, validated the same as SIGNING_SECRET, must differ from it', () => {
  assert.equal(testConfig().signingSecretPrevious, undefined, 'no rotation in progress by default');
  const K2 = 'k'.repeat(40);
  assert.equal(testConfig({ SIGNING_SECRET: K2, SIGNING_SECRET_PREVIOUS: 's'.repeat(40) }).signingSecretPrevious, 's'.repeat(40));
  assert.throws(() => Config.fromEnv({ ...fullEnv(), SIGNING_SECRET_PREVIOUS: 'short' }), (e) => e instanceof ConfigError && /SIGNING_SECRET_PREVIOUS/.test(e.message));
  assert.throws(() => Config.fromEnv({ ...fullEnv(), SIGNING_SECRET_PREVIOUS: fullEnv().SIGNING_SECRET }), (e) => e instanceof ConfigError && /must not be the same/.test(e.message));
});

test('Stage 8: MAX_CONCURRENT_VARIANTS and VARIANT_WAIT_TIMEOUT_MS have sane defaults and validated ranges', () => {
  const c = testConfig();
  assert.equal(c.maxConcurrentVariants, 4);
  assert.equal(c.variantWaitTimeoutMs, 30_000);
  assert.equal(testConfig({ MAX_CONCURRENT_VARIANTS: '1' }).maxConcurrentVariants, 1);
  assert.throws(() => Config.fromEnv({ ...fullEnv(), MAX_CONCURRENT_VARIANTS: '0' }), ConfigError);
  assert.throws(() => Config.fromEnv({ ...fullEnv(), VARIANT_WAIT_TIMEOUT_MS: '100' }), ConfigError);
});
