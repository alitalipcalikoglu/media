import { Config } from './config.js';
import { AuditClient } from './net/audit-client.js';
import { Database } from './db.js';
import { ImageProcessor } from './domain/image-processor.js';
import { MediaService } from './domain/media-service.js';
import { MediaApi } from './http/media-api.js';
import { Maintenance } from './maintenance.js';
import { LocalStorage } from './storage/local-storage.js';
import { FileStore } from './store/file-store.js';
import { TicketStore } from './store/ticket-store.js';
import { UrlSigner } from './url-signer.js';

/** Composition root: wires everything and owns the process lifecycle. */
export class Application {
  /** @param {Config} config */
  constructor(config) {
    this.config = config;
    this.audit = new AuditClient({ target: config.audit });
    this.db = new Database(config.dbPath);
    this.files = new FileStore(this.db);
    this.tickets = new TicketStore(this.db);
    this.storage = new LocalStorage(config.dataDir);
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {Maintenance|null} */
    this.maintenance = null;
    this.shuttingDown = false;
  }

  static fromEnv() {
    try {
      return new Application(Config.fromEnv());
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config } = this;
    await this.storage.prepare();
    const service = new MediaService({
      files: this.files, tickets: this.tickets, storage: this.storage,
      images: new ImageProcessor({ maxPixels: config.maxImagePixels, quality: config.variantQuality }),
      signer: new UrlSigner(config.signingSecret),
      log: /** @type {any} */ (console),
      options: {
        publicBaseUrl: config.publicBaseUrl, maxUploadBytes: config.maxUploadBytes, allowedTypes: config.allowedTypes, variants: config.variants,
        stripImageMetadata: config.stripImageMetadata, signedUrlTtlSec: config.signedUrlTtlSec, uploadTicketTtlSec: config.uploadTicketTtlSec,
        deleteGraceMs: config.deleteGraceDays * 86_400_000,
      },
    });
    const app = await new MediaApi({ config, audit: this.audit, service, db: this.db, files: this.files }).build();
    this.app = app;
    service.log = app.log.child({ component: 'media' });
    this.maintenance = new Maintenance({ service, log: app.log.child({ component: 'maintenance' }) });
    this.#installSignalHandlers(app.log);
    this.audit.logger = app.log;
    this.audit.start();
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ tls: config.tls !== null, dataDir: config.dataDir, variants: config.variants.map((v) => v.name) }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    this.maintenance.start();
    if (process.send) process.send('ready'); // PM2 wait_ready
  }

  /** @param {string} reason */
  async shutdown(reason) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const log = /** @type {import('./types.js').Logger} */ (this.app?.log ?? console);
    log.info({ reason }, 'shutting down');
    const forceExit = setTimeout(() => {
      log.error('shutdown timed out, exiting');
      process.exit(1);
    }, 60_000).unref();
    try {
      await this.app?.close();
      await this.audit.close();
      await this.maintenance?.stop();
      this.db.close();
      clearTimeout(forceExit);
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  }

  /** @param {import('./types.js').Logger} log */
  #installSignalHandlers(log) {
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
      log.fatal({ err: reason }, 'unhandled rejection');
      this.shutdown('unhandledRejection');
    });
    process.on('uncaughtException', (err) => {
      log.fatal({ err }, 'uncaught exception');
      process.exit(1);
    });
  }
}
