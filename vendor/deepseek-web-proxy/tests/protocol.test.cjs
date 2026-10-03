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

function mockAdapter(completionResponse) {
  const calls = [];
  const adapter = new DeepSeekWebAdapter({
    credentials: async () => ({ token: 'web-login-token-123456' }), solve: async () => 'local-pow-result',
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
      const route = url.split('/api/v0/')[1];
      const bizData = route === 'users/current' ? { token: 'validated-access-token' }
        : route === 'chat_session/create' ? { chat_session: { id: 'owned-temporary-session' } }
        : route === 'chat/create_pow_challenge' ? { challenge: { algorithm: 'DeepSeekHashV1' } } : {};
      if (route === 'chat/completion') return completionResponse ? completionResponse() : new Response(sse(fragments), { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: bizData } }));
    },
  });
  return { adapter, calls };
}

test('uses web auth, ordinary model_type and JSON prompts; deletes only its temporary session', async () => {
  const { adapter, calls } = mockAdapter();
  const messages = [{ role: 'system', content: '岗位筛选' }, { role: 'user', content: '要求 React' }];
  for (const model of ['deepseek-v4-flash']) {
    const result = await adapter.complete({ model, messages, response_format: { type: 'json_object' } }, AbortSignal.timeout(5000));
    assert.equal(result.model, model);
    assert.equal(JSON.parse(result.choices[0].message.content).ok, true);
    const completion = calls.filter((call) => call.url.endsWith('/chat/completion')).at(-1);
    assert.equal(completion.body.model_type, 'default');
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
  assert.equal(cleanup.length, 1);
  assert.ok(cleanup.every((call) => call.body.chat_session_id === 'owned-temporary-session'));
  assert.ok(calls.every((call) => new URL(call.url).hostname === 'chat.deepseek.com'));
  assert.ok(!calls.some((call) => /delete_all/.test(call.url)));
  await assert.rejects(adapter.complete({ model: 'deepseek-v4-pro', messages }), (error) => error.code === 'invalid_model');
  assert.equal(calls.filter((call) => call.url.endsWith('/chat/completion')).length, 1, '移除的 Pro 模式不能发起上游请求');
});

test('preserves long and HTTP-date cooldowns, including upstream 503', async () => {
  const adapter = mockAdapter().adapter;
  for (const status of [429, 503]) {
    await assert.rejects(adapter.readJson(new Response('{}', { status, headers: { 'Retry-After': '1800' } })),
      error => error.status === status && error.retryAfter === 1800);
    const date = new Date(Date.now() + 900000).toUTCString();
    await assert.rejects(adapter.readJson(new Response('{}', { status, headers: { 'Retry-After': date } })),
      error => error.retryAfter >= 898 && error.retryAfter <= 900);
  }
});

test('replays the same local request ID after success without submitting another chat', async () => {
  const { adapter, calls } = mockAdapter();
  const request = { model: 'deepseek-v4-flash', request_id: 'stable-local-request', messages: [{ role: 'user', content: '虚构岗位' }] };
  const first = await adapter.complete(request);
  assert.deepEqual(await adapter.complete(request), first);
  assert.equal(calls.filter(call => call.url.endsWith('/chat/completion')).length, 1);
  assert.equal(adapter.requests.list().length, 0);
});

test('lost transport or incomplete stream retains its session and blocks new submissions until explicitly retried', async () => {
  for (const fail of [() => { throw new Error('network lost after submit'); },
    () => new Response(sse(fragments.slice(0, -1), false), { headers: { 'Content-Type': 'text/event-stream' } })]) {
    let shouldFail = true;
    const { adapter, calls } = mockAdapter(() => shouldFail ? fail() : new Response(sse(fragments), { headers: { 'Content-Type': 'text/event-stream' } }));
    const request = { model: 'deepseek-v4-flash', request_id: 'uncertain-local-request', messages: [{ role: 'user', content: '虚构岗位' }] };
    await assert.rejects(adapter.complete(request), error => error.code === 'completion_uncertain');
    const pending = adapter.requests.list();
    assert.equal(pending.length, 1); assert.equal(pending[0].sessionId, 'owned-temporary-session');
    assert.equal(calls.filter(call => call.url.endsWith('/chat_session/delete')).length, 0, '断流时不能删除待检查的聊天');
    const previousCount = calls.length;
    await assert.rejects(adapter.complete(request), error => error.code === 'completion_uncertain');
    await assert.rejects(adapter.complete({ ...request, request_id: 'different-request-id' }), error => error.code === 'completion_uncertain');
    assert.equal(calls.length, previousCount + 1, '不确定时只多一次读取原聊天，不能另开会话');
    assert.equal(calls.at(-1).init.method, 'GET');
    assert.ok(calls.at(-1).url.includes('/chat/history_messages?chat_session_id=owned-temporary-session'));
    assert.equal(calls.filter(call => call.url.endsWith('/chat/completion')).length, 1);
    adapter.requests.clear(pending[0].requestId); shouldFail = false;
    await adapter.complete(request);
    assert.equal(calls.filter(call => call.url.endsWith('/chat/completion')).length, 2);
  }
});

test('confirmed HTTP or business rate-limit rejection can be retried and never becomes an uncertain completion', async () => {
  for (const rejected of [new Response('{}', { status: 429, headers: { 'Retry-After': '900' } }),
    new Response(JSON.stringify({ code: 0, data: { biz_code: 1, biz_msg: '请求频率上限' } }))]) {
    let attempts = 0;
    const { adapter, calls } = mockAdapter(() => ++attempts === 1 ? rejected : new Response(sse(fragments), { headers: { 'Content-Type': 'text/event-stream' } }));
    const request = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '虚构岗位' }] };
    await assert.rejects(adapter.complete(request), error => error.code === 'rate_limited');
    assert.equal(adapter.requests.list().length, 0);
    await adapter.complete(request);
    assert.equal(calls.filter(call => call.url.endsWith('/chat/completion')).length, 2);
  }
});

