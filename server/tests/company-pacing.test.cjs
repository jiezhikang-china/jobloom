const assert = require('node:assert/strict');
const { BrowserService } = require('../dist/services/browser.service.js');
const { BossActionScheduler, bossActionScheduler } = require('../dist/services/boss-action-scheduler.js');
const { bossOperationPolicy } = require('../dist/services/boss-operation-policy.js');
async function main() {
  const oldNow = Date.now, oldFetch = global.fetch, oldWait = bossActionScheduler.waitForElapsed;
  let clock = 100000;
  Date.now = () => clock;
  try {
    async function scenario(load, reading, options = {}) {
      const start = clock, controller = new AbortController();
      let restriction = options.initialRestriction || null, closed = 0, focused = 0, queued = 0, disconnected = 0;
      const scheduler = new BossActionScheduler(() => bossOperationPolicy, () => clock, async ms => {
        clock += ms;
        if (options.restrictDuringWait) restriction = { reason: 'verification', message: 'fixture' };
        if (options.stopDuringWait) controller.abort(new Error('用户停止'));
      });
      bossActionScheduler.waitForElapsed = scheduler.waitForElapsed.bind(scheduler);
      global.fetch = async () => { closed++; return { ok: !options.closeFailure }; };
      const page = {
        id: 'fixture', waitForFunction: async () => { clock += load; },
        refreshUrl: async () => 'https://www.zhipin.com/gongsi/fixture.html',
        evaluate: async () => restriction,
        bringToFront: async () => { focused++; },
        closeConnection: () => { disconnected++; },
        action: async (kind, work) => { assert.equal(kind, 'navigation'); queued++; return scheduler.run(kind, work); },
      };
      const browser = new BrowserService('unused-fixture');
      browser.createPage = async () => page;
      const call = () => scheduler.withScope({ signal: controller.signal }, () =>
        browser.withCompanyInspection('https://www.zhipin.com/gongsi/fixture.html', async () => {
          clock += reading;
          if (options.readFailure) throw new Error('fixture read failed');
          return '公司原文';
        }));
      if (options.stopDuringWait) await assert.rejects(call(), /用户停止/);
      else if (options.readFailure) await assert.rejects(call(), /read failed/);
      else if (options.closeFailure) await assert.rejects(call(), /关闭失败/);
      else assert.equal(await call(), '公司原文');
      return { elapsed: clock - start, closed, focused, queued, disconnected };
    }
    let result = await scenario(200, 100);
    assert.equal(result.elapsed, 3000); assert.equal(result.closed, 1); assert.equal(result.queued, 1);
    result = await scenario(2500, 1000);
    assert.equal(result.elapsed, 3500, '加载与分析已超过停留时间，不再重复等待');
    result = await scenario(100, 100, { restrictDuringWait: true });
    assert.equal(result.closed, 0); assert.equal(result.focused, 1, '等待期间出现验证保留窗口');
    result = await scenario(100, 100, { stopDuringWait: true });
    assert.equal(result.closed, 0); assert.equal(result.queued, 0, '停止能中断等待且不发出关闭动作');
    result = await scenario(100, 100, { readFailure: true });
    assert.equal(result.elapsed, 3000); assert.equal(result.closed, 1, '读取失败也不瞬间删除页面');
    result = await scenario(100, 100, { closeFailure: true });
    assert.equal(result.disconnected, 0, '关闭失败保留连接和页面引用');
    result = await scenario(100, 100, { initialRestriction: { reason: 'login_expired', message: 'fixture' } });
    assert.equal(result.elapsed, 200); assert.equal(result.closed, 0); assert.equal(result.focused, 1);
    console.log('PASS | 公司页停留、加载耗时抵扣、关闭排队、等待中验证保留、停止取消、读取与关闭失败');
  } finally { Date.now = oldNow; global.fetch = oldFetch; bossActionScheduler.waitForElapsed = oldWait; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
