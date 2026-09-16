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

## API

Errors are JSON: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready` | none | Liveness; readiness (database and data directory writable, cached 30 s). |
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

## Configuration

All settings come from environment variables and are validated at startup. See [.env.example](.env.example).

Required: `MEDIA_API_KEYS`, `PUBLIC_BASE_URL`, `SIGNING_SECRET`. `PUBLIC_BASE_URL` is the origin clients use to reach this service; every URL the API returns starts with it.

Rotating `SIGNING_SECRET` invalidates outstanding signed URLs; issue new ones with `POST /v1/files/:id/urls`.

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
| `FileStore`, `TicketStore` | `src/store/` | Blobs, files, upload tickets |
| `LocalStorage`, `TypeSniffer` | `src/storage/` | Content-addressed objects, hashed streaming receive, magic bytes |
| `ImageProcessor` | `src/domain/image-processor.js` | Inspect, normalise, variants (sharp) |
| `MediaService` | `src/domain/media-service.js` | All use-cases |
| `FileName`, `MediaError` | `src/domain/` | Safe names, error codes |
| `UrlSigner` | `src/url-signer.js` | HMAC signed URLs |
| `MediaApi`, `FileServer`, `Cors`, `ApiKeyAuth`, `Schemas` | `src/http/` | Routes, delivery, browser access |
| `Maintenance` | `src/maintenance.js` | Hourly purge |

## Out of scope by design

- Object storage backends (S3, GCS): `LocalStorage` is the only backend. Add a class with the same methods when a deployment needs remote storage.
- Video and audio: not in `ALLOWED_TYPES`; transcoding is a different service.
- Arbitrary resize parameters in URLs: only configured presets, so nobody can make the server encode 10 000 sizes.
- Multiple processes on one data directory: intended deployment is one instance per data directory.

## License

MIT, see [LICENSE](LICENSE).
