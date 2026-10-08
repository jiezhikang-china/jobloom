'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('../../node_modules/playwright-core');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => {
    const p = s.address().port; s.close(() => resolve(p));
  }); });
}
async function until(check, label) {
  for (let i = 0; i < 80; i++) { const result = await check(); if (result) return result; await delay(100); }
  throw new Error('等待失败：' + label);
}
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-dom-monitor-test-'));
  const data = path.join(temp, 'data'), profile = path.join(temp, 'profile');
  fs.mkdirSync(data); const port = await freePort();
  let context, child, childOutput = '', intercepted = 0;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.BOSS_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: true, args: ['--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1', '--proxy-server=http://127.0.0.1:9'],
    });
    await context.route('**/*', async route => {
      intercepted++; await delay(350);
      const url = route.request().url();
      let body;
      if (url.includes('/gongsi/')) body = '<body><button class="company-control">私有公司介绍，不应保存</button></body>';
      else if (url.includes('/chat')) body = '<body><input class="chat-input"><button class="chat-control">私有聊天正文，不应保存</button></body>';
      else if (url.includes('/web/user/')) body = '<body><input type="password"></body>';
      else body = '<body style="height:3000px"><button class="other-control">私有按钮正文</button><input class="query">'
        + '<div class="job-card-box"><a class="job-name">离线岗位</a></div>'
        + '<div class="job-detail-box"><div class="job-detail-body"><p class="desc"></p></div>'
        + '<button class="op-btn-chat">立即沟通</button><button class="continue-chat">继续沟通</button>'
        + '<a class="company-link" target="_blank" href="https://www.zhipin.com/gongsi/fixture.html">公司</a></div>'
        + '<button class="spa-control" onclick="history.pushState({},\'\',\'/web/geek/jobs?test=private-query\')">切换</button>'
        + '<script>document.querySelector(".job-card-box").onclick=()=>document.querySelector(".desc").textContent="负责资料整理与客服咨询，核对售后订单，按安排完成内容记录。"</script></body>';
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
    const page = context.pages()[0];
    await page.goto('https://www.zhipin.com/web/geek/jobs');
    const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
    fs.writeFileSync(path.join(profile, 'boss-browser-runtime.json'), JSON.stringify({
      port, browserIdentity: new URL(version.webSocketDebuggerUrl).pathname,
    }));
    child = spawn(process.execPath, [path.join(__dirname, 'recorder.cjs')], {
      env: { ...process.env, BOSS_MANUAL_PACE_DATA_DIR: data, BOSS_PACE_PROFILE_DIR: profile }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { childOutput += chunk; });
    child.stderr.on('data', chunk => { childOutput += chunk; });
    const runtime = await until(() => {
      try { return JSON.parse(fs.readFileSync(path.join(data, 'runtime.json'), 'utf8')); } catch { return false; }
    }, '服务启动');
    const state = async () => (await fetch(runtime.url + 'api/state')).json();
    const post = async action => {
      const response = await fetch(runtime.url + 'api/' + action, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      return { status: response.status, value: await response.json() };
    };
    let result = await post('start');
    assert.equal(result.status, 200, JSON.stringify(result.value));
    assert.equal(result.value.status, 'recording'); assert.equal(result.value.observingPages, 1);
    assert.ok(!result.value.events.some(e => e.kind === 'select' || e.kind === 'observer_ready'), '就绪握手不能编造选岗');

    assert.equal((await post('start')).status, 400, '不能覆盖正在记录的样本');
    assert.equal((await post('manual-start')).status, 400, '已移除手动打点入口');
    await page.locator('.job-card-box').click();
    await until(async () => (await state()).events.some(e => e.kind === 'detail_ready'), '选择与详情就绪');
    await page.locator('.other-control').click();
    await page.locator('.query').fill('输入私有文字不能保存');
    await page.mouse.wheel(0, 250); await delay(300);
    await page.locator('.op-btn-chat').click(); await page.locator('.continue-chat').click();
    const popupPromise = page.waitForEvent('popup'); await page.locator('.company-link').click();
    const popup = await popupPromise;
    await until(async () => (await state()).observingPages === 2, '公司新标签自动安装');
    await popup.locator('.company-control').click();
    await until(async () => (await state()).events.some(e => e.kind === 'click' && e.page === 'company'), '公司 DOM 点击');
    await popup.close();
    await page.locator('.spa-control').click();
    await until(async () => (await state()).events.some(e => e.kind === 'navigate'), '站内路由变化');
    await page.reload();
    await until(async () => (await state()).observingPages === 1, '刷新后的监听器');
    await page.locator('.job-card-box').click();
    await until(async () => (await state()).events.filter(e => e.kind === 'select').length === 2, '刷新后再次选岗');
    await page.goto('https://www.zhipin.com/web/geek/chat');
    await until(async () => (await state()).observingPages === 1, '沟通页监听');
    await page.locator('.chat-control').click();
    await until(async () => (await state()).events.some(e => e.kind === 'click' && e.page === 'chat'), '沟通页点击不漏记');
    await delay(350);
    const clicks = (await state()).events.filter(e => e.action === 'click').length;
    await page.locator('.chat-control').evaluate(el => el.click()); await delay(150);
    assert.equal((await state()).events.filter(e => e.action === 'click').length, clicks, '合成点击不计入人工操作');
    assert.equal((await post('pause')).value.status, 'paused');
    const pausedCount = (await state()).events.length;
    await page.locator('.chat-control').click(); await delay(150);
    assert.equal((await state()).events.length, pausedCount, '暂停期间不记录动作');
    assert.equal((await post('resume')).value.status, 'recording');
    await page.goto('https://www.zhipin.com/web/user/');
    await until(async () => (await state()).status === 'paused', '登录页面暂停');
    await page.locator('input').fill('密码不可采集');
    await page.goto('https://www.zhipin.com/web/geek/jobs');
    assert.equal((await post('resume')).status, 200);
    result = await post('finish');
    assert.equal(result.value.status, 'finished'); assert.equal(result.value.capture, 'dom');
    assert.equal(result.value.observingPages, 0); assert.equal(result.value.rounds.length, 2);
    assert.equal(result.value.rounds[0].outcome, '已点继续沟通');
    const saved = JSON.parse(fs.readFileSync(path.join(data, result.value.id + '.json'), 'utf8'));
    for (const kind of ['select', 'detail_ready', 'company', 'company_ready', 'submit', 'confirm', 'scroll', 'input', 'navigate']) {
      assert.ok(saved.events.some(e => e.kind === kind), kind);
    }
    assert.ok(saved.events.some(e => e.target === 'button.other-control' && e.action === 'click'));
    assert.doesNotMatch(JSON.stringify(saved), /私有|不应保存|不能保存|密码|private-query|www\.zhipin\.com/);
    const finalCount = saved.events.length;
    await page.reload(); await page.locator('.other-control').click(); await delay(350);
    assert.equal((await state()).events.length, finalCount, '结束后刷新也不重新注入');
    assert.ok(!page.isClosed(), '结束不关闭浏览器');
    await page.goto('https://www.zhipin.com/web/user/');
    const refused = await post('start');
    assert.equal(refused.status, 400, '登录页面不虚报监听开始');
    assert.match(refused.value.error, /登录|验证/);
    assert.ok(intercepted >= 6);
    console.log('PASS DOM/CDP 全链路：实际监听就绪、可信点击、详情、公司新标签、输入/滚动、路由/刷新、聊天页、自动分轮、暂停恢复、登录暂停、结束卸载和本机保存；所有页面请求均离线拦截，无真实投递');
  } catch (error) { console.error(childOutput.slice(-1500)); throw error; }
  finally {
    child?.kill(); await context?.close();
    // The fixture directory is retained under the system temp directory for diagnostics.
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
