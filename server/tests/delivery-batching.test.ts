import { bossActionScheduler } from '../src/services/boss-action-scheduler.js';
import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';
import { DeliveryService } from '../src/services/delivery.service.js';
import { bossPageService } from '../src/services/boss.page.service.js';
import { llmService } from '../src/services/llm.service.js';
import { workConditionReviews } from '../src/services/work-condition-reviews.js';
import type { DOMJobCardInfo } from '../src/services/boss.page.service.js';
import { evaluationRetrySeconds } from '../src/services/ai-retry.js';

const restores: Array<() => void> = [];
function stub(object: any, key: string, replacement: any) {
  const original = object[key]; object[key] = replacement; restores.push(() => { object[key] = original; });
}
const original = configManager.getConfig();
const config = { ...original, llm: { ...original.llm, jobBatchSize: 3 },
  filter: { ...original.filter, commute: {}, cityName: '上海', cityCode: '101020100', salaryMin: 3, salaryMax: 8,
    degree: ['本科'], experience: [], hrActiveDaysLimit: 0, requiredKeywords: [], companyBlacklist: [],
    workRequirements: [{ id: 'hours', text: '每天工作不超过八小时', enabled: true },
      { id: 'metro', text: '离地铁步行不超过十分钟', enabled: true }] },
  delivery: { dailyMaxQuota: 2, minDelaySeconds: 0, maxDelaySeconds: 0 } };
const card = (key: string, salary = '4-6K'): DOMJobCardInfo => ({ index: 0, jobHref: '/job_detail/' + Buffer.from(key).toString('hex') + '.html',
  jobName: '行政助理', companyName: key, cityName: '上海', salary, activeTimeDesc: '今日活跃', experience: '经验不限',
  degree: '大专', skills: [], cardLocator: { key } as any });
let cards = [card('薪资不符', '1-2K'), card('工时不符'), card('作息未注明'), card('甲'), card('乙'), card('丙')];
const loaded: string[] = [];
const sent: string[] = [];
const reviewed: string[] = [];
const batches: string[][] = [];
let marked = 0;
let currentDetail = '';
let changed = false;
let changedLocation = false;
let locationAfter: 'far' | 'unknown' = 'far';
const origin = { name: '人民广场', address: '上海人民大道185号', cityName: '上海', query: '上海人民广场',
  longitude: 121.481492, latitude: 31.234736, coordinateSystem: 'boss' as const };

