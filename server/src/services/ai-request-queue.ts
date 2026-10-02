export interface QueueClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Shared by webpage calls from delivery, resume tools and connection tests. */
export class AiRequestQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private completedAt: number | undefined;
  private cooldownUntil = 0;

  constructor(private clock: QueueClock = { now: Date.now, sleep: abortableSleep }) {}

  public coolDown(seconds: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.clock.now() + seconds * 1000);
  }

  public run<T>(intervalSeconds: number, operation: () => Promise<T>, options: {
    signal?: AbortSignal; onWait?: (seconds: number) => void;
  } = {}): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const queued = this.tail.catch(() => {}).then(async () => {
      options.signal?.throwIfAborted();
      const cooling = this.cooldownUntil - this.clock.now();
      if (cooling > 0) throw new Error('DeepSeek 网页正在冷却，还需 ' + Math.ceil(cooling / 1000) + ' 秒，请稍后恢复任务');
      const delay = this.completedAt === undefined ? 0
        : Math.max(0, this.completedAt + intervalSeconds * 1000 - this.clock.now());
      if (delay > 0) {
        options.onWait?.(Math.ceil(delay / 1000));
        await this.clock.sleep(delay, options.signal);
      }
      options.signal?.throwIfAborted();
      try { return await operation(); }
      finally { this.completedAt = this.clock.now(); }
    });
    this.tail = queued;
    if (!options.signal) return queued;
    const signal = options.signal;
    // A cancelled caller need not wait for somebody else's active webpage request.
    return new Promise<T>((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      queued.then((value) => { signal.removeEventListener('abort', abort); resolve(value); },
        (error) => { signal.removeEventListener('abort', abort); reject(error); });
      if (signal.aborted) abort();
    });
  }
}
