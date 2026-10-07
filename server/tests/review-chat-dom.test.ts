import assert from 'node:assert/strict';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { CdpConnection, CdpPage } from '../src/services/cdp.page.js';
import { BossPageService } from '../src/services/boss.page.service.js';
import { configManager } from '../src/config/config.manager.js';
import type { WorkConditionReview } from '../src/types.js';

async function main() {
  const port = await new Promise<number>(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true,
    args: ['--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1'],
  });
  let page: CdpPage | undefined;
  try {
    const fixture = await browser.newPage();
    await fixture.route('https://www.zhipin.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body>
      <div class="job-banner"><div class="name"><h1>ai数据标注师</h1><span class="salary">8-13K</span></div>
        <span class="text-city">上海</span><span class="text-experiece">经验不限</span><span class="text-degree">本科</span>
        <a class="btn-startchat" href="javascript:;">立即沟通</a></div>
      <div class="sider-company"><div class="company-info"><a title="示例科技公司">示例科技公司</a></div>
        <a ka="job-detail-brandindustry">互联网</a></div>
      <div class="job-detail-section"><h3>职位描述</h3><div class="job-sec-text"></div></div>
      <script>
      window.applicationClicks=0; window.extraMessages=0; window.composerChanges=0;
      setTimeout(()=>document.querySelector('.job-sec-text').textContent='负责中文数据标注、质量检查与结果校对，经验不限。',450);
      document.querySelector('.btn-startchat').onclick=()=>{
        window.applicationClicks++;
        const dialog=document.createElement('div'); dialog.className='dialog-wrap startchat-dialog';
        dialog.innerHTML='<div class="dialog-container"><div class="dialog-con"><div class="startchat-content"><div class="left">'+
          '<div class="message"><ul class="message-list"><li class="message-item"><span class="status">发送中</span><p class="text">平台默认招呼</p></li></ul></div>'+
          '<div class="edit-area"><textarea class="input-area" placeholder="打招呼"></textarea><div class="send-message disable">发送</div></div>'+
          '</div></div></div></div>';
        document.body.append(dialog);
        dialog.querySelector('textarea').addEventListener('input',()=>window.composerChanges++);
        dialog.querySelector('.send-message').onclick=()=>window.extraMessages++;
        if(!window.keepPending) setTimeout(()=>{
          const status=dialog.querySelector('.status');status.classList.add('success');status.textContent='已发送';
          document.querySelector('.btn-startchat').textContent='继续沟通';
        },window.ackDelay||0);
      };
      </script></body>` }));
    await fixture.goto('https://www.zhipin.com/job_detail/manual-review.html');
    const tabs = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json()) as any[];
    const targetTab = tabs.find(tab => tab.url.includes('/job_detail/manual-review.html'));
    page = await new CdpPage(targetTab.id, await CdpConnection.connect(targetTab.webSocketDebuggerUrl), targetTab.url, false).initialize();
    const service = new BossPageService({ pageReadyTimeoutMs: 2000, pagePollIntervalMs: 30 });
    const target = { jobName: 'ai数据标注师', companyName: '示例科技公司', jobHref: fixture.url() };
    const detail = await service.loadReviewJob(page, target as WorkConditionReview, { ...configManager.getConfig().filter,
      commute: {}, companyBlacklist: [], candidateLanguages: '', skipMissingCompanyIntro: false, skipVagueJobDescription: false });
    assert.match(detail.jobDetailText, /数据标注/, '岗位标题先出现时，须等职位描述加载完成');
    for (const delay of [0, 900]) {
      await page.evaluate(ms => {
        document.querySelector('.startchat-dialog')?.remove();
        document.querySelector('.btn-startchat')!.textContent = '立即沟通';
        (window as any).ackDelay = ms;
      }, delay);
      const before = await page.evaluate(() => (window as any).applicationClicks);
      const result = await service.executeChatClick(detail.chatButtonLocator!, '不可补发第二条消息', target);
      assert.equal(result.success, true, '独立岗位页已发送窗口应计为投递成功');
      assert.equal(result.platformGreeting, true);
      assert.equal(result.continued, true, '含已发送消息的实际沟通窗口已打开');
      assert.equal(await page.locator('.startchat-dialog textarea').inputValue(), '');
      assert.equal(await page.evaluate(() => (window as any).applicationClicks), before + 1);
      assert.equal(await page.evaluate(() => (window as any).extraMessages), 0);
      assert.equal(await page.evaluate(() => (window as any).composerChanges), 0, '不得向已开启的会话再次填入招呼');
    }
    const stale = await (service as any).readStartChatAcknowledgement(page, { ...target, jobHref: 'https://www.zhipin.com/job_detail/other.html' });
    assert.equal(stale, null, '其他岗位的旧消息不能计为本次发送');
    await page.evaluate(() => {
      document.querySelector('.startchat-dialog')?.remove();
      document.querySelector('.btn-startchat')!.textContent = '立即沟通';
      (window as any).keepPending = true;
    });
    const unknown = await service.executeChatClick(detail.chatButtonLocator!, '仍不可补发', target);
    assert.equal(unknown.success, false, '发送中不能当作成功');
    assert.equal(unknown.uncertain, true, '无发送确认保留未知状态');
    assert.equal(await page.evaluate(() => (window as any).extraMessages), 0);
    assert.equal(await page.evaluate(() => (window as any).composerChanges), 0);
    console.log('PASS | 真实 CDP 独立岗位页：异步描述、立即/延迟已发送确认、空输入框不补发、目标核对、未确认结果防重投');
  } finally { page?.closeConnection(); await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });