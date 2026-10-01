const { app, BrowserWindow, dialog, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const serverDir = path.join(root, 'server');
const serverEntry = path.join(serverDir, 'dist', 'index.js');
const clientEntry = path.join(root, 'client', 'dist', 'index.html');
const portFile = path.join(dataDir, 'desktop-port.json');
const activeStatuses = new Set(['running', 'paused', 'sage_time', 'cool_down']);
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'electron-profile-v2'), { recursive: true });
app.setPath('userData', path.join(dataDir, 'electron-profile-v2'));

function log(message) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'desktop-electron.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {}
}
log('main loaded');
process.on('uncaughtException', (error) => log(`uncaughtException: ${error.stack || error}`));
process.on('unhandledRejection', (error) => log(`unhandledRejection: ${error?.stack || error}`));

let window = null;
let ownServer = null;
let serverPort = null;
let serverUrl = null;
let stopping = false;
let rendererFallbackStarted = false;

// 此窗口只显示本机页面。软件绘制兼容远程桌面和无 GPU 的 Windows 会话。
app.disableHardwareAcceleration();

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
}

function address(port) {
  return `http://127.0.0.1:${port}`;
}

async function readJson(url, timeout = 1500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function isOurService(port) {
  try {
    const health = await readJson(`${address(port)}/health`);
    return health.app === 'boss-job-agent' && health.integrationVersion === 12 && health.status === 'ok';
  } catch {
    return false;
  }
}

function rememberedPort() {
  try {
    const value = JSON.parse(fs.readFileSync(portFile, 'utf8')).port;
    return Number.isInteger(value) && value > 0 && value < 65536 ? value : null;
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

async function ensureServer() {
  log('checking local service');
  if (!fs.existsSync(clientEntry) || !fs.existsSync(serverEntry)) {
    throw new Error('缺少构建文件。请运行「启动桌面版-调试.cmd」完成构建。');
  }
  fs.mkdirSync(dataDir, { recursive: true });

  for (const port of [rememberedPort(), 3001]) {
    if (port && await isOurService(port)) {
      serverPort = port;
      serverUrl = address(port);
      log(`using local service on ${port}`);
      return;
    }
  }

  serverPort = await freePort();
  serverUrl = address(serverPort);
  const logFd = fs.openSync(path.join(dataDir, 'desktop-server.log'), 'a');
  try {
    ownServer = spawn(process.execPath, [serverEntry], {
      cwd: serverDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOST: '127.0.0.1', PORT: String(serverPort) },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    if (await isOurService(serverPort)) {
      fs.writeFileSync(portFile, JSON.stringify({ port: serverPort }), 'utf8');
      log(`started local service on ${serverPort}`);
      return;
    }
    if (ownServer.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  ownServer.kill();
  ownServer = null;
  throw new Error('本地服务启动失败。详情见 data/desktop-server.log。');
}

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      void shell.openExternal(url);
    }
  } catch {}
}

function createWindow() {
  log('creating browser window');
  window = new BrowserWindow({
    title: 'BOSS 求职助手',
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => { log('ready to show'); window?.show(); });
  window.webContents.on('render-process-gone', (_event, details) => {
    log(`renderer gone: ${JSON.stringify(details)}`);
    if (details.reason === 'launch-failed' && !process.argv.includes('--no-sandbox') && !rendererFallbackStarted) {
      rendererFallbackStarted = true;
      log('relaunching with compatibility mode after renderer launch failed');
      app.relaunch({ args: ['--no-sandbox', ...process.argv.slice(1)] });
      app.exit(0);
    }
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => log(`load failed: ${code} ${description} ${url}`));
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (serverUrl && url.startsWith(serverUrl + '/')) return;
    if (url.startsWith('file://') && !serverUrl) return;
    event.preventDefault();
    openExternal(url);
  });
  void window.loadFile(path.join(__dirname, 'splash.html'));
  window.on('closed', () => { window = null; });
}

async function showApp() {
  try {
    await ensureServer();
    log(`loading ${serverUrl}`);
    if (window) await window.loadURL(serverUrl + '/');
    log('app page loaded');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`startup failed: ${message}`);
    dialog.showErrorBox('BOSS 求职助手启动失败', message);
  }
}

async function shutDown() {
  if (stopping) return;
  stopping = true;
  if (ownServer && serverPort) {
    let active = true;
    try {
      const response = await readJson(`${serverUrl}/api/delivery/status`, 2500);
      active = activeStatuses.has(response?.data?.stats?.status);
    } catch {}
    if (!active) {
      try {
        await fetch(`${serverUrl}/api/llm/web/stop`, { method: 'POST', signal: AbortSignal.timeout(2500) });
      } catch {}
      ownServer.kill();
      try {
        if (rememberedPort() === serverPort) fs.unlinkSync(portFile);
      } catch {}
    }
  }
  app.quit();
}

if (hasLock) {
  app.whenReady().then(() => {
    log('app ready');
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    createWindow();
    void showApp();
  });
  app.on('window-all-closed', () => { void shutDown(); });
}
