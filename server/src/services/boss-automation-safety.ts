import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type BossSafetyReason = 'user_reported_ban' | 'account_restricted' | 'verification' | 'rate_limit' | 'state_unreadable';
export interface BossSafetyHold { id: string; reason: BossSafetyReason; message: string; detectedAt: string; retryAfter?: string; }
export class BossAutomationBlockedError extends Error {
  readonly code = 'BOSS_AUTOMATION_BLOCKED';
  constructor(public readonly hold: BossSafetyHold) { super(hold.message); }
}
const priority: Record<BossSafetyReason, number> = { verification: 1, rate_limit: 2, account_restricted: 3, user_reported_ban: 4, state_unreadable: 5 };

/** A platform restriction requires a human decision; elapsed time and restarts never clear it. */
export class BossAutomationSafety {
  private hold: BossSafetyHold | null = null;
  constructor(private readonly file: string | null = path.resolve(__dirname, '../../../data/boss-automation-safety.json'), private readonly now = Date.now) {
    if (!file || !fs.existsSync(file)) return;
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.hold && (typeof state.hold.id !== 'string' || !Object.hasOwn(priority, state.hold.reason) || typeof state.hold.message !== 'string')) throw new Error('invalid state');
      this.hold = state.hold || null;
    } catch {
      this.hold = { id: randomUUID(), reason: 'state_unreadable', message: 'BOSS 自动操作停止记录无法读取，请先人工核对账号和本机记录', detectedAt: new Date(this.now()).toISOString() };
    }
  }
  public status(): { blocked: boolean; hold: BossSafetyHold | null } { return { blocked: !!this.hold, hold: this.hold ? { ...this.hold } : null }; }
  public assertAllowed(): void { if (this.hold) throw new BossAutomationBlockedError({ ...this.hold }); }
  public halt(reason: BossSafetyReason, message: string, retryAt?: number): BossSafetyHold {
    if (this.hold && priority[this.hold.reason] >= priority[reason]) {
      if (this.hold.reason === reason && retryAt && retryAt > Date.parse(this.hold.retryAfter || '1970-01-01')) {
        this.hold.retryAfter = new Date(retryAt).toISOString(); this.save();
      }
      return { ...this.hold };
    }
    this.hold = { id: randomUUID(), reason, message, detectedAt: new Date(this.now()).toISOString(),
      ...(retryAt && retryAt > this.now() ? { retryAfter: new Date(retryAt).toISOString() } : {}) };
    this.save(); return { ...this.hold };
  }
  public confirmRecovery(id: string): void {
    if (!this.hold) return;
    if (this.hold.id !== id) throw new Error('停止原因已变化，请重新查看当前状态');
    if (this.hold.reason === 'state_unreadable') throw new Error('请先修复停止记录，不允许忽略无法读取的状态');
    if (this.hold.retryAfter && Date.parse(this.hold.retryAfter) > this.now()) throw new Error('平台要求的等待时间尚未结束');
    const previous = this.hold;
    this.hold = null;
    try { this.save(); } catch (error) { this.hold = previous; throw error; }
  }
  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ hold: this.hold }), 'utf8');
    fs.renameSync(this.file + '.tmp', this.file);
  }
}
export const bossAutomationSafety = new BossAutomationSafety();

/** Only visible notices or a dedicated security page supply restriction evidence, never job descriptions. */
export function visibleBossRestriction(): { reason: 'account_restricted' | 'verification'; message: string } | null {
  const notices = [...document.querySelectorAll('.common-dialog, .dialog-wrap, .toast, .message, .error-tip, .geetest_popup, .geetest_radar_tip, [class*="security-check"]')]
    .filter(el => (el as HTMLElement).getClientRects().length > 0).map(el => (el as HTMLElement).innerText || '');
  const securityPage = /\/security-check\.html|\/web\/passport\/zp\/security\.html/.test(location.pathname);
  if (securityPage || location.pathname.startsWith('/web/user/')) notices.push((document.body?.innerText || '').slice(0, 3000));
  const text = notices.join('\n');
  if (/(?:你的|您的|当前|该)?(?:账号|帐号)(?:已被|已|被|因[^\n]{0,24})?(?:封禁|封停|冻结|限制使用|禁止使用)|账号异常.{0,20}(?:限制|停止使用)|无法继续使用BOSS|禁止登录/.test(text)) {
    return { reason: 'account_restricted', message: 'BOSS 显示账号限制，自动操作已停止；请通过平台人工核实或申诉' };
  }
  if (securityPage || /请完成安全验证|请进行安全验证/.test(text)
    || [...document.querySelectorAll('.geetest_popup, .geetest_radar_tip, [class*="security-check"]')].some(el => (el as HTMLElement).getClientRects().length > 0)) {
    return { reason: 'verification', message: 'BOSS 需要人工安全验证，自动操作已停止；验证完成后仍需主动确认恢复' };
  }
  return null;
}
