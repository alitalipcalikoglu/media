/** A waiter timed out before a slot ever freed up. */
export class SemaphoreTimeoutError extends Error {
  constructor() {
    super('semaphore acquire timed out waiting for a free slot');
    this.name = 'SemaphoreTimeoutError';
  }
}

/** The wait queue itself is already at its bound; this request never started waiting at all. */
export class SemaphoreQueueFullError extends Error {
  constructor() {
    super('semaphore wait queue is full');
    this.name = 'SemaphoreQueueFullError';
  }
}

/**
 * Bounded concurrency gate: at most `limit` holders at once, and at most `maxQueue` more callers
 * waiting for a slot — never an unbounded wait queue. A waiter is bounded by whichever of
 * `timeoutMs` or `signal` (an `AbortSignal`, e.g. the HTTP request's own disconnect) fires first,
 * and is removed from the queue the instant either does — it is never left to wait forever, and
 * never left occupying a queue slot after it stops caring about the result.
 */
export class Semaphore {
  /**
   * @param {number} limit
   * @param {{ maxQueue?: number }} [o] `maxQueue` default: `limit * 4`.
   */
  constructor(limit, { maxQueue = limit * 4 } = {}) {
    this.limit = limit;
    this.maxQueue = maxQueue;
    this.active = 0;
    /** @type {{ resolve: () => void, reject: (err: unknown) => void }[]} */
    this.queue = [];
  }

  /**
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [o]
   * @returns {Promise<() => void>} Release function — must be called exactly once, whether the
   *   held work succeeds or throws (callers should use `try/finally`).
   */
  async acquire({ timeoutMs, signal } = {}) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
    if (this.active < this.limit) {
      this.active++;
      return () => this.#release();
    }
    if (this.queue.length >= this.maxQueue) throw new SemaphoreQueueFullError();
    return new Promise((resolvePromise, rejectPromise) => {
      /** @type {NodeJS.Timeout|undefined} */
      let timer;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const drop = () => {
        const i = this.queue.indexOf(entry);
        if (i !== -1) this.queue.splice(i, 1);
      };
      const onAbort = () => { drop(); cleanup(); rejectPromise(signal?.reason ?? new DOMException('aborted', 'AbortError')); };
      const entry = {
        resolve: () => { cleanup(); this.active++; resolvePromise(() => this.#release()); },
        reject: (/** @type {unknown} */ err) => { cleanup(); rejectPromise(err); },
      };
      if (signal) signal.addEventListener('abort', onAbort);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => { drop(); entry.reject(new SemaphoreTimeoutError()); }, timeoutMs);
        timer.unref?.();
      }
      this.queue.push(entry);
    });
  }

  #release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next.resolve();
  }
}
