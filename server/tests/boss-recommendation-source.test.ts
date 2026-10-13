import './fixtures/activate-isolated-safety.js';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { BossPageService } from '../src/services/boss.page.service.js';
import { browserService } from '../src/services/browser.service.js';
import { bossActionScheduler } from '../src/services/boss-action-scheduler.js';
const restores: Array<() => void> = [];
function stub(obj: any, key: string, value: any) { const old = obj[key]; obj[key] = value; restores.push(() => obj[key] = old); }
async function main() {
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8">
      <div class="c-expect-select"><a class="synthesis" ka="jobs_recommend_tab_click" href="javascript:;">推荐</a>
      <div class="expect-list"><a class="expect-item active">行政(上海)</a></div></div>
      <ul class="rec-job-list"><li class="job-card-box"><a class="job-name" href="/job_detail/old.html">旧目标岗位</a>
      <span class="job-salary">5-6K</span><ul class="tag-list"><li>大专</li><li>经验不限</li></ul>
      <div class="job-card-footer"><span class="boss-name">虚构公司</span><span class="company-location">上海·徐汇区</span></div></li></ul>
      <script>window.selections=0;document.querySelector('.synthesis').onclick=()=>{window.selections++;document.querySelector('.synthesis').classList.add('active');
      document.querySelector('.expect-item').classList.remove('active');document.querySelector('.job-name').href='/job_detail/recommended~.html?ka=fixture';document.querySelector('.job-name').textContent='推荐行政岗位';};</script>` }));
    await page.goto('https://www.zhipin.com/web/geek/jobs');
    stub(browserService, 'getWorkerPage', async () => page); stub(browserService, 'checkLoginStatus', async () => ({ isLoggedIn: true, isBrowserActive: true }));
    stub(bossActionScheduler, 'run', async (_kind: any, action: any) => action()); stub(bossActionScheduler, 'waitForElapsed', async () => {});
    const source = new BossPageService();
    await source.initJobPage('不可搜索这个词', '101010100', '100901', { recommendation: true });
    assert.equal(await page.evaluate(() => (window as any).selections), 1);
    assert.equal(new URL(page.url()).searchParams.get('query'), null, '推荐源不能被搜索词覆盖');
    assert.equal(new URL(page.url()).searchParams.get('position'), null, '推荐源不能被岗位分类覆盖');
    assert.equal(new URL(page.url()).searchParams.get('city'), '101010100', '当前城市仍应用于推荐列表');
    const cards = await source.getVisibleJobCards(); assert.equal(cards.length, 1); assert.equal(cards[0].jobName, '推荐行政岗位');
    assert.match(cards[0].jobHref, /recommended~\.html/);
    await source.initJobPage(undefined, undefined, undefined, { recommendation: true });
    assert.equal(await page.evaluate(() => (window as any).selections), 1, '已经选中推荐时不重复点击');
    await page.evaluate(() => document.querySelector('.synthesis')!.remove());
    await assert.rejects(() => source.initJobPage(undefined, undefined, undefined, { recommendation: true }), /推荐入口未找到/);
    console.log('PASS | actual recommendation selector, source switching, card extraction, no search/classification override or duplicate clicks');
  } finally { restores.reverse().forEach(fn => fn()); await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

