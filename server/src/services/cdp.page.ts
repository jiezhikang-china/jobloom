const WebSocket = require('ws') as any;
import { bossOperationPolicy } from './boss-operation-policy.js';
import { bossActionScheduler, type BossActionKind } from './boss-action-scheduler.js';
import { bossAutomationSafety, visibleBossRestriction, BossAutomationBlockedError, type BossAutomationSafety } from './boss-automation-safety.js';

type CommandResult = { result?: any; error?: { message: string } };
type LocatorStep = { selector: string; position?: 'first' | 'last' | number; hasSelector?: string; visible?: boolean };
type DocumentLifecycle = { frameId: string; loaderId: string; committedAt?: number; events: Set<string> };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CdpConnection {
  private socket: any;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(message: any) => void>();
  public closed = false;

  private constructor(socket: any) {
    this.socket = socket;
    socket.on('message', (raw: Buffer) => {
      let message: any;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result || {});
      } else {
        for (const listener of this.listeners) listener(message);
      }
    });
    socket.on('close', () => {
      this.closed = true;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Chrome 页面连接已关闭'));
      }
      this.pending.clear();
    });
    socket.on('error', () => {});
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new CdpConnection(socket);
  }

  onEvent(listener: (message: any) => void): void { this.listeners.add(listener); }

  async send(method: string, params: Record<string, unknown> = {}, timeout = 10000): Promise<any> {
    if (this.closed) throw new Error('Chrome 页面连接已关闭');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome 操作超时：${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error: Error | undefined) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close(): void {
    if (!this.closed) this.socket.close();
  }
}

