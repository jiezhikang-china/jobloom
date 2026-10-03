import { type CdpLocator, type CdpPage } from './cdp.page.js';
import { browserService, isSecurityUrl } from './browser.service.js';
import type { AppConfig, BossCompanyInfo, BossJobItem, BossWorkAddress, CommuteOrigin, WorkConditionReview } from '../types.js';
import { jobInformationIssue } from './job-information.js';
import { findJobExclusion } from './job-exclusions.js';
import { decodeBossText, readableBossSalary } from './boss-text.js';
import { languageQualificationIssue, type CandidateLanguageContext } from './language-qualification.js';
import { readBossWorkAddress, bossMapService } from './boss-map.service.js';
import { commuteDecision } from './commute.js';
import { bossJobId, sameJobLink, normalizedJobName } from './job-identity.js';
import { notSuitableStore } from './not-suitable-store.js';
import { bossActionScheduler, runBossAction, clickBossAction } from './boss-action-scheduler.js';

const ORIGIN = 'https://www.zhipin.com';
const CARD = 'ul.rec-job-list li.job-card-box';
const DETAIL = '.job-detail-box';
const DESCRIPTION = '.job-detail-body p.desc';
const SEARCH = 'input[placeholder="搜索职位、公司"]';
const CHAT = '.job-detail-box .op-btn-chat, .job-banner .btn-startchat';
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

export interface JobDetailData {
  jobHref: string; jobName: string; companyName: string; salary: string;
  degree: string; experience: string; cityName: string; skills: string[];
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
  platformGreeting?: boolean;
  continued?: boolean;
  continuationFailed?: boolean;
  loginRequired?: boolean;
  needCaptcha?: boolean;
  quotaExceeded?: boolean;
  isCoolDown?: boolean;
  targetChanged?: boolean;
  uncertain?: boolean;
}

interface DetailIdentity {
  name: string; href: string; id: string; boundName: string; company: string; loading: boolean; text: string; description: string;
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

const normalizedName = normalizedJobName;
function sameCompany(actual: string, expected: string): boolean {
  const prefix = normalizedName(expected).replace(/(?:\.{3}|…+)$/, '');
  return normalizedName(actual) === normalizedName(expected)
    || (/(?:\.{3}|…+)$/.test(expected) && prefix.length >= 4 && normalizedName(actual).startsWith(prefix));
}

export class BossPageService {
  private readonly pageReadyTimeoutMs: number;
  private readonly pagePollIntervalMs: number;
  private companyCache = new Map<string, { expiresAt: number; info: BossCompanyInfo }>();
  private feedbackUnavailableUntil = new Map<string, number>();
  private rememberNotSuitable: (target: { jobHref: string; jobName: string; companyName: string }) => void;

  constructor(options: { pageReadyTimeoutMs?: number; pagePollIntervalMs?: number;
    rememberNotSuitable?: (target: { jobHref: string; jobName: string; companyName: string }) => void } = {}) {
    this.pageReadyTimeoutMs = options.pageReadyTimeoutMs ?? 20000;
    this.pagePollIntervalMs = options.pagePollIntervalMs ?? 400;
    this.rememberNotSuitable = options.rememberNotSuitable || (target => notSuitableStore.remember(target));
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

  public async getSavedExpectationNames(): Promise<string[]> {
    const page = await browserService.getWorkerPage();
    const current = new URL(typeof page.refreshUrl === 'function' ? await page.refreshUrl() : page.url());
    if (current.searchParams.has('query') || current.searchParams.has('position') || !(await this.isJobListPage())) await this.initJobPage();
    await this.ensureLoggedIn(page);
    const names = await page.locator('.c-expect-select .expect-list .expect-item').evaluateAll((elements) =>
      elements.filter((item) => (item as HTMLElement).getClientRects().length > 0)
        .map((item) => (item as HTMLElement).innerText.trim()).filter(Boolean));
    if (!names.length) throw new Error('未读取到 BOSS 自选求职期望，请先在 BOSS「推荐」旁边设置期望岗位。');
    return [...new Set(names)];
  }

  public async initJobPage(keyword?: string, cityCode?: string, positionCode?: string,
    options: { expectationName?: string } = {}): Promise<CdpPage> {
    const page = await browserService.getWorkerPage();
    const current = new URL(typeof page.refreshUrl === 'function' ? await page.refreshUrl() : page.url());
    const reuseSavedList = options.expectationName && current.hostname === 'www.zhipin.com'
      && current.pathname === '/web/geek/jobs' && !current.searchParams.has('query') && !current.searchParams.has('position')
      && await this.isJobListPage();
    if (!reuseSavedList) await page.goto(searchUrl(options.expectationName ? undefined : keyword,
      options.expectationName ? undefined : cityCode, options.expectationName ? undefined : positionCode),
      { timeout: 30000, waitUntil: 'domcontentloaded' });
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
    if (options.expectationName) {
      const names = await this.getSavedExpectationNames();
      const index = names.indexOf(options.expectationName);
      if (index < 0) throw new Error('BOSS 自选期望已变化，请重新开始：' + options.expectationName);
      const tab = page.locator('.c-expect-select .expect-list .expect-item').filter({ visible: true }).nth(index);
      if ((await tab.innerText()).trim() !== options.expectationName) throw new Error('BOSS 自选岗位顺序已变化');
      const before = await page.evaluate(() => ({
        selected: (document.querySelector('.expect-item.active') as HTMLElement | null)?.innerText.trim() || '',
        jobs: [...document.querySelectorAll('li.job-card-box a.job-name')].map((item) => item.getAttribute('href')).join('|'),
      }));
      if (before.selected !== options.expectationName) {
        await tab.click();
        await page.waitForFunction(({ name, previousJobs }) => {
          const selected = (document.querySelector('.expect-item.active') as HTMLElement | null)?.innerText.trim();
          const jobs = [...document.querySelectorAll('li.job-card-box a.job-name')].map((item) => item.getAttribute('href')).join('|');
          const empty = [...document.querySelectorAll('.search-empty, .job-list-empty, [class*="empty-result"]')]
            .some((item) => (item as HTMLElement).getClientRects().length && /暂无|没有|无相关|未找到/.test(item.textContent || ''));
          return selected === name && ((!!jobs && jobs !== previousJobs) || empty);
        }, { name: options.expectationName, previousJobs: before.jobs }, { timeout: this.pageReadyTimeoutMs });
      }
      await this.ensureLoggedIn(page);
      return page;
    }
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

  /** Read visible preview links. Screening fields are taken from the opened details. */
  public async getVisibleJobCards(): Promise<DOMJobCardInfo[]> {
    const page = await browserService.getWorkerPage();
    await this.ensureLoggedIn(page);
    const state = await this.inspectPage(page);
    if (state.kind === 'empty') return [];
    if (state.kind !== 'jobs') throw new Error(`无法扫描职位：${state.reason}`);
    const rows = await page.locator(CARD).evaluateAll((elements) => elements.map((element, index) => {
      const card = element as HTMLElement;
      if (!card.getClientRects().length) return null;
      const visibleText = (selector: string) => (card.querySelector(selector) as HTMLElement | null)?.innerText?.trim() || '';
      const tags = [...card.querySelectorAll('.tag-list li')].filter(item => (item as HTMLElement).getClientRects().length)
        .map(item => (item as HTMLElement).innerText.trim()).filter(Boolean);
      return {
        index, href: card.querySelector('a.job-name')?.getAttribute('href') || '',
        name: visibleText('a.job-name'),
        company: visibleText('.job-card-footer .boss-name'),
        location: visibleText('.company-location'),
        salary: visibleText('.job-salary'),
        tags,
      };
    }).filter((item) => item !== null));
    const result: DOMJobCardInfo[] = [];
    for (const raw of rows) {
      const row = { ...raw, name: decodeBossText(raw.name), company: decodeBossText(raw.company),
        location: decodeBossText(raw.location), salary: readableBossSalary(raw.salary), tags: raw.tags.map(decodeBossText) };
      if (!row.href) continue;
      const href = new URL(row.href, page.url());
      if (href.hostname !== 'www.zhipin.com' || !href.pathname.startsWith('/job_detail/')) {
        throw new Error(`职位卡片链接异常：${row.href}`);
      }
      result.push({
        index: row.index, jobHref: row.href, jobName: row.name || '职位详情待加载', companyName: row.company,
        cityName: row.location.split('·')[0]?.trim() || '', salary: row.salary, activeTimeDesc: '',
        experience: row.tags.find((tag) => /年|应届|在校|经验/.test(tag)) || '',
        degree: row.tags.find((tag) => /博士|硕士|本科|大专|专科|高中|中专|中技|职高|初中|学历/.test(tag)) || '',
        skills: row.tags, cardLocator: this.cardByHref(page, row.href),
      });
    }
    if (state.cardCount && !result.length) throw new Error('页面显示职位卡片但无法读取');
    return result;
  }

  private cardByHref(page: CdpPage, href: string): CdpLocator {
    const id = bossJobId(href);
    return page.locator(CARD).filter({ has: page.locator(`a.job-name[href*=${JSON.stringify('/job_detail/' + id + '.html')}]`) }).first();
  }

  public async isCardStillTarget(card: CdpLocator, _jobName: string, _companyName: string, href: string): Promise<boolean> {
    const data = await card.evaluate((element) => ({ href: element.querySelector('a.job-name')?.getAttribute('href') || '' })).catch(() => null);
    return !!data && sameJobLink(data.href, href);
  }

  public async relocateCard(href: string, jobName: string, companyName: string): Promise<CdpLocator | null> {
    const page = await browserService.getWorkerPage();
    const card = this.cardByHref(page, href);
    return await this.isCardStillTarget(card, jobName, companyName, href) ? card : null;
  }

  /** Hidden panels can retain old snapshots; read the visible detail only. */
  private detailLocator(page: CdpPage): CdpLocator { return page.locator(DETAIL).filter({ visible: true }).first(); }

  private async readDetailIdentity(page: CdpPage): Promise<DetailIdentity | null> {
    return this.detailLocator(page).evaluate((element) => ({
      name: (element.querySelector('.job-detail-info .job-name') as HTMLElement | null)?.innerText?.trim() || '',
      href: element.querySelector('a.more-job-btn')?.getAttribute('href') || '',
      id: (element as any).__vue__?.$props?.data?.jobInfo?.encryptId || '',
      boundName: (element as any).__vue__?.$props?.data?.jobInfo?.jobName || '',
      company: (element as any).__vue__?.$props?.data?.brandComInfo?.brandName || '',
      loading: (element as any).__vue__?.$props?.loading === true,
      text: (element as HTMLElement).innerText,
      description: (element.querySelector('.job-detail-body p.desc') as HTMLElement | null)?.innerText?.trim() || '',
    })).catch(() => null);
  }

  private openedDetailIssue(detail: DetailIdentity | null): string {
    if (!detail) return '没有可见的职位详情';
    if (detail.loading) return '详情仍在加载';
    if (!(detail.name || detail.boundName) || !detail.description.trim()) return '职位详情内容尚未加载';
    const linkId = bossJobId(detail.href);
    if (detail.id && linkId && detail.id !== linkId) return '详情正在切换，链接与内容尚未同步';
    if (!linkId && !/^[a-zA-Z0-9_-]+$/.test(detail.id)) return '详情尚未提供岗位链接';
    return '';
  }

  private identityIssue(detail: DetailIdentity | null, jobName: string, companyName: string, href?: string): string {
    if (!detail) return '没有可见的职位详情';
    if (detail.loading) return '详情仍在加载';
    if (href) {
      const expected = bossJobId(href), linkId = bossJobId(detail.href);
      if (!expected) return '目标岗位链接没有有效编号';
      if (detail.id && detail.id !== expected) return '详情绑定编号 ' + detail.id + ' 与目标编号 ' + expected + ' 不同';
      if (linkId && linkId !== expected) return '详情链接编号 ' + linkId + ' 与目标编号 ' + expected + ' 不同';
      if (detail.id === expected || linkId === expected) return '';
      return '详情未提供可核对的岗位编号';
    }
    if (normalizedName(detail.name || detail.boundName) !== normalizedName(jobName)) return '没有岗位编号，标题与目标不同';
    if (!companyName || !detail.text.includes(companyName)) return '没有岗位编号，公司名称无法核对';
    return '';
  }

  public async isDetailStillTarget(jobName: string, companyName: string, href?: string, targetPage?: CdpPage): Promise<boolean> {
    const page = targetPage || await browserService.getWorkerPage();
    const state = await this.inspectPage(page);
    if (state.kind === 'other' && /^\/job_detail\/[^/]+\.html$/.test(new URL(state.url).pathname)) {
      const identity = await page.evaluate(() => ({ path: location.pathname,
        name: (document.querySelector('.job-banner .name h1') as HTMLElement | null)?.innerText?.trim() || '',
        company: document.querySelector('.sider-company .company-info a[title]')?.getAttribute('title') || '' }));
      if (href) return Boolean(identity.name) && sameJobLink(identity.path, href);
      return normalizedName(identity.name) === normalizedName(jobName) && sameCompany(identity.company, companyName);
    }
    if (state.kind !== 'jobs') return false;
    return !this.identityIssue(await this.readDetailIdentity(page), jobName, companyName, href);
  }

  public async readCompanyInfo(href: string, companyName: string, refresh = false): Promise<BossCompanyInfo> {
    const url = new URL(href, ORIGIN);
    url.search = ''; url.hash = '';
    const cached = this.companyCache.get(url.href);
    if (!refresh && cached && cached.expiresAt > Date.now() && sameCompany(cached.info.name, companyName)) return structuredClone(cached.info);
    return browserService.withCompanyInspection(url.href, async (page) => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const currentUrl = await page.refreshUrl();
        if (isSecurityUrl(currentUrl)) throw new Error('CAPTCHA_REQUIRED: 公司页需要安全验证');
        if (currentUrl.includes('/web/user/')) throw new Error('BOSS 公司页要求登录，请在 Chrome 中完成登录');
        const data = await page.evaluate(() => {
          const banner = document.querySelector('.company-banner');
          const section = [...document.querySelectorAll('.company-info-box .job-sec')].find((item) =>
            (item.querySelector('h3') as HTMLElement | null)?.innerText?.trim() === '公司简介');
          const scope = [...document.querySelectorAll('.company-business .business-detail li')].find((item) =>
            /^经营范围\s*[：:]/.test((item as HTMLElement).innerText?.trim() || ''));
          return { path: location.pathname,
            name: (banner?.querySelector('h1.name') as HTMLElement | null)?.innerText?.trim().split('\n')[0]?.replace(/\s*收藏$/, '').trim() || '',
            industry: (banner?.querySelector('a[href^="/i"]') as HTMLElement | null)?.innerText?.trim() || '',
            introduction: (section?.querySelector('.text, .job-sec-text') as HTMLElement | null)?.innerText?.trim() || '',
            businessScope: (scope as HTMLElement | undefined)?.innerText?.trim().replace(/^经营范围\s*[：:]\s*/, '') || '',
            hasIntroduction: Boolean(section),
            profileReady: document.readyState === 'complete' && Boolean(document.querySelector('.company-info-box, .company-business')),
            verifying: /请完成安全验证|请进行安全验证/.test(document.body?.innerText || '') };
        });
        if (data.verifying) throw new Error('CAPTCHA_REQUIRED: 公司页需要安全验证');
        if (data.name && data.industry && (data.hasIntroduction || data.businessScope || data.profileReady)) {
          if (data.path !== url.pathname) throw new Error('公司页链接与打开的页面不一致');
          const info: BossCompanyInfo = { url: url.href, name: decodeBossText(data.name), industry: decodeBossText(data.industry),
            introduction: decodeBossText(data.introduction), businessScope: decodeBossText(data.businessScope), checkedAt: new Date().toISOString() };
          this.companyCache.set(url.href, { expiresAt: Date.now() + 5 * 60 * 1000, info });
          while (this.companyCache.size > 100) this.companyCache.delete(this.companyCache.keys().next().value!);
          return info;
        }
        await pause(200);
      }
      throw new Error('无法核对该岗位的公司页和业务信息，已跳过该岗位');
    });
  }

