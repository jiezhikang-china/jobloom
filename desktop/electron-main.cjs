const { app, BrowserWindow, dialog, session, shell, protocol, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { profileDirectory } = require('./user-profile.cjs');
const { APP_ORIGIN, isAppUrl, createAppProtocol } = require('./app-protocol.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'boss-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const serverDir = path.join(root, 'server');
const serverEntry = path.join(serverDir, 'dist', 'index.js');
const clientEntry = path.join(root, 'client', 'dist', 'index.html');
const portFile = path.join(dataDir, 'desktop-port.json');
const activeStatuses = new Set(['running', 'paused', 'sage_time', 'cool_down']);
fs.mkdirSync(dataDir, { recursive: true });
const userDataDir = profileDirectory(dataDir);
fs.mkdirSync(userDataDir, { recursive: true });
// Electron 的实例锁依赖 userData。同一项目下不同 Windows 账号必须使用各自目录。
app.setPath('userData', userDataDir);

function log(message) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'desktop-electron.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {}
}
log(`main loaded pid=${process.pid} desktopProfile=${path.basename(userDataDir)}`);
process.on('uncaughtException', (error) => log(`uncaughtException: ${error.stack || error}`));
process.on('unhandledRejection', (error) => log(`unhandledRejection: ${error?.stack || error}`));

let window = null;
let ownServer = null;
let serverPort = null;
let serverUrl = null;
let serviceToken = randomUUID();
let stopping = false;
let rendererFallbackStarted = false;
let serverReadyPromise = null;

// 此窗口只显示本机页面。软件绘制兼容远程桌面和无 GPU 的 Windows 会话。
app.disableHardwareAcceleration();

const hasLock = app.requestSingleInstanceLock();
log(`single instance lock=${hasLock}`);
if (!hasLock) {
  log('requested existing desktop window');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('second launch received');
    void app.whenReady().then(openWindow);
  });
}

function address(port) {
  return `http://127.0.0.1:${port}`;
}

