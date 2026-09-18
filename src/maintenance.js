/** @typedef {{ files: number, blobs: number, tickets: number, trashReconciled: number, trashSkipped: number, trashErrors: number }} PurgeResult */
/** @typedef {PurgeResult & { errors: number }} MaintenanceResult errors: 1 when purge() itself threw (never happens today — purge() contains its own failures — kept so a caller never has to guess whether a result reflects a real run). */

/** Periodic purge of soft-deleted files past the grace period, orphaned blobs and expired tickets. */
export class Maintenance {
  static INTERVAL_MS = 3_600_000;

  /**
   * @param {{ service: import('./domain/media-service.js').MediaService, log: import('./types.js').Logger }} deps
   */
  constructor({ service, log }) {
    this.service = service;
    this.log = log;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** @type {Promise<MaintenanceResult>|null} */
    this.running = null;
  }

  start() {
    if (this.timer) return;
    void this.run('startup');
    this.timer = setInterval(() => void this.run('timer'), Maintenance.INTERVAL_MS);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /**
   * Runs the real production purge path — never a second implementation — regardless of what
   * triggered it. Concurrent callers within this same process coalesce onto the one in-flight run
   * rather than starting a second (a plain optimisation against redundant same-process work, not a
   * correctness primitive: two separate processes calling `purge()` at once are already made safe
   * by the DB compare-and-swap and storage fencing `purge()` itself relies on — see
   * docs/READINESS.md "Purge/upload race").
   *
   * Never rejects: a real failure inside `purge()` is caught, logged, and reported back as
   * `{ ..., errors: 1 }` rather than thrown, so a `void this.run('timer')` call from `setInterval`
   * can never produce an unhandled rejection. A `'manual'` trigger always logs its result (an
   * operator waiting on this run needs to see it happened, even when there was nothing to do); a
   * `'startup'`/`'timer'` trigger only logs when something actually happened, unchanged from
   * before, to keep routine runs quiet.
   * @param {'startup'|'timer'|'manual'} [trigger]
   * @returns {Promise<MaintenanceResult>}
   */
  async run(trigger = 'manual') {
    if (this.running) return this.running;
    const startedAt = Date.now();
    this.running = (async () => {
      try {
        const r = await this.service.purge();
        const durationMs = Date.now() - startedAt;
        if (trigger === 'manual' || r.files || r.blobs || r.tickets || r.trashReconciled || r.trashErrors) {
          this.log.info({ trigger, durationMs, ...r }, 'maintenance run');
        }
        return { ...r, errors: 0 };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        this.log.error({ trigger, durationMs, err }, 'maintenance failed');
        return { files: 0, blobs: 0, tickets: 0, trashReconciled: 0, trashSkipped: 0, trashErrors: 0, errors: 1 };
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }
}
