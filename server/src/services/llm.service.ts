import { boundedInteger, configManager } from '../config/config.manager.js';
import type { AppConfig } from '../types.js';
import { AiRequestQueue, abortableSleep } from './ai-request-queue.js';
import { sanitizeApiKey, isApiKeyFormatValid } from '../config/credentials.js';
import { deepseekProxyService } from './deepseek.proxy.service.js';
import { createHash, randomUUID } from 'node:crypto';
import { finalMessageText, ModelOutputError, parseModelJson } from './model-json.js';

export { sanitizeApiKey, isApiKeyFormatValid };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequestOptions {
  signal?: AbortSignal;
  onWait?: (seconds: number) => void;
  onRequest?: () => void;
  beforeRequest?: () => Promise<void>;
}

const DEFAULT_MAX_TOKENS = 16384;
const MIN_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 90000;

export function chatEndpoint(baseUrl: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(baseUrl.trim()); }
  catch { throw new Error('模型接口地址无效，请填写完整的 http:// 或 https:// 地址'); }
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('模型接口只支持 HTTP 或 HTTPS');
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
  if (!endpoint.pathname.endsWith('/chat/completions')) endpoint.pathname += '/chat/completions';
  return endpoint;
}

export class LLMService {
  private pendingWebRequests = new Map<string, string>();
  constructor(private webQueue = new AiRequestQueue()) {}

  public async chat(messages: ChatMessage[], responseFormatJson = false, maxRetries = 3, options: LLMRequestOptions = {}): Promise<string> {
    const config = configManager.getConfig().llm;
    const request = () => this.request(config, messages, responseFormatJson, maxRetries, options);
    return config.connectionMode === 'deepseek-web'
      ? this.webQueue.run(boundedInteger(config.minRequestIntervalSeconds, 30, 10, 300), request, options)
      : request();
  }

  private async request(config: AppConfig['llm'], messages: ChatMessage[], responseFormatJson: boolean,
    maxRetries: number, options: LLMRequestOptions): Promise<string> {
    options.signal?.throwIfAborted();
    const isWeb = config.connectionMode === 'deepseek-web';
    if (isWeb) maxRetries = 1;
    // The managed proxy supplies its own local key. Never forward the previous provider's key.
    const connection = isWeb ? await deepseekProxyService.connection() : config;
    const apiKey = sanitizeApiKey(connection.apiKey);
    const endpoint = chatEndpoint(connection.baseUrl);
    const isLocalEndpoint = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);

    if (!apiKey && !isLocalEndpoint) {
      throw new Error('未配置大模型 API Key，请在【设置】中填写当前接口对应的 Key');
    }
    if (apiKey && !isApiKeyFormatValid(apiKey)) {
      throw new Error('API Key 格式非法：不应包含空格、引号或 "KEY:" 前缀，请到设置页重新粘贴');
    }

    // 官方模型代码是小写；兼容旧配置或手动输入的 GLM-4.7-Flash 展示名称。
    const model = /^glm-4\.7-flash$/i.test(config.model.trim()) ? 'glm-4.7-flash' : config.model.trim();
    const timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
    let maxTokens = config.maxTokens && config.maxTokens > 0 ? config.maxTokens : DEFAULT_MAX_TOKENS;

    const payload: Record<string, any> = {
      model: model || (isWeb ? 'deepseek-v4-flash' : 'glm-4.7-flash'),
      messages,
      temperature: config.temperature ?? 1.0,
      max_tokens: maxTokens,
    };

    // 简单 JSON 请求实测开启思考耗时 81 秒。由用户选择，不再强制开启。
    if (!isWeb && model === 'glm-4.7-flash' && /(?:^|\.)bigmodel\.cn$/i.test(endpoint.hostname)) {
      payload.thinking = { type: config.thinking === 'enabled' ? 'enabled' : 'disabled' };
    }
    if (isWeb) {
      // The website doesn't expose OpenAI max_tokens / temperature / JSON mode.
      delete payload.max_tokens;
      delete payload.temperature;
      payload.stream = false;
      payload.thinking = config.thinking === 'enabled';
      payload.web_search = config.webSearch === true;
      payload.min_request_interval_seconds = boundedInteger(config.minRequestIntervalSeconds, 30, 10, 300);
    }

    if (responseFormatJson) {
      payload.response_format = { type: 'json_object' };
    }
    const fingerprint = isWeb ? createHash('sha256').update(JSON.stringify(payload)).digest('hex') : '';
    if (isWeb) {
      if (!this.pendingWebRequests.has(fingerprint)) this.pendingWebRequests.set(fingerprint, randomUUID());
      payload.request_id = this.pendingWebRequests.get(fingerprint);
    }
    const requestTimeoutMs = isWeb ? Math.max(timeoutMs, payload.thinking ? 630000 : 330000) + boundedInteger(config.minRequestIntervalSeconds, 30, 10, 300) * 1000
      : payload.thinking?.type === 'enabled' ? Math.max(timeoutMs, 180000) : timeoutMs;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let response: Response;
      try {
        options.signal?.throwIfAborted();
        await options.beforeRequest?.();
        options.signal?.throwIfAborted();
        options.onRequest?.();
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (err: any) {
        if (options.signal?.aborted) throw options.signal.reason;
        // 超时不重试：投递主循环不能为了一个挂死的请求反复等待
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
          throw new Error(`大模型请求超时（${Math.round(requestTimeoutMs / 1000)} 秒），请检查网络或关闭深度思考`);
        }
        lastError = err as Error;
        if (attempt >= maxRetries) break;
        console.warn(`[LLM] 请求异常: ${lastError.message}，正在重试 (${attempt}/${maxRetries})...`);
        await abortableSleep(1500 * attempt, options.signal);
        continue;
      }

