import { type CdpLocator, type CdpPage } from './cdp.page.js';
import { browserService, isSecurityUrl } from './browser.service.js';

const ORIGIN = 'https://www.zhipin.com';
const CARD = 'ul.rec-job-list li.job-card-box';
const DETAIL = '.job-detail-box';
const DESCRIPTION = '.job-detail-body p.desc';
const SEARCH = 'input[placeholder="搜索职位、公司"]';
const CHAT = '.job-detail-box .op-btn-chat';
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface DOMJobCardInfo {
  index: number;
  jobHref: string;
  jobName: string;
  companyName: string;
  cityName: string;
  salary: string;
  activeTimeDesc: string;
  experience: string;
  degree: string;
  skills: string[];
  cardLocator: CdpLocator;
}

export interface JobPageState {
  kind: 'jobs' | 'empty' | 'loading' | 'login' | 'captcha' | 'blocked' | 'other';
  url: string;
  cardCount: number;
  reason: string;
}

export interface ChatResult {
  success: boolean;
  verified?: boolean;
  greetingSent?: boolean;
  loginRequired?: boolean;
  needCaptcha?: boolean;
  quotaExceeded?: boolean;
  isCoolDown?: boolean;
  targetChanged?: boolean;
  uncertain?: boolean;
}

export function searchUrl(keyword?: string, cityCode?: string, positionCode?: string): string {
  const url = new URL('/web/geek/jobs', ORIGIN);
  if (keyword) url.searchParams.set('query', keyword);
  if (cityCode) url.searchParams.set('city', cityCode);
  if (positionCode) {
    if (!/^\d{6}$/.test(positionCode)) throw new Error('BOSS 岗位代码格式不正确');
    url.searchParams.set('position', positionCode);
  }
  return url.toString();
}

function pathOf(href: string, base: string): string {
  try { return new URL(href, base).pathname; } catch { return ''; }
}

export class BossPageService {
  private readonly pageReadyTimeoutMs: number;
  private readonly pagePollIntervalMs: number;

  constructor(options: { pageReadyTimeoutMs?: number; pagePollIntervalMs?: number } = {}) {
    this.pageReadyTimeoutMs = options.pageReadyTimeoutMs ?? 20000;
    this.pagePollIntervalMs = options.pagePollIntervalMs ?? 400;
  }

