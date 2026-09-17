import { ConfigError, EnvReader, parseApiKeys, parseAudit } from '@atc-web/service-core/config';

/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').VariantSpec} VariantSpec */

export { ConfigError };

/** Image variant preset, parsed from `name:WIDTHxHEIGHT:fit` or `name:WIDTH`. */
export class VariantPreset {
  static MAX_DIMENSION = 4096;

  /**
   * @param {string} raw
   * @returns {VariantSpec}
   */
  static parse(raw) {
    const m = /^([a-z][a-z0-9-]{0,31}):(\d{1,4})(?:x(\d{1,4}))?(?::(cover|inside|contain))?$/.exec(raw.trim());
    if (!m) throw new ConfigError(`VARIANTS entry "${raw}" must look like name:800, name:200x200 or name:200x200:cover`);
    const width = Number(m[2]);
    const height = m[3] ? Number(m[3]) : null;
    if (width < 1 || width > VariantPreset.MAX_DIMENSION || (height !== null && (height < 1 || height > VariantPreset.MAX_DIMENSION))) {
      throw new ConfigError(`VARIANTS entry "${raw}" dimensions must be 1..${VariantPreset.MAX_DIMENSION}`);
    }
    const fit = /** @type {VariantSpec['fit']} */ (m[4] ?? (height ? 'cover' : 'inside'));
    return { name: m[1], width, height, fit };
  }

  /**
   * @param {string} csv
   * @returns {VariantSpec[]}
   */
  static parseList(csv) {
    const specs = csv.split(',').map((s) => s.trim()).filter(Boolean).map(VariantPreset.parse);
    if (new Set(specs.map((s) => s.name)).size !== specs.length) throw new ConfigError('VARIANTS names must be unique');
    if (specs.some((s) => s.name === 'original')) throw new ConfigError('VARIANTS name "original" is reserved');
    return specs;
  }
}

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;
  static DEFAULT_TYPES = 'image/jpeg,image/png,image/webp,image/gif,image/avif,application/pdf';
  static DEFAULT_VARIANTS = 'thumb:200x200:cover,small:400,medium:800,large:1600';
  static KNOWN_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml', 'application/pdf']);

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.audit = v.audit;
    this.dbPath = v.dbPath;
    this.dbBackupDir = v.dbBackupDir;
    this.dataDir = v.dataDir;
    this.publicBaseUrl = v.publicBaseUrl;
    this.apiKeys = v.apiKeys;
    this.rateLimitMax = v.rateLimitMax;
    this.signingSecret = v.signingSecret;
    this.signingSecretPrevious = v.signingSecretPrevious;
    this.storageDriver = v.storageDriver;
    this.maxConcurrentVariants = v.maxConcurrentVariants;
    this.variantWaitTimeoutMs = v.variantWaitTimeoutMs;
    this.maxUploadBytes = v.maxUploadBytes;
    this.maxImagePixels = v.maxImagePixels;
    this.allowedTypes = v.allowedTypes;
    this.variants = v.variants;
    this.variantQuality = v.variantQuality;
    this.stripImageMetadata = v.stripImageMetadata;
    this.signedUrlTtlSec = v.signedUrlTtlSec;
    this.uploadTicketTtlSec = v.uploadTicketTtlSec;
    this.deleteGraceDays = v.deleteGraceDays;
    this.corsOrigins = v.corsOrigins;
    Object.freeze(this);
  }

  /**
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {Config}
   */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);
    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');

    const publicBaseUrl = r.required('PUBLIC_BASE_URL').replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+$/.test(publicBaseUrl)) throw new ConfigError('PUBLIC_BASE_URL must be an origin like https://media.example.com');

    const signingSecret = r.required('SIGNING_SECRET');
    if (signingSecret.length < Config.MIN_SECRET_LENGTH) throw new ConfigError(`SIGNING_SECRET must be at least ${Config.MIN_SECRET_LENGTH} characters`);
    const signingSecretPrevious = r.optional('SIGNING_SECRET_PREVIOUS') || undefined;
    if (signingSecretPrevious !== undefined && signingSecretPrevious.length < Config.MIN_SECRET_LENGTH) {
      throw new ConfigError(`SIGNING_SECRET_PREVIOUS must be at least ${Config.MIN_SECRET_LENGTH} characters`);
    }
    if (signingSecretPrevious !== undefined && signingSecretPrevious === signingSecret) {
      throw new ConfigError('SIGNING_SECRET_PREVIOUS must not be the same as SIGNING_SECRET');
    }

    // Stage 8: the only backend today. Fail fast on anything else rather than silently ignoring
    // an operator's typo — see Application#start for where this actually selects a Storage.
    const storageDriver = r.optional('STORAGE_DRIVER') || 'local';
    if (storageDriver !== 'local') throw new ConfigError(`STORAGE_DRIVER "${storageDriver}" is not supported; only "local" exists today`);

    const allowedTypes = r.list('ALLOWED_TYPES', Config.DEFAULT_TYPES).map((t) => t.toLowerCase());
    for (const t of allowedTypes) if (!Config.KNOWN_TYPES.has(t)) throw new ConfigError(`ALLOWED_TYPES contains unsupported type "${t}"`);

    const corsOrigins = r.list('CORS_ORIGINS', '');
    for (const o of corsOrigins) if (o !== '*' && !/^https?:\/\/[^\s/]+$/.test(o)) throw new ConfigError(`CORS_ORIGINS entry "${o}" must be an origin`);

    return new Config({
      port: r.integer('PORT', 3003, { min: 1, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: parseAudit(r),
      dbPath: r.optional('DB_PATH') || './data/media.db',
      dbBackupDir: r.optional('DB_BACKUP_DIR') || undefined,
      dataDir: r.optional('DATA_DIR') || './data/files',
      publicBaseUrl,
      apiKeys: Config.#parseApiKeys(r.required('MEDIA_API_KEYS')),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 600, { min: 1 }),
      signingSecret,
      signingSecretPrevious,
      storageDriver,
      maxConcurrentVariants: r.integer('MAX_CONCURRENT_VARIANTS', 4, { min: 1, max: 64 }),
      variantWaitTimeoutMs: r.integer('VARIANT_WAIT_TIMEOUT_MS', 30_000, { min: 1_000, max: 300_000 }),
      maxUploadBytes: r.integer('MAX_UPLOAD_BYTES', 25 * 1024 * 1024, { min: 1024 }),
      maxImagePixels: r.integer('MAX_IMAGE_PIXELS', 50_000_000, { min: 10_000 }),
      allowedTypes,
      variants: VariantPreset.parseList(r.optional('VARIANTS') || Config.DEFAULT_VARIANTS),
      variantQuality: r.integer('VARIANT_QUALITY', 82, { min: 1, max: 100 }),
      stripImageMetadata: r.boolean('STRIP_IMAGE_METADATA', true),
      signedUrlTtlSec: r.integer('SIGNED_URL_TTL_SEC', 900, { min: 10, max: 604_800 }),
      uploadTicketTtlSec: r.integer('UPLOAD_TICKET_TTL_SEC', 900, { min: 30, max: 86_400 }),
      deleteGraceDays: r.integer('DELETE_GRACE_DAYS', 7, { min: 0 }),
      corsOrigins,
    });
  }

  /**
   * @param {string} raw
   * @returns {ApiKey[]}
   */
  static #parseApiKeys(raw) {
    return parseApiKeys(raw, 'MEDIA_API_KEYS', { minSecretLength: Config.MIN_SECRET_LENGTH });
  }
}
