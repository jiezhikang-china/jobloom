import assert from 'node:assert/strict';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { CdpConnection, CdpPage } from '../src/services/cdp.page.js';
import { browserService } from '../src/services/browser.service.js';
import { BossPageService } from '../src/services/boss.page.service.js';

const names = ['客服(上海)', '数据采集(上海)', '数据标注(上海)', '行政(上海)'];
const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <div class="c-expect-select"><a class="synthesis">推荐</a><div class="expect-list">
    <a class="expect-item" style="display:none">隐藏入口</a>${names.map((name) => '<a class="expect-item">' + name + '</a>').join('')}
  </div></div><ul class="rec-job-list"></ul><div class="job-detail-box"></div>
  <div class="zp-feedback-dialog" style="display:none"><h3 class="zp-title">隐藏弹窗</h3></div>
  <script>
    window.submissions = []; window.showFeedback = true; window.recommendClicks = 0;
    window.neutralOption = true; window.requiresReason = false;
    function list(index) {
      document.querySelector('.rec-job-list').innerHTML = '<li class="job-card-box"><a class="job-name" href="/job_detail/' + index + '.html">岗位' + index + '</a>' +
        '<span class="job-salary">6-8K</span><ul class="tag-list"><li>1-3年</li><li>大专</li></ul>' +
        '<div class="job-card-footer"><span class="company-location">上海</span><span class="boss-name">公司' + index + '</span></div></li>';
      document.querySelector('.job-detail-box').innerHTML = '';
      document.querySelector('.job-card-box').onclick = function(event) {
        event.preventDefault();
        document.querySelector('.job-detail-box').innerHTML = '<div class="job-detail-info"><span class="job-name">岗位' + index + '</span></div>' +
          '<a class="more-job-btn" href="/job_detail/' + index + '.html">更多</a>' +
          '<div class="job-detail-body"><p class="desc">工作面议</p><div class="job-detail-operate"><span class="not-suitable">不合适</span></div></div>';
        document.querySelector('.not-suitable').onclick = function() {
          var d = document.createElement('div'); d.className = 'zp-feedback-dialog';
          d.innerHTML = '<h3 class="zp-title">选择原因，减少不合适职位推荐</h3><ul><li class="zp-type-item">“公司' + index + '”公司</li>' +
            (window.neutralOption ? '<li class="zp-type-item">职位不匹配</li>' : '<li class="zp-type-item">其他</li>') + '</ul><textarea class="zp-type-textarea" maxlength="50"></textarea>' +
            '<span class="zp-btn-sure" ka="dialog_sure">确定</span><span ka="dialog_cancel">取消</span>';
          document.body.appendChild(d);
          d.querySelectorAll('.zp-type-item').forEach(function(item) { item.onclick = function() { this.classList.add('active'); }; });
          d.querySelector('[ka="dialog_cancel"]').onclick = function() { d.remove(); };
          d.querySelector('[ka="dialog_sure"]').onclick = function() {
            var reason = d.querySelector('textarea').value; if (window.requiresReason && !reason) return;
            window.submissions.push({ index: index, reason: reason, company: d.querySelector('.zp-type-item').classList.contains('active') }); d.remove();
            if (window.showFeedback) { var t = document.createElement('div'); t.className = 'zp-toast'; t.textContent = '已进行反馈';
              document.body.appendChild(t); setTimeout(function() { t.remove(); }, 600); }
          };
        };
      };
    }
    list('recommended');
    document.querySelector('.synthesis').onclick = function() { window.recommendClicks++; list('recommended'); };
    document.querySelectorAll('.expect-item').forEach(function(tab, index) { tab.onclick = function() {
      document.querySelectorAll('.expect-item').forEach(function(t) { t.classList.remove('active'); }); tab.classList.add('active');
      setTimeout(function() { list(index - 1); }, 80);
    }; });
  </script></body></html>`;

async function main() {
  const port = await new Promise<number>((resolve) => {
    const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => {
      const value = (probe.address() as net.AddressInfo).port; probe.close(() => resolve(value));
    });
  });
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true, args: ['--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1'] });
  const getWorker = browserService.getWorkerPage;
  const login = browserService.checkLoginStatus;
  let page: CdpPage | undefined;
  try {
    const fixturePage = await browser.newPage();
    let navigations = 0;
    await fixturePage.route('https://www.zhipin.com/**', (route) => { navigations++; return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }); });
    const tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json() as any[];
    const target = tabs.find((tab) => tab.type === 'page');
    page = await new CdpPage(target.id, await CdpConnection.connect(target.webSocketDebuggerUrl), target.url).initialize();
    browserService.getWorkerPage = async () => page!;
    browserService.checkLoginStatus = async () => ({ isLoggedIn: true, isBrowserActive: true });
    const remembered: string[] = [];
    const service = new BossPageService({ pageReadyTimeoutMs: 2500, pagePollIntervalMs: 30, rememberNotSuitable: target => { remembered.push(target.companyName); } });
    await page.goto('https://www.zhipin.com/web/geek/jobs?jobType=1903');
    assert.deepEqual(await service.getSavedExpectationNames(), names, '读取全部可见自选期望，不写死数量');
    for (const [index, name] of names.entries()) {
      await service.initJobPage('不应该搜索', '101020100', '100901', { expectationName: name });
      assert.equal((await service.getVisibleJobCards())[0].jobName, '岗位' + index);
      assert.equal(new URL(page.url()).searchParams.get('jobType'), '1903', '切换自选期望保留当前 BOSS 页面设置');
    }
    assert.equal(navigations, 1, '自选期望在原页切换，避免重复打开网页');
    assert.equal(await page.evaluate(() => (window as any).recommendClicks), 0);
    const card = (await service.getVisibleJobCards())[0];
    assert.equal(await service.markJobNotSuit(card.cardLocator, { ...card, jobHref: '/job_detail/wrong.html' }), false);
    assert.equal(await service.markJobNotSuit(card.cardLocator, card, '公司页没有公司介绍'), true,
      '短或模糊描述也能打开目标详情，操作可见反馈弹窗并确认成功');
    assert.deepEqual(await page.evaluate(() => (window as any).submissions), [{ index: 3, reason: '', company: true }], '优先选公司内置选项，内部淘汰理由不上传');
    assert.deepEqual(remembered, ['公司3'], '过期目标不记错公司，正确淘汰目标保存本地');
    await page.evaluate(() => { (window as any).showFeedback = false; document.querySelectorAll('.zp-toast').forEach((item) => item.remove()); });
    assert.equal(await service.markJobNotSuit(card.cardLocator, card, '职责不清晰'), false, '没有确认信号不计入成功');
    assert.equal(await page.evaluate(() => (window as any).submissions.length), 2, '不反复点击确定');
    await page.evaluate(() => { (window as any).neutralOption = false; (window as any).requiresReason = true; });
    assert.equal(await service.markJobNotSuit(card.cardLocator, card, '涉及助贷，我的个人信息不得发给平台'), false);
    assert.equal(await page.evaluate(() => (window as any).submissions.length), 2, '平台必须填写文字时取消，无本地理由提交');
    assert.equal(await page.locator('.zp-feedback-dialog').filter({ visible: true }).evaluateAll(items => items.length), 0);
    console.log('PASS | 真实 CDP：动态自选期望、原页切换、优先屏蔽公司、零内部理由上传、本地记录、必填文字取消、平台成功信号');
  } finally { browserService.getWorkerPage = getWorker; browserService.checkLoginStatus = login; page?.closeConnection(); await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
