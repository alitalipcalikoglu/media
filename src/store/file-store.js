import { randomUUID } from 'node:crypto';

/** @typedef {{ sha256: string, delete_token: string }} MarkedBlobRow */

/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').BlobRow} BlobRow */
/** @typedef {import('../types.js').FileRecord} FileRecord */
/** @typedef {import('../types.js').Visibility} Visibility */

/** Persistence for blobs (content-addressed objects) and files (named references to blobs). */
export class FileStore {
  static SELECT = `SELECT f.id, f.api_key_id, f.blob_sha256, f.name, f.visibility, f.created_at, f.deleted_at,
    b.sha256, b.size, b.mime, b.width, b.height FROM files f JOIN blobs b ON b.sha256 = f.blob_sha256`;

  /** @param {Database} db */
  constructor(db) {
    this.db = db;
    this.stmt = {
      // Stage 8.1: DO UPDATE (not DO NOTHING) is the reclaim — any file creation that touches an
      // existing blob row, marked for deletion or not, clears delete_token back to NULL. This is
      // what lets `finalizeOrphanBlobs`'s compare-and-swap detect "a concurrent upload referenced
      // this content again since I marked it as orphaned" and refuse to delete it.
      blobUpsert: db.prepare(`INSERT INTO blobs (sha256, size, mime, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (sha256) DO UPDATE SET delete_token = NULL`),
      blobGet: db.prepare(`SELECT sha256, size, mime, width, height, created_at, delete_token FROM blobs WHERE sha256 = ?`),
      fileInsert: db.prepare(`INSERT INTO files (id, api_key_id, blob_sha256, name, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
      fileById: db.prepare(`${FileStore.SELECT} WHERE f.id = ?`),
      fileList: db.prepare(`${FileStore.SELECT} WHERE f.api_key_id = ? AND f.deleted_at IS NULL AND (f.created_at < ? OR (f.created_at = ? AND f.id < ?)) ORDER BY f.created_at DESC, f.id DESC LIMIT ?`),
      fileSoftDelete: db.prepare(`UPDATE files SET deleted_at = ? WHERE id = ? AND api_key_id = ? AND deleted_at IS NULL`),
      fileRestore: db.prepare(`UPDATE files SET deleted_at = NULL WHERE id = ? AND api_key_id = ? AND deleted_at IS NOT NULL`),
      fileSetVisibility: db.prepare(`UPDATE files SET visibility = ? WHERE id = ? AND api_key_id = ? AND deleted_at IS NULL`),
      fileSetName: db.prepare(`UPDATE files SET name = ? WHERE id = ? AND api_key_id = ? AND deleted_at IS NULL`),
      filePurge: db.prepare(`DELETE FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ?`),
      // Phase 1 (mark): only rows not already marked — a row left marked by a crashed prior
      // maintenance run is deliberately NOT re-marked (it would get a new, different token,
      // pointlessly), it is picked up by `selectMarked` below regardless of which pass marked it.
      markOrphans: db.prepare(`UPDATE blobs SET delete_token = ? WHERE delete_token IS NULL AND NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_sha256 = blobs.sha256)`),
      // Phase 2 (finalize): every currently-marked row, from this pass or any earlier one that
      // crashed before finalizing — re-verified still orphan defensively (a marked row can only
      // stop being orphan by being reclaimed, which already clears its token, but this costs
      // nothing extra to double-check).
      selectMarked: db.prepare(`SELECT sha256, delete_token FROM blobs WHERE delete_token IS NOT NULL AND NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_sha256 = blobs.sha256)`),
      // The compare-and-swap: deletes only if delete_token is UNCHANGED since it was selected —
      // if a concurrent reclaim (blobUpsert) cleared it in between, this matches zero rows and the
      // row (and therefore its bytes) survives.
      confirmDelete: db.prepare(`DELETE FROM blobs WHERE sha256 = ? AND delete_token = ?`),
      stats: db.prepare(`SELECT (SELECT COUNT(*) FROM files WHERE deleted_at IS NULL) AS files, (SELECT COUNT(*) FROM blobs) AS blobs, (SELECT COALESCE(SUM(size), 0) FROM blobs) AS bytes`),
    };
  }

  /**
   * Register a blob (no-op if already present) and a file pointing at it.
   * @param {{ apiKeyId: string, blob: Omit<BlobRow, 'created_at'>, name: string, visibility: Visibility }} input
   * @param {number} [now]
   * @returns {FileRecord}
   */
  createFile({ apiKeyId, blob, name, visibility }, now = Date.now()) {
    const id = randomUUID();
    this.db.transaction(() => {
      this.stmt.blobUpsert.run(blob.sha256, blob.size, blob.mime, blob.width, blob.height, now);
      this.stmt.fileInsert.run(id, apiKeyId, blob.sha256, name, visibility, now);
    });
    return /** @type {FileRecord} */ (this.stmt.fileById.get(id));
  }

  /** @param {string} sha256 */
  blob(sha256) {
    return /** @type {BlobRow|undefined} */ (this.stmt.blobGet.get(sha256));
  }

  /**
   * Any file, including soft-deleted ones (callers decide).
   * @param {string} id
   */
  byId(id) {
    return /** @type {FileRecord|undefined} */ (this.stmt.fileById.get(id));
  }

  /**
   * Live files for an owner, newest first.
   * @param {{ apiKeyId: string, limit: number, before?: { createdAt: number, id: string } }} q
   */
  list({ apiKeyId, limit, before = { createdAt: Number.MAX_SAFE_INTEGER, id: '￿' } }) {
    return /** @type {FileRecord[]} */ (this.stmt.fileList.all(apiKeyId, before.createdAt, before.createdAt, before.id, limit));
  }

  /**
   * @param {string} id
   * @param {string} apiKeyId
   * @param {number} [now]
   */
  softDelete(id, apiKeyId, now = Date.now()) {
    return this.stmt.fileSoftDelete.run(now, id, apiKeyId).changes === 1;
  }

  /**
   * @param {string} id
   * @param {string} apiKeyId
   */
  restore(id, apiKeyId) {
    return this.stmt.fileRestore.run(id, apiKeyId).changes === 1;
  }

  /**
   * @param {string} id
   * @param {string} apiKeyId
   * @param {{ visibility?: Visibility, name?: string }} patch
   */
  update(id, apiKeyId, patch) {
    return this.db.transaction(() => {
      let changed = false;
      if (patch.visibility !== undefined) changed = this.stmt.fileSetVisibility.run(patch.visibility, id, apiKeyId).changes === 1 || changed;
      if (patch.name !== undefined) changed = this.stmt.fileSetName.run(patch.name, id, apiKeyId).changes === 1 || changed;
      return changed;
    });
  }

  /**
   * Hard-delete files soft-deleted before `before`. Blob/byte cleanup is a separate, two-phase
   * process — see {@link markOrphanBlobs} / {@link finalizeOrphanBlobs} — deliberately not run in
   * the same transaction as this, so a concurrent upload's reclaim has a real chance to land
   * between the two phases (see docs/READINESS.md "Purge/upload race").
   * @param {number} before
   * @returns {number} Files hard-deleted.
   */
  purgeExpiredFiles(before) {
    return Number(this.stmt.filePurge.run(before).changes);
  }

  /**
   * Phase 1: mark every blob currently orphaned (no live file references it) and not already
   * marked by an earlier, not-yet-finalized pass. Does not delete anything.
   * @returns {string} The token this pass marked rows with (finalize re-reads each row's current
   *   token itself; this return value is mainly for tests asserting on a specific pass's rows).
   */
  markOrphanBlobs() {
    const token = randomUUID();
    this.stmt.markOrphans.run(token);
    return token;
  }

  /**
   * Phase 2: for every currently-marked, still-orphaned blob, delete its row if and only if its
   * token is unchanged since it was marked (compare-and-swap) — a concurrent upload referencing
   * the same content in between already cleared the token, and that row is left alone. Safe to
   * call with nothing marked (no-op); safe to call repeatedly (idempotent — a row already
   * finalized or reclaimed just doesn't match on a later call).
   * @returns {string[]} sha256 of every row actually deleted — the caller (only now) may safely
   *   remove those objects' bytes from storage.
   */
  finalizeOrphanBlobs() {
    const candidates = /** @type {MarkedBlobRow[]} */ (this.stmt.selectMarked.all());
    /** @type {string[]} */
    const confirmed = [];
    for (const row of candidates) {
      if (this.stmt.confirmDelete.run(row.sha256, row.delete_token).changes === 1) confirmed.push(row.sha256);
    }
    return confirmed;
  }

  /** @returns {{ files: number, blobs: number, bytes: number }} */
  stats() {
    return /** @type {{ files: number, blobs: number, bytes: number }} */ (this.stmt.stats.get());
  }
}
