'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { percentile } = require('./model.cjs');
function analyze(record) {
  if (record?.capture !== 'dom' || record.status !== 'finished' || !Array.isArray(record.events)) {
    throw new Error('需要已结束的 DOM 监控记录');
  }
  let previous = -1;
  for (const event of record.events) {
    if (!Number.isFinite(event.elapsedMs) || event.elapsedMs < previous) throw new Error('操作时间必须单调递增');
    previous = event.elapsedMs;
  }
  const events = record.events;
  const auth = event => event.page === 'login' || /boss-login|geetest|captcha|verification/i.test(event.target || '');
  const selected = events.map((event, index) => ({ event, index })).filter(item => item.event.kind === 'select' && item.event.action === 'click');
  const intervals = [], loads = [], reads = [], excluded = [];
  for (let i = 0; i < selected.length - 1; i++) {
    const a = selected[i], b = selected[i + 1];
    const middle = events.slice(a.index + 1, b.index);
    const hasAuth = middle.some(auth);
    const differentFlow = middle.some(event => ['submit', 'confirm', 'company', 'company_ready', 'source', 'navigate'].includes(event.kind));
    if (hasAuth || differentFlow) {
      excluded.push({ from: a.event.n, to: b.event.n, reason: hasAuth ? 'login_or_verification' : 'different_workflow' }); continue;
    }
    const gap = Math.round(b.event.elapsedMs - a.event.elapsedMs);
    if (gap <= 0) continue;
    intervals.push(gap);
    const ready = middle.find(event => event.kind === 'detail_ready');
    if (ready) {
      loads.push(Math.round(ready.elapsedMs - a.event.elapsedMs));
      reads.push(Math.round(b.event.elapsedMs - ready.elapsedMs));
    }
  }
  if (intervals.length < 3) throw new Error('可用的相邻选岗间隔不足三个');
  const press = [];
  for (let i = 1; i < events.length; i++) {
    const a = events[i - 1], b = events[i];
    if (a.kind === 'focus' && b.kind === 'select' && b.action === 'click' && a.target === b.target && !auth(a) && !auth(b)) {
      const gap = Math.round(b.elapsedMs - a.elapsedMs);
      if (gap > 0 && gap <= Math.min(...intervals)) press.push(gap);
    }
  }
  const stats = values => ({ count: values.length, minMs: values.length ? Math.min(...values) : null,
    p25Ms: percentile(values, .25), medianMs: percentile(values, .5), p75Ms: percentile(values, .75),
    maxMs: values.length ? Math.max(...values) : null });
  return {
    id: record.id, startedAt: record.startedAt, elapsedMs: record.elapsedMs,
    domEventCount: events.filter(e => !['pause', 'resume', 'finish'].includes(e.kind)).length,
    selectionCount: selected.length, selectionIntervalsMs: intervals, selection: stats(intervals),
    observedLoad: stats(loads), observedReading: stats(reads), excluded,
    pointerHoldSamplesMs: press, pointerHoldMs: press.length ? percentile(press, .5) : null,
    minimumActionIntervalMs: Math.min(...intervals),
    unmeasured: ['company', 'input', 'source', 'confirm', 'successful_submit'],
  };
}
if (require.main === module) {
  try {
    const input = process.argv[2];
    if (!input) throw new Error('请提供 DOM 记录 JSON 路径');
    const raw = fs.readFileSync(input);
    const result = { sha256: crypto.createHash('sha256').update(raw).digest('hex'), ...analyze(JSON.parse(raw)) };
    if (process.argv[3]) {
      const profile = { sourceSha256: result.sha256, sampleId: result.id,
        selectionIntervalsMs: result.selectionIntervalsMs, minimumActionIntervalMs: result.minimumActionIntervalMs,
        pointerHoldMs: result.pointerHoldMs };
      fs.writeFileSync(process.argv[3], '/** Generated from a completed user DOM trace; timings, not platform safety thresholds. */\n'
        + 'export const bossRecordedPace = Object.freeze(' + JSON.stringify(profile, null, 2).replace(/"selectionIntervalsMs": (\[[\s\S]*?\])/, '"selectionIntervalsMs": Object.freeze($1)')
        + ');\n', 'utf8');
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { analyze };
