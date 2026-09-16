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

/**
 * Fully wired MediaService on a temp directory and in-memory database.
 * @param {Record<string, string>} [envOverrides]
 */
export async function testMediaService(envOverrides = {}) {
  const { FileStore } = await import('../src/store/file-store.js');
  const { TicketStore } = await import('../src/store/ticket-store.js');
  const { ImageProcessor } = await import('../src/domain/image-processor.js');
  const { MediaService } = await import('../src/domain/media-service.js');
  const { UrlSigner } = await import('../src/url-signer.js');
  const config = testConfig(envOverrides);
  const { dir, cleanup } = tempDir();
  const db = testDb();
  const files = new FileStore(db);
  const tickets = new TicketStore(db);
  const storage = await testStorage(dir);
  const clock = { now: Date.now() };
  const service = new MediaService({
    files, tickets, storage,
    images: new ImageProcessor({ maxPixels: config.maxImagePixels, quality: config.variantQuality }),
    signer: new UrlSigner(config.signingSecret),
    log: silentLog,
    options: {
      publicBaseUrl: config.publicBaseUrl, maxUploadBytes: config.maxUploadBytes, allowedTypes: config.allowedTypes, variants: config.variants,
      stripImageMetadata: config.stripImageMetadata, signedUrlTtlSec: config.signedUrlTtlSec, uploadTicketTtlSec: config.uploadTicketTtlSec,
      deleteGraceMs: config.deleteGraceDays * 86_400_000,
    },
    now: () => clock.now,
  });
  return { service, config, db, files, tickets, storage, clock, dir, cleanup };
}
