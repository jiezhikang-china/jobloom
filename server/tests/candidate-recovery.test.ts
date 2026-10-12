import './fixtures/activate-isolated-safety.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CandidateLedger, candidateLedger, candidateFingerprint } from '../src/services/candidate-ledger.js';
import { bossJobId, sameJobLink, canonicalBossJobHref } from '../src/services/job-identity.js';
import { CareerStore } from '../src/services/career-store.js';
import { configManager } from '../src/config/config.manager.js';
import { filterService } from '../src/services/filter.service.js';
import { assessWorkRequirements, normalizeWorkRequirements, summarizeWorkRequirements } from '../src/services/work-requirements.js';
import { DeliveryService } from '../src/services/delivery.service.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';
import { bossPageService } from '../src/services/boss.page.service.js';
import { bossActionScheduler } from '../src/services/boss-action-scheduler.js';
import { browserService } from '../src/services/browser.service.js';
import { llmService } from '../src/services/llm.service.js';
import { notSuitableStore } from '../src/services/not-suitable-store.js';
import type { BossJobItem } from '../src/types.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobloom-candidates-'));
const restores: Array<() => void> = [];
const stub = (obj: any, key: string, value: any) => { const original = obj[key]; obj[key] = value; restores.push(() => obj[key] = original); };
const target = { jobHref: 'https://www.zhipin.com/job_detail/835facaae34d2d7933F73Ny6E1E~.html', jobName: '行政支持', companyName: '虚构公司', salary: '5-6K' };
const job: BossJobItem = { securityId: '', jobId: 'fixture', lid: '', jobName: target.jobName, brandName: target.companyName, salaryDesc: target.salary,
  jobDegree: '大专', jobExperience: '经验不限', cityName: '上海', brandIndustry: '企业服务', activeTimeDesc: '今日活跃', areaDistrict: '',
  brandScaleName: '', bossName: '', bossTitle: '', skills: [], welfareList: [] };
