import assert from 'node:assert/strict';
import { CdpPage, type CdpConnection } from '../src/services/cdp.page.js';
import { BossAutomationSafety, visibleBossRestriction } from '../src/services/boss-automation-safety.js';

class Connection {
  closed = false; listener?: (event: any) => void; bodies = new Map<string, string>();
  onEvent(listener: any) { this.listener = listener; }
  async send(method: string, params: any) { return method === 'Network.getResponseBody' ? { body: this.bodies.get(params.requestId) } : {}; }
  close() { this.closed = true; }
}
async function scenario(url: string, status: number, body: any, expected?: string) {
  const connection = new Connection(), safety = new BossAutomationSafety(null);
  const page = new CdpPage('offline-login', connection as unknown as CdpConnection,
    'https://www.zhipin.com/web/geek/jobs', true, safety);
  try {
    connection.bodies.set('one', JSON.stringify(body));
    connection.listener!({ method: 'Network.responseReceived', params: { requestId: 'one', response: { status, url } } });
    connection.listener!({ method: 'Network.loadingFinished', params: { requestId: 'one', encodedDataLength: 200 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(safety.status().hold?.reason, expected);
    if (expected) {
      let sent = false;
      await assert.rejects(page.action('submit', async () => { sent = true; }));
      assert.equal(sent, false, '登录异常后禁止后续提交');
    }
  } finally { page.closeConnection(); }
}
async function main() {
  await scenario('https://www.zhipin.com/wapi/zpuser/wap/getUserInfo.json', 200, { code: 37, message: '无效登录' }, 'login_expired');
  await scenario('https://www.zhipin.com/wapi/zpuser/wap/getUserInfo.json', 200, { code: 0 });
  await scenario('https://www.zhipin.com/wapi/zpgeek/fixture.json', 200, { code: 37, message: '请重新登录' }, 'login_expired');
  await scenario('https://www.zhipin.com/wapi/zpgeek/fixture.json', 200, { code: 37, message: '岗位已失效' });
  await scenario('https://www.zhipin.com/wapi/zpgeek/fixture.json', 200, { code: 0, zpData: { jobDescription: '协助用户重新登录' } });
  await scenario('https://www.zhipin.com/wapi/zpgeek/fixture.json', 401, {}, 'login_expired');
  await scenario('https://www.zhipin.com/wapi/zpgeek/fixture.json', 403, {}, 'account_restricted');
  await scenario('https://www.zhipin.com/wapi/zpuser/wap/getUserInfo.json', 401, {}, 'login_expired');
  await scenario('https://www.zhipin.com/wapi/zpuser/wap/getUserInfo.json', 403, {}, 'account_restricted');
  await scenario('https://www.zhipin.com/assets/fixture.png', 403, {});
  await scenario('https://other.invalid/wapi/zpgeek/fixture.json', 401, {});
  const oldDocument = globalThis.document, oldLocation = globalThis.location;
  try {
    (globalThis as any).location = { pathname: '/web/geek/jobs' };
    (globalThis as any).document = { body: { innerText: '岗位职责：处理用户强制下线投诉' }, querySelectorAll: () => [] };
    assert.equal(visibleBossRestriction(), null, '岗位内容不作为账号异常通知');
    (globalThis as any).document.querySelectorAll = (selector: string) => selector.includes('common-dialog')
      ? [{ innerText: '您的账号在其他设备登录，已被强制下线，请重新登录', getClientRects: () => [1] }] : [];
    assert.equal(visibleBossRestriction()?.reason, 'login_expired');
    (globalThis as any).document.querySelectorAll = () => [{ innerText: '请重新登录', getClientRects: () => [] }];
    assert.equal(visibleBossRestriction(), null);
  } finally { (globalThis as any).document = oldDocument; (globalThis as any).location = oldLocation; }
  console.log('PASS | HTTP200身份失效、业务明确登录失效、未知码不乱判、401/403、资产错误隔离、可见强制下线通知和提交门控');
}
main().catch(error => { console.error(error); process.exitCode = 1; });