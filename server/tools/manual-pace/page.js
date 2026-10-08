'use strict';
const $ = id => document.getElementById(id);
let state = null, receivedAt = 0, requesting = false;
const seconds = ms => ms === null || ms === undefined ? '—' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' 秒';
const pages = { list: '职位列表', detail: '岗位详情', company: '公司页', chat: '沟通页', other: '其他页面', login: '登录 / 验证' };
function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}
function cell(text, cls) { const el = document.createElement('td'); el.textContent = text; if (cls) el.className = cls; return el; }
function emptyRow(text, cols = 3) { const row = document.createElement('tr'), td = cell(text, 'empty'); td.colSpan = cols; row.append(td); return row; }
function render(value) {
  state = value; receivedAt = performance.now();
  $('connection').textContent = value.observingPages
    ? 'DOM 监听已就绪 · ' + value.observingPages + ' 个页面'
    : value.status === 'finished' ? 'DOM 监听已结束' : value.connected ? 'Chrome 已连接，DOM 监听未就绪' : 'DOM 监听未连接';
  $('connection').classList.toggle('ready', value.observingPages > 0);
  $('status').textContent = { ready: '尚未开始', recording: value.domEventCount ? '正在监控 · 已记录 ' + value.domEventCount + ' 次 DOM 操作' : '正在监听，等待你在 BOSS 操作', paused: '已暂停，离开时间不计入', finished: '操作记录已保存' }[value.status];
  $('message').textContent = value.message;
  $('start').hidden = !['ready', 'finished'].includes(value.status);
  $('start').textContent = value.status === 'finished' ? '重新开始 DOM 监控' : '开始 DOM 监控';
  $('pause').hidden = value.status !== 'recording';
  $('resume').hidden = value.status !== 'paused';
  $('finish').hidden = !['recording', 'paused'].includes(value.status);
  $('export').hidden = value.status !== 'finished';
  const completed = value.rounds.filter(round => round.complete).length;
  $('round-count').textContent = completed + ' 轮完成';
  $('rounds').replaceChildren(...(value.rounds.length ? value.rounds.map(round => {
    const row = document.createElement('tr');
    row.append(cell('第 ' + round.number + ' 轮'), cell(seconds(round.durationMs), round.complete ? '' : 'in-progress'),
      cell(round.complete ? round.outcome : '进行中')); return row;
  }) : [emptyRow('等待你在 BOSS 选择岗位。')]));
  $('median').textContent = seconds(value.summary.rounds.medianMs);
  $('detail-median').textContent = seconds(value.summary.detailReading.medianMs);
  $('company-median').textContent = seconds(value.summary.companyReading.medianMs);
  $('sample-note').textContent = completed >= 3 ? '已有 ' + completed + ' 轮样本。结束后可分析实际用时。'
    : '下一次选岗会自动分轮，建议连续操作 3–5 个岗位。';
  $('event-count').textContent = value.domEventCount + ' 次 DOM 操作';
  const events = value.events.map((event, index) => ({ ...event, delta: event.elapsedMs - (value.events[index - 1]?.elapsedMs || 0) })).slice(-80).reverse();
  $('events').replaceChildren(...(events.length ? events.map(event => {
    const row = document.createElement('tr');
    row.append(cell(event.label), cell([event.target, pages[event.page]].filter(Boolean).join(' · '), 'dom-target'),
      cell(seconds(event.delta)), cell(seconds(event.elapsedMs))); return row;
  }) : [emptyRow('监听就绪后，你的操作会自动出现在这里。', 4)]));
}
async function action(name) {
  if (requesting) return; requesting = true; $('error').hidden = true;
  document.querySelectorAll('button').forEach(button => button.disabled = true);
  if (['start', 'resume'].includes(name)) $('message').textContent = '正在连接 Chrome 并确认 DOM 监听器已安装…';
  try {
    const response = await fetch('api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '操作未完成');
    render(value);
  } catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
  finally { requesting = false; document.querySelectorAll('button').forEach(button => button.disabled = false); }
}
for (const name of ['start', 'pause', 'resume', 'finish']) $(name).onclick = () => action(name);
const stream = new EventSource('api/events');
stream.onmessage = event => render(JSON.parse(event.data));
stream.onerror = () => {
  $('connection').textContent = '本地监控服务连接中断'; $('connection').classList.remove('ready');
  $('error').textContent = '本地监控服务未连接。已保存的记录仍在本机，请重新打开工具。'; $('error').hidden = false;
};
setInterval(() => {
  if (!state) return;
  $('clock').textContent = clock(state.elapsedMs + (state.status === 'recording' ? performance.now() - receivedAt : 0));
}, 100);
setInterval(async () => {
  if (requesting) return;
  try {
    const response = await fetch('api/state');
    if (response.ok && !requesting) render(await response.json());
  } catch {}
}, 2000);
