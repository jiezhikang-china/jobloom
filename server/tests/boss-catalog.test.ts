import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BossCatalogService, BOSS_POSITION_SOURCE, parseBossPositionResponse, positionSelections } from '../src/services/boss.catalog.service.js';
import { searchUrl } from '../src/services/boss.page.service.js';
import { resumeService } from '../src/services/resume.service.js';
import { llmService } from '../src/services/llm.service.js';

async function main(): Promise<void> {
  const fixture = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/boss-positions-official.json'), 'utf8'));
  const catalog = parseBossPositionResponse(fixture);
  assert.equal(catalog.categories.length, 28);
  assert.equal(catalog.positionCount, 848);
  const positions = positionSelections(catalog.categories);
  const frontEnd = positions.find((position) => position.code === '100901');
  assert.equal(frontEnd?.name, '前端开发工程师');
  assert.equal(frontEnd?.categoryName, '互联网/AI');
  assert.equal(frontEnd?.subcategoryName, '前端/移动开发');
  assert.throws(() => parseBossPositionResponse({ code: -1003, message: '资源不存在' }), /资源不存在/);
  assert.throws(() => parseBossPositionResponse({ code: 0, zpData: { position: [] } }), /空的岗位分类/);
  const classified = new URL(searchUrl('', '101020100', '100901'));
  assert.equal(classified.searchParams.get('position'), '100901');
  assert.equal(classified.searchParams.has('query'), false);
  const keywordSearch = new URL(searchUrl('React Native', '101020100', '100901'));
  assert.equal(keywordSearch.searchParams.get('query'), 'React Native');
  assert.equal(keywordSearch.searchParams.get('position'), '100901');
  assert.throws(() => searchUrl('', '', '100901&position=0'), /格式不正确/);

  const testDir = path.resolve('../data', `catalog-test-${process.pid}`);
  fs.mkdirSync(testDir, { recursive: true });
  const cacheFile = path.join(testDir, 'cache.json');
  const originalFetch = globalThis.fetch;
  const originalChatJson = llmService.chatJson;
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ ...catalog, fetchedAt: '2020-01-01T00:00:00.000Z' }));
    const service = new BossCatalogService(cacheFile, path.join(testDir, 'missing.json'));
    let requests = 0;
    globalThis.fetch = (async (url: any) => {
      assert.equal(String(url), BOSS_POSITION_SOURCE);
      requests++;
      return new Response(JSON.stringify(fixture));
    }) as typeof fetch;
    const [first, second] = await Promise.all([service.getPositions(true), service.getPositions(true)]);
    assert.equal(requests, 1, '并发刷新只应请求一次官方接口');
    assert.equal(first.positionCount, second.positionCount);
    assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).positionCount, 848);
    globalThis.fetch = (async () => { throw new Error('网络断开'); }) as typeof fetch;
    const fallback = await service.getPositions(true);
    assert.equal(fallback.stale, true);
    assert.match(fallback.warning || '', /网络断开/);
    assert.equal((await service.findPosition('100901'))?.name, '前端开发工程师');
    assert.equal(await service.findPosition('999999'), undefined);

    (llmService as any).chatJson = async (messages: any[]) => {
      assert.match(messages[0].content, /100901=前端开发工程师/);
      return { summary: '测试', coreSkills: ['React'], recommendations: [{ positionCode: '100901', roleTitle: '非官方别名', matchScore: 90 }] };
    };
    const diagnosis = await resumeService.diagnoseResume('React TypeScript 前端开发经验。'.repeat(5));
    assert.equal(diagnosis.recommendations[0].roleTitle, '前端开发工程师');
    assert.equal(diagnosis.recommendations[0].positionCode, '100901');
    process.stdout.write('PASS | 官方三级岗位分类、刷新与离线缓存、代码搜索、AI 推荐映射\n');
  } finally {
    globalThis.fetch = originalFetch;
    (llmService as any).chatJson = originalChatJson;
    const safeRoot = path.resolve('../data') + path.sep;
    if (!testDir.startsWith(safeRoot)) throw new Error('测试目录越界');
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