// 在页面上下文中执行的选择器解析。只支持本项目实际使用的 CSS、:has-text 与相对 XPath。
function resolveElements(steps: LocatorStep[]): Element[] {
  let roots: (Document | Element)[] = [document];
  for (const step of steps) {
    let found: Element[] = [];
    for (const root of roots) {
      if (step.selector.startsWith('xpath=')) {
        const xpath = step.selector.slice(6);
        const result = document.evaluate(xpath, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
        for (let i = 0; i < result.snapshotLength; i++) {
          const item = result.snapshotItem(i);
          if (item instanceof Element) found.push(item);
        }
      } else {
        const parts = step.selector.split(/,(?![^()]*\))/);
        for (const part of parts) {
          const match = part.trim().match(/^(.*):has-text\(["'](.*)["']\)$/);
          const css = match ? match[1].trim() : part.trim();
          const text = match?.[2];
          try {
            found.push(...[...root.querySelectorAll(css)].filter((element) => !text || (element.textContent || '').includes(text)));
          } catch { /* 页面结构变化由上层处理 */ }
        }
      }
    }
    found = [...new Set(found)];
    if (step.hasSelector) found = found.filter((element) => !!element.querySelector(step.hasSelector!));
    if (step.visible !== undefined) found = found.filter((element) => Boolean((element as HTMLElement).getClientRects().length) === step.visible);
    if (step.position === 'first') found = found.slice(0, 1);
    if (step.position === 'last') found = found.slice(-1);
    if (typeof step.position === 'number') found = found.slice(step.position, step.position + 1);
    roots = found;
  }
  return roots as Element[];
}

export class CdpPage {
  private static activePages = new Set<CdpPage>();
  private currentUrl: string;
  private authResponses = new Map<string, boolean>();
  private mainFrameId = '';
  private mainLoaderId = '';
  private commitSequence = 0;
  private documents = new Map<string, DocumentLifecycle>();

  private documentFor(frameId: string, loaderId: string): DocumentLifecycle {
    const key = `${frameId}:${loaderId}`;
    let entry = this.documents.get(key);
    if (!entry) {
      entry = { frameId, loaderId, events: new Set() };
      this.documents.set(key, entry);
      if (this.documents.size > 64) this.documents.delete(this.documents.keys().next().value!);
    }
    return entry;
  }

  constructor(public readonly id: string, private readonly connection: CdpConnection, initialUrl: string, private readonly paceActions = true,
    private readonly safety: BossAutomationSafety = bossAutomationSafety) {
    this.currentUrl = initialUrl;
    CdpPage.activePages.add(this);
    connection.onEvent((message) => {
      if (message.method === 'Network.loadingFailed') this.authResponses.delete(message.params?.requestId);
      if (message.method === 'Network.loadingFinished' && this.paceActions) {
        const requestId = message.params?.requestId;
        const identityResponse = this.authResponses.get(requestId);
        this.authResponses.delete(requestId);
        if (identityResponse !== undefined && message.params?.encodedDataLength < 1024 * 1024) {
          void this.connection.send('Network.getResponseBody', { requestId }, 2000).then(result => {
            const body = JSON.parse(result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body);
            if (body?.code === undefined || body.code === 0) return;
            const text = [body.message, body.msg, body.zpData?.message].filter(v => typeof v === 'string').join(' ');
            if (identityResponse || /未登录|登录.{0,8}(?:失效|过期)|请重新登录|强制下线|账号.{0,16}(?:其他|异地|别处).{0,16}登录/.test(text)) {
              this.safety.halt('login_expired', 'BOSS 身份或岗位接口返回登录无效，自动操作已停止，请人工核对当前页面');
            }
          }).catch(() => { /* Unreadable bodies are not evidence of a forced logout. */ });
        }
      }
      if (message.method === 'Network.responseReceived' && this.paceActions) {
        const response = message.params?.response;
        if (response?.status === 200) {
          try {
            const url = new URL(response.url);
            if (url.hostname === 'www.zhipin.com' && (/^\/wapi\/zpgeek\//.test(url.pathname)
              || url.pathname === '/wapi/zpuser/wap/getUserInfo.json')) {
              this.authResponses.set(message.params.requestId, url.pathname === '/wapi/zpuser/wap/getUserInfo.json');
              if (this.authResponses.size > 100) this.authResponses.delete(this.authResponses.keys().next().value!);
            }
          } catch {}
        }
        try {
          if ([401, 403].includes(response?.status)) {
            const url = new URL(response.url);
            if (url.hostname === 'www.zhipin.com' && (/^\/wapi\/zpgeek\//.test(url.pathname)
              || url.pathname === '/wapi/zpuser/wap/getUserInfo.json')) {
              this.safety.halt(response.status === 401 ? 'login_expired' : 'account_restricted',
                response.status === 401 ? 'BOSS 岗位业务请求要求重新登录（HTTP 401），自动操作已停止，请人工处理'
                  : 'BOSS 拒绝岗位业务请求（HTTP 403），自动操作已停止，请人工核对账号');
            }
          }
          if (response?.status === 429 && new URL(response.url).hostname === 'www.zhipin.com') {
            const header = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
            const retry = typeof header === 'string' ? /^\d+$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now()) : 0;
            bossActionScheduler.limit(Number.isFinite(retry) ? retry : 0);
          }
        } catch {}
      }
      if (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) {
        const frame = message.params.frame;
        this.currentUrl = frame.url || this.currentUrl;
        this.mainFrameId = frame.id;
        this.mainLoaderId = frame.loaderId;
        this.documentFor(frame.id, frame.loaderId).committedAt = ++this.commitSequence;
      }
      if (message.method === 'Page.navigatedWithinDocument' && message.params?.frameId === this.mainFrameId) {
        this.currentUrl = message.params?.url || this.currentUrl;
      }
      if (message.method === 'Page.lifecycleEvent') {
        const { frameId, loaderId, name } = message.params;
        if (loaderId) this.documentFor(frameId, loaderId).events.add(name);
      }
    });
  }
  async initialize(): Promise<this> {
    await this.connection.send('Page.enable');
    await this.connection.send('Network.enable');
    // Connected/background Chrome tabs can otherwise update :hover while discarding clicks.
    await this.connection.send('Input.setIgnoreInputEvents', { ignore: false });
    await this.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.connection.send('Page.setLifecycleEventsEnabled', { enabled: true });
    const { frameTree } = await this.connection.send('Page.getFrameTree');
    this.mainFrameId = frameTree.frame.id;
    this.mainLoaderId = frameTree.frame.loaderId;
    this.currentUrl = frameTree.frame.url || this.currentUrl;
    return this;
  }
  url(): string { return this.currentUrl; }
  isClosed(): boolean { return this.connection.closed; }
  closeConnection(): void { CdpPage.activePages.delete(this); this.connection.close(); }
  static async assertPagesReady(safety = bossAutomationSafety): Promise<void> {
    safety.assertAllowed();
    for (const page of CdpPage.activePages) {
      if (page.isClosed()) { CdpPage.activePages.delete(page); continue; }
      if (!page.paceActions || page.safety !== safety || !page.url().startsWith('https://www.zhipin.com/')) continue;
      const restriction = await page.evaluate(visibleBossRestriction);
      if (restriction) {
        const hold = safety.halt(restriction.reason, restriction.message);
        if (restriction.reason === 'verification') throw new Error('CAPTCHA_REQUIRED: ' + restriction.message);
        throw new BossAutomationBlockedError(hold);
      }
    }
  }
  async refreshUrl(): Promise<string> {
    this.currentUrl = await this.evaluate(() => location.href).catch(() => this.currentUrl);
    return this.currentUrl;
  }
  async bringToFront(): Promise<void> { await this.connection.send('Page.bringToFront'); }
  async action<T>(kind: BossActionKind, work: () => Promise<T>, targetUrl = this.currentUrl): Promise<T> {
    let boss = false;
    try { boss = new URL(targetUrl).hostname === 'www.zhipin.com'; } catch {}
    if (!this.paceActions || !boss) return work();
    this.safety.assertAllowed();
    return bossActionScheduler.run(kind, async () => {
      await CdpPage.assertPagesReady(this.safety);
      return work();
    });
  }
  async fileInput(selector: string, files: string[]): Promise<void> {
    await this.action('submit', async () => {
      const { root } = await this.connection.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await this.connection.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error('没有找到附件文件选择控件');
      await this.connection.send('DOM.setFileInputFiles', { nodeId, files });
    });
  }
  async cookiesFor(url: string): Promise<Array<{ name: string; value: string }>> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'docdownload.zhipin.com') throw new Error('附件备份下载地址无效');
    const result = await this.connection.send('Network.getCookies', { urls: [url] });
    return result.cookies || [];
  }
  async title(): Promise<string> { return this.evaluate(() => document.title); }
  async waitForTimeout(ms: number): Promise<void> { await pause(ms); }
  locator(selector: string): CdpLocator { return new CdpLocator(this, [{ selector }]); }

  async evaluate<T, A = undefined>(fn: ((arg: A) => T) | (() => T), arg?: A): Promise<T> {
    // tsx/esbuild can retain local function names with __name inside serialized callbacks.
    const expression = `(() => { const __name = (fn, _name) => fn; return (${fn.toString()})(${JSON.stringify(arg ?? null)}); })()`;
    const response: CommandResult = await this.connection.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: false,
    });
    if ((response as any).exceptionDetails) {
      const detail = (response as any).exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || '页面脚本执行失败');
    }
    if (response.error) throw new Error(response.error.message);
    return response.result?.value as T;
  }

  async goto(url: string, options: { timeout?: number; waitUntil?: string } = {}): Promise<void> {
    return this.action('navigation', () => this.navigate(url, options), url);
  }
  private async navigate(url: string, options: { timeout?: number; waitUntil?: string } = {}): Promise<void> {
    const timeout = options.timeout ?? 30000;
    const waitUntil = options.waitUntil ?? 'domcontentloaded';
    if (waitUntil !== 'domcontentloaded' && waitUntil !== 'load') throw new Error(`不支持的页面等待状态：${waitUntil}`);
    const deadline = Date.now() + timeout;
    const result = await this.connection.send('Page.navigate', { url }, timeout);
    if (result.errorText) throw new Error(`页面导航失败：${result.errorText}`);
    if (result.isDownload) throw new Error('页面导航变成文件下载');
    const eventName = waitUntil === 'load' ? 'load' : 'DOMContentLoaded';
    while (Date.now() < deadline) {
      if (this.isClosed()) throw new Error('Chrome 页面连接已关闭');
      let documentReady = !result.loaderId;
      if (result.loaderId) {
        const requested = this.documents.get(`${result.frameId}:${result.loaderId}`);
        const current = this.documents.get(`${this.mainFrameId}:${this.mainLoaderId}`);
        // 新文档及其后续重定向必须真正提交并触发加载事件；旧文档的 readyState 不能放行。
        documentReady = this.mainFrameId === result.frameId
          && requested?.committedAt !== undefined && current?.committedAt !== undefined
          && current.committedAt >= requested.committedAt && current.events.has(eventName);
      }
      try {
        if (documentReady) {
          const checkedLoader = this.mainLoaderId;
          const state = await this.evaluate(() => ({ url: location.href, ready: document.readyState }));
          const ready = state.ready === 'complete' || (waitUntil === 'domcontentloaded' && state.ready === 'interactive');
          if (this.mainFrameId === result.frameId && this.mainLoaderId === checkedLoader) {
            this.currentUrl = state.url;
            if (ready && (result.loaderId || state.url === new URL(url).href)) return;
          }
        }
      } catch {}
      await pause(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`等待新网页载入超时（${url}）`);
  }

  async waitForFunction<A>(fn: (arg: A) => unknown, arg: A, options: { timeout?: number } = {}): Promise<void> {
    const deadline = Date.now() + (options.timeout || 30000);
    while (Date.now() < deadline) {
      if (await this.evaluate(fn, arg).catch(() => false)) return;
      await pause(150);
    }
    throw new Error('等待网页内容超时');
  }

  async getCookies(url: string): Promise<{ name: string; value: string; expires?: number }[]> {
    const result = await this.connection.send('Network.getCookies', { urls: [url] });
    return result.cookies || [];
  }

  async waitAfterPointerDown(): Promise<void> {
    if (this.paceActions && this.currentUrl.startsWith('https://www.zhipin.com/')) await this.waitForTimeout(bossOperationPolicy.pointerHoldMs);
  }
  async input(method: string, params: Record<string, unknown>): Promise<void> {
    await this.connection.send(method, params);
  }
  async elements<T, A>(steps: LocatorStep[], fn: (elements: any, arg: A) => T, arg?: A, single = false): Promise<T> {
    const expression = `(() => { const __name = (fn, _name) => fn; const resolveElements = ${resolveElements.toString()}; const elements = resolveElements(${JSON.stringify(steps)}); if (${single} && !elements[0]) throw new Error('页面元素不存在'); return (${fn.toString()})(${single ? 'elements[0]' : 'elements'}, ${JSON.stringify(arg ?? null)}); })()`;
    const response = await this.connection.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: false,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || '页面元素读取失败');
    return response.result?.value as T;
  }
}

