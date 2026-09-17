import { createHash } from 'node:crypto';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { UploadError } from '../storage/storage.js';
import { TypeSniffer } from '../storage/type-sniffer.js';
import { MediaError } from './errors.js';
import { FileName } from './file-name.js';
import { Semaphore, SemaphoreQueueFullError, SemaphoreTimeoutError } from './semaphore.js';

/** @typedef {import('../types.js').FileRecord} FileRecord */
/** @typedef {import('../types.js').Visibility} Visibility */
/** @typedef {import('../types.js').VariantSpec} VariantSpec */
/** @typedef {import('../types.js').Logger} Logger */
/** @typedef {import('../store/file-store.js').FileStore} FileStore */
/** @typedef {import('../store/ticket-store.js').TicketStore} TicketStore */
/** @typedef {import('../storage/storage.js').Storage} Storage */
/** @typedef {import('../storage/storage.js').StorageKey} StorageKey */
/** @typedef {import('./image-processor.js').ImageProcessor} ImageProcessor */
/** @typedef {import('../url-signer.js').UrlSigner} UrlSigner */

/**
 * @typedef {object} UploadOptions
 * @property {string} apiKeyId
 * @property {string|null} [name]
 * @property {Visibility} [visibility]
 * @property {number} [maxBytes]          Tighter than the service limit (tickets).
 * @property {string[]} [allowedTypes]    Subset of the service list (tickets).
 */

/**
 * @typedef {object} MediaServiceOptions
 * @property {string} publicBaseUrl
 * @property {number} maxUploadBytes
 * @property {string[]} allowedTypes
 * @property {VariantSpec[]} variants
 * @property {boolean} stripImageMetadata
 * @property {number} signedUrlTtlSec
 * @property {number} uploadTicketTtlSec
 * @property {number} deleteGraceMs
 * @property {number} maxConcurrentVariants   Active CPU-bound variant generations allowed at once, process-wide.
 * @property {number} variantWaitTimeoutMs    Bound on how long a NEW (non-deduped) generation waits for a free slot.
 */

/**
 * All media use-cases: upload (direct or by ticket), metadata, visibility, deletion with grace
 * period, variant generation, URL building and signed-URL authorisation. Talks to bytes only
 * through {@link Storage} — never `node:fs`, `node:path`, or a local filesystem path (the one
 * documented exception being the CPU-bound image decode below, via `Storage#localPath`'s
 * explicit, nullable escape hatch, with a buffering fallback when it is null).
 */
export class MediaService {
  /**
   * @param {object} deps
   * @param {FileStore} deps.files
   * @param {TicketStore} deps.tickets
   * @param {Storage} deps.storage
   * @param {ImageProcessor} deps.images
   * @param {UrlSigner} deps.signer
   * @param {Logger} deps.log
   * @param {MediaServiceOptions} deps.options
   * @param {() => number} [deps.now]
   */
  constructor({ files, tickets, storage, images, signer, log, options, now = Date.now }) {
    this.files = files;
    this.tickets = tickets;
    this.storage = storage;
    this.images = images;
    this.signer = signer;
    this.log = log;
    this.options = options;
    this.now = now;
    /** @type {Map<string, VariantSpec>} */
    this.variants = new Map(options.variants.map((v) => [v.name, v]));
    // Two layers, applied in this order (Stage 8): (1) `inflight` — a concurrent request for the
    // SAME (object, variant) shares one generation, no matter how many callers ask; it never
    // touches the semaphore at all. (2) `semaphore` — only genuinely distinct generations (a new
    // object, or a variant nobody is currently making) contend for `maxConcurrentVariants` CPU
    // slots. This is why 20 concurrent requests for one (object, variant) cost exactly one slot,
    // not 20: the 19 followers never reach the semaphore, they just await the same promise.
    /** @type {Map<string, Promise<void>>} */
    this.inflight = new Map();
    this.semaphore = new Semaphore(options.maxConcurrentVariants);
  }

  // ---------------------------------------------------------------- upload

  /**
   * Store an uploaded stream. Sniffs the real type, rejects anything not allowed, validates and
   * (by default) re-encodes images, then records a file pointing at the content-addressed blob.
   * @param {NodeJS.ReadableStream} stream
   * @param {UploadOptions} o
   * @returns {Promise<FileRecord>}
   */
  async upload(stream, o) {
    const maxBytes = Math.min(o.maxBytes ?? this.options.maxUploadBytes, this.options.maxUploadBytes);
    const allowed = o.allowedTypes ? o.allowedTypes.filter((t) => this.options.allowedTypes.includes(t)) : this.options.allowedTypes;
    let received;
    try {
      received = await this.storage.writeTemp(stream, { maxBytes });
    } catch (err) {
      if (err instanceof UploadError) throw new MediaError(err.code, err.message, { maxBytes });
      throw err;
    }
    let { key: tempKey, sha256, size } = received;
    try {
      const mime = TypeSniffer.sniff(received.head);
      if (!mime || !allowed.includes(mime)) {
        throw new MediaError('UNSUPPORTED_TYPE', mime ? `type ${mime} is not allowed` : 'file type not recognised', { allowed });
      }
      /** @type {number|null} */ let width = null;
      /** @type {number|null} */ let height = null;
      if (TypeSniffer.isRasterImage(mime)) {
        const input = await this.#readInput(tempKey);
        const info = await this.images.inspect(input);
        width = info.width;
        height = info.height;
        if (this.options.stripImageMetadata) {
          const normalized = await this.images.normalize(input, mime);
          const cleanKey = this.storage.tempKey();
          await this.storage.writeAtomic(cleanKey, normalized.buffer);
          await this.storage.discard(tempKey);
          tempKey = cleanKey;
          sha256 = createHash('sha256').update(normalized.buffer).digest('hex');
          size = normalized.buffer.length;
          width = normalized.width;
          height = normalized.height;
        }
      }
      await this.storage.commit(tempKey, { kind: 'object', sha256 });
      const record = this.files.createFile({
        apiKeyId: o.apiKeyId,
        blob: { sha256, size, mime, width, height },
        name: FileName.sanitize(o.name, mime),
        visibility: o.visibility ?? 'private',
      }, this.now());
      this.log.info({ fileId: record.id, sha256, mime, size, apiKeyId: o.apiKeyId }, 'file stored');
      return record;
    } catch (err) {
      await this.storage.discard(tempKey);
      throw err;
    }
  }

  /**
   * Issue a ticket a browser can use to upload once, directly, without an API key.
   * @param {{ apiKeyId: string, visibility?: Visibility, maxBytes?: number, allowedTypes?: string[], name?: string|null }} t
   * @returns {{ token: string, uploadUrl: string, expiresAt: number, maxBytes: number, allowedTypes: string[] }}
   */
  createTicket(t) {
    const maxBytes = t.maxBytes ?? this.options.maxUploadBytes;
    if (maxBytes < 1 || maxBytes > this.options.maxUploadBytes) {
      throw new MediaError('INVALID_ARGUMENT', `maxBytes must be 1..${this.options.maxUploadBytes}`);
    }
    const allowedTypes = t.allowedTypes ?? this.options.allowedTypes;
    const unknown = allowedTypes.filter((x) => !this.options.allowedTypes.includes(x));
    if (unknown.length) throw new MediaError('INVALID_ARGUMENT', `types not allowed by this service: ${unknown.join(', ')}`);
    const { token, expiresAt } = this.tickets.create({
      apiKeyId: t.apiKeyId, visibility: t.visibility ?? 'private', maxBytes, allowedTypes: t.allowedTypes ?? null, name: t.name ?? null,
      ttlMs: this.options.uploadTicketTtlSec * 1000,
    }, this.now());
    return { token, uploadUrl: `${this.options.publicBaseUrl}/v1/uploads/${token}`, expiresAt, maxBytes, allowedTypes };
  }

  /**
   * Upload against a ticket. The ticket is released if the upload fails so the client can retry.
   * @param {string} token
   * @param {NodeJS.ReadableStream} stream
   * @param {{ name?: string|null }} [o]
   * @returns {Promise<FileRecord>}
   */
  async uploadWithTicket(token, stream, o = {}) {
    const ticket = this.tickets.claim(token, this.now());
    if (!ticket) throw new MediaError('INVALID_TICKET', 'upload ticket is invalid, used or expired');
    try {
      const record = await this.upload(stream, {
        apiKeyId: ticket.api_key_id,
        visibility: ticket.visibility,
        maxBytes: ticket.max_bytes,
        allowedTypes: ticket.allowed_types ? JSON.parse(ticket.allowed_types) : undefined,
        name: o.name ?? ticket.name,
      });
      this.tickets.complete(token, record.id);
      return record;
    } catch (err) {
      this.tickets.release(token);
      throw err;
    }
  }

