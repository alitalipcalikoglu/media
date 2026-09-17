import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '../net/audit-client.js';
import { MediaError } from '../domain/errors.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { Cors } from './cors.js';
import { FileServer } from './file-server.js';
import { Schemas } from './schemas.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('../domain/media-service.js').MediaService} MediaService */
/** @typedef {import('../types.js').FileRecord} FileRecord */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */

/** Opaque keyset cursor for listing. */
class FileCursor {
  /** @param {FileRecord} row */
  static encode(row) {
    return Buffer.from(`${row.created_at}:${row.id}`).toString('base64url');
  }

  /** @param {string} cursor */
  static decode(cursor) {
    const m = /^(\d{1,16}):([0-9a-f-]{36})$/.exec(Buffer.from(cursor, 'base64url').toString());
    if (!m) throw new MediaError('INVALID_ARGUMENT', 'invalid cursor');
    return { createdAt: Number(m[1]), id: m[2] };
  }
}

/**
 * HTTP surface.
 *  - `/v1/*` (API key): upload, metadata, tickets, signing.
 *  - `/v1/uploads/:token` (ticket, browser): direct upload.
 *  - `/files/:id/:variant` (public or signed): delivery.
 */
export class MediaApi {
  static READY_CACHE_MS = 30_000;

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {MediaService} deps.service
   * @param {import('../db.js').Database} deps.db
   * @param {import('../store/file-store.js').FileStore} deps.files
   * @param {import('../types.js').Logger} [deps.logger]
   * @param {import('../net/audit-client.js').AuditClient} [deps.audit]
   */
  constructor({ config, audit, service, db, files, logger }) {
    this.config = config;
    this.audit = audit;
    this.service = service;
    this.db = db;
    this.files = files;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
    this.cors = new Cors(config.corsOrigins);
    this.fileServer = new FileServer();
    this.readyCache = { at: 0, ok: false, error: '' };
    this.counters = { uploads: 0, downloads: 0, bytesOut: 0 };
  }