  /** Read the full job's own company link, then check the company profile before passing exclusions. */
  public async readJobCompanyInfo(href: string, jobName: string, companyName: string,
    options: { filter?: AppConfig['filter']; exclusionText?: string; refreshCompany?: boolean; candidateContext?: CandidateLanguageContext } = {}): Promise<{
    brandIndustry: string; jobDetailText: string; skills: string[]; detailData: JobDetailData;
    companyInfo?: BossCompanyInfo; workAddress?: BossWorkAddress;
  }> {
    return browserService.withJobInspection(href, async (page) => {
      const expectedPath = new URL(href, ORIGIN).pathname;
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const url = await page.refreshUrl();
        if (isSecurityUrl(url)) throw new Error('CAPTCHA_REQUIRED: 公司行业核对页需要安全验证');
        if (url.includes('/web/user/')) throw new Error('BOSS 公司行业核对页要求登录，请在 Chrome 中完成登录');
        const data = await page.evaluate(() => {
          const sidebar = document.querySelector('.sider-company');
          const banner = document.querySelector('.job-banner');
          const section = [...document.querySelectorAll('.job-detail-section')].find((item) => (item.querySelector('h3') as HTMLElement | null)?.innerText?.trim() === '职位描述');
          return { path: location.pathname, name: (document.querySelector('.job-banner .name h1') as HTMLElement | null)?.innerText?.trim() || '',
            salary: (banner?.querySelector('.salary') as HTMLElement | null)?.innerText?.trim() || '',
            city: (banner?.querySelector('.text-city') as HTMLElement | null)?.innerText?.trim() || '',
            experience: (banner?.querySelector('.text-experiece') as HTMLElement | null)?.innerText?.trim() || '',
            degree: (banner?.querySelector('.text-degree') as HTMLElement | null)?.innerText?.trim() || '',
            company: sidebar?.querySelector('.company-info a[title]')?.getAttribute('title') || '',
            companyHref: sidebar?.querySelector('.company-info a[href^="/gongsi/"]')?.getAttribute('href') || '',
            industry: (sidebar?.querySelector('a[ka="job-detail-brandindustry"]') as HTMLElement | null)?.innerText?.trim() || '',
            description: (section?.querySelector('.job-sec-text') as HTMLElement | null)?.innerText?.trim() || '',
            skills: [...(section?.querySelectorAll('.job-tags span') || [])].map((item) => (item as HTMLElement).innerText?.trim() || '').filter(Boolean),
            verifying: /请完成安全验证|请进行安全验证/.test(document.body?.innerText || '') };
        });
        if (data.verifying) throw new Error('CAPTCHA_REQUIRED: 公司行业核对页需要安全验证');
        if (data.name && data.company && data.industry && data.description.length >= 20) {
          if (data.path !== expectedPath) {
            throw new Error('公司行业核对页与所选岗位不一致');
          }
          const detailData: JobDetailData = { jobHref: new URL(expectedPath, ORIGIN).href, jobName: decodeBossText(data.name),
            companyName: decodeBossText(data.company), salary: readableBossSalary(data.salary), cityName: decodeBossText(data.city),
            experience: decodeBossText(data.experience), degree: decodeBossText(data.degree), skills: data.skills.map(decodeBossText) };
          const result = { detailData, brandIndustry: data.industry, jobDetailText: decodeBossText(data.description), skills: detailData.skills,
            workAddress: await readBossWorkAddress(page) };
          if (options.filter && findJobExclusion({ jobName: decodeBossText(data.name), brandName: decodeBossText(data.company), brandIndustry: data.industry,
            jobDetail: result.jobDetailText, skills: result.skills }, options.filter, options.exclusionText)) return result;
          if (options.filter && languageQualificationIssue({ jobName: decodeBossText(data.name), skills: result.skills }, result.jobDetailText, options.filter, options.candidateContext)) return result;
          if (!data.companyHref) throw new Error('缺少该岗位的公司页链接，无法核对实际业务');
          return { ...result, companyInfo: await this.readCompanyInfo(data.companyHref, data.company, options.refreshCompany) };
        }
        await pause(200);
      }
      throw new Error('无法从当前岗位的公司基本信息读取行业，已跳过该岗位');
    });
  }

  public async loadJobDetail(card: CdpLocator, jobName: string, companyName: string, href?: string,
    options: { readIndustry?: boolean; filter?: AppConfig['filter']; exclusionText?: string; refreshCompany?: boolean; candidateContext?: CandidateLanguageContext } = {}): Promise<{
    jobDetailText: string;
    activeTimeDesc: string;
    brandIndustry: string;
    companyInfo?: BossCompanyInfo;
    workAddress?: BossWorkAddress;
    alreadyChatted: boolean;
    chatButtonLocator: CdpLocator | null;
    detailData: JobDetailData;
    cardData?: { salary: string; degree: string; experience: string; cityName: string };
  }> {
    const page = card.page();
    if (href && !(await this.isCardStillTarget(card, jobName, companyName, href))) throw new Error('职位卡片在点击前发生变化');
    await card.click();
    const deadline = Date.now() + 9000;
    let retried = false;
    let opened: DetailIdentity | null = null, settled = false;
    let stable = '', stableSince = 0;
    while (Date.now() < deadline) {
      const state = await this.inspectPage(page);
      this.throwIfUnavailable(state);
      opened = await this.readDetailIdentity(page);
      if (!this.openedDetailIssue(opened)) {
        const fingerprint = JSON.stringify([opened!.id, opened!.href, opened!.name, opened!.description]);
        if (fingerprint !== stable) { stable = fingerprint; stableSince = Date.now(); }
        if (Date.now() - stableSince >= 250) { settled = true; break; }
      } else { stable = ''; stableSince = 0; }
      // A rendered card can precede the SPA click handler. Retry that same ID once.
      if (!retried && Date.now() > deadline - 7000 && href && await this.isCardStillTarget(card, jobName, companyName, href)) {
        retried = true; await card.click();
      }
      await pause(250);
    }
    if (!settled) {
      throw new Error('详情尚未就绪：' + (this.openedDetailIssue(opened) || '内容仍在变化'));
    }
    const detail = this.detailLocator(page);
    let jobDetailText = decodeBossText((await detail.locator(DESCRIPTION).innerText()).trim());
    const bound = await detail.evaluate(element => {
      const data = (element as any).__vue__?.$props?.data;
      const info = element.querySelector('.job-detail-info');
      const text = (selector: string) => (element.querySelector(selector) as HTMLElement | null)?.innerText?.trim() || '';
      const tags = [...(info?.querySelectorAll('.tag-list li, .job-tags span') || [])].map(item => (item as HTMLElement).innerText?.trim() || '');
      const rawSkills = data?.jobInfo?.showSkills;
      const skills = Array.isArray(rawSkills) ? rawSkills.map((item: any) => typeof item === 'string' ? item : item?.name || '')
        : [...element.querySelectorAll('.job-detail-body .job-tags span')].map(item => (item as HTMLElement).innerText?.trim() || '');
      return { id: data?.jobInfo?.encryptId || '', active: data?.bossInfo?.activeTimeDesc || '',
        industry: data?.brandComInfo?.industryName || '', salary: data?.jobInfo?.salaryDesc || '',
        name: text('.job-detail-info .job-name') || data?.jobInfo?.jobName || '',
        company: data?.brandComInfo?.brandName || text('.company-info .company-name, .company-name'),
        companyHref: element.querySelector('a[href^="/gongsi/"]')?.getAttribute('href') || '',
        degree: data?.jobInfo?.degreeName || tags.find(tag => /博士|硕士|本科|大专|专科|高中|中专|中技|职高|初中|学历/.test(tag)) || '',
        experience: data?.jobInfo?.experienceName || tags.find(tag => /年|应届|在校|经验/.test(tag)) || '',
        city: data?.jobInfo?.locationName || text('.job-detail-info .job-location, .job-detail-info .location-name'),
        domSalary: text('.job-detail-info .salary, .job-detail-info .job-salary'),
        skills: skills as string[] };
    });
    const detailHref = bossJobId(opened!.href) ? opened!.href : '/job_detail/' + opened!.id + '.html';
    const detailData: JobDetailData = { jobHref: new URL(detailHref, ORIGIN).href, jobName: decodeBossText(bound.name),
      companyName: decodeBossText(bound.company), salary: readableBossSalary(bound.domSalary || bound.salary),
      degree: decodeBossText(bound.degree), experience: decodeBossText(bound.experience), cityName: decodeBossText(bound.city).split('·')[0].trim(),
      skills: bound.skills.map(decodeBossText).filter(Boolean) };
    const recruiterText = decodeBossText(await detail.locator('.job-boss-info').first().innerText({ timeout: 500 }).catch(() => ''));
    const activeTimeDesc = typeof bound.active === 'string' && bound.active ? decodeBossText(bound.active)
      : recruiterText.match(/刚刚活跃|今日活跃|今天活跃|在线|\d+\s*(?:日内|天前|周内)活跃|本周活跃|本月活跃/)?.[0] || '';
    let brandIndustry = decodeBossText((await detail.locator('a[ka="job-detail-brandindustry"]').first().innerText({ timeout: 200 }).catch(() => '')).trim()
      || (typeof bound.industry === 'string' ? bound.industry : ''));
    let companyInfo: BossCompanyInfo | undefined;
    let workAddress = await readBossWorkAddress(page);
    const rejectEarly = options.filter && (findJobExclusion({ jobName: detailData.jobName, brandName: detailData.companyName, brandIndustry,
      jobDetail: jobDetailText, skills: detailData.skills }, options.filter, options.exclusionText)
      || languageQualificationIssue({ jobName: detailData.jobName, skills: detailData.skills }, jobDetailText, options.filter, options.candidateContext)
      || jobInformationIssue({ jobDetail: jobDetailText }, options.filter)
      || commuteDecision({ workAddress }, options.filter).status === 'failed');
    if ((options.readIndustry && !rejectEarly) || !detailData.companyName) {
      const companyHref = bound.companyHref;
      if (companyHref) {
        companyInfo = await this.readCompanyInfo(companyHref, detailData.companyName, options.refreshCompany);
        brandIndustry = companyInfo.industry;
      } else {
        const fullPage = await this.readJobCompanyInfo(detailData.jobHref, detailData.jobName, detailData.companyName, options);
        brandIndustry = fullPage.brandIndustry;
        jobDetailText = fullPage.jobDetailText;
        companyInfo = fullPage.companyInfo;
        workAddress = fullPage.workAddress || workAddress;
        detailData.skills = fullPage.skills;
        for (const key of ['jobName', 'companyName', 'salary', 'degree', 'experience', 'cityName'] as const) {
          if (fullPage.detailData[key]) detailData[key] = fullPage.detailData[key];
        }
      }
    }
    if (companyInfo) detailData.companyName = companyInfo.name;
    const button = page.locator(CHAT).filter({ visible: true }).first();
    const visible = await button.isVisible({ timeout: 800 }).catch(() => false);
    const label = visible ? (await button.innerText()).trim() : '';
    return { jobDetailText, activeTimeDesc, brandIndustry, workAddress, detailData, ...(companyInfo ? { companyInfo } : {}),
      cardData: { salary: detailData.salary, degree: detailData.degree, experience: detailData.experience, cityName: detailData.cityName },
      alreadyChatted: /继续沟通|已在沟通/.test(label), chatButtonLocator: visible ? button : null };
  }

  public async isJobListPage(): Promise<boolean> {
    const state = await this.inspectPage(await browserService.getWorkerPage());
    return state.kind === 'jobs' || state.kind === 'empty';
  }

  /** Open a saved review's own job page; all fields come from that page before a manual application. */
  public async loadReviewJob(page: CdpPage, review: WorkConditionReview, filter: AppConfig['filter']): Promise<{
    job: BossJobItem; jobDetailText: string; alreadyChatted: boolean; chatButtonLocator: CdpLocator | null;
  }> {
    const deadline = Date.now() + this.pageReadyTimeoutMs;
    while (Date.now() < deadline && !(await this.isDetailStillTarget(review.jobName, review.companyName, review.jobHref, page))) {
      this.throwIfUnavailable(await this.inspectPage(page));
      await pause(this.pagePollIntervalMs);
    }
    if (!(await this.isDetailStillTarget(review.jobName, review.companyName, review.jobHref, page))) throw new Error('待确认岗位与当前详情身份不一致');
    const data = await page.evaluate(() => {
      const section = [...document.querySelectorAll('.job-detail-section')].find(item => (item.querySelector('h3') as HTMLElement | null)?.innerText?.trim() === '职位描述');
      const banner = document.querySelector('.job-banner');
      return { description: (section?.querySelector('.job-sec-text') as HTMLElement | null)?.innerText?.trim() || '',
        name: (banner?.querySelector('.name h1') as HTMLElement | null)?.innerText?.trim() || '',
        company: document.querySelector('.sider-company .company-info a[title]')?.getAttribute('title') || '',
        salary: (banner?.querySelector('.salary') as HTMLElement | null)?.innerText?.trim() || '',
        city: (banner?.querySelector('.text-city') as HTMLElement | null)?.innerText?.trim() || '',
        experience: (banner?.querySelector('.text-experiece') as HTMLElement | null)?.innerText?.trim() || '',
        degree: (banner?.querySelector('.text-degree') as HTMLElement | null)?.innerText?.trim() || '',
        skills: [...(section?.querySelectorAll('.job-tags span') || [])].map(item => (item as HTMLElement).innerText?.trim() || '').filter(Boolean),
        industry: (document.querySelector('.sider-company a[ka="job-detail-brandindustry"]') as HTMLElement | null)?.innerText?.trim() || '',
        companyHref: document.querySelector('.sider-company .company-info a[href^="/gongsi/"]')?.getAttribute('href') || '',
        recruiter: (document.querySelector('.job-boss-info, .boss-info-attr') as HTMLElement | null)?.innerText || '' };
    });
    const jobDetailText = decodeBossText(data.description);
    if (!jobDetailText.trim()) throw new Error('待确认岗位详情尚未加载，未发起沟通');
    const job: BossJobItem = { securityId: '', jobId: bossJobId(review.jobHref), lid: '', jobName: decodeBossText(data.name), brandName: decodeBossText(data.company),
      salaryDesc: readableBossSalary(data.salary), cityName: decodeBossText(data.city), jobExperience: decodeBossText(data.experience), jobDegree: decodeBossText(data.degree),
      brandIndustry: decodeBossText(data.industry), skills: data.skills.map(decodeBossText), activeTimeDesc: data.recruiter.match(/刚刚活跃|今日活跃|今天活跃|在线|\d+\s*日内活跃|本周活跃|本月活跃/)?.[0] || '',
      areaDistrict: '', brandScaleName: '', bossName: '', bossTitle: '', welfareList: [] };
    job.workAddress = await readBossWorkAddress(page);
    const candidate = { text: review.screening?.languageEvidence || '', source: 'resume' as const };
    const earlyExclusion = findJobExclusion({ ...job, jobDetail: jobDetailText }, filter, '', review.screening?.taskExclusions)
      || languageQualificationIssue(job, jobDetailText, filter, candidate) || jobInformationIssue({ jobDetail: jobDetailText }, filter)
      || commuteDecision(job, filter).status === 'failed';
    if (!earlyExclusion && data.companyHref) {
      job.companyInfo = await this.readCompanyInfo(data.companyHref, job.brandName, true);
      job.brandIndustry = job.companyInfo.industry;
      job.brandName = job.companyInfo.name;
    }
    const button = page.locator(CHAT).filter({ visible: true }).first();
    const visible = await button.isVisible();
    const label = visible ? (await button.innerText()).trim() : '';
    if (visible && /立即沟通/.test(label)) {
      const loginLink = await button.evaluate(element => element.getAttribute('ka') || '');
      if (/tosign/.test(loginLink)) throw new Error('BOSS 登录已失效，请重新登录后投递');
    }
    return { job, jobDetailText, alreadyChatted: /继续沟通|已在沟通/.test(label), chatButtonLocator: visible ? button : null };
  }

  /** Resolve a user-selected starting place using BOSS's existing map search. */
  public async searchCommuteOrigins(query: string, cityName: string, cityCode: string): Promise<CommuteOrigin[]> {
    let page = await browserService.getWorkerPage();
    if (!(await this.isJobListPage())) page = await this.initJobPage(undefined, cityCode);
    await this.ensureLoggedIn(page);
    const selectedHref = await page.locator('.job-detail-box .more-job-btn').first()
      .evaluate(element => element.getAttribute('href') || '').catch(() => '');
    const href = selectedHref || (await this.getVisibleJobCards())[0]?.jobHref;
    if (!href) throw new Error('BOSS 当前没有岗位可打开地图，请先切换到有岗位的职位列表');
    return browserService.withJobInspection(href, async inspection => {
      if (!(await readBossWorkAddress(inspection))) throw new Error('参考岗位未提供地图地址，请在 BOSS 中先选择有地址的岗位');
      return bossMapService.searchOrigins(inspection, query, cityName);
    });
  }

  public async readJobTransit(target: { jobHref: string; jobName: string; companyName: string }, origin: CommuteOrigin,
    address: BossWorkAddress, ownedPage?: CdpPage): Promise<{ minutes: number; summary: string }> {
    const page = ownedPage || await browserService.getWorkerPage();
    if (!(await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref, page))) throw new Error('岗位身份已变化，未查询通勤');
    const result = await bossMapService.readTransit(page, origin, address);
    if (!(await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref, page))) throw new Error('岗位身份已变化，通勤结果未采用');
    return result;
  }

  /** BOSS 自选期望中的“不合适”位于右侧详情；点击前再次核对岗位链接。 */
  public async markJobNotSuit(card: CdpLocator, target: { jobName: string; companyName: string; jobHref: string; sourceHref?: string },
    _localReason = ''): Promise<boolean> {
    const page = card.page();
    const selected = await page.locator('.expect-item.active').first().innerText({ timeout: 200 }).catch(() => '');
    const feedbackScope = (page.id || page.url()) + '|' + selected;
    const dialog = page.locator('.zp-feedback-dialog').filter({ visible: true }).first();
    if (await dialog.isVisible()) return false;
    const hasDetail = await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref);
    if (!hasDetail && !(await this.isCardStillTarget(card, target.jobName, target.companyName, target.sourceHref || target.jobHref))) return false;
    this.rememberNotSuitable(target);
    if ((this.feedbackUnavailableUntil.get(feedbackScope) || 0) > Date.now()) return false;
    if (!hasDetail) {
      await card.click();
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && !(await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref))) {
        this.throwIfUnavailable(await this.inspectPage(page));
        await pause(200);
      }
    }
    const button = page.locator('.job-detail-box .job-detail-operate .not-suitable').filter({ visible: true }).first();
    if (!(await button.isVisible({ timeout: 300 }).catch(() => false))
      || !(await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref))) return false;
    const previousMessage = await page.locator('.zp-toast').filter({ visible: true }).first().innerText({ timeout: 100 }).catch(() => '');
    if (/已进行反馈|反馈成功/.test(previousMessage)) {
      const cleared = await page.waitForFunction(() => ![...document.querySelectorAll('.zp-toast')]
        .some((item) => (item as HTMLElement).getClientRects().length && /已进行反馈|反馈成功/.test(item.textContent || '')),
      null, { timeout: 3000 }).then(() => true).catch(() => false);
      if (!cleared || !(await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref))) return false;
    }
    const before = await page.evaluate(() => [...document.querySelectorAll('.toast-content, .toast, .message-content, .zp-toast')]
      .filter((item) => (item as HTMLElement).getClientRects().length).map((item) => item.textContent?.trim()).join('|'));
    await button.click();
    let deadline = Date.now() + 4500;
    let confirmed = false;
    while (Date.now() < deadline) {
      const feedback = await page.evaluate(({ href, oldFeedback, selectedName }) => {
        const visible = (item: Element) => (item as HTMLElement).getClientRects().length > 0;
        const messages = [...document.querySelectorAll('.toast-content, .toast, .message-content, .zp-toast')]
          .filter(visible).map((item) => item.textContent?.trim()).join('|');
        const jobPath = new URL(href, location.href).pathname;
        const targetRemains = [...document.querySelectorAll('li.job-card-box a.job-name')]
          .some((item) => new URL(item.getAttribute('href') || '', location.href).pathname === jobPath);
        const sameList = location.pathname === '/web/geek/jobs'
          && ((document.querySelector('.expect-item.active') as HTMLElement | null)?.innerText || '') === selectedName;
        const dialog = [...document.querySelectorAll('.zp-feedback-dialog')].find(visible);
        return { targetRemains, sameList, success: messages !== oldFeedback && /已标记|不再推荐|减少推荐|操作成功|反馈成功|已进行反馈|感谢.{0,8}反馈/.test(messages),
          failed: messages !== oldFeedback && /失败|频繁|稍后|上限|提交内容为空/.test(messages),
          limited: messages !== oldFeedback && /操作频繁|请求过于频繁|稍后再试/.test(messages), needsConfirmation: Boolean(dialog && visible(dialog)) };
      }, { href: target.jobHref, oldFeedback: before, selectedName: selected });
      if (feedback.limited) bossActionScheduler.limit();
      if (feedback.failed) break;
      if (confirmed && feedback.sameList && (feedback.success || !feedback.targetRemains)) {
        await page.waitForFunction(() => ![...document.querySelectorAll('.zp-feedback-dialog')]
          .some((item) => (item as HTMLElement).getClientRects().length > 0), null, { timeout: 2000 }).catch(() => {});
        return true;
      }
      if (feedback.needsConfirmation && !confirmed) {
        const title = (await dialog.locator('.zp-title').innerText({ timeout: 200 }).catch(() => '')).trim();
        if (title !== '选择原因，减少不合适职位推荐') return false;
        const confirm = dialog.locator('[ka="dialog_sure"].zp-btn-sure').first();
        if (!(await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref))
          || !(await confirm.isVisible())) return false;
        // Internal screening, company analysis and candidate information stay local.
        // Prefer the site's company option so its other jobs stop being recommended.
        const choices = await dialog.locator('.zp-type-item').evaluateAll(items => items.map(item => ({
          text: (item as HTMLElement).innerText.trim(), visible: (item as HTMLElement).getClientRects().length > 0,
        })));
        if (!choices.some(item => item.visible)) { await pause(250); continue; }
        const companyChoice = choices.findIndex(item => item.visible && sameCompany(
          item.text.match(/^[“"「](.+)[”"」]公司$/)?.[1] || '', target.companyName));
        const index = companyChoice >= 0 ? companyChoice : choices.findIndex(item => item.visible);
        if (index < 0) {
          // Avoid reopening a known unsupported feedback menu on every rejected job.
          this.feedbackUnavailableUntil.set(feedbackScope, Date.now() + 60000);
          while (this.feedbackUnavailableUntil.size > 50) this.feedbackUnavailableUntil.delete(this.feedbackUnavailableUntil.keys().next().value!);
          await dialog.locator('[ka="dialog_cancel"]').first().click().catch(() => {});
          return false;
        }
        await dialog.locator('.zp-type-item').nth(index).click();
        const comment = dialog.locator('textarea.zp-type-textarea').first();
        if (await comment.isVisible() && await comment.inputValue()) await comment.fill('');
        if (!(await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref))) return false;
        if (await confirm.evaluate(element => element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true'
          || /(?:^|\s)(?:disabled|is-disabled)(?:\s|$)/.test(element.className))) {
          await dialog.locator('[ka="dialog_cancel"]').first().click().catch(() => {}); return false;
        }
        await clickBossAction(confirm, 'feedback', async () => {
          if (!(await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref))) {
            throw new Error('岗位已经切换，未提交不合适反馈');
          }
        });
        confirmed = true;
        deadline = Date.now() + 4500;
      }
      await pause(200);
    }
    if (await dialog.isVisible() && (await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref))) {
      await dialog.locator('[ka="dialog_cancel"]').first().click().catch(() => {});
    }
    return false;
  }

  private async chatInterruption(page: CdpPage): Promise<ChatResult | null> {
    const state = await this.inspectPage(page);
    if (state.kind === 'captcha') return { success: false, needCaptcha: true };
    if (state.kind === 'login') return { success: false, loginRequired: true };
    if (state.kind === 'blocked') return { success: false, uncertain: true };
    const text = await page.locator('.dialog-wrap, .boss-dialog, .toast-content').first()
      .innerText({ timeout: 400 }).catch(() => '');
    if (/沟通.*上限|今日.*上限|次数已满/.test(text)) return { success: false, quotaExceeded: true };
    if (/操作频繁|稍后再试|请求过于频繁/.test(text)) {
      bossActionScheduler.limit(); return { success: false, isCoolDown: true };
    }
    return null;
  }

  private async sentDialogButton(page: CdpPage): Promise<CdpLocator | null> {
    const buttons = page.locator('button:has-text("继续沟通"), a:has-text("继续沟通")').filter({ visible: true });
    const index = await buttons.evaluateAll(elements => elements.findIndex(element => {
      if ((element as HTMLElement).innerText?.trim() !== '继续沟通') return false;
      let parent = element.parentElement;
      while (parent && parent !== document.body) {
        if (/dialog|modal/.test(parent.className) || parent.getAttribute('role') === 'dialog') {
          if (/已向\s*BOSS\s*发送消息/i.test(parent.innerText || '')) return true;
        }
        parent = parent.parentElement;
      }
      return false;
    }));
    return index >= 0 ? buttons.nth(index) : null;
  }

  private async finishSentDialog(page: CdpPage, button: CdpLocator): Promise<ChatResult> {
    try {
      await button.click();
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (!(await this.sentDialogButton(page))) return { success: true, verified: true, platformGreeting: true, continued: true };
        await pause(150);
      }
    } catch { /* The acknowledgement still proves the greeting was sent. */ }
    return { success: true, verified: true, platformGreeting: true, continuationFailed: true };
  }

  private async waitForChatSignal(page: CdpPage, target?: { jobName: string; companyName: string; jobHref: string }): Promise<ChatResult> {
    const deadline = Date.now() + 6500;
    while (Date.now() < deadline) {
      const interrupted = await this.chatInterruption(page);
      if (interrupted) return interrupted;
      const sent = await this.sentDialogButton(page);
      if (sent) return this.finishSentDialog(page, sent);
      if (target && await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref, page)) {
        const label = await page.locator(CHAT).first().innerText({ timeout: 300 }).catch(() => '');
        if (/继续沟通|已在沟通/.test(label)) return { success: true, verified: true };
      }
      const currentUrl = typeof page.refreshUrl === 'function' ? await page.refreshUrl() : page.url();
      if (currentUrl.includes('/web/geek/chat') && target) {
        const body = await page.locator('body').innerText({ timeout: 500 }).catch(() => '');
        if (body.includes(target.companyName) && body.includes(target.jobName)) return { success: true, verified: true };
      }
      await pause(350);
    }
    return { success: false, uncertain: true };
  }

  /** 点击后必须观察到目标岗位的沟通反馈；未知结果令批次停止。 */
  public async executeChatClick(
    chatButton: CdpLocator, greeting?: string,
    target?: { jobName: string; companyName: string; jobHref: string },
  ): Promise<ChatResult> {
    const page = chatButton.page();
    if (target && !(await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref, page))) {
      return { success: false, targetChanged: true };
    }
    const label = (await chatButton.innerText().catch(() => '')).trim();
    if (!label.includes('立即沟通')) return { success: false, targetChanged: true };
    if (await this.sentDialogButton(page)) return { success: false, uncertain: true };
    let clicked = false;
    try {
      await clickBossAction(chatButton, 'submit', async () => {
        if (target && !(await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref, page))) {
          throw new Error('岗位已经切换，未发起沟通');
        }
      });
      clicked = true;
      await pause(200);
      let interrupted = await this.chatInterruption(page);
      if (interrupted) return interrupted;
      const acknowledgement = await this.sentDialogButton(page);
      if (acknowledgement) return this.finishSentDialog(page, acknowledgement);
      const input = page.locator('.dialog-wrap textarea, .boss-dialog textarea, textarea[placeholder*="打招呼"]').first();
      if (await input.isVisible({ timeout: 1600 }).catch(() => false)) {
        if (!greeting?.trim()) return { success: false, uncertain: true };
        if (target && !(await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref, page))) {
          return { success: false, uncertain: true };
        }
        const dialog = input.locator('xpath=ancestor::*[contains(@class,"dialog-wrap") or contains(@class,"chat-input")][1]');
        const send = dialog.locator('button:has-text("发送"), button:has-text("确定")').first();
        if (!(await send.isVisible({ timeout: 800 }).catch(() => false))) return { success: false, uncertain: true };
        await input.fill(greeting.trim());
        await clickBossAction(send, 'submit', async () => {
          if (target && !(await this.isDetailStillTarget(target.jobName, target.companyName, target.jobHref, page))) {
            throw new Error('岗位已经切换，未发送消息');
          }
        });
        interrupted = await this.chatInterruption(page);
        if (interrupted) return interrupted;
        const result = await this.waitForChatSignal(page, target);
        return { ...result, greetingSent: result.success };
      }
      return { ...await this.waitForChatSignal(page, target), greetingSent: false };
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
    await runBossAction(page, 'navigation', () => page.evaluate(() => {
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
    }));
    await pause(900);
  }
}

export const bossPageService = new BossPageService();
