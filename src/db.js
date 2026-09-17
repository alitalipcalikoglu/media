import { Database as CoreDatabase } from '@atc-web/service-core/db';

/** SQLite connection with schema migrations applied on open. */
export class Database extends CoreDatabase {
  static MIGRATIONS = [
    `
    CREATE TABLE blobs (
      sha256     TEXT PRIMARY KEY,
      size       INTEGER NOT NULL,
      mime       TEXT NOT NULL,
      width      INTEGER,
      height     INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE files (
      id          TEXT PRIMARY KEY,
      api_key_id  TEXT NOT NULL,
      blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
      name        TEXT NOT NULL,
      visibility  TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
      created_at  INTEGER NOT NULL,
      deleted_at  INTEGER
    );
    CREATE INDEX files_owner ON files (api_key_id, created_at DESC, id DESC);
    CREATE INDEX files_blob ON files (blob_sha256);
    CREATE INDEX files_deleted ON files (deleted_at);

    CREATE TABLE upload_tickets (
      token_hash    TEXT PRIMARY KEY,
      api_key_id    TEXT NOT NULL,
      visibility    TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
      max_bytes     INTEGER NOT NULL,
      allowed_types TEXT,
      name          TEXT,
      expires_at    INTEGER NOT NULL,
      used_at       INTEGER,
      file_id       TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX upload_tickets_expiry ON upload_tickets (expires_at);
    `,
    `
    -- Stage 8.1: closes the purge-vs-concurrent-upload-of-the-same-content race (P0, see
    -- IMPLEMENTATION_PLAN.md Stage 0 — planned there, never actually implemented). A blob row is
    -- never deleted outright the moment it's found orphaned; it's first marked with a token
    -- (two-phase: mark, then a later/separate finalize re-confirms via compare-and-swap on this
    -- same token before the row — and only then the bytes — are actually removed). Any upload
    -- that references this sha256 again before finalize runs clears the token back to NULL
    -- (FileStore#createFile's blob upsert), which finalize's CAS then detects as "reclaimed,"
    -- skipping deletion. See docs/READINESS.md "Purge/upload race" for the full protocol.
    ALTER TABLE blobs ADD COLUMN delete_token TEXT;
    CREATE INDEX blobs_delete_token ON blobs (delete_token) WHERE delete_token IS NOT NULL;
    `,
  ];
}
