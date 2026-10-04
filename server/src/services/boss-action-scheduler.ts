import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { bossOperationPolicy } from './boss-operation-policy.js';
import { bossAutomationSafety } from './boss-automation-safety.js';

export type BossActionKind = 'control' | 'input' | 'navigation' | 'route' | 'feedback' | 'submit' | 'confirm';
interface ActionScope { signal?: AbortSignal; beforeAction?: () => Promise<void>; onWait?: (seconds: number, kind: BossActionKind) => void; }
interface Settings { intervalMs: number; burst: number; restMs: number; feedbackMs: number; maxPerMinute?: number; maxPerHour?: number; writesPerHour?: number; }
interface ActionState { blockedUntil: number; level: number; lastLimitAt: number; sequenceCount?: number; actionTimes?: number[]; writeTimes?: number[]; recentActions?: Array<{ time: number; kind: BossActionKind; result: 'ok' | 'error' }>; }
const scopes = new AsyncLocalStorage<ActionScope>();
const statePath = path.resolve(__dirname, '../../../data/boss-operation-state.json');

/** One queue for actual website actions across all tabs; passive DOM reads are not actions. */
export class BossActionScheduler {
  private tail: Promise<void> = Promise.resolve();
  private lastAt = 0;
  private lastKindAt = new Map<BossActionKind, number>();
  private lastWriteAt = 0;
  private count = 0;
  private blockedUntil = 0;
  private level = 0;
  private lastLimitAt = 0;
  private actionTimes: number[] = [];
  private writeTimes: number[] = [];
  private recentActions: NonNullable<ActionState['recentActions']> = [];
  constructor(private settings: () => Settings, private now = Date.now,
    private sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      signal?.throwIfAborted();
      const abort = () => { clearTimeout(timer); reject(signal?.reason || new Error('操作已停止')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
      signal?.addEventListener('abort', abort, { once: true });
    }), private persist?: (state: ActionState) => void, private onLimit?: (until: number, level: number) => void) {}
  public withScope<T>(scope: ActionScope, task: () => Promise<T>): Promise<T> { return scopes.run(scope, task); }
  public restore(state: any): void {
    const recent = (values: unknown) => Array.isArray(values) ? values.filter(value => Number.isFinite(value) && value > this.now() - 3600000 && value <= this.now()).sort((a, b) => a - b).slice(-1000) : [];
    this.actionTimes = recent(state?.actionTimes); this.writeTimes = recent(state?.writeTimes);
    this.lastAt = this.actionTimes.at(-1) || 0; this.lastWriteAt = this.writeTimes.at(-1) || 0;
    this.recentActions = Array.isArray(state?.recentActions) ? state.recentActions.filter((item: any) => Number.isFinite(item?.time)
      && ['control', 'input', 'navigation', 'route', 'feedback', 'submit', 'confirm'].includes(item.kind)
      && ['ok', 'error'].includes(item.result)).slice(-1000) : [];
    const restMs = this.settings().restMs;
    if (this.lastAt && this.now() - this.lastAt < restMs) {
      if (Number.isInteger(state?.sequenceCount) && state.sequenceCount >= 0) this.count = Math.min(1000, state.sequenceCount);
      else {
        // Migrate an old journal conservatively; do not refresh the session allowance on restart.
        for (let i = this.recentActions.length - 1; i >= 0; i--) {
          if (i < this.recentActions.length - 1 && this.recentActions[i + 1].time - this.recentActions[i].time >= restMs) break;
          this.count++;
        }
      }
    }
    if (Number.isFinite(state?.blockedUntil) && state.blockedUntil > this.now() && state.blockedUntil <= this.now() + 24 * 3600000) {
      this.blockedUntil = state.blockedUntil; this.level = Math.min(5, Math.max(1, Number(state.level) || 1));
      this.lastLimitAt = Math.max(0, Number(state.lastLimitAt) || 0);
    }
  }
  public limit(retryAfterMs = 0): void {
    const now = this.now();
    if (now - this.lastLimitAt < 1000 && this.lastLimitAt) return;
    this.level = now - this.lastLimitAt > 3600000 ? 1 : Math.min(5, this.level + 1);
    this.lastLimitAt = now;
    this.blockedUntil = Math.max(this.blockedUntil, now + Math.max(Math.min(900000, 60000 * 2 ** (this.level - 1)), Math.min(86400000, retryAfterMs)));
    this.save(); this.onLimit?.(this.blockedUntil, this.level);
  }
  private save(): void { this.persist?.({ blockedUntil: this.blockedUntil, level: this.level, lastLimitAt: this.lastLimitAt, sequenceCount: this.count, actionTimes: this.actionTimes, writeTimes: this.writeTimes, recentActions: this.recentActions }); }
  private budgetUntil(times: number[], limit: number | undefined, window: number, now: number): number {
    if (!limit || limit < 1) return 0;
    const recent = times.filter(time => time > now - window);
    return recent.length >= limit ? recent[recent.length - limit] + window : 0;
  }
  public status(): { remainingSeconds: number; level: number } { return { remainingSeconds: Math.max(0, Math.ceil((this.blockedUntil - this.now()) / 1000)), level: this.level }; }
  public run<T>(kind: BossActionKind, action: () => Promise<T>): Promise<T> {
    const scope = scopes.getStore();
    const work = this.tail.catch(() => {}).then(async () => {
      scope?.signal?.throwIfAborted(); await scope?.beforeAction?.();
      const settings = this.settings();
      let announced = false;
      while (true) {
        scope?.signal?.throwIfAborted(); await scope?.beforeAction?.();
        const now = this.now();
        this.actionTimes = this.actionTimes.filter(time => time > now - 3600000); this.writeTimes = this.writeTimes.filter(time => time > now - 3600000);
        if (this.lastAt && now - this.lastAt >= settings.restMs) this.count = 0;
        const writes = kind === 'feedback' || kind === 'submit';
        const kindGap = kind === 'navigation' ? settings.intervalMs * 3 : kind === 'route' ? settings.intervalMs * 5 : 0;
        const globalGap = kind === 'confirm' ? Math.min(600, settings.intervalMs) : settings.intervalMs;
        const budget = kind === 'confirm' ? 0 : Math.max(this.budgetUntil(this.actionTimes, settings.maxPerMinute, 60000, now),
          this.budgetUntil(this.actionTimes, settings.maxPerHour, 3600000, now), writes ? this.budgetUntil(this.writeTimes, settings.writesPerHour, 3600000, now) : 0);
        const until = Math.max(this.blockedUntil, this.lastAt ? this.lastAt + globalGap : 0,
          this.lastKindAt.has(kind) ? this.lastKindAt.get(kind)! + kindGap : 0,
          writes && this.lastWriteAt ? this.lastWriteAt + settings.feedbackMs : 0,
          kind !== 'confirm' && this.count >= settings.burst && this.lastAt ? this.lastAt + settings.restMs : 0, budget);
        const wait = Math.max(0, until - now);
        if (!wait) break;
        if (!announced && wait >= 1000) { scope?.onWait?.(Math.ceil(wait / 1000), kind); announced = true; }
        await this.sleep(Math.min(wait, 500), scope?.signal);
      }
      scope?.signal?.throwIfAborted(); await scope?.beforeAction?.();
      let result: 'ok' | 'error' = 'ok';
      try { return await action(); }
      catch (error) { result = 'error'; throw error; }
      finally {
        this.lastAt = this.now(); this.lastKindAt.set(kind, this.lastAt); this.count++;
        this.actionTimes.push(this.lastAt);
        this.recentActions.push({ time: this.lastAt, kind, result }); this.recentActions = this.recentActions.slice(-1000);
        if (kind === 'feedback' || kind === 'submit') { this.lastWriteAt = this.lastAt; this.writeTimes.push(this.lastAt); }
        this.save();
      }
    });
    this.tail = work.then(() => {}, () => {});
    return work;
  }
}
export const bossActionScheduler = new BossActionScheduler(() => bossOperationPolicy, Date.now, undefined, state => {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath + '.tmp', JSON.stringify(state), 'utf8'); fs.renameSync(statePath + '.tmp', statePath);
  } catch (error) {
    bossAutomationSafety.halt('state_unreadable', 'BOSS 操作节奏记录无法保存，已停止自动操作，请先修复本机记录'); throw error;
  }
}, (until) => { bossAutomationSafety.halt('rate_limit', 'BOSS 已明确限频，全部自动操作已停止；等待结束后仍需人工确认账号恢复', until); });
try { bossActionScheduler.restore(JSON.parse(fs.readFileSync(statePath, 'utf8'))); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') bossAutomationSafety.halt('state_unreadable', 'BOSS 操作节奏记录无法读取，已停止自动操作，请先修复本机记录');
}

/** Compatibility helper also accepts the existing test/browser adapters without a scheduler. */
export function runBossAction<T>(page: { action?: <R>(kind: BossActionKind, work: () => Promise<R>) => Promise<R> }, kind: BossActionKind, work: () => Promise<T>): Promise<T> {
  return page.action ? page.action(kind, work) : work();
}

/** Native click adapters recheck the target after waiting, immediately before the actual click. */
export async function clickBossAction(locator: { click: () => Promise<void>;
  clickAs?: (kind: BossActionKind, before?: () => Promise<void>) => Promise<void> },
  kind: BossActionKind, before?: () => Promise<void>): Promise<void> {
  if (locator.clickAs) return locator.clickAs(kind, before);
  await before?.(); await locator.click();
}
