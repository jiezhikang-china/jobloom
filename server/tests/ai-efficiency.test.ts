import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { FilterService } from '../src/services/filter.service.js';
import { llmService, LLMService } from '../src/services/llm.service.js';
import { AiRequestQueue } from '../src/services/ai-request-queue.js';
import { deepseekProxyService } from '../src/services/deepseek.proxy.service.js';
import { assessLocalRequirement } from '../src/services/work-requirements.js';
import type { BossJobItem, ConditionStatus, WorkRequirement } from '../src/types.js';

const originalGet = configManager.getConfig;
const originalChat = llmService.chatJson;
const originalFetch = globalThis.fetch;
const originalConnection = deepseekProxyService.connection;
const originalConfig = configManager.getConfig();
const config = { ...originalConfig, llm: { ...originalConfig.llm, connectionMode: 'deepseek-web' as const,
  jobBatchSize: 5, minRequestIntervalSeconds: 30, thinking: 'disabled' as const, webSearch: false },
  filter: { ...originalConfig.filter, workRequirements: [] as WorkRequirement[], requiredKeywords: [],
    skipMissingCompanyIntro: false, skipVagueJobDescription: false,
    companyBlacklist: [], degree: ['本科'], experience: [], salaryMin: 0, salaryMax: 0, hrActiveDaysLimit: 0, minLlmMatchScore: 75 } };
const job: BossJobItem = { securityId: '', jobId: '', jobName: '行政助理', lid: '', salaryDesc: '4-6K',
  jobExperience: '经验不限', jobDegree: '大专', cityName: '上海', areaDistrict: '', brandName: '模拟公司',
  brandScaleName: '', brandIndustry: '企业服务', bossName: '', bossTitle: '', activeTimeDesc: '今日活跃', skills: [], welfareList: [] };
const make = (text: string): WorkRequirement => ({ id: 'custom', text, enabled: true });
const localCases: Array<[string, string, ConditionStatus]> = [
  ['每天工作不超过七小时', '每天工作7小时。', 'met'],
  ['每天工作不超过七小时', '每天工作8小时。', 'not_met'],
  ['每天工作不超过7.5小时', '上班时间09:00-17:30，午休1小时。', 'met'],
  ['每天工作不超过七小时', '工时面议。', 'unknown'],
  ['每周双休', '周末双休，不需要加班。', 'met'],
  ['允许无经验入职', '经验不限，入职培训。', 'met'],
  ['不做销售', '负责资料整理，不涉及销售。', 'met'],
  ['不做销售', '负责销售，完成销售指标。', 'not_met'],
  ['不做销售', '不涉及销售，但是需要完成销售任务。', 'unknown'],
  ['不做销售', '负责办公室行政支持。', 'unknown'],
  ['不做销售', '没有任何销售指标。', 'met'],
  ['不做销售', '无销售经验要求，入职有培训。', 'unknown'],
  ['必须缴纳五险一金', '提供五险一金。', 'met'],
  ['必须缴纳五险一金', '没有五险一金。', 'not_met'],
  ['必须缴纳五险一金', '不提供五险一金。', 'not_met'],
  ['必须缴纳五险一金', '无五险一金。', 'not_met'],
  ['必须缴纳五险一金', '五险一金可申请。', 'unknown'],
  ['必须缴纳五险一金', '希望未来提供五险一金。', 'unknown'],
  ['必须缴纳五险一金', '要求熟悉五险一金办理流程。', 'unknown'],
  ['入职缴纳五险一金', '入职即缴纳五险一金。', 'met'],
  ['入职缴纳五险一金', '转正后缴纳五险一金。', 'not_met'],
  ['入职缴纳五险一金', '福利：五险一金。', 'unknown'],
  ['只接受白班', '固定白班，不上夜班。', 'met'],
  ['只接受白班', '两班倒，需要夜班。', 'not_met'],
  ['不上夜班', '白班夜班轮换。', 'unknown'],
  ['不上夜班', '班次面议。', 'unknown'],
  ['不加班', '无需加班。', 'met'],
  ['不加班', '经常加班。', 'not_met'],
  ['不加班', '无法保证不加班。', 'unknown'],
  ['不加班', '不强制加班。', 'unknown'],
  ['必须包含：React', '负责 React 项目。', 'met'],
  ['必须包含：React', '负责 Java 项目。', 'not_met'],
  ['不得包含：劳务派遣', '负责办公室行政支持。', 'met'],
  ['不得包含：劳务派遣', '该岗位为劳务派遣。', 'not_met'],
];

