/**
 * @typedef {{ kind: 'object', sha256: string }} ObjectKey    An original, content-addressed upload.
 * @typedef {{ kind: 'variant', sha256: string, name: string }} VariantKey  A derived image, named by preset.
 * @typedef {{ kind: 'temp', id: string }} TempKey    Scratch space for an upload in progress; never readable as a finished object.
 * @typedef {ObjectKey|VariantKey} StorageKey   Permanent, content-addressed identity. Opaque to callers: never a filesystem path, never assumed to have any particular shape beyond its own fields.
 */

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
 * @property {TempKey} key
 * @property {string} sha256
 * @property {number} size
 * @property {Buffer} head   First bytes, for type sniffing.
 */

/**
 * Storage contract every backend implements. `MediaService` depends on this interface only —
 * never on `node:fs`, `node:path`, or any notion of a local filesystem path. A `StorageKey` is an
 * opaque, content-addressed identity (`{kind, sha256[, name]}`); only a backend's own
 * implementation ever turns one into wherever the bytes actually live.
 *
 * This is deliberately narrow: exactly the operations `MediaService` calls today, nothing
 * speculative (no listing, no metadata/tagging, no multipart upload, no ACL API) and nothing that
 * assumes a future distributed backend's semantics (no conditional-write/compare-and-swap, no
 * eventual-consistency modeling) — see the service's `docs/READINESS.md` "Storage interface" (or
 * equivalent Stage 8 report) for the concrete list of gaps a real object-store backend would still
 * have to close.
 * @abstract
 */
export class Storage {
  /**
   * Create the layout and clear anything left by an interrupted upload. Call once at process
   * start, never from a readiness probe — it may destroy in-flight upload state. Returns `this`
   * for `new LocalStorage(dir).prepare()`-style construction (every implementation should do the
   * same, purely for that convenience — callers must not otherwise rely on the return value).
   * @returns {Promise<this>}
   */
  async prepare() {
    throw new Error('Storage.prepare must be overridden');
  }

  /**
   * Cheap, non-destructive readiness check — the layout exists and is writable. Safe to call on
   * every `/ready` poll; must never touch or discard anything an in-flight upload depends on.
   * @returns {Promise<this>}
   */
  async check() {
    throw new Error('Storage.check must be overridden');
  }

  /**
   * Mint a fresh, unique {@link TempKey} for scratch content the caller will `writeAtomic` and
   * later either `commit` or `discard`. Pure and synchronous — any backend can hand out a random
   * identifier without touching storage itself.
   * @returns {TempKey}
   */
  tempKey() {
    throw new Error('Storage.tempKey must be overridden');
  }

  /**
   * Stream an upload into a new temp entry while hashing, counting and capturing the head bytes
   * for type sniffing. Rejects with {@link UploadError} and leaves nothing behind when the limit
   * is exceeded, the stream is empty, or it fails partway.
   * @param {NodeJS.ReadableStream} source
   * @param {{ maxBytes: number }} o
   * @returns {Promise<Received>}
   */
  async writeTemp(source, o) {
    throw new Error('Storage.writeTemp must be overridden');
  }

  /**
   * Move a temp entry into place under its permanent key. If that key already holds content
   * (content-addressed dedup), `tempKey` is left untouched rather than discarded — a caller that
   * needs to know may re-`commit()` from the same temp entry again later (e.g. `MediaService`'s
   * purge-race self-heal: the "already there" content it deduped against may have been removed by
   * a stale purge in between, and `commit()` is safe to retry, being atomic). Either way, the
   * caller owns `discard(tempKey)` once it's genuinely done with it.
   * @param {TempKey} tempKey
   * @param {StorageKey} key
   * @returns {Promise<boolean>} true when new content was stored, false when deduped.
   */
  async commit(tempKey, key) {
    throw new Error('Storage.commit must be overridden');
  }

  /**
   * Write a complete buffer atomically under `key` — for a derived artifact written directly
   * (a variant) or for scratch content under a {@link TempKey} on its way to {@link commit}.
   * @param {StorageKey|TempKey} key
   * @param {Buffer} data
   * @returns {Promise<void>}
   */
  async writeAtomic(key, data) {
    throw new Error('Storage.writeAtomic must be overridden');
  }

  /**
   * @param {StorageKey} key
   * @returns {Promise<boolean>}
   */
  async exists(key) {
    throw new Error('Storage.exists must be overridden');
  }

  /**
   * Read (all or a byte range of) the content at `key`. `end` is inclusive, matching HTTP Range
   * semantics — the one place this leaks through, because it is the delivery contract every
   * caller (the HTTP file server) already speaks, not a filesystem-specific detail.
   * @param {StorageKey|TempKey} key
   * @param {{ start?: number, end?: number }} [range]
   * @returns {Promise<NodeJS.ReadableStream>}
   */
  async open(key, range) {
    throw new Error('Storage.open must be overridden');
  }

  /**
   * @param {StorageKey} key
   * @returns {Promise<{ size: number }|null>} null when nothing is stored at `key`.
   */
  async stat(key) {
    throw new Error('Storage.stat must be overridden');
  }

  /**
   * A local filesystem path for `key`, if this backend happens to expose one — an explicit,
   * narrow escape hatch for `ImageProcessor` (`sharp`), which reads far more efficiently from a
   * real file than a buffered stream. Callers MUST treat a `null` return as normal (a
   * non-filesystem backend, e.g. a future object-store one) and fall back to {@link open} plus
   * buffering; nothing may require this to be non-null. Never used for anything but handing a
   * path to a trusted native decoder — never returned to an HTTP response, logged, or otherwise
   * treated as part of the storage contract's real identity.
   * @param {StorageKey|TempKey} key
   * @returns {Promise<string|null>}
   */
  async localPath(key) {
    throw new Error('Storage.localPath must be overridden');
  }

  /**
   * Remove the content at `key`. Removing an `object` key also removes every `variant` key
   * derived from it — a variant has no independent lifetime, so a caller never has to enumerate
   * and remove each one itself. Safe to call when nothing is stored at `key`.
   *
   * Stage 8.2: a plain `remove()` races a concurrent write on the SAME path (nothing stops a
   * `commit()`/`writeAtomic()` from landing between whatever check a caller made and this actually
   * running) — `MediaService`'s purge no longer calls this directly for exactly that reason, using
   * {@link detachForDelete}/{@link discardDetached} instead. `remove()` itself is unchanged and
   * still correct for a caller that owns the key exclusively (nothing else concurrently writes to
   * it) — there is no other such caller today.
   * @param {StorageKey} key
   * @returns {Promise<void>}
   */
  async remove(key) {
    throw new Error('Storage.remove must be overridden');
  }

  /** Discard a temp entry that was never committed. @param {TempKey} key @returns {Promise<void>} */
  async discard(key) {
    throw new Error('Storage.discard must be overridden');
  }

  /**
   * Stage 8.2 physical-delete fencing: atomically detach the canonical bytes at `key` — and every
   * variant derived from it — into quarantine scoped to `token`, in one step. The instant this
   * returns, the canonical location(s) no longer exist at all: a concurrent `commit()`/
   * `writeAtomic()` for the same key is completely free to recreate a brand-new, independent file
   * there, because there is nothing left to collide or dedupe against. This is what makes a stale
   * purge unable to ever delete a fresh upload's bytes, however the two interleave — unlike a
   * plain `remove()`, which can race a concurrent write on the SAME path.
   *
   * Only `discardDetached` (never `remove`, never a second `detachForDelete`) may act on what
   * this detached — the canonical path itself is never touched again under this token.
   * @param {ObjectKey} key
   * @param {string} token Caller-minted, unique per call — never reused.
   * @returns {Promise<boolean>} whether there was anything to detach.
   */
  async detachForDelete(key, token) {
    throw new Error('Storage.detachForDelete must be overridden');
  }

  /**
   * Permanently remove everything `detachForDelete` quarantined under `token`. Only ever touches
   * that token's own quarantine location — never the canonical path, regardless of what has
   * happened there since. Safe to call more than once, or on a token nothing was detached under.
   * @param {string} token
   * @returns {Promise<void>}
   */
  async discardDetached(token) {
    throw new Error('Storage.discardDetached must be overridden');
  }
}
