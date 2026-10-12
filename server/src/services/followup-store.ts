import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './atomic-json.js';
import { normalizeFollowupSettings, type FollowupState, type FollowupContact, type FollowupAction, type ChatSnapshot } from './followup-types.js';
import type { WorkRequirement, WorkRequirementAssessment } from '../types.js';
import type { BossJobItem } from '../types.js';
import { assessWorkRequirements } from './work-requirements.js';

export function canonicalFollowupJob(href: string): string {
  const url = new URL(href, 'https://www.zhipin.com');
  if (url.origin !== 'https://www.zhipin.com' || !/^\/job_detail\/[a-zA-Z0-9_-]+\.html$/.test(url.pathname)) throw new Error('请使用有效的 BOSS 职位详情链接');
  return url.origin + url.pathname;
}
function validContact(c: FollowupContact): boolean {
  const text = (v: unknown) => typeof v === 'string' && v.length > 0;
  const time = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  return Boolean(c && text(c.id) && /^[a-f0-9]{24}$/.test(c.id) && text(c.jobName) && text(c.companyName)
    && canonicalFollowupJob(c.jobHref) === c.jobHref && c.id === createHash('sha256').update(c.jobHref).digest('hex').slice(0, 24)
    && time(c.contactedAt) && time(c.lastOutgoingAt) && time(c.updatedAt)
    && (c.lastIncomingAt === undefined || time(c.lastIncomingAt))
    && (c.conversationId === undefined || text(c.conversationId))
    && ['waiting', 'replied', 'needs_user', 'closed', 'uncertain'].includes(c.status)
    && Array.isArray(c.requirements) && c.requirements.every(r => text(r.id) && text(r.text) && typeof r.enabled === 'boolean' && (r.policy === undefined || ['required', 'ask', 'preference'].includes(r.policy)))
    && Array.isArray(c.assessment) && c.assessment.every(a => text(a.requirementId) && text(a.text) && typeof a.evidence === 'string' && ['met', 'not_met', 'unknown'].includes(a.status))
    && Array.isArray(c.messages) && c.messages.every(m => text(m.id) && typeof m.text === 'string' && ['incoming', 'outgoing'].includes(m.direction)
      && (m.confirmed === undefined || typeof m.confirmed === 'boolean') && (m.timestamp === undefined || time(m.timestamp)))
    && new Set(c.messages.map(m => m.id)).size === c.messages.length
    && Array.isArray(c.actions) && c.actions.every(a => text(a.id) && text(a.text) && text(a.basis) && text(a.conversationId)
      && ['followup', 'conditions', 'fact'].includes(a.kind) && ['queued', 'sending', 'sent', 'uncertain', 'cancelled'].includes(a.state)
      && time(a.createdAt) && (a.attemptedAt === undefined || time(a.attemptedAt)) && (a.sentAt === undefined || time(a.sentAt))
      && (a.outgoingBefore === undefined || (Array.isArray(a.outgoingBefore) && a.outgoingBefore.every(text))))
    && new Set(c.actions.map(a => a.id)).size === c.actions.length);
}
export class FollowupStore {
  private state: FollowupState = { version: 1, settings: normalizeFollowupSettings({}), contacts: [] };
  private loadError = '';
  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as FollowupState;
      if (data.version !== 1 || !Array.isArray(data.contacts) || data.contacts.some(c => !validContact(c))
        || new Set(data.contacts.map(c => c.id)).size !== data.contacts.length
        || (data.accountId !== undefined && (typeof data.accountId !== 'string' || !data.accountId))) throw new Error('台账格式错误');
      const settings = normalizeFollowupSettings(data.settings);
      if (!data.settings || Object.entries(settings).some(([key, value]) => JSON.stringify((data.settings as any)[key]) !== JSON.stringify(value))) throw new Error('台账设置格式错误');
      this.state = { ...data, settings };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.loadError = '沟通台账无法读取，已停止跟进，请保留原文件并修复：' + (error as Error).message; }
  }
  error(): string { return this.loadError; }
  snapshot(): FollowupState { return structuredClone(this.state); }
  private change(fn: (state: FollowupState) => void): void {
    if (this.loadError) throw new Error(this.loadError);
    const next = this.snapshot(); fn(next);
    if (this.file) writeJsonAtomic(this.file, next);
    this.state = next;
  }
  settings(value: unknown): void { const settings = normalizeFollowupSettings(value); this.change(state => { state.settings = settings; }); }
  recordContact(target: { jobHref: string; jobName: string; companyName: string }, requirements: WorkRequirement[] = [], assessment: WorkRequirementAssessment[] = [], now = Date.now()): string {
    const jobHref = canonicalFollowupJob(target.jobHref), id = createHash('sha256').update(jobHref).digest('hex').slice(0, 24);
    this.change(state => {
      if (state.contacts.some(c => c.id === id)) return;
      state.contacts.unshift({ id, jobHref, jobName: target.jobName, companyName: target.companyName, contactedAt: now, lastOutgoingAt: now,
        status: 'waiting', requirements: structuredClone(requirements.filter(r => r.enabled)), assessment: structuredClone(assessment), messages: [], actions: [], updatedAt: now });
    });
    return id;
  }
  update(id: string, fn: (contact: FollowupContact, state: FollowupState) => void): void {
    this.change(state => { const contact = state.contacts.find(c => c.id === id); if (!contact) throw new Error('沟通记录不存在'); fn(contact, state); contact.updatedAt = Date.now(); });
  }
  ingest(id: string, snapshot: ChatSnapshot, now: number): void {
    this.update(id, (contact, state) => {
      if (!snapshot.accountId || (state.accountId && state.accountId !== snapshot.accountId)) throw new Error('当前 BOSS 账号与沟通台账不一致，未发送消息');
      state.accountId = snapshot.accountId;
      if (canonicalFollowupJob(snapshot.jobHref) !== contact.jobHref || (contact.conversationId && contact.conversationId !== snapshot.conversationId)) throw new Error('会话与岗位不一致，未发送消息');
      contact.conversationId = snapshot.conversationId;
      const oldIds = new Set(contact.messages.map(m => m.id));
      const added = snapshot.messages.filter(m => !oldIds.has(m.id));
      const hadHistory = contact.messages.length > 0;
      contact.messages = snapshot.messages.slice(-300);
      for (const action of contact.actions.filter(a => a.state === 'queued')) action.state = 'cancelled';
      const messageTime = (m: ChatSnapshot['messages'][number]) => m.timestamp && m.timestamp <= now ? m.timestamp : now;
      if (added.some(m => m.direction === 'incoming')) contact.lastIncomingAt = Math.max(contact.lastIncomingAt || 0, ...added.filter(m => m.direction === 'incoming').map(messageTime));
      const outgoing = added.filter(m => m.direction === 'outgoing' && m.confirmed === true);
      if (hadHistory && outgoing.length) contact.lastOutgoingAt = Math.max(contact.lastOutgoingAt, ...outgoing.map(messageTime));
      else if (outgoing.some(m => m.timestamp && m.timestamp <= now)) contact.lastOutgoingAt = Math.max(contact.lastOutgoingAt, ...outgoing.filter(m => m.timestamp && m.timestamp <= now).map(m => m.timestamp!));
      if (snapshot.messages.at(-1)?.direction === 'incoming') {
        const lastOutgoing = snapshot.messages.map(m => m.direction).lastIndexOf('outgoing');
        // Questions and quotations of our desired conditions are not employer evidence.
        const reply = snapshot.messages.slice(lastOutgoing + 1).filter(m => m.direction === 'incoming')
          .map(m => m.text.split(/[。；;\n]/).filter(s => !/[?？]|是否|能否|请问/.test(s)).join('。')).join('\n');
        const job: BossJobItem = { securityId: '', jobId: '', lid: '', jobName: '', brandName: '', salaryDesc: '', jobExperience: '', jobDegree: '', cityName: '',
          areaDistrict: '', brandScaleName: '', brandIndustry: '', bossName: '', bossTitle: '', activeTimeDesc: '', skills: [], welfareList: [] };
        for (const assessment of assessWorkRequirements(job, reply, contact.requirements)) {
          if (assessment.status !== 'unknown') {
            contact.assessment = contact.assessment.filter(a => a.requirementId !== assessment.requirementId); contact.assessment.push(assessment);
          }
        }
      }
      for (const action of contact.actions.filter(a => a.state === 'sending' || a.state === 'uncertain')) {
        const proof = snapshot.messages.find(m => m.direction === 'outgoing' && m.confirmed === true && m.text === action.text && !action.outgoingBefore?.includes(m.id));
        if (action.outgoingBefore && proof) { action.state = 'sent'; action.sentAt = now; action.error = undefined; contact.lastOutgoingAt = now; }
        else { action.state = 'uncertain'; contact.status = 'uncertain'; contact.nextStep = '发送结果尚未确认，请核对 BOSS 会话记录；不会自动重发。'; }
      }
      if (!contact.actions.some(a => a.state === 'uncertain' || a.state === 'sending') && contact.status !== 'closed') {
        contact.status = snapshot.messages.at(-1)?.direction === 'incoming' ? 'replied' : 'waiting'; contact.nextStep = undefined;
      }
    });
  }
  queue(id: string, value: Pick<FollowupAction, 'kind' | 'text' | 'basis' | 'conversationId'>, now: number): FollowupAction {
    const action: FollowupAction = { ...value, id: randomUUID(), state: 'queued', createdAt: now };
    this.update(id, contact => {
      if (contact.actions.some(a => a.basis === action.basis && a.state !== 'cancelled')) throw new Error('此消息已安排或发送');
      contact.actions.push(action);
    }); return action;
  }
}
export const followupStore = new FollowupStore(path.resolve(__dirname, '../../../data/followup.json'));
