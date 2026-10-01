import assert from 'node:assert/strict';
import { CdpConnection, CdpPage } from '../src/services/cdp.page.js';

const previousUrl = 'https://www.zhipin.com/web/geek/jobs?query=previous';
const nextUrl = 'https://www.zhipin.com/web/geek/jobs?query=next';
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class FakeConnection {
  closed = false;
  listeners: ((message: any) => void)[] = [];
  frame = { id: 'main', loaderId: 'old', url: previousUrl };
  state = { url: previousUrl, ready: 'complete' };
  evaluations = 0;
  enabled = false;
  navigate: (url: string) => Promise<any> = async () => ({ frameId: 'main', loaderId: 'new' });
  onEvent(listener: (message: any) => void): void { this.listeners.push(listener); }
  close(): void { this.closed = true; }
  emit(method: string, params: any): void { this.listeners.forEach((listener) => listener({ method, params })); }
  commit(loaderId: string, url = nextUrl): void {
    this.frame = { id: 'main', loaderId, url };
    this.emit('Page.frameNavigated', { frame: this.frame });
  }
  lifecycle(loaderId: string, name = 'DOMContentLoaded', frameId = 'main'): void {
    this.emit('Page.lifecycleEvent', { frameId, loaderId, name });
  }
  async send(method: string, params: any = {}): Promise<any> {
    if (method === 'Page.setLifecycleEventsEnabled') this.enabled = params.enabled;
    if (method === 'Page.getFrameTree') return { frameTree: { frame: this.frame } };
    if (method === 'Page.navigate') return this.navigate(params.url);
    if (method === 'Runtime.evaluate') {
      this.evaluations++;
      return { result: { value: this.state } };
    }
    return {};
  }
}

async function setup(): Promise<{ connection: FakeConnection; page: CdpPage }> {
  const connection = new FakeConnection();
  const page = await new CdpPage('test', connection as unknown as CdpConnection, previousUrl).initialize();
  assert.equal(connection.enabled, true);
  return { connection, page };
}

async function main(): Promise<void> {
  {
    const { connection, page } = await setup();
    // 即使 URL 和 readyState 看似就绪，也不能借用旧文档或子框架的加载事件。
    connection.state = { url: nextUrl, ready: 'complete' };
    let finished = false;
    const navigation = page.goto(nextUrl, { timeout: 2500 }).then(() => { finished = true; });
    connection.lifecycle('old');
    connection.lifecycle('new', 'DOMContentLoaded', 'child');
    await pause(600);
    assert.equal(finished, false, '旧实现会在 500ms 后提前返回');
    assert.equal(connection.evaluations, 0, '未收到新主文档加载事件前不能采信 readyState');
    connection.commit('new');
    connection.lifecycle('old');
    await pause(120);
    assert.equal(finished, false);
    connection.lifecycle('new');
    await navigation;
    assert.equal(finished, true);
  }
  {
    const { connection, page } = await setup();
    connection.navigate = async () => {
      connection.commit('new');
      connection.state = { url: nextUrl, ready: 'interactive' };
      // 快速页面的事件可能早于 Page.navigate 的响应。
      connection.lifecycle('new');
      return { frameId: 'main', loaderId: 'new' };
    };
    await page.goto(nextUrl, { timeout: 500 });
    assert.equal(page.url(), nextUrl);
  }
  {
    const { connection, page } = await setup();
    connection.navigate = async () => {
      connection.commit('new');
      connection.lifecycle('new');
      connection.commit('redirect', nextUrl + '&redirect=1');
      connection.state = { url: nextUrl + '&redirect=1', ready: 'complete' };
      connection.lifecycle('redirect');
      return { frameId: 'main', loaderId: 'new' };
    };
    await page.goto(nextUrl, { timeout: 500 });
    assert.match(page.url(), /redirect=1/);
  }
  {
    const { connection, page } = await setup();
    connection.navigate = async () => {
      connection.commit('new');
      connection.lifecycle('new');
      connection.state = { url: nextUrl, ready: 'complete' };
      return { frameId: 'main', loaderId: 'new' };
    };
    let finished = false;
    const navigation = page.goto(nextUrl, { timeout: 1000, waitUntil: 'load' }).then(() => { finished = true; });
    await pause(120);
    assert.equal(finished, false, 'load 必须等对应文档的 load 事件');
    connection.lifecycle('new', 'load');
    await navigation;
  }
  {
    const { connection, page } = await setup();
    const target = previousUrl + '#details';
    connection.navigate = async () => {
      connection.state = { url: target, ready: 'complete' };
      connection.emit('Page.navigatedWithinDocument', { frameId: 'main', url: target });
      return { frameId: 'main' };
    };
    await page.goto(target, { timeout: 500 });
    connection.emit('Page.navigatedWithinDocument', { frameId: 'child', url: 'https://unrelated.invalid/' });
    assert.equal(page.url(), target, '子框架不能覆盖主页面地址');
  }
  {
    const { connection, page } = await setup();
    await assert.rejects(page.goto(nextUrl, { timeout: 150 }), /等待新网页载入超时/);
    connection.navigate = async () => ({ frameId: 'main', errorText: 'net::ERR_CONNECTION_RESET' });
    await assert.rejects(page.goto(nextUrl), /页面导航失败.*ERR_CONNECTION_RESET/);
    connection.closed = true;
    connection.navigate = async () => ({ frameId: 'main', loaderId: 'new' });
    await assert.rejects(page.goto(nextUrl), /连接已关闭/);
  }
  process.stdout.write('PASS | CDP 导航：新文档、旧页面竞态、子框架、提前事件、重定向、load、同文档、超时与断开\n');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
