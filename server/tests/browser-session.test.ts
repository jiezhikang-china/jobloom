import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { BrowserService } from '../src/services/browser.service.js';
import { isolateBossSafety } from './fixtures/safety.js';

async function main(): Promise<void> {
  const restoreSafety = isolateBossSafety();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-session-test-'));
  const profile = path.join(tempRoot, 'profile');
  fs.mkdirSync(path.join(profile, 'Default', 'Network'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Network', 'Cookies'), 'fixture');
  const service = new BrowserService(profile);
  const identity = '/devtools/browser/session-test';
  let noTabs = false;
  const debugServer = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    const port = (debugServer.address() as net.AddressInfo).port;
    response.end(JSON.stringify(request.url === '/json/version'
      ? { webSocketDebuggerUrl: `ws://127.0.0.1:${port}${identity}` }
      : noTabs ? [] : [{ id: 'fixture', type: 'page', url: 'about:blank' }]));
  });
  await new Promise<void>((resolve) => debugServer.listen(0, '127.0.0.1', resolve));
  const debugPort = (debugServer.address() as net.AddressInfo).port;
  let reconnects = 0;
  (service as any).port = 12345;
  (service as any).ensureChrome = async () => { reconnects++; };
  (service as any).hasSessionCookie = async () => false;
  (service as any).listTabs = async () => [];
  try {
    const status = await service.checkLoginStatus();
    assert.equal(reconnects, 1, '已有端口时仍须检查并恢复保存的会话');
    assert.equal(status.reasonCode, 'browser_unavailable', '浏览器连接故障不能误报为需要扫码');
    const runtimePath = path.join(profile, 'boss-browser-runtime.json');
    fs.writeFileSync(runtimePath, JSON.stringify({ port: debugPort, browserIdentity: identity }));
    const reconnected = new BrowserService(profile);
    await (reconnected as any).ensureChrome(false);
    assert.equal((reconnected as any).port, debugPort, '后端重启时复用既有专用 Chrome');
    assert.equal((reconnected as any).chrome, null, '不能启动占用同一资料目录的第二个 Chrome');
    await reconnected.close();
    assert.equal((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok, true, '断开连接不能结束复用的浏览器');
    noTabs = true;
    const noTabBrowser = new BrowserService(profile);
    await (noTabBrowser as any).ensureChrome(false);
    assert.equal((noTabBrowser as any).port, debugPort, '浏览器已启动但暂时没有标签页时仍复用，不争抢资料目录');
    assert.equal((noTabBrowser as any).chrome, null);
    await noTabBrowser.close();
    fs.writeFileSync(runtimePath, JSON.stringify({ port: debugPort, browserIdentity: identity + '-wrong' }));
    assert.equal(await (reconnected as any).tryReconnectChrome(), false, '其他浏览器占用同一端口时不能错误复用');
    assert.equal((reconnected as any).port, null);
    process.stdout.write('PASS | 已保存会话重连、后台重启复用浏览器、实例标识验证与扫码提示区分\n');
  } finally {
    restoreSafety();
    await service.close();
    await new Promise<void>((resolve, reject) => debugServer.close((error) => error ? reject(error) : resolve()));
    const resolved = path.resolve(tempRoot);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录超出临时文件夹');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
