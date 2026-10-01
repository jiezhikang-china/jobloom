/**
 * 凭据清洗与校验（独立模块，避免 config.manager 与 llm.service 循环依赖）
 *
 * 常见误粘贴形式：`KEY:xxxx`、`Bearer xxxx`、带引号、带首尾空格。
 * 这类脏值会让 Authorization 头整体失效 —— 实测智谱接口会返回 401
 * 「令牌已过期或验证不正确」，进而让整条 AI 链路静默失效。
 */
export function sanitizeApiKey(raw: string | undefined | null): string {
  let key = (raw ?? '').trim();
  key = key.replace(/^["'`]+|["'`]+$/g, '').trim();
  key = key.replace(/^(bearer|key|api[-_ ]?key|token)\b\s*[:=]?\s*/i, '').trim();
  key = key.replace(/["'`]+$/g, '').trim();
  return key;
}

/** 含空白字符或过短的 Key 一律视为非法 */
export function isApiKeyFormatValid(key: string): boolean {
  if (!key) return false;
  if (/\s/.test(key)) return false;
  return key.length >= 8;
}