async function main() {
  configManager.getConfig = () => config;
  for (const [text, detail, expected] of localCases) {
    assert.equal(assessLocalRequirement({ ...job, jobExperience: '' }, detail, make(text))?.status, expected, text + '：' + detail);
  }
  assert.equal(assessLocalRequirement(job, '白班，工作7小时。', make('只接受白班并且工作最多7小时')), undefined, '复合要求不能只检查一半');
  assert.equal(assessLocalRequirement(job, '离地铁近。', make('离地铁步行不超过十分钟')), undefined, '新加的复杂条件仍能交给模型');
  const normalize = (configManager as any).normalize.bind(configManager);
  const limited = normalize({ ...config, llm: { ...config.llm, jobBatchSize: 99, minRequestIntervalSeconds: 0 } });
  assert.equal(limited.llm.jobBatchSize, 10); assert.equal(limited.llm.minRequestIntervalSeconds, 10);
  const defaults = normalize({ ...config, llm: { ...config.llm, jobBatchSize: undefined, minRequestIntervalSeconds: undefined } });
  assert.equal(defaults.llm.jobBatchSize, 5); assert.equal(defaults.llm.minRequestIntervalSeconds, 30);

  let calls = 0;
  const groups: any[][] = [];
  (llmService as any).chatJson = async (messages: any[], _retries: number, options: any) => {
    calls++; options?.onRequest?.();
    const serialized = messages[1].content.split('【待评估岗位列表（逐个评估）】：\n')[1];
    const jobs = JSON.parse(serialized);
    groups.push(jobs);
    assert.equal(messages.map((item) => item.content).join('\n').split('共同简历唯一标記').length - 1, 1);
    return { jobs: jobs.slice().reverse().map((item: any) => ({
      jobKey: item.jobKey, score: 90, passed: true, reason: '符合条件', customGreeting: '您好，希望交流。',
      workRequirements: item.requirementsToCheck.map((requirement: any) => ({
        requirementId: requirement.requirementId, status: 'met', evidence: '步行5分钟到地铁',
      })),
    })) };
  };
  config.filter.workRequirements = [make('每天工作不超过八小时')];
  const service = new FilterService();
  const local = await service.evaluateStage2(job, '负责行政事务，每天工作8小时。', '共同简历唯一标記', '工作条件', 'requirements', { rulesOnly: true });
  assert.equal(local.passed, true); assert.equal(local.evaluationSource, 'rules'); assert.equal(calls, 0);
  assert.equal((await service.evaluateStage2(job, '负责行政事务，工时面议。', '共同简历唯一标記', '行政助理')).needsReview, true);
  assert.equal(calls, 1, '缺少简单规则的依据时仍需 AI 分析职责和条件，不能绕过模型');
  await service.evaluateStage2(job, '负责行政事务，每天工作8小时。', '共同简历唯一标記', '行政助理', 'resume');
  assert.equal(calls, 2, '简历匹配不能仅靠工作条件通过');
  calls = 0; groups.length = 0;
  config.filter.workRequirements = [
    { id: 'hours', text: '每天工作不超过八小时', enabled: true },
    { id: 'sales', text: '不做销售', enabled: true },
    { id: 'metro', text: '离地铁步行不超过十分钟', enabled: true },
  ];
  const full = '负责资料整理，不涉及销售。每天工作8小时。步行5分钟到地铁。';
  const candidates = [
    { job, jobDetail: '负责销售，每天工作8小时。步行5分钟到地铁。' },
    { job, jobDetail: '负责资料整理，不涉及销售，工时面议。' },
    ...Array.from({ length: 7 }, (_, index) => ({ job: { ...job, brandName: '模拟公司' + index }, jobDetail: full + '岗位标识' + index })),
  ];
  const batched = new FilterService();
  const results = await batched.evaluateBatch(candidates, '共同简历唯一标記', '行政助理', 'resume');
  assert.equal(calls, 2, '八个初筛合格岗位按5+3合并，只请求两次');
  assert.deepEqual(groups.map((group) => group.length), [5, 3]);
  assert.equal(results[0].passed, false); assert.equal(results[1].needsReview, true);
  assert.ok(results.slice(2).every((item) => item.passed));
  assert.ok(groups.flat().filter(item => item.description.includes('每天工作8小时')).every((item) => item.requirementsToCheck.length === 1 && item.requirementsToCheck[0].requirementId === 'metro'));
  assert.ok(groups.flat().find(item => item.description.includes('工时面议')).requirementsToCheck.some((item: any) => item.requirementId === 'hours'));
  const cached = await batched.evaluateBatch(candidates, '共同简历唯一标記', '行政助理', 'resume');
  assert.equal(calls, 2); assert.ok(cached.slice(2).every((item) => item.evaluationSource === 'cache'));
  await batched.evaluateBatch([{ ...candidates[2], jobDetail: full + '新增职责。' }], '共同简历唯一标記', '行政助理', 'resume');
  assert.equal(calls, 3, 'JD变化必须重新分析');
  await batched.evaluateBatch([candidates[2]], '共同简历唯一标記：简历变化', '行政助理', 'resume');
  assert.equal(calls, 4, '简历变化必须重新分析');
  config.llm.thinking = 'enabled' as any;
  await batched.evaluateBatch([candidates[2]], '共同简历唯一标記', '行政助理', 'resume');
  assert.equal(calls, 5, '模型设置变化必须重新分析');
  config.llm.thinking = 'disabled';
  config.filter.workRequirements[2] = { ...config.filter.workRequirements[2], text: '离地铁步行不超过五分钟' };
  await batched.evaluateBatch([candidates[2]], '共同简历唯一标記', '行政助理', 'resume');
  assert.equal(calls, 6, '要求变化必须重新分析');

  config.filter.workRequirements = [];
  let attempt = 0;
  (llmService as any).chatJson = async () => {
    attempt++;
    return attempt === 1 ? { jobs: [{ jobKey: 'job-1', score: 99, passed: true }, { jobKey: 'job-1', score: 99, passed: true }] }
      : { jobs: [{ jobKey: 'job-1', score: 10, passed: false }, { jobKey: 'job-0', score: 91, passed: true }] };
  };
  const strict = new FilterService();
  const pair = candidates.slice(2, 4);
  const broken = await strict.evaluateBatch(pair, '测试简历', '行政助理');
  assert.ok(broken.every((item) => item.llmError && !item.passed), '漏评、重复项均不能盲目投递');
  const recovered = await strict.evaluateBatch(pair, '测试简历', '行政助理');
  assert.equal(attempt, 2, '坏结果不能写入缓存');
  assert.equal(recovered[0].passed, true); assert.equal(recovered[1].passed, false, '返回顺序与岗位顺序不同也必须对应正确');
  (llmService as any).chatJson = async () => ({ jobs: [{ jobKey: 'job-0', score: 99 }] });
  assert.equal((await new FilterService().evaluateBatch([pair[0]], '测试简历', '行政助理'))[0].llmError, true);
  (llmService as any).chatJson = async () => ({ score: 99, passed: true });
  assert.equal((await new FilterService().evaluateBatch([pair[0]], '测试简历', '行政助理'))[0].llmError, true, '没有岗位ID的总评分不能套给某个岗位');

  config.filter.workRequirements = [{ id: 'metro', text: '离地铁步行不超过十分钟', enabled: true }];
  (llmService as any).chatJson = async () => ({ jobs: [
    { jobKey: 'job-0', score: 90, passed: true, workRequirements: [{ requirementId: 'metro', status: 'met', evidence: '步行5分钟到地铁' }] },
    { jobKey: 'job-1', score: 90, passed: true, workRequirements: [{ requirementId: 'metro', status: 'met', evidence: '步行5分钟到地铁' }] },
  ] });
  const evidenceResults = await new FilterService().evaluateBatch([
    { job, jobDetail: '该岗位地址偏远，交通尚未注明。' }, { job, jobDetail: '步行5分钟到地铁。' },
  ], '测试简历', '行政助理');
  assert.equal(evidenceResults[0].needsReview, true, '不得用同批另一岗位的引文补齐本岗位条件');
  assert.equal(evidenceResults[1].passed, true);

  config.filter.workRequirements = [];
  config.llm.jobBatchSize = 10;
  const largeGroups: number[] = [];
  (llmService as any).chatJson = async (messages: any[]) => {
    const jobs = JSON.parse(messages[1].content.split('【待评估岗位列表（逐个评估）】：\n')[1]);
    largeGroups.push(jobs.length);
    assert.ok(messages[1].content.includes('关键资格位于末尾'), '共同简历不能被截断丢失末尾资格');
    assert.ok(jobs.every((item: any) => item.description.endsWith('末尾工作要求')), '不能为了凑一批截断JD');
    return { jobs: jobs.map((item: any) => ({ jobKey: item.jobKey, score: 90, passed: true })) };
  };
  const longCandidates = Array.from({ length: 7 }, (_, index) => ({ job: { ...job, brandName: '长描述公司' + index },
    jobDetail: '完整岗位信息。'.repeat(1550) + '末尾工作要求' }));
  const longResults = await new FilterService().evaluateBatch(longCandidates, '共同简历。'.repeat(500) + '关键资格位于末尾', '行政助理');
  assert.deepEqual(largeGroups, [3, 3, 1], '长JD按内容长度缩小批次，不截断');
  assert.ok(longResults.every((item) => item.passed));

  await testWebPacing();
  console.log('PASS | ' + localCases.length + ' 项本地条件、初筛后5+3批量请求、顺序/漏评/引文约束、缓存与失效、全局串行/冷却/停止');
}

