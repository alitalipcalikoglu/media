# media

File storage and delivery for application backends: authenticated uploads, content-addressed storage, image normalisation and on-demand variants, signed URLs for private files, ticketed direct-from-browser uploads, range-capable delivery with cache and security headers.

Runtime dependencies: `fastify`, `@fastify/rate-limit`, `sharp`. Storage is the local file system plus SQLite metadata via `node:sqlite` (built into Node 22.13+). The folder is self-contained: copy it to any host with Node 22 and run.

## Run

```bash
cp .env.example .env        # fill in keys, PUBLIC_BASE_URL, CORS_ORIGINS
npm ci
npm run dev
```

Production with PM2 (reads `./.env` through Node's `--env-file`):

```bash
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Production with Docker (mount the data volume; it holds both the database and the objects):

```bash
docker build -t atc-media .
docker run -p 3003:3003 -v media-data:/data --env-file .env atc-media
```

Tests and type check:

```bash
npm test
npm run typecheck
```

## Model

- **Callers are trusted backends** holding an API key from `MEDIA_API_KEYS`. Browsers reach the service only through upload tickets and download URLs.
- **Upload is a raw body.** `PUT` the bytes with `Content-Type` and optional `X-File-Name` (URL-encoded). No multipart. Browsers can do `fetch(url, { method: 'PUT', body: file })`.
- **Type is sniffed, never trusted.** The first bytes decide the type; anything not in `ALLOWED_TYPES` is rejected with `415`. The stored name's extension is rewritten to match.
- **Images are re-encoded on upload** (`STRIP_IMAGE_METADATA=true`): EXIF, GPS and XMP are dropped, orientation is applied, the file becomes a clean encoder product. Decoding is capped at `MAX_IMAGE_PIXELS`.
- **Storage is content-addressed.** Identical bytes are stored once; files are named references to a blob. Deleting a file is soft; bytes disappear after `DELETE_GRACE_DAYS`, when no file references the blob any more.
- **Variants** are presets from `VARIANTS` (`thumb:200x200:cover`, `medium:800`, …), generated on first request, cached on disk, served as WebP, never enlarged.
- **Visibility.** `public` files have stable URLs with immutable caching. `private` files need `exp` and `sig` query parameters; signatures are bound to file id, variant and expiry.

## Boundaries

**Purpose:** content-addressed file storage, ticketed uploads, and signed delivery.

**Responsibilities:** dedup by sha256; ticketed browser uploads; public/private visibility; signed, time-limited delivery URLs; variant generation; soft delete/restore; purge.

**Non-responsibilities:** media ≠ CDN/object-store implementation — today's `LocalStorage` is disk-only, single-node; the `Storage` interface (a later stage) is a seam for a future backend, not a claim that one exists. It is not a general blob store for other services' internal files — everything goes through this same public, ticketed/signed API, never a shared disk path.

## API

Errors are JSON: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready`, `/v1/info` | none | Liveness; readiness (database and data directory writable, cached 30 s); service identity (version, API version, capabilities, schema version, service-core version). |
| PUT | `/v1/files?visibility=&name=` | API key | Upload raw body. `201` with `file`. Headers: `Content-Type`, `X-File-Name`. |
| GET | `/v1/files?limit=&cursor=` | API key | Own files, newest first. |
| GET / PATCH / DELETE | `/v1/files/:id` | API key | Metadata; change `visibility` / `name`; soft delete (`204`). |
| POST | `/v1/files/:id/restore` | API key | Undo a soft delete within the grace period. |
| POST | `/v1/files/:id/urls?ttl=` | API key | Fresh URLs (signed for private files, `ttl` seconds, max 7 days). |
| POST | `/v1/uploads` | API key | Create an upload ticket `{ visibility?, maxBytes?, allowedTypes?, name? }` → `{ token, uploadUrl, method: "PUT", expiresAt, maxBytes, allowedTypes }`. |
| PUT | `/v1/uploads/:token?name=` | ticket | Direct upload from a browser. Single use, constrained by the ticket. `201` with `file`. |
| GET / HEAD | `/files/:id/original` | public or `exp`+`sig` | The stored bytes. |
| GET / HEAD | `/files/:id/:variant` | public or `exp`+`sig` | Image variant as WebP. |
| GET | `/metrics` | API key | Prometheus text: files, blobs, bytes, uploads, downloads. |

`file` shape: `{ id, name, mime, size, width, height, sha256, visibility, createdAt, urls: { original, thumb, … } }` where each url is `{ url, expiresAt }` (`expiresAt` null for public files).

Delivery headers: strong `ETag` (304 on `If-None-Match`), `Accept-Ranges: bytes` with single-range `206`/`416`, `Cache-Control: public, max-age=31536000, immutable` for public files and `no-store` for private ones, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`. Images are `inline`; PDFs and everything else are `attachment` with `X-Frame-Options: DENY`.

Error codes: `UNSUPPORTED_TYPE` (415), `TOO_LARGE` (413), `INVALID_IMAGE` (422), `EMPTY`, `INVALID_ARGUMENT`, `NOT_AN_IMAGE`, `VALIDATION_FAILED` (400), `INVALID_TICKET`, `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND`, `UNKNOWN_VARIANT` (404), `RATE_LIMITED` (429).

### Typical flows

Backend upload:

```bash
curl -X PUT "https://media.example.com/v1/files?visibility=public" \
  -H "Authorization: Bearer $MEDIA_KEY" -H "Content-Type: image/jpeg" \
  -H "X-File-Name: product.jpg" --data-binary @product.jpg
```

Browser upload without proxying through your backend:

1. Backend: `POST /v1/uploads` with `{ "allowedTypes": ["image/jpeg","image/png"], "maxBytes": 5000000, "visibility": "public" }`, hand `uploadUrl` to the page.
2. Page: `fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'X-File-Name': encodeURIComponent(file.name) } })`. The origin must be in `CORS_ORIGINS`.
3. Page receives `{ file }`, sends `file.id` to the backend.

Private file for a signed-in user: backend calls `POST /v1/files/:id/urls?ttl=300` and embeds `urls.medium.url` in the page.

## Examples

Scenario walkthroughs for every feature live in [examples/](examples/README.md).

## Configuration

All settings come from environment variables and are validated at startup. See [.env.example](.env.example).

Required: `MEDIA_API_KEYS`, `PUBLIC_BASE_URL`, `SIGNING_SECRET`. `PUBLIC_BASE_URL` is the origin clients use to reach this service; every URL the API returns starts with it.

- `STORAGE_DRIVER` (default `local`) — which `Storage` backend to use. `local` (`LocalStorage`) is the only value that exists today; anything else fails startup immediately with a `ConfigError`, never a silent fallback. See "Code layout" for the `Storage` interface itself.
- `MAX_CONCURRENT_VARIANTS` (default `4`) and `VARIANT_WAIT_TIMEOUT_MS` (default `30000`) — bound CPU-heavy on-demand variant generation; see "Scaling model" below for the exact semantics.

### Rotating `SIGNING_SECRET`

Signed URLs are self-contained (the expiry is part of the signed data) — rotating the secret with
nothing else in place invalidates every outstanding signed URL immediately, which breaks any
client that cached one. `SIGNING_SECRET_PREVIOUS` gives a grace period instead:

1. `K1` is `SIGNING_SECRET` today; nothing else configured.
2. Deploy with `SIGNING_SECRET=K2` (new) and `SIGNING_SECRET_PREVIOUS=K1` (old). From this moment:
   every *new* URL is signed with `K2` only; verification accepts a signature made with either
   `K2` or `K1` — `K1` is never used to sign anything new, only to keep validating URLs already
   handed out.
3. Wait out the grace period: the longest TTL any URL signed under `K1` could still have
   (`SIGNED_URL_TTL_SEC`, or a longer custom `ttl` passed to `POST /v1/files/:id/urls` — 7 days
   max). Any `K1` URL older than that has already expired on its own.
4. Deploy again with `SIGNING_SECRET_PREVIOUS` removed. `K1` URLs now fail verification (fail
   closed, same as an unrecognised secret); `K2` keeps working. `SIGNING_SECRET_PREVIOUS` is not
   meant to be kept indefinitely — it exists for exactly this window.

Neither secret is ever logged or exposed via `/v1/info` or any other endpoint. If a backup or an
old `.env` gets restored with a stale `SIGNING_SECRET`/`SIGNING_SECRET_PREVIOUS` pair, matching
that pair up with whatever URLs were actually issued under it is the operator's own
responsibility — the service has no way to know which secret was live when a given signed URL
still in the wild was generated.

## Security notes

- API keys compared in constant time; per-key rate limit; unknown query fields rejected.
- Upload limits: `MAX_UPLOAD_BYTES` enforced while streaming (the connection is cut, nothing is kept), `MAX_IMAGE_PIXELS` before any decode.
- Only sniffed, allow-listed types are stored. SVG is off by default (scriptable); if enabled it is served as an attachment inside a sandboxed CSP.
- Re-encoding images removes metadata (location, device, author) and neutralises polyglot payloads.
- Names are sanitised (no path separators, control characters or quotes), length-capped, and get the real extension. `Content-Disposition` carries an ASCII fallback plus RFC 6266 `filename*`.
- Signed URLs use HMAC-SHA256 with constant-time verification; expiry is part of the signed data.
- Upload tickets are single use, expire, are stored hashed, and carry their own type and size limits; a failed upload releases the ticket so the client can retry.
- Temp files live under the data directory with mode 0600 and are wiped on start.
- Container runs as the unprivileged `node` user.

## Code layout

Class-based; dependencies are injected through constructors, `src/application.js` is the composition root.

| Class | File | Role |
|---|---|---|
| `Application` | `src/application.js` | Wiring, startup, graceful shutdown |
| `Config`, `VariantPreset` | `src/config.js` | Validated environment, preset parsing |
| `Database` | `src/db.js` | SQLite connection, migrations, transactions |
| `FileStore`, `TicketStore` | `src/store/` | Blobs, files, upload tickets; `FileStore`'s two-phase mark/finalize purge protocol (Stage 8.1) closes the purge-vs-concurrent-upload race — see `docs/READINESS.md` |
| `Storage` | `src/storage/storage.js` | The storage contract (Stage 8) — `prepare`/`check`/`tempKey`/`writeTemp`/`commit`/`writeAtomic`/`exists`/`open`/`stat`/`localPath`/`remove`/`discard` — everything `MediaService` depends on; a filesystem path never crosses it except through the explicit, nullable `localPath` escape hatch |
| `LocalStorage`, `TypeSniffer` | `src/storage/` | The only `Storage` implementation today; content-addressed objects, hashed streaming receive, magic bytes |
| `ImageProcessor` | `src/domain/image-processor.js` | Inspect, normalise, variants (sharp) |
| `MediaService` | `src/domain/media-service.js` | All use-cases; talks to bytes only through `Storage` |
| `Semaphore` | `src/domain/semaphore.js` | Bounded concurrency gate behind `MAX_CONCURRENT_VARIANTS` |
| `FileName`, `MediaError` | `src/domain/` | Safe names, error codes |
| `UrlSigner` | `src/url-signer.js` | HMAC signed URLs |
| `MediaApi`, `FileServer`, `Cors`, `ApiKeyAuth`, `Schemas` | `src/http/` | Routes, delivery, browser access |
| `Maintenance` | `src/maintenance.js` | Hourly purge |

## Out of scope by design

- Object storage backends (S3, GCS): `LocalStorage` is the only `Storage` implementation. A future backend implements the same interface (`src/storage/storage.js`) — see its "Stage 8 report" note on the real semantic gaps a remote backend would still have to close (no atomic rename equivalent, streaming/`localPath` fallback cost, consistency model) before assuming a drop-in replacement is trivial.
- Video and audio: not in `ALLOWED_TYPES`; transcoding is a different service.
- Arbitrary resize parameters in URLs: only configured presets, so nobody can make the server encode 10 000 sizes.
- Multiple processes on one data directory: intended deployment is one instance per data directory.

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, every completed write request is forwarded to the audit service as one event (`success`, or `denied` on 403) with the calling key as actor, the affected entity as target, client IP, user agent and request id. Events are buffered and sent in batches; the audit service being down never fails a request. Actions: see [examples/audit-events.md](examples/audit-events.md).

## Scaling model

Single-node stateful: one process owns the SQLite file and the local object-storage directory.
Deferred variant generation de-duplicates concurrent requests for the same variant only within one
process — two instances asked for the same missing variant would both encode it (wasted work, not
corruption). Two instances sharing one data directory are not supported.

**Variant generation concurrency (Stage 8).** Two layers, always in this order:
1. **Dedupe** — every concurrent request for the exact same `(object, variant)` shares one
   in-flight generation; N callers cost exactly one CPU-bound encode, never N.
2. **`MAX_CONCURRENT_VARIANTS`** (default 4) — only genuinely distinct generations (a different
   object, or a variant nobody is currently making) contend for this many process-wide slots. A
   new one that finds every slot taken waits, bounded by `VARIANT_WAIT_TIMEOUT_MS` (default 30s)
   and by a bounded wait queue (`4×` the slot count) — past either bound it fails with `503
   VARIANT_BUSY` rather than queueing forever. A waiting HTTP request whose client disconnects
   stops waiting immediately (best-effort — see `MediaService#resolve`'s doc for why this can never
   cancel a generation shared with another still-connected caller). A failed generation (thrown
   error, or a storage write failure) always releases its slot and never leaves a cached failure
   behind — the next request retries from scratch, and a partial/corrupt variant is never visible
   under its final key (write is atomic).

## Observability

Accepts an inbound `X-Request-Id` unconditionally and logs it via Fastify's default request
logging. Does not parse or forward `traceparent`.

## Backup / restore

Back up the database and the `objects`/`variants` directories from the same snapshot — restoring
only one half produces a database row pointing at a missing file, or an orphaned file with no row.
`stack backup`/`stack restore` from the workspace root (see `stack/docs/UPGRADE.md`) captures the
database and both directories together for exactly this reason; a database-only backup is never a
complete backup of this service. `tmp/` (in-flight uploads) is never included — it is safe to lose
and is cleared on the next start anyway. On every start, before applying a pending migration to an
existing database, the service itself also snapshots the database file to
`DB_PATH.pre-v<N>-<timestamp>` (directory overridable with `DB_BACKUP_DIR`) — a manual last resort
that still needs `objects`/`variants` restored alongside it.

**Rollback limitations:** none of the migrations are reversible; to roll back, restore the database
and `objects`/`variants` from the same `stack backup` snapshot (or the pre-migration database copy
plus a same-time file copy) and run the previous version of this service against it.

See [docs/READINESS.md](docs/READINESS.md) for the full contract.

## License

MIT, see [LICENSE](LICENSE).