  // ---------------------------------------------------------------- files

  /**
   * Live file by id, optionally scoped to an owner.
   * @param {string} id
   * @param {string} [apiKeyId]
   * @returns {FileRecord}
   */
  get(id, apiKeyId) {
    const f = this.files.byId(id);
    if (!f || f.deleted_at !== null || (apiKeyId !== undefined && f.api_key_id !== apiKeyId)) throw new MediaError('NOT_FOUND', 'file not found');
    return f;
  }

  /**
   * @param {string} apiKeyId
   * @param {{ limit: number, before?: { createdAt: number, id: string } }} q
   */
  list(apiKeyId, q) {
    return this.files.list({ apiKeyId, ...q });
  }

  /**
   * @param {string} id
   * @param {string} apiKeyId
   * @param {{ visibility?: Visibility, name?: string }} patch
   * @returns {FileRecord}
   */
  update(id, apiKeyId, patch) {
    const f = this.get(id, apiKeyId);
    const clean = { ...patch, ...(patch.name !== undefined ? { name: FileName.sanitize(patch.name, f.mime) } : {}) };
    this.files.update(id, apiKeyId, clean);
    return this.get(id, apiKeyId);
  }

  /**
   * Soft delete; bytes are removed by {@link purge} after the grace period.
   * @param {string} id
   * @param {string} apiKeyId
   */
  delete(id, apiKeyId) {
    this.get(id, apiKeyId);
    this.files.softDelete(id, apiKeyId, this.now());
    this.log.info({ fileId: id, apiKeyId }, 'file soft-deleted');
  }

  /**
   * Undo a soft delete within the grace period.
   * @param {string} id
   * @param {string} apiKeyId
   * @returns {FileRecord}
   */
  restore(id, apiKeyId) {
    const f = this.files.byId(id);
    if (!f || f.api_key_id !== apiKeyId) throw new MediaError('NOT_FOUND', 'file not found');
    this.files.restore(id, apiKeyId);
    return this.get(id, apiKeyId);
  }

  // ---------------------------------------------------------------- delivery

  /**
   * Storage key and type of the bytes to serve for a variant, generating it on first request.
   * @param {FileRecord} f
   * @param {string} variant "original" or a preset name.
   * @param {{ signal?: AbortSignal }} [o] `signal`: this ONE caller's own abort (e.g. its HTTP
   *   client disconnected) — stops THIS call from waiting any longer and lets it return control
   *   to its caller, but never cancels the underlying generation itself: `#generate`'s promise is
   *   shared by every concurrent request for the same (object, variant) (see below), so one
   *   caller giving up must never fail the others still waiting on the same result, and the
   *   generation is left to finish and populate the cache regardless.
   * @returns {Promise<{ key: StorageKey, mime: string, size: number }>}
   */
  async resolve(f, variant, { signal } = {}) {
    if (variant === 'original') return { key: { kind: 'object', sha256: f.sha256 }, mime: f.mime, size: f.size };
    const spec = this.variants.get(variant);
    if (!spec) throw new MediaError('UNKNOWN_VARIANT', `unknown variant "${variant}"`);
    if (!TypeSniffer.isRasterImage(f.mime)) throw new MediaError('NOT_AN_IMAGE', 'variants exist for images only');
    /** @type {StorageKey} */
    const key = { kind: 'variant', sha256: f.sha256, name: variant };
    let st = await this.storage.stat(key);
    if (!st) {
      await MediaService.#abortable(this.#generate(f, spec, key), signal);
      st = await this.storage.stat(key);
      if (!st) throw new Error('variant vanished after generation');
    }
    return { key, mime: 'image/webp', size: st.size };
  }

