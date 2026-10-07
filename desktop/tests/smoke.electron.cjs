// Real Electron integration using ONLY a local fixture worker, never BOSS or account storage.
const { app, BrowserWindow, protocol, session } = require('electron');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { APP_ORIGIN, createAppProtocol } = require('../app-protocol.cjs');
const base = path.resolve(__dirname, '../../data');
const dir = fs.mkdtempSync(path.join(base, 'electron-smoke-'));
app.setPath('userData', path.join(dir, 'profile'));
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: 'boss-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
let server, window;
const seen = [];
const resultFile = path.join(base, 'electron-smoke-result.json');
async function main() {
  const config = { llm: { connectionMode: 'deepseek-web', model: 'deepseek-v4-flash', baseUrl: '', apiKey: '', temperature: .7 },
    filter: { cityName: '上海', cityCode: '101020100', degree: ['本科'], experience: [], hrActiveDaysLimit: 3, companyBlacklist: [], requiredKeywords: [], minLlmMatchScore: 75, workRequirements: [] },
    delivery: { dailyMaxQuota: 80, jobSource: 'saved_expectations' }, targetPositions: [] };
  const stats = { status: 'idle', isPaused: false, needsCaptchaVerification: false, todayAppliedCount: 0, dailyMaxQuota: 80, totalScanned: 0, passedFilterCount: 0, markedNotSuitCount: 0, skippedByLlmErrorCount: 0 };
  server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.headers['x-boss-desktop-token'] !== 'fixture-private-token') { res.writeHead(401); res.end(); return; }
    if (req.url === '/api/delivery/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: ' + JSON.stringify({ type: 'init', stats, logs: [] }) + '\n\n');
      return;
    }
    if (req.url === '/api/fixture/binary') { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="fixture.pdf"' }); res.end(Buffer.from([1, 2, 255])); return; }
    if (req.url === '/api/fixture/upload') {
      const chunks = []; req.on('data', data => chunks.push(data)); req.on('end', () => {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, multipart: /multipart\/form-data; boundary=/.test(req.headers['content-type']), chinese: Buffer.concat(chunks).toString().includes('中文测试简历') }));
      }); return;
    }
    const data = req.url === '/api/config' ? config
      : req.url === '/api/resume/current' ? { source: null }
      : req.url === '/api/boss/positions' ? { categories: [], source: 'fixture', fetchedAt: new Date().toISOString() }
      : req.url === '/api/browser/status' ? { isLoggedIn: false, isBrowserActive: false, reasonCode: 'automation_blocked', reason: '模拟账号停止' }
      : req.url === '/api/boss/automation-safety' ? { blocked: true, hold: { id: 'fixture-hold', reason: 'user_reported_ban', message: '模拟账号停止，等待人工确认', detectedAt: new Date().toISOString() } }
      : req.url === '/health' ? { app: 'boss-job-agent', integrationVersion: 29, status: 'ok' } : [];
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await app.whenReady();
  const url = 'http://127.0.0.1:' + server.address().port;
  protocol.handle('boss-app', createAppProtocol({ clientDir: path.resolve(__dirname, '../../client/dist'), getService: () => ({ url, token: 'fixture-private-token' }) }));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  window = new BrowserWindow({ show: false, width: 1320, height: 860, frame: false,
    webPreferences: { preload: path.resolve(__dirname, '../preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await window.loadURL(APP_ORIGIN + '/');
  const result = await window.webContents.executeJavaScript(`(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i=0; i<60 && !document.querySelector('.boss-safety-panel.blocked'); i++) await sleep(100);
    const form = new FormData(); form.append('resume', new Blob(['中文测试简历']), '测试.pdf');
    const upload = await fetch('/api/fixture/upload', { method: 'POST', body: form }).then(r => r.json());
    const binary = [...new Uint8Array(await fetch('/api/fixture/binary').then(r=>r.arrayBuffer()))];
    const stream = await new Promise((resolve, reject) => {
      const events = new EventSource('/api/delivery/events');
      const timeout = setTimeout(() => { events.close(); reject(new Error('SSE timed out')); }, 4000);
      events.onmessage = event => { clearTimeout(timeout); events.close(); resolve(JSON.parse(event.data).type); };
    });
    return { protocol: location.protocol, desktop: window.bossDesktop?.platform, hasNode: typeof window.require !== 'undefined',
      titlebar: !!document.querySelector('.desktop-titlebar'), safety: !!document.querySelector('.boss-safety-panel.blocked'),
      upload, binary, stream, text: document.body.innerText };
  })()`);
  assert.equal(result.protocol, 'boss-app:'); assert.equal(result.desktop, 'windows'); assert.equal(result.hasNode, false);
  assert.equal(result.titlebar, true); assert.equal(result.safety, true); assert.equal(result.stream, 'init');
  assert.equal(result.upload.chinese, true); assert.equal(result.upload.multipart, true); assert.deepEqual(result.binary, [1, 2, 255]);
  const downloaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('native PDF download timed out')), 4000);
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(path.join(dir, 'fixture.pdf'));
      item.once('done', (_event, state) => { clearTimeout(timer); state === 'completed' ? resolve() : reject(new Error(state)); });
    });
  });
  await window.webContents.executeJavaScript(`(() => { const link = document.createElement('a'); link.href='/api/fixture/binary'; link.download='fixture.pdf'; document.body.appendChild(link); link.click(); link.remove(); })()`);
  await downloaded; assert.deepEqual([...fs.readFileSync(path.join(dir, 'fixture.pdf'))], [1, 2, 255]);
  await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('筛选规则')).click()`);
  const rules = await window.webContents.executeJavaScript('document.body.innerText');
  assert.ok(!rules.includes('选择岗位的浏览间隔')); assert.ok(!rules.includes('网页操作频率')); assert.ok(rules.includes('每日自动投递数'));
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 150))');
  fs.writeFileSync(path.join(base, 'electron-workbench-preview.png'), (await window.webContents.capturePage()).toPNG());
  fs.writeFileSync(resultFile, JSON.stringify({ passed: true, ...result, text: undefined, requests: seen }, null, 2));
  window.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.exit(0);
}
main().catch(error => {
  fs.writeFileSync(resultFile, JSON.stringify({ passed: false, error: error.stack }, null, 2));
  window?.destroy(); server?.closeAllConnections(); server?.close(); app.exit(1);
});
