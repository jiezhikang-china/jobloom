import type { CdpPage } from './cdp.page.js';
import type { FollowupAdapter } from './followup-engine.js';
import type { FollowupContact, ChatSnapshot } from './followup-types.js';
import { FollowupNotSubmittedError } from './followup-types.js';
import { canonicalFollowupJob } from './followup-store.js';
import { bossActionScheduler } from './boss-action-scheduler.js';

/** Read only the visible thread. Missing identity or message direction never permits a send. */
export async function readBossThread(page: CdpPage, target: FollowupContact): Promise<ChatSnapshot> {
  const result = await page.evaluate(() => {
    const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0;
    const roots = [...document.querySelectorAll('.chat-conversation')].filter(visible);
    if (roots.length !== 1) throw new Error('BOSS 消息会话尚未加载');
    const root = roots[0];
    const header = (root.querySelector('.chat-position-content') as any)?.__vue__?.conversation$;
    const links = [...root.querySelectorAll<HTMLAnchorElement>('a[href*="/job_detail/"]')].filter(a => visible(a) && !a.closest('.chat-message-list, .chat-record')).map(a => a.href);
    if (header?.encryptJobId && /^[a-zA-Z0-9_-]+$/.test(header.encryptJobId)) links.push('https://www.zhipin.com/job_detail/' + header.encryptJobId + '.html');
    const jobs = [...new Set(links.map(href => { const u = new URL(href); return u.origin + u.pathname; }))];
    if (jobs.length !== 1) throw new Error('当前会话的岗位链接尚未核对');
    const selected = [...document.querySelectorAll('.user-list .selected')].filter(visible);
    if (selected.length !== 1) throw new Error('当前联系人尚未核对');
    const row = selected[0] as any;
    const parentProps = row.closest('.friend-content-warp')?.__vue__?.$props || {};
    const props = row.__vue__?.$props || parentProps;
    const friend = props.friend || props.item || props.source || parentProps.source || {};
    const uid = row.getAttribute('data-uid') || row.getAttribute('data-id') || friend.uniqueId || friend.encryptUid || friend.uid || friend.friendId;
    if (!uid || !/^[a-zA-Z0-9_-]+$/.test(String(uid))) throw new Error('无法读取当前联系人的稳定标识');
    if (header?.uniqueId && String(header.uniqueId) !== String(uid)) throw new Error('联系人已切换，右侧会话尚未加载完');
    const recordBoss = (root.querySelector('.chat-record') as any)?.__vue__?.boss;
    if (recordBoss?.uniqueId && String(recordBoss.uniqueId) !== String(uid)) throw new Error('消息记录尚未切换到当前联系人');
    if (header?.encryptJobId && friend.encryptJobId && header.encryptJobId !== friend.encryptJobId) throw new Error('联系人岗位与右侧会话尚未同步');
    const lists = [...root.querySelectorAll('.chat-message-list, .chat-record .im-list')].filter(visible);
    if (lists.length !== 1) throw new Error('BOSS 消息列表尚未加载');
    const senderIds = new Set<string>();
    const messages = [...lists[0].querySelectorAll('.message-item')].flatMap(item => {
      const incoming = item.matches('.item-friend') ? item : item.querySelector('.item-friend');
      const outgoing = item.matches('.item-myself') ? item : item.querySelector('.item-myself');
      if (Boolean(incoming) === Boolean(outgoing)) return [];
      const source = incoming || outgoing!;
      const text = source.querySelector('.text-content')?.textContent?.trim() || source.querySelector('.text > span')?.textContent?.trim() || source.querySelector('.text')?.textContent?.trim()
        || source.querySelector('.message-card-top-title')?.textContent?.trim() || '';
      if (!text) return [];
      const props = (item as any).__vue__?.$props || {};
      const message = props.message || props.item || props.msg || {};
      if (outgoing) {
        const sender = item.getAttribute('data-sender-id') || message.fromId || message.from?.uid || message.fromUid;
        if (sender) senderIds.add(String(sender));
      }
      const id = item.getAttribute('data-mid') || item.getAttribute('data-id') || message.mid || message.msgId || message.id;
      if (!id) throw new Error('消息缺少稳定编号，无法安全去重');
      const pending = item.querySelector('.sending, .failed, .error, .status.loading, .status.fail');
      const acknowledged = Boolean(item.querySelector('.message-status.status-read, .message-status.status-delivery, .status.success'));
      const confirmed = incoming ? true : !pending && acknowledged;
      const timestamp = typeof message.time === 'number' && Number.isFinite(message.time) && message.time > 0 ? message.time : undefined;
      const kind = source.querySelector('.text-content, .text') ? 'text' as const : 'card' as const;
      return [{ id: String(id), direction: incoming ? 'incoming' as const : 'outgoing' as const, text, confirmed, timestamp, kind }];
    });
    if (!messages.length) throw new Error('会话中尚未读取到有编号的消息');
    const userId = (root as any).__vue__?.$store?.state?.userInfo?.userId;
    const accountId = userId ? String(userId) : senderIds.size === 1 ? [...senderIds][0] : '';
    if (!accountId || [...senderIds].some(id => id !== accountId)) throw new Error('当前发送账号尚未核对，未发送消息');
    return { accountId, conversationId: String(uid), jobHref: jobs[0], messages };
  });
  if (canonicalFollowupJob(result.jobHref) !== target.jobHref || (target.conversationId && result.conversationId !== target.conversationId)) throw new Error('当前消息会话与该岗位不一致，未发送');
  return { ...result, jobName: target.jobName, companyName: target.companyName };
}

