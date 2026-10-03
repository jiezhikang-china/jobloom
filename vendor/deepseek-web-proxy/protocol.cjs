// Adapted from Chat2API DeepSeek adapter / stream / providerModelOptions.
// Copyright (C) 2026 Chat2API Team. GPL-3.0-or-later; see LICENSE and UPSTREAM.md.
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { WebRequests, retryAfterSeconds } = require('./requests.cjs');

const API_BASE = 'https://chat.deepseek.com/api/v0';
// Names and mapping from the pinned adapter, not a live claim about the account's quota.
const MODELS = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek 网页', modelType: 'default' },
];

class ProxyError extends Error {
  constructor(message, status = 502, code = 'upstream_error', retryAfter = 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function normalizeToken(raw) {
  if (typeof raw !== 'string') return '';
  let value = raw.trim();
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'string') value = parsed;
    else if (parsed && typeof parsed === 'object') value = parsed.value || parsed.token || parsed.userToken || '';
  } catch { /* The website also stores a plain string. */ }
  return typeof value === 'string' && value.length >= 8 && value.length < 8192 && !/\s/.test(value)
    ? value : '';
}

function resolveOptions(request) {
  const model = MODELS.find((item) => item.id === request.model);
  if (!model) throw new ProxyError('此网页代理只使用 DeepSeek 网页普通模式', 400, 'invalid_model');
  return { model_type: model.modelType, search_enabled: request.web_search === true, thinking_enabled: request.thinking === true };
}

function messagesToPrompt(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 50) {
    throw new ProxyError('聊天消息格式无效', 400, 'invalid_request');
  }
  const blocks = [];
  for (const message of messages) {
    if (!['user', 'system', 'assistant'].includes(message?.role) || typeof message.content !== 'string') {
      throw new ProxyError('聊天消息只支持文本', 400, 'invalid_request');
    }
    const previous = blocks[blocks.length - 1];
    if (previous?.role === message.role) previous.content += `\n\n${message.content}`;
    else blocks.push({ role: message.role, content: message.content });
  }
  const prompt = blocks.map((block, index) => block.role === 'assistant'
    ? `<｜Assistant｜>${block.content}<｜end of sentence｜>`
    : index > 0 ? `<｜User｜>${block.content}` : block.content).join('');
  if (Buffer.byteLength(prompt) > 1500000) throw new ProxyError('简历或消息过长，请缩短后重试', 400, 'invalid_request');
  return prompt;
}

