import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 signatures for time-limited download URLs of private files.
 * Signed string: `<fileId>\n<variant>\n<expiresAtSec>`.
 *
 * Rotation grace (Stage 8): `previous`, when given, is accepted for verification only — every
 * new URL is signed with `current` alone. This lets an operator rotate `SIGNING_SECRET` without
 * invalidating every outstanding signed URL: deploy with the new secret as `current` and the old
 * one as `previous`, wait out the longest TTL any already-issued URL could still have, then drop
 * `previous`. See README "Rotating SIGNING_SECRET" for the operational runbook.
 */
export class UrlSigner {
  /**
   * @param {string} current
   * @param {string} [previous]
   */
  constructor(current, previous) {
    this.#current = current;
    this.#previous = previous ?? null;
  }

  /** @type {string} */
  #current;
  /** @type {string|null} */
  #previous;

  /**
   * @param {string} fileId
   * @param {string} variant  Preset name or "original".
   * @param {number} expiresAtSec
   * @returns {string} base64url signature, current secret only.
   */
  sign(fileId, variant, expiresAtSec) {
    return UrlSigner.#hmac(this.#current, fileId, variant, expiresAtSec);
  }

  /**
   * Accepts a signature made with `current` OR (if configured) `previous` — never the reverse:
   * {@link sign} only ever uses `current`. An unknown or tampered signature fails closed
   * regardless of which secret(s) are configured.
   * @param {{ fileId: string, variant: string, exp: string|number|undefined, sig: string|undefined }} q
   * @param {number} [nowMs]
   * @returns {boolean}
   */
  verify({ fileId, variant, exp, sig }, nowMs = Date.now()) {
    if (typeof sig !== 'string' || !/^\d{1,12}$/.test(String(exp ?? ''))) return false;
    const expiresAtSec = Number(exp);
    if (expiresAtSec * 1000 <= nowMs) return false;
    const given = Buffer.from(sig, 'base64url');
    for (const secret of [this.#current, this.#previous]) {
      if (secret === null) continue;
      const expected = Buffer.from(UrlSigner.#hmac(secret, fileId, variant, expiresAtSec), 'base64url');
      if (expected.length === given.length && timingSafeEqual(expected, given)) return true;
    }
    return false;
  }

  /**
   * Query string fragment for a signed URL. Format unchanged from before rotation existed.
   * @param {string} fileId
   * @param {string} variant
   * @param {number} expiresAtSec
   */
  query(fileId, variant, expiresAtSec) {
    return `exp=${expiresAtSec}&sig=${encodeURIComponent(this.sign(fileId, variant, expiresAtSec))}`;
  }

  /**
   * @param {string} secret
   * @param {string} fileId
   * @param {string} variant
   * @param {number} expiresAtSec
   */
  static #hmac(secret, fileId, variant, expiresAtSec) {
    return createHmac('sha256', secret).update(`${fileId}\n${variant}\n${expiresAtSec}`).digest('base64url');
  }
}
