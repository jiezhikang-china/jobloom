/** A response arrived; this is an output problem, not a failed model request. */
export class ModelOutputError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelOutputError'; }
}

function withoutTrailingCommas(source: string): string {
  let result = '', quoted = false, escaped = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      result += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else {
      if (c === '"') quoted = true;
      if (c === ',' && /^[\s]*[}\]]/.test(source.slice(i + 1))) continue;
      result += c;
    }
  }
  return result;
}
function balancedValues(text: string): string[] {
  const values: string[] = [];
  let start = -1, quoted = false, escaped = false;
  const stack: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) { if (c === '{' || c === '[') { start = i; stack.push(c); } continue; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      if (stack.at(-1) !== (c === '}' ? '{' : '[')) { start = -1; stack.length = 0; continue; }
      stack.pop();
      if (!stack.length) { values.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return values;
}

/** Only repair framing and trailing commas. Never evaluate code or invent fields. */
export function parseModelJson<T>(raw: string): T {
  let text = raw.replace(/^\uFEFF/, '').trim();
  if (/<think\b/i.test(text)) {
    text = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').trim();
    if (/<think\b/i.test(text)) throw new ModelOutputError('思考过程尚未结束，没有可核对的最终结果');
  }
  const parse = (source: string) => {
    try {
      const value = JSON.parse(withoutTrailingCommas(source));
      return value !== null && typeof value === 'object' ? { value } : undefined;
    } catch { return undefined; }
  };
  const direct = parse(text);
  if (direct) return direct.value as T;
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)];
  const candidates = (fences.length ? fences.flatMap(match => balancedValues(match[1])) : balancedValues(text))
    .map(parse).filter((value): value is { value: any } => Boolean(value));
  if (candidates.length === 1) return candidates[0].value as T;
  throw new ModelOutputError(candidates.length > 1 ? '已收到多个不同的 JSON 结果，需确认哪个是最终评估'
    : '已收到模型回答，但没有完整、可识别的 JSON 评估结果');
}

export function finalMessageText(message: any): string {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.filter((part: any) =>
    ['text', 'output_text'].includes(part?.type) && typeof part.text === 'string').map((part: any) => part.text).join('');
  return '';
}