function generationFingerprint(prompt, options) {
  return createHash('sha256').update(JSON.stringify({ prompt, model_type: options.model_type,
    search_enabled: options.search_enabled, thinking_enabled: options.thinking_enabled })).digest('hex');
}
function completionFromResult(sessionId, result, model = 'deepseek-v4-flash') {
  return { id: `${sessionId}@${result.messageId}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: result.content,
      ...(result.reasoning ? { reasoning_content: result.reasoning } : {}) } }] };
}

// Keep complete fragments so SET snapshots do not duplicate earlier tokens.
// Classify empty THINK / RESPONSE fragments before their content arrives.
class DeepSeekAccumulator {
  constructor() {
    this.fragments = [];
    this.lastPath = '';
    this.messageId = '';
    this.finished = false;
    this.totalTokens = 0;
    this.legacyContent = '';
    this.legacyReasoning = '';
    this.channel = 'RESPONSE';
  }
  add(event) {
    if (event?.error || (typeof event?.code === 'number' && event.code !== 0)) {
      throw new ProxyError('DeepSeek 返回错误，请打开登录窗口查看账号状态', 502, 'upstream_error');
    }
    if (event.response_message_id) this.messageId = String(event.response_message_id);
    if (event?.v?.response && !Array.isArray(event.v.response)) this.snapshot(event.v.response);
    else {
      const explicitPath = typeof event.p === 'string';
      if (explicitPath) this.lastPath = event.p.replace(/^\//, '');
      if (!explicitPath && typeof event.v === 'string' && !/\/(?:content|type|status)$/.test(this.lastPath)) {
        const fragment = this.fragments.at(-1);
        if (fragment) fragment.content = (fragment.content || '') + event.v;
        else if (this.channel === 'THINK') this.legacyReasoning += event.v;
        else this.legacyContent += event.v;
      } else this.patch(this.lastPath, event.v, event.o);
    }
  }
  snapshot(response) {
    if (Array.isArray(response.fragments)) this.fragments = response.fragments.map((fragment) => ({ ...fragment }));
    if (this.fragments.at(-1)?.type) this.channel = this.fragments.at(-1).type;
    else if (response.thinking_enabled === true) this.channel = 'THINK';
    if (['FINISHED', 'DONE', 'CLOSED'].includes(response.status)) this.finished = true;
    if (typeof response.accumulated_token_usage === 'number') this.totalTokens = response.accumulated_token_usage;
  }
  patch(p, value, operation) {
    if (operation === 'BATCH' && Array.isArray(value)) {
      for (const item of value) {
        if (typeof item?.p === 'string') this.patch(this.joinPath(p, item.p), item.v, item.o);
      }
      return;
    }
    if (p === '' && value && typeof value === 'object' && !Array.isArray(value)) {
      if (value.response) this.snapshot(value.response);
      return;
    }
    if (p === 'response') {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item?.p === 'string') this.patch(this.joinPath(p, item.p), item.v, item.o);
        }
      } else if (value && typeof value === 'object') this.snapshot(value);
      return;
    }
    if (p === 'response/status' && ['FINISHED', 'DONE', 'CLOSED'].includes(value)) { this.finished = true; return; }
    if (p === 'response/accumulated_token_usage' && typeof value === 'number') { this.totalTokens = value; return; }
    if (p === 'response/fragments' && Array.isArray(value)) {
      const incoming = value.map((fragment) => ({ ...fragment }));
      this.fragments = operation === 'APPEND' ? [...this.fragments, ...incoming] : incoming;
      if (this.fragments.at(-1)?.type) this.channel = this.fragments.at(-1).type;
      return;
    }
    const fragmentPath = p.match(/^response\/fragments\/(-?\d+)(?:\/(content|type))?$/);
    if (fragmentPath) {
      let index = Number(fragmentPath[1]);
      if (index < 0) index = this.fragments.length + index;
      if (index < 0 || index > 1000) return;
      const field = fragmentPath[2];
      const previous = this.fragments[index] || { type: this.channel, content: '' };
      if (!field && value && typeof value === 'object') this.fragments[index] = { ...previous, ...value };
      else if (field && typeof value === 'string') this.fragments[index] = {
        ...previous,
        [field]: field === 'content' && operation !== 'SET' ? `${previous.content || ''}${value}` : value,
      };
      if (this.fragments[index]?.type) this.channel = this.fragments[index].type;
      return;
    }
    if (p === 'response/content' && typeof value === 'string') {
      this.legacyContent = operation === 'SET' ? value : this.legacyContent + value;
    }
    if (p === 'response/thinking_content' && typeof value === 'string') {
      this.legacyReasoning = operation === 'SET' ? value : this.legacyReasoning + value;
    }
  }
  joinPath(parent, child) {
    child = child.replace(/^\//, '');
    return child === 'response' || child.startsWith('response/') ? child : `${parent}/${child}`.replace(/^\/|\/+$/g, '').replace(/\/+/g, '/');
  }
  result() {
    return {
      content: this.fragments.filter((item) => ['ANSWER', 'RESPONSE'].includes(item?.type)).map((item) => item.content || '').join('') || this.legacyContent,
      reasoning: this.fragments.filter((item) => item?.type === 'THINK').map((item) => item.content || '').join('') || this.legacyReasoning,
      totalTokens: this.totalTokens,
      messageId: this.messageId,
    };
  }
}

async function collectCompletion(body, { webSearch = false, jsonExpected = false } = {}) {
  if (!body) throw new ProxyError('DeepSeek 未返回聊天流');
  const state = new DeepSeekAccumulator();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  let eventName = '';
  let dataLines = [];
  const dispatch = () => {
    const data = dataLines.join('\n').trim();
    const name = eventName.toLowerCase();
    eventName = ''; dataLines = [];
    if (name === 'error') throw new ProxyError('DeepSeek 网页返回错误，请检查账号或稍后重试');
    if (data === '[DONE]') { state.finished = true; return; }
    if (data) {
      let parsed;
      try { parsed = JSON.parse(data); }
      catch { throw new ProxyError('DeepSeek 网页协议已变化：聊天流不是合法 JSON', 502, 'stream_format'); }
      state.add(parsed);
    }
    if (['finish', 'done', 'close'].includes(name)) state.finished = true;
  };
  const line = (value) => {
    if (value.startsWith('event:')) { eventName = value.slice(6).trim(); return; }
    if (!value.trim()) { dispatch(); return; }
    if (!value.startsWith('data:')) return;
    dataLines.push(value.slice(5).replace(/^ /, ''));
  };
  for await (const chunk of body) {
    bytes += chunk.byteLength ?? Buffer.byteLength(chunk);
    if (bytes > 8000000) throw new ProxyError('DeepSeek 返回过长，请缩短任务');
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      line(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
      if (state.finished) break;
    }
    // Do not wait for TCP EOF after a completed response: upstream may send keepalives.
    if (state.finished) break;
  }
  buffer += decoder.decode();
  if (!state.finished) {
    if (buffer.trim()) line(buffer.replace(/\r$/, ''));
    dispatch();
  }
  const result = state.result();
  // Search responses may prefix the answer with a control marker. Keep search
  // metadata separate from the final JSON and preserve ordinary answer text.
  if (webSearch) result.content = result.content.replace(/^(SEARCH|WEB_SEARCH|SEARCHING)(?:\s+|$)/i, '');
  // The pinned upstream also uses ordinary stream end. Accept it for a complete
  // JSON final answer only; a cut-off/THINK-only stream remains unconfirmed.
  if (!state.finished && jsonExpected && result.content.trim()) {
    try {
      const final = JSON.parse(result.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
      state.finished = final !== null && typeof final === 'object';
    } catch { /* Keep a truncated response unconfirmed. */ }
  }
  if (!state.finished) throw new ProxyError('DeepSeek 返回中断，未收到完成标记，请稍后重试', 502, 'incomplete_response');
  if (!result.content.trim()) {
    const error = new ProxyError('DeepSeek 已结束，但只返回思考过程或空答案；结果需要确认', 422, 'final_answer_missing');
    error.completed = true; throw error;
  }
  return result;
}

function calculatePow(challenge, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'pow-worker.cjs'));
    const finish = (error, answer) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      error ? reject(error) : resolve(Buffer.from(JSON.stringify({
        algorithm: challenge.algorithm, challenge: challenge.challenge, salt: challenge.salt,
        answer, signature: challenge.signature, target_path: '/api/v0/chat/completion',
      })).toString('base64'));
    };
    const onAbort = () => finish(new ProxyError('DeepSeek 请求已取消', 504, 'timeout'));
    const timer = setTimeout(() => finish(new ProxyError('DeepSeek 协议计算超时，请稍后重试', 504, 'timeout')), 20000);
    worker.once('message', (result) => finish(result.error ? new ProxyError(result.error) : null, result.answer));
    worker.once('error', () => finish(new ProxyError('DeepSeek 协议计算启动失败')));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else worker.postMessage(challenge);
  });
}

class DeepSeekWebAdapter {
  constructor({ fetchImpl = fetch, credentials, solve = calculatePow, onAuthState = () => {}, requests = new WebRequests() }) {
    this.fetchImpl = fetchImpl;
    this.credentials = credentials;
    this.solve = solve;
    this.onAuthState = onAuthState;
    this.access = null;
    this.requests = requests;
    this.nextRecoveryAt = new Map();
  }
  clearTokenCache() { this.access = null; }
  async headers(token) {
    const credential = await this.credentials();
    const headers = {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: '*/*',
      Origin: 'https://chat.deepseek.com', Referer: 'https://chat.deepseek.com/',
      'X-App-Version': '2.0.0', 'X-Client-Version': '2.0.0',
      'X-Client-Locale': 'zh_CN', 'X-Client-Platform': 'web', 'X-Client-Timezone-Offset': '28800',
    };
    if (credential.cookie) headers.Cookie = credential.cookie;
    if (credential.userAgent) headers['User-Agent'] = credential.userAgent;
    return headers;
  }
  async request(route, token, payload, signal) {
    const response = await this.fetchImpl(`${API_BASE}/${route}`, {
      method: payload === undefined ? 'GET' : 'POST', headers: await this.headers(token),
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    return this.readJson(response);
  }
  async readJson(response) {
    if (response.status === 429) throw new ProxyError('DeepSeek 网页请求过于频繁，请稍后继续', 429, 'rate_limited', Math.max(1, retryAfterSeconds(response.headers.get('Retry-After'))));
    if (response.status === 503) throw new ProxyError('DeepSeek 网页暂时繁忙，请等待恢复', 503, 'service_unavailable', Math.max(1, retryAfterSeconds(response.headers.get('Retry-After'))));
    if (response.status === 401) {
      this.clearTokenCache(); this.onAuthState('expired');
      throw new ProxyError('DeepSeek 登录已失效，请在设置中重新登录', 401, 'login_expired');
    }
    if (response.status === 403) {
      this.onAuthState('verification_required');
      throw new ProxyError('DeepSeek 网页需要确认，请打开登录窗口手动处理后重试', 403, 'verification_required');
    }
    if (!response.ok) throw new ProxyError(`DeepSeek 网页暂不可用（HTTP ${response.status}），请稍后重试`, 502);
    let data;
    try { data = await response.json(); }
    catch { throw new ProxyError('DeepSeek 网页返回异常，请打开登录窗口确认网页可用'); }
    if (data?.code !== 0 || (data?.data?.biz_code != null && data.data.biz_code !== 0)) {
      const message = String(data?.data?.biz_msg || data?.msg || '');
      if (/token|登录|login|unauthorized|未认证|认证失败/i.test(message)) {
        this.clearTokenCache(); this.onAuthState('expired');
        throw new ProxyError('DeepSeek 登录已失效，请在设置中重新登录', 401, 'login_expired');
      }
      if (/频繁|频率|limit|quota|额度|上限/i.test(message)) throw new ProxyError('DeepSeek 网页额度或频率受限，请稍后继续', 429, 'rate_limited', 60);
      if (/验证|captcha|verify/i.test(message)) {
        this.onAuthState('verification_required');
        throw new ProxyError('DeepSeek 网页需要确认，请打开登录窗口手动处理', 403, 'verification_required');
      }
      throw new ProxyError('DeepSeek 网页请求失败，请打开登录窗口检查账号状态');
    }
    return data?.data?.biz_data || data?.biz_data;
  }
  async acquireToken(signal, force = false) {
    const { token } = await this.credentials();
    if (!token) throw new ProxyError('请先在设置中登录 DeepSeek 网页账号', 401, 'login_required');
    if (!force && this.access?.source === token && this.access.expiresAt > Date.now()) return this.access.token;
    const data = await this.request('users/current', token, undefined, signal);
    if (!data || typeof data.token !== 'string' || !data.token) {
      this.onAuthState('expired');
      throw new ProxyError('DeepSeek 未确认登录状态，请重新登录', 401, 'login_expired');
    }
    this.access = { source: token, token: data.token, expiresAt: Date.now() + 3600000 };
    this.onAuthState('ready');
    return data.token;
  }
  async complete(request, signal) {
    const options = resolveOptions(request);
    const requestId = typeof request.request_id === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(request.request_id)
      ? request.request_id : randomUUID();
    const previous = this.requests.result(requestId);
    if (previous) return previous;
    let prompt = messagesToPrompt(request.messages);
    if (request.response_format?.type === 'json_object') prompt += '\n\n仅输出一个合法 JSON 对象，不要输出代码围栏或解释。';
    const fingerprint = generationFingerprint(prompt, options);
    let cached = this.requests.resultForFingerprint(fingerprint);
    if (cached) return cached;
    const pending = this.requests.list()[0];
    if (pending) {
      await this.recoverPending(pending, signal);
      cached = this.requests.resultForFingerprint(fingerprint);
      if (cached) return cached;
    }
    if (this.requests.list().length) throw new ProxyError('原聊天尚未完成，岗位已保留。等待后会读取同一聊天的结果，不重复提交生成', 503, 'completion_uncertain', 60);
    const token = await this.acquireToken(signal);
    let sessionId;
    let dispatched = false;
    let confirmed = false;
    try {
      const session = await this.request('chat_session/create', token, {}, signal);
      sessionId = session?.chat_session?.id;
      if (!sessionId) throw new ProxyError('DeepSeek 创建聊天失败，请重新登录或稍后重试');
      const challenge = await this.request('chat/create_pow_challenge', token, { target_path: '/api/v0/chat/completion' }, signal);
      if (!challenge?.challenge) throw new ProxyError('DeepSeek 网页协议已变化：缺少请求校验数据');
      const answer = await this.solve(challenge.challenge, signal);
      const headers = { ...await this.headers(token), 'X-Ds-Pow-Response': answer, Referer: `https://chat.deepseek.com/a/chat/s/${sessionId}` };
      signal?.throwIfAborted();
      // Record before the non-idempotent POST. A lost connection cannot prove it was rejected.
      this.requests.begin(requestId, sessionId, fingerprint);
      dispatched = true;
      const response = await this.fetchImpl(`${API_BASE}/chat/completion`, {
        method: 'POST', signal,
        headers,
        body: JSON.stringify({ chat_session_id: sessionId, parent_message_id: null, prompt,
          ...options, ref_file_ids: [], preempt: false }),
      });
      if (!response.ok || !/text\/event-stream/i.test(response.headers.get('content-type') || '')) {
        if ([400, 401, 403, 429].includes(response.status)) {
          this.requests.clear(requestId); dispatched = false;
        }
        await this.readJson(response);
        throw new ProxyError('DeepSeek 没有返回聊天流，请更新代理');
      }
      const result = await collectCompletion(response.body, { webSearch: options.search_enabled, jsonExpected: request.response_format?.type === 'json_object' });
      const completion = completionFromResult(sessionId, result, request.model);
      this.requests.finish(requestId, completion, fingerprint);
      confirmed = true;
      return completion;
    } catch (error) {
      if (dispatched && error.completed) {
        // Generation ended. Preserve this terminal result by ID; do not regenerate it.
        this.requests.finish(requestId, { error: { message: error.message, code: error.code } }, fingerprint);
        confirmed = true;
      }
      if (dispatched && ['rate_limited', 'login_expired', 'verification_required'].includes(error.code)) {
        this.requests.clear(requestId); dispatched = false;
      }
      if (dispatched && !confirmed) throw new ProxyError('DeepSeek 聊天已提交，但未取得完整结果。岗位已保留，请在设置中查看该聊天；等待期间不会重复提交', 503, 'completion_uncertain', Math.max(60, error.retryAfter || 0));
      throw error;
    } finally {
      // Only remove the temporary chat created by this request. Never clear the user's history.
      if (sessionId && (!dispatched || confirmed)) {
        try { await this.request('chat_session/delete', token, { chat_session_id: sessionId }); }
        catch { /* A failed cleanup must not discard a completed answer. */ }
      }
    }
  }
  /** Verified in this project's own chat: GET history_messages without cache deltas. */
  async recoverPending(pending, signal, force = false) {
    if (!this.requests.list().some(item => item.requestId === pending.requestId && item.sessionId === pending.sessionId)) return false;
    if (!force && (this.nextRecoveryAt.get(pending.requestId) || 0) > Date.now()) return false;
    this.nextRecoveryAt.set(pending.requestId, Date.now() + 60000);
    const token = await this.acquireToken(signal);
    const history = await this.request('chat/history_messages?chat_session_id=' + encodeURIComponent(pending.sessionId), token, undefined, signal);
    if (history?.chat_session?.id !== pending.sessionId || !Array.isArray(history.chat_messages)) return false;
    const users = history.chat_messages.filter(item => item.role === 'USER');
    const replies = history.chat_messages.filter(item => item.role === 'ASSISTANT');
    if (users.length !== 1 || replies.length !== 1 || replies[0].parent_id !== users[0].message_id) return false;
    const reply = replies[0];
    if (reply.status !== 'FINISHED' || reply.incomplete_message === true || reply.has_pending_fragment === true) return false;
    const accumulator = new DeepSeekAccumulator(); accumulator.snapshot(reply); accumulator.messageId = String(reply.message_id);
    const result = accumulator.result();
    if (!result.content.trim()) return false;
    const prompt = (users[0].fragments || []).filter(item => item.type === 'REQUEST').map(item => item.content || '').join('');
    if (!prompt || typeof history.chat_session.model_type !== 'string') return false;
    const fingerprint = generationFingerprint(prompt, { model_type: history.chat_session.model_type,
      thinking_enabled: users[0].thinking_enabled === true, search_enabled: users[0].search_enabled === true });
    if (pending.fingerprint && pending.fingerprint !== fingerprint) return false;
    this.requests.finish(pending.requestId, completionFromResult(pending.sessionId, result), fingerprint);
    this.nextRecoveryAt.delete(pending.requestId);
    return true; // Keep the original chat in history; never regenerate on recovery.
  }
}

module.exports = { MODELS, ProxyError, normalizeToken, resolveOptions, messagesToPrompt, DeepSeekAccumulator, collectCompletion, calculatePow, DeepSeekWebAdapter, generationFingerprint };
