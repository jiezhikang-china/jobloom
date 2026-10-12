import { browserService } from '../src/services/browser.service.js';
import './fixtures/activate-isolated-safety.js';
import { resetOfflineCandidates } from './fixtures/safety.js';
import assert from 'node:assert/strict';
import { llmService } from '../src/services/llm.service.js';
import { DeliveryService } from '../src/services/delivery.service.js';
import { configManager } from '../src/config/config.manager.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';
import { bossPageService } from '../src/services/boss.page.service.js';
import { notSuitableStore } from '../src/services/not-suitable-store.js';
import { workConditionReviews } from '../src/services/work-condition-reviews.js';

const restores: Array<() => void> = [];
const stub = (object: any, key: string, value: any) => {
  const original = object[key]; object[key] = value; restores.push(() => object[key] = original);
};
async function main() {
  stub(browserService, 'closeAfterTask', async () => false);
  const original = configManager.getConfig();
  const config = { ...original, delivery: { ...original.delivery, jobSource: 'search' as const, dailyMaxQuota: 5 },
    filter: { ...original.filter, companyBlacklist: [] as string[], requiredKeywords: [], workRequirements: [{ id: 'hours', text: '每天工作不超过八小时', enabled: true }], commute: {},
      candidateLanguages: '', degree: [], experience: [], hrActiveDaysLimit: 0, cityName: '', cityCode: '',
      salaryMin: 0, salaryMax: 0, skipMissingCompanyIntro: false, skipVagueJobDescription: false } };
  let generation = 0, rested = false, listOpens = 0, restAfter = 1;
  const loaded: string[] = [], sent: string[] = [];
  stub(configManager, 'getConfig', () => config);
  stub(llmService, 'chatJson', async () => { throw new Error('本地休息测试禁止请求真实 AI'); });
  stub(stateManager, 'loadQuota', () => ({ date: todayStr(), count: 3 }));
  stub(stateManager, 'saveQuota', () => {});
  stub(notSuitableStore, 'matches', () => false);
  stub(workConditionReviews, 'removeForJob', () => {});
  stub(workConditionReviews, 'add', () => { throw new Error('正常休息不能把岗位变成待确认'); });
  stub(bossPageService, 'initJobPage', async () => { listOpens++; });
  stub(bossPageService, 'isJobListPage', async () => true);
  stub(bossPageService, 'scrollDownForMore', async () => {});
  const cards = () => ['one', 'two'].map(key => ({ index: 0, jobHref: '/job_detail/' + key + '.html',
    jobName: '客服', companyName: '示例电商', salary: '6-8K', degree: '大专', experience: '经验不限',
    cityName: '上海', activeTimeDesc: '今日活跃', skills: [], cardLocator: { key, generation } }));
  stub(bossPageService, 'getVisibleJobCards', async () => cards());
  stub(bossPageService, 'isCardStillTarget', async (locator: any) => {
    assert.equal(locator.generation, generation, '休息重开后不能继续使用旧卡片'); return true;
  });
  stub(bossPageService, 'isDetailStillTarget', async () => true);
  stub(bossPageService, 'loadJobDetail', async (locator: any) => {
    assert.equal(locator.generation, generation); loaded.push(locator.key);
    const card = cards().find(card => card.cardLocator.key === locator.key)!;
    return { detailData: { jobHref: card.jobHref, jobName: card.jobName, companyName: card.companyName, salary: card.salary,
      degree: card.degree, experience: card.experience, cityName: card.cityName, skills: [] }, brandIndustry: '',
      jobDetailText: '负责回复电商用户咨询，整理售后订单信息。每天工作8小时。', activeTimeDesc: '今日活跃', alreadyChatted: false,
      chatButtonLocator: { key: locator.key, generation } };
  });
  stub(bossPageService, 'executeChatClick', async (button: any) => {
    assert.equal(button.generation, generation, '不能向已关闭浏览器的按钮提交'); sent.push(button.key);
    return { success: true, greetingSent: true, continued: true };
  });
  const rest = { runIfDue: async () => {
    if (!rested && loaded.length >= restAfter) { rested = true; generation++; return true; } return false;
  } };
  resetOfflineCandidates();
  const service = new DeliveryService(rest);
  await service.startDelivery({ targetRole: '客服', keywords: ['客服'], resumeText: '希望客服工作。', candidateSource: 'requirements', rulesOnly: true });
  assert.equal(service.getStats().status, 'finished');
  assert.equal(service.getStats().todayAppliedCount, 5, '重开不会重置已投递计数');
  assert.deepEqual(sent, ['one', 'two'], '本轮岗位去重保留，不能重复发送');
  assert.deepEqual(loaded, ['one', 'one', 'two'], '直接本地通过的岗位在休息后也必须重读详情');
  assert.ok(listOpens >= 2);
  assert.equal(service.getStats().totalScanned, 2);
  loaded.length = 0; sent.length = 0; rested = false; restAfter = 2; listOpens = 0;
  let aiCalls = 0;
  stub(llmService, 'chatJson', async (messages: any[], _retries: number, options: any) => {
    aiCalls++; options.onRequest();
    const jobs = JSON.parse(messages[1].content.split('【待评估岗位列表（逐个评估）】：\n')[1]);
    return { jobs: jobs.map((job: any) => ({ jobKey: job.jobKey, score: 90, passed: true, customGreeting: '您好' })) };
  });
  resetOfflineCandidates();
  const batchService = new DeliveryService(rest);
  await batchService.startDelivery({ targetRole: '客服', keywords: ['客服'], resumeText: '虚构离线简历：熟悉客服订单整理。', candidateSource: 'resume' });
  assert.equal(batchService.getStats().status, 'finished');
  assert.equal(aiCalls, 1, '休息不能丢失已收集的 AI 批次或重复请求');
  assert.deepEqual(sent, ['one', 'two']);
  assert.deepEqual(loaded, ['one', 'two', 'one', 'two'], 'AI 候选跨休息后重新核对全部详情');
  assert.equal(batchService.getStats().todayAppliedCount, 5);

  loaded.length = 0; sent.length = 0; rested = false; restAfter = 1;
  config.filter.companyBlacklist = ['示例电商'];
  let feedbacks = 0;
  stub(bossPageService, 'markJobNotSuit', async (locator: any) => {
    assert.equal(locator.generation, generation, '不合适也不能使用休息前的页面句柄');
    feedbacks++; return true;
  });
  resetOfflineCandidates();
  const excluded = new DeliveryService(rest);
  await excluded.startDelivery({ targetRole: '客服', keywords: ['客服'], resumeText: '仅本地排除测试。', candidateSource: 'requirements', rulesOnly: true });
  assert.equal(excluded.getStats().status, 'finished');
  assert.equal(feedbacks, 2);
  assert.deepEqual(sent, []);
  assert.equal(aiCalls, 1, '明确排除不再请求 AI');
  console.log('PASS | 本地通过/AI批次/排除反馈跨休息、重读新详情和按钮、旧卡片失效、批次去重与今日配额保留');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => restores.reverse().forEach(restore => restore()));