async function main() {
  stub(configManager, 'getConfig', () => config);
  stub(bossActionScheduler, 'waitSeconds', () => 0);
  stub(bossActionScheduler, 'isBusinessRestImminent', () => false);
  stub(DeliveryService.prototype, 'paceJobSelection', async () => true);
  stub(stateManager, 'loadQuota', () => ({ date: todayStr(), count: 0 }));
  stub(stateManager, 'saveQuota', () => {});
  stub(workConditionReviews, 'add', (input: any) => { reviewed.push(input.companyName); });
  stub(workConditionReviews, 'removeForJob', () => {});
  stub(bossPageService, 'initJobPage', async () => ({}));
  stub(bossPageService, 'getVisibleJobCards', async () => cards);
  stub(bossPageService, 'isCardStillTarget', async (locator: any, _name: string, company: string) => locator.key === company);
  stub(bossPageService, 'isDetailStillTarget', async (_name: string, company: string) => currentDetail === company);
  stub(bossPageService, 'loadJobDetail', async (_locator: any, _name: string, company: string) => {
    const times = loaded.filter((value) => value === company).length;
    loaded.push(company); currentDetail = company;
    return { jobDetailText: '负责行政文书支持。步行5分钟到地铁。' + (company === '工时不符' || (changed && company === '甲' && times > 0)
      ? '每天工作9小时。' : company === '作息未注明' ? '详细作息面议。' : '每天工作8小时。'),
      activeTimeDesc: '今日活跃', brandIndustry: '企业服务', alreadyChatted: false, chatButtonLocator: { key: company },
      workAddress: changedLocation ? company === '甲' && times > 0
        ? locationAfter === 'unknown' ? undefined : { address: '搬到远处的工作地', point: { longitude: 120.2, latitude: 30.5, coordinateSystem: 'boss' as const } }
        : { address: '上海人民广场附近的工作地', point: { longitude: 121.48, latitude: 31.23, coordinateSystem: 'boss' as const } } : undefined };
  });
  stub(bossPageService, 'executeChatClick', async (locator: any, greeting: string, target: any) => {
    assert.equal(currentDetail, target.companyName, '发送时必须重新打开正确的岗位详情');
    assert.equal(locator.key, target.companyName);
    assert.equal(greeting, '您好，' + target.companyName);
    sent.push(target.companyName); return { success: true, greetingSent: true };
  });
  stub(bossPageService, 'markJobNotSuit', async () => { marked++; return true; });
  stub(bossPageService, 'isJobListPage', async () => true);
  stub(bossPageService, 'scrollDownForMore', async () => {});
  stub(llmService, 'chatJson', async (messages: any[], _retries: number, options: any) => {
    const jobs = JSON.parse(messages[1].content.split('【待评估岗位列表（逐个评估）】：\n')[1]);
    batches.push(jobs.map((item: any) => item.companyName));
    assert.ok(jobs.every((item: any) => loaded.includes(item.companyName)), '必须先完整初筛、收集岗位再请求');
    options.onRequest();
    return { jobs: jobs.slice().reverse().map((item: any) => ({
      jobKey: item.jobKey, score: 90, passed: true, customGreeting: '您好，' + item.companyName,
      workRequirements: [{ requirementId: 'metro', status: 'met', evidence: '步行5分钟到地铁' }],
    })) };
  });

  const service = new DeliveryService();
  const params = { targetRole: '行政助理', keywords: ['行政'], resumeText: '虚构简历，行政支持经验。'.repeat(8) };
  await service.startDelivery(params);

  assert.deepEqual(batches, [['作息未注明', '甲', '乙']], '未知作息与两个合格岗位一起评估；硬拒绝仍不请求，达到配额停止下一批');
  assert.deepEqual(sent, ['甲', '乙'], '同批返回乱序时依旧正确对应，达到配额不发第三个岗位');
  assert.equal(loaded.includes('薪资不符'), true, '先读详情后脚本初筛，不能仅凭卡片薪资淘汰');
  assert.deepEqual(reviewed, ['作息未注明']); assert.equal(marked, 2);
  assert.equal(service.getStats().aiRequestCount, 1);
  assert.equal(service.getStats().todayAppliedCount, 2);
  assert.equal(service.getStats().pendingEvaluationCount, 0);
  assert.equal(service.getStats().status, 'finished');

  loaded.length = 0; sent.length = 0; batches.length = 0;
  cards = [card('甲'), card('乙')]; changed = true;
  config.delivery.dailyMaxQuota = 1;
  const stale = new DeliveryService();
  await stale.startDelivery({ ...params, resumeText: params.resumeText + '新批次' });
  assert.deepEqual(batches, [['甲', '乙']], '列表最后不足三条，也只发一个批量请求');
  assert.deepEqual(sent, ['乙'], '暂存岗位的JD改变后不能使用旧评估投递');
  assert.ok(reviewed.includes('甲'), '最新详情变化也应保存待確認而非永久跳过');

  changed = false; changedLocation = true; loaded.length = 0; sent.length = 0;
  config.filter.commute = { origin, maxDistanceKm: 15 };
  const moved = new DeliveryService();
  await moved.startDelivery({ ...params, resumeText: params.resumeText + '地址变更测试' });
  assert.deepEqual(sent, ['乙'], 'AI通过后重新打开的工作地点变远，也必须拒绝发送');
  assert.ok(moved.getLogs().some(item => item.message.includes('最新岗位已不符合筛选') && item.message.includes('距离')));
  loaded.length = 0; sent.length = 0; reviewed.length = 0; locationAfter = 'unknown';
  const missingLocation = new DeliveryService();
  await missingLocation.startDelivery({ ...params, resumeText: params.resumeText + '地址变更为未知测试' });
  assert.deepEqual(sent, ['乙']); assert.deepEqual(reviewed, ['甲'], 'AI通过后地址缺失，保留到待确认列表');
  changedLocation = false; config.filter.commute = {};

  changed = false; loaded.length = 0; sent.length = 0;
  config.delivery.dailyMaxQuota = 2;
  const delays: number[] = []; const retryBatches: string[][] = [];
  let retries = 0;
  stub(llmService, 'chatJson', async (messages: any[], _count: number, options: any) => {
    options.onRequest();
    const jobs = JSON.parse(messages[1].content.split('【待评估岗位列表（逐个评估）】：\n')[1]);
    retryBatches.push(jobs.map((item: any) => item.companyName));
    if (++retries < 3) throw new Error('DeepSeek暂时繁忙');
    return { jobs: jobs.map((item: any) => ({ jobKey: item.jobKey, score: 90, passed: true, customGreeting: '您好，' + item.companyName,
      workRequirements: [{ requirementId: 'metro', status: 'met', evidence: '步行5分钟到地铁' }] })) };
  });
  const retrying = new DeliveryService();
  (retrying as any).sleepInterruptible = async (ms: number) => { delays.push(ms); assert.equal(retrying.getStats().status, 'running'); return true; };
  await retrying.startDelivery({ ...params, resumeText: params.resumeText + '重试恢复测试' });
  assert.deepEqual(retryBatches, [['甲', '乙'], ['甲', '乙'], ['甲', '乙']], '失败后保留同一批岗位');
  assert.deepEqual(delays, [30000, 60000], '连续失败加长等待，不立即重发或暂停');
  assert.deepEqual(sent, ['甲', '乙']); assert.equal(retrying.getStats().status, 'finished'); assert.equal(retrying.getStats().skippedByLlmErrorCount, 0);
  assert.ok(retrying.getLogs().some(item => item.message.includes('AI 等待重试')));
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => evaluationRetrySeconds(n, 30)), [30, 60, 120, 240, 300, 300]);
  assert.equal(evaluationRetrySeconds(1, 90), 90);
  sent.length = 0; retries = 0;
  const cancelledRetry = new DeliveryService();
  (cancelledRetry as any).sleepInterruptible = async () => { cancelledRetry.stop(); return false; };
  await cancelledRetry.startDelivery({ ...params, resumeText: params.resumeText + '重试等待停止测试' });
  assert.equal(retries, 1); assert.equal(cancelledRetry.getStats().status, 'idle'); assert.deepEqual(sent, [], '等待重试时停止，不再请求或投递');
  loaded.length = 0; sent.length = 0;
  let entered!: () => void;
  const inFlight = new Promise<void>((resolve) => { entered = resolve; });
  stub(llmService, 'chatJson', async (_messages: any[], _retries: number, options: any) => {
    entered();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const stopping = new DeliveryService();
  const run = stopping.startDelivery({ ...params, resumeText: params.resumeText + '停止测试' });
  await inFlight; stopping.stop(); await run;
  assert.equal(stopping.getStats().status, 'idle'); assert.equal(stopping.getStats().pendingEvaluationCount, 0);
  assert.deepEqual(sent, [], 'AI请求中点击停止，暂存的岗位均不得发送');
  assert.equal(stopping.isActive(), false);

  changed = false; config.filter.workRequirements = []; config.filter.hrActiveDaysLimit = 3;
  config.delivery.dailyMaxQuota = 1; config.filter.skipMissingCompanyIntro = false; config.filter.skipVagueJobDescription = false;
  loaded.length = 0; sent.length = 0; reviewed.length = 0; batches.length = 0;
  cards = [{ ...card('缺卡片字段'), salary: '', degree: '', experience: '', cityName: '', activeTimeDesc: '' }];
  stub(bossPageService, 'loadJobDetail', async (_locator: any, _name: string, company: string) => {
    loaded.push(company); currentDetail = company;
    return { jobDetailText: '负责行政文书和资料整理，每周双休。', activeTimeDesc: '', brandIndustry: '企业服务',
      alreadyChatted: false, chatButtonLocator: { key: company }, cardData: { salary: '4-6K', degree: '大专', experience: '经验不限', cityName: '上海' } };
  });
  stub(llmService, 'chatJson', async (messages: any[]) => {
    const jobs = JSON.parse(messages[1].content.split('【待评估岗位列表（逐个评估）】：\n')[1]);
    batches.push(jobs.map((item: any) => item.companyName));
    return { jobs: jobs.map((item: any) => ({ jobKey: item.jobKey, score: 90, passed: true, customGreeting: '您好，' + item.companyName })) };
  });
  await new DeliveryService().startDelivery({ ...params, resumeText: params.resumeText + '详情补字段测试' });
  assert.deepEqual(sent, ['缺卡片字段'], '卡片缺字段先读其已核对详情补齐；招聘者活跃时间未知不无端跳过');

  config.filter.hrActiveDaysLimit = 0; cards = [card('临时详情失败')]; sent.length = 0; reviewed.length = 0;
  let detailAttempts = 0;
  stub(bossPageService, 'loadJobDetail', async () => { detailAttempts++; throw new Error('详情还没有绑定到所选职位'); });
  const deferred = new DeliveryService();
  (deferred as any).sleepInterruptible = async () => true;
  await deferred.startDelivery({ ...params, resumeText: params.resumeText + '读详情失败保留测试' });
  assert.equal(detailAttempts, 3); assert.deepEqual(reviewed, ['临时详情失败']); assert.deepEqual(sent, []);

  cards = [card('格式待确认')]; reviewed.length = 0; detailAttempts = 0;
  stub(bossPageService, 'loadJobDetail', async (_locator: any, _name: string, company: string) => {
    currentDetail = company; return { jobDetailText: '负责行政文书和资料整理。', activeTimeDesc: '', brandIndustry: '企业服务', alreadyChatted: false, chatButtonLocator: { key: company } };
  });
  let outputCalls = 0;
  stub(llmService, 'chatJson', async () => { outputCalls++; return { jobs: [{ jobKey: 'job-0', score: 80 }] }; });
  const outputReview = new DeliveryService();
  (outputReview as any).sleepInterruptible = async () => true;
  await outputReview.startDelivery({ ...params, resumeText: params.resumeText + '已返回格式待确认测试' });
  assert.equal(outputCalls, 1); assert.deepEqual(reviewed, ['格式待确认']); assert.deepEqual(sent, [], '响应结论缺失保留待确认，不当网络失败重新生成');
  // Real long test regression: a short batch must not wait behind a long browsing break.
  cards = [card('逾时候选'), card('稍后候选')]; config.delivery.dailyMaxQuota = 1;
  loaded.length = 0; sent.length = 0; batches.length = 0;
  stub(bossPageService, 'loadJobDetail', async (_locator: any, _name: string, company: string) => {
    loaded.push(company); currentDetail = company;
    return { jobDetailText: '负责行政文书和资料整理。', activeTimeDesc: '', brandIndustry: '企业服务', alreadyChatted: false, chatButtonLocator: { key: company } };
  });
  stub(llmService, 'chatJson', async (messages: any[], _count: number, options: any) => {
    const jobs = JSON.parse(messages[1].content.split('【待评估岗位列表（逐个评估）】：\n')[1]);
    batches.push(jobs.map((item: any) => item.companyName)); options.onRequest();
    return { jobs: jobs.map((item: any) => ({ jobKey: item.jobKey, score: 90, passed: true, customGreeting: '您好，' + item.companyName })) };
  });
  let virtualNow = Date.now();
  stub(Date, 'now', () => virtualNow);
  const aging = new DeliveryService();
  aging.subscribe((_stats, log) => { if (log?.message.startsWith('[初筛暂存')) virtualNow += 90001; });
  await aging.startDelivery({ ...params, resumeText: params.resumeText + '候选逾期合并测试' });
  assert.deepEqual(batches, [['逾时候选']], '等待过久的小批次先评估，不继续攒满');
  assert.deepEqual(sent, ['逾时候选']); assert.equal(loaded.includes('稍后候选'), false);
  loaded.length = 0; sent.length = 0; batches.length = 0;
  stub(bossActionScheduler, 'isBusinessRestImminent', () => loaded.length > 0);
  const beforeBreak = new DeliveryService();
  await beforeBreak.startDelivery({ ...params, resumeText: params.resumeText + '业务长休息前合并测试' });
  assert.deepEqual(batches, [['逾时候选']], '尚未开始休息但下一次选择会达到休息点时，先评估候选');
  assert.deepEqual(sent, ['逾时候选']); assert.equal(beforeBreak.getStats().aiRequestCount, 1);
  console.log('PASS | 先脚本初筛再暂存、3岗位1请求、尾批处理、乱序对应、同批配额、旧JD不发送、AI请求可停止');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { for (const restore of restores.reverse()) restore(); });
