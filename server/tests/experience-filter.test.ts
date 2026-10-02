import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { FilterService } from '../src/services/filter.service.js';
import { assessWorkConditions } from '../src/services/work-conditions.js';
import { llmService } from '../src/services/llm.service.js';
import type { BossJobItem, ConditionStatus } from '../src/types.js';

const original = configManager.getConfig();
const base: BossJobItem = { securityId: '', jobId: '', jobName: '行政助理', lid: '', salaryDesc: '6-8K',
  jobExperience: '1-3年', jobDegree: '大专', cityName: '上海', areaDistrict: '', brandName: '测试公司',
  brandScaleName: '', brandIndustry: '企业服务', bossName: '', bossTitle: '', activeTimeDesc: '今日活跃', skills: [], welfareList: [] };
const filter = { ...original.filter, experience: ['3-5年'], experienceMatchMode: 'flexible' as 'flexible' | 'strict',
  skipMissingCompanyIntro: false, skipVagueJobDescription: false,
  companyBlacklist: ['金融', '销售'], requiredKeywords: [], degree: ['本科'], salaryMin: 0, salaryMax: 0, hrActiveDaysLimit: 0,
  workRequirements: [{ id: 'experience', text: '允许无经验入职', enabled: true }] };
const cases: Array<[string, string, string, ConditionStatus]> = [
  ['标签不能单独淘汰', '', '1-3年', 'unknown'],
  ['更高标签同样只作参考', '负责资料整理。', '3-5年', 'unknown'],
  ['正文明确允许优先于标签', '无经验可入职。', '1-3年', 'met'],
  ['宽泛标签冲突不阻挡新人', '接受无经验，提供培训。', '5-10年', 'met'],
  ['经验优先不淘汰', '有相关经验者优先，提供岗前培训。', '1-3年', 'unknown'],
  ['一般经验年限留待确认', '一年以上相关工作经验。', '1-3年', 'unknown'],
  ['经验区间不是强制条件', '1—3年相关经验。', '1-3年', 'unknown'],
  ['明确强制经验仍排除', '必须具有三年以上相关经验。', '1-3年', 'not_met'],
  ['明确需要经验仍排除', '需要有相关工作经验。', '1-3年', 'not_met'],
  ['明确要求具备经验仍排除', '需具备相关工作经验。', '1-3年', 'not_met'],
  ['不接收新人仍排除', '无经验勿投。', '1-3年', 'not_met'],
  ['明确硬门槛覆盖宽泛标签', '必须有三年经验。', '经验不限', 'not_met'],
  ['正文自身冲突仍确认', '接受无经验，但必须有三年相关经验。', '1-3年', 'unknown'],
  ['正文明确不限仍通过', '经验不限，无需具备工作经验。', '1-3年', 'met'],
];

async function main() {
  const getConfig = configManager.getConfig;
  const chat = llmService.chatJson;
  let calls = 0;
  configManager.getConfig = () => ({ ...original, filter });
  llmService.chatJson = (async () => { calls++; throw new Error('经验本地判定不应调用 AI'); }) as typeof chat;
  try {
    for (const [name, detail, label, expected] of cases) {
      assert.equal(assessWorkConditions({ ...base, jobExperience: label }, detail,
        { eightHours: false, doubleRest: false, noExperience: true }).noExperience.status, expected, name);
    }
    const service = new FilterService();
    assert.equal(service.evaluateStage1(base).passed, true);
    filter.workRequirements = [];
    assert.equal(service.evaluateStage1(base).passed, true, '宽泛模式下，旧经验范围不能在卡片阶段过滤岗位');
    filter.experienceMatchMode = 'strict';
    assert.equal(service.evaluateStage1(base).passed, false, '明确选择严格模式时才使用经验范围');
    assert.equal(assessWorkConditions(base, '无经验可入职。', { eightHours: false, doubleRest: false, noExperience: true }, 'strict')
      .noExperience.status, 'unknown', '严格模式仍保留标签冲突检查');
    filter.experienceMatchMode = 'flexible';
    filter.workRequirements = [{ id: 'experience', text: '允许无经验入职', enabled: true }];
    const company = { url: 'https://www.zhipin.com/gongsi/example.html', name: base.brandName, industry: '商务服务',
      introduction: '公司主营助贷服务和贷款撮合，为客户提供融资咨询。', businessScope: '信息咨询服务。', checkedAt: new Date().toISOString() };
    const results = await service.evaluateBatch([
      { job: base, jobDetail: '负责行政资料整理，无经验可入职。' },
      { job: base, jobDetail: '负责行政资料整理，有经验者优先。' },
      { job: base, jobDetail: '负责行政资料整理，必须有相关工作经验。' },
      { job: { ...base, brandIndustry: '互联网金融' }, jobDetail: '行政文书，无经验可入职。' },
      { job: { ...base, companyInfo: company }, jobDetail: '行政文书，无经验可入职。' },
    ], '希望接受无经验的行政工作。', '行政助理', 'requirements', { rulesOnly: true });
    assert.equal(results[0].passed, true);
    assert.equal(results[1].needsReview, true, '宽泛保留不等于未经确认就自动投递');
    assert.equal(results[2].passed, false);
    assert.equal(results[2].needsReview, undefined);
    assert.match(results[3].reason, /金融.*公司行业.*互联网金融/);
    assert.match(results[4].reason, /金融.*公司介绍.*助贷/);
    assert.ok(results.slice(3).every(item => !item.passed && !item.needsReview));
    assert.equal(calls, 0, '经验条件和明确金融/助贷排除不增加 AI 请求');
    const normalized = (configManager as any).normalize({ ...original, filter: { ...filter, experienceMatchMode: undefined } });
    assert.equal(normalized.filter.experienceMatchMode, 'flexible', '旧配置迁移后默认采用宽泛模式');
    filter.workRequirements = [];
    llmService.chatJson = (async (messages: any[]) => {
      calls++;
      assert.match(messages[0].content, /经验按宽泛方式评估/);
      assert.match(messages[0].content, /不得单凭标签/);
      return { jobs: [{ jobKey: 'job-0', score: 90, passed: true, reason: '实际职责符合', customGreeting: '您好' }] };
    }) as typeof chat;
    assert.equal((await service.evaluateStage2(base, '负责日常行政资料整理，有经验者优先。', '行政文书与软件项目经历。', '行政助理', 'resume')).passed, true);
    assert.equal(calls, 1);
    console.log('PASS | ' + cases.length + ' 项宽泛经验判断、正文优先、严格模式/旧配置迁移、待确认保留、金融/助贷硬排除、零 AI 本地筛选');
  } finally { configManager.getConfig = getConfig; llmService.chatJson = chat; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
