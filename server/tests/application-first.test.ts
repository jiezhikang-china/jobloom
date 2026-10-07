import assert from 'node:assert/strict';
import { FilterService } from '../src/services/filter.service.js';
import { configManager } from '../src/config/config.manager.js';
import { llmService } from '../src/services/llm.service.js';
import type { BossJobItem } from '../src/types.js';

async function main() {
  const get = configManager.getConfig, chat = llmService.chatJson;
  const config = { ...get.call(configManager), filter: { ...get.call(configManager).filter,
    degree: [], experience: [], companyBlacklist: [], requiredKeywords: [], salaryMin: 0, salaryMax: 0,
    hrActiveDaysLimit: 0, workRequirements: [], candidateLanguages: '', commute: {},
    skipMissingCompanyIntro: false, skipVagueJobDescription: false, minLlmMatchScore: 75 } };
  const job = { jobName: '原创编辑（游戏）', brandName: '3DMGAME', salaryDesc: '6-8K', jobDegree: '大专',
    jobExperience: '经验不限', cityName: '上海', skills: [], welfareList: [], brandIndustry: '互联网' } as unknown as BossJobItem;
  let response: any;
  configManager.getConfig = () => config;
  llmService.chatJson = (async (messages: any[]) => {
    assert.match(messages[0].content, /未写到某项不等于不会/);
    assert.match(messages[0].content, /missingEvidenceOnly/);
    assert.match(messages[0].content, /candidateEvidence/);
    return { jobs: [{ jobKey: 'job-0', ...response }] };
  }) as any;
  const evaluate = (detail: string, profile = '做过视频内容运营、策划和剪辑。') =>
    new FilterService().evaluateStage2(job, detail, profile, '内容运营');
  try {
    response = { score: 52, passed: false, reason: '未提供游戏热爱、游戏内容写作或文字作品证明，与核心要求不匹配。' };
    assert.equal((await evaluate('热爱游戏，具备足够文字功底并有写作表达欲望。')).passed, true, '3DM 原始误判应直接放行');
    response = { score: 68, passed: false, reason: '未提供秀米、Canva、剪映等工具使用能力证明。',
      qualificationFailures: [{ evidence: '能熟练使用秀米、Canva、剪映等图文/视频编辑工具', reason: '未提供工具能力证明' }] };
    assert.equal((await evaluate('具备优秀文字功底，能熟练使用秀米、Canva、剪映等图文/视频编辑工具。')).passed, true, '常见工具不要求逐项证明');
    response = { score: 52, passed: false, missingEvidenceOnly: true, reason: '未写编辑经历' };
    assert.equal((await evaluate('负责内容策划与文章编辑。')).passed, true);
    response = { score: 40, passed: false, missingEvidenceOnly: false, reason: '实际职责是生产线设备安装，与内容编辑无关，且未提供相近经历。' };
    assert.equal((await evaluate('负责生产线设备安装与维修。')).passed, false, '明确无关不能因一句未提供而反向放行');
    response = { score: 30, passed: false, reason: '未提供证书证明', qualificationFailures: [
      { evidence: '必须持有初级会计证书', reason: '未提供所需证书' }] };
    const missing = await evaluate('负责财务报表，必须持有初级会计证书。');
    assert.equal(missing.needsReview, true, '真正证照未提供只待确认，不当成明确不具备');
    response = { score: 5, passed: false, qualificationFailures: [
      { evidence: '必须持有初级会计证书', reason: '用户明确未持有所需会计证书', candidateEvidence: '我未持有初级会计证书' }] };
    const conflict = await evaluate('必须持有初级会计证书，负责财务报表。', '我未持有初级会计证书');
    assert.equal(conflict.passed, false); assert.equal(conflict.needsReview, undefined);
    assert.match(conflict.reason, /明确资格冲突/);
    const invented = await evaluate('必须持有初级会计证书，负责财务报表。', '视频运营经历');
    assert.equal(invented.needsReview, true, '伪造用户引文不得当成资格冲突');
    console.log('PASS | 游戏兴趣/写作作品/常见工具缺证明可投、明确无关保留低分、真实硬资格待确认、双向引文验证');
  } finally { configManager.getConfig = get; llmService.chatJson = chat; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });