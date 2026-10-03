import assert from 'node:assert/strict';
import path from 'node:path';
import { BrowserService, isSecurityUrl } from '../src/services/browser.service.js';

async function main(): Promise<void> {
  assert.equal(isSecurityUrl('https://www.zhipin.com/web/passport/zp/security.html?code=37'), true);
  assert.equal(isSecurityUrl('https://www.zhipin.com/web/geek/jobs?_security_check=1_123'), false);
  assert.equal(isSecurityUrl('https://www.zhipin.com/web/geek/jobs'), false);

  const service = new BrowserService(path.resolve(process.cwd(), '../data/test-chrome-profile'), { headless: true });
  try {
    const page = await service.getWorkerPage();
    assert.equal((await (service as any).listTabs()).some((tab: any) => tab.url === 'about:blank'), false,
      '专用 Chrome 应直接打开 BOSS 职位页，不额外保留空白标签');
    assert.equal((await Promise.all([service.getWorkerPage(), service.getWorkerPage()]))[0], page,
      '并发获取工作页应复用同一标签');
    const fixture = '<html><head><meta charset="utf-8"></head><body><input id="name"><button onclick="document.body.dataset.clicked=1">发送</button><ul class="rec-job-list"><li class="job-card-box"><a class="job-name" href="/job_detail/demo.html">前端开发</a></li></ul><div class="dialog-wrap"><textarea></textarea><button>确定</button></div></body></html>';
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`);
    assert.equal((await service.checkLoginStatus()).isLoggedIn, false);
    const button = page.locator('button:has-text("发送")').first();
    assert.equal(await button.isVisible(), true);
    assert.equal(await button.innerText(), '发送');
    await button.click();
    assert.equal(await page.evaluate(() => document.body.dataset.clicked), '1');
    await page.locator('#name').fill('测试输入');
    assert.equal(await page.locator('#name').inputValue(), '测试输入');
    assert.equal((await page.locator('button').evaluateAll((items) => items.length)), 2);
    const card = page.locator('ul.rec-job-list li.job-card-box')
      .filter({ has: page.locator('a.job-name[href="/job_detail/demo.html"]') }).first();
    assert.equal(await card.evaluate((element) => element.querySelector('a')?.textContent), '前端开发');
    const dialog = page.locator('textarea').locator('xpath=ancestor::*[contains(@class,"dialog-wrap")][1]');
    assert.equal(await dialog.locator('button:has-text("确定")').isVisible(), true);
    process.stdout.write('PASS | Chrome 原生窗口、DOM 读取、真实点击与输入\n');
  } finally {
    await service.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