async function readJson(url, timeout = 1500) {
  const response = await fetch(url, { headers: { 'x-boss-desktop-token': serviceToken }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function isOurService(port) {
  try {
    const health = await readJson(`${address(port)}/health`);
    if (health.app !== 'boss-job-agent' || health.integrationVersion !== 30 || health.status !== 'ok' || health.desktopManaged !== true) return false;
    const safety = await readJson(`${address(port)}/api/boss/automation-safety`);
    return safety.success === true;
  } catch {
    return false;
  }
}

async function isActivePreviousService(port) {
  try {
    const health = await readJson(`${address(port)}/health`);
    if (health.app !== 'boss-job-agent' || health.status !== 'ok' || !Number.isInteger(health.integrationVersion)
      || health.integrationVersion < 22 || health.integrationVersion >= 30) return false;
    const result = await readJson(`${address(port)}/api/delivery/status`, 2500);
    return activeStatuses.has(result?.data?.stats?.status);
  } catch { return false; }
}

function rememberedPort() {
  try {
    const record = JSON.parse(fs.readFileSync(portFile, 'utf8'));
    if (typeof record.token === 'string' && /^[a-f0-9-]{36}$/.test(record.token)) serviceToken = record.token;
    return Number.isInteger(record.port) && record.port > 0 && record.port < 65536 ? record.port : null;
  } catch {
    return null;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function startServer() {
  log('checking local service');
  if (!fs.existsSync(clientEntry) || !fs.existsSync(serverEntry)) {
    throw new Error('缺少构建文件。请运行「启动桌面版-调试.cmd」完成构建。');
  }
  fs.mkdirSync(dataDir, { recursive: true });

  for (const port of new Set([rememberedPort(), 3001])) {
    if (!port) continue;
    const current = await isOurService(port);
    const previous = !current && await isActivePreviousService(port);
    if (previous) {
      const stopped = await fetch(`${address(port)}/api/delivery/stop`, { method: 'POST', signal: AbortSignal.timeout(2500) });
      if (!stopped.ok || (await stopped.json()).success !== true) throw new Error('账号自动操作已停止，但旧版任务尚未确认停止；请关闭旧版后再启动');
      log(`stopped previous delivery on ${port} before upgrading the desktop worker`);
      continue;
    }
    if (current) {
      serverPort = port;
      serverUrl = address(port);
      log(`using local service on ${port}`);
      return;
    }
  }

  serverPort = await freePort();
  serverUrl = address(serverPort);
  serviceToken = randomUUID();
  const logFd = fs.openSync(path.join(dataDir, 'desktop-server.log'), 'a');
  let spawnError = null;
  try {
    ownServer = spawn(process.execPath, [serverEntry], {
      cwd: serverDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOST: '127.0.0.1', PORT: String(serverPort), BOSS_DESKTOP_TOKEN: serviceToken },
      detached: false,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
    });
    ownServer.on('error', (error) => { spawnError = error; });
  } finally {
    fs.closeSync(logFd);
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) break;
    if (await isOurService(serverPort)) {
      fs.writeFileSync(portFile, JSON.stringify({ port: serverPort, token: serviceToken }), 'utf8');
      log(`started local service on ${serverPort}`);
      return;
    }
    if (ownServer.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  ownServer.kill();
  ownServer = null;
  throw new Error(spawnError
    ? `本地服务启动失败：${spawnError.message}`
    : '本地服务启动失败。详情见 data/desktop-server.log。');
}

function ensureServer() {
  if (!serverReadyPromise) {
    serverReadyPromise = startServer().catch((error) => {
      serverReadyPromise = null;
      throw error;
    });
  }
  return serverReadyPromise;
}

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      void shell.openExternal(url);
    }
  } catch {}
}

function presentWindow(target = window) {
  if (!target || target.isDestroyed()) return;
  if (target.isMinimized()) target.restore();
  target.show();
  target.moveTop();
  target.focus();
  log(`window visible=${target.isVisible()}`);
}

async function recoverRenderer(target, details) {
  log(`renderer gone: ${JSON.stringify(details)}`);
  if (stopping || target.isDestroyed()) return;
  if (details.reason === 'launch-failed' && !process.argv.includes('--no-sandbox') && !rendererFallbackStarted) {
    rendererFallbackStarted = true;
    stopping = true;
    // The IPC-owned worker exits with this process; do not hand its dying port to the relaunched app.
    if (serverReadyPromise) await serverReadyPromise.catch(() => {});
    if (ownServer) {
      ownServer.kill(); ownServer = null;
      try { if (rememberedPort() === serverPort) fs.unlinkSync(portFile); } catch {}
    }
    log('relaunching with compatibility mode after renderer launch failed');
    app.relaunch({ args: ['--no-sandbox', ...process.argv.slice(1)] });
    app.exit(0);
    return;
  }
  presentWindow(target);
  dialog.showErrorBox('BOSS 求职助手页面无法显示', '桌面页面进程意外退出。请关闭窗口后重新打开；详细原因已记录在 data/desktop-electron.log。');
}

function createWindow() {
  log('creating browser window');
  const target = new BrowserWindow({
    title: 'BOSS 求职助手',
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    show: true,
    backgroundColor: '#faf9f5',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window = target;
  // Identify this map viewer to public tile services while retaining the browser's normal user agent.
  if (target.webContents.setUserAgent && target.webContents.getUserAgent) {
    target.webContents.setUserAgent(target.webContents.getUserAgent() + ' BossJobAgent/1.0');
  }

  target.once('ready-to-show', () => { log('ready to show'); presentWindow(target); });
  target.webContents.on('did-finish-load', () => presentWindow(target));
  target.webContents.on('render-process-gone', (_event, details) => { void recoverRenderer(target, details); });
  target.webContents.on('did-fail-load', (_event, code, description, url) => {
    if (code !== -3) log(`load failed: ${code} ${description} ${url}`);
  });
  target.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  target.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    if (url.startsWith('file://') && !serverUrl) return;
    event.preventDefault();
    openExternal(url);
  });
  target.on('closed', () => { if (window === target) window = null; });
  presentWindow(target);
  return target;
}

async function showApp(target) {
  try {
    // 启动页可显示后才启动服务；渲染失败重启时不会同时启动两份后台。
    await target.loadFile(path.join(__dirname, 'splash.html'));
    if (stopping || target.isDestroyed()) return;
    presentWindow(target);
    await ensureServer();
    if (stopping || target.isDestroyed()) return;
    log('loading bundled Electron workbench');
    await target.loadURL(APP_ORIGIN + '/');
    presentWindow(target);
    log('app page loaded');
  } catch (error) {
    if (stopping || target.isDestroyed()) return;
    const message = error instanceof Error ? error.message : String(error);
    log(`startup failed: ${message}`);
    presentWindow(target);
    dialog.showErrorBox('BOSS 求职助手启动失败', message);
  }
}

function openWindow() {
  if (stopping) return;
  if (window && !window.isDestroyed()) {
    presentWindow();
    return;
  }
  void showApp(createWindow());
}

async function shutDown() {
  if (stopping) return;
  stopping = true;
  if (serverUrl) {
    try {
      const stopped = await fetch(`${serverUrl}/api/delivery/stop`, { method: 'POST', headers: { 'x-boss-desktop-token': serviceToken }, signal: AbortSignal.timeout(4000) });
      if (!stopped.ok || (await stopped.json()).success !== true) throw new Error('stop not acknowledged');
      await fetch(`${serverUrl}/api/llm/web/stop`, { method: 'POST', headers: { 'x-boss-desktop-token': serviceToken }, signal: AbortSignal.timeout(2500) });
    } catch (error) { log(`shutdown stop failed: ${error.message}`); }
    // Closing a desktop window must never leave unattended delivery running.
    ownServer?.kill();
    try { if (rememberedPort() === serverPort && ownServer) fs.unlinkSync(portFile); } catch {}
  }
  app.quit();
}

if (hasLock) {
  app.whenReady().then(() => {
    log('app ready');
    protocol.handle('boss-app', createAppProtocol({ clientDir: path.dirname(clientEntry), getService: () => ({ url: serverUrl, token: serviceToken }) }));
    ipcMain.handle('desktop:window', (event, action) => {
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isAppUrl(event.senderFrame.url)) throw new Error('Invalid desktop sender');
      if (action === 'minimize') window.minimize();
      else if (action === 'toggle-maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
      else if (action === 'close') window.close();
      else throw new Error('Unknown window action');
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    openWindow();
  });
  app.on('activate', () => { if (app.isReady()) openWindow(); });
  app.on('window-all-closed', () => { void shutDown(); });
}
