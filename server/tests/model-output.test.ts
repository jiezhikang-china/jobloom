import assert from 'node:assert/strict';
import { finalMessageText, ModelOutputError, parseModelJson } from '../src/services/model-json.js';
import { LLMService } from '../src/services/llm.service.js';
import { configManager } from '../src/config/config.manager.js';
import { deepseekProxyService } from '../src/services/deepseek.proxy.service.js';

async function main() {
  const expected = { jobs: [{ jobKey: 'job-0', score: 88, passed: true, reason: '字符串中的 }, 和 [不应改变]' }] };
  const json = JSON.stringify(expected);
  for (const framing of [json, '\uFEFF' + json, '分析完成。\n' + json + '\n以上为结果。', '```json\n' + json + '\n```',
    '<think>仅供思考 {"passed":false}</think>\n```json\n' + json + '\n```', json.replace('}]}', '},],}')]) {
    assert.deepEqual(parseModelJson(framing), expected);
  }
  assert.deepEqual(parseModelJson('[{"jobKey":"job-0",}]'), [{ jobKey: 'job-0' }]);
  assert.throws(() => parseModelJson('{"ok":true}\n{"ok":false}'), ModelOutputError);
  for (const broken of ['<think>{"passed":true}', '<think>{"passed":true}</think>', '{"jobs":[', "{'passed':true}", 'true']) {
    assert.throws(() => parseModelJson(broken), ModelOutputError, '不将思考或截断内容当最终评估');
  }
  assert.equal(finalMessageText({ content: [{ type: 'reasoning', text: '错误答案' }, { type: 'text', text: '{"ok":' }, { type: 'output_text', text: 'true}' }] }), '{"ok":true}');
  assert.equal(finalMessageText({ reasoning_content: '{"passed":true}', content: null }), '');

  const oldGet = configManager.getConfig, oldFetch = globalThis.fetch, oldConnection = deepseekProxyService.connection;
  const cfg = configManager.getConfig();
  configManager.getConfig = () => ({ ...cfg, llm: { ...cfg.llm, connectionMode: 'deepseek-web', thinking: 'enabled', minRequestIntervalSeconds: 10 } });
  deepseekProxyService.connection = async () => ({ baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'fake-local-test-token' });
  let calls = 0;
  try {
    globalThis.fetch = (async (_url, init) => {
      calls++; assert.equal(JSON.parse(String(init?.body)).thinking, true);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { reasoning_content: '思考 JSON {"wrong":true}',
        content: [{ type: 'text', text: '```json\n{"ok":true}\n```' }] } }] }));
    }) as typeof fetch;
    assert.deepEqual(await new LLMService().chatJson([{ role: 'user', content: '本地测试' }]), { ok: true });
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: '{"passed":true}' } }] })); }) as typeof fetch;
    await assert.rejects(new LLMService().chatJson([{ role: 'user', content: '仅思考' }]), ModelOutputError);
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ error: { code: 'final_answer_missing', message: '最终答案为空' } }), { status: 422 }); }) as typeof fetch;
    await assert.rejects(new LLMService().chatJson([{ role: 'user', content: '无最终答案' }]), ModelOutputError);
    assert.equal(calls, 3, '格式问题不在请求内部重新生成');
    console.log('PASS | 最终答案独立读取、思考隔离、围栏/前后文字/尾逗号兼容、歧义和残缺保留确认、零额外生成');
  } finally { configManager.getConfig = oldGet; globalThis.fetch = oldFetch; deepseekProxyService.connection = oldConnection; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
