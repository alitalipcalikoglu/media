import { Config, ConfigError } from './config.js';
import { AuditClient } from '@atc-web/service-core/audit';
import { readServiceVersion } from '@atc-web/service-core/fastify';
import { Lifecycle } from '@atc-web/service-core/lifecycle';
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
    this.version = readServiceVersion(import.meta.url);
    this.audit = new AuditClient({ target: config.audit });
    this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir });
    this.files = new FileStore(this.db);
    this.tickets = new TicketStore(this.db);
    // Stage 8: only "local" exists — config.js already fails fast on anything else, so this
    // switch is currently a single case, not a sign a second backend is coming.
    switch (config.storageDriver) {
      case 'local': this.storage = new LocalStorage(config.dataDir); break;
      default: throw new ConfigError(`STORAGE_DRIVER "${config.storageDriver}" is not supported`);
    }
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {Maintenance|null} */
    this.maintenance = null;
    /** @type {(reason: string) => Promise<void>} */
    this.shutdown = async () => {};
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
      signer: new UrlSigner(config.signingSecret, config.signingSecretPrevious),
      log: /** @type {any} */ (console),
      options: {
        publicBaseUrl: config.publicBaseUrl, maxUploadBytes: config.maxUploadBytes, allowedTypes: config.allowedTypes, variants: config.variants,
        stripImageMetadata: config.stripImageMetadata, signedUrlTtlSec: config.signedUrlTtlSec, uploadTicketTtlSec: config.uploadTicketTtlSec,
        deleteGraceMs: config.deleteGraceDays * 86_400_000,
        maxConcurrentVariants: config.maxConcurrentVariants, variantWaitTimeoutMs: config.variantWaitTimeoutMs,
        trashGraceMs: config.trashGraceMs, trashMaxEntries: config.trashMaxEntries,
      },
    });
    const app = await new MediaApi({ config, audit: this.audit, service, db: this.db, files: this.files, version: this.version }).build();
    this.app = app;
    service.log = app.log.child({ component: 'media' });
    this.maintenance = new Maintenance({ service, log: app.log.child({ component: 'maintenance' }) });
    const { shutdown } = Lifecycle.install({
      forceExitMs: 60_000,
      log: app.log,
      steps: [
        () => this.app?.close(),
        () => this.audit.close(),
        () => this.maintenance?.stop(),
        () => this.db.close(),
      ],
    });
    this.shutdown = shutdown;
    this.audit.logger = app.log;
    this.audit.start();
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ tls: config.tls !== null, dataDir: config.dataDir, variants: config.variants.map((v) => v.name) }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    this.maintenance.start();
    if (process.send) process.send('ready'); // PM2 wait_ready
  }

}
