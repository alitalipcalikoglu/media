import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FileStore } from '../src/store/file-store.js';
import { TicketStore } from '../src/store/ticket-store.js';
import { testDb } from './helpers.js';

const blob = (/** @type {string} */ sha, size = 10) => ({ sha256: sha, size, mime: 'image/png', width: 1, height: 1 });
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

test('FileStore shares blobs between files, soft-deletes, purges and reports orphans', () => {
  const files = new FileStore(testDb());
  const f1 = files.createFile({ apiKeyId: 'k', blob: blob(SHA_A), name: 'a.png', visibility: 'public' }, 1000);
  const f2 = files.createFile({ apiKeyId: 'k', blob: blob(SHA_A), name: 'copy.png', visibility: 'private' }, 2000);
  const f3 = files.createFile({ apiKeyId: 'other', blob: blob(SHA_B, 20), name: 'b.png', visibility: 'public' }, 3000);
  assert.equal(f1.sha256, SHA_A);
  assert.equal(f1.mime, 'image/png');
  assert.deepEqual({ ...files.stats() }, { files: 3, blobs: 2, bytes: 30 });
  assert.deepEqual(files.list({ apiKeyId: 'k', limit: 10 }).map((f) => f.id), [f2.id, f1.id]);
  assert.deepEqual(files.list({ apiKeyId: 'k', limit: 10, before: { createdAt: f2.created_at, id: f2.id } }).map((f) => f.id), [f1.id]);

  assert.equal(files.update(f1.id, 'k', { visibility: 'private', name: 'renamed.png' }), true);
  assert.equal(files.byId(f1.id)?.visibility, 'private');
  assert.equal(files.byId(f1.id)?.name, 'renamed.png');
  assert.equal(files.update(f1.id, 'other', { visibility: 'public' }), false, 'owner scoped');

  assert.equal(files.softDelete(f1.id, 'other', 5000), false);
  assert.equal(files.softDelete(f1.id, 'k', 5000), true);
  assert.equal(files.softDelete(f1.id, 'k', 5000), false);
  assert.equal(files.byId(f1.id)?.deleted_at, 5000);
  assert.equal(files.list({ apiKeyId: 'k', limit: 10 }).length, 1);
  assert.equal(files.restore(f1.id, 'k'), true);
  assert.equal(files.softDelete(f1.id, 'k', 5000), true);

  assert.deepEqual(files.purge(5000), { files: 0, orphanBlobs: [] }, 'not strictly before');
  assert.deepEqual(files.purge(5001), { files: 1, orphanBlobs: [] }, 'blob still referenced by f2');
  assert.equal(files.byId(f1.id), undefined);
  files.softDelete(f2.id, 'k', 6000);
  files.softDelete(f3.id, 'other', 6000);
  const purged = files.purge(7000);
  assert.equal(purged.files, 2);
  assert.deepEqual(purged.orphanBlobs.sort(), [SHA_A, SHA_B]);
  assert.equal(files.blob(SHA_A), undefined);
  assert.deepEqual({ ...files.stats() }, { files: 0, blobs: 0, bytes: 0 });
});

test('TicketStore claims once, can release on failure and purges expired', () => {
  const tickets = new TicketStore(testDb());
  const { token, expiresAt } = tickets.create({ apiKeyId: 'k', visibility: 'private', maxBytes: 100, allowedTypes: ['image/png'], name: null, ttlMs: 1000 }, 0);
  assert.equal(expiresAt, 1000);
  assert.equal(TicketStore.looksValid(token), true);
  assert.equal(tickets.claim(token, 1000), undefined, 'expired at boundary');
  const t = tickets.claim(token, 10);
  assert.equal(t?.api_key_id, 'k');
  assert.deepEqual(JSON.parse(t?.allowed_types ?? ''), ['image/png']);
  assert.equal(tickets.claim(token, 10), undefined, 'single use');
  tickets.release(token);
  assert.ok(tickets.claim(token, 20), 'usable again after release');
  tickets.complete(token, 'file-1');
  tickets.release(token);
  assert.equal(tickets.claim(token, 30), undefined, 'completed tickets cannot be released');
  assert.equal(tickets.claim('garbage', 0), undefined);
  assert.equal(tickets.purge(999), 0);
  assert.equal(tickets.purge(1001), 1);
});
