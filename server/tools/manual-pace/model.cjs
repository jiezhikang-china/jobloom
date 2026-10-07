'use strict';
const { randomUUID } = require('node:crypto');
const KINDS = Object.freeze({
  select: ['选择岗位', 'load_detail'], detail_ready: ['详情已显示', 'read_detail'],
  detail_visible: ['回到岗位详情', 'read_detail'], company: ['打开公司页', 'load_company'],
  company_ready: ['公司页已显示', 'read_company'], source: ['切换自选岗位', 'browse'],
  list: ['回到职位列表', 'browse'], scroll: ['滚动阅读', null], control: ['其他控件', null],
  input: ['输入筛选条件', null], submit: ['点击沟通', 'submit'], confirm: ['点击继续沟通', 'after_submit'],
  feedback: ['点击不合适', 'feedback'], round: ['完成这一轮', 'browse'],
  pause: ['暂停计时', null], resume: ['继续计时', null], finish: ['结束采样', null],
});
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p, lo = Math.floor(index), hi = Math.ceil(index);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo));
}
class PaceSession {
  constructor(now = Date.now) { this.now = now; this.reset(); }
  reset() {
    this.id = randomUUID(); this.status = 'ready'; this.startedAt = null; this.endedAt = null;
    this.pausedAt = null; this.pausedMs = 0; this.events = []; this.pauseReason = '';
  }
  elapsed(at = this.now()) {
    if (this.startedAt === null) return 0;
    return Math.max(0, (this.endedAt ?? this.pausedAt ?? at) - this.startedAt - this.pausedMs);
  }
  start() {
    if (this.status !== 'ready' && this.status !== 'finished') throw new Error('已有采样，请先结束');
    this.reset(); this.startedAt = this.now(); this.status = 'recording';
  }
  record(kind, at = this.now()) {
    if (this.status !== 'recording' || !Object.hasOwn(KINDS, kind) || ['pause', 'resume', 'finish'].includes(kind)) return false;
    const received = this.now();
    if (!Number.isFinite(at) || Math.abs(at - received) > 5000) at = received;
    const elapsedMs = Math.max(this.events.at(-1)?.elapsedMs || 0, this.elapsed(at));
    this.events.push({ n: this.events.length + 1, kind, label: KINDS[kind][0], at: new Date(at).toISOString(), elapsedMs });
    return true;
  }
  pause(reason = '手动暂停') {
    if (this.status !== 'recording') return;

    this.events.push({ n: this.events.length + 1, kind: 'pause', label: KINDS.pause[0], at: new Date(this.now()).toISOString(), elapsedMs: this.elapsed() });
    this.pausedAt = this.now(); this.status = 'paused'; this.pauseReason = reason;
  }
  resume() {
    if (this.status !== 'paused') throw new Error('当前没有暂停');
    this.pausedMs += this.now() - this.pausedAt; this.pausedAt = null; this.status = 'recording'; this.pauseReason = '';
    this.events.push({ n: this.events.length + 1, kind: 'resume', label: KINDS.resume[0], at: new Date(this.now()).toISOString(), elapsedMs: this.elapsed() });
  }
  finish() {
    if (!['recording', 'paused'].includes(this.status)) return;
    const elapsedMs = this.elapsed();
    this.endedAt = this.now();
    if (this.pausedAt !== null) { this.pausedMs += this.endedAt - this.pausedAt; this.pausedAt = null; }
    this.status = 'finished';
    this.events.push({ n: this.events.length + 1, kind: 'finish', label: KINDS.finish[0], at: new Date(this.endedAt).toISOString(), elapsedMs });
  }
  view() {
    const elapsedMs = this.elapsed();
    const rounds = []; let current = null;
    for (const event of this.events) {
      if (event.kind === 'select') {
        if (current) { current.durationMs = event.elapsedMs - current.startMs; current.complete = true; rounds.push(current); }
        current = { number: rounds.length + 1, startMs: event.elapsedMs, durationMs: 0, complete: false, outcome: '浏览判断' };
      }
      if (current && event.kind === 'submit') current.outcome = '已点沟通';
      if (current && event.kind === 'confirm') current.outcome = '已点继续沟通';
      if (current && event.kind === 'feedback') current.outcome = '已点不合适';
      if (current && ['round', 'finish'].includes(event.kind)) {
        current.durationMs = event.elapsedMs - current.startMs; current.complete = true; rounds.push(current); current = null;
      }
    }
    if (current) { current.durationMs = elapsedMs - current.startMs; rounds.push(current); }
    const phases = []; let phase = 'browse', phaseStart = 0;
    for (const event of this.events) {
      const next = KINDS[event.kind]?.[1];
      if (next && next !== phase) {
        if (event.elapsedMs > phaseStart) phases.push({ phase, durationMs: event.elapsedMs - phaseStart });
        phase = next; phaseStart = event.elapsedMs;
      }
    }
    if (elapsedMs > phaseStart) phases.push({ phase, durationMs: elapsedMs - phaseStart });
    const completed = rounds.filter(r => r.complete && r.durationMs >= 1000).map(r => r.durationMs);
    const metric = values => ({ count: values.length, p25Ms: percentile(values, .25), medianMs: percentile(values, .5), p75Ms: percentile(values, .75) });
    return { id: this.id, status: this.status, startedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
      elapsedMs, pausedMs: this.pausedMs, pauseReason: this.pauseReason, events: this.events, rounds,
      summary: { rounds: metric(completed), detailReading: metric(phases.filter(p => p.phase === 'read_detail').map(p => p.durationMs)),
        companyReading: metric(phases.filter(p => p.phase === 'read_company').map(p => p.durationMs)) },
      phases };
  }
}
module.exports = { PaceSession, KINDS, percentile };