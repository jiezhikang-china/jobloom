import { spawn, type ChildProcess } from 'node:child_process';
import './fixtures/activate-isolated-safety.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { chromium, type BrowserContext } from 'playwright-core';
import { BrowserService } from '../src/services/browser.service.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  return new Promise<number>(resolve => {
    const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port; probe.close(() => resolve(port));
    });
  });
}
async function main() {
  const root = path.resolve(process.cwd(), '../data');
  const dir = fs.mkdtempSync(path.join(root, 'boss-rest-test-'));
  const profile = path.join(dir, 'profile'); fs.mkdirSync(profile);
  let context: BrowserContext | undefined;
  let chromeChild: ChildProcess | undefined;
  const service = new BrowserService(profile, { headless: true });
  const unrelated = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const unrelatedPage = await unrelated.newPage();
  await unrelatedPage.setContent('<body>other browser</body>');
  let port = 0, identity = '', blockedRequests = 0;
  const launch = async () => {
    port = await freePort();
    chromeChild = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
      '--user-data-dir=' + profile, '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--headless=new', '--new-window', 'data:text/html,<body>offline</body>',
    ], { detached: true, windowsHide: true, stdio: 'ignore' });
    let available = false;
    for (let i = 0; i < 50; i++) {
      try { await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(500) }); available = true; break; }
      catch { await pause(100); }
    }
    assert.equal(available, true, '原生 Chrome 启动成功');
    const connected = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    context = connected.contexts()[0];
    await context.route('**/*', route => {
      blockedRequests++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<body><ul class="rec-job-list"><li class="job-card-box">离线职位样例</li></ul></body>' });
    });
    const fixture = context.pages()[0];
    await fixture.goto('https://www.zhipin.com/web/geek/jobs');
    const version = await fetch('http://127.0.0.1:' + port + '/json/version').then(r => r.json()) as any;
    identity = new URL(version.webSocketDebuggerUrl).pathname;
    fs.writeFileSync(path.join(profile, 'boss-browser-runtime.json'), JSON.stringify({ port, browserIdentity: identity }));
    (service as any).port = port;
  };
  try {
    await launch();
    await context!.addCookies([{ name: 'wt2', value: 'offline-fixture-cookie', domain: 'www.zhipin.com', path: '/',
      expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: true }]);
    assert.equal((await context!.cookies()).find(c => c.name === 'wt2')?.value, 'offline-fixture-cookie', '关闭前 fixture Cookie 确实存在');
    const originalIdentity = identity, originalPort = port;
    const oldPage = await service.getWorkerPage();
    assert.equal((service as any).chrome, null, '模拟桌面重启后复用的 Chrome，无自有子进程句柄');
    assert.equal(await service.suspendForRest(), true);
    await assert.rejects(fetch('http://127.0.0.1:' + originalPort + '/json/version', { signal: AbortSignal.timeout(1500) }));
    assert.equal(oldPage.isClosed(), true);
    assert.equal(fs.existsSync(path.join(profile, 'boss-browser-runtime.json')), false);
    assert.equal((await service.checkLoginStatus({ restore: false })).reasonCode, 'resting');
    await assert.rejects(service.getWorkerPage(), /正在关闭休息/, '状态查询和业务入口不能在休息中偷偷重开');
    assert.equal(await unrelatedPage.innerText('body'), 'other browser', '不能关闭其他 Chrome 实例');
    (service as any).ensureChrome = async () => { if (!(service as any).port) await launch(); };
    await pause(500);
    await service.resumeAfterRest();
    assert.notEqual(identity, originalIdentity, '必须是新的真实浏览器实例');
    const newPage = await service.getWorkerPage();
    assert.notEqual(newPage.id, oldPage.id);
    const cookies = await context!.cookies('https://www.zhipin.com');
    assert.equal(cookies.find(c => c.name === 'wt2')?.value, 'offline-fixture-cookie', '正常关闭并重开同一 profile 后保留 Cookie');
    assert.equal((await service.checkLoginStatus({ restore: false })).isLoggedIn, true);
    assert.ok(blockedRequests >= 2, '所有 BOSS 地址都由离线 fixture 拦截，无真实网站请求');
    await service.suspendForRest();
    console.log('PASS | 真实 Chrome 关闭重连实例、完整退出、新实例与页面、Cookie持久化、休息入口门控、其他浏览器保留；全部网站请求离线拦截');
  } finally {
    await context?.close().catch(() => {});
    await service.close();
    await unrelated.close();
    if (chromeChild?.exitCode === null) chromeChild.kill();
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(root + path.sep) && path.basename(resolved).startsWith('boss-rest-test-'));
    for (let i = 0; i < 25; i++) {
      try { fs.rmSync(resolved, { recursive: true, force: true }); break; }
      catch (error) { if (i === 24) throw error; await pause(200); }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });