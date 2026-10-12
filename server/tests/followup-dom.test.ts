import assert from 'node:assert/strict';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { CdpConnection, CdpPage } from '../src/services/cdp.page.js';
import { BossFollowupDom, readBossThread } from '../src/services/boss-followup-dom.js';
import { FollowupStore } from '../src/services/followup-store.js';

async function main() {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as net.AddressInfo).port; probe.close(() => resolve(port)); });
  });
  const server = await chromium.launchServer({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--remote-debugging-port=' + port] });
  const browser = await chromium.connect(server.wsEndpoint());
  let connectionPage: CdpPage | undefined;
  try {
    const fixture = await browser.newPage();
    await fixture.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><div class="user-list"><div class="selected" data-uid="hr-fixture">离线公司 内容运营</div></div><div class="chat-conversation"><a href="https://www.zhipin.com/job_detail/dom_fixture~.html">内容运营</a><div class="chat-message-list"><div class="message-item" data-mid="greet"><div class="item-myself"><div class="text"><span>您好</span></div></div></div></div><textarea id="boss-chat-editor-input"></textarea></div>' }));
    await fixture.goto('https://www.zhipin.com/web/geek/chat');
    await fixture.evaluate(() => { document.querySelector('.message-item')!.setAttribute('data-sender-id', 'account-fixture'); });
    const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json()) as any[];
    const tab = targets.find(t => t.url.includes('/web/geek/chat'))!;
    const page = await new CdpPage(tab.id, await CdpConnection.connect(tab.webSocketDebuggerUrl), tab.url, false).initialize();
    connectionPage = page;
    const store = new FollowupStore(null); store.recordContact({ jobHref: 'https://www.zhipin.com/job_detail/dom_fixture~.html', jobName: '内容运营', companyName: '离线公司' });
    const contact = store.snapshot().contacts[0], controller = new AbortController();
    const adapter = new BossFollowupDom(async () => page);
    await fixture.evaluate(() => {
      (window as any).submits = 0; (window as any).trusted = false;
      document.querySelector('textarea')!.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault(); (window as any).submits++; (window as any).trusted = e.isTrusted;
        const input = e.target as HTMLTextAreaElement, item = document.createElement('div'); item.className = 'message-item'; item.dataset.mid = 'sent-' + (window as any).submits; item.dataset.senderId = 'account-fixture';
        const bubble = document.createElement('div'); bubble.className = 'item-myself'; const text = document.createElement('div'); text.className = 'text'; const span = document.createElement('span'); span.textContent = input.value; text.append(span); bubble.append(text);
        const pending = document.createElement('span'); pending.className = 'status loading'; bubble.append(pending); item.append(bubble); document.querySelector('.chat-message-list')!.append(item); input.value = '';
        setTimeout(() => { pending.className = 'status success'; }, 350);
      });
    });
    const before = await adapter.read(contact, controller.signal);
    const after = await adapter.send(contact, '离线测试跟进，不会发送给真实招聘方', before, controller.signal);
    assert.equal(after.messages.at(-1)!.text, '离线测试跟进，不会发送给真实招聘方');
    assert.deepEqual(await fixture.evaluate(() => [(window as any).submits, (window as any).trusted]), [1, true]);
    console.log('PASS | native CDP input + submit + confirmed numbered outgoing message');
    await fixture.evaluate(() => { (document.querySelector('textarea') as HTMLTextAreaElement).value = '用户自己的草稿'; });
    await assert.rejects(() => adapter.send(contact, '不应覆盖', after, controller.signal), /已有草稿/);
    assert.equal(await fixture.locator('textarea').inputValue(), '用户自己的草稿');
    console.log('PASS | existing user draft is preserved without submitting');
    await fixture.evaluate(() => {
      (document.querySelector('textarea') as HTMLTextAreaElement).value = '';
      document.querySelector('textarea')!.addEventListener('input', () => {
        const item = document.createElement('div'); item.className = 'message-item'; item.dataset.mid = 'incoming-race'; item.innerHTML = '<div class="item-friend"><div class="text"><span>招聘方刚刚回复了</span></div></div>'; document.querySelector('.chat-message-list')!.append(item);
      }, { once: true });
    });
    await assert.rejects(() => adapter.send(contact, '应取消的旧追聊', after, controller.signal), /新消息/);
    assert.equal(await fixture.evaluate(() => (window as any).submits), 1);
    console.log('PASS | incoming message during composition cancels the stale followup');
    await fixture.evaluate(() => { document.querySelector('.chat-conversation a')!.setAttribute('href', 'https://www.zhipin.com/job_detail/other_job.html'); });
    await assert.rejects(() => readBossThread(page, contact), /不一致/);
    console.log('PASS | changed conversation/job refuses a send');
    await fixture.evaluate(() => { document.querySelector('.chat-conversation a')!.setAttribute('href', 'https://www.zhipin.com/job_detail/dom_fixture~.html'); document.querySelector('.message-item')!.removeAttribute('data-mid'); });
    await assert.rejects(() => readBossThread(page, contact), /稳定编号/);
    console.log('PASS | missing stable message identity refuses unsafe deduplication');
    await fixture.evaluate(() => {
      document.body.innerHTML = '<div class="user-list"><div class="friend-content-warp"><div class="friend-content selected">已有联系人</div></div></div><div class="chat-conversation"><div class="chat-position-content"><span class="position-name">内容运营</span></div><div class="chat-record"><div class="chat-message"><ul class="im-list"><li class="message-item item-myself"><div class="text-content">您好</div><i class="message-status status-read"></i></li><li class="message-item item-friend"><div class="text-content">请问你的学历是什么？</div></li></ul></div></div><div class="chat-input" id="chat-input" contenteditable="true"></div></div>';
      const root = document.querySelector('.chat-conversation') as any;
      root.__vue__ = { $store: { state: { userInfo: { userId: 'account-fixture' } } } };
      const friend = { uniqueId: 'hr-fixture-0', encryptJobId: 'dom_fixture~' };
      (document.querySelector('.friend-content-warp') as any).__vue__ = { $props: { source: friend } };
      (document.querySelector('.chat-position-content') as any).__vue__ = { conversation$: friend };
      (document.querySelector('.chat-record') as any).__vue__ = { boss: friend };
      for (const [i, item] of [...document.querySelectorAll('.message-item')].entries()) (item as any).__vue__ = { $props: { message: { mid: 100 + i, fromId: i ? 'hr-fixture' : 'account-fixture', time: 1791766800000, status: 2, received: true } } };
      document.querySelector('#chat-input')!.addEventListener('keydown', e => {
        const key = e as KeyboardEvent; if (key.key !== 'Enter') return; key.preventDefault();
        const input = e.target as HTMLElement, item = document.createElement('li'); item.className = 'message-item item-myself';
        const span = document.createElement('div'); span.className = 'text-content'; span.textContent = input.innerText; item.append(span);
        (item as any).__vue__ = { $props: { message: { mid: 102, fromId: 'account-fixture', time: Date.now(), status: 0, received: false } } };
        document.querySelector('.im-list')!.append(item); input.innerHTML = '';
        setTimeout(() => { const ack = document.createElement('i'); ack.className = 'message-status status-delivery'; item.append(ack); }, 500);
      });
    });
    const modern = await adapter.read(contact, controller.signal);
    assert.equal(modern.conversationId, 'hr-fixture-0'); assert.equal(modern.messages.length, 2); assert.equal(modern.messages[0].confirmed, true); assert.equal(modern.messages[0].timestamp, 1791766800000);
    const modernSent = await adapter.send(contact, '现代求职端离线测试', modern, controller.signal);
    assert.equal(modernSent.messages.at(-1)?.confirmed, true);
    console.log('PASS | verified geek DOM: Vue contact/job identity, row direction, contenteditable and delivered acknowledgement');
    await fixture.evaluate(() => { (document.querySelector('.chat-position-content') as any).__vue__.conversation$ = { uniqueId: 'another-hr', encryptJobId: 'dom_fixture~' }; });
    await assert.rejects(() => readBossThread(page, contact), /尚未加载/);
    console.log('PASS | partially switched header cannot be mistaken for a loaded conversation');
  } finally {
    connectionPage?.closeConnection();
    // Dispose only our isolated fixture process, never the user's persistent BOSS browser.
    const child = server.process();
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.kill('SIGKILL');
    for (const pipe of child.stdio) (pipe as { destroy?: () => void } | null)?.destroy?.();
    await exited;
    await server.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
