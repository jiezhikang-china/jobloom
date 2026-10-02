import type { BossJobItem, ConditionEvidence, WorkRequirement } from '../types.js';
import { assessDailyWorkHours, assessWorkConditions } from './work-conditions.js';

const unknown = (): ConditionEvidence => ({ status: 'unknown', evidence: '' });
const evidence = (status: ConditionEvidence['status'], value: string): ConditionEvidence => ({ status, evidence: value.slice(0, 500) });
const numberWords: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 };

function verifyExplicit(text: string, yes: RegExp, no: RegExp, uncertain?: RegExp): ConditionEvidence {
  const positives = [...text.matchAll(new RegExp(yes.source, 'g'))].filter((match) =>
    !/(?:不|未|无|没|没有|无需|取消|并非|不是|无法保证)[^，。；;\n]{0,6}$/.test(text.slice(Math.max(0, match.index! - 12), match.index)));
  const positive = positives[0];
  // Mask negative phrases before looking for a conflicting affirmative phrase.
  let masked = text;
  for (const match of positives.reverse()) masked = masked.slice(0, match.index) + ' '.repeat(match[0].length) + masked.slice(match.index! + match[0].length);
  const negative = masked.match(no);
  const doubt = uncertain && text.match(uncertain);
  if (doubt || (positive && negative)) return evidence('unknown', doubt?.[0] || positive![0] + '；' + negative![0]);
  return negative ? evidence('not_met', negative[0]) : positive ? evidence('met', positive[0]) : unknown();
}

/** Compile only a complete, unambiguous requirement; compound/semantic rules stay with AI. */
export function assessLocalRequirement(job: BossJobItem, detail: string, requirement: WorkRequirement): ConditionEvidence | undefined {
  const text = requirement.text.trim().replace(/[。！!\s]+$/g, '').replace(/\s+/g, '');
  const source = detail + '\n' + (job.welfareList || []).join('\n');
  const flags = { eightHours: false, doubleRest: false, noExperience: false };
  let preset = requirement.builtin;
  if (!preset && /^(?:每周|周末)?(?:必须|固定)?双休$|^每周休(?:息)?[两二2]天$/.test(text)) preset = 'doubleRest';
  if (!preset && /^(?:(?:允许|接受|欢迎|可接受)(?:无(?:工作)?经验|零经验|小白)(?:入职|上岗)?|经验不限|(?:不要求|无需)(?:工作)?经验)$/.test(text)) preset = 'noExperience';
  if (!preset && /^(?:每天工作不超过八小时|[八8]小时工作制)$/.test(text)) preset = 'eightHours';
  if (preset) { flags[preset] = true; return assessWorkConditions(job, detail, flags)[preset]; }
  const hours = text.match(/^(?:每天|每日|日工时)(?:工作)?(?:不超过|最多|至多|小于等于)(\d+(?:\.\d+)?|[一二两三四五六七八])(?:个)?小时$/);
  if (hours) {
    const limit = numberWords[hours[1]] ?? Number(hours[1]);
    if (limit > 0 && limit <= 8) return assessDailyWorkHours(source, limit);
  }
  if (/^(?:不做销售|不涉及销售|非销售岗位|不要销售岗位)$/.test(text)) {
    const result = verifyExplicit(source, /(?:不涉及|无需承担|不承担|不需要做|不做)(?:任何)?销售(?:任务|工作|指标|职责)?(?!经验)|(?:没有|无)(?:任何)?销售(?:任务|工作|指标|职责)/,
      /(?:负责|需要|要求|从事|开展).{0,6}销售|销售(?:任务|目标|指标|业绩)|陌生拜访|推销产品/);
    if (/销售|营销/.test(job.jobName)) return result.status === 'met' ? evidence('unknown', job.jobName + '；' + result.evidence)
      : evidence('not_met', job.jobName);
    return result;
  }
  if (/^(?:必须|需要|要求)?(?:入职(?:即|就)?(?:缴纳|购买|提供)|缴纳|购买|提供|有)五险一金$/.test(text)) {
    const entry = text.includes('入职');
    const result = verifyExplicit(source, entry ? /入职(?:即|就|当天|后)?(?:缴纳|购买|提供|享有)五险一金/ : /(?:(?:缴纳|购买|提供|享有|含|有)\s*)?五险一金/,
      /(?:不缴纳|不购买|不提供|没有|无).{0,3}(?:五险一金|社保|公积金)/,
      /(?:可申请|自行|自费|视情况|计划|希望|有望|可能).{0,6}五险一金|五险一金.{0,6}(?:可申请|自行|自费|视情况|办理|核算|管理|经验)/);
    const delayed = entry && source.match(/(?:转正|试用期结束).{0,6}(?:缴纳|购买|提供).{0,3}五险一金/);
    if (delayed) return evidence(result.status === 'met' ? 'unknown' : 'not_met', delayed[0]);
    return result;
  }
  if (/^(?:不上夜班|不接受夜班|不做夜班|只(?:接受|上|做)白班|仅白班)$/.test(text)) {
    const result = verifyExplicit(source, /(?:只上|仅|长|固定|纯)白班|(?:不上|无|没有|不安排)夜班/,
      /(?:需要|必须|安排|有|需上|要上|需)夜班|两班倒|三班倒|轮班制/);
    const mentioned = source.replace(/(?:不上|无|没有|不安排)夜班/g, '').match(/夜班|晚班/);
    return mentioned && result.status !== 'not_met' ? evidence('unknown', source.slice(0, 500)) : result;
  }
  if (/^(?:不加班|无需加班|不接受加班|不要加班)$/.test(text)) {
    const doubt = source.match(/(?:不能|无法|不)保证.{0,5}(?:不|无)加班|不强制加班/);
    if (doubt) return evidence('unknown', doubt[0]);
    return verifyExplicit(source, /(?:无需|不需要|不用|无|不)加班/,
      /加班|996|007/);
  }
  // Explicit text operators let new keyword rules be added without changing code.
  const literal = requirement.text.trim().match(/^(必须包含|不得包含)[：:]\s*(.{2,100})$/);
  if (literal) {
    const term = literal[2].trim();
    const fields = [detail, job.jobName, job.brandName, job.brandIndustry, ...(job.skills || []), ...(job.welfareList || [])];
    const hit = fields.find((field) => field.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
    const met = literal[1] === '必须包含' ? Boolean(hit) : !hit;
    return evidence(met ? 'met' : 'not_met', hit ? term : '已检查岗位标题、描述和标签，未包含「' + term + '」');
  }
  return undefined;
}