  /** 页面状态由实际可见 DOM 决定；_security_check 参数本身不代表验证码。 */
  public async inspectPage(page: CdpPage): Promise<JobPageState> {
    const url = typeof page.refreshUrl === 'function' ? await page.refreshUrl() : page.url();
    if (typeof page.isClosed === 'function' && page.isClosed()) {
      return { kind: 'blocked', url, cardCount: 0, reason: 'Chrome 页面连接已关闭' };
    }
    if (isSecurityUrl(url)) return { kind: 'captcha', url, cardCount: 0, reason: 'BOSS 安全验证页面' };
    if (url === 'about:blank') return { kind: 'blocked', url, cardCount: 0, reason: '浏览器页面为空白' };
    let parsed: URL;
    try { parsed = new URL(url); } catch {
      return { kind: 'blocked', url, cardCount: 0, reason: '页面地址无效' };
    }
    if (parsed.hostname !== 'www.zhipin.com') return { kind: 'blocked', url, cardCount: 0, reason: '页面离开 BOSS 直聘' };
    if (parsed.pathname.startsWith('/web/user/')) return { kind: 'login', url, cardCount: 0, reason: '需要扫码登录' };

    let readError = '';
    const dom = await page.evaluate((selector) => {
      const text = document.body?.innerText || '';
      const cards = [...document.querySelectorAll(selector)].filter((element) => (element as HTMLElement).getClientRects().length > 0).length;
      const login = [...document.querySelectorAll('.login-register-box, .sign-wrap, [class*="login-dialog"]')]
        .some((element) => (element as HTMLElement).getClientRects().length > 0)
        || [...document.querySelectorAll('a[href*="/web/user/"]')]
          .some((element) => (element as HTMLElement).getClientRects().length > 0 && /登录\s*\/\s*注册/.test(element.textContent || ''));
      const captcha = [...document.querySelectorAll('.geetest_popup, .geetest_radar_tip, [class*="security-check"]')]
        .some((element) => (element as HTMLElement).getClientRects().length > 0);
      const empty = [...document.querySelectorAll('.search-empty, .job-list-empty, [class*="empty-result"]')]
        .some((element) => (element as HTMLElement).getClientRects().length > 0 && /暂无|没有|无相关|未找到/.test(element.textContent || ''));
      return { cards, login, captcha, empty, bodyLength: text.trim().length, readyState: document.readyState,
        securityText: /请完成安全验证|请进行安全验证/.test(text) };
    }, CARD).catch((error) => {
      readError = (error as Error).message;
      console.warn('[BOSS 页面] 状态读取失败:', readError);
      return null;
    });
    if (!dom) {
      const navigating = /Execution context was destroyed|Cannot find context|Cannot find default execution context|Inspected target navigated/i.test(readError);
      return { kind: navigating ? 'loading' : 'blocked', url, cardCount: 0,
        reason: navigating ? '页面正在切换，等待新文档' : `无法读取 BOSS 页面：${readError}` };
    }
    if (dom.captcha || (dom.securityText && dom.cards === 0)) {
      return { kind: 'captcha', url, cardCount: dom.cards, reason: '页面要求安全验证' };
    }
    if (dom.login) return { kind: 'login', url, cardCount: dom.cards, reason: '页面要求重新登录' };
    if (!parsed.pathname.startsWith('/web/geek/jobs')) {
      return { kind: 'other', url, cardCount: dom.cards, reason: '当前不是职位列表' };
    }
    if (dom.cards > 0) return { kind: 'jobs', url, cardCount: dom.cards, reason: '职位卡片可见' };
    if (dom.empty) return { kind: 'empty', url, cardCount: 0, reason: '页面明确显示无结果' };
    if (dom.bodyLength < 20) return { kind: 'loading', url, cardCount: 0, reason: `页面正在渲染（文档状态：${dom.readyState}）` };
    return { kind: 'loading', url, cardCount: 0, reason: '等待职位卡片或空结果' };
  }

  private throwIfUnavailable(state: JobPageState): void {
    if (state.kind === 'captcha') throw new Error('CAPTCHA_REQUIRED: 请先在 Chrome 中完成 BOSS 安全验证');
    if (state.kind === 'login') throw new Error('BOSS 登录已失效，请重新扫码');
    if (state.kind === 'blocked') throw new Error(`BOSS 页面不可用：${state.reason}（${state.url}）`);
  }

  public async ensureLoggedIn(page?: CdpPage): Promise<void> {
    const target = page || await browserService.getWorkerPage();
    const state = await this.inspectPage(target);
    this.throwIfUnavailable(state);
    const login = await browserService.checkLoginStatus();
    if (!login.isLoggedIn) {
      if (login.reasonCode === 'verification_required') throw new Error(`CAPTCHA_REQUIRED: ${login.reason || 'BOSS 要求人工安全验证'}`);
      throw new Error(login.reason || '尚未证实 BOSS 职位页已登录');
    }
  }

