import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from '../src/db.js';
import { ImageProcessor } from '../src/domain/image-processor.js';
import { MediaService } from '../src/domain/media-service.js';
import { Maintenance } from '../src/maintenance.js';
import { LocalStorage } from '../src/storage/local-storage.js';
import { FileStore } from '../src/store/file-store.js';
import { TicketStore } from '../src/store/ticket-store.js';
import { UrlSigner } from '../src/url-signer.js';
import { silentLog, streamOf, tempDir, testConfig } from './helpers.js';

/**
 * Post-production Phase 4, item 4: concurrent maintenance runs. `Maintenance#run`'s own
 * `this.running` coalescing is a same-process optimisation only — the real correctness guarantee
 * for two independent runs racing the same content is the DB compare-and-swap
 * (`FileStore#finalizeOrphanBlobs`) plus storage's atomic detach (`LocalStorage#detachForDelete`),
 * proven already in `purge-race.test.js`. This file proves that guarantee holds when it's not just
 * two calls in one process's event loop, but two genuinely independent `MediaService`/`Database`/
 * `LocalStorage` object graphs — the closest a single test process gets to "two separate media
 * processes" without literally spawning two, opening the SAME real SQLite file and the SAME real
 * data directory (a real one-process-per-Maintenance-instance separation, not shared in-memory state).
 */

/**
 * @param {string} dbPath @param {string} dataDir @param {{ prepareStorage?: boolean }} [o]
 */
async function buildInstance(dbPath, dataDir, { prepareStorage = false } = {}) {
  const config = testConfig({ DELETE_GRACE_DAYS: '0' });
  const db = new Database(dbPath);
  const files = new FileStore(db);
  const tickets = new TicketStore(db);
  const storage = prepareStorage ? await new LocalStorage(dataDir).prepare() : await new LocalStorage(dataDir).check();
  const clock = { now: Date.now() };
  const service = new MediaService({
    files, tickets, storage,
    images: new ImageProcessor({ maxPixels: config.maxImagePixels, quality: config.variantQuality }),
    signer: new UrlSigner(config.signingSecret, config.signingSecretPrevious),
    log: silentLog,
    options: {
      publicBaseUrl: config.publicBaseUrl, maxUploadBytes: config.maxUploadBytes, allowedTypes: config.allowedTypes, variants: config.variants,
      stripImageMetadata: config.stripImageMetadata, signedUrlTtlSec: config.signedUrlTtlSec, uploadTicketTtlSec: config.uploadTicketTtlSec,
      deleteGraceMs: config.deleteGraceDays * 86_400_000,
      maxConcurrentVariants: config.maxConcurrentVariants, variantWaitTimeoutMs: config.variantWaitTimeoutMs,
      trashGraceMs: config.trashGraceMs, trashMaxEntries: config.trashMaxEntries,
    },
    now: () => clock.now,
  });
  return { db, files, tickets, storage, service, clock };
}

test('manual trigger and a timer-triggered run overlapping in the same process coalesce onto one underlying purge, never run it twice concurrently', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const inst = await buildInstance(join(dir, 'media.db'), dir, { prepareStorage: true });
    const f = await inst.service.upload(streamOf('%PDF-1.4 x'), { apiKeyId: 'k', visibility: 'public' });
    inst.service.delete(f.id, 'k');
    inst.clock.now += 1;

    let concurrentPurges = 0;
    let maxConcurrent = 0;
    const realPurge = inst.service.purge.bind(inst.service);
    inst.service.purge = async () => {
      concurrentPurges++;
      maxConcurrent = Math.max(maxConcurrent, concurrentPurges);
      try {
        return await realPurge();
      } finally {
        concurrentPurges--;
      }
    };

    const m = new Maintenance({ service: inst.service, log: silentLog });
    const [manual, timer] = await Promise.all([m.run('manual'), m.run('timer')]);
    assert.equal(maxConcurrent, 1, 'the timer-triggered call coalesced onto the manual run\'s in-flight promise, never a second concurrent purge()');
    assert.deepEqual(manual, timer, 'both callers observe the exact same result — one run, shared');
    assert.equal(manual.blobs, 1);
    assert.equal(manual.errors, 0);
    inst.db.close();
  } finally {
    cleanup();
  }
});

test('two independent Maintenance/MediaService instances sharing the same real DB file and data directory never corrupt state or delete a live object, even racing purge() at once', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const dbPath = join(dir, 'media.db');
    const seed = await buildInstance(dbPath, dir, { prepareStorage: true });
    const live = await seed.service.upload(streamOf('%PDF-1.4 live-object'), { apiKeyId: 'k', visibility: 'public' });
    const orphaned = await seed.service.upload(streamOf('%PDF-1.4 soon-to-be-orphaned'), { apiKeyId: 'k', visibility: 'public' });
    seed.service.delete(orphaned.id, 'k');
    seed.clock.now += 1;
    seed.db.close();

    // Two genuinely separate object graphs, same real db file, same real data directory.
    const a = await buildInstance(dbPath, dir);
    const b = await buildInstance(dbPath, dir);
    a.clock.now = seed.clock.now;
    b.clock.now = seed.clock.now;

    const [ra, rb] = await Promise.all([
      new Maintenance({ service: a.service, log: silentLog }).run('manual'),
      new Maintenance({ service: b.service, log: silentLog }).run('manual'),
    ]);
    assert.equal(ra.errors, 0);
    assert.equal(rb.errors, 0);
    assert.equal(ra.blobs + rb.blobs, 1, 'the orphan is finalized by exactly one of the two racing instances, never both, never neither');

    const check = await buildInstance(dbPath, dir);
    assert.equal(check.service.get(live.id).deleted_at, null, 'INVARIANT: the live file survives two concurrent, cross-instance purge runs');
    assert.equal(await check.storage.exists({ kind: 'object', sha256: live.sha256 }), true, 'INVARIANT: the live object\'s bytes survive');
    assert.equal(await check.storage.exists({ kind: 'object', sha256: orphaned.sha256 }), false, 'the orphan\'s bytes are genuinely gone');

    a.db.close();
    b.db.close();
    check.db.close();
  } finally {
    cleanup();
  }
});
