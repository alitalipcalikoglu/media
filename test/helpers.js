import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { LocalStorage } from '../src/storage/local-storage.js';

export const API_KEY = 'k'.repeat(40);
export const OTHER_KEY = 'o'.repeat(40);
export const SIGNING_SECRET = 's'.repeat(40);

export function fullEnv() {
  return {
    MEDIA_API_KEYS: `test:${API_KEY},other:${OTHER_KEY}`,
    PUBLIC_BASE_URL: 'https://media.test.local',
    SIGNING_SECRET,
    DB_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    MAX_UPLOAD_BYTES: '2000000',
  };
}

/** @param {Record<string, string>} [overrides] */
export function testConfig(overrides = {}) {
  return Config.fromEnv({ ...fullEnv(), ...overrides });
}

export function testDb() {
  return new Database(':memory:');
}

/** Temp data directory with cleanup. */
export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'media-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** @param {string} dir */
export async function testStorage(dir) {
  return new LocalStorage(dir).init();
}

/** @param {Buffer|string} data */
export function streamOf(data) {
  return Readable.from([Buffer.isBuffer(data) ? data : Buffer.from(data)]);
}

/**
 * Generate a test image.
 * @param {{ width?: number, height?: number, format?: 'jpeg'|'png'|'webp'|'gif'|'avif', withExif?: boolean }} [o]
 */
export async function testImage({ width = 640, height = 480, format = 'jpeg', withExif = false } = {}) {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 60 } } });
  if (withExif) img = img.withExif({ IFD0: { Copyright: 'Test Owner', Artist: 'Someone' } });
  return img.toFormat(format).toBuffer();
}

/** Silent pino-compatible logger. */
export const silentLog = /** @type {any} */ (new Proxy({}, {
  get: (_t, prop) => (prop === 'child' ? () => silentLog : () => {}),
}));