async function testWebPacing() {
  let time = 0;
  const starts: number[] = [];
  const queue = new AiRequestQueue({ now: () => time, sleep: async (ms, signal) => { signal?.throwIfAborted(); time += ms; } });
  const web = new LLMService(queue);
  deepseekProxyService.connection = async () => ({ baseUrl: 'http://127.0.0.1:19081/v1', apiKey: 'test-local-key-123456789' });
  const successful = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  globalThis.fetch = (async (_url, init: any) => {
    starts.push(time); time += 1000;
    assert.equal(JSON.parse(init.body).min_request_interval_seconds, 30);
    return successful();
  }) as typeof fetch;
  await Promise.all([web.chatJson([{ role: 'user', content: '模拟简历分析' }]),
    web.chatJson([{ role: 'user', content: '模拟岗位评估' }]), web.chatJson([{ role: 'user', content: '模拟连接测试' }])]);
  assert.deepEqual(starts, [0, 31000, 62000], '三个用途共用串行队列且从上一轮结束算间隔');
  let rateCalls = 0;
  globalThis.fetch = (async () => {
    rateCalls++;
    return new Response('{"error":{"message":"网页额度受限"}}', { status: 429, headers: { 'Retry-After': '180' } });
  }) as typeof fetch;
  await assert.rejects(web.chatJson([{ role: 'user', content: '模拟限流' }]), /额度受限/);
  assert.equal(rateCalls, 1, '冷却期间不得再次向反代发送模型请求');
  const limitedAt = time;
  const cooldowns: number[] = [];
  globalThis.fetch = (async () => { rateCalls++; return successful(); }) as typeof fetch;
  await web.chatJson([{ role: 'user', content: '冷却内再次请求' }], 1, { onWait: seconds => cooldowns.push(seconds) });
  assert.equal(rateCalls, 2);
  assert.equal(time - limitedAt, 180000, '真实等待整个冷却，再请求；不暂停任务');
  assert.deepEqual(cooldowns, [180, 120, 60], '长等待分段且可停止');
  const aborted = new AbortController(); aborted.abort(new Error('用户停止'));
  await assert.rejects(web.chatJson([{ role: 'user', content: '取消的请求' }], 1, { signal: aborted.signal }), /用户停止/);
  assert.equal(rateCalls, 2);

  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  let queuedCalls = 0;
  const separate = new LLMService(new AiRequestQueue({ now: () => time, sleep: async (ms) => { time += ms; } }));
  globalThis.fetch = (async () => { queuedCalls++; await blocker; return successful(); }) as typeof fetch;
  const active = separate.chatJson([{ role: 'user', content: '正在执行' }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const controller = new AbortController();
  const cancelled = separate.chatJson([{ role: 'user', content: '排队等待' }], 1, { signal: controller.signal });
  const rejected = assert.rejects(cancelled, /用户停止/);
  controller.abort(new Error('用户停止'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([rejected, new Promise((_resolve, reject) => {
    timer = setTimeout(() => { release(); reject(new Error('停止排队任务不能等待其他网页请求结束')); }, 1000);
  })]).finally(() => clearTimeout(timer));
  assert.equal(queuedCalls, 1);
  release(); await active;
  assert.equal(queuedCalls, 1, '排队中的已停止任务不能启动网页请求');

  let coolingTime = 0, coolingCalls = 0;
  const cancelCooldown = new AbortController();
  const cancellableQueue = new AiRequestQueue({ now: () => coolingTime, sleep: async ms => {
    coolingTime += ms; cancelCooldown.abort(new Error('冷却中停止'));
  } });
  cancellableQueue.coolDown(1000);
  await assert.rejects(cancellableQueue.run(30, async () => { coolingCalls++; }, { signal: cancelCooldown.signal }), /冷却中停止/);
  assert.equal(coolingCalls, 0, '冷却中停止，不发送任何请求');

  const dateQueue = new AiRequestQueue({ now: () => coolingTime, sleep: async ms => { coolingTime += ms; } });
  const dateService = new LLMService(dateQueue);
  const retryDate = new Date(Date.now() + 900000).toUTCString();
  globalThis.fetch = (async () => new Response('{"error":{"message":"暂时繁忙"}}', { status: 503, headers: { 'Retry-After': retryDate } })) as typeof fetch;
  await assert.rejects(dateService.chatJson([{ role: 'user', content: '日期等待' }]), /繁忙/);
  const beforeCooling = coolingTime;
  let gateRan = false;
  globalThis.fetch = (async () => { assert.equal(gateRan, true); return successful(); }) as typeof fetch;
  await dateService.chatJson([{ role: 'user', content: '日期等待' }], 1, { beforeRequest: async () => { gateRan = true; } });
  assert.ok(coolingTime - beforeCooling >= 898000, 'HTTP日期形式且超过300秒，不能截短等待');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  configManager.getConfig = originalGet; llmService.chatJson = originalChat;
  globalThis.fetch = originalFetch; deepseekProxyService.connection = originalConnection;
});
