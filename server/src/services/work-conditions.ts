import type { BossJobItem, ConditionEvidence, WorkConditions, WorkConditionAssessment } from '../types.js';

export const WORK_CONDITION_LABELS: Record<keyof WorkConditions, string> = {
  eightHours: '每天工作不超过八小时', doubleRest: '每周双休', noExperience: '允许无经验入职',
};
export const CONDITION_KEYS = Object.keys(WORK_CONDITION_LABELS) as (keyof WorkConditions)[];

const proof = (status: ConditionEvidence['status'], evidence = ''): ConditionEvidence => ({ status, evidence: evidence.slice(0, 500) });
function matchProof(text: string, pattern: RegExp, status: ConditionEvidence['status']): ConditionEvidence | undefined {
  const match = text.match(pattern);
  return match ? proof(status, match[0]) : undefined;
}
function hoursIn(text: string): number | undefined {
  const numbers: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
  const match = text.match(/(\d+(?:\.\d+)?|十二|十一|[一二两三四五六七八九十])\s*(?:个)?小时/);
  return match ? (numbers[match[1]] ?? Number(match[1])) : undefined;
}
export function assessDailyWorkHours(text: string, maxHours = 8): ConditionEvidence {
  const uncheckedOvertime = matchProof(text, /(?:无法|不能|不)保证.{0,4}(?:不|无).{0,3}加班/, 'unknown');
  if (uncheckedOvertime) return uncheckedOvertime;
  const checkedText = text.replace(/(?:无需|不需要|不要求|不强制|不必|不用|禁止|拒绝|没有).{0,4}加班|无(?:强制)?加班|(?:不实行|不执行|拒绝|告别|非|不是|不)(?:996|007)/g, (value) => ' '.repeat(value.length));
  const forbidden = matchProof(checkedText, /(?:996|007|(?:必须|需要|要求|强制|经常|频繁).{0,8}加班|加班.{0,6}(?:至|到)(?:深夜|凌晨|晚上)|(?:不|无法|不能)保证.{0,5}(?:八|8)小时)/, 'not_met');
  if (forbidden) return forbidden;
  // A stated working day plus overtime uncertainty is not an eight-hour promise.
  const uncertain = matchProof(checkedText, /[^。；;\n]{0,12}加班[^。；;\n]{0,12}|弹性.{0,6}(?:工时|工作时间)/, 'unknown');
  if (uncertain) return uncertain;
  let positive: ConditionEvidence | undefined;
  let dailyDurationCount = 0;
  for (const line of text.split(/[。\n；;]/)) {
    const daily = /(?:每天|每日|一天|单日|每班|日工时|工作|上班|工时)/.test(line) || /(?:八|8)\s*小时(?:工作)?制/.test(line);
    if (daily && !/(?:培训|课程|学习).{0,8}小时/.test(line)) {
      const durations = [...line.matchAll(/(?:\d+(?:\.\d+)?\s*[-~至]\s*)?(\d+(?:\.\d+)?|十二|十一|[一二两三四五六七八九十])\s*(?:个)?小时/g)].filter((match) => {
        const before = line.slice(Math.max(0, match.index! - 16), match.index);
        return !/(?:午休|休息|培训|课程|学习|用餐|每周|每月|周工时|月工时).{0,8}$/.test(before);
      });
      for (const duration of durations) {
        dailyDurationCount++;
        const before = line.slice(Math.max(0, duration.index! - 12), duration.index);
        const after = line.slice(duration.index! + duration[0].length);
        if (/(?:不少于|不低于|至少|最少|不保证)\s*$/.test(before) || /^\s*(?:以上|起|及以上)/.test(after)) return proof('unknown', line);
        const value = hoursIn(duration[0].replace(/^\d+(?:\.\d+)?\s*[-~至]\s*/, ''));
        if (value != null && value > maxHours) return proof('not_met', line);
        if (value != null && value > 0) positive = proof('met', line);
      }
    }
    const clock = /(\d{1,2})[:：](\d{2})\s*[-~—至到]\s*(\d{1,2})[:：](\d{2})/g;
    const ranges = [...line.matchAll(clock)];
    let span: number | undefined;
    if (ranges.length === 1) {
      const range = ranges[0];
      const start = Number(range[1]) + Number(range[2]) / 60;
      const end = Number(range[3]) + Number(range[4]) / 60;
      if (start < 24 && end <= 24 && Number(range[2]) < 60 && Number(range[4]) < 60) span = (end - start + 24) % 24;
    } else if (/朝九晚六|早九晚六/.test(line)) span = 9;
    else if (/朝九晚五|早九晚五/.test(line)) span = 8;
    if (span != null && /(?:上班|工作|作息|朝九|早九)/.test(line)) {
      const rest = line.match(/(?:午休|中午休息|休息时间)\s*[:：]?\s*(\d+(?:\.\d+)?|[一二两三])\s*(?:个)?小时/);
      const restHours = rest ? hoursIn(rest[0]) : undefined;
      if (restHours != null && restHours >= span) return proof('unknown', line);
      if (restHours != null || span <= maxHours) {
        const actual = span - (restHours || 0);
        if (actual > maxHours) return proof('not_met', line);
        if (actual > 0) positive = proof('met', line);
      }
    }
  }
  if ([...text.matchAll(/\d{1,2}[:：]\d{2}\s*[-~—至到]\s*\d{1,2}[:：]\d{2}/g)].length > 1) {
    return proof('unknown', '多个时段，需确认每天总工时：' + text.slice(0, 250));
  }
  if (dailyDurationCount > 1) return proof('unknown', '多段工时，需确认每天总工时：' + text.slice(0, 250));
  return positive || proof('unknown');
}
function inspectRest(text: string): ConditionEvidence {
  text = text.replace(/(?:不实行|不执行|不是|没有|拒绝|告别|非|不)(?:大小周|单双休|单休)/g, (value) => ' '.repeat(value.length));
  text = text.replace(/(?:无需|不需要|不要求|不强制|不必|不用|没有).{0,4}加班|无(?:强制)?加班/g, (value) => ' '.repeat(value.length));
  const bad = matchProof(text, /(?:大小周|单双休|隔周双休|(?:不保证|无法保证|不是|非|没有|不实行)\s*(?:每周|周末)?双休|不\s*双休|双休.{0,6}(?:取消|改为单休|不保证)|(?:每周|周)[休息]*[一1](?:天|日)|月休[四五六4-6](?:天|日)?)/, 'not_met');
  if (bad) return bad;
  // Don't turn "不是单休" into a rejection, or "不保证双休" into a match.
  const single = [...text.matchAll(/单休/g)].find((match) => !/(?:不是|无需|没有|非|不实行)$/.test(text.slice(Math.max(0, match.index! - 5), match.index)));
  if (single) return proof('not_met', text.slice(Math.max(0, single.index! - 8), single.index! + 12));
  const uncertain = matchProof(text, /(?:可(?:以)?申请|视.{0,6}情况|尽量|争取|偶尔).{0,4}双休|双休.{0,8}(?:需|要|可能|偶尔).{0,5}(?:加班|上班)|休息.{0,6}不固定/, 'unknown');
  if (uncertain) return uncertain;
  return matchProof(text, /(?:周末)?双休|周六[、和及与]?周日(?:固定)?休息|每周.{0,3}休(?:息)?[两二2](?:天|日)|周休[两二2](?:天|日)|(?:一周|每周)(?:只)?工作[五5]天|五天(?:八|8)?小时?(?:工作)?制|五天工作制/, 'met') || proof('unknown');
}
function inspectExperience(text: string, cardExperience: string, mode: 'flexible' | 'strict'): ConditionEvidence {
  const denied = /无(?:工作|相关)?经验[^。，,；;\n]{0,4}(?:勿投|请勿|不接受|不能|不考虑|不行|不可)|无(?:工作|相关)?经验(?:者|人员)?不收|(?:不接受|不招|不考虑|不欢迎|不能接受|不可接受|拒绝).{0,3}(?:无(?:工作|相关)?经验|零经验|小白)|(?:并非|不是|非)经验不限/g;
  const bad = matchProof(text, denied, 'not_met');
  const positiveText = text.replace(denied, (value) => ' '.repeat(value.length));
  const positive = matchProof(positiveText, /经验不限|不(?:要求|需要)(?:具备|有)?(?:相关|工作|行业)?经验|无需(?:具备|有)?(?:相关|工作|行业)?经验|(?:无|没有)(?:相关|工作)?经验要求|有无(?:工作)?经验(?:均|都)?可|(?:无|没有)(?:相关|工作)?经验(?:者|人员|也|均|都)?(?:可|能)|(?:接受|欢迎|可接受)(?:无(?:工作)?经验|零经验|小白)|(?:无(?:工作)?经验|零经验|小白).{0,4}(?:入职|上岗|带薪培训|可培训)|零经验可/, 'met');
  const cardAllows = /^(?:经验不限|不限|无经验)$/.test(cardExperience.trim());
  let mandatory = bad;
  let preference: ConditionEvidence | undefined;
  for (const line of text.split(/[。，,；;\n]|但是|但|不过|然而|且必须/)) {
    if (/不要求|不需要|无需|经验不限|无经验.*可/.test(line)) continue;
    if (/优先|加分/.test(line) && !/必须|至少|最低/.test(line)) continue;
    const years = matchProof(line, /(?:\d+\s*[-~至]\s*)?[一二三四五六七八九十\d]+年(?:以上|及以上)?.{0,8}(?:工作|行业|相关)?经验|(?:工作经验|经验要求).{0,5}(?:\d+\s*[-~至]\s*)?[一二三四五六七八九十\d]+年|(?:必须|需具备|需要具备|要求具备|需要有|要求有|需有|硬性要求).{0,12}经验/, 'not_met');
    if (years) {
      if (mode === 'strict' || /必须|至少|最低|硬性|必备|需具备|需要具备|要求具备|需要有|要求有|需有/.test(line)) mandatory = years;
      else preference = proof('unknown', '正文经验条件需确认：' + line.trim());
    }
  }
  const cardRequires = /\d+\s*(?:[-~至]\s*\d+)?\s*年|[一二三四五六七八九十]年以上/.test(cardExperience)
    && !/不限|以内|以下/.test(cardExperience);
  if ((mandatory && (positive || (mode === 'strict' && cardAllows))) || (mode === 'strict' && cardRequires && positive)) {
    return proof('unknown', '经验要求有冲突：' + (positive?.evidence || '岗位经验要求：' + cardExperience) + '；' + (mandatory?.evidence || '岗位经验要求：' + cardExperience));
  }
  if (mode === 'flexible') {
    return mandatory || positive || preference || (cardAllows ? proof('met', '岗位经验要求：' + cardExperience)
      : proof('unknown', cardExperience.trim() ? '经验标签仅供参考「' + cardExperience.trim() + '」，需确认是否接受无经验' : ''));
  }
  return mandatory || (cardRequires ? proof('not_met', '岗位经验要求：' + cardExperience) : undefined)
    || positive || (cardAllows ? proof('met', '岗位经验要求：' + cardExperience) : proof('unknown'));
}

/** Additional checks for the three convenience presets; custom conditions use work-requirements.ts. */
export function assessWorkConditions(
  job: BossJobItem, detail: string, conditions: WorkConditions, experienceMode: 'flexible' | 'strict' = 'flexible',
): WorkConditionAssessment {
  const source = detail + '\n' + (job.welfareList || []).join('\n');
  const local = {
    eightHours: assessDailyWorkHours(source),
    doubleRest: inspectRest(source),
    noExperience: inspectExperience(source, job.jobExperience || '', experienceMode),
  };
  for (const key of CONDITION_KEYS) {
    if (!conditions[key]) local[key] = proof('unknown');
  }
  return local;
}