const description = '负责办公室文书整理及员工行政支持。';
async function main() {
  assert.equal(bossJobId(target.jobHref), '835facaae34d2d7933F73Ny6E1E~', '真实 BOSS 编号中的波浪号是身份的一部分');
  assert.equal(sameJobLink(target.jobHref + '?ka=search#detail', target.jobHref), true);
  assert.equal(sameJobLink(target.jobHref.replace('~', ''), target.jobHref), false, '不得删除波浪号来伪造另一个编号');
  for (const href of ['https://example.com/job_detail/a~.html', 'http://www.zhipin.com/job_detail/a~.html',
    'https://user:password@www.zhipin.com/job_detail/a~.html', '/web/geek/jobs', '/job_detail/a%2Fb.html']) {
    assert.throws(() => canonicalBossJobHref(href), /有效/); assert.equal(bossJobId(href), '');
  }
  const file = path.join(dir, 'ledger.json');
  let ledger = new CandidateLedger(file);
  ledger.discover({ ...target, cardLocator: { circular: () => {}, page: Promise.resolve() } } as any, 'context', 'rules', '来源甲');
  assert.equal('cardLocator' in ledger.get(target.jobHref)!, false, '持久化不携带 DOM 句柄或连接'); ledger.discover(target, 'context', 'rules', '来源乙');
  assert.equal(ledger.summary().unique, 1);
  ledger.transition(target.jobHref, 'evaluation_retry', '网络失败', { job, description });
  ledger = new CandidateLedger(file);
  assert.equal(ledger.recoverable('context', 'rules', '来源甲').length, 1, '重启恢复未完成岗位');
  assert.equal(ledger.recoverable('different-person', 'rules', '来源甲').length, 0, '不混用其他求职资料');
  const result = { passed: true, score: 90, reason: '相符', customGreeting: '您好', evaluationSource: 'ai' as const };
  ledger.saveEvaluation(target.jobHref, result, { job, description });
  ledger = new CandidateLedger(file);
  assert.equal(ledger.cachedEvaluation(target.jobHref, { job, description })?.passed, true, '有效评估跨重启复用');
  assert.equal(ledger.cachedEvaluation(target.jobHref, { job, description: description + '必须持有执照' }), undefined, '事实变化必须重新评估');
  const changedRules = new CandidateLedger(null);
  changedRules.discover(target, 'ctx', 'old', 'source');
  changedRules.saveEvaluation(target.jobHref, result, { job, description });
  changedRules.recoverable('ctx', 'new', 'source');
  assert.equal(changedRules.cachedEvaluation(target.jobHref, { job, description }), undefined, '规则变化不得复用旧通过结论');
  ledger.transition(target.jobHref, 'sending', '提交中');
  ledger.discover(target, 'context2', 'rules2', '来源甲');
  assert.equal(ledger.shouldProcess(ledger.get(target.jobHref)!), false, '发送中断不可自动重投');
  assert.equal(new CandidateLedger(file).summary().uncertain, 1);
  ledger.transition(target.jobHref, 'send_unknown', '无回执');
  assert.equal(ledger.recoverable('context', 'rules', '来源甲').length, 0);
  ledger.transition(target.jobHref, 'read_retry', '用户核实未发出');
  assert.equal(ledger.recoverable('context', 'new-rules', '来源甲').length, 1, '规则变化能恢复不在列表中的原链接');
  ledger.transition(target.jobHref, 'sent', '已确认');
  assert.equal(ledger.summary().sent, 1);
  assert.equal(ledger.shouldProcess(ledger.discover(target, 'new-context', 'new-rules', '来源甲')), false);
  const corrupt = path.join(dir, 'corrupt.json'); fs.writeFileSync(corrupt, '{bad');
  const broken = new CandidateLedger(corrupt);
  assert.throws(() => broken.discover(target, 'a', 'b', 'c')); assert.equal(fs.readFileSync(corrupt, 'utf8'), '{bad');
  const migration = new CandidateLedger(null);
  const legacy = { ...target, id: 'legacy', updatedAt: new Date().toISOString(), reason: '列表变化', question: '',
    requirements: [], assessment: [], screening: { industry: '', jobDetail: '', skills: [], needsDetailConfirmation: true } };
  assert.deepEqual(migration.migrateTechnical([legacy], 'current', 'current-rules', '当前目标'), ['legacy']);
  assert.deepEqual(migration.get(target.jobHref)?.legacyReview, legacy);
  assert.equal(migration.summary().decisions, 0);
  const oldDecision = { ...legacy, id: 'old-condition', jobHref: 'https://www.zhipin.com/job_detail/changed-condition.html',
    screening: undefined, requirements: [{ id: 'rest', text: '每周双休', enabled: true }], assessment: [] };
  assert.deepEqual(migration.migrateTechnical([oldDecision], 'current', 'current-rules', '当前目标', []), ['old-condition'], '条件改变后的旧人工记录由系统重新评估');
  assert.equal(migration.get(oldDecision.jobHref)?.legacyReview?.id, 'old-condition');

  const filter = { ...configManager.getConfig().filter, salaryMin: 0, salaryMax: 0, cityName: '', experience: [], degree: [], candidateLanguages: '',
    companyBlacklist: [], requiredKeywords: [], commute: {}, skipMissingCompanyIntro: false, skipVagueJobDescription: false };
  const required = normalizeWorkRequirements([{ id: 'hours', text: '每天工作不超过八小时', builtin: 'eightHours', enabled: true }]);
  assert.equal(required[0].policy, 'required', '旧条件不被静默放宽');
  assert.equal(summarizeWorkRequirements(assessWorkRequirements(job, description, required), required).missing.length, 1);
  const ask = required.map(r => ({ ...r, policy: 'ask' as const }));
  const preference = required.map(r => ({ ...r, policy: 'preference' as const }));
  assert.equal(filterService.evaluateLocally(job, description, true, { ...filter, workRequirements: required })?.needsReview, true);
  assert.equal(filterService.evaluateLocally(job, description, true, { ...filter, workRequirements: ask })?.passed, true);
  assert.equal(filterService.evaluateLocally(job, description + '每天工作9小时。', true, { ...filter, workRequirements: ask })?.passed, false);
  assert.equal(filterService.evaluateLocally(job, description + '每天工作9小时。', true, { ...filter, workRequirements: preference })?.passed, true);
  assert.equal(candidateFingerprint({ role: 'a' }) === candidateFingerprint({ role: 'b' }), false);
  assert.equal(candidateFingerprint({ a: 1, b: 2 }), candidateFingerprint({ b: 2, a: 1 }), '字段顺序不造成无意义重新评估');

  const careerFile = path.join(dir, 'career.json'); let career = new CareerStore(careerFile);
  career.ensure(target); career.ensure(target); assert.equal(career.snapshot().entries.length, 1);
  const id = career.snapshot().entries[0].id;
  career.recordResume({ id: 'resume_abc-123.pdf', fileName: '原始简历.pdf', format: 'pdf' });
  career.update(id, { stage: 'interview', interviewAt: '2026-12-01T14:00:00+08:00', interviewPlace: '视频面试', resumeVersionId: 'resume_abc-123.pdf' });
  career.update(id, { stage: 'offer', offerSalary: '6K·13薪', offerHours: '8小时', offerRest: '双休' });
  career = new CareerStore(careerFile);
  assert.equal(career.snapshot().entries[0].stage, 'offer'); assert.equal(career.snapshot().entries[0].history.length, 3);
  assert.throws(() => career.update(id, { stage: 'fake' as any }));
  assert.throws(() => career.update(id, { resumeVersionId: '../private' }));
  assert.throws(() => career.update(id, { interviewAt: 'not-a-date' }));

  let runtime = new CandidateLedger(path.join(dir, 'runtime.json'));
  for (const key of ['list', 'get', 'discover', 'transition', 'shouldProcess', 'recoverable', 'migrateTechnical', 'sourceMetrics', 'summary', 'saveEvaluation', 'cachedEvaluation'] as const)
    stub(candidateLedger, key, (...args: any[]) => (runtime[key] as any)(...args));
  const config = { ...configManager.getConfig(), filter: { ...filter, workRequirements: [] }, delivery: { ...configManager.getConfig().delivery, dailyMaxQuota: 1, jobSource: 'search' as const } };
  stub(configManager, 'getConfig', () => config);
  stub(stateManager, 'loadQuota', () => ({ date: todayStr(), count: 0 })); stub(stateManager, 'saveQuota', () => {});
  stub(browserService, 'closeAfterTask', async () => false);
  stub(bossActionScheduler, 'waitSeconds', () => 0); stub(bossActionScheduler, 'isBusinessRestImminent', () => false);
  stub(notSuitableStore, 'matches', () => false);
  stub(bossPageService, 'initJobPage', async () => {});
  let visible = true, live = '', sent = 0, ai = 0, standalone = 0, failAi = false, uncertain = false;
  const card = { ...target, cityName: '上海', degree: '大专', experience: '经验不限', skills: [], activeTimeDesc: '今日活跃', index: 0, cardLocator: { key: 'fixture' } as any };
  const detail = () => ({ jobDetailText: description, activeTimeDesc: job.activeTimeDesc, brandIndustry: job.brandIndustry,
    alreadyChatted: false, chatButtonLocator: { key: 'fixture' } as any, detailData: { ...target, degree: '大专', experience: '经验不限', cityName: '上海', skills: [] } });
  stub(bossPageService, 'getVisibleJobCards', async () => visible ? [card] : []);
  stub(bossPageService, 'isCardStillTarget', async () => true);
  stub(bossPageService, 'isDetailStillTarget', async () => live === target.jobHref);
  stub(bossPageService, 'isJobListPage', async () => true);
  stub(bossPageService, 'scrollDownForMore', async () => {});
  stub(bossPageService, 'loadJobDetail', async () => { live = target.jobHref; return detail(); });
  stub(bossPageService, 'loadCandidateJob', async (value: any) => { assert.equal(value.jobHref, target.jobHref); standalone++; live = target.jobHref; return detail(); });
  stub(bossPageService, 'executeChatClick', async (_button: any, _text: string, value: any) => { assert.equal(value.jobHref, live); sent++; return uncertain ? { uncertain: true } : { success: true }; });
  stub(llmService, 'chatJson', async (_messages: any, _retries: any, options: any) => {
    ai++; options.onRequest?.(); visible = false;
    if (failAi) throw new Error('虚构服务繁忙');
    return { jobs: [{ jobKey: 'job-0', score: 90, passed: true, reason: '符合职责', customGreeting: '您好' }] };
  });
  const params = { targetRole: '行政支持', keywords: ['行政'], resumeText: '虚构求职经历行政支持。'.repeat(8) };
  const create = () => { const service = new DeliveryService({ runIfDue: async () => false }); (service as any).sleepInterruptible = async () => true; return service; };
  await create().startDelivery(params);
  assert.equal(sent, 1); assert.equal(standalone, 1, '列表消失按原链接恢复并投递'); assert.equal(runtime.summary().sent, 1);
  visible = true; await create().startDelivery(params); assert.equal(sent, 1, '跨批次不得重复投递已确认岗位');

  runtime = new CandidateLedger(path.join(dir, 'retry-runtime.json')); visible = true; failAi = true; sent = 0; ai = 0;
  await create().startDelivery({ ...params, resumeText: params.resumeText + '网络恢复' });
  assert.equal(ai, 3); assert.equal(runtime.summary().recovery, 1); assert.equal(sent, 0);
  runtime = new CandidateLedger(path.join(dir, 'retry-runtime.json'));
  runtime.transition(target.jobHref, 'evaluation_retry', '已达到下次重试时间');
  failAi = false;
  await create().startDelivery({ ...params, resumeText: params.resumeText + '网络恢复' });
  assert.equal(sent, 1, '重启后无列表仍恢复持久化岗位'); assert.equal(runtime.summary().sent, 1);

  runtime = new CandidateLedger(path.join(dir, 'uncertain-runtime.json')); visible = true; uncertain = true; sent = 0;
  await create().startDelivery({ ...params, resumeText: params.resumeText + '不确定结果' });
  assert.equal(runtime.summary().uncertain, 1);
  visible = true; await create().startDelivery({ ...params, resumeText: params.resumeText + '不确定结果' }); assert.equal(sent, 1, '发送无回执也不盲目重投');
  runtime = new CandidateLedger(path.join(dir, 'sources-runtime.json')); visible = true; uncertain = false; sent = 0; ai = 0;
  config.filter.salaryMin = 3;
  let source = '', lowReads = 0;
  const low = Array.from({ length: 40 }, (_, index) => ({ ...card, jobHref: 'https://www.zhipin.com/job_detail/low' + index + '.html',
    salary: '1-2K', companyName: '低薪公司' + index, cardLocator: { key: index } as any }));
  stub(bossPageService, 'initJobPage', async (keyword: string) => { source = keyword; });
  stub(bossPageService, 'getVisibleJobCards', async () => !visible ? [] : source === '低命中' ? low : [card]);
  stub(bossPageService, 'loadJobDetail', async (_locator: any, _name: string, _company: string, href: string) => {
    live = href;
    const current = low.find(c => c.jobHref === href);
    if (current) { lowReads++; return { ...detail(), detailData: { ...current }, chatButtonLocator: { key: 'fixture' } }; }
    return detail();
  });
  await create().startDelivery({ ...params, keywords: ['低命中', '高命中'], resumeText: params.resumeText + '来源轮转' });
  assert.equal(sent, 1);
  assert.ok(lowReads > 0 && lowReads < low.length, '低命中来源未耗尽就轮转到其他来源');
  const metrics = runtime.sourceMetrics(candidateFingerprint({ text: params.resumeText + '来源轮转', source: undefined, role: params.targetRole,
    keywords: ['低命中', '高命中'], positions: undefined, rulesOnly: undefined }), ['低命中', '高命中']);
  assert.equal(metrics[1].sent, 1); assert.ok(metrics[1].yield > metrics[0].yield);
  runtime = new CandidateLedger(path.join(dir, 'backlog.json')); visible = false; sent = 0; config.delivery.dailyMaxQuota = 18;
  const backlogParams = { ...params, resumeText: params.resumeText + '大批历史候选恢复' };
  const backlogContext = candidateFingerprint({ text: backlogParams.resumeText, source: undefined, role: backlogParams.targetRole,
    keywords: backlogParams.keywords, positions: undefined, rulesOnly: undefined });
  const backlogRules = candidateFingerprint({ filter: config.filter, policy: 2 });
  for (let i = 0; i < 18; i++) runtime.discover({ ...target, jobHref: 'https://www.zhipin.com/job_detail/backlog' + i + '.html' }, backlogContext, backlogRules, '行政');
  stub(bossPageService, 'loadCandidateJob', async (saved: any) => { live = saved.jobHref; return { ...detail(), detailData: { ...detail().detailData!, jobHref: saved.jobHref } }; });
  stub(bossPageService, 'isDetailStillTarget', async (_name: string, _company: string, href: string) => live === href);
  stub(llmService, 'chatJson', async (messages: any[], _retry: any, options: any) => {
    options.onRequest?.();
    const jobs = JSON.parse(messages[1].content.split('【待评估岗位列表（逐个评估）】：\n')[1]);
    return { jobs: jobs.map((j: any) => ({ jobKey: j.jobKey, score: 90, passed: true, reason: '职责匹配', customGreeting: '您好' })) };
  });
  await create().startDelivery(backlogParams);
  assert.equal(sent, 18, '恢复台账多于一轮预算也应续接，不依赖列表里出现新卡片');
  assert.equal(runtime.summary().recovery, 0);
  console.log('PASS | persistent candidates, URL recovery, interrupted AI restart, no duplicate send, rules migration, condition tiers, durable interview/offer/resume records');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  restores.reverse().forEach(fn => fn());
  if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('fixture cleanup outside temp');
  fs.rmSync(dir, { recursive: true, force: true });
});