test('missing login makes no upstream requests; expired / verification / rate limits are distinct', async () => {
  const missing = new DeepSeekWebAdapter({ credentials: async () => ({ token: '' }), fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(missing.complete({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '测试' }] }), (error) => error.code === 'login_required');
  for (const [status, expected] of [[401, 'login_expired'], [403, 'verification_required'], [429, 'rate_limited']]) {
    const adapter = new DeepSeekWebAdapter({ credentials: async () => ({ token: 'web-login-token' }), fetchImpl: async () => new Response('{}', { status }) });
    await assert.rejects(adapter.acquireToken(), (error) => error.code === expected);
  }
});

test('thinking and web search reach the website independently in all four combinations', async () => {
  const { adapter, calls } = mockAdapter();
  for (const [thinking, search] of [[false, false], [true, false], [false, true], [true, true]]) {
    await adapter.complete({ model: 'deepseek-v4-flash', thinking, web_search: search,
      messages: [{ role: 'user', content: '测试独立功能开关' }] }, AbortSignal.timeout(5000));
    const completion = calls.filter((call) => call.url.endsWith('/chat/completion')).at(-1);
    assert.equal(completion.body.model_type, 'default');
    assert.equal(completion.body.thinking_enabled, thinking);
    assert.equal(completion.body.search_enabled, search);
  }
  assert.equal(calls.filter((call) => call.url.endsWith('/chat_session/delete')).length, 4);
});

test('search metadata and control markers do not corrupt the final JSON or reasoning', async () => {
  for (const marker of ['SEARCH', 'WEB_SEARCH', 'SEARCHING']) {
    const events = [
      { v: { response: { search_results: [{ title: '测试来源', url: 'https://example.com' }], fragments: [
        { type: 'SEARCH', content: '检索过程' }, { type: 'THINK', content: '思考过程' },
        { type: 'RESPONSE', content: marker + ' ' },
      ] } } },
      { p: 'response/search_results', o: 'APPEND', v: [{ title: '其他来源', url: 'https://example.org' }] },
      { p: 'response/fragments/-1/content', o: 'APPEND', v: '{"ok":true,"text":"SEARCH 原文"}' },
      { p: 'response/status', o: 'SET', v: 'FINISHED' },
    ];
    const result = await collectCompletion(sse(events), { webSearch: true });
    assert.deepEqual(JSON.parse(result.content), { ok: true, text: 'SEARCH 原文' });
    assert.equal(result.reasoning, '思考过程');
  }
  const ordinary = await collectCompletion(sse([{ v: { response: { fragments: [
    { type: 'RESPONSE', content: 'SEARCH 是这段回答的原文' },
  ] } } }]));
  assert.equal(ordinary.content, 'SEARCH 是这段回答的原文');
});
