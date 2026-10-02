import type { AppConfig } from '../types.js';

export interface CandidateLanguageContext { text: string; source: 'resume' | 'requirements'; }
export interface LanguageRequirement { language: string; evidence: string; level: number; dialect?: string; }
interface Language { name: string; pattern: RegExp; }
const languages: Language[] = [
  { name: '英语', pattern: /英语|英文|雅思|托福|\bEnglish\b|\bIELTS\b|\bTOEFL\b|\b(?:CET|TEM)[ -]?[468]\b/i },
  { name: '西班牙语', pattern: /西班牙语|西语|\bSpanish\b/i },
  { name: '葡萄牙语', pattern: /葡萄牙语|葡语|\bPortuguese\b/i },
  { name: '日语', pattern: /日语|日文|日本语|\bJapanese\b|\bJLPT\b/i },
  { name: '韩语', pattern: /韩语|韩文|韩国语|朝鲜语|\bKorean\b|\bTOPIK\b/i },
  { name: '法语', pattern: /法语|法文|\bFrench\b/i },
  { name: '德语', pattern: /德语|德文|\bGerman\b/i },
  { name: '俄语', pattern: /俄语|俄文|\bRussian\b/i },
  { name: '阿拉伯语', pattern: /阿拉伯语|阿语|\bArabic\b/i },
  { name: '意大利语', pattern: /意大利语|意语|\bItalian\b/i },
  { name: '泰语', pattern: /泰语|泰文|\bThai\b/i },
  { name: '越南语', pattern: /越南语|越语|\bVietnamese\b/i },
  { name: '印尼语', pattern: /印尼语|印度尼西亚语|\bIndonesian\b/i },
  { name: '马来语', pattern: /马来语|\bMalay\b/i },
  { name: '印地语', pattern: /印地语|\bHindi\b/i },
  { name: '土耳其语', pattern: /土耳其语|\bTurkish\b/i },
  { name: '波兰语', pattern: /波兰语|\bPolish\b/i },
  { name: '荷兰语', pattern: /荷兰语|\bDutch\b/i },
  { name: '希伯来语', pattern: /希伯来语|\bHebrew\b/i },
  { name: '乌克兰语', pattern: /乌克兰语|\bUkrainian\b/i },
  { name: '波斯语', pattern: /波斯语|\bPersian\b|\bFarsi\b/i },
  { name: '孟加拉语', pattern: /孟加拉语|\bBengali\b/i },
  { name: '乌尔都语', pattern: /乌尔都语|\bUrdu\b/i },
  { name: '高棉语', pattern: /高棉语|柬埔寨语|\bKhmer\b/i },
  { name: '泰米尔语', pattern: /泰米尔语|\bTamil\b/i },
  { name: '斯瓦希里语', pattern: /斯瓦希里语|\bSwahili\b/i },
];
const normalize = (text: string) => text.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '');
const certificateText = (text: string) => normalize(text)
  .replace(/日语(?:能力考试|能力考)?([一二三四五1-5])级/g, (_match, digit: string) => '日语N' + ('一二三四五'.indexOf(digit) >= 0 ? '一二三四五'.indexOf(digit) + 1 : digit))
  .replace(/英语专业八级/g, '英语TEM8').replace(/英语专业四级/g, '英语TEM4').replace(/四级/g, 'CET4').replace(/六级/g, 'CET6');
const clauses = (text: string) => normalize(text).split(/[\n。；;，,!?！？]/).map(item => item.trim()).filter(Boolean);
const hard = /必须|必备|硬性|核心要求|至少|需(?:要)?|要求|熟练|精通|流利|听懂|能(?:够)?(?:听|说|读|写)|掌握|具备|达到|母语|无障碍|翻译|转写|听写|四级|六级|[四六]级|雅思|托福|\b(?:IELTS|TOEFL|TOPIK)\b|\b(?:CET|TEM)[ -]?[468]\b|\bN[1-5]\b|\b[ABC][12]\b/i;
const positive = /母语|熟练|精通|流利|无障碍|fluent|native|良好|听说读写|读写|能(?:够)?(?:听|说|读|写)|熟悉|日常交流|掌握|会(?:说|用)?|基础|入门|了解|四级|六级|[四六]级|雅思|托福|\b(?:IELTS|TOEFL|TOPIK)\b|\b(?:CET|TEM)[ -]?[468]\b|\bN[1-5]\b|\b[ABC][12]\b/i;

