import { randomUUID } from 'node:crypto';

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
      blobUpsert: db.prepare(`INSERT INTO blobs (sha256, size, mime, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (sha256) DO NOTHING`),
      blobGet: db.prepare(`SELECT sha256, size, mime, width, height, created_at FROM blobs WHERE sha256 = ?`),
      fileInsert: db.prepare(`INSERT INTO files (id, api_key_id, blob_sha256, name, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
      fileById: db.prepare(`${FileStore.SELECT} WHERE f.id = ?`),
      fileList: db.prepare(`${FileStore.SELECT} WHERE f.api_key_id = ? AND f.deleted_at IS NULL AND (f.created_at < ? OR (f.created_at = ? AND f.id < ?)) ORDER BY f.created_at DESC, f.id DESC LIMIT ?`),
      fileSoftDelete: db.prepare(`UPDATE files SET deleted_at = ? WHERE id = ? AND api_key_id = ? AND deleted_at IS NULL`),
      fileRestore: db.prepare(`UPDATE files SET deleted_at = NULL WHERE id = ? AND api_key_id = ? AND deleted_at IS NOT NULL`),
      fileSetVisibility: db.prepare(`UPDATE files SET visibility = ? WHERE id = ? AND api_key_id = ? AND deleted_at IS NULL`),
      fileSetName: db.prepare(`UPDATE files SET name = ? WHERE id = ? AND api_key_id = ? AND deleted_at IS NULL`),
      filePurge: db.prepare(`DELETE FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ? RETURNING blob_sha256`),
      orphanBlobs: db.prepare(`SELECT sha256 FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_sha256 = b.sha256)`),
      blobDelete: db.prepare(`DELETE FROM blobs WHERE sha256 = ?`),
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
   * Hard-delete files soft-deleted before `before`; then return blobs nobody references any more
   * and drop their rows. The caller removes the bytes from storage.
   * @param {number} before
   * @returns {{ files: number, orphanBlobs: string[] }}
   */
  purge(before) {
    return this.db.transaction(() => {
      const files = this.stmt.filePurge.all(before).length;
      const orphans = /** @type {{ sha256: string }[]} */ (this.stmt.orphanBlobs.all()).map((r) => r.sha256);
      for (const sha of orphans) this.stmt.blobDelete.run(sha);
      return { files, orphanBlobs: orphans };
    });
  }

  /** @returns {{ files: number, blobs: number, bytes: number }} */
  stats() {
    return /** @type {{ files: number, blobs: number, bytes: number }} */ (this.stmt.stats.get());
  }
}