      const rawText = await response.text();

      // 免费接口常见的 429 / 503 限流：指数退避重试
      if (response.status === 429 || response.status === 503) {
        // Retain the batch; the shared queue waits for the complete provider cooldown.
        if (isWeb) {
          let message = 'DeepSeek 网页请求频率或额度受限，请稍后继续';
          try { message = JSON.parse(rawText)?.error?.message || message; } catch {}
          const retryAfter = response.headers.get('Retry-After');
          const numeric = retryAfter ? Number(retryAfter) : NaN;
          const until = retryAfter ? Date.parse(retryAfter) : NaN;
          const seconds = Number.isFinite(numeric) && numeric > 0 ? numeric
            : Number.isFinite(until) && until > Date.now() ? (until - Date.now()) / 1000 : 60;
          this.webQueue.coolDown(Math.max(1, seconds));
          throw new Error(message);
        }
        const waitSeconds = this.resolveBackoffSeconds(response.headers.get('Retry-After'), attempt);
        if (attempt < maxRetries) {
          console.warn(
            `[LLM] 遭遇免费接口频控 (HTTP ${response.status})，退避 ${waitSeconds.toFixed(1)} 秒后重试 (第 ${attempt}/${maxRetries} 次)...`
          );
          await abortableSleep(waitSeconds * 1000, options.signal);
          continue;
        }
        lastError = new Error(`大模型接口限流 (HTTP ${response.status})，重试 ${maxRetries} 次仍失败`);
        break;
      }

      // 部分 provider 的输出上限远低于默认值，会以 400 拒绝：自动降级后重试
      if (response.status === 400 && maxTokens > MIN_MAX_TOKENS && /max_tokens|max output|maximum token|token limit/i.test(rawText)) {
        maxTokens = Math.max(MIN_MAX_TOKENS, Math.floor(maxTokens / 2));
        payload.max_tokens = maxTokens;
        console.warn(`[LLM] provider 拒绝 max_tokens，自动降级为 ${maxTokens} 后重试 (第 ${attempt}/${maxRetries} 次)`);
        continue;
      }

      if (!response.ok) {
        const hint = !isWeb && (response.status === 401 || response.status === 403)
          ? '（API Key 无效或已过期，请到设置页重新获取并粘贴）'
          : '';
        let providerMessage = rawText;
        try {
          const errorData = JSON.parse(rawText);
          if (['final_answer_missing', 'output_format'].includes(errorData?.error?.code)) throw new ModelOutputError(errorData.error.message);
          providerMessage = errorData?.error?.message || errorData?.message || rawText;
        } catch (error) { if (error instanceof ModelOutputError) throw error; }
        throw new Error(`大模型请求失败 [HTTP ${response.status}]${hint}: ${String(providerMessage).slice(0, 300)}`);
      }

      let data: any;
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(`大模型返回的不是合法 JSON: ${rawText.slice(0, 200)}`);
      }

      // 部分 provider 把错误塞在 200 响应体里
      if (data?.error) {
        if (['final_answer_missing', 'output_format'].includes(data.error.code)) throw new ModelOutputError(data.error.message);
        throw new Error(`大模型返回错误: ${JSON.stringify(data.error).slice(0, 300)}`);
      }

      const message = data.choices?.[0]?.message;
      if (data.choices?.[0]?.finish_reason === 'length') {
        throw new ModelOutputError(`模型输出达到 ${maxTokens} token 上限，评估结果被截断`);
      }
      // reasoning_content 是思考过程，不能作为最终 JSON 结果。
      const content = finalMessageText(message);
      if (!content.trim()) {
        throw new ModelOutputError(message?.reasoning_content ? '已收到思考过程，但没有最终评估答案' : '模型已返回，但最终答案为空');
      }
      if (isWeb) this.pendingWebRequests.delete(fingerprint);
      return content;
    }

    throw lastError || new Error('大模型多次重试依然失败');
  }

  private resolveBackoffSeconds(retryAfterHeader: string | null, attempt: number): number {
    const parsed = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
    if (!isNaN(parsed) && parsed > 0 && parsed <= 120) return parsed;
    return Math.pow(2, attempt) + Math.random() * 0.5;
  }

  public async chatJson<T>(messages: ChatMessage[], maxRetries = 3, options: LLMRequestOptions = {}): Promise<T> {
    const systemPromptExtra: ChatMessage = {
      role: 'system',
      content: '你必须且只能输出严格合法的 JSON 对象，不要包含任何额外的自然语言解释或 markdown 代码块标记。',
    };

    // 注意：JSON 约束放在最前面，避免 system 消息出现在 user 之后被部分 provider 拒绝
    const system: ChatMessage = {
      role: 'system',
      content: [...messages.filter((item) => item.role === 'system').map((item) => item.content), systemPromptExtra.content].join('\n\n'),
    };
    const raw = await this.chat([system, ...messages.filter((item) => item.role !== 'system')], true, maxRetries, options);
    return parseModelJson<T>(raw);
  }
}

export const llmService = new LLMService();
