# media readiness contract

## Purpose

Secure binary/media storage and delivery: raw streaming uploads, real MIME sniffing, image
normalisation with metadata stripped, sha256 content-addressed deduplication, signed URLs, browser
upload tickets, on-demand WebP variants, soft delete with a grace period. Out of scope: an
S3-compatible backend today (README says "add a class with the same methods"; not implemented),
malware scanning, resumable/multipart uploads.

## Dependencies

audit (`AUDIT_URL`/`AUDIT_API_KEY`), optional, both-or-neither: forwards upload/update/delete/
restore/ticket events. Nothing else.

## Persistence

SQLite (`DB_PATH`): `blobs` (sha256-keyed), `files` (references a blob, soft-delete via
`deleted_at`), `upload_tickets` (hashed token, single use). Object storage on disk:
`<dataDir>/objects/<sha2>/<sha4>/<sha256>` (immutable originals), `<dataDir>/variants/<sha256>/
<name>.webp` (derived), `<dataDir>/tmp/<uuid>` (in-flight uploads, written with `flags:'wx', mode
0600`, moved into place with `rename`).

## Health endpoint

`GET /health`: static `{"status":"ok"}`.

## Readiness endpoint

`GET /ready`: `db.ping()` **and** `storage.check()`. As of Stage 0, `check()` only verifies the
directory layout exists and is writable (`mkdir` with `recursive: true`) — it is safe to poll.
Before Stage 0 this called the *destructive* `init()` (now renamed `prepare()`), which wipes `tmp/`
on every call; that method now runs exactly once, from `Application.start()`, never from a probe.
Cached 30 s.

## Graceful shutdown

SIGTERM/SIGINT → `app.close()` (in-flight uploads/downloads finish streaming) → flush the audit
forwarder → stop maintenance → close the database → exit. Force-exit 60 s; PM2 `kill_timeout`
65 000 ms (the longest of any service, to cover a large in-flight upload/download).

## Resource limits

`MAX_UPLOAD_BYTES` (default 26 214 400, ~25 MiB), `MAX_IMAGE_PIXELS` (sharp `limitInputPixels`,
checked before decoding). `max_memory_restart`: 600M (sharp decodes images in memory; the highest
memory ceiling of any service in the platform for exactly that reason).

## Timeouts

None of its own beyond Fastify/Node defaults for the streaming request/response bodies themselves;
uploads and downloads are expected to take as long as their size and the client's connection allow,
which is why `kill_timeout` here is the longest in the platform.

## Retry policy

None for uploads/downloads (client-driven, once). Deferred variant generation is not retried on
failure within a request — a failed encode surfaces as an error to that request; a later request
for the same variant tries again.

## Idempotency

Upload is naturally idempotent by content: two uploads of identical bytes dedupe to the same
`blobs` row (sha256), and `commit()` discards the redundant temp file rather than writing a second
copy. Upload tickets are single-use (a conditional `UPDATE`, not retried as if reusable). Delete is
soft (safe to repeat: a second delete of an already-deleted file is a no-op, not an error) and
restore likewise.

## Backup

The database (file metadata, ticket state) **and** the `objects`/`variants` directories together —
a database row pointing at a missing object file, or an orphaned object file with no row, are both
inconsistent states a mismatched backup can produce.

## Restore

Restore the database and the object-storage directory from the **same** snapshot. Restoring only
one half produces exactly the inconsistency named above.

## Metrics

`GET /metrics`: `media_files`, `media_blobs`, `media_stored_bytes` are computed from the database
at request time (durable). `media_uploads_total`, `media_downloads_total`,
`media_downloaded_bytes_total` are process-local counters since start, explicitly not durable.

## Logging

Fastify's default request logging (`requestIdHeader: 'x-request-id'`, accepted unconditionally —
internal service). Redacts `authorization`.

## Tracing

Accepts an inbound `X-Request-Id` unconditionally, logs it via Fastify's default request logging.
Does not parse or forward `traceparent`.

## Security model

API keys (`id:secret`, no roles). `SIGNING_SECRET` (HMAC over file id, variant, expiry) for signed
delivery URLs — no previous-secret grace: rotating it invalidates every outstanding signed URL
immediately, which the README states as a known consequence, not a bug. Upload tickets: 32 random
bytes, only their SHA-256 hash stored, single use, expire. MIME is sniffed from content (magic
bytes), never trusted from the client's declared type; images are re-encoded (stripping EXIF and
any other embedded metadata) rather than stored as received. Path components (sha256, variant name)
are regex-validated before touching the filesystem — no path traversal via a crafted id.

## Scaling model

**B — single-node stateful.** One process owns the SQLite file and the local object-storage
directory. Deferred variant generation uses a process-local `Map` to de-duplicate concurrent
requests for the *same* variant within one process (`MediaService.inflight`) — this is **not** a
multi-instance guarantee: two instances asked for the same missing variant at the same time would
both encode it, and both would `rename` their result into the same path (last write wins, wasted
CPU, not corruption — the file that lands is a valid encode either way).

## Single-node / multi-node guarantees

One process per data directory. Two instances pointed at the *same* `dataDir` are not supported:
besides the variant-generation duplication above, `prepare()` at startup wipes `tmp/`, which a
second instance starting later would do to the first instance's already-in-flight uploads.

## Known failure modes

- `/ready` (or any prior version of it) triggering `prepare()`'s destructive wipe: fixed in Stage 0
  — the readiness path is now non-destructive (`check()`); `prepare()` only ever runs once, at
  process start.
- Purge (`Maintenance`, deletes soft-deleted files past `DELETE_GRACE_DAYS`) racing a fresh upload
  of the same content: the object-store bytes for an orphaned blob are removed after the database
  row is deleted in the same transaction; a very tight race with a concurrent upload of identical
  content within that window is a known, narrow edge case, not yet closed (see
  `stack/docs/ARCHITECTURE_AUDIT.md` §3, media row, for the proposed fix — out of scope for this
  stage).
- Disk full mid-upload: the write fails, the temp file is not moved into place, the client sees an
  error; no partial object is left in `objects/`.
- Two instances sharing one `dataDir`: unsupported, see above — avoid.
