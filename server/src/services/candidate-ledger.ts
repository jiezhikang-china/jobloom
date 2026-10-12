import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeJsonAtomic } from './atomic-json.js';
import { canonicalBossJobHref as canonicalFollowupJob } from './job-identity.js';
import type { Stage2Result } from './filter.service.js';
import { normalizeWorkRequirements } from './work-requirements.js';
import type { WorkRequirement, BossJobItem, WorkConditionReview } from '../types.js';

export type CandidateStatus = 'discovered' | 'read_retry' | 'evaluation_retry' | 'ready' | 'decision' | 'rejected' | 'sending' | 'sent' | 'send_unknown';
export interface CandidateRecord {
  jobHref: string; jobName: string; companyName: string; salary: string;
  context: string; sources: string[]; status: CandidateStatus; reason: string;
  discoveredAt: number; updatedAt: number; retryAt: number; attempts: number;
  job?: BossJobItem; description?: string; rulesVersion: string;
  history: Array<{ at: number; status: CandidateStatus; reason: string }>;
  legacyReview?: WorkConditionReview;
  evaluation?: { facts: string; at: number; result: Stage2Result };
}
interface Ledger { version: 1; candidates: CandidateRecord[]; }
export const candidateFingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, node) => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  return Object.fromEntries(Object.keys(node).sort().map(key => [key, node[key]]));
})).digest('hex');
const states: CandidateStatus[] = ['discovered', 'read_retry', 'evaluation_retry', 'ready', 'decision', 'rejected', 'sending', 'sent', 'send_unknown'];
const pendingStates: CandidateStatus[] = ['discovered', 'read_retry', 'evaluation_retry', 'ready'];
export class CandidateLedger {
  private state: Ledger = { version: 1, candidates: [] };
  private loadError = '';
  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Ledger;
      if (data.version !== 1 || !Array.isArray(data.candidates) || data.candidates.some(c =>
        !c || canonicalFollowupJob(c.jobHref) !== c.jobHref || !states.includes(c.status)
        || typeof c.context !== 'string' || typeof c.rulesVersion !== 'string'
        || !Array.isArray(c.sources) || !c.sources.every(s => typeof s === 'string')
        || !Array.isArray(c.history) || !Number.isFinite(c.updatedAt) || !Number.isFinite(c.retryAt)
        || !Number.isInteger(c.attempts) || c.attempts < 0 || typeof c.jobName !== 'string' || typeof c.companyName !== 'string'
        || typeof c.salary !== 'string' || typeof c.reason !== 'string' || !Number.isFinite(c.discoveredAt)
        || c.history.some(h => !h || !Number.isFinite(h.at) || !states.includes(h.status) || typeof h.reason !== 'string')
        || (c.evaluation && (!/^[a-f0-9]{64}$/.test(c.evaluation.facts) || !Number.isFinite(c.evaluation.at)
          || typeof c.evaluation.result?.passed !== 'boolean' || !Number.isFinite(c.evaluation.result.score)
          || c.evaluation.result.score < 0 || c.evaluation.result.score > 100
          || typeof c.evaluation.result.reason !== 'string' || typeof c.evaluation.result.customGreeting !== 'string'
          || c.evaluation.result.llmError || c.evaluation.result.responseIssue)))
        || new Set(data.candidates.map(c => c.jobHref)).size !== data.candidates.length) throw new Error('候选台账格式错误');
      this.state = data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.loadError = '候选台账无法读取，已保留原文件：' + (error as Error).message; }
  }
  error(): string { return this.loadError; }
  list(): CandidateRecord[] { if (this.loadError) throw new Error(this.loadError); return structuredClone(this.state.candidates); }
  get(href: string): CandidateRecord | undefined {
    if (this.loadError) throw new Error(this.loadError);
    const row = this.state.candidates.find(c => c.jobHref === canonicalFollowupJob(href));
    return row ? structuredClone(row) : undefined;
  }
  private change(fn: (state: Ledger) => void): void {
    if (this.loadError) throw new Error(this.loadError);
    const next = structuredClone(this.state); fn(next);
    if (this.file) writeJsonAtomic(this.file, next);
    this.state = next;
  }
  discover(target: { jobHref: string; jobName: string; companyName: string; salary: string }, context: string, rulesVersion: string, source: string): CandidateRecord {
    const jobHref = canonicalFollowupJob(target.jobHref), now = Date.now();
    this.change(state => {
      let c = state.candidates.find(c => c.jobHref === jobHref);
      if (!c) {
        c = { jobHref, jobName: target.jobName, companyName: target.companyName, salary: target.salary, context, rulesVersion, sources: [], status: 'discovered', reason: '', discoveredAt: now, updatedAt: now, retryAt: 0, attempts: 0, history: [] };
        state.candidates.push(c);
      }
      if (!c.sources.includes(source)) c.sources.push(source);
      // Sending and unknown acknowledgements are never made retryable by a settings change.
      if (!['sent', 'sending', 'send_unknown'].includes(c.status) && (c.context !== context || c.rulesVersion !== rulesVersion)) {
        c.context = context; c.rulesVersion = rulesVersion; c.status = 'discovered'; c.retryAt = 0; c.attempts = 0; delete c.evaluation;
        c.history.push({ at: now, status: c.status, reason: '求职资料或条件变化，重新读取评估' });
      }
      c.jobName = target.jobName; c.companyName = target.companyName; c.salary = target.salary;
    });
    return this.get(jobHref)!;
  }
  transition(href: string, status: CandidateStatus, reason: string, snapshot?: { job: BossJobItem; description: string }, retryMs = 0): void {
    this.change(state => {
      const c = state.candidates.find(c => c.jobHref === canonicalFollowupJob(href));
      if (!c) throw new Error('候选岗位不存在');
      if (c.status === 'sent' && status !== 'sent') return;
      const now = Date.now(); c.status = status; c.reason = reason; c.updatedAt = now; c.retryAt = now + retryMs;
      if (status === 'read_retry' || status === 'evaluation_retry') c.attempts++;
      if (snapshot) { c.job = structuredClone(snapshot.job); c.description = snapshot.description; c.jobName = snapshot.job.jobName; c.companyName = snapshot.job.brandName; c.salary = snapshot.job.salaryDesc; }
      c.history.push({ at: now, status, reason });
    });
  }
  private facts(snapshot: { job: BossJobItem; description: string }): string {
    const info = snapshot.job.companyInfo;
    return candidateFingerprint({ ...snapshot, job: { ...snapshot.job,
      commute: snapshot.job.commute ? { ...snapshot.job.commute, checkedAt: undefined } : undefined,
      companyInfo: info ? { industry: info.industry, name: info.name, introduction: info.introduction, businessScope: info.businessScope, url: info.url } : undefined } });
  }
  saveEvaluation(href: string, result: Stage2Result, snapshot: { job: BossJobItem; description: string }): void {
    if (result.llmError || result.responseIssue) return;
    this.change(state => { const c = state.candidates.find(c => c.jobHref === canonicalFollowupJob(href)); if (!c) throw new Error('候选不存在');
      c.evaluation = { facts: this.facts(snapshot), at: Date.now(), result: structuredClone(result) }; });
  }
  cachedEvaluation(href: string, snapshot: { job: BossJobItem; description: string }): Stage2Result | undefined {
    const c = this.get(href);
    if (!c?.evaluation || c.evaluation.facts !== this.facts(snapshot) || c.evaluation.at + 24 * 3600000 < Date.now()) return;
    return { ...structuredClone(c.evaluation.result), evaluationSource: c.evaluation.result.evaluationSource === 'rules' ? 'rules' : 'cache' };
  }
  shouldProcess(c: CandidateRecord, now = Date.now()): boolean {
    if (['sent', 'sending', 'send_unknown'].includes(c.status)) return false;
    if (pendingStates.includes(c.status)) return c.retryAt <= now;
    return c.updatedAt + 24 * 60 * 60 * 1000 <= now;
  }
  recoverable(context: string, rulesVersion: string, source: string, now = Date.now()): CandidateRecord[] {
    const changed = this.state.candidates.some(c => c.context === context && c.rulesVersion !== rulesVersion && !['sent', 'sending', 'send_unknown'].includes(c.status));
    if (changed) this.change(state => { for (const c of state.candidates) {
      if (c.context === context && c.rulesVersion !== rulesVersion && !['sent', 'sending', 'send_unknown'].includes(c.status)) {
        c.rulesVersion = rulesVersion; c.status = 'discovered'; c.retryAt = 0; c.attempts = 0; delete c.evaluation;
        c.history.push({ at: now, status: c.status, reason: '条件变化，按当前规则恢复评估' });
      }
    } });
    if (this.loadError) throw new Error(this.loadError);
    return structuredClone(this.state.candidates.filter(c => c.context === context && c.rulesVersion === rulesVersion && c.sources.includes(source)
      && pendingStates.includes(c.status) && c.retryAt <= now));
  }
  migrateTechnical(reviews: WorkConditionReview[], context: string, rulesVersion: string, source: string, currentRequirements?: WorkRequirement[]): string[] {
    const moved: string[] = [];
    for (const r of reviews) {
      const requirementsChanged = currentRequirements && candidateFingerprint(normalizeWorkRequirements(r.requirements).filter(r => r.enabled))
        !== candidateFingerprint(normalizeWorkRequirements(currentRequirements).filter(r => r.enabled));
      if (!r.screening?.needsDetailConfirmation && !r.screening?.needsEvaluationConfirmation && !requirementsChanged) continue;
      // Archived reviews lack reliable candidate provenance; explicitly mark them for current-rule reevaluation.
      const existing = this.get(r.jobHref);
      if (existing && ['sent', 'sending', 'send_unknown'].includes(existing.status)) {
        this.change(state => { state.candidates.find(c => c.jobHref === canonicalFollowupJob(r.jobHref))!.legacyReview = structuredClone(r); });
        moved.push(r.id); continue;
      }
      this.discover({ ...r, salary: r.salary }, context, rulesVersion, source);
      this.change(state => { const c = state.candidates.find(c => c.jobHref === canonicalFollowupJob(r.jobHref))!; c.legacyReview = structuredClone(r); });
      this.transition(r.jobHref, 'read_retry', requirementsChanged ? '条件已变化；保存旧记录，按当前条件重新读取' : '从旧技术待确认记录恢复；保留原记录，按当前条件重新读取');
      moved.push(r.id);
    }
    return moved;
  }
  sourceMetrics(context: string, sources: string[]) {
    if (this.loadError) throw new Error(this.loadError);
    return sources.map(source => {
      const rows = this.state.candidates.filter(c => c.context === context && c.sources.includes(source));
      const detail = rows.filter(c => c.job);
      const passed = rows.filter(c => c.history.some(e => e.status === 'ready'));
      const sent = rows.filter(c => c.status === 'sent');
      return { source, unique: rows.length, details: detail.length, passed: passed.length, sent: sent.length,
        rejected: rows.filter(c => c.status === 'rejected').length, recovery: rows.filter(c => pendingStates.includes(c.status)).length,
        decisions: rows.filter(c => c.status === 'decision').length,
        yield: (passed.length + sent.length + 2) / (rows.length + 10) };
    });
  }
  summary() {
    if (this.loadError) throw new Error(this.loadError);
    const rows = this.state.candidates;
    return { unique: rows.length, details: rows.filter(c => c.job).length,
      passed: rows.filter(c => c.history.some(e => e.status === 'ready')).length,
      sent: rows.filter(c => c.status === 'sent').length, recovery: rows.filter(c => pendingStates.includes(c.status)).length,
      decisions: rows.filter(c => c.status === 'decision').length,
      uncertain: rows.filter(c => ['sending', 'send_unknown'].includes(c.status)).length };
  }
}
export const candidateLedger = new CandidateLedger(path.resolve(__dirname, '../../../data/candidates.json'));
