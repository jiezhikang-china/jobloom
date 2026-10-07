'use strict';
const $ = id => document.getElementById(id);
let state = null, receivedAt = 0, requesting = false;
const seconds = ms => ms === null || ms === undefined ? '—' : (ms / 1000).toFixed(1) + ' 秒';
function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}
function cell(text, cls) { const el = document.createElement('td'); el.textContent = text; if (cls) el.className = cls; return el; }
function emptyRow(text) { const row = document.createElement('tr'), td = cell(text, 'empty'); td.colSpan = 3; row.append(td); return row; }
function render(value) {
  state = value; receivedAt = performance.now();
  const manual = ['recording', 'paused'].includes(value.status) ? value.manualMode : $('mode').value === 'manual';
  $('connection').textContent = manual ? '手动记录每轮' : (value.connected ? 'BOSS 网页已连接' : 'BOSS 网页未连接');
  $('connection').classList.toggle('ready', value.connected || manual);
  $('status').textContent = { ready: '尚未开始', recording: '正在记录你的操作', paused: '已暂停，离开时间不计入', finished: '采样已保存' }[value.status];
  $('message').textContent = manual && value.status === 'ready' && !value.connected
    ? '点击“打开 BOSS 网页”会启动专用 Chrome。准备好后点“开始采样”。'
    : (!value.manualMode && !value.connected && value.message.includes('网页已打开')
      ? 'BOSS 窗口已断开，请重新打开网页后开始采样。' : value.message);
  $('start').hidden = !['ready', 'finished'].includes(value.status);
  $('start').textContent = value.status === 'finished' ? '重新采样' : '开始采样';
  $('pause').hidden = value.status !== 'recording';
  $('resume').hidden = value.status !== 'paused';
  $('round').hidden = value.status !== 'recording';
  $('round').textContent = value.manualMode && !value.rounds.some(round => !round.complete) ? '开始下一轮' : '完成这一轮';
  $('mode').disabled = ['recording', 'paused'].includes(value.status);
  $('open').hidden = ['recording', 'paused'].includes(value.status);
  $('round-guide').textContent = value.manualMode || $('mode').value === 'manual'
    ? '回到计时表点“完成这一轮”；下一轮准备好后再点“开始下一轮”。'
    : '下一次选岗会自动结束上一轮。最后一轮可点“完成这一轮”。';
  $('finish').hidden = !['recording', 'paused'].includes(value.status);
  $('export').hidden = value.status !== 'finished';
  const completed = value.rounds.filter(round => round.complete).length;
  $('round-count').textContent = completed + ' 轮完成';
  $('rounds').replaceChildren(...(value.rounds.length ? value.rounds.map(round => {
    const row = document.createElement('tr');
    row.append(cell('第 ' + round.number + ' 轮'), cell(seconds(round.durationMs), round.complete ? '' : 'in-progress'),
      cell(round.complete ? round.outcome : '进行中')); return row;
  }) : [emptyRow('开始采样后，选一个新岗位。')]));
  $('median').textContent = seconds(value.summary.rounds.medianMs);
  $('detail-median').textContent = seconds(value.summary.detailReading.medianMs);
  $('company-median').textContent = seconds(value.summary.companyReading.medianMs);
  $('sample-note').textContent = completed >= 3 ? '已有 ' + completed + ' 轮样本。结束后会分析实际用时。'
    : '建议连续操作 3–5 轮，避免仅凭一次快慢定节奏。';
  $('event-count').textContent = value.events.length + ' 次';
  const events = value.events.map((event, index) => ({ ...event, delta: event.elapsedMs - (value.events[index - 1]?.elapsedMs || 0) })).slice(-60).reverse();
  $('events').replaceChildren(...(events.length ? events.map(event => {
    const row = document.createElement('tr'); row.append(cell(event.label), cell(seconds(event.delta)), cell(clock(event.elapsedMs))); return row;
  }) : [emptyRow('开始和完成每轮后，时间会记录在这里。')]));
}
async function action(name) {
  if (requesting) return; requesting = true; $('error').hidden = true;
  document.querySelectorAll('button').forEach(button => button.disabled = true);
  if (name === 'open') $('message').textContent = '正在启动 Chrome 并检查连接…';
  try {
    if (['open', 'start'].includes(name) && $('mode').value === 'manual') name = 'manual-' + name;
    const response = await fetch('api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '操作未完成');
    render(value);
  } catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
  finally { requesting = false; document.querySelectorAll('button').forEach(button => button.disabled = false); }
}
for (const name of ['open', 'start', 'pause', 'resume', 'round', 'finish']) $(name).onclick = () => action(name);
$('mode').onchange = () => { if (state) render(state); };
const stream = new EventSource('api/events');
stream.onmessage = event => render(JSON.parse(event.data));
stream.onopen = () => { if (!requesting) $('error').hidden = true; };
stream.onerror = () => {
  $('connection').textContent = '计时服务连接中断'; $('connection').classList.remove('ready');
  $('error').textContent = '本地计时服务未连接。已保存的记录仍在本机，请重新打开采样工具。'; $('error').hidden = false;
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