import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Maintenance } from '../src/maintenance.js';
import { silentLog, streamOf, testMediaService } from './helpers.js';

test('Maintenance runs purge, coalesces concurrent runs and stops cleanly', async () => {
  const t = await testMediaService({ DELETE_GRACE_DAYS: '0' });
  try {
    const f = await t.service.upload(streamOf('%PDF-1.4 x'), { apiKeyId: 'k' });
    t.service.delete(f.id, 'k');
    t.clock.now += 1;
    const m = new Maintenance({ service: t.service, log: silentLog });
    await Promise.all([m.run(), m.run()]);
    assert.equal(await t.storage.exists({ kind: 'object', sha256: f.sha256 }), false);
    m.start();
    await m.stop();
  } finally {
    t.cleanup();
  }
});