  /** @returns {Promise<FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      loggerInstance: this.logger,
      logger: this.logger ? undefined : { level: config.logLevel, redact: ['req.headers.authorization'] },
      trustProxy: config.trustProxy,
      bodyLimit: config.maxUploadBytes + 1024,
      requestIdHeader: 'x-request-id',
      genReqId: () => randomUUID(),
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    // Uploads arrive as raw bodies of any type; hand the stream through untouched.
    app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    app.decorateRequest('apiKeyId', '');
    app.setErrorHandler(this.#errorHandler);
    app.addHook('onSend', AuditClient.hook(this.audit));
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    if (this.cors.enabled) app.addHook('onRequest', this.cors.hook);
    this.#registerProbes(app);
    this.#registerDelivery(app);
    this.#registerTicketUpload(app);
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }

  /** @type {FastifyInstance['errorHandler']} */
  #errorHandler = (rawErr, request, reply) => {
    const err = /** @type {import('fastify').FastifyError & { validation?: { instancePath: string, message?: string, params: object }[] }} */ (rawErr);
    if (err instanceof MediaError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err.validation) {
      return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: err.message, details: err.validation.map((v) => ({ path: v.instancePath, message: v.message, params: v.params })) } });
    }
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: { code: 'TOO_LARGE', message: `upload exceeds ${this.config.maxUploadBytes} bytes` } });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(status).send({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    }
    return reply.code(status).send({ error: { code: err.code ?? 'REQUEST_ERROR', message: err.message } });
  };

  /**
   * @param {FileRecord} f
   * @param {number} [ttlSec]
   */
  #view(f, ttlSec) {
    return {
      id: f.id,
      name: f.name,
      mime: f.mime,
      size: f.size,
      width: f.width,
      height: f.height,
      sha256: f.sha256,
      visibility: f.visibility,
      createdAt: new Date(f.created_at).toISOString(),
      urls: this.service.urls(f, ttlSec),
    };
  }

  /**
   * Raw upload body plus optional `X-File-Name`.
   * @param {FastifyRequest} request
   */
  static #fileName(request) {
    const header = request.headers['x-file-name'];
    if (typeof header !== 'string' || !header) return null;
    try {
      return decodeURIComponent(header);
    } catch {
      return header;
    }
  }

  /** @param {FastifyInstance} app */
  #registerProbes(app) {
    app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok' }));
    app.get('/ready', { logLevel: 'warn' }, async (_request, reply) => {
      const now = Date.now();
      if (now - this.readyCache.at > MediaApi.READY_CACHE_MS) {
        try {
          this.db.ping();
          await this.service.storage.check();
          this.readyCache = { at: now, ok: true, error: '' };
        } catch (err) {
          this.readyCache = { at: now, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (!this.readyCache.ok) {
        app.log.warn({ error: this.readyCache.error }, 'readiness check failed');
        return reply.code(503).send({ status: 'unavailable', error: this.readyCache.error });
      }
      return { status: 'ok' };
    });
  }

  /** Public + signed delivery. @param {FastifyInstance} app */
  #registerDelivery(app) {
    const handler = async (/** @type {FastifyRequest} */ request, /** @type {import('fastify').FastifyReply} */ reply) => {
      const { id, variant } = /** @type {{ id: string, variant: string }} */ (request.params);
      const query = /** @type {{ exp?: string, sig?: string, download?: string }} */ (request.query);
      const file = this.service.get(id);
      if (!this.service.authorize(file, variant, query)) throw new MediaError('FORBIDDEN', 'missing or invalid signature');
      const target = await this.service.resolve(file, variant);
      if (query.download === '1') reply.header('x-media-force-download', '1');
      this.counters.downloads += 1;
      this.counters.bytesOut += target.size;
      return this.fileServer.send(request, reply, file, target, variant);
    };
    /** @type {import('fastify').RouteShorthandOptions} */
    const opts = { schema: { params: Schemas.idVariantParams, querystring: Schemas.downloadQuery }, logLevel: 'warn' };
    app.get('/files/:id/:variant', opts, handler);
  }

  /** Ticketed browser upload: no API key, ticket is the credential. @param {FastifyInstance} app */
  #registerTicketUpload(app) {
    app.put('/v1/uploads/:token', { schema: { params: Schemas.tokenParams, querystring: Schemas.ticketUploadQuery } }, async (request, reply) => {
      const { token } = /** @type {{ token: string }} */ (request.params);
      const q = /** @type {{ name?: string }} */ (request.query);
      const f = await this.service.uploadWithTicket(token, /** @type {NodeJS.ReadableStream} */ (request.raw), { name: q.name ?? MediaApi.#fileName(request) });
      this.counters.uploads += 1;
      reply.header('location', `/v1/files/${f.id}`);
      return reply.code(201).send({ file: this.#view(f) });
    });
  }

  /** @param {FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKeyId,
      errorResponseBuilder: (_request, context) => Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), { statusCode: 429, code: 'RATE_LIMITED' }),
    });
    const s = this.service;

    api.put('/files', { config: { audit: AuditClient.route('media.file.upload', (_r, b) => ({ type: 'file', id: b.file.id }), (_r, b) => ({ name: b?.file?.name, visibility: b?.file?.visibility })) },  schema: { querystring: Schemas.uploadQuery } }, async (request, reply) => {
      const q = /** @type {{ visibility?: 'public'|'private', name?: string }} */ (request.query);
      const f = await s.upload(/** @type {NodeJS.ReadableStream} */ (request.raw), { apiKeyId: request.apiKeyId, visibility: q.visibility, name: q.name ?? MediaApi.#fileName(request) });
      this.counters.uploads += 1;
      reply.header('location', `/v1/files/${f.id}`);
      return reply.code(201).send({ file: this.#view(f) });
    });

    api.get('/files', { schema: { querystring: Schemas.listQuery } }, async (request) => {
      const q = /** @type {{ limit?: string, cursor?: string }} */ (request.query);
      const limit = q.limit ? Number(q.limit) : 20;
      const rows = s.list(request.apiKeyId, { limit: limit + 1, before: q.cursor ? FileCursor.decode(q.cursor) : undefined });
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items: items.map((f) => this.#view(f)), nextCursor: rows.length > limit && last ? FileCursor.encode(last) : null };
    });

    api.get('/files/:id', { schema: { params: Schemas.idParams } }, async (request) => ({
      file: this.#view(s.get(/** @type {{ id: string }} */ (request.params).id, request.apiKeyId)),
    }));

    api.patch('/files/:id', { config: { audit: AuditClient.route('media.file.update', (r) => ({ type: 'file', id: /** @type {any} */ (r.params).id }), (r) => ({ patch: r.body })) },  schema: { params: Schemas.idParams, body: Schemas.patchBody } }, async (request) => ({
      file: this.#view(s.update(/** @type {{ id: string }} */ (request.params).id, request.apiKeyId, /** @type {any} */ (request.body))),
    }));

    api.delete('/files/:id', { config: { audit: AuditClient.route('media.file.delete', (r) => ({ type: 'file', id: /** @type {any} */ (r.params).id })) },  schema: { params: Schemas.idParams } }, async (request, reply) => {
      s.delete(/** @type {{ id: string }} */ (request.params).id, request.apiKeyId);
      return reply.code(204).send();
    });

    api.post('/files/:id/restore', { config: { audit: AuditClient.route('media.file.restore', (r) => ({ type: 'file', id: /** @type {any} */ (r.params).id })) },  schema: { params: Schemas.idParams } }, async (request) => ({
      file: this.#view(s.restore(/** @type {{ id: string }} */ (request.params).id, request.apiKeyId)),
    }));

    api.post('/files/:id/urls', { schema: { params: Schemas.idParams, querystring: Schemas.signQuery } }, async (request) => {
      const f = s.get(/** @type {{ id: string }} */ (request.params).id, request.apiKeyId);
      const q = /** @type {{ ttl?: string }} */ (request.query);
      const ttl = q.ttl ? Math.min(Number(q.ttl), 604_800) : undefined;
      return { urls: s.urls(f, ttl) };
    });

    api.post('/uploads', { config: { audit: AuditClient.route('media.upload.ticket', (_r, b) => ({ type: 'ticket', id: b.token })) },  schema: { body: Schemas.ticketBody } }, async (request, reply) => {
      const body = /** @type {any} */ (request.body ?? {});
      const t = s.createTicket({ apiKeyId: request.apiKeyId, ...body });
      return reply.code(201).send({ ...t, expiresAt: new Date(t.expiresAt).toISOString(), method: 'PUT' });
    });
  }

  /** @param {FastifyInstance} ops */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn' }, async (_request, reply) => {
      const st = this.files.stats();
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP media_files Live files.', '# TYPE media_files gauge', `media_files ${st.files}`,
        '# HELP media_blobs Stored unique objects.', '# TYPE media_blobs gauge', `media_blobs ${st.blobs}`,
        '# HELP media_stored_bytes Bytes of stored originals.', '# TYPE media_stored_bytes gauge', `media_stored_bytes ${st.bytes}`,
        '# HELP media_uploads_total Successful uploads since start.', '# TYPE media_uploads_total counter', `media_uploads_total ${this.counters.uploads}`,
        '# HELP media_downloads_total Delivery requests since start.', '# TYPE media_downloads_total counter', `media_downloads_total ${this.counters.downloads}`,
        '# HELP media_downloaded_bytes_total Bytes requested since start.', '# TYPE media_downloaded_bytes_total counter', `media_downloaded_bytes_total ${this.counters.bytesOut}`,
        '# HELP media_process_uptime_seconds Process uptime.', '# TYPE media_process_uptime_seconds gauge', `media_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }
}
