import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserService } from '../src/services/browser.service.js';
import { BossPageService, bossPageService } from '../src/services/boss.page.service.js';

const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <input placeholder="搜索职位、公司" value="前端开发">
  <ul class="rec-job-list">
    <li class="job-card-box" data-key="a">
      <div class="job-info"><div class="job-title"><a class="job-name" href="/job_detail/a.html">前端开发</a><span class="job-salary">15-25K</span></div>
      <ul class="tag-list"><li>3-5年</li><li>本科</li><li>React</li></ul></div>
      <div class="job-card-footer"><span class="company-location">上海·浦东新区</span><a class="boss-info"><span class="boss-name">甲公司</span></a></div>
    </li>
    <li class="job-card-box" data-key="b">
      <div class="job-info"><div class="job-title"><a class="job-name" href="/job_detail/b.html">前端开发</a><span class="job-salary">20-30K</span></div>
      <ul class="tag-list"><li>3-5年</li><li>本科</li><li>TypeScript</li></ul></div>
      <div class="job-card-footer"><span class="company-location">上海·徐汇区</span><a class="boss-info"><span class="boss-name">乙公司</span></a></div>
    </li>
  </ul>
  <div class="job-detail-box"></div>
  <script>
    document.querySelectorAll('.job-card-box').forEach(function (card) {
      card.addEventListener('click', function (event) {
        event.preventDefault();
        var company = card.querySelector('.boss-name').textContent;
        var box = document.querySelector('.job-detail-box');
        var href = card.querySelector('a.job-name').getAttribute('href');
        box.innerHTML = '<div class="job-detail-header"><div class="job-detail-info"><span class="job-name">前端开发</span></div>' +
          '<a class="more-job-btn" href="' + href + '?from=list">查看更多信息</a><a href="javascript:;" class="op-btn-chat">立即沟通</a></div>' +
          '<div class="job-detail-body"><p class="desc">负责前端架构、复杂业务开发、性能优化及团队协作，要求 TypeScript 和 React 实战经验。</p>' +
          '<div class="job-boss-info">' + company + ' · 今日活跃</div></div>';
        box.querySelector('.op-btn-chat').addEventListener('click', function (clickEvent) {
          clickEvent.preventDefault();
          var dialog = document.createElement('div');
          dialog.className = 'dialog-wrap';
          dialog.innerHTML = '<textarea placeholder="打招呼"></textarea><button>发送</button>';
          document.body.appendChild(dialog);
          dialog.querySelector('button').addEventListener('click', function () {
            window.sentText = dialog.querySelector('textarea').value;
            dialog.remove();
            var toast = document.createElement('div');
            toast.className = 'toast-content';
            toast.textContent = '发送成功';
            document.body.appendChild(toast);
            box.querySelector('.op-btn-chat').textContent = '继续沟通';
          });
        });
      });
    });
  </script>
