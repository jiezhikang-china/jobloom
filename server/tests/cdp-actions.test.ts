import assert from 'node:assert/strict';
import { CdpPage, type CdpConnection } from '../src/services/cdp.page.js';
import { BossActionScheduler, bossActionScheduler, runBossAction } from '../src/services/boss-action-scheduler.js';
import { BossAutomationSafety } from '../src/services/boss-automation-safety.js';

class Connection {
  closed = false; inputValue = ''; blocked = false;
  listener?: (event: any) => void; inputs: any[] = [];
  onEvent(listener: (event: any) => void) { this.listener = listener; }
  close() { this.closed = true; }
  async send(method: string, params: any = {}) {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: 'https://www.zhipin.com/web/geek/jobs' } } };
    if (method === 'Runtime.evaluate') {
      const expression = params.expression;
      const value = expression.includes('getBoundingClientRect()') ? { x: 20, y: 30 }
        : expression.includes('getClientRects') && expression.includes('security-check') ? this.blocked ? { reason: 'verification', message: 'fixture safety verification' } : null
        : expression.includes('element.value') ? this.inputValue : true;
      return { result: { value } };
    }
    if (method === 'Input.insertText') this.inputValue = params.text;
    if (method.startsWith('Input.') || method === 'DOM.setFileInputFiles') this.inputs.push({ method, ...params });
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 2 };
    return {};
  }
}
async function main() {
  let clock = 100000, writes = 0;
  const scheduler = new BossActionScheduler(() => ({ intervalMs: 2000, burst: 20, restMs: 20000, feedbackMs: 15000 }),
    () => clock, async ms => { clock += ms; });
  const originalRun = bossActionScheduler.run, originalLimit = bossActionScheduler.limit;
  bossActionScheduler.run = (kind, task) => scheduler.run(kind, task);
  bossActionScheduler.limit = () => { writes++; };
  const firstConnection = new Connection(), secondConnection = new Connection();
  const safety = new BossAutomationSafety(null);
  const first = await new CdpPage('first', firstConnection as unknown as CdpConnection, '', true, safety).initialize();
  const second = await new CdpPage('second', secondConnection as unknown as CdpConnection, '', true, safety).initialize();
  try {
    await first.locator('button').click();
    assert.deepEqual(firstConnection.inputs.filter(item => item.method === 'Input.dispatchMouseEvent').map(item => item.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
    assert.equal(clock, 100000, '鼠标按下和释放是一个完整动作');
    await second.locator('input').fill('中文内容');
    assert.equal(clock, 102000, '填入文字只排队一次，不与内部点击形成死锁');
    await first.fileInput('input[type=file]', ['C:/fixture.pdf']);
    assert.equal(firstConnection.inputs.at(-1).method, 'DOM.setFileInputFiles');
    await runBossAction(first, 'route', async () => { firstConnection.inputs.push({ method: 'native-route' }); });
    const before = secondConnection.inputs.length;
    firstConnection.blocked = true;
    await assert.rejects(second.locator('button').click(), /CAPTCHA_REQUIRED/);
    assert.equal(secondConnection.inputs.length, before, '其他页面遇到验证时，这一页也停止点击');
    firstConnection.blocked = false;
    await assert.rejects(second.locator('button').click(), /fixture safety verification/, '验证提示消失后仍不自动恢复');
    safety.confirmRecovery(safety.status().hold!.id);
    firstConnection.listener?.({ method: 'Network.responseReceived', params: { response: { status: 429, url: 'https://unrelated.example/', headers: {} } } });
    assert.equal(writes, 0);
    firstConnection.listener?.({ method: 'Network.responseReceived', params: { response: { status: 429, url: 'https://www.zhipin.com/wapi/fixture', headers: { 'Retry-After': '60' } } } });
    assert.equal(writes, 1);
    let checkedAt = 0;
    await second.locator('button').clickAs('feedback', async () => { checkedAt = clock; });
    assert.equal(checkedAt, clock, '等候结束后再核对提交目标');
    console.log('PASS | 原生鼠标事件原子性、输入无嵌套死锁、文件选择节流、路线回调、跨页验证、429 来源、提交前再次核对');
  } finally {
    first.closeConnection(); second.closeConnection(); bossActionScheduler.run = originalRun; bossActionScheduler.limit = originalLimit;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
