import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { configManager } from '../src/config/config.manager.js';
import { filterService, FilterService } from '../src/services/filter.service.js';
import { llmService } from '../src/services/llm.service.js';
import { assessWorkConditions } from '../src/services/work-conditions.js';
import { WorkConditionReviews } from '../src/services/work-condition-reviews.js';
import { assessWorkRequirements, normalizeWorkRequirements, validateWorkRequirements } from '../src/services/work-requirements.js';
import type { BossJobItem, ConditionStatus, WorkConditions } from '../src/types.js';

const selected: WorkConditions = { eightHours: true, doubleRest: true, noExperience: true };
const job: BossJobItem = {
  securityId: '', jobId: '', jobName: '行政助理', lid: '', salaryDesc: '4-6K', jobExperience: '', jobDegree: '大专',
  cityName: '上海', areaDistrict: '', brandName: '模拟公司', brandScaleName: '', brandIndustry: '企业服务',
  bossName: '', bossTitle: '', activeTimeDesc: '', skills: [], welfareList: [],
};
const cases: Array<[keyof WorkConditions, string, ConditionStatus, string?]> = [
  ['eightHours', '每天工作8小时，学历大专及以上。', 'met'],
  ['eightHours', '每日工作7.5小时。', 'met'],
  ['eightHours', '八小时工作制。', 'met'],
  ['eightHours', '工作八小时，周末双休。', 'met'],
  ['eightHours', '上班时间09:00-18:00，午休1小时。', 'met'],
  ['eightHours', '朝九晚六，午休一小时。', 'met'],
  ['eightHours', '上班时间09:00-17:00。', 'met'],
  ['eightHours', '每天工作9小时。', 'not_met'],
  ['eightHours', '每天工作7-9小时。', 'not_met'],
  ['eightHours', '上班时间09:00-19:00，午休1小时。', 'not_met'],
  ['eightHours', '上班时间09:00-18:00。', 'unknown'],
  ['eightHours', '每天至少8小时。', 'unknown'],
  ['eightHours', '每天工作8小时以上。', 'unknown'],
  ['eightHours', '每周工作40小时。', 'unknown'],
  ['eightHours', '提供培训课程，每天培训8小时。', 'unknown'],
  ['eightHours', '每天工作8小时，需要加班。', 'not_met'],
  ['eightHours', '每天工作8小时，偶尔加班。', 'unknown'],
  ['eightHours', '每天工作8小时，有加班补贴。', 'unknown'],
  ['eightHours', '每天工作8小时，不需要加班，非996。', 'met'],
  ['eightHours', '每天工作8小时，加班视工作量而定。', 'unknown'],
  ['eightHours', '每天工作8小时，无法保证不加班。', 'unknown'],
  ['eightHours', '上班时间09:00-13:00，14:00-19:00。', 'unknown'],
  ['eightHours', '上午工作5小时，下午工作4小时。', 'unknown'],
  ['doubleRest', '每周双休。', 'met'],
  ['doubleRest', '每周休两天，采用轮休。', 'met'],
  ['doubleRest', '周六周日固定休息。', 'met'],
  ['doubleRest', '不是单休，每周休2天。', 'met'],
  ['doubleRest', '不实行大小周，每周双休。', 'met'],
  ['doubleRest', '不加班，双休。', 'met'],
  ['doubleRest', '周六周日双休，无需加班。', 'met'],
  ['doubleRest', '每周双休，不需要加班。', 'met'],
  ['doubleRest', '实行大小周。', 'not_met'],
  ['doubleRest', '单双休，隔周双休。', 'not_met'],
  ['doubleRest', '月休8天。', 'unknown'],
  ['doubleRest', '可以申请双休。', 'unknown'],
  ['doubleRest', '双休但偶尔需要加班。', 'unknown'],
  ['doubleRest', '不保证双休。', 'not_met'],
  ['doubleRest', '单休。', 'not_met'],
  ['noExperience', '经验不限，提供入职培训。', 'met'],
  ['noExperience', '接受无经验。', 'met'],
  ['noExperience', '无经验也可，三年经验优先。', 'met'],
  ['noExperience', '无经验也可以，不收取任何培训费。', 'met'],
  ['noExperience', '不要求工作经验。', 'met'],
  ['noExperience', '无工作经验也可。', 'met'],
  ['noExperience', '无需具备工作经验。', 'met'],
  ['noExperience', '无经验要求，入职培训。', 'met'],
  ['noExperience', '无需具备3年经验，无经验可入职。', 'met'],
  ['noExperience', '欢迎应届生，有经验优先。', 'unknown'],
  ['noExperience', '', 'met', '经验不限'],
  ['noExperience', '', 'unknown', '应届生'],
  ['noExperience', '无经验可入职。', 'met', '1年以内'],
  ['noExperience', '无经验可入职。', 'met', '1-3年'],
  ['noExperience', '必须有三年以上相关经验。', 'not_met'],
  ['noExperience', '需要有销售工作经验。', 'not_met'],
  ['noExperience', '不接受无经验。', 'not_met'],
  ['noExperience', '不接受无工作经验。', 'not_met'],
  ['noExperience', '必须有3年经验。', 'not_met', '经验不限'],
  ['noExperience', '不要求工作经验，但必须有3年相关经验。', 'unknown'],
];