export class CdpLocator {
  constructor(private readonly owner: CdpPage, private readonly steps: LocatorStep[]) {}
  page(): CdpPage { return this.owner; }
  locator(selector: string): CdpLocator { return new CdpLocator(this.owner, [...this.steps, { selector }]); }
  first(): CdpLocator { return new CdpLocator(this.owner, [...this.steps.slice(0, -1), { ...this.steps.at(-1)!, position: 'first' }]); }
  last(): CdpLocator { return new CdpLocator(this.owner, [...this.steps.slice(0, -1), { ...this.steps.at(-1)!, position: 'last' }]); }
  nth(index: number): CdpLocator {
    if (!Number.isInteger(index) || index < 0) throw new Error('页面元素序号无效');
    return new CdpLocator(this.owner, [...this.steps.slice(0, -1), { ...this.steps.at(-1)!, position: index }]);
  }
  filter(options: { has?: CdpLocator; visible?: boolean }): CdpLocator {
    const selector = options.has?.steps.at(-1)?.selector;
    return new CdpLocator(this.owner, [...this.steps.slice(0, -1), { ...this.steps.at(-1)!,
      ...(selector ? { hasSelector: selector } : {}), ...(options.visible !== undefined ? { visible: options.visible } : {}) }]);
  }
  async evaluate<T>(fn: (element: Element) => T): Promise<T> {
    return this.owner.elements(this.steps, fn, undefined, true);
  }
  async evaluateAll<T>(fn: (elements: Element[]) => T): Promise<T> {
    return this.owner.elements(this.steps, fn);
  }
  async isVisible(options: { timeout?: number } = {}): Promise<boolean> {
    const deadline = Date.now() + (options.timeout || 0);
    do {
      const visible = await this.owner.elements(this.steps, (elements) =>
        !!elements[0] && (elements[0] as HTMLElement).getClientRects().length > 0).catch(() => false);
      if (visible) return true;
      if (Date.now() >= deadline) return false;
      await pause(100);
    } while (true);
  }
  async waitFor(options: { state?: 'visible'; timeout?: number } = {}): Promise<void> {
    if (await this.isVisible({ timeout: options.timeout || 30000 })) return;
    throw new Error('等待页面元素显示超时');
  }
  async innerText(options: { timeout?: number } = {}): Promise<string> {
    await this.waitFor({ timeout: options.timeout || 30000 });
    return this.evaluate((element) => (element as HTMLElement).innerText);
  }
  async textContent(options: { timeout?: number } = {}): Promise<string | null> {
    await this.waitFor({ timeout: options.timeout || 30000 });
    return this.evaluate((element) => element.textContent);
  }
  async inputValue(): Promise<string> { return this.evaluate((element) => (element as HTMLInputElement).value); }
  async scrollIntoViewIfNeeded(): Promise<void> {
    await this.owner.action('control', () => this.evaluate((element) => { element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); return true; }));
  }
  private async point(): Promise<{ x: number; y: number }> {
    return this.evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) throw new Error('元素不可见');
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
  }
  async hover(): Promise<void> {
    await this.owner.action('control', async () => {
      const { x, y } = await this.point();
      await this.owner.input('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    });
  }
  async click(): Promise<void> {
    const kind = this.steps.some(step => /dialog_sure|dialog_cancel|继续沟通|dialog_close/.test(step.selector)) ? 'confirm' : 'control';
    await this.clickAs(kind);
  }
  async clickAs(kind: BossActionKind, before?: () => Promise<void>): Promise<void> {
    await this.owner.action(kind, async () => { await before?.(); await this.clickNow(); });
  }
  private async clickNow(): Promise<void> {
    const { x, y } = await this.point();
    await this.owner.input('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.owner.input('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    try { await this.owner.waitAfterPointerDown(); }
    finally {
      await this.owner.input('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    }
  }
  async fill(value: string): Promise<void> {
    await this.owner.action('input', async () => {
      await this.clickNow();
      await this.evaluate((element) => {
        if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) throw new Error('当前元素不是文本输入框');
        element.focus(); element.select(); return true;
      });
      await this.owner.input('Input.insertText', { text: value });
      if (await this.inputValue() !== value) throw new Error('页面输入未成功，已停止确认操作');
    });
  }
}
