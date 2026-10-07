import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-json.js';
import { bossActionScheduler } from './boss-action-scheduler.js';
import { browserService } from './browser.service.js';
import { bossOperationPolicy } from './boss-operation-policy.js';
import { bossAutomationSafety } from './boss-automation-safety.js';

interface RestState { closedAt?: number; resumeAt?: number; }
interface RestDependencies {
  needsRest: () => boolean;
  durationMs: number;
  close: () => Promise<boolean>;
  open: (signal?: AbortSignal) => Promise<void>;
  complete: () => void;
  assertAllowed: () => void;
  persist: (state: RestState | null) => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
interface RestOptions {
  signal?: AbortSignal;
  beforeResume?: () => Promise<void>;
  onState?: (stage: 'closing' | 'closed' | 'opening' | 'finished', remainingSeconds: number) => void;
}
const abortableSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal?.reason || new Error('任务已停止')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

/** A scheduled rest is distinct from platform restrictions and from short interaction delays. */
export class BossSessionRest {
  private state: RestState | null = null;
  private running = false;
  private readonly now: () => number;
  private readonly sleep: NonNullable<RestDependencies['sleep']>;
  constructor(private readonly deps: RestDependencies) { this.now = deps.now || Date.now; this.sleep = deps.sleep || abortableSleep; }
  public restore(value: unknown): void {
    if (value === null || value === undefined) { this.state = null; return; }
    const item = value as RestState;
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || (item.closedAt !== undefined && (!Number.isFinite(item.closedAt) || !Number.isFinite(item.resumeAt)
        || item.resumeAt! <= item.closedAt || item.resumeAt! - item.closedAt > 24 * 3600000))
      || (item.closedAt === undefined && item.resumeAt !== undefined)) throw new Error('浏览器休息记录无法读取');
    this.state = { ...(item.closedAt !== undefined ? { closedAt: item.closedAt, resumeAt: item.resumeAt } : {}) };
  }
  public due(): boolean { return Boolean(this.state || this.deps.needsRest()); }
  public async runIfDue(options: RestOptions = {}): Promise<boolean> {
    if (!this.due()) return false;
    if (this.running) throw new Error('浏览器休息已经在执行');
    this.running = true;
    const check = () => { options.signal?.throwIfAborted(); this.deps.assertAllowed(); };
    try {
      check(); await options.beforeResume?.(); check();
      if (!this.state) { this.state = {}; this.deps.persist(this.state); }
      options.onState?.('closing', 0);
      const hadBrowser = await this.deps.close();
      check();
      // A browser reopened by another actor invalidates an earlier closed-browser interval.
      if (hadBrowser || this.state.resumeAt === undefined) {
        const closedAt = this.now();
        this.state = { closedAt, resumeAt: closedAt + this.deps.durationMs };
        this.deps.persist(this.state);
      }
      while (this.now() < this.state.resumeAt!) {
        check();
        const remaining = this.state.resumeAt! - this.now();
        options.onState?.('closed', Math.ceil(remaining / 1000));
        await this.sleep(Math.min(500, remaining), options.signal);
      }
      check(); await options.beforeResume?.(); check();
      options.onState?.('opening', 0);
      await this.deps.open(options.signal);
      check();
      this.deps.complete();
      this.deps.persist(null); this.state = null;
      options.onState?.('finished', 0);
      return true;
    } finally { this.running = false; }
  }
}
const stateFile = path.resolve(__dirname, '../../../data/boss-session-rest.json');
export const bossSessionRest = new BossSessionRest({
  needsRest: () => bossActionScheduler.needsBusinessRest(), durationMs: bossOperationPolicy.restMs,
  close: () => browserService.suspendForRest(), open: signal => browserService.resumeAfterRest(signal),
  complete: () => bossActionScheduler.completeBusinessRest(), assertAllowed: () => bossAutomationSafety.assertAllowed(),
  persist: state => {
    try { writeJsonAtomic(stateFile, { rest: state }); }
    catch (error) { bossAutomationSafety.halt('state_unreadable', 'BOSS 浏览器休息记录无法保存，自动操作已停止'); throw error; }
  },
});
try {
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!state || !Object.hasOwn(state, 'rest')) throw new Error('invalid rest state');
    bossSessionRest.restore(state.rest);
  }
}
catch { bossAutomationSafety.halt('state_unreadable', 'BOSS 浏览器休息记录无法读取，自动操作已停止，请先核对本机记录'); }