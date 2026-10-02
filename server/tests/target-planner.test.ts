import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { bossCatalogService, positionSelections } from '../src/services/boss.catalog.service.js';
import { llmService } from '../src/services/llm.service.js';
import { planTargetPositions } from '../src/services/target-planner.js';
import catalog from '../resources/boss-positions.json';

const original = configManager.getConfig();
const originals = [configManager.getConfig, bossCatalogService.getPositions, llmService.chatJson] as const;
const positions = positionSelections(catalog.categories);
const find = (name: string) => { const item = positions.find(item => item.name === name); assert.ok(item); return item; };
let calls = 0;
let response: unknown = { positions: ['网络客服', '数据采集', '数据标注/AI训练师'].map(name => ({ positionCode: find(name).code })) };

async function main() {
  configManager.getConfig = () => ({ ...original, filter: { ...original.filter, companyBlacklist: ['金融', '销售'],
    workRequirements: [{ id: 'rest', text: '每周双休', enabled: true }] } });
  bossCatalogService.getPositions = async () => catalog;
  llmService.chatJson = (async (messages: any[], retries: number, options: any) => {
    calls++;
    assert.equal(retries, 1);
    const listed = messages[0].content.split('官方列表（代码=名称 | 大类/子类）：\n')[1];
    assert.ok(listed.includes(find('网络客服').code + '=网络客服'));
    assert.ok(!listed.includes('=销售专员') && !listed.includes('=银行柜员'), '否定行业和销售不能成为 AI 可选方向');
    const input = JSON.parse(messages[1].content);
    assert.deepEqual(input.requirements, ['每周双休']);
    assert.ok(messages[0].content.includes('不得推测技能或经历'));
    options.onRequest?.();
    return response;
  }) as typeof llmService.chatJson;
  let notified = 0;
  const targets = await planTargetPositions('不考虑金融，不做销售，想找双休入门工作。', 'requirements', { onRequest: () => { notified++; } });
  assert.deepEqual(targets.map(item => item.name), ['网络客服', '数据采集', '数据标注/AI训练师']);
  assert.ok(targets.every(item => item.categoryName && item.subcategoryName));
  assert.equal(calls, 1); assert.equal(notified, 1, 'AI 目标规划请求须计入界面的调用次数');
  for (const positions of [[], [{ positionCode: '999999' }], [{ positionCode: find('销售专员').code }],
    [{ positionCode: find('网络客服').code }, { positionCode: find('网络客服').code }],
    Array.from({ length: 4 }, () => ({ positionCode: find('网络客服').code }))]) {
    response = { positions };
    await assert.rejects(planTargetPositions('想找入门工作。', 'requirements'), /有效|无效|重复/);
  }
  const controller = new AbortController(); controller.abort(new Error('用户停止规划'));
  const before = calls;
  await assert.rejects(planTargetPositions('不考虑金融。', 'requirements', { signal: controller.signal }), /用户停止规划/);
  assert.equal(calls, before, '已停止的任务不能读取分类或发起 AI 请求');
  console.log('PASS | AI 目标规划遵守排除条件、最多三个官方代码、保留完整层级、拒绝无效和重复结果、计数与停止');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  configManager.getConfig = originals[0]; bossCatalogService.getPositions = originals[1]; llmService.chatJson = originals[2];
});
