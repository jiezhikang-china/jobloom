'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { launchVisibleChrome: launchNativeChrome } = require('./native-launch.cjs');
const { randomBytes } = require('node:crypto');
const WebSocket = require('../../node_modules/ws');
const { PaceSession, KINDS } = require('./model.cjs');
const root = path.resolve(__dirname, '../../..');
const dataDir = process.env.BOSS_MANUAL_PACE_DATA_DIR ? path.resolve(process.env.BOSS_MANUAL_PACE_DATA_DIR) : path.join(root, 'data/manual-pacing');
const profileDir = path.join(root, 'data/boss-profile-v3');
const browserRuntime = path.join(profileDir, 'boss-browser-runtime.json');
const runtimeFile = path.join(dataDir, 'runtime.json');
const JOBS = 'https://www.zhipin.com/web/geek/jobs';
const secret = randomBytes(24).toString('hex');
const bindingName = '__boss_manual_pace_' + randomBytes(8).toString('hex');
const cleanupKey = bindingName + '_cleanup';
const observerSource = fs.readFileSync(path.join(__dirname, 'observer.js'), 'utf8')
  .replace('__BINDING_NAME__', JSON.stringify(bindingName)).replace('__CLEANUP_KEY__', JSON.stringify(cleanupKey));
const session = new PaceSession();
const pages = new Map(), clients = new Set();
let observing = false, manualMode = false;
let browser = null, port = null, connected = false, busy = false, message = '先打开 BOSS 网页，再开始采样。';
let discovery = null, saveTimer = null, shuttingDown = false;
fs.mkdirSync(dataDir, { recursive: true });
function atomic(file, value) {
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}
function snapshot() { return { app: 'boss-manual-pacing', ...session.view(), connected, manualMode, message, savedFile: session.startedAt === null ? null : 'data/manual-pacing/' + session.id + '.json' }; }
function save() {
  clearTimeout(saveTimer);
  if (session.startedAt !== null) atomic(path.join(dataDir, session.id + '.json'), { formatVersion: 1, ...snapshot() });
}
function changed(immediate = false) {
  const value = JSON.stringify(snapshot());
  for (const response of clients) response.write('data: ' + value + '\n\n');
  if (immediate) save();
  else { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { save(); } catch { message = '采样保存失败，请结束采样并导出记录。'; } }, 250); }
}
class CDP {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.listeners = [];
    socket.on('message', raw => {
      let value; try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.id) {
        const pending = this.pending.get(value.id); if (!pending) return;
        this.pending.delete(value.id); clearTimeout(pending.timer);
        if (value.error) pending.reject(new Error(value.error.message)); else pending.resolve(value.result || {});
      } else for (const listener of this.listeners) listener(value);
    });
    socket.on('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('浏览器连接已关闭')); } this.pending.clear(); });
    socket.on('error', () => {});
  }
  static async connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('连接浏览器超时')); }, 4000);
      socket.once('open', () => { clearTimeout(timer); resolve(new CDP(socket)); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('无法连接浏览器')); });
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('浏览器读取超时')); }, 4000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  close() { this.socket.close(); }
}
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(1800) });
  if (!response.ok) throw new Error('本机浏览器连接不可用');
  return response.json();
}
function allowedPage(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'www.zhipin.com'; } catch { return false; }
}
async function attach(tab) {
  if (!observing || tab.type !== 'page' || !allowedPage(tab.url) || pages.has(tab.id)) return;
  const slot = { cdp: null, script: null }; pages.set(tab.id, slot);
  try {
    const cdp = await CDP.connect(tab.webSocketDebuggerUrl || 'ws://127.0.0.1:' + port + '/devtools/page/' + tab.id);
    if (!observing) { cdp.close(); return; }
    slot.cdp = cdp;
    cdp.listeners.push(event => {
      if (event.method !== 'Runtime.bindingCalled' || event.params.name !== bindingName) return;
      let value; try { value = JSON.parse(event.params.payload); } catch { return; }
      if (value.kind === 'manual_verification') {
        if (session.status === 'recording') { session.pause('登录或验证页面，处理后可继续计时'); message = session.pauseReason; changed(true); }
        return;
      }
      if (session.events.length >= 5000) { session.pause('采样记录已足够，请结束采样'); changed(true); return; }
      if (Object.hasOwn(KINDS, value.kind) && session.record(value.kind, value.at)) changed();
    });
    cdp.socket.on('close', () => { if (pages.get(tab.id) === slot) pages.delete(tab.id); });
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.addBinding', { name: bindingName });
    slot.script = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: observerSource })).identifier;
    await cdp.send('Runtime.evaluate', { expression: observerSource });
  } catch { slot.cdp?.close(); if (pages.get(tab.id) === slot) pages.delete(tab.id); }
}
async function discover() {
  if (!port) return;
  try {
    const tabs = await json('http://127.0.0.1:' + port + '/json/list');
    connected = true;
    await Promise.allSettled(tabs.map(attach));
  } catch {
    const wasConnected = connected;
    connected = false;
    if (session.status === 'recording') {
      session.pause('BOSS 浏览器已关闭，计时暂停'); message = session.pauseReason; changed(true);
    } else if (wasConnected) {
      message = 'BOSS 窗口已断开，请重新打开网页后开始采样。'; changed();
    }
  }
}
async function disconnect() {
  observing = false;
  clearInterval(discovery); discovery = null;
  const slots = [...pages.values()]; pages.clear();
  await Promise.allSettled(slots.map(async slot => {
    if (!slot.cdp) return;
    await slot.cdp.send('Runtime.evaluate', { expression: 'window[' + JSON.stringify(cleanupKey) + ']?.()' }).catch(() => {});
    if (slot.script) await slot.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: slot.script }).catch(() => {});
    await slot.cdp.send('Runtime.removeBinding', { name: bindingName }).catch(() => {});
    slot.cdp.close();
  }));
  browser?.close(); browser = null;
}
function chromePath() {
  const found = [process.env.BOSS_CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find(p => p && fs.existsSync(p));
  if (!found) throw new Error('未找到 Chrome，请先安装 Google Chrome');
  return found;
}
function launchVisibleChrome(args) { return launchNativeChrome(chromePath(), args); }
async function freePort() {
  return new Promise(resolve => {
    const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => {
      const value = probe.address().port; probe.close(() => resolve(value));
    });
  });
}
async function ensureManualBrowser(observe = true) {
  manualMode = !observe;
  observing = observe;
  let remembered = null;
  try { remembered = JSON.parse(fs.readFileSync(browserRuntime, 'utf8')); } catch {}
  if (remembered && Number.isInteger(remembered.port)) {
    try {
      const v = await json('http://127.0.0.1:' + remembered.port + '/json/version');
      if (new URL(v.webSocketDebuggerUrl).pathname !== remembered.browserIdentity) throw new Error('浏览器实例已变化');
      port = remembered.port;
    } catch { port = null; }
  }
  if (!port) {
    fs.mkdirSync(profileDir, { recursive: true });
    port = await freePort();
    await launchVisibleChrome(['--user-data-dir=' + profileDir, '--remote-debugging-port=' + port,
      '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--new-window', JOBS]);
    let version = null;
    const startupDeadline = Date.now() + 12000;
    while (Date.now() < startupDeadline) {
      try { version = await json('http://127.0.0.1:' + port + '/json/version'); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!version) { port = null; throw new Error('专用 Chrome 启动失败。请先关闭占用项目资料目录的窗口，再重新打开。'); }
    atomic(browserRuntime, { port, browserIdentity: new URL(version.webSocketDebuggerUrl).pathname });
  }
  if (!observe) {
    const tabs = await json('http://127.0.0.1:' + port + '/json/list');
    if (!tabs.some(tab => allowedPage(tab.url))) {
      await json('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(JOBS), { method: 'PUT' });
    }
    await discover();
    if (!connected) throw new Error('Chrome 刚启动就断开了，当前未能打开 BOSS 窗口。');
    if (!discovery) discovery = setInterval(() => { void discover(); }, 2000);
    message = '已连接专用 Chrome，BOSS 页面已打开。请在 Chrome 中操作，准备好后开始采样。';
    changed(); return;
  }
  if (!browser || browser.socket.readyState !== WebSocket.OPEN) {
    const version = await json('http://127.0.0.1:' + port + '/json/version');
    browser = await CDP.connect(version.webSocketDebuggerUrl);
    browser.listeners.push(event => {
      if (event.method === 'Target.targetInfoChanged' || event.method === 'Target.targetCreated') {
        void attach({ ...event.params.targetInfo, id: event.params.targetInfo.targetId });
      }
    });
    await browser.send('Target.setDiscoverTargets', { discover: true });
  }
  const tabs = await json('http://127.0.0.1:' + port + '/json/list');
  if (!tabs.some(tab => allowedPage(tab.url))) {
    await json('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(JOBS), { method: 'PUT' });
  }
  await discover();
  if (!discovery) discovery = setInterval(() => { void discover(); }, 2000);
  message = 'BOSS 网页已打开。按平常速度操作即可，点击由本机自动计时。';
  changed();
}
async function assertDesktopClosed() {
  let desktop = null;
  try { desktop = JSON.parse(fs.readFileSync(path.join(root, 'data/desktop-port.json'), 'utf8')); } catch {}
  if (desktop && Number.isInteger(desktop.port)) {
    let health = null; try { health = await json('http://127.0.0.1:' + desktop.port + '/health'); } catch {}
    if (health?.app === 'boss-job-agent') throw new Error('采样前请先关闭桌面助手，避免自动任务混入时间记录。');
  }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (!pathname.startsWith('/' + secret + '/')) { res.writeHead(404); res.end(); return; }
  const route = pathname.slice(secret.length + 1);
  try {
    if (req.method === 'GET' && route === '/api/state') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(snapshot())); return;
    }
    if (req.method === 'GET' && route === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify(snapshot()) + '\n\n'); clients.add(res);
      req.on('close', () => clients.delete(res)); return;
    }
    if (req.method === 'GET' && route === '/api/export') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="manual-pacing.json"' });
      res.end(JSON.stringify(snapshot(), null, 2)); return;
    }
    if (req.method === 'POST' && route.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin && origin !== 'http://127.0.0.1:' + server.address().port && origin !== 'http://localhost:' + server.address().port) throw new Error('请从本机操作表使用按钮');
      if (!String(req.headers['content-type']).startsWith('application/json')) throw new Error('请求格式错误');
      if (busy) throw new Error('正在连接浏览器，请稍等');
      busy = true;
      try {
        if (['/api/open', '/api/manual-open', '/api/start', '/api/manual-start'].includes(route) && !['ready', 'finished'].includes(session.status)) {
          throw new Error('当前正在采样，请先结束并保存。');
        }
        if (route === '/api/manual-open') {
          await disconnect(); await ensureManualBrowser(false);
        }
        else if (route === '/api/manual-start') {
          await assertDesktopClosed(); await disconnect();
          manualMode = true; connected = false; session.start(); session.record('select');
          message = '这一轮已开始计时。去 BOSS 正常操作，完成后回来点“完成这一轮”。';
        }
        else if (route === '/api/open') await ensureManualBrowser();
        else if (route === '/api/start') {
          let desktop = null;
          try { desktop = JSON.parse(fs.readFileSync(path.join(root, 'data/desktop-port.json'), 'utf8')); } catch {}
          if (desktop && Number.isInteger(desktop.port)) {
            let health = null; try { health = await json('http://127.0.0.1:' + desktop.port + '/health'); } catch {}
            if (health?.app === 'boss-job-agent') throw new Error('采样前请先关闭桌面助手，保留手动 BOSS 窗口，避免自动任务混入时间记录。');
          }
          await ensureManualBrowser(); session.start(); message = '正在记录。先选一个岗位，像平常一样阅读与操作。';
        }
        else if (route === '/api/pause') { session.pause(); message = '计时已暂停，临时离开时间不会计入操作节奏。'; }
        else if (route === '/api/resume') { if (!manualMode) await ensureManualBrowser(); session.resume(); message = '已继续记录。'; }
        else if (route === '/api/round') {
          if (manualMode && !session.view().rounds.some(round => !round.complete)) {
            session.record('select'); message = '下一轮已开始计时，按平常速度操作。';
          } else { session.record('round'); message = '这一轮已完成。下一轮准备好后点“开始下一轮”。'; }
        }
        else if (route === '/api/finish') { session.finish(); message = '记录已保存。可导出，或告诉我“采样完成”来分析节奏。'; await disconnect(); }
        else throw new Error('没有这个操作');
        changed(true);
        res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(snapshot())); return;
      } finally { busy = false; }
    }
    const file = { '/': 'page.html', '/page.js': 'page.js', '/page.css': 'page.css' }[route];
    if (req.method === 'GET' && file) {
      res.setHeader('Content-Type', MIME[path.extname(file)]);
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
      res.end(fs.readFileSync(path.join(__dirname, file))); return;
    }
    res.writeHead(404); res.end();
  } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message })); }
});
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  session.finish(); save(); await disconnect();
  for (const client of clients) client.end();
  server.close();
  try { const v = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')); if (v.pid === process.pid) fs.unlinkSync(runtimeFile); } catch {}
}
server.listen(0, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + server.address().port + '/' + secret + '/';
  atomic(runtimeFile, { pid: process.pid, port: server.address().port, url, startedAt: new Date().toISOString() });
  console.log('手动节奏采样已就绪：' + url);
  if (process.argv.includes('--open')) void launchVisibleChrome([url]).catch(error => console.error(error.message));
});
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });