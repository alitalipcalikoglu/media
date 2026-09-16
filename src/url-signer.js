import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 signatures for time-limited download URLs of private files.
 * Signed string: `<fileId>\n<variant>\n<expiresAtSec>`.
 */
export class UrlSigner {
  /** @param {string} secret */
  constructor(secret) {
    this.#secret = secret;
  }

  /** @type {string} */
  #secret;

  /**
   * @param {string} fileId
   * @param {string} variant  Preset name or "original".
   * @param {number} expiresAtSec
   * @returns {string} base64url signature
   */
  sign(fileId, variant, expiresAtSec) {
    return createHmac('sha256', this.#secret).update(`${fileId}\n${variant}\n${expiresAtSec}`).digest('base64url');
  }

  /**
   * @param {{ fileId: string, variant: string, exp: string|number|undefined, sig: string|undefined }} q
   * @param {number} [nowMs]
   * @returns {boolean}
   */
  verify({ fileId, variant, exp, sig }, nowMs = Date.now()) {
    if (typeof sig !== 'string' || !/^\d{1,12}$/.test(String(exp ?? ''))) return false;
    const expiresAtSec = Number(exp);
    if (expiresAtSec * 1000 <= nowMs) return false;
    const expected = Buffer.from(this.sign(fileId, variant, expiresAtSec), 'base64url');
    const given = Buffer.from(sig, 'base64url');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /**
   * Query string fragment for a signed URL.
   * @param {string} fileId
   * @param {string} variant
   * @param {number} expiresAtSec
   */
  query(fileId, variant, expiresAtSec) {
    return `exp=${expiresAtSec}&sig=${encodeURIComponent(this.sign(fileId, variant, expiresAtSec))}`;
  }
}
