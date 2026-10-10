const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { BossAutomationSafety, bossAutomationSafety, visibleBossRestriction } = require('../dist/services/boss-automation-safety.js');
const { BossActionScheduler } = require('../dist/services/boss-action-scheduler.js');
const { BrowserService, browserService } = require('../dist/services/browser.service.js');
const { DeliveryService, deliveryService } = require('../dist/services/delivery.service.js');
const { apiRouter } = require('../dist/routes/api.router.js');
const { CdpPage } = require('../dist/services/cdp.page.js');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = path.resolve(__dirname, '../..');
  const dir = fs.mkdtempSync(path.join(root, 'data/boss-safety-test-'));
  const restorers = [];
  const stub = (object, name, fn) => { const original = object[name]; object[name] = fn; restorers.push(() => { object[name] = original; }); };
  let local = new BossAutomationSafety(path.join(dir, 'hold.json'));
  let server;
  try {
    for (const name of ['status', 'assertAllowed', 'halt', 'confirmRecovery']) stub(bossAutomationSafety, name, (...args) => local[name](...args));
    local.halt('user_reported_ban', 'fixture account restricted');
    let restored = new BossAutomationSafety(path.join(dir, 'hold.json'));
    assert.throws(() => restored.assertAllowed(), /fixture account restricted/, '重启不能清除封禁停止状态');
    const originalId = local.status().hold.id;
    local.halt('verification', 'captcha'); assert.equal(local.status().hold.id, originalId, '验证提示不能降级封禁停止状态');
    assert.equal(local.status().hold.requiresPageVerification, true, '人工报告不能掩盖已有平台验证证据');
    assert.throws(() => local.confirmRecovery('stale-id'), /已变化/);
    const protectedBrowser = new BrowserService(path.join(dir, 'unused-profile'));
    let launches = 0; stub(protectedBrowser, 'tryReconnectChrome', async () => { launches++; return false; });
    await assert.rejects(protectedBrowser.getWorkerPage(), /fixture account restricted/);
    assert.equal(launches, 0, '停止状态下不能连接或启动业务浏览器');

    let focused = 0, created = 0, selected;
    const manualPage = { bringToFront: async () => { focused++; }, goto: async () => { throw new Error('must not navigate existing page'); } };
    stub(protectedBrowser, 'tryReconnectChrome', async () => { launches++; return true; });
    stub(protectedBrowser, 'listTabs', async () => [
      { id: 'job', url: 'https://www.zhipin.com/web/geek/jobs' },
      { id: 'verify', url: 'https://www.zhipin.com/web/passport/zp/security.html' }
    ]);
    stub(protectedBrowser, 'pageFor', async tab => { selected = tab.id; return manualPage; });
    stub(protectedBrowser, 'createPageNow', async url => { assert.ok(url.startsWith('https://www.zhipin.com/web/user/')); created++; return manualPage; });
    await protectedBrowser.openManualRecovery();
    assert.equal(selected, 'verify'); assert.equal(focused, 1); assert.equal(created, 0);
    assert.equal(local.status().blocked, true, '人工打开页面不能解除停止状态');
    assert.equal(local.status().hold.id, originalId, '人工处理保留原限制记录');
    stub(protectedBrowser, 'listTabs', async () => []);
    await protectedBrowser.openManualRecovery();
    assert.equal(created, 1); assert.equal(focused, 2, '没有现有BOSS页面时打开登录页并置前');

    local = new BossAutomationSafety(null);
    const passive = new BrowserService(path.join(dir, 'passive-profile'));
    let activeChecks = 0, reconnects = 0;
    stub(passive, 'ensureChrome', async () => { activeChecks++; throw new Error('must not launch'); });
    stub(passive, 'tryReconnectChrome', async () => { reconnects++; return false; });
    assert.equal((await passive.checkLoginStatus({ restore: false })).isLoggedIn, false);
    assert.equal(activeChecks, 0); assert.equal(reconnects, 1, '状态观察只检查本地已有窗口，不启动 Chrome');

    const resumedBrowser = new BrowserService(path.join(dir, 'mock-rest-profile'));
    let restFocused = 0;
    stub(resumedBrowser, 'getWorkerPage', async () => ({ bringToFront: async () => { restFocused++; } }));
    stub(resumedBrowser, 'waitForJobsOrLogin', async () => {});
    stub(resumedBrowser, 'checkLoginStatus', async () => ({ isLoggedIn: false, isBrowserActive: true, reasonCode: 'login_required' }));
    const originalReady = CdpPage.assertPagesReady;
    try {
      CdpPage.assertPagesReady = async () => {};
      await assert.rejects(resumedBrowser.resumeAfterRest(), /无法确认/);
      assert.equal(restFocused, 1, '休息后登录失效必须把人工处理页面置前');
      assert.equal(local.status().hold.reason, 'login_expired');
      local = new BossAutomationSafety(null);
      CdpPage.assertPagesReady = async () => { throw new Error('fixture pending verification'); };
      await assert.rejects(resumedBrowser.resumeAfterRest(), /pending verification/);
      assert.equal(restFocused, 2, '休息后出现验证也必须把页面置前');
    } finally { CdpPage.assertPagesReady = originalReady; }
    local = new BossAutomationSafety(null);

    let clock = 100000, persisted;
    const settings = { intervalMs: 0, burst: 100, restMs: 0, feedbackMs: 0, maxPerMinute: 2, maxPerHour: 3 };
    const scheduler = new BossActionScheduler(() => settings, () => clock, async ms => { clock += ms; }, state => { persisted = structuredClone(state); });
    const starts = [];
    for (let i = 0; i < 4; i++) await scheduler.run('control', async () => { starts.push(clock); });
    assert.equal(starts[2] - starts[0], 60000, '滚动分钟额度限制短时间操作总量');
    assert.equal(starts[3] - starts[0], 3600000, '滚动小时额度限制整个会话');
    const recoveredBudget = new BossActionScheduler(() => ({ ...settings, maxPerHour: 1 }), () => clock, async ms => { clock += ms; });
    recoveredBudget.restore(persisted); const beforeRestart = clock;
    await recoveredBudget.run('control', async () => {});
    assert.equal(clock - beforeRestart, 3600000, '重启不能刷新操作额度');
    assert.equal(persisted.recentActions.length, 4); assert.deepEqual(Object.keys(persisted.recentActions[0]).sort(), ['kind', 'result', 'startedAt', 'time']);

    const writes = new BossActionScheduler(() => ({ intervalMs: 2000, burst: 1, restMs: 20000, feedbackMs: 15000, writesPerHour: 1 }), () => clock, async ms => { clock += ms; });
    await writes.run('submit', async () => {}); const firstWrite = clock;
    await writes.run('confirm', async () => {}); assert.equal(clock - firstWrite, 600, '已发送的继续沟通仍及时确认');
    await writes.run('feedback', async () => {}); assert.equal(clock - firstWrite, 3600000, '沟通与反馈共用小时写入额度');

    local = new BossAutomationSafety(null);
    const task = new DeliveryService({ runIfDue: async () => false }); task.isTaskActive = true;
    let sitePolls = 0; stub(browserService, 'checkCaptcha', async () => { sitePolls++; return false; });
    const captchaWait = task.handleCaptcha(); await pause(300);
    assert.equal(task.getStats().status, 'paused'); assert.equal(sitePolls, 0, '验证等待不能轮询网站或自动恢复');
    assert.throws(() => task.resume(), /人工安全验证/);
    local.confirmRecovery(local.status().hold.id); task.resume(); await captchaWait;
    assert.equal(task.getStats().status, 'running'); task.stop();

    const connection = { closed: false, onEvent() {}, async send() { return {}; }, close() { this.closed = true; } };
    local.halt('user_reported_ban', 'fixture account restricted');
    const page = new CdpPage('blocked-fixture', connection, 'https://www.zhipin.com/web/geek/jobs', true, local);
    let actions = 0;
    await assert.rejects(page.action('submit', async () => { actions++; }), /fixture account restricted/); assert.equal(actions, 0); page.closeConnection();

    const oldDocument = global.document, oldLocation = global.location;
    try {
      global.location = { pathname: '/web/geek/jobs' };
      global.document = { body: { innerText: '岗位职责：处理账号封禁工单' }, querySelectorAll: () => [] };
      assert.equal(visibleBossRestriction(), null, '岗位描述中的封禁文字不能当成平台通知');
      global.document.querySelectorAll = selector => selector.includes('common-dialog') ? [{ innerText: '您的账号已被封禁', getClientRects: () => [1] }] : [];
      assert.equal(visibleBossRestriction().reason, 'account_restricted');
      global.document.querySelectorAll = () => [{ innerText: '您的账号已被封禁', getClientRects: () => [] }];
      assert.equal(visibleBossRestriction(), null, '隐藏旧通知不能触发停止');
    } finally { global.document = oldDocument; global.location = oldLocation; }

    stub(browserService, 'verifyManualSession', () => browserService.checkLoginStatus({ restore: false, observeBlocked: true }));
    let bossCalls = 0, automaticResumes = 0;
    let manualOpens = 0;
    stub(browserService, 'openManualRecovery', async () => { manualOpens++; });
    stub(deliveryService, 'stop', () => {});
    stub(browserService, 'promptLogin', async () => { bossCalls++; }); stub(browserService, 'verifyLogin', async () => { bossCalls++; });
    stub(deliveryService, 'resume', () => { automaticResumes++; });
    stub(browserService, 'checkLoginStatus', async options => { assert.equal(options.restore, false); return { isLoggedIn: true, isBrowserActive: true }; });
    stub(browserService, 'checkVisibleRestriction', async () => false);
    const app = express(); app.use(express.json()); app.use('/api', apiRouter);
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/api';
    stub(browserService, 'checkLoginStatus', async () => ({ isLoggedIn: false, isBrowserActive: false }));
    for (const [route, method] of [['/delivery/start','POST'], ['/delivery/resume','POST'],
      ['/resume/boss/upload','POST'], ['/resume/boss/attachments','GET'], ['/delivery/work-condition-reviews/apply','POST']]) {
      const response = await fetch(base + route, { method }); assert.equal(response.status, 423, route + ' 必须在业务操作前拦截');
    }
    assert.equal(bossCalls, 0);
    stub(browserService, 'checkLoginStatus', async options => { assert.equal(options.restore, false); return { isLoggedIn: true, isBrowserActive: true }; });
    assert.equal((await fetch(base + '/browser/status')).status, 200);
    const beforeManual = local.status().hold.id;
    const manualResponse = await fetch(base + '/boss/automation-safety/open-browser', { method: 'POST' });
    assert.equal(manualResponse.status, 200, '停止期间必须保留人工打开浏览器入口');
    assert.equal(manualOpens, 1); assert.equal(automaticResumes, 0);
    assert.equal(local.status().hold.id, beforeManual); assert.equal(local.status().blocked, true);

    let response = await fetch(base + '/boss/automation-safety/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holdId: local.status().hold.id }) });
    assert.equal(response.status, 400, '必须明确人工确认恢复');
    response = await fetch(base + '/boss/automation-safety/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holdId: local.status().hold.id, platformAccessRestored: true }) });
    assert.equal(response.status, 200); assert.equal(automaticResumes, 0, '确认恢复不能自动启动或恢复投递');
    local.halt('user_reported_ban', 'fixture closed-browser ban');
    stub(browserService, 'checkLoginStatus', async options => { assert.equal(options.restore, false); return { isLoggedIn: false, isBrowserActive: false, reasonCode: 'login_required' }; });
    response = await fetch(base + '/boss/automation-safety/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holdId: local.status().hold.id, platformAccessRestored: true }) });
    assert.equal(response.status, 200); assert.equal(local.status().blocked, false, '人工报告的封禁解除不能因浏览器关闭而死锁');
    assert.equal(bossCalls, 0); assert.equal(automaticResumes, 0, '解除记录不打开浏览器或恢复投递');
    local.halt('verification', 'fixture verification still pending');
    response = await fetch(base + '/boss/automation-safety/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holdId: local.status().hold.id, platformAccessRestored: true }) });
    assert.equal(response.status, 409); assert.equal(local.status().blocked, true, '系统检测的安全验证仍需核对已登录页面');
    local = new BossAutomationSafety(null); local.halt('user_reported_ban', 'fixture visible ban');
    stub(browserService, 'checkLoginStatus', async () => ({ isLoggedIn: false, isBrowserActive: true }));
    stub(browserService, 'checkVisibleRestriction', async () => true);
    response = await fetch(base + '/boss/automation-safety/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holdId: local.status().hold.id, platformAccessRestored: true }) });
    assert.equal(response.status, 409); assert.equal(local.status().blocked, true, '可见限制不能由人工报告恢复覆盖');
    assert.equal(local.status().hold.requiresPageVerification, true);
    stub(browserService, 'checkLoginStatus', async () => ({ isLoggedIn: false, isBrowserActive: false }));
    response = await fetch(base + '/boss/automation-safety/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holdId: local.status().hold.id, platformAccessRestored: true }) });
    assert.equal(response.status, 409, '关掉仍有限制的页面不能变为纯人工恢复');
    local = new BossAutomationSafety(null);
    local.halt('verification', 'fixture previous verification');
    const normalLogin = await fetch(base + '/browser/login', { method: 'POST' });
    assert.equal(normalLogin.status, 200, '普通登录按钮可打开人工处理页面');
    assert.equal(local.status().blocked, true, '打开页面不会自动清除限制');
    const notReady = await fetch(base + '/browser/verify', { method: 'POST' });
    assert.equal((await notReady.json()).success, false);
    stub(browserService, 'checkLoginStatus', async options => { assert.equal(options.restore, false); return { isLoggedIn: true, isBrowserActive: true }; });
    stub(browserService, 'checkVisibleRestriction', async () => false);
    const normalVerify = await fetch(base + '/browser/verify', { method: 'POST' });
    assert.equal((await normalVerify.json()).success, true);
    assert.equal(local.status().blocked, false, '普通验证登录直接解除过期记录');
    assert.equal(automaticResumes, 0, '验证登录不自动投递');
    local.halt('verification', 'fixture earlier verification');
    await fetch(base + '/browser/status');
    assert.equal(local.status().blocked, true, '状态轮询不自动恢复任务');
    stub(deliveryService, 'getStats', () => ({ status: 'paused', needsCaptchaVerification: false }));
    const explicitResume = await fetch(base + '/delivery/resume', { method: 'POST' });
    assert.equal(explicitResume.status, 200);
    assert.equal(local.status().blocked, false);
    assert.equal(automaticResumes, 1, '主动恢复在页面正常后可以直接执行');
    const cooldownFile = path.join(dir, 'cooldown.json'); let time = Date.now();
    const cooling = new BossAutomationSafety(cooldownFile, () => time);
    cooling.halt('rate_limit', 'rate limited', time + 60000); const coolingId = cooling.status().hold.id;
    cooling.halt('rate_limit', 'rate limited again', time + 120000);
    const reportedOverLimit = new BossAutomationSafety(null, () => time);
    reportedOverLimit.halt('rate_limit', 'rate limit', time + 120000); reportedOverLimit.halt('user_reported_ban', 'user report');
    assert.equal(reportedOverLimit.status().hold.retryAfter, new Date(time + 120000).toISOString());
    assert.equal(reportedOverLimit.status().hold.requiresPageVerification, true);
    time += 61000; assert.throws(() => cooling.confirmRecovery(coolingId), /等待时间/);
    time += 61000; assert.equal(new BossAutomationSafety(cooldownFile, () => time).status().blocked, true, '冷却到期不能自动解除停止状态');
    console.log('PASS | 封禁持久停止、无浏览器自启、跨重启分钟/小时额度、及时继续沟通、验证不轮询不自动恢复、可见通知、全入口拦截、人工确认不启动任务');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const restore of restorers.reverse()) restore();
    if (path.dirname(path.resolve(dir)) !== path.join(root, 'data') || !path.basename(dir).startsWith('boss-safety-test-')) throw new Error('unexpected fixture folder');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