  public async initJobPage(keyword?: string, cityCode?: string, positionCode?: string): Promise<CdpPage> {
    const page = await browserService.getWorkerPage();
    await page.goto(searchUrl(keyword, cityCode, positionCode), { timeout: 30000, waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + this.pageReadyTimeoutMs;
    let state = await this.inspectPage(page);
    while ((state.kind === 'loading' || state.kind === 'other') && Date.now() < deadline) {
      await pause(Math.min(this.pagePollIntervalMs, Math.max(0, deadline - Date.now())));
      state = await this.inspectPage(page);
    }
    this.throwIfUnavailable(state);
    if (state.kind !== 'jobs' && state.kind !== 'empty') {
      throw new Error(`职位页加载超时：${this.pageReadyTimeoutMs / 1000} 秒内未出现职位卡片或无结果提示；${state.reason}（${state.url}）`);
    }
    await this.ensureLoggedIn(page);
    const actualUrl = typeof page.refreshUrl === 'function' ? await page.refreshUrl() : page.url();
    if (positionCode && new URL(actualUrl).searchParams.get('position') !== positionCode) {
      throw new Error('BOSS 岗位分类未生效，请重新选择岗位后启动');
    }
    if (keyword) {
      const input = page.locator(SEARCH).first();
      if (!(await input.isVisible({ timeout: 1500 }))) throw new Error('BOSS 搜索框结构已变化');
      const actual = (await input.inputValue()).trim();
      if (actual !== keyword) throw new Error(`搜索词未生效：当前「${actual}」，预期「${keyword}」`);
    }
    return page;
  }

  /** 一次性提取可见卡片，验证每张卡片的岗位链接与基本字段。 */
  public async getVisibleJobCards(): Promise<DOMJobCardInfo[]> {
    const page = await browserService.getWorkerPage();
    await this.ensureLoggedIn(page);
    const state = await this.inspectPage(page);
    if (state.kind === 'empty') return [];
    if (state.kind !== 'jobs') throw new Error(`无法扫描职位：${state.reason}`);
    const rows = await page.locator(CARD).evaluateAll((elements) => elements.map((element, index) => {
      const card = element as HTMLElement;
      if (!card.getClientRects().length) return null;
      const tags = [...card.querySelectorAll('.tag-list li')].map((item) => item.textContent?.trim() || '').filter(Boolean);
      return {
        index, href: card.querySelector('a.job-name')?.getAttribute('href') || '',
        name: card.querySelector('a.job-name')?.textContent?.trim() || '',
        company: card.querySelector('.job-card-footer .boss-name')?.textContent?.trim() || '',
        location: card.querySelector('.company-location')?.textContent?.trim() || '',
        salary: card.querySelector('.job-salary')?.textContent?.trim() || '',
        tags,
      };
    }).filter((item) => item !== null));
    const result: DOMJobCardInfo[] = [];
    for (const row of rows) {
      if (!row.href || !row.name || !row.company) throw new Error(`第 ${row.index + 1} 张职位卡片缺少链接、职位名或公司名`);
      const href = new URL(row.href, page.url());
      if (href.hostname !== 'www.zhipin.com' || !href.pathname.startsWith('/job_detail/')) {
        throw new Error(`职位卡片链接异常：${row.href}`);
      }
      result.push({
        index: row.index, jobHref: row.href, jobName: row.name, companyName: row.company,
        cityName: row.location.split('·')[0]?.trim() || '', salary: row.salary, activeTimeDesc: '',
        experience: row.tags.find((tag) => /年|应届|在校|经验/.test(tag)) || '',
        degree: row.tags.find((tag) => /博士|硕士|本科|大专|专科|高中|中专|学历/.test(tag)) || '',
        skills: row.tags, cardLocator: this.cardByHref(page, row.href),
      });
    }
    if (state.cardCount && !result.length) throw new Error('页面显示职位卡片但无法读取');
    return result;
  }

  private cardByHref(page: CdpPage, href: string): CdpLocator {
    return page.locator(CARD).filter({ has: page.locator(`a.job-name[href=${JSON.stringify(href)}]`) }).first();
  }

  public async isCardStillTarget(card: CdpLocator, jobName: string, companyName: string, href: string): Promise<boolean> {
    const data = await card.evaluate((element) => ({
      href: element.querySelector('a.job-name')?.getAttribute('href') || '',
      name: element.querySelector('a.job-name')?.textContent?.trim() || '',
      company: element.querySelector('.job-card-footer .boss-name')?.textContent?.trim() || '',
    })).catch(() => null);
    return !!data && data.href === href && data.name === jobName && data.company === companyName;
  }

  public async relocateCard(href: string, jobName: string, companyName: string): Promise<CdpLocator | null> {
    const page = await browserService.getWorkerPage();
    const card = this.cardByHref(page, href);
    return await this.isCardStillTarget(card, jobName, companyName, href) ? card : null;
  }

  /** 实测详情链接的查询参数会变化，岗位路径与卡片路径一致。 */
  public async isDetailStillTarget(jobName: string, companyName: string, href?: string): Promise<boolean> {
    const page = await browserService.getWorkerPage();
    const state = await this.inspectPage(page);
    if (state.kind !== 'jobs') return false;
    const detail = await page.locator(DETAIL).first().evaluate((element) => ({
      name: element.querySelector('.job-detail-info .job-name')?.textContent?.trim() || '',
      href: element.querySelector('a.more-job-btn')?.getAttribute('href') || '',
      text: (element as HTMLElement).innerText,
      description: (element.querySelector('.job-detail-body p.desc') as HTMLElement | null)?.innerText?.trim() || '',
    })).catch(() => null);
    if (!detail || detail.name !== jobName || detail.description.length < 20) return false;
    if (href) return !!detail.href && pathOf(detail.href, page.url()) === pathOf(href, page.url());
    return !!companyName && detail.text.includes(companyName);
  }

  public async loadJobDetail(card: CdpLocator, jobName: string, companyName: string, href?: string): Promise<{
    jobDetailText: string;
    activeTimeDesc: string;
    brandIndustry: string;
    alreadyChatted: boolean;
    chatButtonLocator: CdpLocator | null;
  }> {
    const page = card.page();
    if (href && !(await this.isCardStillTarget(card, jobName, companyName, href))) throw new Error('职位卡片在点击前发生变化');
    await card.click();
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline && !(await this.isDetailStillTarget(jobName, companyName, href))) {
      const state = await this.inspectPage(page);
      this.throwIfUnavailable(state);
      await pause(250);
    }
    if (!(await this.isDetailStillTarget(jobName, companyName, href))) throw new Error('右侧详情与所选职位链接不一致');
    const detail = page.locator(DETAIL).first();
    const jobDetailText = (await detail.locator(DESCRIPTION).innerText()).trim();
    if (jobDetailText.length < 20) throw new Error('职位描述不可读，已停止当前岗位');
    const recruiterText = await detail.locator('.job-boss-info').first().innerText({ timeout: 500 }).catch(() => '');
    const activeTimeDesc = recruiterText.match(/刚刚活跃|今日活跃|今天活跃|在线|\d+\s*日内活跃|\d+\s*周内活跃|本周活跃|本月活跃/)?.[0] || '';
    const brandIndustry = (await detail.locator('a[href^="/i"]').first().textContent({ timeout: 500 }).catch(() => ''))?.trim() || '';
    const button = page.locator(CHAT).first();
    const visible = await button.isVisible({ timeout: 800 }).catch(() => false);
    const label = visible ? (await button.innerText()).trim() : '';
    return { jobDetailText, activeTimeDesc, brandIndustry,
      alreadyChatted: /继续沟通|已在沟通/.test(label), chatButtonLocator: visible ? button : null };
  }

  public async isJobListPage(): Promise<boolean> {
    const state = await this.inspectPage(await browserService.getWorkerPage());
    return state.kind === 'jobs' || state.kind === 'empty';
  }

  /** 仅对真实出现的“不合适”控件执行操作。 */
  public async markJobNotSuit(card: CdpLocator): Promise<boolean> {
    const page = card.page();
    await card.hover().catch(() => {});
    const button = card.locator('[ka*="not_match"]').first();
    if (!(await button.isVisible({ timeout: 500 }).catch(() => false))) return false;
    await button.click();
    const confirm = page.locator('.dialog-wrap button:has-text("确定"), .dialog-wrap button:has-text("确认")').first();
    if (await confirm.isVisible({ timeout: 500 }).catch(() => false)) await confirm.click();
    const feedback = await page.locator('.toast-content, .toast').first().innerText({ timeout: 1200 }).catch(() => '');
    return /已标记|不再推荐|减少推荐|操作成功/.test(feedback);
  }

  private async chatInterruption(page: CdpPage): Promise<ChatResult | null> {
    const state = await this.inspectPage(page);
    if (state.kind === 'captcha') return { success: false, needCaptcha: true };
    if (state.kind === 'login') return { success: false, loginRequired: true };
    if (state.kind === 'blocked') return { success: false, uncertain: true };
    const text = await page.locator('.dialog-wrap, .boss-dialog, .toast-content').first()
      .innerText({ timeout: 400 }).catch(() => '');
    if (/沟通.*上限|今日.*上限|次数已满/.test(text)) return { success: false, quotaExceeded: true };
    if (/操作频繁|稍后再试|请求过于频繁/.test(text)) return { success: false, isCoolDown: true };
    return null;
  }

  private async waitForChatSignal(page: CdpPage, target?: { jobName: string; companyName: string; jobHref: string }): Promise<boolean> {
    const deadline = Date.now() + 6500;
    while (Date.now() < deadline) {
      if (target && await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref)) {
        const label = await page.locator(CHAT).first().innerText({ timeout: 300 }).catch(() => '');
        if (/继续沟通|已在沟通/.test(label)) return true;
      }
      if (page.url().includes('/web/geek/chat') && target) {
        const body = await page.locator('body').innerText({ timeout: 500 }).catch(() => '');
        if (body.includes(target.companyName) && body.includes(target.jobName)) return true;
      }
      await pause(350);
    }
    return false;
  }

  /** 点击后必须观察到目标岗位的沟通反馈；未知结果令批次停止。 */
  public async executeChatClick(
    chatButton: CdpLocator, greeting?: string,
    target?: { jobName: string; companyName: string; jobHref: string },
  ): Promise<ChatResult> {
    const page = chatButton.page();
    if (target && !(await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref))) {
      return { success: false, targetChanged: true };
    }
    const label = (await chatButton.innerText().catch(() => '')).trim();
    if (!label.includes('立即沟通')) return { success: false, targetChanged: true };
    let clicked = false;
    try {
      await chatButton.click();
      clicked = true;
      await pause(500);
      let interrupted = await this.chatInterruption(page);
      if (interrupted) return interrupted;
      const input = page.locator('.dialog-wrap textarea, textarea[placeholder*="打招呼"], .chat-input textarea').first();
      if (await input.isVisible({ timeout: 1600 }).catch(() => false)) {
        if (!greeting?.trim()) return { success: false, uncertain: true };
        if (target && !(await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref))) {
          return { success: false, uncertain: true };
        }
        const dialog = input.locator('xpath=ancestor::*[contains(@class,"dialog-wrap") or contains(@class,"chat-input")][1]');
        const send = dialog.locator('button:has-text("发送"), button:has-text("确定")').first();
        if (!(await send.isVisible({ timeout: 800 }).catch(() => false))) return { success: false, uncertain: true };
        await input.fill(greeting.trim());
        await send.click();
        interrupted = await this.chatInterruption(page);
        if (interrupted) return interrupted;
        const verified = await this.waitForChatSignal(page, target);
        return { success: verified, verified, greetingSent: verified, uncertain: !verified };
      }
      const verified = await this.waitForChatSignal(page, target);
      interrupted = await this.chatInterruption(page);
      if (interrupted) return interrupted;
      return { success: verified, verified, greetingSent: false, uncertain: !verified };
    } catch (error) {
      console.warn('[BOSS 页面] 沟通结果无法确认:', (error as Error).message);
      return { success: false, uncertain: clicked };
    }
  }

  public async scrollDownForMore(): Promise<void> {
    const page = await browserService.getWorkerPage();
    const state = await this.inspectPage(page);
    this.throwIfUnavailable(state);
    if (state.kind !== 'jobs') return;
    await page.locator(CARD).last().scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      let node = document.querySelector('ul.rec-job-list');
      while (node) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 20) {
          node.scrollBy({ top: Math.max(800, node.clientHeight), behavior: 'instant' });
          return;
        }
        node = node.parentElement;
      }
      window.scrollBy({ top: Math.max(800, window.innerHeight), behavior: 'instant' });
    });
    await pause(900);
  }
}

export const bossPageService = new BossPageService();
