// Local DeepSeek-only Chat2API adaptation, GPL-3.0-or-later. See UPSTREAM.md.
// This is a separate Electron process communicating over an authenticated loopback API.
const { app, BrowserWindow, safeStorage, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { CredentialVault } = require('./vault.cjs');
const { MODELS, ProxyError, normalizeToken, DeepSeekWebAdapter } = require('./protocol.cjs');
const { WebRequestPacing } = require('./pacing.cjs');
const { WebRequests } = require('./requests.cjs');

const dataDir = path.resolve(process.env.BOSS_DEEPSEEK_DATA_DIR || path.join(__dirname, '../../data'));
const runtimeFile = path.join(dataDir, 'deepseek-proxy-runtime.json');
const secret = process.env.BOSS_DEEPSEEK_PROXY_SECRET || '';
if (secret.length < 32) { process.exitCode = 1; app.quit(); }
fs.mkdirSync(path.join(dataDir, 'deepseek-web-profile'), { recursive: true });
app.setPath('userData', path.join(dataDir, 'deepseek-web-profile'));
app.disableHardwareAcceleration();
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

let loginWindow = null;
let loginTimer = null;
let loginSession;
let server;
let token = '';
let state = 'not_logged_in';
let stateMessage = '请登录 DeepSeek 网页账号';
let busy = false;
let captureBusy = false;
const pacing = new WebRequestPacing();
let vault;
let adapter;
let closing = false;
let lastCaptureToken = '';
let lastCaptureAt = 0;

const messages = {
  ready: 'DeepSeek 登录已确认，可使用网页模型', saved: '已保存登录，首次请求会自动检查有效性',
  expired: 'DeepSeek 登录已失效，请重新登录', verification_required: '请打开 DeepSeek 登录窗口手动完成网页确认',
  not_logged_in: '请登录 DeepSeek 网页账号', error: 'DeepSeek 连接异常，请检查网络后重试',
};
function setState(next) { state = next; stateMessage = messages[next] || messages.error; }
function status() {
  return {
    running: true, state, message: stateMessage, hasCredential: Boolean(token),
    loginWindowOpen: Boolean(loginWindow && !loginWindow.isDestroyed()), busy,
    retryAfterSeconds: pacing.retryAfterSeconds,
    pendingRequests: adapter?.requests.list() || [],
    models: MODELS.map(({ id, name }) => ({ id, name })),
    source: 'Chat2API', sourceUrl: 'https://github.com/xiaoY233/Chat2API',
  };
}
function reply(res, code, data, extraHeaders = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(data));
}
function authenticated(req) {
  const provided = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 2000000) throw new ProxyError('请求过大', 413, 'invalid_request');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ProxyError('请求不是合法 JSON', 400, 'invalid_request'); }
}
async function saveLogin(raw) {
  const nextToken = normalizeToken(raw);
  if (!nextToken) throw new ProxyError('DeepSeek 登录凭据格式无效', 400, 'invalid_token');
  const previous = token;
  token = nextToken;
  adapter.clearTokenCache();
  try {
    await adapter.acquireToken(undefined, true);
    vault.save(nextToken);
    await loginSession.flushStorageData();
    setState('ready');
  } catch (error) {
    token = previous;
    adapter.clearTokenCache();
    if (previous && error.code !== 'login_expired') setState('saved');
    else if (!previous) setState(error.code === 'login_expired' ? 'expired' : 'error');
    throw error;
  }
}
async function captureLogin() {
  if (captureBusy || busy || !loginWindow || loginWindow.isDestroyed()) return;
  // Read storage only on the actual DeepSeek origin, with no preload or Node bridge.
  try {
    if (new URL(loginWindow.webContents.getURL()).origin !== 'https://chat.deepseek.com') return;
    captureBusy = true;
    const raw = await loginWindow.webContents.executeJavaScript('localStorage.getItem("userToken")', true);
    const found = normalizeToken(raw);
    if (!found || (found === token && state === 'ready')) return;
    if (found === lastCaptureToken && Date.now() - lastCaptureAt < 30000) return;
    lastCaptureToken = found; lastCaptureAt = Date.now();
    await saveLogin(found);
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.setTitle('DeepSeek · 登录已保存，可以关闭此窗口');
    // Keep the page visible until the user closes it, including after successful login.
  } catch (error) {
    stateMessage = error instanceof ProxyError ? error.message : '暂时无法读取 DeepSeek 登录，请完成网页登录后稍等';
  } finally { captureBusy = false; }
}
async function openLogin(chatUrl) {
  if (loginWindow && !loginWindow.isDestroyed()) {
    if (loginWindow.isMinimized()) loginWindow.restore();
    loginWindow.show(); loginWindow.focus();
    if (chatUrl) await loginWindow.loadURL(chatUrl);
    return;
  }
  loginWindow = new BrowserWindow({
    title: 'DeepSeek · 请手动登录，登录完成后会自动保存', width: 1100, height: 800, minWidth: 800, minHeight: 600,
    show: false, autoHideMenuBar: true, backgroundColor: '#ffffff',
    webPreferences: { session: loginSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  loginWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Login links stay in the isolated web session; never open a privileged local window.
    try { if (new URL(url).protocol === 'https:') void loginWindow?.loadURL(url); } catch {}
    return { action: 'deny' };
  });
  loginWindow.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).protocol === 'https:') return; } catch {}
    event.preventDefault();
  });
  loginWindow.webContents.on('page-title-updated', (event) => { if (state === 'ready') event.preventDefault(); });
  loginWindow.once('ready-to-show', () => loginWindow?.show());
  loginWindow.webContents.on('did-finish-load', () => void captureLogin());
  loginWindow.on('closed', () => { loginWindow = null; clearInterval(loginTimer); loginTimer = null; });
  loginTimer = setInterval(() => void captureLogin(), 3000);
  loginWindow.show();
  void loginWindow.loadURL(chatUrl || 'https://chat.deepseek.com/').catch(() => {
    stateMessage = 'DeepSeek 网页加载失败，请检查网络后重新打开登录窗口'; loginWindow?.show();
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/health' && req.method === 'GET') {
    return reply(res, 200, { app: 'boss-deepseek-web-proxy', integrationVersion: 7, status: 'ok' });
  }
  if (!authenticated(req)) return reply(res, 401, { error: { message: '本机代理认证失败', code: 'proxy_unauthorized' } });
  try {
    if (url.pathname === '/status' && req.method === 'GET') {
      if (url.searchParams.get('refresh') === '1' && token && !busy) {
        try { await adapter.acquireToken(undefined, true); }
        catch (error) { stateMessage = error instanceof ProxyError ? error.message : messages.error; }
      }
      return reply(res, 200, status());
    }
    if (url.pathname === '/login' && req.method === 'POST') { await openLogin(); return reply(res, 200, status()); }
    if (['/requests/view', '/requests/retry', '/requests/recover'].includes(url.pathname) && req.method === 'POST') {
      if (busy) throw new ProxyError('模型正在处理请求，请等待完成后操作', 409, 'busy');
      const body = await readBody(req);
      const pending = adapter.requests.list().find(item => item.requestId === body.requestId);
      if (!pending) throw new ProxyError('该未完成请求已经处理，请刷新', 404, 'not_found');
      if (url.pathname === '/requests/view') await openLogin(`https://chat.deepseek.com/a/chat/s/${encodeURIComponent(pending.sessionId)}`);
      else if (url.pathname === '/requests/recover') {
        busy = true;
        try {
          const recovered = await adapter.recoverPending(pending, AbortSignal.timeout(40000), true);
          if (!recovered) throw new ProxyError('原聊天还没有完整答案或状态尚未确认，记录已保留；稍后再读取', 409, 'not_finished');
          setState('ready'); stateMessage = '已读回原聊天的最终答案，可复用相同批次的结果，无需重新生成';
        } finally { busy = false; }
      }
      else adapter.requests.clear(pending.requestId);
      return reply(res, 200, status());
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const body = await readBody(req);
      if (busy) throw new ProxyError('模型正在处理任务，请等待完成后更新登录', 409, 'busy');
      await saveLogin(body.token); return reply(res, 200, status());
    }
    if (url.pathname === '/logout' && req.method === 'POST') {
      if (busy) throw new ProxyError('模型正在处理任务，请等待完成后退出登录', 409, 'busy');
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
      token = ''; adapter.clearTokenCache(); vault.clear();
      await loginSession.clearStorageData(); setState('not_logged_in');
      return reply(res, 200, status());
    }
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      return reply(res, 200, { object: 'list', data: MODELS.map(({ id }) => ({ id, object: 'model', owned_by: 'deepseek-web' })) });
    }
    if (url.pathname === '/shutdown' && req.method === 'POST') {
      if (busy || loginWindow) throw new ProxyError('任务或登录窗口仍在使用，服务继续保持', 409, 'busy');
      reply(res, 200, { stopped: true }); setImmediate(() => void close()); return;
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      if (busy) throw new ProxyError('DeepSeek 正在处理上一项任务，请稍后重试', 429, 'busy', 3);
      if (pacing.retryAfterSeconds) throw new ProxyError('DeepSeek 网页正在等待频率恢复，请稍后继续', 429, 'rate_limited', pacing.retryAfterSeconds);
      busy = true;
      const controller = new AbortController();
      let timeout;
      const abort = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', abort);
      try {
        const body = await readBody(req);
        if (body.stream) throw new ProxyError('本项目使用非流式模型调用，请设置 stream: false', 400, 'invalid_request');
        await pacing.wait(body.min_request_interval_seconds, controller.signal);
        delete body.min_request_interval_seconds;
        timeout = setTimeout(() => controller.abort(), body.thinking ? 600000 : 300000);
        const completion = await adapter.complete(body, controller.signal);
        setState('ready'); reply(res, 200, completion);
      } finally {
        busy = false; pacing.finished(); clearTimeout(timeout); res.removeListener('close', abort);
      }
      return;
    }
    return reply(res, 404, { error: { message: '代理路径不存在', code: 'not_found' } });
  } catch (error) {
    const known = error instanceof ProxyError;
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    const code = known ? error.status : timedOut ? 504 : 502;
    if (['rate_limited', 'service_unavailable'].includes(error?.code)) pacing.coolDown(error.retryAfter);
    const message = known ? error.message : timedOut ? 'DeepSeek 网页请求超时，请检查网络或关闭深度思考' : '无法连接 DeepSeek 网页，请检查网络后重试';
    if (code !== 400 && code !== 409) stateMessage = message;
    if (!res.destroyed) reply(res, code, { error: { message, code: known ? error.code : timedOut ? 'timeout' : 'network_error' } },
      error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
  }
}

async function close() {
  if (closing) return;
  closing = true; clearInterval(loginTimer);
  try {
    const current = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    if (current.pid === process.pid) fs.unlinkSync(runtimeFile);
  } catch { /* Runtime file can be absent on startup failure. */ }
  server?.close();
  app.quit();
}
if (hasLock && secret.length >= 32) app.whenReady().then(async () => {
  loginSession = session.fromPartition('persist:deepseek-login');
  loginSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  vault = new CredentialVault(path.join(dataDir, 'deepseek-web-credential.json'), safeStorage);
  try { token = vault.load(); if (token) setState('saved'); }
  catch (error) { state = 'error'; stateMessage = error.message; }
  adapter = new DeepSeekWebAdapter({
    // Keep certificate trust, cookies and proxy behavior with the logged-in browser session.
    fetchImpl: (input, init) => loginSession.fetch(input, init),
    credentials: async () => ({ token, userAgent: loginSession.getUserAgent(),
      cookie: (await loginSession.cookies.get({ url: 'https://chat.deepseek.com' })).map((item) => `${item.name}=${item.value}`).join('; ') }),
    onAuthState: setState,
    requests: new WebRequests(path.join(dataDir, 'deepseek-pending-requests.json')),
  });
  server = http.createServer((req, res) => void handle(req, res));
  server.requestTimeout = 210000;
  server.on('error', () => { state = 'error'; stateMessage = '本机 DeepSeek 代理无法启动'; void close(); });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(runtimeFile, JSON.stringify({ port: server.address().port, secret, pid: process.pid, integrationVersion: 7 }), { mode: 0o600 });
  });
}).catch(() => void close());
app.on('window-all-closed', () => {}); // Login window lifetime does not control the proxy.
app.on('before-quit', () => { clearInterval(loginTimer); });
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
