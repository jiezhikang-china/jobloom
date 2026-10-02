import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { hasClearJobDuties, hasCompanyIntroduction, jobInformationIssue } from '../src/services/job-information.js';
import { FilterService } from '../src/services/filter.service.js';
import { llmService } from '../src/services/llm.service.js';
import type { BossCompanyInfo, BossJobItem } from '../src/types.js';

const original = configManager.getConfig();
const filter = { ...original.filter, skipMissingCompanyIntro: true, skipVagueJobDescription: true,
  companyBlacklist: [], requiredKeywords: [], degree: [], experience: [], salaryMin: 0, salaryMax: 0,
  hrActiveDaysLimit: 0, workRequirements: [] };
const company: BossCompanyInfo = { name: '示例公司', industry: '企业服务', introduction: '', businessScope: '信息咨询服务。',
  url: 'https://www.zhipin.com/gongsi/example.html', checkedAt: new Date().toISOString() };
const job: BossJobItem = { securityId: '', jobId: '', jobName: '客服', lid: '', salaryDesc: '6-8K', jobExperience: '1-3年',
  jobDegree: '大专', cityName: '上海', areaDistrict: '', brandName: company.name, brandScaleName: '', brandIndustry: company.industry,
  bossName: '', bossTitle: '', activeTimeDesc: '今日活跃', skills: [], welfareList: [], companyInfo: company };

async function main() {
  for (const text of ['', '工作简单，待遇优厚，欢迎咨询。', '负责日常工作，服从领导安排，完成其他相关任务。',
    '八小时双休，学历不限，沟通能力强，福利齐全，具体工作内容面议。', '岗位要求：熟悉软件开发流程，具有客户服务意识。']) {
    assert.equal(hasClearJobDuties(text), false, text);
  }
  for (const text of ['回复网店买家咨询。', '整理仓库货物。', '负责办公室行政支持。',
    '任职要求：学历大专，经验不限。\n工作内容：录入订单信息，核对客户地址。',
    '工作职责：接听来电，处理售后退款申请。', 'Maintain customer records and handle customer enquiries.']) {
    assert.equal(hasClearJobDuties(text), true, text);
  }
  assert.equal(hasCompanyIntroduction(company), false, '工商经营范围不能替代公司简介');
  assert.equal(hasCompanyIntroduction({ ...company, introduction: '暂无公司介绍' }), false);
  assert.equal(hasCompanyIntroduction({ ...company, introduction: '暂未填写' }), false);
  assert.equal(hasCompanyIntroduction({ ...company, introduction: '经营电商客户服务。' }), true);
  assert.equal(jobInformationIssue({ jobDetail: '回复网店买家咨询。' }, filter), undefined, '未核查公司页不声称没有简介');
  assert.match(jobInformationIssue({ jobDetail: '回复网店买家咨询。', companyInfo: company }, filter)!, /公司介绍/);
  assert.equal(jobInformationIssue({ jobDetail: '', companyInfo: company }, { ...filter,
    skipVagueJobDescription: false, skipMissingCompanyIntro: false }), undefined, '用户可以关闭新规则');
  const getConfig = configManager.getConfig;
  const chat = llmService.chatJson;
  let requests = 0;
  try {
    configManager.getConfig = () => ({ ...original, filter });
    llmService.chatJson = (async () => { requests++; throw new Error('信息缺失无需询问 AI'); }) as typeof chat;
    const service = new FilterService();
    assert.equal(service.evaluateStage1({ ...job, companyInfo: undefined }).passed, true, '卡片阶段不把尚未打开的职责当作缺失');
    assert.equal(service.evaluateStage1(job, '回复网店买家咨询。').passed, false);
    for (const [candidate, description] of [[job, '回复网店买家咨询。'], [{ ...job, companyInfo: undefined }, '工作内容面议。']] as const) {
      const result = await service.evaluateStage2(candidate, description, '希望找到客服工作，双休。', '客服', 'requirements');
      assert.equal(result.passed, false);
      assert.equal(result.evaluationSource, 'rules');
      assert.equal(result.needsReview, undefined);
    }
    assert.equal(requests, 0, '没有公司介绍或职责模糊都在 AI 之前淘汰');
    console.log('PASS | 缺失公司简介、模糊职责、短但明确的职责、章节顺序、规则开关和零 AI 淘汰');
  } finally { configManager.getConfig = getConfig; llmService.chatJson = chat; }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
