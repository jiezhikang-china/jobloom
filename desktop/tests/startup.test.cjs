const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { profileDirectory } = require('../user-profile.cjs');
const { APP_ORIGIN, isAppUrl, createAppProtocol } = require('../app-protocol.cjs');

const entry = path.resolve(__dirname, '..', 'electron-main.cjs');
const source = fs.readFileSync(entry, 'utf8');
const health = { app: 'boss-job-agent', integrationVersion: 31, desktopManaged: true, status: 'ok' };

function desktop(options = {}) {
  const windows = [];
  const children = [];
  const errors = [];
  const logs = [];
  const savedPorts = [];
  const requests = [];
  const ipcHandlers = new Map();
  const protocols = new Map();
  let removedPort = false;
  const app = new EventEmitter();
  Object.assign(app, {
    setPath(name, value) { app[name] = value; },
    disableHardwareAcceleration() {},
    requestSingleInstanceLock() {
      if (options.locks) {
        if (options.locks.has(app.userData)) return false;
        options.locks.add(app.userData);
      }
      return options.hasLock !== false;
    },
    whenReady: () => Promise.resolve(),
    isReady: () => true,
    quit() { app.quitCount = (app.quitCount || 0) + 1; },
    relaunch(value) { app.relaunchOptions = value; },
    exit(code) { app.exitCode = code; },
  });

  class BrowserWindow extends EventEmitter {
    constructor(settings) {
      super();
      this.settings = settings;
      this.visible = options.initiallyHidden ? false : settings.show;
      this.destroyed = false;
      this.minimized = false;
      this.focusCount = 0;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: APP_ORIGIN + '/' };
      this.maximized = false;
      this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
      windows.push(this);
    }
    minimize() { this.minimized = true; }
    maximize() { this.maximized = true; }
    unmaximize() { this.maximized = false; }
    isMaximized() { return this.maximized; }
    close() { this.destroyed = true; this.emit('closed'); app.emit('window-all-closed'); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    isVisible() { return this.visible; }
    show() { this.visible = true; }
    restore() { this.minimized = false; }
    moveTop() {}
    focus() { this.focusCount++; }
    async loadFile(file) {
      this.file = file;
      if (options.loadSplash) await options.loadSplash(this);
      if (!options.noLoadEvents) this.webContents.emit('did-finish-load');
    }
    async loadURL(url) {
      this.url = url;
      if (options.loadPage) await options.loadPage(this);
      if (!options.noLoadEvents) this.webContents.emit('did-finish-load');
    }
  }

  const fakeFs = {
    mkdirSync() {},
    appendFileSync(_file, value) { logs.push(value); },
    existsSync: () => !options.missingBuild,
    readFileSync: file => file.endsWith('boss-automation-safety.json') ? JSON.stringify({ hold: options.automationHold ? { reason: 'user_reported_ban' } : null })
      : JSON.stringify({ port: savedPorts.at(-1)?.port || 1878, token: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    writeFileSync(_file, value) { savedPorts.push(JSON.parse(value)); },
    unlinkSync() { removedPort = true; },
    openSync: () => 20,
    closeSync() {},
  };
  const processStub = new EventEmitter();
  Object.assign(processStub, {
    pid: 123,
    execPath: 'electron.exe',
    argv: ['electron.exe', '.', ...(options.compatibility ? ['--no-sandbox'] : [])],
    env: {},
  });
  const dependencies = {
    electron: {
      app,
      protocol: { registerSchemesAsPrivileged() {}, handle: (scheme, handler) => protocols.set(scheme, handler) },
      ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler) },
      BrowserWindow,
      dialog: { showErrorBox: (title, message) => errors.push({ title, message }) },
      session: { defaultSession: { setPermissionRequestHandler() {} } },
      shell: { openExternal: async () => {} },
    },
    'node:child_process': {
      spawn() {
        const child = new EventEmitter();
        Object.assign(child, { exitCode: null, kills: 0, kill() { this.kills++; } });
        children.push(child);
        return child;
      },
    },
    'node:fs': fakeFs,
    'node:path': path,
    'node:crypto': { randomUUID: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    './app-protocol.cjs': { APP_ORIGIN, isAppUrl, createAppProtocol },
    './user-profile.cjs': {
      profileDirectory: (dataDir) => profileDirectory(dataDir, options.account || 'S-1-5-21-100-500'),
    },
    'node:net': {
      createServer() {
        const probe = new EventEmitter();
        Object.assign(probe, {
          listen(_port, _host, callback) { queueMicrotask(callback); },
          address: () => ({ port: 4567 }),
          close: (callback) => callback(),
        });
        return probe;
      },
    },
  };
  const context = {
    __dirname: path.dirname(entry),
    require(name) {
      assert.ok(dependencies[name], `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    process: processStub,
    URL,
    AbortSignal,
    setTimeout,
    fetch: async (url, init) => {
      requests.push({ url, method: init?.method || 'GET' });
      if (url.endsWith('/health')) {
        if (options.healthRequest) return options.healthRequest(url, children);
        if (options.startOwnServer && !url.includes(':4567/')) throw new Error('No service');
        return { ok: true, json: async () => health };
      }
      if (url.endsWith('/api/boss/automation-safety')) return { ok: true, json: async () => ({ success: true, data: { blocked: !!options.automationHold } }) };
      if (url.endsWith('/api/delivery/stop')) return { ok: true, json: async () => ({ success: true }) };
      return {
        ok: true,
        json: async () => ({ data: { stats: { status: options.deliveryStatus || 'idle' } } }),
      };
    },
  };
  vm.runInNewContext(source, context, { filename: entry });
  return { app, windows, children, errors, logs, savedPorts, requests, ipcHandlers, protocols, removedPort: () => removedPort };
}

async function settled() {
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
}

test('启动不依赖 ready-to-show，隐藏启动状态也能显示主页', async () => {
  const run = desktop({ initiallyHidden: true, noLoadEvents: true });
  await settled();
  assert.equal(run.windows.length, 1);
  assert.equal(run.windows[0].visible, true);
  assert.equal(run.windows[0].url, APP_ORIGIN + '/');
  assert.equal(run.errors.length, 0);
});

test('再次启动恢复隐藏或最小化的窗口，并复用同一后台', async () => {
  const run = desktop({ startOwnServer: true });
  await settled();
  const window = run.windows[0];
  window.visible = false;
  window.minimized = true;
  const previousFocus = window.focusCount;
  run.app.emit('second-instance');
  await settled();
  assert.equal(window.visible, true);
  assert.equal(window.minimized, false);
  assert.ok(window.focusCount > previousFocus);
  assert.equal(run.windows.length, 1);
  assert.equal(run.children.length, 1);
});

test('升级时先停止旧任务，再启动新版桌面服务', async () => {
  const run = desktop({ deliveryStatus: 'running', healthRequest: async url => ({ ok: true, json: async () => ({ ...health, integrationVersion: url.includes(':4567/') ? 31 : 22 }) }) });
  await settled();
  assert.equal(run.windows[0].url, APP_ORIGIN + '/');
  assert.equal(run.children.length, 1); assert.equal(run.errors.length, 0);
  assert.ok(run.requests.some(request => request.url.endsWith('/api/delivery/stop')));
});

test('上一版空闲后台不会阻止新版本启动', async () => {
  const run = desktop({ healthRequest: async url => ({ ok: true, json: async () => ({ ...health, integrationVersion: url.includes(':4567/') ? 31 : 25 }) }) });
  await settled();
  assert.equal(run.windows[0].url, APP_ORIGIN + '/');
  assert.equal(run.children.length, 1); assert.equal(run.errors.length, 0);
});
test('账号已有停止状态时，停止旧版任务并加载带保护的新版本', async () => {
  const run = desktop({ automationHold: true, deliveryStatus: 'running', healthRequest: async url => ({ ok: true,
    json: async () => ({ ...health, integrationVersion: url.includes(':4567/') ? 31 : 25 }) }) });
  await settled();
  assert.ok(run.requests.some(request => request.url.endsWith('/api/delivery/stop') && request.method === 'POST'));
  assert.equal(run.windows[0].url, APP_ORIGIN + '/');
  assert.equal(run.children.length, 1); assert.equal(run.errors.length, 0);
});

test('已有窗口失效时，再次启动会重新创建可用窗口', async () => {
  const run = desktop({ startOwnServer: true });
  await settled();
  run.windows[0].destroyed = true;
  run.windows[0].emit('closed');
  run.app.emit('second-instance');
  await settled();
  assert.equal(run.windows.length, 2);
  assert.equal(run.windows[1].visible, true);
  assert.equal(run.windows[1].url, APP_ORIGIN + '/');
  assert.equal(run.children.length, 1);
});

test('失去实例锁的新进程退出，不创建另一份服务', async () => {
  const run = desktop({ hasLock: false });
  await settled();
  assert.equal(run.app.quitCount, 1);
  assert.equal(run.windows.length, 0);
  assert.equal(run.children.length, 0);
  assert.ok(run.logs.some((line) => line.includes('single instance lock=false')));
});

test('启动页渲染失败时只重启桌面，不提前启动后台', async () => {
  const run = desktop({
    startOwnServer: true,
    loadSplash: async (window) => {
      window.webContents.emit('render-process-gone', {}, { reason: 'launch-failed', exitCode: 49 });
      throw new Error('Renderer failed');
    },
  });
  await settled();
  assert.equal(run.app.relaunchOptions.args[0], '--no-sandbox');
  assert.equal(run.app.exitCode, 0);
  assert.equal(run.children.length, 0);
  assert.equal(run.errors.length, 0);
});

test('后台启动期间渲染失败，结束所属后台并移除失效端口再重启', async () => {
  let finishHealth;
  const pendingHealth = new Promise((resolve) => { finishHealth = resolve; });
  const run = desktop({
    healthRequest: async (url) => {
      if (!url.includes(':4567/')) throw new Error('No service');
      return pendingHealth;
    },
  });
  await settled();
  assert.equal(run.children.length, 1);
  run.windows[0].webContents.emit('render-process-gone', {}, { reason: 'launch-failed', exitCode: 49 });
  await settled();
  assert.equal(run.app.relaunchOptions, undefined);
  finishHealth({ ok: true, json: async () => health });
  await settled();
  assert.equal(run.savedPorts.at(-1).port, 4567);
  assert.equal(run.app.relaunchOptions.args[0], '--no-sandbox');
  assert.equal(run.children.length, 1);
  assert.equal(run.children[0].kills, 1); assert.equal(run.removedPort(), true);
  assert.equal(run.windows[0].url, undefined);
});

test('兼容启动仍失败时显示原因，不反复重启', async () => {
  const run = desktop({ compatibility: true });
  await settled();
  run.windows[0].webContents.emit('render-process-gone', {}, { reason: 'launch-failed', exitCode: 49 });
  await settled();
  assert.equal(run.app.relaunchOptions, undefined);
  assert.equal(run.windows[0].visible, true);
  assert.equal(run.errors.length, 1);
});

test('缺少构建文件时显示错误，窗口不会无声消失', async () => {
  const run = desktop({ missingBuild: true });
  await settled();
  assert.equal(run.windows[0].visible, true);
  assert.equal(run.children.length, 0);
  assert.equal(run.errors.length, 1);
  assert.match(run.errors[0].message, /缺少构建文件/);
});

test('关闭空闲窗口结束它启动的后台', async () => {
  const run = desktop({ startOwnServer: true });
  await settled();
  run.app.emit('window-all-closed');
  await settled();
  assert.equal(run.children[0].kills, 1);
  assert.equal(run.removedPort(), true);
  assert.equal(run.app.quitCount, 1);
});

test('关闭窗口停止任务，不留下无人管理的投递后台', async () => {
  const run = desktop({ startOwnServer: true, deliveryStatus: 'running' });
  await settled();
  run.app.emit('window-all-closed');
  await settled();
  assert.equal(run.children[0].kills, 1);
  assert.equal(run.removedPort(), true);
  assert.equal(run.app.quitCount, 1);
  assert.ok(run.requests.some(request => request.url.endsWith('/api/delivery/stop') && request.method === 'POST'));
});

test('Windows 账号分别持有桌面启动锁，不共用测试账号的窗口', async () => {
  const locks = new Set();
  const admin = desktop({ account: 'S-1-5-21-100-500', locks });
  const sandbox = desktop({ account: 'S-1-5-21-100-1001', locks });
  const adminAgain = desktop({ account: 'S-1-5-21-100-500', locks });
  await settled();
  assert.notEqual(admin.app.userData, sandbox.app.userData);
  assert.equal(admin.app.userData, adminAgain.app.userData);
  assert.equal(admin.windows[0].visible, true);
  assert.equal(sandbox.windows[0].visible, true);
  assert.equal(adminAgain.windows.length, 0, '同账号再次启动仍只恢复已有窗口');
  assert.equal(adminAgain.app.quitCount, 1);
  assert.equal(admin.windows[0].url, sandbox.windows[0].url, '桌面目录分开后仍复用原后台配置');
});

test('隔离 preload、内部协议和受限窗口命令', async () => {
  const run = desktop(); await settled();
  const window = run.windows[0];
  assert.equal(window.settings.frame, false);
  assert.equal(window.settings.webPreferences.nodeIntegration, false);
  assert.equal(window.settings.webPreferences.contextIsolation, true);
  assert.equal(window.settings.webPreferences.sandbox, true);
  assert.match(window.settings.webPreferences.preload, /preload\.cjs$/);
  assert.ok(run.protocols.has('boss-app'));
  const command = run.ipcHandlers.get('desktop:window');
  const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  command(sender, 'minimize'); assert.equal(window.minimized, true);
  command(sender, 'toggle-maximize'); assert.equal(window.maximized, true);
  command(sender, 'toggle-maximize'); assert.equal(window.maximized, false);
  assert.throws(() => command({ sender: window.webContents, senderFrame: { url: 'https://example.com' } }, 'close'), /Invalid desktop sender/);
  assert.throws(() => command(sender, 'run-arbitrary-code'), /Unknown window action/);
});
