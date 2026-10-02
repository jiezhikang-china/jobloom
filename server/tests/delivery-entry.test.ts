import assert from 'node:assert/strict';
import express from 'express';
import { apiRouter } from '../src/routes/api.router.js';
import { browserService } from '../src/services/browser.service.js';
import { deliveryService } from '../src/services/delivery.service.js';
import { configManager } from '../src/config/config.manager.js';

const originalLogin = browserService.checkLoginStatus;
const originalVerify = browserService.verifyLogin;
const originalActive = deliveryService.isActive;
const originalStart = deliveryService.startDelivery;
const originalGetConfig = configManager.getConfig;
const originalConfig = configManager.getConfig();

async function main(): Promise<void> {
  configManager.getConfig = () => ({ ...originalConfig, delivery: { ...originalConfig.delivery, jobSource: 'search' } });
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未启动');
  const url = `http://127.0.0.1:${address.port}/api/delivery/start`;
  const calls: any[] = [];
  (browserService as any).checkLoginStatus = async () => ({ isLoggedIn: true, isBrowserActive: true });
  (deliveryService as any).isActive = () => false;
  (deliveryService as any).startDelivery = async (params: any) => { calls.push(params); };
  const post = async (body: any) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };

  try {
    const manual = await post({ mode: 'manual', targetRole: '前端工程师', requirementsText: '希望上海 React 岗位，非外包。' });
    assert.equal(manual.status, 200);
    assert.equal(calls[0].candidateSource, 'requirements');
    assert.deepEqual(calls[0].keywords, ['前端工程师']);
    assert.match(calls[0].resumeText, /React/);

    const resume = await post({ mode: 'resume', targetRole: '前端工程师', keywords: ['前端'], resumeText: '前端经验与项目成果。'.repeat(10) });
    assert.equal(resume.status, 200);
    assert.equal(calls[1].candidateSource, 'resume');

    const missing = await post({ mode: 'manual', targetRole: '前端工程师', keywords: ['前端'], requirementsText: 'React' });
    assert.equal(missing.status, 400);
    assert.equal(calls.length, 2);

    let rechecks = 0;
    (browserService as any).checkLoginStatus = async () => ({ isLoggedIn: false, isBrowserActive: true, reasonCode: 'unverified', reason: '职位页尚未验证' });
    (browserService as any).verifyLogin = async () => { rechecks++; return { isLoggedIn: true, isBrowserActive: true }; };
    const recovered = await post({ mode: 'manual', targetRole: '前端工程师', requirementsText: '希望上海 React 岗位，非外包。' });
    assert.equal(recovered.status, 200);
    assert.equal(rechecks, 1, '有 Cookie 但页面尚未验证时应复核，而非要求扫码');

    (browserService as any).checkLoginStatus = async () => ({ isLoggedIn: false, isBrowserActive: false, reasonCode: 'browser_unavailable', reason: 'Chrome 连接失败' });
    const unavailable = await post({ mode: 'manual', targetRole: '前端工程师', keywords: ['前端'], requirementsText: '希望上海 React 岗位，非外包。' });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.json.reasonCode, 'browser_unavailable');
    assert.doesNotMatch(unavailable.json.message, /扫码/);
    assert.equal(calls.length, 3);
    (browserService as any).checkLoginStatus = async () => ({ isLoggedIn: true, isBrowserActive: true });
    const classified = await post({ mode: 'manual', targetRole: '用户别名', positionCode: '100901', requirementsText: '希望上海 React 岗位，非外包。' });
    assert.equal(classified.status, 200);
    assert.equal(calls[3].positionCode, '100901');
    assert.equal(calls[3].targetRole, '前端开发工程师', '服务端应使用官方岗位名');
    assert.deepEqual(calls[3].keywords, [''], '按分类浏览时不应强制附加岗位名称关键词');
    const invalid = await post({ mode: 'manual', targetRole: '虚构岗位', positionCode: '999999', requirementsText: '希望上海 React 岗位，非外包。' });
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 4);
    const conditions = await post({ mode: 'manual', targetRole: '符合工作条件的岗位', keywords: ['双休', '经验不限'],
      requirementsText: '希望每天八小时、每周双休、允许无经验入职。' });
    assert.equal(conditions.status, 200);
    assert.equal(calls[4].positionCode, undefined, '按工作条件搜索时无需指定职业分类');
    assert.deepEqual(calls[4].keywords, ['双休', '经验不限']);
    assert.equal(calls[4].candidateSource, 'requirements');
    process.stdout.write('PASS | 简历、手动和按工作条件投递入口与登录故障区分\n');
  } finally {
    configManager.getConfig = originalGetConfig;
    (browserService as any).checkLoginStatus = originalLogin;
    (browserService as any).verifyLogin = originalVerify;
    (deliveryService as any).isActive = originalActive;
    (deliveryService as any).startDelivery = originalStart;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