function optional(clause: string, language: Language): boolean {
  const match = language.pattern.exec(clause);
  if (!match) return false;
  const before = clause.slice(Math.max(0, match.index - 20), match.index).replace(/\s+/g, '');
  const after = clause.slice(match.index + match[0].length, match.index + match[0].length + 35).replace(/\s+/g, '');
  if (/不要求(?:掌握|具备|熟悉|会|懂|有)?$|无需(?:掌握|具备|熟悉|会|懂|有)?$|不需要(?:掌握|具备|熟悉|会|懂|有)?$/.test(before)
    || /^(?:能力|水平|基础|证书)?(?:不作要求|不要求|不限|无要求|不是必须|非必需|零基础)/.test(after)) return true;
  return /优先|加分|更佳|更好|为佳|可培训|可以培训|可从零学/.test(clause) && !/必须|必备|硬性|核心要求|至少/.test(clause);
}

function level(text: string): number {
  text = certificateText(text);
  if (/母语|\bnative\b/i.test(text)) return 4;
  if (/熟练|精通|流利|无障碍|\bfluent\b|\bC[12]\b/i.test(text)) return 3;
  if (/良好|听说读写|读写|能(?:够)?(?:听|说|读|写)|熟悉|日常交流|\bB[12]\b|四级|六级|[四六]级|\b(?:CET|TEM)[ -]?[468]\b|\bN[12]\b/i.test(text)) return 2;
  return 1;
}

function dialect(text: string): string | undefined {
  if (!/本土|本地|当地口音|方言|美式|英式|拉美/.test(text)) return undefined;
  const cleaned = text.replace(/^.*(?:掌握|聆听|听懂|熟悉|精通|要求)/, '').replace(/^\s*\d+[.、)]\s*/, '');
  return cleaned.match(/^([\u3400-\u9fff]{2,10}?)(?:本土|本地)/)?.[1]
    || text.match(/哥斯达黎加|墨西哥|阿根廷|哥伦比亚|拉美|关西|魁北克|美式|英式/)?.[0];
}

export function requiredLanguages(job: { jobName: string; skills?: string[] }, detail: string): LanguageRequirement[] {
  const result: LanguageRequirement[] = [];
  const parts = clauses(detail);
  for (const language of languages) {
    const mentioned = parts.filter(part => language.pattern.test(part) && !/英文版|英文字母|英文键盘|英文标点/.test(part));
    const mandatory = mentioned.filter(part => !optional(part, language) && hard.test(certificateText(part)));
    const titleOrTag = [job.jobName, ...(job.skills || [])].filter(part => language.pattern.test(normalize(part)) && !optional(normalize(part), language));
    // A title/tag can establish a language requirement, unless the description explicitly makes it optional.
    const evidence = mandatory.length ? mandatory : mentioned.some(part => optional(part, language)) ? [] : titleOrTag;
    for (const part of evidence) result.push({ language: language.name, evidence: part, level: level(part), ...(dialect(part) ? { dialect: dialect(part) } : {}) });
  }
  return result;
}

function capabilityClauses(profile: string, candidate?: CandidateLanguageContext): string[] {
  return [...clauses(profile), ...clauses(candidate?.text || '').filter(part => candidate?.source !== 'requirements'
    || /我(?:的)?|本人|具备|已通过|持有|获得/.test(part))]
    .filter(part => !/不会|不懂|不熟悉|不熟练|不需要会|不要求会|未通过|没有.{0,5}(?:能力|证书)|口语不好|不擅长|准备考|计划|希望|打算|想找|想做|想申请|正在学|初学|岗位要求|招聘要求|任职要求/.test(part));
}

function certificateMet(requirement: string, ability: string): boolean {
  const wanted = certificateText(requirement); const available = certificateText(ability);
  const cet = wanted.match(/\bCET[ -]?([46])\b/i);
  if (cet && ![...available.matchAll(/\b(?:CET|TEM)[ -]?([468])\b/ig)].some(match => Number(match[1]) >= Number(cet[1]))) return false;
  const tem = wanted.match(/\bTEM[ -]?([48])\b/i);
  if (tem && ![...available.matchAll(/\bTEM[ -]?([48])\b/ig)].some(match => Number(match[1]) >= Number(tem[1]))) return false;
  const jlpt = wanted.match(/\bN([1-5])\b/i);
  if (jlpt && ![...available.matchAll(/\bN([1-5])\b/ig)].some(match => Number(match[1]) <= Number(jlpt[1]))) return false;
  const cefr = wanted.match(/\b([ABC][12])\b/i);
  const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  if (cefr && ![...available.matchAll(/\b([ABC][12])\b/ig)].some(match => levels.indexOf(match[1].toUpperCase()) >= levels.indexOf(cefr[1].toUpperCase()))) return false;
  for (const family of ['(?:雅思|IELTS)', '(?:托福|TOEFL)', 'TOPIK']) {
    const exam = new RegExp(family + '\\s*(口语|写作|听力|阅读|总分)?\\s*(?:成绩|分数|达到)?\\s*(\\d+(?:\\.\\d+)?)', 'i');
    const threshold = wanted.match(exam);
    if (threshold) {
      const actual = available.match(new RegExp(family + '\\s*' + (threshold[1] || '(?:总分)?') + '\\s*(?:成绩|分数|达到)?\\s*(\\d+(?:\\.\\d+)?)', 'i'));
      if (!actual || Number(actual[1]) < Number(threshold[2])) return false;
    }
  }
  return true;
}

export function candidateLanguageEvidence(profile = '', candidate?: CandidateLanguageContext): string {
  const parts = capabilityClauses(profile, candidate);
  const withLanguage = parts.filter(part => languages.some(language => language.pattern.test(part)) && positive.test(certificateText(part)));
  return parts.filter(part => withLanguage.includes(part) || (withLanguage.length && /口音|方言|本地人/.test(part) && positive.test(part))).join('；').slice(0, 2000);
}

/** An unverified mandatory foreign-language skill never becomes a work-schedule review. */
export function languageQualificationIssue(job: { jobName: string; skills?: string[] }, detail: string,
  filter: Pick<AppConfig['filter'], 'candidateLanguages'>, candidate?: CandidateLanguageContext): string | undefined {
  // Read the description before rejecting a language title/tag: it may say 优先 or 可培训.
  if (!detail.trim()) return undefined;
  const abilities = capabilityClauses(filter.candidateLanguages || '', candidate);
  const evidenceText = abilities.join('\n');
  for (const requirement of requiredLanguages(job, detail)) {
    const language = languages.find(item => item.name === requirement.language)!;
    const matches = abilities.filter(part => language.pattern.test(part) && positive.test(certificateText(part)));
    const sufficient = matches.some(part => level(part) >= requirement.level && certificateMet(requirement.evidence, part));
    const specific = !requirement.dialect || new RegExp('(?:熟悉|听懂|掌握|理解|能听|母语).{0,15}' + requirement.dialect + '.{0,20}(?:口音|方言|西班牙语|西语|英语|本土)|'
      + requirement.dialect + '.{0,20}(?:口音|方言).{0,10}(?:熟悉|听懂|无障碍|流利)|' + requirement.dialect + '(?:本地人|人)').test(evidenceText);
    if (!sufficient || !specific) return '语言硬要求未满足：' + requirement.language + (requirement.dialect ? '（' + requirement.dialect + '口音）' : '')
      + '；未提供达到岗位要求的能力依据。岗位原文：' + requirement.evidence.slice(0, 220);
  }
  return undefined;
}
