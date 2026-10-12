import './fixtures/activate-isolated-safety.js';
import assert from 'node:assert/strict';
import { CandidateLedger, candidateLedger, candidateFingerprint } from '../src/services/candidate-ledger.js';
import { DeliveryService } from '../src/services/delivery.service.js';
import { configManager } from '../src/config/config.manager.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';
import { bossPageService } from '../src/services/boss.page.service.js';
import { browserService } from '../src/services/browser.service.js';
import { bossActionScheduler } from '../src/services/boss-action-scheduler.js';
import { notSuitableStore } from '../src/services/not-suitable-store.js';
import { FilterService } from '../src/services/filter.service.js';
import { llmService } from '../src/services/llm.service.js';
const restores: Array<() => void> = [];
const stub = (object: any, key: string, value: any) => { const original = object[key]; object[key] = value; restores.push(() => object[key] = original); };
async function main() {
  const ledger = new CandidateLedger(null);
  for (const key of ['list', 'get', 'discover', 'transition', 'shouldProcess', 'recoverable', 'migrateTechnical', 'sourceMetrics', 'summary', 'saveEvaluation', 'cachedEvaluation'] as const)
    stub(candidateLedger, key, (...args: any[]) => (ledger[key] as any)(...args));
  const cfg = configManager.getConfig();
  const config = { ...cfg, filter: { ...cfg.filter, cityName: '', salaryMin: 10, salaryMax: 0, degree: [], experience: [],
    hrActiveDaysLimit: 0, companyBlacklist: ['金融'], requiredKeywords: [], workRequirements: [], commute: {},
    skipMissingCompanyIntro: false, skipVagueJobDescription: false }, delivery: { ...cfg.delivery, jobSource: 'search' as const, dailyMaxQuota: 5 } };
  stub(configManager, 'getConfig', () => config);
  stub(stateManager, 'loadQuota', () => ({ date: todayStr(), count: 0 })); stub(stateManager, 'saveQuota', () => {});
  stub(browserService, 'closeAfterTask', async () => false);
  stub(bossActionScheduler, 'waitSeconds', () => 0); stub(bossActionScheduler, 'isBusinessRestImminent', () => false);
  stub(notSuitableStore, 'matches', () => false);
  stub(bossPageService, 'initJobPage', async () => {});
  stub(bossPageService, 'getVisibleJobCards', async () => []);
  stub(bossPageService, 'scrollDownForMore', async () => {});
  stub(bossPageService, 'isJobListPage', async () => true);
  stub(bossPageService, 'isDetailStillTarget', async () => true);
  let sent = 0, feedback = 0, ai = 0;
  stub(bossPageService, 'executeChatClick', async () => { sent++; throw new Error('本测试不得点击沟通'); });
  stub(bossPageService, 'markJobNotSuit', async () => { feedback++; throw new Error('本测试不得提交反馈'); });
  const params = { targetRole: '行政支持', keywords: ['行政'], resumeText: '虚构求职者行政支持经历。'.repeat(10) };
  const context = candidateFingerprint({ text: params.resumeText, source: undefined, role: params.targetRole, keywords: params.keywords, positions: undefined, rulesOnly: undefined, positionCode: undefined });
  const rules = candidateFingerprint({ filter: config.filter, policy: 2 });
  const href = (id: string) => 'https://www.zhipin.com/job_detail/' + id + '~.html';
  for (const id of ['low', 'finance', 'qualified', 'read-error'])
    ledger.discover({ jobHref: href(id), jobName: '行政支持', companyName: '虚构软件公司', salary: '20-25K' }, context, rules, '行政');
  const reads: Record<string, number> = {};
  stub(bossPageService, 'loadCandidateJob', async (saved: any) => {
    const id = saved.jobHref.match(/\/([^/]+)~\.html$/)![1]; reads[id] = (reads[id] || 0) + 1;
    if (id === 'read-error') throw new Error('虚构页面读取失败');
    return { jobDetailText: '负责行政文档整理、办公用品登记及日常行政支持工作。', activeTimeDesc: '今日活跃',
      brandIndustry: id === 'finance' ? '金融' : '软件开发', alreadyChatted: false, chatButtonLocator: null,
      companyInfo: { name: '虚构软件公司', industry: id === 'finance' ? '金融' : '软件开发', introduction: id === 'finance' ? '公司主营金融信贷服务。' : '公司主营企业软件开发及技术服务。',
        businessScope: '', url: 'https://www.zhipin.com/gongsi/fixture.html', checkedAt: new Date().toISOString() },
      detailData: { jobHref: saved.jobHref, jobName: saved.jobName, companyName: saved.companyName, salary: id === 'low' ? '5-6K' : '20-25K',
        degree: '大专', experience: '经验不限', cityName: '上海', skills: [] } };
  });
  stub(llmService, 'chatJson', async (_messages: any, _retry: any, options: any) => {
    options.onRequest?.(); ai++;
    return { jobs: [{ jobKey: 'job-0', score: 90, passed: true, reason: '符合行政支持职责', customGreeting: '您好' }] };
  });
  const service = new DeliveryService({ runIfDue: async () => false }); (service as any).sleepInterruptible = async () => true;
  await service.startDelivery(params);
  assert.equal(ledger.get(href('low'))?.status, 'rejected', '没有按钮也必须执行低薪筛除');
  assert.match(ledger.get(href('low'))!.reason, /薪资/);
  assert.equal(ledger.get(href('finance'))?.status, 'rejected', '没有按钮也必须执行排除行业筛选');
  assert.equal(ledger.get(href('qualified'))?.status, 'read_retry', '合格但缺按钮的岗位保留，不尝试发送');
  assert.equal(ai, 1, '需要目标适配的合格岗位确实进入AI，硬筛失败不消耗AI');
  assert.equal(reads['read-error'], 1, '读取失败不能在同一任务的8轮中反复恢复');
  assert.equal(reads.low, 1); assert.equal(reads.finance, 1);
  assert.equal(service.getStats().passedFilterCount, 1, '筛选通过计数不应与按钮可用性混为一谈');
  assert.equal(service.getStats().totalScanned, 4, '恢复浏览也按去重岗位计数');
  assert.ok(service.getLogs().some(l => /候选恢复失败.*虚构页面读取失败/.test(l.message)), '恢复错误必须出现在运行记录');
  assert.equal(sent, 0); assert.equal(feedback, 0);
  (config.filter as any).workRequirements = [{ id: 'hours', text: '每天工作不超过八小时', builtin: 'eightHours', enabled: true, policy: 'required' }];
  const evaluationJob: any = { jobName: '配送员', brandName: '虚构公司', brandIndustry: '软件开发', skills: [], jobDegree: '大专', jobExperience: '经验不限',
    salaryDesc: '20-25K', cityName: '上海', welfareList: [], activeTimeDesc: '今日活跃' };
  let model: any = { score: 30, passed: false, missingEvidenceOnly: false, reason: '岗位负责配送，与行政支持目标职责不符',
    workRequirements: [{ requirementId: 'hours', status: 'unknown', evidence: '' }] };
  stub(llmService, 'chatJson', async () => ({ jobs: [{ jobKey: 'job-0', ...model }] }));
  const rejected = await new FilterService().evaluateStage2(evaluationJob, '负责物品配送，工时面议。', params.resumeText, '行政支持');
  assert.equal(rejected.passed, false); assert.notEqual(rejected.needsReview, true, 'AI已判不匹配的岗位不能被工时未知重新塞入人工池');
  model = { ...model, score: 90, passed: true, reason: '职责符合' };
  const uncertainHours = await new FilterService().evaluateStage2(evaluationJob, '负责行政文档整理，工时面议。', params.resumeText, '行政支持');
  assert.equal(uncertainHours.needsReview, true, '职责匹配也不能擅自放宽用户的必需工时条件');
  model = { ...model, score: 52, passed: false, missingEvidenceOnly: true, reason: '简历未提供文字作品证明' };
  (config.filter as any).workRequirements = [];
  const sparse = await new FilterService().evaluateStage2(evaluationJob, '负责行政文案撰写，具备表达意愿即可。', params.resumeText, '行政支持');
  assert.equal(sparse.passed, true, '保留简历没写证明不能直接淘汰的既有行为');
  console.log('PASS | recovery screens salary/exclusions before buttons, enters AI only when needed, records progress, bounds retries; no real requests or sends');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => restores.reverse().forEach(fn => fn()));
