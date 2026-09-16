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
    /** @type {Promise<void>|null} */
    this.running = null;
  }

  start() {
    if (this.timer) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), Maintenance.INTERVAL_MS);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  async run() {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const r = await this.service.purge();
        if (r.files || r.blobs || r.tickets) this.log.info(r, 'maintenance purged');
      } catch (err) {
        this.log.error({ err }, 'maintenance failed');
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }
}
