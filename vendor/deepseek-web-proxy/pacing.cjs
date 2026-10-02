const { setTimeout: sleep } = require('node:timers/promises');

function requestInterval(value) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? 30 : Math.max(10, Math.min(300, Math.trunc(number)));
}

class WebRequestPacing {
  constructor(clock = { now: Date.now, sleep: (ms, signal) => sleep(ms, undefined, { signal }) }) {
    this.clock = clock; this.completedAt = undefined; this.cooldownUntil = 0;
  }
  get retryAfterSeconds() { return Math.max(0, Math.ceil((this.cooldownUntil - this.clock.now()) / 1000)); }
  coolDown(seconds) { this.cooldownUntil = Math.max(this.cooldownUntil, this.clock.now() + seconds * 1000); }
  async wait(interval, signal) {
    signal?.throwIfAborted();
    const delay = this.completedAt == null ? 0 : Math.max(0, this.completedAt + requestInterval(interval) * 1000 - this.clock.now());
    if (delay) await this.clock.sleep(delay, signal);
    signal?.throwIfAborted();
  }
  finished() { this.completedAt = this.clock.now(); }
}
module.exports = { WebRequestPacing, requestInterval };
