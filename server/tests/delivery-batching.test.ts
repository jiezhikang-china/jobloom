import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';
import { DeliveryService } from '../src/services/delivery.service.js';
import { bossPageService } from '../src/services/boss.page.service.js';
import { llmService } from '../src/services/llm.service.js';
import { workConditionReviews } from '../src/services/work-condition-reviews.js';
import type { DOMJobCardInfo } from '../src/services/boss.page.service.js';

const restores: Array<() => void> = [];
function stub(object: any, key: string, replacement: any) {
  const original = object[key]; object[key] = replacement; restores.push(() => { object[key] = original; });
}
const original = configManager.getConfig();
const config = { ...original, llm: { ...original.llm, jobBatchSize: 3 },
  filter: { ...original.filter, cityName: '上海', cityCode: '101020100', salaryMin: 3, salaryMax: 8,
    degree: ['本科'], experience: [], hrActiveDaysLimit: 0, requiredKeywords: [], companyBlacklist: [],
    workRequirements: [{ id: 'hours', text: '每天工作不超过八小时', enabled: true },
      { id: 'metro', text: '离地铁步行不超过十分钟', enabled: true }] },
  delivery: { dailyMaxQuota: 2, minDelaySeconds: 0, maxDelaySeconds: 0 } };
const card = (key: string, salary = '4-6K'): DOMJobCardInfo => ({ index: 0, jobHref: '/job_detail/' + key + '.html',
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

async function main() {
  stub(configManager, 'getConfig', () => config);
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
      activeTimeDesc: '今日活跃', brandIndustry: '企业服务', alreadyChatted: false, chatButtonLocator: { key: company } };
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
  assert.deepEqual(batches, [['甲', '乙', '丙']], '只有三个初筛合格的岗位进入同一模型请求');
  assert.deepEqual(sent, ['甲', '乙'], '同批返回乱序时依旧正确对应，达到配额不发第三个岗位');
  assert.equal(loaded.includes('薪资不符'), false, '薪资初筛失败甚至不需要打开完整JD');
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
  assert.ok(stale.getLogs().some((item) => item.message.includes('暂存已过期')));

  changed = false; loaded.length = 0; sent.length = 0;
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
  console.log('PASS | 先脚本初筛再暂存、3岗位1请求、尾批处理、乱序对应、同批配额、旧JD不发送、AI请求可停止');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { for (const restore of restores.reverse()) restore(); });
