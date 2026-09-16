import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** SQLite connection with schema migrations applied on open. */
export class Database {
  /** @type {readonly string[]} */
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
  ];

  /** @param {string} path File path, or ":memory:". */
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    /** @readonly */
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  #migrate() {
    const { user_version: current } = /** @type {{ user_version: number }} */ (this.raw.prepare('PRAGMA user_version').get());
    for (let v = current; v < Database.MIGRATIONS.length; v++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(Database.MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /** @param {string} sql */
  prepare(sql) {
    return this.raw.prepare(sql);
  }

  /**
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  ping() {
    this.raw.prepare('SELECT 1').get();
  }

  close() {
    this.raw.close();
  }
}
