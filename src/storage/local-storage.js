import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { Storage, UploadError } from './storage.js';
import { TypeSniffer } from './type-sniffer.js';

export { UploadError };

/** @typedef {import('./storage.js').StorageKey} StorageKey */
/** @typedef {import('./storage.js').ObjectKey} ObjectKey */
/** @typedef {import('./storage.js').TempKey} TempKey */
/** @typedef {import('./storage.js').Received} Received */

const SHA256_RE = /^[0-9a-f]{64}$/;
const VARIANT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const TEMP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Content-addressed object storage on the local file system, behind the {@link Storage}
 * contract — see there for the operations and their semantics. On-disk layout (an implementation
 * detail no caller outside this file depends on):
 *
 *   <dataDir>/tmp/<uuid>                incoming uploads and scratch content
 *   <dataDir>/objects/ab/cd/<sha256>    immutable originals
 *   <dataDir>/variants/<sha256>/<name>.webp   derived images
 *
 * Every key field (`sha256`, variant `name`, temp `id`) is validated against a strict allowlist
 * before it ever reaches a path — the same boundary the pre-abstraction version enforced, just
 * relocated behind {@link Storage}'s key types instead of raw strings. A 64-hex-character sha256,
 * a `[a-z][a-z0-9-]{0,31}` variant name or a v4-shaped UUID cannot contain `/`, `..` or a `\0`, so
 * there is no path-traversal, absolute-path or separator-injection surface to escape through —
 * `#assertKey` rejects anything else before any `fs` call is ever reached.
 * @extends {Storage}
 */
