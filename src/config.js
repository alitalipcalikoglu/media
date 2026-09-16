/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').VariantSpec} VariantSpec */

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

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
    this.dbPath = v.dbPath;
    this.dataDir = v.dataDir;
    this.publicBaseUrl = v.publicBaseUrl;
    this.apiKeys = v.apiKeys;
    this.rateLimitMax = v.rateLimitMax;
    this.signingSecret = v.signingSecret;
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

    const allowedTypes = r.csv('ALLOWED_TYPES', Config.DEFAULT_TYPES).map((t) => t.toLowerCase());
    for (const t of allowedTypes) if (!Config.KNOWN_TYPES.has(t)) throw new ConfigError(`ALLOWED_TYPES contains unsupported type "${t}"`);

    const corsOrigins = r.csv('CORS_ORIGINS', '');
    for (const o of corsOrigins) if (o !== '*' && !/^https?:\/\/[^\s/]+$/.test(o)) throw new ConfigError(`CORS_ORIGINS entry "${o}" must be an origin`);

    return new Config({
      port: r.integer('PORT', 3003, { min: 1, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      dbPath: r.optional('DB_PATH') || './data/media.db',
      dataDir: r.optional('DATA_DIR') || './data/files',
      publicBaseUrl,
      apiKeys: Config.#parseApiKeys(r.required('MEDIA_API_KEYS')),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 600, { min: 1 }),
      signingSecret,
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
    const keys = raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
      const idx = entry.indexOf(':');
      if (idx <= 0) throw new ConfigError(`MEDIA_API_KEYS entry "${entry.slice(0, 8)}…" must be id:secret`);
      const id = entry.slice(0, idx);
      const secret = entry.slice(idx + 1);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ConfigError(`MEDIA_API_KEYS id "${id}" must match [A-Za-z0-9_-]{1,64}`);
      if (secret.length < Config.MIN_SECRET_LENGTH) throw new ConfigError(`MEDIA_API_KEYS secret for "${id}" must be at least ${Config.MIN_SECRET_LENGTH} characters`);
      return { id, secret };
    });
    if (keys.length === 0) throw new ConfigError('MEDIA_API_KEYS must contain at least one key');
    if (new Set(keys.map((k) => k.id)).size !== keys.length) throw new ConfigError('MEDIA_API_KEYS ids must be unique');
    return keys;
  }
}

/** Typed accessors over a raw environment map. */
class EnvReader {
  /** @param {NodeJS.ProcessEnv} env */
  constructor(env) {
    this.env = env;
  }

  /** @param {string} name */
  optional(name) {
    return this.env[name]?.trim() ?? '';
  }

  /** @param {string} name */
  required(name) {
    const v = this.optional(name);
    if (v === '') throw new ConfigError(`${name} is required`);
    return v;
  }

  /**
   * @param {string} name
   * @param {number} fallback
   * @param {{ min?: number, max?: number }} [range]
   */
  integer(name, fallback, range = {}) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
    const n = Number(raw);
    if (range.min !== undefined && n < range.min) throw new ConfigError(`${name} must be >= ${range.min}`);
    if (range.max !== undefined && n > range.max) throw new ConfigError(`${name} must be <= ${range.max}`);
    return n;
  }

  /**
   * @param {string} name
   * @param {boolean} fallback
   */
  boolean(name, fallback) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new ConfigError(`${name} must be true or false, got "${raw}"`);
  }

  /**
   * @param {string} name
   * @param {string} fallback
   */
  csv(name, fallback) {
    const raw = this.env[name] === undefined ? fallback : this.env[name];
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
}
