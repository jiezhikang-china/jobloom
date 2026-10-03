const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { DeepSeekAccumulator, DeepSeekWebAdapter, collectCompletion, generationFingerprint, messagesToPrompt } = require('../protocol.cjs');
const { WebRequests } = require('../requests.cjs');
const sse = events => Readable.from(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n'));

test('root BATCH, nested response patches and bare tokens respect THINK / ANSWER', async () => {
  for (const root of ['', 'response']) {
    const patches = [{ p: 'fragments', o: 'APPEND', v: [{ type: 'THINK', content: '' }] }];
    const events = [{ p: root, o: 'BATCH', v: root ? patches : patches.map(e => ({ ...e, p: 'response/' + e.p })) },
      { v: '思考中的 JSON {"passed":false}' },
      { p: 'response/fragments', o: 'APPEND', v: [{ type: 'ANSWER', content: '' }] }, { v: '{"passed":true}' },
      { p: '', o: 'BATCH', v: [{ p: 'response/status', o: 'SET', v: 'FINISHED' }] }];
    const result = await collectCompletion(sse(events));
    assert.equal(result.content, '{"passed":true}'); assert.match(result.reasoning, /false/);
  }
  const state = new DeepSeekAccumulator();
  state.add({ p: 'response', v: [{ p: 'fragments', o: 'SET', v: [{ type: 'RESPONSE', content: '最终答案' }] }] });
  assert.equal(state.result().content, '最终答案');
});

test('multi-line SSE and finish without data complete without waiting for keepalive EOF', async () => {
  const body = new Readable({ read() {} });
  body.push('data: {"p":"response",\ndata: "v":{"fragments":[{"type":"RESPONSE","content":"{\\"ok\\":true}"}]}}\n\n');
  body.push('event: finish\n\n'); // Intentionally never ends the connection.
  const result = await Promise.race([collectCompletion(body), new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('已完成答案仍在等断开')), 1000); timer.unref();
  })]);
  assert.equal(result.content, '{"ok":true}');
});

test('ordinary EOF accepts complete final JSON only when requested; THINK-only is not the answer', async () => {
  const complete = [{ v: { response: { fragments: [{ type: 'RESPONSE', content: '{"jobs":[]}' }] } } }];
  assert.equal((await collectCompletion(sse(complete), { jsonExpected: true })).content, '{"jobs":[]}');
  await assert.rejects(collectCompletion(sse(complete)), error => error.code === 'incomplete_response');
  await assert.rejects(collectCompletion(sse([{ v: { response: { fragments: [{ type: 'RESPONSE', content: '{"jobs":[' }] } } }]), { jsonExpected: true }), error => error.code === 'incomplete_response');
  await assert.rejects(collectCompletion(sse([{ v: { response: { status: 'FINISHED', fragments: [{ type: 'THINK', content: '{"jobs":[]}' }] } } }]), { jsonExpected: true }), error => error.code === 'final_answer_missing' && error.completed === true);
});

function mockHistory({ finished = true, legacy = false, wrongParent = false, wrongFingerprint = false } = {}) {
  const request = { model: 'deepseek-v4-flash', thinking: true, web_search: false,
    response_format: { type: 'json_object' }, request_id: 'original-request-123', messages: [{ role: 'user', content: '原来的五个岗位' }] };
  const prompt = messagesToPrompt(request.messages) + '\n\n仅输出一个合法 JSON 对象，不要输出代码围栏或解释。';
  const fingerprint = generationFingerprint(prompt, { model_type: 'default', search_enabled: false, thinking_enabled: true });
  const requests = new WebRequests(); requests.begin(request.request_id, 'original-session-123', legacy ? undefined : wrongFingerprint ? 'f'.repeat(64) : fingerprint);
  const calls = [];
  const answer = '{"jobs":[{"jobKey":"job-0","score":88,"passed":true}]}';
  const adapter = new DeepSeekWebAdapter({ requests, credentials: async () => ({ token: 'fake-test-token-1234' }),
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (url.endsWith('/users/current')) return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { token: 'validated-test-token' } } }));
      assert.ok(url.includes('/chat/history_messages?chat_session_id=original-session-123'));
      assert.equal(init.method, 'GET'); assert.ok(!url.includes('cache_'));
      return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: {
        chat_session: { id: 'original-session-123', model_type: 'default' }, chat_messages: [
          { message_id: 1, role: 'USER', thinking_enabled: true, search_enabled: false, fragments: [{ type: 'REQUEST', content: prompt }] },
          { message_id: 2, parent_id: wrongParent ? 999 : 1, role: 'ASSISTANT', status: finished ? 'FINISHED' : 'GENERATING',
            incomplete_message: false, has_pending_fragment: false,
            fragments: [{ type: 'THINK', content: '很长的思考，不是答案' }, { type: 'RESPONSE', content: answer }, { type: 'TIP', content: '忽略提示' }] },
        ],
      } } }));
    } });
  return { request, adapter, calls, fingerprint, answer };
}

test('recover original completed thinking answer with exact prompt fingerprint, never generate or delete it', async () => {
  for (const legacy of [false, true]) {
    const { request, adapter, calls, answer, fingerprint } = mockHistory({ legacy });
    assert.equal(await adapter.recoverPending(adapter.requests.list()[0]), true);
    assert.equal(adapter.requests.list().length, 0);
    const original = adapter.requests.result(request.request_id);
    assert.equal(original.choices[0].message.content, answer);
    assert.equal(adapter.requests.resultForFingerprint(fingerprint), original);
    assert.deepEqual(await adapter.complete({ ...request, request_id: 'new-local-request-456' }), original);
    assert.equal(calls.length, 2, '只校验登录和读取原聊天，没有新的生成/删除');
  }
});

test('unfinished / foreign parent / fingerprint mismatch stay pending, polling waits 60 seconds', async () => {
  for (const options of [{ finished: false }, { wrongParent: true }, { wrongFingerprint: true }]) {
    const { adapter, request, calls } = mockHistory(options);
    const pending = adapter.requests.list()[0];
    assert.equal(await adapter.recoverPending(pending), false);
    assert.equal(await adapter.recoverPending(pending), false);
    await assert.rejects(adapter.complete(request), error => error.code === 'completion_uncertain');
    assert.equal(adapter.requests.list().length, 1); assert.equal(calls.length, 2);
    assert.equal(adapter.requests.resultForFingerprint('e'.repeat(64)), undefined);
  }
});