export class BossFollowupDom implements FollowupAdapter {
  constructor(private readonly page: () => Promise<CdpPage>) {}
  async read(contact: FollowupContact, signal: AbortSignal): Promise<ChatSnapshot> {
    signal.throwIfAborted(); const page = await this.page();
    try { return await readBossThread(page, contact); } catch { /* Select a different existing conversation. */ }
    await page.waitForFunction(() => Boolean(document.querySelector('.user-list, .boss-search-input')), { timeout: 15000 });
    const search = page.locator('.boss-search-input').filter({ visible: true });
    if (await search.isVisible()) { await search.fill(contact.companyName); signal.throwIfAborted(); }
    const findRows = () => page.evaluate(({ company, job, contactHref }) => {
      const list = document.querySelector('.user-list'); if (!list) return [];
      const norm = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');
      const candidates = [...list.querySelectorAll<HTMLElement>('.friend-content')].filter(el => {
        if (!el.getClientRects().length) return false;
        const source = (el.closest('.friend-content-warp') as any)?.__vue__?.$props?.source;
        if (source?.encryptJobId) return 'https://www.zhipin.com/job_detail/' + source.encryptJobId + '.html' === contactHref;
        return norm(el.innerText).includes(norm(company)) && norm(el.innerText).includes(norm(job));
      });
      // Minimal matching row; never click an entire list that contains many contacts.
      const rows = candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
      return rows.map(el => ({ tag: el.tagName.toLowerCase(), index: [...list.querySelectorAll(el.tagName.toLowerCase())].indexOf(el), text: norm(el.innerText) }));
    }, { company: contact.companyName, job: contact.jobName, contactHref: contact.jobHref });
    let rows = await findRows();
    for (let i = 0; !rows.length && i < 20; i++) { signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 250)); rows = await findRows(); }
    if (rows.length !== 1) throw new Error(rows.length ? '同一公司有多个相似会话，请在 BOSS 中选择对应联系人再核对' : '未找到对应岗位会话，请打开 BOSS 中已有的沟通记录再核对');
    const row = rows[0];
    await page.locator('.user-list').locator(row.tag).nth(row.index).clickAs('detail', async () => {
      signal.throwIfAborted(); const fresh = await findRows();
      if (fresh.length !== 1 || fresh[0].index !== row.index || fresh[0].text !== row.text) throw new Error('联系人列表发生变化，本次未点击');
    });
    await bossActionScheduler.waitForElapsed(Date.now(), 1200);
    let error: Error | undefined;
    for (let i = 0; i < 20; i++) {
      signal.throwIfAborted(); try { return await readBossThread(page, contact); } catch (cause) { error = cause as Error; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw error || new Error('会话尚未加载');
  }
  async send(contact: FollowupContact, text: string, before: ChatSnapshot, signal: AbortSignal): Promise<ChatSnapshot> {
    const page = await this.page();
    let submitted = false;
    try {
    const unchanged = async () => {
      signal.throwIfAborted(); const fresh = await readBossThread(page, contact);
      if (fresh.accountId !== before.accountId) throw new Error('发送账号已变化，本次未发送');
      if (fresh.messages.at(-1)?.id !== before.messages.at(-1)?.id) throw new FollowupNotSubmittedError('对话已有新消息，取消本次发送并重新核对', true);
    };
    await unchanged();
    const inputs = page.locator('.chat-conversation #chat-input[contenteditable="true"], .chat-conversation #boss-chat-editor-input, .chat-conversation textarea').filter({ visible: true });
    if ((await inputs.evaluateAll(elements => elements.length)) !== 1) throw new Error('未找到唯一的 BOSS 消息输入框');
    const existing = await inputs.evaluate(el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : (el as HTMLElement).innerText);
    if (existing.trim()) throw new Error('消息输入框已有草稿，请先处理；不会覆盖你的文字');
    if (await inputs.evaluate(el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) await inputs.fill(text);
    else {
      await page.action('input', async () => {
        await unchanged(); await inputs.evaluate(el => { (el as HTMLElement).focus(); });
        await page.input('Input.insertText', { text });
      });
    }
    const checkDraft = async () => {
      await unchanged(); const value = await inputs.evaluate(el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : (el as HTMLElement).innerText);
      if (value.trim() !== text.trim()) throw new Error('消息草稿内容已变化，本次未发送');
    };
    await page.action('submit', async () => {
      await checkDraft();
      submitted = true;
      await page.input('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await page.input('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    });
    const old = new Set(before.messages.filter(m => m.direction === 'outgoing').map(m => m.id));
    for (let i = 0; i < 24; i++) {
      signal.throwIfAborted(); const snapshot = await readBossThread(page, contact);
      if (snapshot.messages.some(m => m.direction === 'outgoing' && m.confirmed === true && m.text === text && !old.has(m.id))) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('消息已提交，但尚未读到确认回执；请核对，不会自动重发');
    } catch (error) {
      if (!submitted && !(error instanceof FollowupNotSubmittedError)) throw new FollowupNotSubmittedError((error as Error).message);
      throw error;
    }
  }
}
