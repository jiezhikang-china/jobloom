'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('../../node_modules/playwright-core');
async function main() {
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const context = await browser.newContext();
  const events = [];
  const source = fs.readFileSync(path.join(__dirname, 'observer.js'), 'utf8')
    .replace('__BINDING_NAME__', JSON.stringify('__manualTest')).replace('__CLEANUP_KEY__', JSON.stringify('__manualCleanup'));
  await context.exposeBinding('__manualTest', (_source, value) => { events.push(JSON.parse(value)); });
  await context.addInitScript(source);
  let intercepted = 0;
  await context.route('**/*', route => {
    intercepted++;
    const body = route.request().url().includes('/gongsi/') ? '<body>离线公司简介</body>'
      : '<body><button id="other">测试控件</button><input id="query"><div class="job-card-box"><a class="job-name">离线岗位</a></div>'
        + '<div class="job-detail-box"><div class="job-detail-body"><p class="desc"></p></div><button class="op-btn-chat">立即沟通</button>'
        + '<button id="confirm">继续沟通</button><a id="company" target="_blank" href="https://www.zhipin.com/gongsi/fixture.html">公司</a></div>'
        + '<script>document.querySelector(".job-card-box").onclick=()=>document.querySelector(".desc").textContent="负责资料整理与客服咨询，核对售后订单，按安排完成内容记录。"</script></body>';
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  try {
    const page = await context.newPage(); await page.goto('https://www.zhipin.com/web/geek/jobs');
    await page.locator('.job-card-box').click();
    for (let i = 0; i < 30 && !events.some(e => e.kind === 'detail_ready'); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(events.some(e => e.kind === 'select')); assert.ok(events.some(e => e.kind === 'detail_ready'));
    const before = events.length; await page.locator('#other').evaluate(el => el.click());
    assert.equal(events.length, before, '脚本模拟点击不能算作人的控件点击');
    await page.locator('#query').fill('不应保存的私有文字');
    await page.locator('.op-btn-chat').click(); await page.locator('#confirm').click();
    const popupPromise = page.waitForEvent('popup'); await page.locator('#company').click();
    const popup = await popupPromise; await popup.waitForLoadState('domcontentloaded');
    for (let i = 0; i < 30 && !events.some(e => e.kind === 'company_ready'); i++) await new Promise(resolve => setTimeout(resolve, 100));
    for (const kind of ['company', 'company_ready', 'submit', 'confirm']) assert.ok(events.some(e => e.kind === kind), kind);
    assert.ok(events.every(e => Object.keys(e).sort().join(',') === 'at,kind'));
    assert.doesNotMatch(JSON.stringify(events), /私有文字|离线公司简介|Cookie|负责资料/);
    await page.evaluate(() => window.__manualCleanup());
    const after = events.length; await page.locator('#other').click();
    assert.equal(events.length, after, '结束后清除采样监听');
    assert.ok(intercepted >= 2);
    console.log('PASS | 离线真实浏览器点击、详情出现、公司页、沟通确认、非可信点击隔离、输入正文不保存、停止后移除监听；无真实网站请求');
  } finally { await context.close(); await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });