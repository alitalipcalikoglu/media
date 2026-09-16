import { createHash, randomBytes } from 'node:crypto';

/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').TicketRow} TicketRow */
/** @typedef {import('../types.js').Visibility} Visibility */

/** Single-use, expiring upload tickets that let a browser upload directly without an API key. */
export class TicketStore {
  static COLUMNS = 'token_hash, api_key_id, visibility, max_bytes, allowed_types, name, expires_at, used_at, file_id, created_at';

  /** @param {Database} db */
  constructor(db) {
    const C = TicketStore.COLUMNS;
    this.stmt = {
      insert: db.prepare(`INSERT INTO upload_tickets (token_hash, api_key_id, visibility, max_bytes, allowed_types, name, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      live: db.prepare(`SELECT ${C} FROM upload_tickets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`),
      claim: db.prepare(`UPDATE upload_tickets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`),
      release: db.prepare(`UPDATE upload_tickets SET used_at = NULL WHERE token_hash = ? AND file_id IS NULL`),
      complete: db.prepare(`UPDATE upload_tickets SET file_id = ? WHERE token_hash = ?`),
      byHash: db.prepare(`SELECT ${C} FROM upload_tickets WHERE token_hash = ?`),
      purge: db.prepare(`DELETE FROM upload_tickets WHERE expires_at < ?`),
    };
  }

  /** @param {string} token */
  static hash(token) {
    return createHash('sha256').update(token).digest('hex');
  }

  /** @param {unknown} token */
  static looksValid(token) {
    return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
  }

  /**
   * @param {{ apiKeyId: string, visibility: Visibility, maxBytes: number, allowedTypes: string[]|null, name: string|null, ttlMs: number }} t
   * @param {number} [now]
   * @returns {{ token: string, expiresAt: number }}
   */
  create(t, now = Date.now()) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + t.ttlMs;
    this.stmt.insert.run(TicketStore.hash(token), t.apiKeyId, t.visibility, t.maxBytes, t.allowedTypes ? JSON.stringify(t.allowedTypes) : null, t.name, expiresAt, now);
    return { token, expiresAt };
  }

  /**
   * Atomically mark a ticket as in use and return it. Undefined if unknown, used or expired.
   * @param {string} token
   * @param {number} [now]
   * @returns {TicketRow|undefined}
   */
  claim(token, now = Date.now()) {
    if (!TicketStore.looksValid(token)) return undefined;
    const hash = TicketStore.hash(token);
    if (this.stmt.claim.run(now, hash, now).changes !== 1) return undefined;
    return /** @type {TicketRow} */ (this.stmt.byHash.get(hash));
  }

  /**
   * Upload failed after claiming: make the ticket usable again.
   * @param {string} token
   */
  release(token) {
    this.stmt.release.run(TicketStore.hash(token));
  }

  /**
   * @param {string} token
   * @param {string} fileId
   */
  complete(token, fileId) {
    this.stmt.complete.run(fileId, TicketStore.hash(token));
  }

  /** @param {number} now */
  purge(now) {
    return Number(this.stmt.purge.run(now).changes);
  }
}
