import { createHash } from 'node:crypto';
import { TypeSniffer } from '../storage/type-sniffer.js';
import { UploadError } from '../storage/local-storage.js';
import { MediaError } from './errors.js';
import { FileName } from './file-name.js';

/** @typedef {import('../types.js').FileRecord} FileRecord */
/** @typedef {import('../types.js').Visibility} Visibility */
/** @typedef {import('../types.js').VariantSpec} VariantSpec */
/** @typedef {import('../types.js').Logger} Logger */
/** @typedef {import('../store/file-store.js').FileStore} FileStore */
/** @typedef {import('../store/ticket-store.js').TicketStore} TicketStore */
/** @typedef {import('../storage/local-storage.js').LocalStorage} LocalStorage */
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
 */

/**
 * All media use-cases: upload (direct or by ticket), metadata, visibility, deletion with grace
 * period, variant generation, URL building and signed-URL authorisation.
 */
export class MediaService {
  /**
   * @param {object} deps
   * @param {FileStore} deps.files
   * @param {TicketStore} deps.tickets
   * @param {LocalStorage} deps.storage
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
    /** Variant generations in flight, keyed by path, so concurrent requests share one encode. @type {Map<string, Promise<void>>} */
    this.inflight = new Map();
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
      received = await this.storage.receive(stream, { maxBytes });
    } catch (err) {
      if (err instanceof UploadError) throw new MediaError(err.code, err.message, { maxBytes });
      throw err;
    }
    let { tmpPath, sha256, size } = received;
    try {
      const mime = TypeSniffer.sniff(received.head);
      if (!mime || !allowed.includes(mime)) {
        throw new MediaError('UNSUPPORTED_TYPE', mime ? `type ${mime} is not allowed` : 'file type not recognised', { allowed });
      }
      /** @type {number|null} */ let width = null;
      /** @type {number|null} */ let height = null;
      if (TypeSniffer.isRasterImage(mime)) {
        const info = await this.images.inspect(tmpPath);
        width = info.width;
        height = info.height;
        if (this.options.stripImageMetadata) {
          const normalized = await this.images.normalize(tmpPath, mime);
          const cleanPath = `${tmpPath}.clean`;
          await this.storage.writeAtomic(cleanPath, normalized.buffer);
          await this.storage.discard(tmpPath);
          tmpPath = cleanPath;
          sha256 = createHash('sha256').update(normalized.buffer).digest('hex');
          size = normalized.buffer.length;
          width = normalized.width;
          height = normalized.height;
        }
      }
      await this.storage.commit(tmpPath, sha256);
      const record = this.files.createFile({
        apiKeyId: o.apiKeyId,
        blob: { sha256, size, mime, width, height },
        name: FileName.sanitize(o.name, mime),
        visibility: o.visibility ?? 'private',
      }, this.now());
      this.log.info({ fileId: record.id, sha256, mime, size, apiKeyId: o.apiKeyId }, 'file stored');
      return record;
    } catch (err) {
      await this.storage.discard(tmpPath);
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
   * Path and type of the bytes to serve for a variant, generating it on first request.
   * @param {FileRecord} f
   * @param {string} variant "original" or a preset name.
   * @returns {Promise<{ path: string, mime: string, size: number }>}
   */
  async resolve(f, variant) {
    if (variant === 'original') return { path: this.storage.objectPath(f.sha256), mime: f.mime, size: f.size };
    const spec = this.variants.get(variant);
    if (!spec) throw new MediaError('UNKNOWN_VARIANT', `unknown variant "${variant}"`);
    if (!TypeSniffer.isRasterImage(f.mime)) throw new MediaError('NOT_AN_IMAGE', 'variants exist for images only');
    const path = this.storage.variantPath(f.sha256, variant);
    let st = await this.storage.statPath(path);
    if (!st) {
      await this.#generate(f, spec, path);
      st = await this.storage.statPath(path);
      if (!st) throw new Error('variant vanished after generation');
    }
    return { path, mime: 'image/webp', size: st.size };
  }

  /**
   * @param {FileRecord} f
   * @param {VariantSpec} spec
   * @param {string} path
   */
  #generate(f, spec, path) {
    let p = this.inflight.get(path);
    if (!p) {
      p = (async () => {
        const started = Date.now();
        const buffer = await this.images.variant(this.storage.objectPath(f.sha256), spec);
        await this.storage.writeAtomic(path, buffer);
        this.log.info({ sha256: f.sha256, variant: spec.name, bytes: buffer.length, durationMs: Date.now() - started }, 'variant generated');
      })().finally(() => this.inflight.delete(path));
      this.inflight.set(path, p);
    }
    return p;
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
    for (const sha of orphanBlobs) await this.storage.remove(sha);
    const tickets = this.tickets.purge(now);
    return { files, blobs: orphanBlobs.length, tickets };
  }
}
