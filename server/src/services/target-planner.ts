import { configManager } from '../config/config.manager.js';
import { bossCatalogService, positionSelections } from './boss.catalog.service.js';
import { llmService, type LLMRequestOptions } from './llm.service.js';
import { configuredWorkRequirements } from './work-requirements.js';
import { findJobExclusion } from './job-exclusions.js';
import type { BossPositionSelection } from '../types.js';

export async function planTargetPositions(candidateText: string, source: 'resume' | 'requirements', options: LLMRequestOptions = {}): Promise<BossPositionSelection[]> {
  options.signal?.throwIfAborted();
  const filter = configManager.getConfig().filter;
  const catalog = await bossCatalogService.getPositions();
  options.signal?.throwIfAborted();
  const positions = [...new Map(positionSelections(catalog.categories).map(item => [item.code, item])).values()]
    .filter(item => !findJobExclusion({ jobName: item.name, brandName: '', brandIndustry: item.categoryName }, filter,
      source === 'requirements' ? candidateText : ''));
  if (!positions.length) throw new Error('当前排除条件没有留下可选的官方岗位，请调整条件或手动选择岗位');
  const response = await llmService.chatJson<{ positions: Array<{ positionCode: string }> }>([
    { role: 'system', content: '你帮助用户选择 BOSS 官方目标岗位。根据简历或求职要求选择1至3个不同岗位，严格遵守排除行业与岗位。'
      + '用户没有简历时不得推测技能或经历；允许无经验时优先考虑有入门岗位的方向。外语翻译或语言岗位需对照用户明确提供的语言能力，不得推测用户会外语。工时、双休等条件必须在后续具体岗位中核实，分类本身不证明满足条件。'
      + '只能使用给出的岗位代码，不能编造。返回JSON：{"positions":[{"positionCode":"官方代码"}]}。无法推荐则返回空数组。'
      + '\n官方列表（代码=名称 | 大类/子类）：\n' + positions.map(item => item.code + '=' + item.name + ' | ' + item.categoryName + '/' + item.subcategoryName).join('\n') },
    { role: 'user', content: JSON.stringify({ source, candidateText, candidateLanguages: filter.candidateLanguages, city: filter.cityName, salaryMin: filter.salaryMin,
      salaryMax: filter.salaryMax, excluded: filter.companyBlacklist, requirements: configuredWorkRequirements(filter).map(item => item.text) }) },
  ], 1, options);
  options.signal?.throwIfAborted();
  if (!Array.isArray(response?.positions) || !response.positions.length || response.positions.length > 3) throw new Error('AI 未返回1至3个有效的目标岗位，请手动选择官方岗位后启动');
  const targets = response.positions.map(item => positions.find(position => position.code === item?.positionCode));
  if (targets.some(item => !item) || new Set(targets.map(item => item!.code)).size !== targets.length) throw new Error('AI 返回的目标岗位无效或重复，请手动选择官方岗位后启动');
  return targets as BossPositionSelection[];
}
