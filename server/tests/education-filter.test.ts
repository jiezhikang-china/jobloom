import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { filterService } from '../src/services/filter.service.js';
import { llmService } from '../src/services/llm.service.js';
import { checkEducationRequirement, normalizeCandidateDegrees } from '../src/services/education.js';
import type { BossJobItem } from '../src/types.js';

async function main(): Promise<void> {
  const cases: [string, string[], boolean][] = [
    ['大专', ['本科'], true], ['专科及以上', ['本科'], true], ['本科及以上', ['本科'], true],
    ['硕士', ['本科'], false], ['博士', ['硕士'], false], ['本科', ['大专'], false],
    ['大专', ['硕士'], true], ['硕士', ['博士'], true], ['中专', ['本科'], true],
    ['学历不限', ['本科'], true], ['', ['本科'], true], ['未注明', ['本科'], true],
    ['硕士', [], true], ['大专或本科', ['大专'], true], ['仅限大专', ['本科'], false],
    ['只招硕士及以上', ['博士'], true], ['仅限大专/本科', ['本科'], true], ['仅限大专/本科', ['硕士'], false],
    ['大专', ['本科', '硕士'], true], ['硕士', ['本科', '硕士'], false],
  ];
  for (const [requirement, degrees, passed] of cases) {
    assert.equal(checkEducationRequirement(requirement, degrees).passed, passed, `${degrees.join('/')} → ${requirement}`);
  }
  assert.deepEqual(normalizeCandidateDegrees(['硕士', '本科']), ['本科']);
  assert.deepEqual(normalizeCandidateDegrees(['专科']), ['大专']);
  assert.deepEqual(normalizeCandidateDegrees([]), []);

  const originalGet = configManager.getConfig;
  const originalChat = llmService.chatJson;
  const original = configManager.getConfig();
  const config = { ...original, filter: { ...original.filter, degree: ['本科'], experience: [], companyBlacklist: [],
    requiredKeywords: [], hrActiveDaysLimit: 0, salaryMin: undefined, salaryMax: undefined } };
  const job: BossJobItem = { securityId: '', jobId: '', jobName: '自动化测试', lid: '', salaryDesc: '15-25K',
    jobExperience: '3-5年', jobDegree: '大专', cityName: '上海', areaDistrict: '', brandName: '模拟公司',
    brandScaleName: '', brandIndustry: '软件', bossName: '', bossTitle: '', activeTimeDesc: '',
    skills: ['Python', 'Selenium'], welfareList: [] };
  try {
    configManager.getConfig = () => config;
    assert.equal(filterService.evaluateStage1(job).passed, true, '本科必须通过大专岗位的真实硬性筛选入口');
    const higher = filterService.evaluateStage1({ ...job, jobDegree: '硕士及以上' });
    assert.equal(higher.passed, false);
    assert.match(higher.reason!, /岗位最低要求 硕士.*你的学历 本科/);
    let messages: any[] = [];
    (llmService as any).chatJson = async (value: any[]) => {
      messages = value;
      return { score: 90, passed: true, reason: '技能与学历满足要求', customGreeting: '您好' };
    };
    for (const source of ['resume', 'requirements'] as const) {
      const result = await filterService.evaluateStage2(job, '要求大专及以上，使用 Python 和 Selenium 开发自动化测试。',
        '本科，3年 Python 和 Selenium 自动化测试经验。', '自动化测试', source);
      assert.equal(result.passed, true);
      assert.match(messages[0].content, /本科满足大专\/专科要求/);
      assert.match(messages[0].content, /不得仅因求职者学历高于岗位最低要求而扣分或淘汰/);
      assert.match(messages[1].content, /用户明确设置的最高学历.*本科/);
      assert.match(messages[1].content, /岗位学历要求：大专/);
    }
    const normalize = (configManager as any).normalize.bind(configManager);
    assert.deepEqual(normalize({ ...original, filter: { ...original.filter, degree: ['本科', '硕士'] } }).filter.degree, ['本科']);
    assert.equal(normalize({ ...original, llm: { ...original.llm, connectionMode: 'deepseek-web', model: 'deepseek-v4-pro' } }).llm.model, 'deepseek-v4-flash');
    process.stdout.write('PASS | 学历门槛：本科兼容大专、拒绝硕士门槛、旧配置迁移、简历/手动 AI 提示、旧 Pro 配置迁移\n');
  } finally {
    configManager.getConfig = originalGet;
    llmService.chatJson = originalChat;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
