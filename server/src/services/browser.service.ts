import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { CdpConnection, CdpPage } from './cdp.page.js';

const BOSS_ORIGIN = 'https://www.zhipin.com';
const LOGIN_URL = `${BOSS_ORIGIN}/web/user/?ka=header-login`;
const JOBS_URL = `${BOSS_ORIGIN}/web/geek/jobs`;
const DEFAULT_PROFILE_DIR = path.resolve(process.env.BOSS_PROFILE_DIR || path.resolve(process.cwd(), '../data/boss-profile-v3'));
const SESSION_COOKIES = new Set(['wt2', 'zp_at']);

export interface LoginStatus {
  isLoggedIn: boolean;
  isBrowserActive: boolean;
  reason?: string;
  reasonCode?: 'login_required' | 'verification_required' | 'browser_unavailable' | 'unverified';
}

interface ChromeTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

function chromeExecutable(): string {
  const candidates = [
    process.env.BOSS_CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((value): value is string => !!value);
  const found = candidates.find((value) => fs.existsSync(value));
  if (!found) throw new Error('没有找到 Google Chrome；请安装 Chrome 或设置 BOSS_CHROME_PATH');
  return found;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

export function isSecurityUrl(url: string): boolean {
  return /\/web\/passport\/zp\/security\.html|\/security-check\.html/i.test(url);
}

export class BrowserService {
  constructor(private readonly profileDir = DEFAULT_PROFILE_DIR, private readonly options: { headless?: boolean } = {}) {}
  private chrome: ChildProcess | null = null;
  private port: number | null = null;
  private launchPromise: Promise<void> | null = null;
  private pages = new Map<string, CdpPage>();
  private loginPage: CdpPage | null = null;
  private workerPage: CdpPage | null = null;
  private verificationPage: CdpPage | null = null;
  private loginPromise: Promise<void> | null = null;
  private workerPromise: Promise<CdpPage> | null = null;
  private lastSessionRecordAt = 0;

  private async browserIdentity(port: number): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('Chrome 调试服务不可用');
    const version = await response.json() as { webSocketDebuggerUrl?: string };
    const debuggerUrl = new URL(version.webSocketDebuggerUrl || '');
    if (debuggerUrl.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(debuggerUrl.hostname)
        || Number(debuggerUrl.port) !== port || !debuggerUrl.pathname.startsWith('/devtools/browser/')) {
      throw new Error('Chrome 调试服务地址不正确');
    }
    return debuggerUrl.pathname;
  }

  private async tryReconnectChrome(): Promise<boolean> {
    try {
      const runtime = JSON.parse(fs.readFileSync(path.join(this.profileDir, 'boss-browser-runtime.json'), 'utf8'));
      if (!Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535
          || typeof runtime.browserIdentity !== 'string') return false;
      // 端口可能被其他程序复用，必须核对该资料目录保存的浏览器实例标识。
      if (await this.browserIdentity(runtime.port) !== runtime.browserIdentity) return false;
      this.port = runtime.port;
      await this.listTabs();
      return true;
    } catch { /* 浏览器已经关闭或记录过期时，正常创建新的专用窗口。 */ }
    this.port = null;
    return false;
  }

  private async rememberChrome(port: number): Promise<void> {
    const runtimePath = path.join(this.profileDir, 'boss-browser-runtime.json');
    const metadata = { port, browserIdentity: await this.browserIdentity(port) };
    fs.writeFileSync(`${runtimePath}.tmp`, JSON.stringify(metadata), 'utf8');
    fs.renameSync(`${runtimePath}.tmp`, runtimePath);
  }

  private async listTabs(): Promise<ChromeTarget[]> {
    if (!this.port) return [];
    const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`Chrome 连接失败：HTTP ${response.status}`);
    return (await response.json() as ChromeTarget[]).filter((tab) => tab.type === 'page');
  }

  private async ensureChrome(openLogin: boolean): Promise<void> {
    if (this.port) {
      try { await this.listTabs(); return; } catch {
        for (const page of this.pages.values()) page.closeConnection();
        this.port = null;
        this.pages.clear();
        this.loginPage = null;
        this.workerPage = null;
        this.verificationPage = null;
      }
    }
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = (async () => {
      fs.mkdirSync(this.profileDir, { recursive: true });
      if (await this.tryReconnectChrome()) return;
      const port = await freePort();
      const child = spawn(chromeExecutable(), [
        `--user-data-dir=${this.profileDir}`,
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        '--no-first-run',
        '--no-default-browser-check',
        ...(this.options.headless ? ['--headless=new'] : []),
        '--new-window',
        openLogin ? LOGIN_URL : JOBS_URL,
      ], { stdio: 'ignore', windowsHide: !!this.options.headless, detached: true });
      this.chrome = child;
      this.port = port;
      for (let attempt = 0; attempt < 80; attempt++) {
        if (child.exitCode !== null) break;
        try {
          await this.listTabs();
          // Chrome may expose CDP before its first tab. Register this instance immediately;
          // getWorkerPage/getLoginPage will create the needed tab without another launch.
          await this.rememberChrome(port);
          return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      this.port = null;
      throw new Error('BOSS 登录窗口启动失败；专用 Chrome 资料目录可能正被其他窗口占用');
    })();
    try { await this.launchPromise; } finally { this.launchPromise = null; }
  }

  private async pageFor(tab: ChromeTarget): Promise<CdpPage> {
    const existing = this.pages.get(tab.id);
    if (existing && !existing.isClosed()) return existing;
    if (!tab.webSocketDebuggerUrl) throw new Error('Chrome 页面没有调试地址');
    const page = await new CdpPage(tab.id, await CdpConnection.connect(tab.webSocketDebuggerUrl), tab.url).initialize();
    this.pages.set(tab.id, page);
    return page;
  }

  private async createPage(url: string, background = false): Promise<CdpPage> {
    await this.ensureChrome(false);
    if (background) {
      const identity = await this.browserIdentity(this.port!);
      const connection = await CdpConnection.connect(`ws://127.0.0.1:${this.port}${identity}`);
      try {
        const { targetId } = await connection.send('Target.createTarget', { url, background: true });
        const target = (await this.listTabs()).find((tab) => tab.id === targetId);
        if (!target) throw new Error('Chrome 无法创建公司行业核对页');
        return this.pageFor(target);
      } finally { connection.close(); }
    }
    const response = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT', signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('Chrome 无法创建页面');
    return this.pageFor(await response.json() as ChromeTarget);
  }

  /** Inspect the actual job page in the same profile, without changing the login or delivery tabs. */
  public async withJobInspection<T>(href: string, read: (page: CdpPage) => Promise<T>): Promise<T> {
    return this.withBossInspection(href, /^\/job_detail\/[^/]+\.html$/, read);
  }

  /** Manual review applications use the visible worker tab and keep the conversation open. */
  public async withReviewApplication<T>(href: string, apply: (page: CdpPage) => Promise<T>): Promise<T> {
    const url = new URL(href, BOSS_ORIGIN);
    if (url.protocol !== 'https:' || url.hostname !== 'www.zhipin.com' || url.port || url.username || url.password
      || !/^\/job_detail\/[^/]+\.html$/.test(url.pathname)) throw new Error('待确认岗位链接无效');
    const page = await this.getWorkerPage();
    await page.goto(url.href, { timeout: 15000 });
    await page.bringToFront();
    return apply(page);
  }

  public async withCompanyInspection<T>(href: string, read: (page: CdpPage) => Promise<T>): Promise<T> {
    return this.withBossInspection(href, /^\/gongsi\/[^/]+\.html$/, read);
  }

  public async withExpectationEditor<T>(edit: (page: CdpPage) => Promise<T>): Promise<T> {
    return this.withBossInspection(`${BOSS_ORIGIN}/web/geek/resume/`, /^\/web\/geek\/resume\/$/, edit);
  }

  private async withBossInspection<T>(href: string, allowedPath: RegExp, read: (page: CdpPage) => Promise<T>): Promise<T> {
    const url = new URL(href, BOSS_ORIGIN);
    if (url.protocol !== 'https:' || url.hostname !== 'www.zhipin.com' || url.port || url.username || url.password
      || !allowedPath.test(url.pathname)) throw new Error('公司业务核对链接无效');
    if (this.verificationPage && !this.verificationPage.isClosed() && await this.checkCaptcha()) {
      throw new Error('CAPTCHA_REQUIRED: 公司行业核对页需要安全验证');
    }
    const page = await this.createPage(url.href, true);
    try {
      await page.waitForFunction((target) => {
        const expected = new URL(target), current = new URL(location.href);
        return document.readyState !== 'loading' && current.hostname === expected.hostname
          && (current.pathname === expected.pathname || current.pathname.startsWith('/web/user/')
            || /\/security-check\.html|\/web\/passport\/zp\/security\.html/.test(current.pathname));
      }, url.href, { timeout: 15000 });
      return await read(page);
    } finally {
      const currentUrl = await page.refreshUrl();
      const verifying = await page.evaluate(() => /请完成安全验证|请进行安全验证/.test(document.body?.innerText || '')).catch(() => false);
      if (isSecurityUrl(currentUrl) || currentUrl.includes('/web/user/') || verifying) {
        this.verificationPage = page;
        await page.bringToFront().catch(() => {});
      } else {
        await fetch(`http://127.0.0.1:${this.port}/json/close/${page.id}`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
        page.closeConnection();
        this.pages.delete(page.id);
      }
    }
  }

  private async getLoginPage(): Promise<CdpPage> {
    await this.ensureChrome(true);
    if (this.loginPage && !this.loginPage.isClosed()) return this.loginPage;
    const tabs = await this.listTabs();
    const login = tabs.find((tab) => tab.url.startsWith(`${BOSS_ORIGIN}/web/user/`))
      || tabs.find((tab) => tab.url === 'about:blank' && tab.id !== this.workerPage?.id);
    this.loginPage = login ? await this.pageFor(login) : await this.createPage(LOGIN_URL);
    return this.loginPage;
  }

  public async getWorkerPage(): Promise<CdpPage> {
    if (this.workerPromise) return this.workerPromise;
    this.workerPromise = this.openWorkerPage();
    try { return await this.workerPromise; } finally { this.workerPromise = null; }
  }

  private async openWorkerPage(): Promise<CdpPage> {
    await this.ensureChrome(false);
    if (this.workerPage && !this.workerPage.isClosed()) return this.workerPage;
    let tabs = await this.listTabs();
    if (!tabs.length && this.chrome) {
      for (let attempt = 0; attempt < 10 && !tabs.length; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 150)); tabs = await this.listTabs();
      }
    }
    const jobs = tabs.find((tab) => tab.url.startsWith(JOBS_URL) && tab.id !== this.loginPage?.id)
      || tabs.find((tab) => tab.url === 'about:blank' && tab.id !== this.loginPage?.id);
    this.workerPage = jobs ? await this.pageFor(jobs) : await this.createPage(JOBS_URL);
    if (await this.workerPage.refreshUrl() === 'about:blank') await this.workerPage.goto(JOBS_URL, { timeout: 30000 });
    return this.workerPage;
  }

  private async getSessionCookies(): Promise<{ name: string; value: string; expires?: number }[]> {
    const page = this.loginPage && !this.loginPage.isClosed()
      ? this.loginPage : this.workerPage && !this.workerPage.isClosed() ? this.workerPage : await this.getWorkerPage();
    return page.getCookies(BOSS_ORIGIN);
  }

  private async hasSessionCookie(): Promise<boolean> {
    const cookies = await this.getSessionCookies();
    return cookies.some((cookie) => SESSION_COOKIES.has(cookie.name) && !!cookie.value);
  }

  private async recordVerifiedSession(): Promise<void> {
    if (Date.now() - this.lastSessionRecordAt < 60_000) return;
    const cookies = await this.getSessionCookies();
    const auth = cookies.filter((cookie) => SESSION_COOKIES.has(cookie.name) && !!cookie.value);
    if (!auth.length) return;
    const metadata = {
      verifiedAt: new Date().toISOString(),
      cookieNames: auth.map((cookie) => cookie.name).sort(),
      expiresAt: Math.min(...auth.map((cookie) => cookie.expires || Number.MAX_SAFE_INTEGER)),
    };
    const metadataPath = path.resolve(this.profileDir, '..', 'boss-session.json');
    const temp = `${metadataPath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(metadata, null, 2), 'utf8');
    fs.renameSync(temp, metadataPath);
    this.lastSessionRecordAt = Date.now();
  }

  private async restoreSession(): Promise<void> {
    if (!fs.existsSync(path.join(this.profileDir, 'Default', 'Network', 'Cookies'))) return;
    await this.ensureChrome(false);
    if (!(await this.hasSessionCookie())) return;
    const worker = await this.getWorkerPage();
    if ((await worker.refreshUrl()) === 'about:blank') {
      await worker.goto(JOBS_URL, { timeout: 30000 });
      await this.waitForJobsOrLogin(worker);
    }
  }

  private async waitForJobsOrLogin(page: CdpPage): Promise<void> {
    await page.waitForFunction(() =>
      !!document.querySelector('li.job-card-box, .search-empty, .job-list-empty')
      || location.pathname.startsWith('/web/user/'), null, { timeout: 15000 }).catch(() => {});
  }

  /** Cookie 只是线索；职位页 DOM 才能证实已登录。 */
  public async checkLoginStatus(): Promise<LoginStatus> {
    try { await this.restoreSession(); } catch (error) {
      return { isLoggedIn: false, isBrowserActive: !!this.port, reasonCode: 'browser_unavailable', reason: `恢复 BOSS 会话失败：${(error as Error).message}` };
    }
    if (!this.port) return { isLoggedIn: false, isBrowserActive: false, reasonCode: 'login_required', reason: '尚无可用的 BOSS 登录会话' };
    try {
      const tabs = await this.listTabs();
      if (!tabs.length) return { isLoggedIn: false, isBrowserActive: false, reasonCode: 'browser_unavailable', reason: 'Chrome 窗口已关闭' };
      let pageIssue = '';
      if (this.loginPage && !this.loginPage.isClosed()) {
        const loginUrl = await this.loginPage.refreshUrl();
        if (loginUrl === 'about:blank') pageIssue = 'BOSS 登录页变成空白页';
        if (isSecurityUrl(loginUrl)) pageIssue = 'BOSS 登录页需要人工安全验证';
      }
      if (!(await this.hasSessionCookie())) {
        return { isLoggedIn: false, isBrowserActive: true, reasonCode: 'login_required', reason: pageIssue || '尚未检测到登录会话' };
      }
      const candidates = [this.workerPage, this.loginPage].filter((page): page is CdpPage => !!page && !page.isClosed());
      for (const page of candidates) {
        const url = await page.refreshUrl();
        if (isSecurityUrl(url)) {
          pageIssue = 'BOSS 要求人工完成安全验证';
          continue;
        }
        if (!url.includes('/web/geek/')) continue;
        const state = await page.evaluate(() => {
          const body = document.body?.innerText || '';
          const loginModal = [...document.querySelectorAll('.login-register-box, .sign-wrap, [class*="login-dialog"]')]
            .some((element) => (element as HTMLElement).getClientRects().length > 0);
          const loginLink = [...document.querySelectorAll('a[href*="/web/user/"]')]
            .some((element) => /登录\s*\/\s*注册/.test(element.textContent || '') && (element as HTMLElement).getClientRects().length > 0);
          const hasPageContent = body.trim().length > 5
            && !!document.querySelector('.rec-job-list, .job-detail-box, .search-empty, .job-list-empty');
          return { loginModal, loginLink, hasPageContent };
        }).catch(() => ({ loginModal: false, loginLink: false, hasPageContent: false }));
        if (state.loginModal || state.loginLink) {
          pageIssue = '页面要求重新登录';
          continue;
        }
        if (state.hasPageContent) {
          await this.recordVerifiedSession();
          return { isLoggedIn: true, isBrowserActive: true };
        }
      }
      const reasonCode = pageIssue.includes('安全验证') ? 'verification_required'
        : pageIssue.includes('重新登录') ? 'login_required' : 'unverified';
      return { isLoggedIn: false, isBrowserActive: true, reasonCode, reason: pageIssue || '尚未看到已登录的职位页面' };
    } catch (error) {
      return { isLoggedIn: false, isBrowserActive: false, reasonCode: 'browser_unavailable', reason: `Chrome 连接失败：${(error as Error).message}` };
    }
  }

  /** 打开并保持普通 Chrome 扫码页，不自动切页。 */
  public async promptLogin(): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.openLoginPage();
    try { await this.loginPromise; } finally { this.loginPromise = null; }
  }

  private async openLoginPage(): Promise<void> {
    if ((await this.checkLoginStatus()).isLoggedIn) return;
    const page = await this.getLoginPage();
    const url = await page.refreshUrl();
    if (isSecurityUrl(url)) {
      await page.bringToFront();
      throw new Error('BOSS 直聘正在进行安全验证，请先在 Chrome 中完成验证');
    }
    if (!url.includes('/web/user/')) await page.goto(LOGIN_URL, { timeout: 30000 });
    await page.bringToFront();
    const after = await page.refreshUrl();
    if (after === 'about:blank') throw new Error('BOSS 登录页变成空白页，请检查 Chrome 中的页面状态');
  }

  /** 会话尚未证实时打开职位页复核，不会打开扫码页。 */
  public async verifyLogin(): Promise<LoginStatus> {
    const current = await this.checkLoginStatus();
    if (current.isLoggedIn) return current;
    if (current.reason?.includes('安全验证')) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const later = await this.checkLoginStatus();
      if (later.isLoggedIn || later.reason?.includes('安全验证')) return later;
    }
    await this.ensureChrome(false);
    if (!(await this.hasSessionCookie())) {
      return { isLoggedIn: false, isBrowserActive: !!this.port, reasonCode: 'login_required', reason: '尚未检测到登录会话，请先在 Chrome 中完成扫码' };
    }
    const worker = await this.getWorkerPage();
    await worker.goto(JOBS_URL, { timeout: 30000 });
    await this.waitForJobsOrLogin(worker);
    const url = await worker.refreshUrl();
    if (isSecurityUrl(url)) {
      await worker.bringToFront();
      return { isLoggedIn: false, isBrowserActive: true, reasonCode: 'verification_required', reason: 'BOSS 职位页要求人工完成安全验证' };
    }
    if (url === 'about:blank') return { isLoggedIn: false, isBrowserActive: true, reasonCode: 'unverified', reason: '职位页变成空白页，无法确认登录' };
    return this.checkLoginStatus();
  }

  public async checkCaptcha(): Promise<boolean> {
    const active = this.workerPage && !this.workerPage.isClosed() ? this.workerPage : this.loginPage;
    const pages = [active, this.verificationPage].filter((page): page is CdpPage => !!page && !page.isClosed());
    for (const page of pages) {
      if (isSecurityUrl(await page.refreshUrl())) return true;
      const visible = await page.locator('.geetest_radar_tip, .geetest_popup, [class*="security-check"]').first()
        .isVisible({ timeout: 500 }).catch(() => false);
      if (visible) return true;
      const securityText = await page.evaluate(() => /请完成安全验证|请进行安全验证/.test(document.body?.innerText || '')).catch(() => false);
      if (securityText) return true;
    }
    return false;
  }

  public async close(): Promise<void> {
    for (const page of this.pages.values()) page.closeConnection();
    this.pages.clear();
    this.loginPage = null;
    this.workerPage = null;
    this.verificationPage = null;
    this.port = null;
    this.chrome?.kill();
    this.chrome = null;
  }
}

export const browserService = new BrowserService();
