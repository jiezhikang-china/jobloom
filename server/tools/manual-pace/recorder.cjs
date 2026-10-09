'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { launchVisibleChrome: launchNativeChrome } = require('./native-launch.cjs');
const { randomBytes } = require('node:crypto');
const { PaceSession, KINDS } = require('./model.cjs');
const { DomMonitor, CDP, json, allowedPage } = require('./monitor.cjs');
const root = path.resolve(__dirname, '../../..');
const dataDir = process.env.BOSS_MANUAL_PACE_DATA_DIR ? path.resolve(process.env.BOSS_MANUAL_PACE_DATA_DIR) : path.join(root, 'data/manual-pacing');
const profileDir = process.env.BOSS_PACE_PROFILE_DIR ? path.resolve(process.env.BOSS_PACE_PROFILE_DIR) : path.join(root, 'data/boss-profile-v3');
const browserRuntime = path.join(profileDir, 'boss-browser-runtime.json');
const runtimeFile = path.join(dataDir, 'runtime.json');
const JOBS = 'https://www.zhipin.com/web/geek/jobs';
const secret = randomBytes(24).toString('hex');
const session = new PaceSession(), clients = new Set();
let monitorState = { connected: false, observingPages: 0, observerError: '', verificationRequired: false };
let busy = false, message = '开始 DOM 监控后，直接在专用 Chrome 中操作 BOSS。';
let saveTimer = null, shuttingDown = false;
fs.mkdirSync(dataDir, { recursive: true });
function atomic(file, value) {
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}
function snapshot() {
  return { app: 'boss-manual-pacing', formatVersion: 2, capture: 'dom', ...session.view(), ...monitorState, message,
    domEventCount: session.events.filter(event => !['pause', 'resume', 'finish'].includes(event.kind)).length,
    savedFile: session.startedAt === null ? null : 'data/manual-pacing/' + session.id + '.json' };
}
function save() {
  clearTimeout(saveTimer);
  if (session.startedAt !== null) atomic(path.join(dataDir, session.id + '.json'), snapshot());
}
function changed(immediate = false) {
  const value = JSON.stringify(snapshot());
  for (const response of clients) response.write('data: ' + value + '\n\n');
  if (immediate) save();
  else {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { save(); } catch { message = '记录保存失败，请结束监控并导出记录。'; } }, 250);
  }
}
const monitor = new DomMonitor({
  onEvent(value) {
    if (session.events.length >= 10000) {
      session.pause('记录已达一万条，请结束并保存'); message = session.pauseReason; changed(true); return;
    }
    if (Object.hasOwn(KINDS, value.kind) && session.record(value.kind, value.at, value)) changed();
  },
  onState(value, reason) {
    const modified = JSON.stringify(monitorState) !== JSON.stringify(value);
    monitorState = value;
    if (reason && session.status === 'recording') {
      session.pause(reason + '，监控已暂停'); message = session.pauseReason; changed(true);
    } else if (modified) changed();
  },
  onVerification() {
    if (session.status === 'recording') {
      session.pause('进入登录或验证页面，请在 Chrome 中人工处理后继续监控'); message = session.pauseReason; changed(true);
    }
  },
});
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
async function ensureBrowser() {
  let remembered = null;
  try { remembered = JSON.parse(fs.readFileSync(browserRuntime, 'utf8')); } catch {}
  let port = null, identity = null;
  if (remembered && Number.isInteger(remembered.port)) {
    try {
      const version = await json('http://127.0.0.1:' + remembered.port + '/json/version');
      if (new URL(version.webSocketDebuggerUrl).pathname !== remembered.browserIdentity) throw new Error('浏览器实例已变化');
      port = remembered.port; identity = remembered.browserIdentity;
    } catch {}
  }
  if (!port) {
    fs.mkdirSync(profileDir, { recursive: true }); port = await freePort();
    await launchVisibleChrome(['--user-data-dir=' + profileDir, '--remote-debugging-port=' + port,
      '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--new-window', JOBS]);
    let version = null;
    const startupDeadline = Date.now() + 12000;
    while (Date.now() < startupDeadline) {
      try { version = await json('http://127.0.0.1:' + port + '/json/version'); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!version) throw new Error('专用 Chrome 启动失败。请先关闭占用项目资料目录的窗口，再重新打开。');
    identity = new URL(version.webSocketDebuggerUrl).pathname;
    atomic(browserRuntime, { port, browserIdentity: identity });
  }
  const tabs = await json('http://127.0.0.1:' + port + '/json/list');
  if (!tabs.some(tab => allowedPage(tab.url))) {
    const version = await json('http://127.0.0.1:' + port + '/json/version');
    const connection = await CDP.connect(version.webSocketDebuggerUrl);
    try { await connection.send('Target.createTarget', { url: JOBS }); } finally { connection.close(); }
  }
  await monitor.start(port, identity);
}
async function assertDesktopClosed() {
  let desktop = null;
  try { desktop = JSON.parse(fs.readFileSync(path.join(root, 'data/desktop-port.json'), 'utf8')); } catch {}
  if (desktop && Number.isInteger(desktop.port)) {
    let health = null; try { health = await json('http://127.0.0.1:' + desktop.port + '/health'); } catch {}
    if (health?.app === 'jobloom') throw new Error('请先关闭自动投递桌面助手，避免自动任务混入你的操作记录。');
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
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="boss-dom-pacing.json"' });
      res.end(JSON.stringify(snapshot(), null, 2)); return;
    }
    if (req.method === 'POST' && route.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin && origin !== 'http://127.0.0.1:' + server.address().port && origin !== 'http://localhost:' + server.address().port) throw new Error('请从本机操作表使用按钮');
      if (!String(req.headers['content-type']).startsWith('application/json')) throw new Error('请求格式错误');
      if (busy) throw new Error('正在连接浏览器，请稍等');
      busy = true;
      try {
        if (['/api/open', '/api/start'].includes(route) && !['ready', 'finished'].includes(session.status)) throw new Error('当前正在监控，请先结束并保存。');
        if (route === '/api/open') {
          await assertDesktopClosed(); await ensureBrowser(); message = 'DOM 监听已就绪，点击开始后会记录你的实际操作。';
        } else if (route === '/api/start') {
          await assertDesktopClosed(); await ensureBrowser(); session.start();
          message = '正在自动监控 DOM。直接在 Chrome 中选岗、阅读和操作，无需回来打点。';
        } else if (route === '/api/pause') {
          session.pause(); message = '监控已暂停，临时离开时间不会计入操作节奏。';
        } else if (route === '/api/resume') {
          if (session.status !== 'paused') throw new Error('当前没有暂停');
          await assertDesktopClosed(); await ensureBrowser(); session.resume(); message = '已继续自动监控 DOM。';
        } else if (route === '/api/finish') {
          session.finish(); message = '记录已保存，DOM 监听已移除。BOSS 窗口保留，可继续使用。'; await monitor.stop();
        } else throw new Error('没有这个操作');
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
  session.finish(); save(); await monitor.stop();
  for (const client of clients) client.end();
  server.close();
  try { const v = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')); if (v.pid === process.pid) fs.unlinkSync(runtimeFile); } catch {}
}
server.listen(0, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + server.address().port + '/' + secret + '/';
  atomic(runtimeFile, { pid: process.pid, port: server.address().port, url, startedAt: new Date().toISOString() });
  console.log('BOSS DOM 操作监控已就绪：' + url);
  if (process.argv.includes('--open')) void launchVisibleChrome([url]).catch(error => console.error(error.message));
});
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
