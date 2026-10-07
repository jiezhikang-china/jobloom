const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DeepSeekWebAdapter, ...protocol } = require('../protocol.cjs');

test('the launched proxy uses the login session when Node TLS cannot trust the local certificate chain', async () => {
  const secret = 'fixture-local-secret-12345678901234567890';
  const calls = [];
  const writes = [];
  let handler;
  const loginSession = {
    setPermissionRequestHandler() {},
    getUserAgent() { return 'Fixture Chrome'; },
    cookies: { async get() { return []; } },
    async fetch(url, init) {
      assert.equal(this, loginSession, 'session method retains its receiver');
      calls.push({ url, init });
      return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { token: 'fixture-access-token' } } }));
    },
  };
  class CapturedAdapter extends DeepSeekWebAdapter {
    constructor(options) {
      assert.equal(typeof options.fetchImpl, 'function', 'the actual startup must provide a browser transport');
      super(options);
    }
  }
  const electron = {
    app: { setPath() {}, disableHardwareAcceleration() {}, requestSingleInstanceLock() { return true; },
      whenReady() { return Promise.resolve(); }, on() {}, quit() {}, },
    session: { fromPartition(name) { assert.equal(name, 'persist:deepseek-login'); return loginSession; } },
    safeStorage: {},
  };
  const fileSystem = {
    mkdirSync() {},
    writeFileSync(file, content) { writes.push({ file, content }); },
  };
  const server = {
    on() {},
    listen(_port, host, callback) { assert.equal(host, '127.0.0.1'); callback(); },
    address() { return { port: 18111 }; },
  };
  const imports = {
    electron,
    'node:http': { createServer(callback) { handler = callback; return server; } },
    'node:fs': fileSystem,
    'node:path': path,
    'node:crypto': require('node:crypto'),
    './vault.cjs': { CredentialVault: class { load() { return 'fixture-login-token'; } } },
    './protocol.cjs': { ...protocol, DeepSeekWebAdapter: CapturedAdapter },
    './pacing.cjs': { WebRequestPacing: class { get retryAfterSeconds() { return 0; } } },
    './requests.cjs': { WebRequests: class { list() { return []; } } },
  };
  const context = {
    require(name) { assert.ok(name in imports, 'unexpected import: ' + name); return imports[name]; },
    __dirname: path.resolve(__dirname, '..'),
    process: { env: { BOSS_DEEPSEEK_PROXY_SECRET: secret, BOSS_DEEPSEEK_DATA_DIR: path.join(__dirname, 'fixture-data') },
      pid: 100, on() {}, exitCode: 0 },
    Buffer, URL, AbortSignal, setInterval, clearInterval, console,
    fetch() {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'SELF_SIGNED_CERT_IN_CHAIN' };
      return Promise.reject(error);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../main.cjs'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof handler, 'function', 'startup creates the loopback server');
  const body = await new Promise(resolve => {
    const req = { method: 'GET', url: '/status?refresh=1', headers: { authorization: 'Bearer ' + secret } };
    const res = { writeHead(code) { assert.equal(code, 200); }, end(raw) { resolve(JSON.parse(raw)); } };
    handler(req, res);
  });
  assert.equal(body.state, 'ready', 'successful browser request confirms the saved login');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://chat.deepseek.com/api/v0/users/current');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer fixture-login-token');
  assert.ok(calls[0].init.signal, 'request timeout/cancellation remains active');
  const runtime = writes.find(item => item.file.endsWith('deepseek-proxy-runtime.json'));
  assert.equal(JSON.parse(runtime.content).integrationVersion, 8, 'upgrade cannot silently retain the old network implementation');
});
