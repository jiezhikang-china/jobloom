import { FollowupStore } from './followup-store.js';
import { decideFollowup, inFollowupWindow, shanghaiDay } from './followup-policy.js';
import type { ChatSnapshot, FollowupContact } from './followup-types.js';
import { FollowupNotSubmittedError } from './followup-types.js';

export interface FollowupAdapter {
  read(contact: FollowupContact, signal: AbortSignal): Promise<ChatSnapshot>;
  send(contact: FollowupContact, text: string, before: ChatSnapshot, signal: AbortSignal): Promise<ChatSnapshot>;
}
export interface FollowupDependencies {
  adapter: FollowupAdapter; ready: () => Promise<void>; busy: () => boolean;
  acquire: () => () => void; scope: (signal: AbortSignal, task: () => Promise<void>) => Promise<void>;
  rest: (signal: AbortSignal) => Promise<void>; now?: () => number;
}
export class FollowupEngine {
  private timer?: NodeJS.Timeout;
  private controller?: AbortController;
  private active = false;
  private message = '尚未开始沟通监控';
  private lastCheckedAt?: number;
  constructor(public readonly store: FollowupStore, private readonly deps: FollowupDependencies) {}
  status() { return { active: this.active, busy: Boolean(this.controller), message: this.store.error() || this.message,
    lastCheckedAt: this.lastCheckedAt, ...this.store.snapshot() }; }
  configure(value: unknown): void { if (this.controller || this.active) throw new Error('请停止监控后修改设置'); this.store.settings(value); if (!this.store.snapshot().settings.enabled) this.stop(); }
  start(): void {
    if (this.store.error()) throw new Error(this.store.error());
    if (!this.store.snapshot().settings.enabled) throw new Error('请先启用自动跟进并保存设置');
    this.active = true; this.message = '正在监控沟通'; this.schedule(); void this.tick().catch(() => {});
  }
  stop(): void { this.active = false; clearTimeout(this.timer); this.controller?.abort(new Error('沟通监控已停止')); this.message = '沟通监控已停止'; }
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.active) this.timer = setTimeout(() => { void this.tick().finally(() => this.schedule()).catch(() => {}); }, this.store.snapshot().settings.pollMinutes * 60000).unref();
  }
  async tick(readOnly = false): Promise<void> {
    if (this.controller) throw new Error('正在核对会话，请稍候');
    if (!readOnly && !this.active) return;
    if (this.deps.busy()) { this.message = '等待当前 BOSS 操作完成'; return; }
    const settings = this.store.snapshot().settings;
    // Avoid opening and walking every conversation overnight.
    if (!readOnly && !inFollowupWindow(settings, (this.deps.now || Date.now)())) { this.message = '当前在发送时段外，等待下一窗口'; return; }
    const contacts = this.store.snapshot().contacts.filter(c => c.status !== 'closed');
    if (!contacts.length) { this.message = '暂无已投递沟通记录，新投递成功后会自动加入'; return; }
    const release = this.deps.acquire(), controller = new AbortController(); this.controller = controller;
    const now = this.deps.now || Date.now;
    let sent = 0, checked = 0, skipped = 0, reachedLimit = false, lastReadError = '';
    try {
      await this.deps.scope(controller.signal, async () => {
        await this.deps.ready();
        for (const initial of contacts) {
          controller.signal.throwIfAborted(); await this.deps.rest(controller.signal); controller.signal.throwIfAborted();
          this.message = '正在核对：' + initial.companyName + ' · ' + initial.jobName;
          let before: ChatSnapshot;
          try { before = await this.deps.adapter.read(initial, controller.signal); }
          catch (error) {
            controller.signal.throwIfAborted(); await this.deps.ready();
            skipped++; lastReadError = (error as Error).message;
            this.store.update(initial.id, c => { c.nextStep = (error as Error).message; }); continue;
          }
          this.store.ingest(initial.id, before, now()); checked++;
          const contact = this.store.snapshot().contacts.find(c => c.id === initial.id)!;
          const decision = decideFollowup(contact, settings, now());
          if (decision.close || decision.nextStep) this.store.update(contact.id, c => {
            c.nextStep = decision.nextStep; if (decision.close) c.status = 'closed'; else c.status = 'needs_user';
          });
          if (readOnly || !this.active || !decision.action || !inFollowupWindow(settings, now())) continue;
          const used = this.store.snapshot().contacts.flatMap(c => c.actions).filter(a => ['sent', 'sending', 'uncertain'].includes(a.state)
            && shanghaiDay(a.attemptedAt || a.sentAt || a.createdAt) === shanghaiDay(now())).length;
          if (used >= settings.dailyMaxMessages) { reachedLimit = true; break; }
          // Discard leftover queued drafts on restart; recompute against fresh incoming messages.
          const action = this.store.queue(contact.id, decision.action, now());
          controller.signal.throwIfAborted(); await this.deps.ready();
          this.store.update(contact.id, c => { const a = c.actions.find(a => a.id === action.id)!;
            a.state = 'sending'; a.attemptedAt = now(); a.outgoingBefore = before.messages.filter(m => m.direction === 'outgoing').map(m => m.id); });
          try {
            const after = await this.deps.adapter.send(contact, action.text, before, controller.signal);
            this.store.ingest(contact.id, after, now());
            const recorded = this.store.snapshot().contacts.find(c => c.id === contact.id)!.actions.find(a => a.id === action.id)!;
            if (recorded.state !== 'sent') throw new Error('未读到可靠的发送回执');
            sent++;
          } catch (error) {
            this.store.update(contact.id, c => { const a = c.actions.find(a => a.id === action.id)!;
              if (a.state !== 'sent') {
                a.state = error instanceof FollowupNotSubmittedError ? 'cancelled' : 'uncertain'; a.error = (error as Error).message;
                c.status = error instanceof FollowupNotSubmittedError ? 'waiting' : 'uncertain'; c.nextStep = (error as Error).message;
              } });
            if (error instanceof FollowupNotSubmittedError && error.retryNextScan) continue;
            throw error;
          }
        }
      });
      if (!checked && skipped) throw new Error('本轮未能读取会话：' + lastReadError);
      this.lastCheckedAt = now(); this.message = '本轮已核对 ' + checked + ' 个会话，发送 ' + sent + ' 条消息'
        + (skipped ? '；' + skipped + ' 个会话读取失败，请查看台账' : '') + (reachedLimit ? '；今日消息已达到上限' : '');
    } catch (error) {
      this.message = (error as Error).message; this.active = false; clearTimeout(this.timer);
      if (readOnly) throw error;
    } finally { this.controller = undefined; release(); }
  }
  closeContact(id: string): void { if (this.controller) throw new Error('正在核对会话，请稍后操作'); this.store.update(id, c => { c.status = 'closed'; c.nextStep = '用户结束跟进'; }); }
}
