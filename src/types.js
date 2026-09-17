/** Shared JSDoc typedefs for the media service. No runtime exports. */

/**
 * @typedef {object} ApiKey
 * @property {string} id
 * @property {string} secret
 */

/**
 * @typedef {object} VariantSpec
 * @property {string} name
 * @property {number} width
 * @property {number|null} height
 * @property {'cover'|'inside'|'contain'} fit
 */

/**
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {{ url: string, apiKey: string }|null} audit   Audit service to forward events to; null = off.
 * @property {string} dbPath
 * @property {string} [dbBackupDir]
 * @property {string} dataDir
 * @property {string} publicBaseUrl
 * @property {ApiKey[]} apiKeys
 * @property {number} rateLimitMax
 * @property {string} signingSecret
 * @property {string} [signingSecretPrevious]  Accepted for verification only during a rotation grace period; never used to sign.
 * @property {'local'} storageDriver
 * @property {number} maxConcurrentVariants   Bounded CPU-heavy variant generations at once, process-wide.
 * @property {number} variantWaitTimeoutMs    Bound on how long a new (non-deduped) generation waits for a free slot.
 * @property {number} maxUploadBytes
 * @property {number} maxImagePixels
 * @property {string[]} allowedTypes
 * @property {VariantSpec[]} variants
 * @property {number} variantQuality
 * @property {boolean} stripImageMetadata
 * @property {number} signedUrlTtlSec
 * @property {number} uploadTicketTtlSec
 * @property {number} deleteGraceDays
 * @property {string[]} corsOrigins
 */

/** @typedef {import('./config.js').Config} Config */

/** @typedef {'public'|'private'} Visibility */

/**
 * Content-addressed stored object; shared by every file with the same bytes.
 * @typedef {object} BlobRow
 * @property {string} sha256
 * @property {number} size
 * @property {string} mime
 * @property {number|null} width
 * @property {number|null} height
 * @property {number} created_at
 */

/**
 * @typedef {object} FileRow
 * @property {string} id
 * @property {string} api_key_id
 * @property {string} blob_sha256
 * @property {string} name          Sanitised original file name.
 * @property {Visibility} visibility
 * @property {number} created_at
 * @property {number|null} deleted_at
 */

/** Joined file + blob row returned by FileStore reads. @typedef {FileRow & Omit<BlobRow, 'created_at'>} FileRecord */

/**
 * @typedef {object} TicketRow
 * @property {string} token_hash
 * @property {string} api_key_id
 * @property {Visibility} visibility
 * @property {number} max_bytes
 * @property {string|null} allowed_types  JSON array or null = service default.
 * @property {string|null} name
 * @property {number} expires_at
 * @property {number|null} used_at
 * @property {string|null} file_id
 * @property {number} created_at
 */

/** @typedef {import('fastify').FastifyBaseLogger} Logger */

export {};