  /**
   * @param {FileRecord} f
   * @param {VariantSpec} spec
   * @param {import('../storage/storage.js').VariantKey} key
   */
  #generate(f, spec, key) {
    const cacheKey = `${key.sha256}:${key.name}`;
    let p = this.inflight.get(cacheKey);
    if (p) return p; // Layer 1 (dedupe): share the one generation already in flight; no semaphore wait at all.
    p = (async () => {
      // Layer 2 (bounded concurrency): only a genuinely new generation reaches here. Bounded by
      // `variantWaitTimeoutMs` only — NOT by any individual caller's signal, since this promise
      // may be shared by several callers (see `resolve`'s doc); one of them disconnecting must
      // not abandon a wait the others are still relying on.
      const release = await this.semaphore.acquire({ timeoutMs: this.options.variantWaitTimeoutMs }).catch((err) => {
        throw err instanceof SemaphoreTimeoutError || err instanceof SemaphoreQueueFullError
          ? new MediaError('VARIANT_BUSY', 'too many variants are being generated right now; try again shortly')
          : err;
      });
      try {
        const started = Date.now();
        const input = await this.#readInput({ kind: 'object', sha256: f.sha256 });
        const buffer = await this.images.variant(input, spec);
        await this.storage.writeAtomic(key, buffer);
        this.log.info({ sha256: f.sha256, variant: spec.name, bytes: buffer.length, durationMs: Date.now() - started }, 'variant generated');
      } finally {
        release();
      }
    })().finally(() => this.inflight.delete(cacheKey));
    this.inflight.set(cacheKey, p);
    return p;
  }

  /**
   * Race `promise` against `signal` without affecting `promise` itself — used so ONE caller's
   * abort only stops that caller's own wait, never a generation or semaphore wait shared with
   * others.
   * @param {Promise<void>} promise
   * @param {AbortSignal|undefined} signal
   */
  static #abortable(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  /**
   * Bytes for `key` as whatever `ImageProcessor` (sharp) can decode most efficiently: a real
   * local path when the backend has one (`Storage#localPath` — always true for `LocalStorage`),
   * or the fully-buffered content otherwise. This is the one place `MediaService` ever sees
   * something path-shaped, and it is never retained, logged or passed anywhere except straight
   * into `sharp`.
   * @param {StorageKey|import('../storage/storage.js').TempKey} key
   * @returns {Promise<string|Buffer>}
   */
  async #readInput(key) {
    const localPath = await this.storage.localPath(key);
    if (localPath !== null) return localPath;
    return streamToBuffer(await this.storage.open(key));
  }

  /**
   * Whether a download request may proceed. Public files: always. Private: valid signature.
   * @param {FileRecord} f
   * @param {string} variant
   * @param {{ exp?: string, sig?: string }} query
   */
  authorize(f, variant, query) {
    return f.visibility === 'public' || this.signer.verify({ fileId: f.id, variant, exp: query.exp, sig: query.sig }, this.now());
  }

  /**
   * Download URL. Private files get a signature valid for `ttlSec` (default from config).
   * @param {FileRecord} f
   * @param {string} variant
   * @param {number} [ttlSec]
   * @returns {{ url: string, expiresAt: string|null }}
   */
  url(f, variant, ttlSec = this.options.signedUrlTtlSec) {
    const base = `${this.options.publicBaseUrl}/files/${f.id}/${variant}`;
    if (f.visibility === 'public') return { url: base, expiresAt: null };
    const exp = Math.floor(this.now() / 1000) + ttlSec;
    return { url: `${base}?${this.signer.query(f.id, variant, exp)}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /**
   * All URLs for a file: original plus every variant when it is an image.
   * @param {FileRecord} f
   * @param {number} [ttlSec]
   */
  urls(f, ttlSec) {
    /** @type {Record<string, { url: string, expiresAt: string|null }>} */
    const out = { original: this.url(f, 'original', ttlSec) };
    if (TypeSniffer.isRasterImage(f.mime)) for (const name of this.variants.keys()) out[name] = this.url(f, name, ttlSec);
    return out;
  }

  // ---------------------------------------------------------------- maintenance

  /**
   * Hard-delete files past the grace period, drop orphaned blobs and their bytes, expire tickets.
   * @returns {Promise<{ files: number, blobs: number, tickets: number }>}
   */
  async purge() {
    const now = this.now();
    const { files, orphanBlobs } = this.files.purge(now - this.options.deleteGraceMs);
    for (const sha256 of orphanBlobs) await this.storage.remove({ kind: 'object', sha256 });
    const tickets = this.tickets.purge(now);
    return { files, blobs: orphanBlobs.length, tickets };
  }
}
