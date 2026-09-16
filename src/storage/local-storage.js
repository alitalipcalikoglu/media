import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { TypeSniffer } from './type-sniffer.js';

export class UploadError extends Error {
  /**
   * @param {'TOO_LARGE'|'EMPTY'|'STREAM_ERROR'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
  }
}

/**
 * @typedef {object} Received
 * @property {string} tmpPath
 * @property {string} sha256
 * @property {number} size
 * @property {Buffer} head   First bytes, for type sniffing.
 */

/**
 * Content-addressed object storage on the local file system.
 *
 *   <dataDir>/tmp/<uuid>                incoming uploads
 *   <dataDir>/objects/ab/cd/<sha256>    immutable originals
 *   <dataDir>/variants/<sha256>/<name>  derived images
 */
export class LocalStorage {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
  }

  async init() {
    await Promise.all(['tmp', 'objects', 'variants'].map((d) => mkdir(join(this.dataDir, d), { recursive: true })));
    // Anything left in tmp belongs to an interrupted upload.
    await rm(join(this.dataDir, 'tmp'), { recursive: true, force: true });
    await mkdir(join(this.dataDir, 'tmp'), { recursive: true });
    return this;
  }

  /** @param {string} sha256 */
  objectPath(sha256) {
    LocalStorage.#assertSha(sha256);
    return join(this.dataDir, 'objects', sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  /** @param {string} sha256 */
  variantDir(sha256) {
    LocalStorage.#assertSha(sha256);
    return join(this.dataDir, 'variants', sha256);
  }

  /**
   * @param {string} sha256
   * @param {string} name Preset name, already validated against configuration.
   */
  variantPath(sha256, name) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error('invalid variant name');
    return join(this.variantDir(sha256), `${name}.webp`);
  }

  /**
   * Stream an upload to a temp file while hashing, counting and capturing the head.
   * Rejects with {@link UploadError} and removes the temp file when the limit is exceeded.
   * @param {NodeJS.ReadableStream} source
   * @param {{ maxBytes: number }} o
   * @returns {Promise<Received>}
   */
  async receive(source, { maxBytes }) {
    const tmpPath = join(this.dataDir, 'tmp', randomUUID());
    const hash = createHash('sha256');
    let size = 0;
    /** @type {Buffer[]} */
    const headChunks = [];
    let headSize = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new UploadError('TOO_LARGE', `upload exceeds ${maxBytes} bytes`));
        hash.update(chunk);
        if (headSize < TypeSniffer.HEAD_BYTES) {
          headChunks.push(chunk);
          headSize += chunk.length;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      if (err instanceof UploadError) throw err;
      throw new UploadError('STREAM_ERROR', `upload interrupted: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (size === 0) {
      await unlink(tmpPath).catch(() => {});
      throw new UploadError('EMPTY', 'upload is empty');
    }
    return { tmpPath, sha256: hash.digest('hex'), size, head: Buffer.concat(headChunks).subarray(0, TypeSniffer.HEAD_BYTES) };
  }

  /**
   * Move a temp file into place as the object for `sha256`. If the object already exists the
   * temp file is discarded (content-addressed dedupe).
   * @param {string} tmpPath
   * @param {string} sha256
   * @returns {Promise<boolean>} true when a new object was stored.
   */
  async commit(tmpPath, sha256) {
    const dest = this.objectPath(sha256);
    if (await this.exists(sha256)) {
      await unlink(tmpPath);
      return false;
    }
    await mkdir(dirname(dest), { recursive: true });
    await rename(tmpPath, dest);
    return true;
  }

  /**
   * Write a file atomically (temp + rename) at `path` inside the data dir.
   * @param {string} path
   * @param {Buffer} data
   */
  async writeAtomic(path, data) {
    const tmp = join(this.dataDir, 'tmp', randomUUID());
    await mkdir(dirname(path), { recursive: true });
    await pipeline([data], createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    await rename(tmp, path);
  }

  /** @param {string} path */
  async discard(path) {
    await unlink(path).catch(() => {});
  }

  /** @param {string} sha256 */
  async exists(sha256) {
    return stat(this.objectPath(sha256)).then((s) => s.isFile(), () => false);
  }

  /**
   * @param {string} path
   * @returns {Promise<import('node:fs').Stats|null>}
   */
  async statPath(path) {
    return stat(path).catch(() => null);
  }

  /** Remove an object and every derived variant. @param {string} sha256 */
  async remove(sha256) {
    await unlink(this.objectPath(sha256)).catch(() => {});
    await rm(this.variantDir(sha256), { recursive: true, force: true });
  }

  /** @param {string} sha256 */
  static #assertSha(sha256) {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid sha256');
  }
}