export class LocalStorage extends Storage {
  /** @param {string} dataDir */
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
  }

  /**
   * Create the directory layout and clear `tmp` of anything left by an interrupted upload. Call
   * once at process start, never from a readiness probe: it deletes in-flight upload files.
   */
  async prepare() {
    await Promise.all(['tmp', 'objects', 'variants', 'trash'].map((d) => mkdir(join(this.dataDir, d), { recursive: true })));
    await rm(join(this.dataDir, 'tmp'), { recursive: true, force: true });
    await mkdir(join(this.dataDir, 'tmp'), { recursive: true });
    return this;
  }

  /**
   * Cheap, non-destructive readiness check: the directory layout exists and is writable. Safe to
   * call on every `/ready` poll; never touches `tmp` contents.
   */
  async check() {
    await Promise.all(['tmp', 'objects', 'variants', 'trash'].map((d) => mkdir(join(this.dataDir, d), { recursive: true })));
    return this;
  }

  /** @returns {TempKey} */
  tempKey() {
    return { kind: 'temp', id: randomUUID() };
  }

  /**
   * @param {NodeJS.ReadableStream} source
   * @param {{ maxBytes: number }} o
   * @returns {Promise<Received>}
   */
  async writeTemp(source, { maxBytes }) {
    const key = this.tempKey();
    const tmpPath = this.#path(key);
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
    return { key, sha256: hash.digest('hex'), size, head: Buffer.concat(headChunks).subarray(0, TypeSniffer.HEAD_BYTES) };
  }

  /**
   * `link()`, not `exists()`-then-`rename()`: `rename()` onto an existing destination silently
   * replaces it on POSIX, so two commits of the same key racing each other could both "succeed"
   * and both report `true` — the exact same-content-dedup safety the interface promises would be
   * unsound under real concurrency. `link()` atomically fails with `EEXIST` when the destination
   * is already there (same guarantee as `open(O_CREAT|O_EXCL)`), so of any number of concurrent
   * commits of the same key, the kernel guarantees exactly one link succeeds.
   *
   * Stage 8.1: on the dedup (`false`) path, `tempKey` is deliberately left untouched instead of
   * being auto-discarded — the caller (`MediaService`) may need to `commit()` again from the same
   * temp copy if it discovers the object it deduped against was concurrently removed by a stale
   * purge (see docs/READINESS.md "Purge/upload race"). The caller owns `discard(tempKey)` once
   * it's actually done with it, on every path (this is why `MediaService.upload`'s `catch` always
   * discards, unconditionally).
   * @param {TempKey} tempKey
   * @param {StorageKey} key
   * @returns {Promise<boolean>}
   */
  async commit(tempKey, key) {
    const dest = this.#path(key);
    const src = this.#path(tempKey);
    await mkdir(dirname(dest), { recursive: true });
    try {
      await link(src, dest);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
      return false;
    }
    await unlink(src);
    return true;
  }

  /**
   * @param {StorageKey|TempKey} key
   * @param {Buffer} data
   */
  async writeAtomic(key, data) {
    const dest = this.#path(key);
    const tmp = this.#path(this.tempKey());
    await mkdir(dirname(dest), { recursive: true });
    await pipeline([data], createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    await rename(tmp, dest);
  }

  /** @param {StorageKey} key */
  async exists(key) {
    return stat(this.#path(key)).then((s) => s.isFile(), () => false);
  }

  /**
   * @param {StorageKey|TempKey} key
   * @param {{ start?: number, end?: number }} [range]
   * @returns {Promise<NodeJS.ReadableStream>}
   */
  async open(key, range = {}) {
    return createReadStream(this.#path(key), range);
  }

  /** @param {StorageKey} key */
  async stat(key) {
    const s = await stat(this.#path(key)).catch(() => null);
    return s ? { size: s.size } : null;
  }

  /**
   * LocalStorage always has one — this is the one backend where the escape hatch documented on
   * {@link Storage#localPath} is always taken.
   * @param {StorageKey|TempKey} key
   */
  async localPath(key) {
    return this.#path(key);
  }

  /** Remove an object and every derived variant, or a single variant. @param {StorageKey} key */
  async remove(key) {
    await unlink(this.#path(key)).catch(() => {});
    if (key.kind === 'object') await rm(this.#variantDir(key.sha256), { recursive: true, force: true });
  }

  /** @param {TempKey} key */
  async discard(key) {
    await unlink(this.#path(key)).catch(() => {});
  }

  /**
   * Single atomic `rename()` per target (object, variant directory) into a token-scoped trash
   * path — never a copy, never a delete-then-recreate, so there is no instant where the canonical
   * path is "half gone". Each target's `rename` is independent: an `ENOENT` (nothing there for
   * that target) is swallowed, anything else propagates.
   * @param {ObjectKey} key
   * @param {string} token
   * @returns {Promise<boolean>}
   */
  async detachForDelete(key, token) {
    if (!TOKEN_RE.test(token)) throw new Error('invalid token');
    const [object, variants] = await Promise.all([
      rename(this.#path(key), this.#trashPath(token, 'object')).then(() => true, (err) => {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
        return false;
      }),
      rename(this.#variantDir(key.sha256), this.#trashPath(token, 'variants')).then(() => true, (err) => {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
        return false;
      }),
    ]);
    return object || variants;
  }

  /** @param {string} token */
  async discardDetached(token) {
    if (!TOKEN_RE.test(token)) throw new Error('invalid token');
    await Promise.all([
      rm(this.#trashPath(token, 'object'), { force: true }),
      rm(this.#trashPath(token, 'variants'), { recursive: true, force: true }),
    ]);
  }

  /**
   * @param {string} token
   * @param {'object'|'variants'} kind
   */
  #trashPath(token, kind) {
    return join(this.dataDir, 'trash', `${token}.${kind}`);
  }

  /**
   * Maps a validated {@link StorageKey}/{@link TempKey} to its on-disk path. The only place a
   * filesystem path is ever constructed — every field is checked against its allowlist first.
   * @param {StorageKey|TempKey} key
   */
  #path(key) {
    if (key.kind === 'temp') {
      if (!TEMP_ID_RE.test(key.id)) throw new Error('invalid temp key');
      return join(this.dataDir, 'tmp', key.id);
    }
    if (!SHA256_RE.test(key.sha256)) throw new Error('invalid sha256');
    if (key.kind === 'object') return join(this.dataDir, 'objects', key.sha256.slice(0, 2), key.sha256.slice(2, 4), key.sha256);
    if (!VARIANT_NAME_RE.test(key.name)) throw new Error('invalid variant name');
    return join(this.#variantDir(key.sha256), `${key.name}.webp`);
  }

  /** @param {string} sha256 */
  #variantDir(sha256) {
    if (!SHA256_RE.test(sha256)) throw new Error('invalid sha256');
    return join(this.dataDir, 'variants', sha256);
  }
}