async function main() {
  for (const [key, description, expected, experience = ''] of cases) {
    const actual = assessWorkConditions({ ...job, jobExperience: experience }, description, selected);
    assert.equal(actual[key].status, expected, key + ': ' + description + ' / ' + experience);
  }
  assert.deepEqual(normalizeWorkRequirements(undefined, { eightHours: 'true' as any, noExperience: true }).map((item) => item.id),
    ['preset-noExperience']);
  const originalGet = configManager.getConfig;
  const originalChat = llmService.chatJson;
  const original = configManager.getConfig();
  const selectedRequirements = normalizeWorkRequirements(undefined, selected);
  const config = { ...original, filter: { ...original.filter, workRequirements: selectedRequirements, degree: ['本科'],
    salaryMin: undefined, salaryMax: undefined, experience: ['3-5年'], hrActiveDaysLimit: 0,
    requiredKeywords: [], companyBlacklist: [], minLlmMatchScore: 75, experienceMatchMode: 'flexible' as 'flexible' | 'strict' } };
  let calls = 0;
  let response: any = { score: 95, passed: true, customGreeting: '您好，希望了解贵司岗位。' };
  let prompt: any[] = [];
  const evaluate: FilterService['evaluateStage2'] = (...args) => new FilterService().evaluateStage2(...args);
  const temporary = path.join(os.tmpdir(), 'boss-work-reviews-' + process.pid + '-' + Date.now() + '.json');
  try {
    configManager.getConfig = () => config;
    (llmService as any).chatJson = async (messages: any[]) => { calls++; prompt = messages; return { jobs: [{ jobKey: 'job-0', ...response }] }; };
    assert.equal(filterService.evaluateStage1({ ...job, jobExperience: '应届生' }).passed, true,
      '开启无经验后不能被旧的经验白名单挡住');
    const complete = '负责行政文书和办公室日常支持。每天工作8小时，周末双休，接受无经验，入职有培训。';
    const passing = await evaluate(job, complete, '希望找每天八小时、双休、允许无经验的工作。', '符合工作条件的岗位', 'requirements', { rulesOnly: true });
    assert.equal(passing.passed, true);
    assert.equal(passing.needsReview, undefined);
    assert.equal(calls, 0, '已完整验证的纯工作条件投递不必询问 AI');
    assert.equal(passing.evaluationSource, 'rules');
    const before = calls;
    const fail = await evaluate(job, complete + '必须加班到深夜。', '同上', '行政助理');
    assert.equal(fail.passed, false);
    assert.equal(calls, before, '明确不符合的岗位不必请求模型');
    response = { score: 99, passed: true, workRequirements: selectedRequirements.map((item) => ({
      requirementId: item.id, status: 'met', evidence: '每天工作8小时，周末双休，经验不限',
    })) };
    const unknown = await evaluate(job, '负责行政支持，接受无经验，详细作息面议。', '想找八小时双休工作', '行政助理');
    assert.equal(unknown.passed, false);
    assert.equal(unknown.needsReview, true, 'AI 高分和虚构引文不能补齐缺失的条件');
    assert.equal(unknown.requirementAssessment?.find((item) => item.requirementId === 'preset-eightHours')?.status, 'unknown');
    assert.equal(calls, before, '缺失作息的岗位也不必询问 AI');
    const contradictory = await evaluate({ ...job, jobExperience: '3-5年' }, complete, '同上', '行政助理', 'requirements', { rulesOnly: true });
    assert.equal(contradictory.passed, true, '宽泛模式下，正文明确接受无经验优先于经验区间标签');
    const overtime = await evaluate(job, complete + '旺季偶尔加班。', '同上', '行政助理');
    assert.equal(overtime.needsReview, true, '只截取八小时引文不能忽略不确定加班');
    const long = await evaluate(job, complete + '岗位信息。'.repeat(3000), '同上', '行政助理');
    assert.equal(long.needsReview, true, '不能将被截断的岗位描述视为完整验证');
    response = { score: 99, passed: false, reason: '缺少岗位要求的证书' };
    const unfit = await evaluate(job, complete, '同上', '行政助理');
    assert.equal(unfit.passed, false, '工作条件符合仍需通过其他资格要求');
    config.filter.workRequirements = [];
    assert.equal(filterService.evaluateStage1({ ...job, jobExperience: '应届生' }).passed, true, '宽泛模式不能受旧经验白名单影响');
    config.filter.experienceMatchMode = 'strict';
    assert.equal(filterService.evaluateStage1({ ...job, jobExperience: '应届生' }).passed, false, '用户选择严格模式后才使用原经验筛选');
    config.filter.experienceMatchMode = 'flexible';
    response = { score: 90, passed: true, reason: '要求匹配' };
    assert.equal((await evaluate(job, '行政支持。', '希望行政工作', '行政助理')).passed, true,
      '旧配置未启用工作条件时保持兼容');
    config.filter.workRequirements = [
      { id: 'no-sales', text: '销售工作不适合我，仅限提供行政支持的职位', enabled: true },
      { id: 'insurance', text: '入职福利必须覆盖社保与住房公积金', enabled: true },
    ];
    const customDetail = '负责行政支持。工作内容仅为资料整理，不涉及销售。入职即缴纳五险一金。';
    response = { score: 90, passed: true, workRequirements: [
      { requirementId: 'no-sales', status: 'met', evidence: '工作内容仅为资料整理，不涉及销售' },
      { requirementId: 'insurance', status: 'met', evidence: '入职即缴纳五险一金' },
    ] };
    const customPassed = await evaluate(job, customDetail, '不做销售，需要五险一金。', '行政助理', 'requirements');
    assert.equal(customPassed.passed, true, '新加条件须进入实际评估，不能只支持三个预设');
    assert.match(prompt[0].content, /行政支持/);
    assert.match(prompt[0].content, /社保与住房公积金/);
    assert.match(prompt[0].content, /覆盖技术与非技术岗位/);
    assert.match(prompt[0].content, /不得捏造引文/);
    response.workRequirements.pop();
    assert.equal((await evaluate(job, customDetail, '同上', '行政助理')).needsReview, true,
      '模型漏评任何一条新加条件都不能投递');
    response.workRequirements = [
      { requirementId: 'no-sales', status: 'met', evidence: '不存在的销售描述' },
      { requirementId: 'insurance', status: 'met', evidence: '入职即缴纳五险一金' },
    ];
    assert.equal((await evaluate(job, customDetail, '同上', '行政助理')).needsReview, true);
    response.workRequirements[0] = { requirementId: 'no-sales', status: 'not_met', evidence: '负责行政支持' };
    assert.equal((await evaluate(job, customDetail, '同上', '行政助理')).passed, false,
      '新加条件明确不符时，即使高分也不能投递');
    const edited = normalizeWorkRequirements([{ ...selectedRequirements[0], text: '每天工作不超过七小时' }]);
    assert.equal(edited[0].builtin, undefined, '修改预设文本后不能继续套用八小时判定');
    assert.equal(assessWorkRequirements(job, '每天工作8小时。', edited)[0].status, 'not_met', '工时按编辑后的七小时阈值判断');
    assert.equal(validateWorkRequirements([{ id: 'a', text: '有效条件', enabled: true }, { id: 'a', text: '其他条件', enabled: true }]), false);
    const duplicateProof = assessWorkRequirements(job, customDetail, config.filter.workRequirements, [
      { requirementId: 'no-sales', status: 'met', evidence: '不涉及销售' },
      { requirementId: 'no-sales', status: 'not_met', evidence: '不涉及销售' },
    ]);
    assert.equal(duplicateProof[0].status, 'unknown');
    assert.equal(assessWorkRequirements(job, customDetail, [{ id: 'role', text: '只接受行政助理岗位', enabled: true }],
      [{ requirementId: 'role', status: 'met', evidence: '行政助理' }])[0].status, 'met', '可引用岗位标题字段支持自定义条件');
    const migrated = (configManager as any).normalize({ ...original, filter: {
      ...original.filter, workRequirements: undefined, workConditions: selected,
    } });
    assert.equal(migrated.filter.workRequirements.length, 3);
    assert.equal(migrated.filter.workConditions, undefined);
    const store = new WorkConditionReviews(temporary);
    const input = { jobHref: '/job_detail/example.html?query=test', jobName: job.jobName, companyName: job.brandName,
      salary: job.salaryDesc, reason: unknown.reason, requirements: selectedRequirements, assessment: unknown.requirementAssessment! };
    const saved = store.add(input);
    store.add({ ...input, jobHref: 'https://www.zhipin.com/job_detail/example.html#anything', reason: '新描述' });
    const restored = new WorkConditionReviews(temporary).list();
    assert.equal(restored.length, 1, '同一岗位链接去除查询参数后去重并覆盖最新依据');
    assert.equal(restored[0].id, saved.id);
    assert.equal(restored[0].reason, '新描述');
    assert.equal(restored[0].jobHref, 'https://www.zhipin.com/job_detail/example.html');
    assert.match(restored[0].question, /每天工作不超过八小时/);
    assert.throws(() => store.add({ ...input, jobHref: 'https://foreign.example/job_detail/example.html' }), /链接无效/);
    store.removeForJob('/job_detail/example.html');
    assert.equal(store.list().length, 0);
    fs.writeFileSync(temporary, '{invalid', 'utf8');
    assert.throws(() => store.add(input), SyntaxError);
    assert.equal(fs.readFileSync(temporary, 'utf8'), '{invalid', '损坏的记录不能被覆盖或自动清空');
    console.log('PASS | ' + cases.length + ' 项工作条件、自定义条件与逐项引文、漏评/重复评估约束、预设编辑、旧配置迁移、待确认持久化');
  } finally {
    configManager.getConfig = originalGet; llmService.chatJson = originalChat;
    for (const file of [temporary, temporary + '.tmp']) if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
