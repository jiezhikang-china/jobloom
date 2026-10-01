const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { normalizeToken, collectCompletion, calculatePow, DeepSeekWebAdapter } = require('../protocol.cjs');

function sse(events, done = true) {
  const text = events.map((item) => `data: ${JSON.stringify(item)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : '');
  const bytes = Buffer.from(text);
  // Split inside UTF-8 characters as real network transport does.
  return Readable.from(Array.from(bytes, (byte) => Buffer.from([byte])));
}
const fragments = [
  { response_message_id: '2' },
  { v: { response: { thinking_enabled: true, fragments: [{ type: 'THINK', content: '' }] } } },
  { p: 'response/fragments/-1/content', o: 'APPEND', v: '推理，不是结果' },
  { p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: '' }] },
  { p: 'response/fragments/-1/content', o: 'APPEND', v: '{"ok":true,"状态":"FINISHED🙂"}' },
  { p: 'response/fragments/-1/type', o: 'SET', v: 'RESPONSE' },
  { p: 'response/status', o: 'SET', v: 'FINISHED' },
];

test('normalizes website raw token, JSON string and .value without logging credentials', () => {
  assert.equal(normalizeToken('  demo-token-123456  '), 'demo-token-123456');
  assert.equal(normalizeToken('"demo-token-123456"'), 'demo-token-123456');
  assert.equal(normalizeToken('{"value":"demo-token-123456","expires":9999}'), 'demo-token-123456');
  assert.equal(normalizeToken('{"value":{}}'), '');
  assert.equal(normalizeToken('token with whitespace'), '');
});

test('bundled DeepSeekHashV1 worker solves a known local vector', async () => {
  // Vector generated using the upstream WASM's separate wasm_deepseek_hash_v1 export.
  const encoded = await calculatePow({ algorithm: 'DeepSeekHashV1', salt: 'local-test-salt',
    expire_at: 1900000000, difficulty: 100, signature: 'local-test',
    challenge: '86546170be3394e4100a74c542725dbd85d38d580844f27cb557be89f97190cc',
  }, AbortSignal.timeout(5000));
  const result = JSON.parse(Buffer.from(encoded, 'base64').toString());
  assert.equal(result.answer, 7);
  assert.equal(result.target_path, '/api/v0/chat/completion');
});

test('handles empty channel switches, metadata, UTF-8 boundaries and literal FINISHED', async () => {
  const result = await collectCompletion(sse(fragments));
  assert.deepEqual(JSON.parse(result.content), { ok: true, 状态: 'FINISHED🙂' });
  assert.equal(result.reasoning, '推理，不是结果');
  assert.equal(result.messageId, '2');
});

test('applies SET snapshots once and relative BATCH patches; refuses interrupted answers', async () => {
  const events = [
    { p: 'response', v: { fragments: [{ type: 'RESPONSE', content: '{"ok":' }] } },
    { p: 'response/fragments/-1/content', o: 'SET', v: '{"ok":true}' },
    { p: 'response', o: 'BATCH', v: [{ p: 'status', o: 'SET', v: 'FINISHED' }] },
  ];
  assert.equal((await collectCompletion(sse(events, false))).content, '{"ok":true}');
  await assert.rejects(collectCompletion(sse(events.slice(0, 2), false)), /返回中断/);
  const explicitFinish = Readable.from([
    'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"{\\"ok\\":true}"}]}\n\n',
    'event: finish\ndata: {}\n\n',
  ]);
  assert.equal((await collectCompletion(explicitFinish)).content, '{"ok":true}');
});

function mockAdapter() {
  const calls = [];
  const adapter = new DeepSeekWebAdapter({
    credentials: async () => ({ token: 'web-login-token-123456' }), solve: async () => 'local-pow-result',
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
      const route = url.split('/api/v0/')[1];
      const bizData = route === 'users/current' ? { token: 'validated-access-token' }
        : route === 'chat_session/create' ? { chat_session: { id: 'owned-temporary-session' } }
        : route === 'chat/create_pow_challenge' ? { challenge: { algorithm: 'DeepSeekHashV1' } } : {};
      if (route === 'chat/completion') return new Response(sse(fragments), { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: bizData } }));
    },
  });
  return { adapter, calls };
}

test('uses web auth, Flash/Pro model_type and JSON prompts; deletes only its temporary session', async () => {
  const { adapter, calls } = mockAdapter();
  const messages = [{ role: 'system', content: '岗位筛选' }, { role: 'user', content: '要求 React' }];
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    const result = await adapter.complete({ model, messages, response_format: { type: 'json_object' } }, AbortSignal.timeout(5000));
    assert.equal(result.model, model);
    assert.equal(JSON.parse(result.choices[0].message.content).ok, true);
    const completion = calls.filter((call) => call.url.endsWith('/chat/completion')).at(-1);
    assert.equal(completion.body.model_type, model.endsWith('pro') ? 'expert' : 'default');
    assert.equal(completion.body.thinking_enabled, false);
    assert.equal(completion.body.search_enabled, false);
    assert.match(completion.body.prompt, /岗位筛选/);
    assert.match(completion.body.prompt, /JSON/);
    assert.equal(completion.init.headers.Authorization, 'Bearer validated-access-token');
    assert.equal(completion.init.headers['X-Ds-Pow-Response'], 'local-pow-result');
    assert.equal(completion.body.max_tokens, undefined);
    assert.equal(completion.body.temperature, undefined);
  }
  assert.equal(calls.filter((call) => call.url.endsWith('/users/current')).length, 1, 'reuse validated access token');
  const cleanup = calls.filter((call) => call.url.endsWith('/chat_session/delete'));
  assert.equal(cleanup.length, 2);
  assert.ok(cleanup.every((call) => call.body.chat_session_id === 'owned-temporary-session'));
  assert.ok(calls.every((call) => new URL(call.url).hostname === 'chat.deepseek.com'));
  assert.ok(!calls.some((call) => /delete_all/.test(call.url)));
});

test('missing login makes no upstream requests; expired / verification / rate limits are distinct', async () => {
  const missing = new DeepSeekWebAdapter({ credentials: async () => ({ token: '' }), fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(missing.complete({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '测试' }] }), (error) => error.code === 'login_required');
  for (const [status, expected] of [[401, 'login_expired'], [403, 'verification_required'], [429, 'rate_limited']]) {
    const adapter = new DeepSeekWebAdapter({ credentials: async () => ({ token: 'web-login-token' }), fetchImpl: async () => new Response('{}', { status }) });
    await assert.rejects(adapter.acquireToken(), (error) => error.code === expected);
  }
});