</body></html>`;

async function main(): Promise<void> {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
  });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const originalGetWorkerPage = browserService.getWorkerPage;
  const originalCheckLoginStatus = browserService.checkLoginStatus;
  const readyService = new BossPageService({ pageReadyTimeoutMs: 1200, pagePollIntervalMs: 30 });
  let pageBody = fixture;

  try {
    await page.route('**/web/geek/jobs**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pageBody }));
    (browserService as any).getWorkerPage = async () => page;
    (browserService as any).checkLoginStatus = async () => ({ isLoggedIn: true, isBrowserActive: true });

    await bossPageService.initJobPage('前端开发', '101020100', '100901');
    assert.equal(new URL(page.url()).searchParams.get('position'), '100901');
    assert.equal((await bossPageService.inspectPage(page)).kind, 'jobs');
    await page.evaluate(() => history.replaceState(null, '', location.href + '&_security_check=1_123'));
    assert.equal((await bossPageService.inspectPage(page)).kind, 'jobs', '带安全检查参数但显示职位卡片时仍是职位页');
    const cards = await bossPageService.getVisibleJobCards();
    assert.equal(cards.length, 2, '缺少卡片活跃时间不应让岗位消失');
    assert.equal(cards[0].companyName, '甲公司');
    assert.equal(cards[1].companyName, '乙公司');
    assert.equal(cards[0].cityName, '上海');
    assert.equal(cards[1].cityName, '上海');

    await page.evaluate(() => {
      const list = document.querySelector('.rec-job-list')!;
      list.insertBefore(list.children[1], list.children[0]);
    });
    const target = cards[1];
    assert.equal(await bossPageService.isCardStillTarget(target.cardLocator, target.jobName, target.companyName, target.jobHref), true);

    const detail = await bossPageService.loadJobDetail(target.cardLocator, target.jobName, target.companyName, target.jobHref);
    assert.match(detail.jobDetailText, /TypeScript/);
    assert.equal(detail.activeTimeDesc, '今日活跃');
    assert.equal(await bossPageService.isDetailStillTarget(target.jobName, target.companyName, target.jobHref), true);
    assert.ok(detail.chatButtonLocator);

    const staleTarget = await bossPageService.executeChatClick(detail.chatButtonLocator!, '你好', {
      jobName: '其他职位', companyName: target.companyName, jobHref: target.jobHref,
    });
    assert.equal(staleTarget.targetChanged, true, '目标变化时不能点击沟通');

    const result = await bossPageService.executeChatClick(detail.chatButtonLocator!, '你好，我有相关开发经验。', {
      jobName: target.jobName, companyName: target.companyName, jobHref: target.jobHref,
    });
    assert.equal(result.success, true);
    assert.equal(result.greetingSent, true);
    assert.equal(await page.evaluate(() => (window as any).sentText), '你好，我有相关开发经验。');

    pageBody = `<html><body><script>setTimeout(() => {
      document.body.innerHTML = ${JSON.stringify(fixture.match(/<body>([\s\S]*?)<script>/)![1])};
    }, 450);</script></body></html>`;
    await page.goto('https://www.zhipin.com/web/geek/jobs?query=delay', { waitUntil: 'domcontentloaded' });
    assert.equal((await readyService.inspectPage(page)).kind, 'loading', 'SPA 暂时空白属于加载状态');
    await readyService.initJobPage('前端开发', '101020100', '100901').catch((error) => {
      throw new Error(`${error.message}; 模拟页面脚本错误：${pageErrors.join('; ')}`);
    });
    assert.equal((await readyService.inspectPage(page)).kind, 'jobs', '等待异步职位卡片出现后正常进入列表');
    assert.deepEqual(pageErrors, [], '模拟页面必须正常执行脚本');

    pageBody = '<html><body><input placeholder="搜索职位、公司" value="前端开发"><div class="search-empty">暂无相关职位</div></body></html>';
    await readyService.initJobPage('前端开发');
    assert.equal((await readyService.inspectPage(page)).kind, 'empty', '真实无结果不应判为加载失败');

    pageBody = '<html><body></body></html>';
    const timeoutService = new BossPageService({ pageReadyTimeoutMs: 200, pagePollIntervalMs: 25 });
    await assert.rejects(timeoutService.initJobPage(), /职位页加载超时.*页面正在渲染.*zhipin/);

    pageBody = '<html><body><div class="login-register-box">扫码登录</div></body></html>';
    await assert.rejects(readyService.initJobPage(), /登录已失效/);
    pageBody = '<html><body><div class="geetest_popup">请完成安全验证</div></body></html>';
    await assert.rejects(readyService.initJobPage(), /CAPTCHA_REQUIRED/);
    const transientPage = {
      url: () => 'https://www.zhipin.com/web/geek/jobs',
      evaluate: async () => { throw new Error('Execution context was destroyed'); },
    } as any;
    assert.equal((await readyService.inspectPage(transientPage)).kind, 'loading');
    transientPage.evaluate = async () => { throw new Error('Chrome 页面连接已关闭'); };
    assert.equal((await readyService.inspectPage(transientPage)).kind, 'blocked');

    await page.route('**/web/passport/zp/security.html**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<body>安全验证</body>' }));
    await page.goto('https://www.zhipin.com/web/passport/zp/security.html?code=37');
    assert.equal((await bossPageService.inspectPage(page)).kind, 'captcha');
    process.stdout.write('PASS | 离线 BOSS DOM：延迟渲染、持续空白、无结果、登录、安全验证、卡片、重排、详情、目标校验、发送确认\n');
  } finally {
    (browserService as any).getWorkerPage = originalGetWorkerPage;
    (browserService as any).checkLoginStatus = originalCheckLoginStatus;
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
