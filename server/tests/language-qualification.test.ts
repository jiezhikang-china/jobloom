import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { languageQualificationIssue, candidateLanguageEvidence } from '../src/services/language-qualification.js';
import { FilterService } from '../src/services/filter.service.js';
import { configManager } from '../src/config/config.manager.js';
import { llmService } from '../src/services/llm.service.js';
import { WorkConditionReviews } from '../src/services/work-condition-reviews.js';
import type { BossJobItem, WorkConditionReview } from '../src/types.js';

const job: BossJobItem = { securityId: '', jobId: '', lid: '', jobName: '数据标注', brandName: '模拟公司',
  salaryDesc: '6-8K', jobExperience: '经验不限', jobDegree: '大专', cityName: '上海', areaDistrict: '',
  brandScaleName: '', brandIndustry: '企业服务', bossName: '', bossTitle: '', activeTimeDesc: '今日活跃', skills: [], welfareList: [] };
const detail = '负责语音转写与标注。熟练掌握哥斯达黎加本土西班⽛语（核心要求）。能听懂哥斯达黎加当地口音。入职培训。';
const cases: Array<[string, string, string, boolean]> = [
  ['核心西语', detail, '', false],
  ['英语不能替代西语', detail, '英语口语流利', false],
  ['泛西语不能替代本地口音', detail, '西班牙语精通', false],
  ['C1及明确口音', detail, '西班牙语 C1，能听懂哥斯达黎加口音', true],
  ['口音否定不能当会', detail, '西班牙语精通，不熟悉哥斯达黎加口音', false],
  ['培训不能补齐核心门槛', '必须掌握西班牙语，入职提供岗前培训。', '', false],
  ['优先', '英语熟练者优先。', '', true],
  ['可从零培训', '英语可从零学习，提供培训。', '', true],
  ['明确不要求', '不要求会英语。', '', true],
  ['某语言不限', '日语水平不限。', '', true],
  ['CET4合格', '要求英语四级。', '大学英语四级', true],
  ['CET6包含CET4', '要求英语四级。', '英语CET6', true],
  ['CET4不能替代CET6', '必须通过英语六级。', '英语CET4', false],
  ['CET6不能证明口语流利', '必须英语口语流利。', '英语CET6', false],
  ['明确口语能力', '必须英语口语流利。', '英语口语流利', true],
  ['日语N1覆盖N2', '必须日语 N2。', '日语 N1', true],
  ['日语N3不能替代N2', '必须日语 N2。', '日语 N3', false],
  ['日语中文级别', '必须日语二级。', '日语一级', true],
  ['CEFR门槛', '西班牙语要求 C1。', '西班牙语 B2', false],
  ['雅思分数', '要求英语雅思7分。', '英语雅思6.5分', false],
  ['雅思口语不能用总分替代', '要求雅思口语7分。', '雅思总分7.5分', false],
  ['雅思对应分数', '要求雅思口语7分。', '雅思口语7.5分', true],
  ['专业八级', '必须英语专业八级。', '英语CET6', false],
  ['专业八级达标', '必须英语专业八级。', '英语专业八级', true],
  ['未来学习不是能力', '必须掌握西班牙语。', '希望学习西班牙语并达到熟练', false],
  ['普通英文界面不是语言岗', '熟练使用英文版 Word 录入中文订单。', '', true],
];

async function main() {
  for (const [name, jd, profile, expected] of cases) assert.equal(!languageQualificationIssue(job, jd, { candidateLanguages: profile }), expected, name);
  const resumeContext = { text: '语言能力：西班牙语 C1，能听懂哥斯达黎加口音', source: 'resume' as const };
  assert.equal(languageQualificationIssue(job, detail, {}, resumeContext), undefined);
  assert.equal(languageQualificationIssue(job, '必须掌握西班牙语。', {}, { text: '希望找熟练西班牙语的岗位。', source: 'requirements' }),
    languageQualificationIssue(job, '必须掌握西班牙语。', {}), '求职愿望不能当语言能力');
  assert.equal(languageQualificationIssue(job, '必须掌握西班牙语。', {}, { text: '我熟练掌握西班牙语。', source: 'requirements' }), undefined);
  const evidence = candidateLanguageEvidence('', resumeContext);
  assert.match(evidence, /哥斯达黎加口音/);
  assert.equal(languageQualificationIssue({ ...job, jobName: '英语客服' }, '英语不要求，可培训。', {}), undefined);
  assert.equal(languageQualificationIssue({ ...job, jobName: '日语标注' }, '', {}), undefined, '标题缺少限定信息时先读全文');
  assert.ok(languageQualificationIssue({ ...job, jobName: '日语标注' }, '负责文字内容核对与录入。', {}));

  const original = configManager.getConfig(); const get = configManager.getConfig; const chat = llmService.chatJson;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-language-'));
  let calls = 0;
  const config = { ...original, filter: { ...original.filter, candidateLanguages: '', companyBlacklist: [], requiredKeywords: [],
    skipMissingCompanyIntro: false, skipVagueJobDescription: false,
    workRequirements: [{ id: 'hours', text: '每天工作不超过八小时', enabled: true }] } };
  configManager.getConfig = () => config;
  try {
    llmService.chatJson = (async () => { calls++; throw new Error('硬语言门槛不能请求AI'); }) as typeof chat;
    const service = new FilterService();
    const rejected = await service.evaluateStage2(job, detail, '希望八小时双休无经验工作。', '数据标注', 'requirements');
    assert.equal(rejected.evaluationSource, 'rules'); assert.equal(rejected.needsReview, undefined); assert.equal(calls, 0);
    assert.match(rejected.reason, /语言硬要求/);
    assert.equal(service.evaluateStage1(job, detail).passed, false);

    llmService.chatJson = (async () => { calls++; return { jobs: [{ jobKey: 'job-0', score: 5, passed: false,
      qualificationFailures: [{ evidence: '必须持有初级会计证书', reason: '未提供所需会计证书' }] }] }; }) as typeof chat;
    const qualification = await service.evaluateStage2(job, '负责财务资料整理。必须持有初级会计证书。作息面议。', '普通行政经历。', '资料整理');
    assert.equal(qualification.needsReview, undefined, '明确资格失败优先于工时待确认'); assert.match(qualification.reason, /必备资格/);
    const fabricated = await service.evaluateStage2(job, '负责行政资料整理。作息面议。', '普通行政经历。', '资料整理');
    assert.equal(fabricated.needsReview, true, '无原文的资格失败不能当硬淘汰');

    const file = path.join(directory, 'reviews.json'); const store = new WorkConditionReviews(file);
    const input: Omit<WorkConditionReview, 'id' | 'question' | 'updatedAt'> = {
      jobHref: '/job_detail/language-fixture.html', jobName: '数据标注', companyName: '模拟公司', salary: '6-8K', reason: '工时待确认',
      requirements: config.filter.workRequirements, assessment: [{ requirementId: 'hours', text: '每天工作不超过八小时', status: 'unknown', evidence: '' }],
      screening: { industry: '企业服务', jobDetail: detail, skills: [] },
    };
    config.filter.candidateLanguages = '西班牙语 C1，能听懂哥斯达黎加口音';
    store.add(input); const previous = fs.readFileSync(file, 'utf8');
    config.filter.candidateLanguages = '';
    assert.equal(store.listEligible().length, 0); const pruned = store.pruneExcluded(); assert.equal(pruned.removed, 1);
    assert.equal(fs.readFileSync(pruned.backup!, 'utf8'), previous);
    assert.throws(() => store.add(input), /语言硬要求/);
    store.add({ ...input, screening: { ...input.screening!, languageEvidence: evidence } });
    assert.equal(store.listEligible().length, 1, '简历已证明的语言和口音必须随待确认记录保留');
    console.log('PASS | ' + cases.length + ' 项语言/等级/口音/偏好判断、零AI硬淘汰、资格优先、引用防伪、旧待确认备份清理与简历依据');
  } finally {
    configManager.getConfig = get; llmService.chatJson = chat;
    assert.equal(path.dirname(path.resolve(directory)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(directory).startsWith('boss-language-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
