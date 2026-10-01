import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserService } from '../src/services/browser.service.js';
import { CdpConnection } from '../src/services/cdp.page.js';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-lifecycle-test-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/browser-owner.ts'], {
    cwd: process.cwd(), env: { ...process.env, BOSS_LIFECYCLE_TEST_PROFILE: profile },
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr?.on('data', (data) => { errors += data.toString(); });
  let reconnected: BrowserService | undefined;
  let runtime: { port: number; browserIdentity: string } | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('测试浏览器启动超时：' + errors)), 25000);
      child.once('message', (message: any) => { clearTimeout(timer); message.ready ? resolve() : reject(new Error('测试窗口未就绪')); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`测试后台提前退出 ${code}：${errors}`)); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    runtime = JSON.parse(fs.readFileSync(path.join(profile, 'boss-browser-runtime.json'), 'utf8'));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.send('exit');
    await exited;
    await pause(500);
    const version = await (await fetch(`http://127.0.0.1:${runtime!.port}/json/version`, { signal: AbortSignal.timeout(2000) })).json() as any;
    assert.equal(new URL(version.webSocketDebuggerUrl).pathname, runtime!.browserIdentity, '原后台退出后 Chrome 实例必须保持运行');
    reconnected = new BrowserService(profile, { headless: true });
    const page = await reconnected.getWorkerPage();
    await page.goto('data:text/html;charset=utf-8,<body>reconnected fixture</body>');
    assert.match(await page.evaluate(() => document.body.innerText), /reconnected fixture/);
    assert.equal((reconnected as any).chrome, null, '新后台应重连原实例，不能再启动 Chrome');
    await reconnected.close();
    const stillAlive = await fetch(`http://127.0.0.1:${runtime!.port}/json/version`, { signal: AbortSignal.timeout(2000) });
    assert.equal(stillAlive.ok, true, '断开复用连接不能关闭用户窗口');
    process.stdout.write('PASS | 真实 Chrome 生命周期：原后台退出保留实例，新后台重连，断开连接保留窗口\n');
  } finally {
    if (child.exitCode === null) child.kill();
    await reconnected?.close();
    runtime ??= fs.existsSync(path.join(profile, 'boss-browser-runtime.json'))
      ? JSON.parse(fs.readFileSync(path.join(profile, 'boss-browser-runtime.json'), 'utf8')) : undefined;
    if (runtime) {
      try {
        const version = await (await fetch(`http://127.0.0.1:${runtime.port}/json/version`, { signal: AbortSignal.timeout(1000) })).json() as any;
        assert.equal(new URL(version.webSocketDebuggerUrl).pathname, runtime.browserIdentity);
        const connection = await CdpConnection.connect(version.webSocketDebuggerUrl);
        await connection.send('Browser.close', {}, 2000).catch(() => {});
        connection.close();
      } catch { /* 测试窗口已经结束。 */ }
    }
    const resolved = path.resolve(profile);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('boss-lifecycle-test-')) {
      throw new Error('测试目录不在指定临时范围');
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      try { fs.rmSync(resolved, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 19) throw error; await pause(150); }
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
