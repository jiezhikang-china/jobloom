import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { llmService } from '../src/services/llm.service.js';
import { filterService } from '../src/services/filter.service.js';
import { DeliveryService } from '../src/services/delivery.service.js';
import { bossPageService } from '../src/services/boss.page.service.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';
import type { BossJobItem } from '../src/types.js';

const originalConfig = configManager.getConfig();
const originalGetConfig = configManager.getConfig;
const originalFetch = globalThis.fetch;
const originalChatJson = llmService.chatJson;
const originalInitJobPage = bossPageService.initJobPage;
const originalLoadQuota = stateManager.loadQuota;

async function main(): Promise<void> {
  const config = {
    ...originalConfig,
    llm: { ...originalConfig.llm, connectionMode: 'api' as const, apiKey: 'test-api-key-123456', model: 'GLM-4.7-Flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    filter: { ...originalConfig.filter, requiredKeywords: ['React', 'TypeScript'] },
    delivery: { ...originalConfig.delivery, dailyMaxQuota: 0 },
  };
  const normalize = (configManager as any).normalize.bind(configManager);
  assert.equal(normalize(config).llm.model, 'glm-4.7-flash');
  assert.equal(normalize(config).delivery.dailyMaxQuota, 0);
  assert.equal(normalize({ ...config, delivery: { ...config.delivery, dailyMaxQuota: 151 } }).delivery.dailyMaxQuota, 150);
  assert.equal(normalize({ ...config, delivery: { ...config.delivery, dailyMaxQuota: -1 } }).delivery.dailyMaxQuota, 0);

  (configManager as any).getConfig = () => config;
  let requestBody: any;
  let requestUrl = '';
  globalThis.fetch = (async (url: any, init: any) => {
    requestUrl = String(url);
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  }) as typeof fetch;
  const json = await llmService.chatJson<{ ok: boolean }>([{ role: 'user', content: '返回 JSON' }]);
  assert.deepEqual(json, { ok: true });
  assert.equal(requestUrl, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.equal(requestBody.model, 'glm-4.7-flash');
  assert.deepEqual(requestBody.thinking, { type: 'disabled' });
  assert.deepEqual(requestBody.response_format, { type: 'json_object' });
  config.llm.baseUrl = 'https://open.bigmodel.cn/api/paas/v4/chat/completions/';
  await llmService.chatJson([{ role: 'system', content: '业务说明' }, { role: 'user', content: '返回 JSON' }]);
  assert.equal(requestUrl, 'https://open.bigmodel.cn/api/paas/v4/chat/completions', '完整接口地址不应重复追加路径');
  assert.equal(requestBody.messages.filter((item: any) => item.role === 'system').length, 1);
  assert.match(requestBody.messages[0].content, /业务说明/);
  assert.match(requestBody.messages[0].content, /JSON/);
  config.llm.thinking = 'enabled';
  await llmService.chat([{ role: 'user', content: '测试' }], false, 1);
  assert.deepEqual(requestBody.thinking, { type: 'enabled' }, '用户主动选择后才开启深度思考');
  config.llm.baseUrl = 'https://example.com/v1';
  config.llm.webSearch = true;
  await llmService.chat([{ role: 'user', content: '测试' }], false, 1);
  assert.equal(requestBody.thinking, undefined, '兼容接口不应被添加智谱专用参数');
  assert.equal(requestBody.web_search, undefined, '网页联网选项不能添加到自定义 API 请求');
  config.llm.baseUrl = 'https://open.bigmodel.cn/api/paas/v4';
  config.llm.thinking = 'disabled';
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: '{"ok":true}' } }] }), { status: 200 })) as typeof fetch;
  await assert.rejects(llmService.chatJson([{ role: 'user', content: '返回 JSON' }], 1), /没有最终答案/);
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"ok":' } }] }), { status: 200 })) as typeof fetch;
  await assert.rejects(llmService.chatJson([{ role: 'user', content: '返回 JSON' }], 1), /被截断/);
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: { code: '401', message: '令牌已过期或验证不正确' } }),
    { status: 401 }
  )) as typeof fetch;
  await assert.rejects(
    llmService.chat([{ role: 'user', content: '测试' }], false, 1),
    /HTTP 401.*API Key 无效或已过期.*令牌已过期或验证不正确/
  );

  const job: BossJobItem = {
    securityId: '', jobId: '', jobName: '前端工程师', lid: '', salaryDesc: '20-30K',
    jobExperience: '3-5年', jobDegree: '本科', cityName: '上海', areaDistrict: '',
    brandName: '测试公司', brandScaleName: '', brandIndustry: '软件', bossName: '', bossTitle: '',
    activeTimeDesc: '今日活跃', skills: [], welfareList: [],
  };
  let llmCalls = 0;
  (llmService as any).chatJson = async () => {
    llmCalls++;
    return { score: 90, passed: true, reason: '匹配', customGreeting: '您好' };
  };
  const miss = await filterService.evaluateStage2(job, '只需 Java 开发', '简历', '前端工程师');
  assert.equal(miss.passed, false);
  assert.match(miss.reason, /未命中需求词/);
  assert.equal(llmCalls, 0);
  const hit = await filterService.evaluateStage2(job, '熟悉 typescript 项目开发', '简历', '前端工程师');
  assert.equal(hit.passed, true);
  assert.equal(llmCalls, 1);
  let manualMessages: any[] = [];
  (llmService as any).chatJson = async (messages: any[]) => {
    manualMessages = messages;
    return { score: 90, reason: '岗位符合要求' };
  };
  const manual = await filterService.evaluateStage2(job, '熟悉 React 项目开发', '希望找 React 岗位', '前端工程师', 'requirements');
  assert.equal(manual.passed, true);
  assert.match(manualMessages[0].content, /用户没有提供简历/);
  assert.match(manualMessages[1].content, /用户指定的岗位方向与筛选要求/);
  assert.doesNotMatch(manual.customGreeting, /多年|主导|经验/);

  let opened = 0;
  (stateManager as any).loadQuota = () => ({ date: todayStr(), count: 0 });
  (bossPageService as any).initJobPage = async () => { opened++; return {}; };
  const delivery = new DeliveryService();
  await delivery.startDelivery({ targetRole: '前端工程师', keywords: ['前端'], resumeText: '测试简历' });
  assert.equal(delivery.getStats().status, 'finished');
  assert.equal(opened, 0, '0 配额不应打开职位页面');
  process.stdout.write('PASS | GLM 请求、需求词过滤、每日 0–150 配额\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  (configManager as any).getConfig = originalGetConfig;
  globalThis.fetch = originalFetch;
  (llmService as any).chatJson = originalChatJson;
  (bossPageService as any).initJobPage = originalInitJobPage;
  (stateManager as any).loadQuota = originalLoadQuota;
});
