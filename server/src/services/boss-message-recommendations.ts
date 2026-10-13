import { browserService } from './browser.service.js';
import { bossPageService, type DOMJobCardInfo } from './boss.page.service.js';
import { bossJobId } from './job-identity.js';
import { decodeBossText } from './boss-text.js';
import type { CdpPage } from './cdp.page.js';
const CHAT_URL = 'https://www.zhipin.com/web/geek/chat';

/** Desktop chat's sourceTitle='荐' is set by BOSS's recommendation notification handler.
 * Ordinary HR greetings and existing chat-header jobs are not recommendation evidence. */
export class BossMessageRecommendations {
  async open(): Promise<CdpPage> {
    const page = await browserService.getWorkerPage();
    const url = typeof page.refreshUrl === 'function' ? await page.refreshUrl() : page.url();
    if (new URL(url).pathname !== '/web/geek/chat') await page.goto(CHAT_URL, { timeout: 30000 });
    await page.waitForFunction(() => {
      const chat = document.querySelector('.chat-conversation') as any;
      if (document.querySelector('.chat-user .user-list') && chat?.__vue__?.$store?.state?.userInfo?.userId) return true;
      return location.pathname.startsWith('/web/user/') || location.pathname.includes('/security')
        || [...document.querySelectorAll('.login-register-box,.sign-wrap,.geetest_popup')]
          .some(e => (e as HTMLElement).getClientRects().length > 0);
    }, { timeout: 15000 });
    await bossPageService.ensureLoggedIn(page);
    // The account binding appears before the conversation request finishes. An empty
    // loading shell must not be reported as "no recommended jobs".
    await page.waitForFunction(() => {
      const list = document.querySelector('.chat-user .user-list') as HTMLElement | null;
      return Boolean(list?.querySelector('.friend-content-warp'))
        || Boolean(list && /暂无联系人|暂无消息|暂无沟通|没有联系人|还没有联系人/.test(list.innerText));
    }, { timeout: 15000 });
    return page;
  }
  async cards(): Promise<DOMJobCardInfo[]> {
    const page = await this.open();
    const rows = await page.evaluate(() => [...document.querySelectorAll('.chat-user .friend-content-warp')].flatMap((node, index) => {
      if (!(node as HTMLElement).getClientRects().length) return [];
      const source = (node as any).__vue__?.$props?.source;
      if (!source || source.sourceTitle !== '荐' || source.isFiltered || typeof source.encryptJobId !== 'string') return [];
      return [{ index, id: source.encryptJobId, jobName: typeof source.jobName === 'string' ? source.jobName : '',
        companyName: typeof source.brandName === 'string' ? source.brandName : '' }];
    }));
    const unique = new Map<string, DOMJobCardInfo>();
    for (const row of rows) {
      const jobHref = 'https://www.zhipin.com/job_detail/' + row.id + '.html';
      if (!bossJobId(jobHref)) continue;
      unique.set(jobHref, { index: row.index, jobHref, jobName: decodeBossText(row.jobName) || '推荐岗位详情待加载',
        companyName: decodeBossText(row.companyName), salary: '', cityName: '', activeTimeDesc: '', experience: '', degree: '', skills: [],
        // Linked sources are opened by their stable URL, never by a stale conversation index.
        cardLocator: null! });
    }
    return [...unique.values()];
  }
  async scroll(): Promise<void> {
    const page = await this.open();
    await page.action('list', async () => {
      const rect = await page.locator('.chat-user .chat-content').evaluate(element => {
        const r = element.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), height: r.height };
      });
      if (rect.height < 20) throw new Error('BOSS 消息列表尚未显示，未滚动');
      await page.input('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: Math.round(rect.height * .8) });
    });
  }
}
export const bossMessageRecommendations = new BossMessageRecommendations();

