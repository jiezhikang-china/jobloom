import assert from 'node:assert/strict';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { CdpConnection, CdpPage } from '../src/services/cdp.page.js';
import { browserService } from '../src/services/browser.service.js';
import { BossPageService } from '../src/services/boss.page.service.js';

async function main(): Promise<void> {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const assigned = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(assigned));
    });
  });
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true, args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
  });
  const originalWorker = browserService.getWorkerPage;
  const originalLogin = browserService.checkLoginStatus;
  let cdpPage: CdpPage | undefined;
  try {
    const fixturePage = await browser.newPage();
    await fixturePage.route('https://www.zhipin.com/**', async (route) => {
      if (route.request().url().endsWith('/bootstrap.js')) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: 'window.bootstrapReady = true;' });
        return;
      }
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head>
        <meta charset="utf-8"><script src="/bootstrap.js" defer></script></head><body><script>
        setTimeout(() => { document.body.innerHTML = '<input placeholder="搜索职位、公司" value="自动化测试">' +
          '<ul class="rec-job-list"><li class="job-card-box"><a class="job-name" href="/job_detail/test.html">自动化测试</a>' +
          '<div class="job-card-footer"><span class="boss-name">模拟公司</span></div></li></ul>'; }, 700);
        </script></body></html>` });
    });
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
    const target = tabs.find((tab) => tab.type === 'page');
    assert.ok(target?.webSocketDebuggerUrl);
    cdpPage = await new CdpPage(target.id, await CdpConnection.connect(target.webSocketDebuggerUrl), target.url).initialize();
    (browserService as any).getWorkerPage = async () => cdpPage;
    (browserService as any).checkLoginStatus = async () => ({ isLoggedIn: true, isBrowserActive: true });
    const service = new BossPageService({ pageReadyTimeoutMs: 2500, pagePollIntervalMs: 40 });
    await cdpPage.goto('https://www.zhipin.com/web/geek/jobs');
    assert.equal(await cdpPage.evaluate(() => (window as any).bootstrapReady), true, '真实 CDP 必须等待新文档的延迟脚本');
    assert.equal((await service.inspectPage(cdpPage)).kind, 'loading');
    await service.initJobPage('自动化测试', '101020100', '100302');
    const state = await service.inspectPage(cdpPage);
    assert.equal(state.kind, 'jobs');
    assert.equal(state.cardCount, 1);
    assert.equal(new URL(cdpPage.url()).searchParams.get('position'), '100302');
    process.stdout.write('PASS | 真实 Chrome CDP + 离线页面：新文档加载、延迟 SPA、自动化测试搜索参数、职位就绪\n');
  } finally {
    (browserService as any).getWorkerPage = originalWorker;
    (browserService as any).checkLoginStatus = originalLogin;
    cdpPage?.closeConnection();
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
