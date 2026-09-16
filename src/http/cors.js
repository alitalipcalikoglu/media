/**
 * Minimal CORS for browser-facing routes (ticket uploads, downloads). Origins come from
 * configuration; `*` allows any origin without credentials.
 */
export class Cors {
  static ALLOW_METHODS = 'GET, HEAD, PUT, POST, OPTIONS';
  static ALLOW_HEADERS = 'Content-Type, X-File-Name, Range, If-None-Match';
  static EXPOSE_HEADERS = 'Content-Length, Content-Range, Accept-Ranges, ETag, Location';

  /** @param {string[]} origins */
  constructor(origins) {
    this.any = origins.includes('*');
    this.origins = new Set(origins.map((o) => o.toLowerCase()));
  }

  get enabled() {
    return this.any || this.origins.size > 0;
  }

  /**
   * Fastify `onRequest` hook: adds headers for allowed origins and answers preflights.
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   */
  hook = async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || !this.#allowed(origin)) {
      if (request.method === 'OPTIONS') return reply.code(204).send();
      return;
    }
    reply.header('access-control-allow-origin', this.any ? '*' : origin);
    if (!this.any) reply.header('vary', 'Origin');
    reply.header('access-control-expose-headers', Cors.EXPOSE_HEADERS);
    if (request.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', Cors.ALLOW_METHODS);
      reply.header('access-control-allow-headers', Cors.ALLOW_HEADERS);
      reply.header('access-control-max-age', '600');
      return reply.code(204).send();
    }
  };

  /** @param {string} origin */
  #allowed(origin) {
    return this.any || this.origins.has(origin.toLowerCase());
  }
}
