import './fixtures/activate-isolated-safety.js';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { BossMessageRecommendations } from '../src/services/boss-message-recommendations.js';
import { browserService } from '../src/services/browser.service.js';
import { bossPageService } from '../src/services/boss.page.service.js';
async function main() {
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const oldPage = browserService.getWorkerPage, oldLogin = bossPageService.ensureLoggedIn;
  try {
    const page = await browser.newPage();
    await page.route('**/*', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8"><div class="chat-user"><div class="chat-content"><div class="user-list"></div></div></div><div class="chat-record"><a href="/job_detail/header-old.html">已沟通岗位</a></div><textarea>用户自己的草稿</textarea>' }));
    await page.goto('https://www.zhipin.com/web/geek/chat');
    await page.evaluate(() => {
      const root = document.createElement('div'); root.className = 'chat-conversation';
      (root as any).__vue__ = { $store: { state: { userInfo: { userId: 'fixture-account' } } } }; document.body.appendChild(root);
      const sources = [
        { sourceTitle: '荐', encryptJobId: 'recommended~', jobName: '行政支持', brandName: '虚构公司' },
        { sourceTitle: '', encryptJobId: 'ordinary-greeting', jobName: '普通新招呼', brandName: '其他公司' },
        { sourceTitle: '荐', encryptJobId: 'recommended~', jobName: '行政支持', brandName: '虚构公司' },
        { sourceTitle: '荐', encryptJobId: 'bad/id', jobName: '无效链接', brandName: '其他公司' },
        { sourceTitle: '荐', encryptJobId: 'filtered', isFiltered: true, jobName: '已过滤', brandName: '其他公司' },
        { sourceTitle: '荐', jobName: '缺编号', brandName: '其他公司' },
      ];
      for (const source of sources) { const node = document.createElement('div'); node.className = 'friend-content-warp'; node.textContent = '消息行';
        (node as any).__vue__ = { $props: { source } }; document.querySelector('.user-list')!.appendChild(node); }
    });
    (browserService as any).getWorkerPage = async () => page; bossPageService.ensureLoggedIn = async () => {};
    const source = new BossMessageRecommendations(), cards = await source.cards();
    assert.equal(cards.length, 1, '只导入有荐标记且有效编号的职位，并去重；普通招呼和聊天头部不算推荐');
    assert.equal(cards[0].jobHref, 'https://www.zhipin.com/job_detail/recommended~.html');
    assert.equal(cards[0].cardLocator, null, '按稳定链接读详情，不点击聊天行');
    assert.equal(await page.locator('textarea').inputValue(), '用户自己的草稿');
    await page.evaluate(() => { document.querySelector('.user-list')!.replaceChildren(); document.querySelector('.user-list')!.textContent = '暂无消息'; });
    assert.equal((await source.cards()).length, 0, '没有荐标记时不伪造来源');
    console.log('PASS | message recommendation marker, stable linked jobs, dedup, filtered/invalid exclusion, ordinary greetings/header/draft untouched');
  } finally { browserService.getWorkerPage = oldPage; bossPageService.ensureLoggedIn = oldLogin; await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });

