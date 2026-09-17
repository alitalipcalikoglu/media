import { ApiKeyAuth as CoreApiKeyAuth } from '@atc-web/service-core/auth';

/** @typedef {import('../types.js').ApiKey} ApiKey */

/**
 * Bearer API-key authentication for Fastify. Thin wrapper over service-core's `ApiKeyAuth`: no
 * role model here (media's keys have never had one — `id:secret` only), so `decorate` attaches
 * just `request.apiKeyId`, and `identify()` keeps returning the id string it always returned
 * (not the whole key object core itself would return), so nothing downstream sees a new shape.
 */
export class ApiKeyAuth {
  /** @param {ApiKey[]} apiKeys */
  constructor(apiKeys) {
    this.core = new CoreApiKeyAuth(apiKeys, {
      decorate: (request, key) => { request.apiKeyId = key.id; },
    });
  }

  /** Fastify `onRequest` hook. */
  get hook() {
    return this.core.hook;
  }

  /**
   * @param {string} secret Presented secret.
   * @returns {string|undefined} Matching key id.
   */
  identify(secret) {
    return this.core.identify(secret)?.id;
  }
}
