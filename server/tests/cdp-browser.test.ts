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
    await fixturePage.route('**/*', async (route) => {
      if (new URL(route.request().url()).hostname !== 'www.zhipin.com') { await route.abort(); return; }
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
    cdpPage = await new CdpPage(target.id, await CdpConnection.connect(target.webSocketDebuggerUrl), target.url, false).initialize();
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
    await cdpPage.evaluate(() => {
      const button = document.createElement('button'); button.id = 'native-click-test'; button.textContent = '测试';
      const state = { count: 0, trusted: false, buttons: 0 }; (window as any).clickTest = state;
      button.addEventListener('mousedown', event => { state.buttons = event.buttons; });
      button.addEventListener('click', event => { state.count++; state.trusted = event.isTrusted; });
      document.body.append(button);
    });
    await cdpPage.locator('#native-click-test').click();
    assert.deepEqual(await cdpPage.evaluate(() => (window as any).clickTest), { count: 1, trusted: true, buttons: 1 }, '连接到 Chrome 后须真正派发一次点击');
    await fixturePage.evaluate(() => {
      document.body.innerHTML = '<style>body{margin:0}.viewport{position:relative;width:300px;height:160px;overflow:auto}button{height:40px}</style>'
        + '<div class="viewport"><button id="visible">可见</button><div style="height:400px"></div><button id="clipped">容器外</button>'
        + '<button id="hidden" style="display:none">隐藏</button></div>';
      const state = { visible: 0, clipped: 0 }; (window as any).geometryClicks = state;
      document.querySelector('#visible')!.addEventListener('click', () => { state.visible++; });
      document.querySelector('#clipped')!.addEventListener('click', () => { state.clipped++; });
    });
    await cdpPage.locator('#visible').click();
    assert.equal(await fixturePage.locator('.viewport').evaluate(element => element.scrollTop), 0, '可见控件不能被强制居中');
    await cdpPage.locator('#clipped').click();
    const afterOffscreen = await fixturePage.locator('.viewport').evaluate(element => element.scrollTop);
    assert.ok(afterOffscreen > 0, '被嵌套滚动容器裁剪的控件必须先滚入可见区域');
    assert.deepEqual(await fixturePage.evaluate(() => (window as any).geometryClicks), { visible: 1, clipped: 1 });
    assert.equal(await fixturePage.evaluate(() => window.scrollY), 0, '只滚动所需的内层容器');
    await fixturePage.evaluate(() => {
      const parent = document.querySelector('.viewport')!, target = document.querySelector('#clipped')!;
      parent.scrollTop += target.getBoundingClientRect().top - parent.getBoundingClientRect().top - (parent.clientHeight - 12);
    });
    const partiallyVisible = await fixturePage.locator('.viewport').evaluate(element => element.scrollTop);
    await cdpPage.locator('#clipped').scrollIntoViewIfNeeded();
    await cdpPage.locator('#clipped').click();
    assert.equal(await fixturePage.locator('.viewport').evaluate(element => element.scrollTop), partiallyVisible, '可点击部分已可见时不重复滚动');
    assert.equal(await fixturePage.evaluate(() => (window as any).geometryClicks.clipped), 2, '鼠标坐标应在裁剪后仍可见的区域内');
    await assert.rejects(cdpPage.locator('#hidden').click(), /元素不可见/);

    await fixturePage.evaluate(() => {
      document.body.innerHTML = '<style>body{margin:0}.list-viewport{height:180px;width:300px;overflow:auto}li{height:80px}</style>'
        + '<input placeholder="搜索职位、公司"><div class="list-viewport"><ul class="rec-job-list"></ul></div>';
      const list = document.querySelector('ul')!;
      for (let i = 0; i < 12; i++) list.insertAdjacentHTML('beforeend', '<li class="job-card-box"><a class="job-name" href="/job_detail/' + i + '.html">测试岗位</a></li>');
      (window as any).listScrolls = 0;
      document.querySelector('.list-viewport')!.addEventListener('scroll', () => {
        (window as any).listScrolls++;
        setTimeout(() => list.insertAdjacentHTML('beforeend', '<li class="job-card-box"><a class="job-name" href="/job_detail/new.html">新岗位</a></li>'), 60);
      }, { once: true });
    });
    const originalAction = cdpPage.action.bind(cdpPage), actions: string[] = [];
    cdpPage.action = (kind, work, targetUrl) => { actions.push(kind); return originalAction(kind, work, targetUrl); };
    const loadingStarted = Date.now();
    await service.scrollDownForMore();
    assert.deepEqual(actions, ['list'], '加载更多只进入一次队列，不能先滚动控件再排队滚动列表');
    assert.equal(await fixturePage.evaluate(() => (window as any).listScrolls), 1, '加载更多只有一次滚动');
    assert.ok(await fixturePage.locator('a[href="/job_detail/new.html"]').count());
    assert.ok(Date.now() - loadingStarted < 800, '新岗位已显示就返回，不再固定等待900ms');

    await fixturePage.evaluate(() => {
      document.querySelector('.list-viewport')!.addEventListener('scroll', () => {
        setTimeout(() => { document.body.innerHTML = '<div class="boss-login-dialog">登录 / 注册</div>'; }, 40);
      }, { once: true });
    });
    await assert.rejects(service.scrollDownForMore(), /登录已失效/, '等待加载期间出现登录页应立即交由人工处理');
    process.stdout.write('PASS | 真实 Chrome CDP + 离线页面：文档与SPA就绪、裁剪后原生点击、可见目标不滚动、列表单次滚动与提前就绪、登录中断\n');
  } finally {
    (browserService as any).getWorkerPage = originalWorker;
    (browserService as any).checkLoginStatus = originalLogin;
    cdpPage?.closeConnection();
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
