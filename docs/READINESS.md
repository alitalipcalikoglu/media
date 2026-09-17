# media readiness contract

## Purpose

Secure binary/media storage and delivery: raw streaming uploads, real MIME sniffing, image
normalisation with metadata stripped, sha256 content-addressed deduplication, signed URLs, browser
upload tickets, on-demand WebP variants, soft delete with a grace period. Bytes are reached only
through the `Storage` interface (`src/storage/storage.js`, Stage 8); `LocalStorage` is the only
implementation. Out of scope: an S3-compatible backend today (add a class implementing `Storage`;
not implemented — see the Stage 8 report for the real semantic gaps that would remain), malware
scanning, resumable/multipart uploads.

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

`MAX_CONCURRENT_VARIANTS` (default 4, Stage 8): bounds CPU-heavy on-demand variant generation,
process-wide — see README "Scaling model" for the two-layer (dedupe, then semaphore) semantics.
Bounded wait, bounded queue (`4×` the slot count): never an unbounded backlog of waiting requests.

## Timeouts

None of its own beyond Fastify/Node defaults for the streaming request/response bodies themselves;
uploads and downloads are expected to take as long as their size and the client's connection allow,
which is why `kill_timeout` here is the longest in the platform.

`VARIANT_WAIT_TIMEOUT_MS` (default 30s, Stage 8): the one exception — bounds how long a genuinely
new (non-deduped) variant generation waits for a free `MAX_CONCURRENT_VARIANTS` slot before
failing `503 VARIANT_BUSY`. Does not bound the generation itself once it has a slot, and does not
apply to a request that only deduped onto an already-running generation (nothing new to wait for a
slot on).

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
delivery URLs. Stage 8 adds `SIGNING_SECRET_PREVIOUS`: an optional rotation grace — verification
accepts a signature made with `current` or `previous`, signing only ever uses `current`, and an
unknown/tampered/expired signature still fails closed regardless of rotation state (see README
"Rotating SIGNING_SECRET" for the operational runbook). Comparison is `timingSafeEqual`, tried
against each configured secret in turn. Neither secret is ever logged or exposed via `/v1/info`.
Upload tickets: 32 random bytes, only their SHA-256 hash stored, single use, expire. MIME is
sniffed from content (magic bytes), never trusted from the client's declared type; images are
re-encoded (stripping EXIF and any other embedded metadata) rather than stored as received.

Every `Storage` key field (sha256, variant name, temp id) is validated against a strict character
allowlist before it ever reaches a path — enforced once, inside `LocalStorage`, behind the `Storage`
interface (Stage 8) rather than scattered across callers. A 64-hex-char sha256, a
`[a-z][a-z0-9-]{0,31}` variant name or a v4 UUID temp id cannot contain `/`, `..` or a null byte, so
there is no path-traversal, absolute-path or separator-injection surface to escape through; the
abstraction did not weaken this boundary, it only relocated it (`test/storage-contract.test.js`'s
traversal-rejection case, run against the same backend the rest of the contract suite exercises).

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
- **Purge racing a fresh upload of the same content: closed (Stage 8.1).** Previously an open, P0
  gap (planned but never actually implemented back at Stage 0) — a fresh upload of content whose
  blob row purge had just deleted, landing in the narrow window before the bytes were physically
  removed, could leave a live file referencing bytes that no longer existed. See "Purge/upload
  race protocol" below for the closed design and its guarantee.

## Purge/upload race protocol (Stage 8.1)

**Guarantee**: for every committed live file row, its referenced content-addressed object is
readable after every completed upload/purge operation, regardless of how the two interleave.
Enforced entirely through SQLite (compare-and-swap on a per-blob token), never a process-local
lock — correct even if maintenance and HTTP upload run in separate processes (not today's
supported topology, see "Single-node / multi-node guarantees" above, but the protocol doesn't
assume otherwise).

Blob deletion is two-phase, `FileStore#markOrphanBlobs()` then `FileStore#finalizeOrphanBlobs()`,
run as two separate, un-batched statements (deliberately not one transaction) so a concurrent
upload's own transaction has a real chance to land in between:

1. **Mark**: every blob row with no live file referencing it, and not already marked, gets a fresh
   `delete_token`. Nothing is deleted yet.
2. **Reclaim** (a concurrent upload, any time before finalize): `FileStore#createFile`'s blob
   upsert is `INSERT … ON CONFLICT (sha256) DO UPDATE SET delete_token = NULL` — touching a blob
   row for any reason, marked or not, always clears its token. This is the entire mechanism: an
   upload doesn't need to know purge is running at all.
3. **Finalize**: for every still-orphaned, currently-marked row (from this pass or an earlier one
   that crashed before finalizing), `DELETE … WHERE sha256 = ? AND delete_token = ?` — the
   compare-and-swap. A token cleared by a reclaim between mark and finalize makes this match zero
   rows: the row, and therefore the bytes, survive. Only a row this DELETE actually removed is
   safe to physically remove — by that point nothing can "un-delete" it; a fresh upload of the
   same content afterward starts an entirely new row.
4. **Physical removal**, per confirmed sha256, after finalize — never before. A failure here
   (`storage.remove()` throwing) is caught per item, logged, and never aborts the rest of the
   batch or re-throws out of `purge()`: the DB row is already gone for good either way.

**Upload-side self-heal** closes the one remaining gap the two-phase delete alone can't: if
`storage.commit()` deduped (the content already existed) but a stale purge finalized-and-removed
those exact bytes in the narrow window before `createFile()`'s row lands, `MediaService.upload`
re-checks `storage.exists()` after its DB write and, if the object is genuinely gone, `commit()`s
again from its own still-held temp copy (bounded to `MediaService.SELF_HEAL_ATTEMPTS`, never an
unbounded retry). `commit()`'s `link()`-based atomicity (Stage 8) makes this safe to retry.

**Crash semantics**: a crash after mark but before finalize leaves the mark in place — the next
maintenance pass's finalize (not just this one) re-scans and picks it up, no special recovery
step needed. A crash after finalize (row deleted) but before the physical unlink leaks the bytes
on disk permanently in this build (no live reference exists, so this is disk bloat, not a
correctness violation) — accepted, matches the project's existing "orphan bytes may remain, a
future stage may add a disk-vs-DB reconciliation sweep" stance. A live DB reference to
permanently-missing bytes is what's actually forbidden, and no crash window produces it.

Test coverage: `test/purge-race.test.js` (real `MediaService` + real SQLite + real `LocalStorage`,
the exact interleaving from the original bug report, both crash windows, `storage.remove()`
throwing, idempotent re-maintenance, and that an unrelated purge never touches a live file's
object or its cached variants).
- Disk full mid-upload: the write fails, the temp file is not moved into place, the client sees an
  error; no partial object is left in `objects/`.
- Two instances sharing one `dataDir`: unsupported, see above — avoid.
