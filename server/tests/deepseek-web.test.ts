import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { llmService } from '../src/services/llm.service.js';
import { deepseekProxyService } from '../src/services/deepseek.proxy.service.js';

const originalConfig = configManager.getConfig;
const originalConnection = deepseekProxyService.connection;
const originalFetch = globalThis.fetch;
const config = configManager.getConfig();
let requestCount = 0;

async function main() {
  const web = { ...config, llm: { ...config.llm, connectionMode: 'deepseek-web' as const,
    apiKey: 'old-official-key-must-not-forward', baseUrl: 'https://old-provider.example/v1', model: 'deepseek-v4-flash' } };
  const normalized = (configManager as any).normalize(web);
  assert.equal(normalized.llm.apiKey, '');
  assert.equal(normalized.llm.baseUrl, '');
  (configManager as any).getConfig = () => web;
  deepseekProxyService.connection = async () => ({ baseUrl: 'http://127.0.0.1:19081/v1', apiKey: 'test-local-key-123456789' });
  globalThis.fetch = (async (url: any, init: any) => {
    requestCount++;
    assert.equal(String(url), 'http://127.0.0.1:19081/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer test-local-key-123456789');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'deepseek-v4-flash');
    assert.equal(body.stream, false);
    assert.equal(typeof body.thinking, 'boolean');
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.temperature, undefined);
    return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"score":87,"passed":true}\n```', reasoning_content: '不能用作 JSON' } }] }));
  }) as typeof fetch;
  const result = await llmService.chatJson([{ role: 'user', content: '请筛选 React 岗位' }]);
  assert.deepEqual(result, { score: 87, passed: true });
  requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount++;
    return new Response(JSON.stringify({ error: { message: 'DeepSeek 网页额度受限，请稍后继续' } }), { status: 429 });
  }) as typeof fetch;
  await assert.rejects(llmService.chatJson([{ role: 'user', content: '测试' }]), /网页额度受限/);
  assert.equal(requestCount, 1, 'do not repeatedly consume webpage quota during retries');
  console.log('DeepSeek web routing, credential isolation and JSON tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  configManager.getConfig = originalConfig;
  deepseekProxyService.connection = originalConnection;
  globalThis.fetch = originalFetch;
});
