import type { AppConfig, BossCompanyInfo, BossJobItem } from '../types.js';

export interface JobExclusionRule { term: string; literal: boolean; }
export interface JobExclusionEvidence {
  jobName: string;
  brandName: string;
  brandIndustry?: string;
  skills?: string[];
  jobDetail?: string;
  companyInfo?: BossCompanyInfo;
}
export interface JobExclusionMatch { term: string; field: string; evidence: string; reason: string; }

const normalize = (value: string) => value.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').toLocaleLowerCase();
const finance = /金融|银行|证券|期货|基金(?!会)|保险|信托|信贷|贷款|助贷|理财|融资|投资(?:\/融资|管理|公司|咨询)?|催收/;
const property = /房地产|房产|地产开发|地产经纪|房屋中介|房产中介|房屋租售|置业/;
const sales = /销售|营销|电销|网销|推销|地推|商务拓展|业务拓展|房产经纪|置业顾问|招商(?:专员|经理|顾问)/;
const negativePrefix = /(?:不(?:做|涉及|承担|从事|需要(?:做|承担)?|负责|接受|考虑|要求(?:承担)?)?|不得(?:从事|涉及|开展|经营|提供|发放)?|禁止(?:从事|经营|发放)?|无需(?:做|承担)?|非|没有|无|并非|不是|拒绝|杜绝|避免)(?:任何|相关|这类|该类)?$/;

function positiveMatch(value: string, pattern: RegExp): string | undefined {
  const text = normalize(value);
  for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
    const businessOffset = match[0].search(/金融|银行|证券|期货|基金|保险|信贷|贷款|助贷|融资|理财|房地产|房产|销售|营销/);
    const start = match.index! + Math.max(0, businessOffset);
    if (negativePrefix.test(text.slice(Math.max(0, start - 15), start))) continue;
    return text.slice(Math.max(0, match.index! - 25), Math.min(text.length, match.index! + match[0].length + 50)).trim();
  }
  return undefined;
}

function category(term: string): 'finance' | 'property' | 'sales' | undefined {
  if (/^(?:金融|金融业|金融行业)$/.test(term)) return 'finance';
  if (/^(?:房地产|房产|房地产行业)$/.test(term)) return 'property';
  if (/^(?:销售|销售岗|销售岗位|销售工作|营销|营销岗)$/.test(term)) return 'sales';
  return undefined;
}

/** Extract only explicit exclusions. The rest of a compound requirement still needs its own assessment. */
export function exclusionsFromText(value: string): JobExclusionRule[] {
  const rules: JobExclusionRule[] = [];
  const literal = value.trim().match(/^不得包含[：:]\s*(.{2,100})$/);
  if (literal) return [{ term: literal[1].trim(), literal: true }];
  if (/^非销售(?:岗位|职位|工作)?$/.test(value.trim())) return [{ term: '销售', literal: false }];
  for (const match of value.matchAll(/(?:不(?:做|要|接受|考虑|从事|涉及|投递)|拒绝|排除|避开|淘汰)\s*([^，,。；;\n！？!?]{2,100})/g)) {
    // A condition such as “不考虑金融，必须双休” must not become one giant keyword.
    const subjects = match[1].split(/[、/|]|以及|或者|或|和|及/);
    for (let subject of subjects) {
      subject = subject.trim().replace(/(?:的)?(?:相关)?(?:行业|岗位|职位|工作|公司|业务)(?:的)?(?:岗位|职位|工作)?$/g, '').trim();
      if (subject.length < 2 || subject.length > 40 || /必须|需要|希望|只接受|但|除外|不适合|经验|加班|夜班/.test(subject)) continue;
      rules.push({ term: subject, literal: false });
    }
  }
  return rules;
}

export function configuredJobExclusions(filter: AppConfig['filter'], extraText = ''): JobExclusionRule[] {
  const rules = (filter.companyBlacklist || []).filter(Boolean).map((term) => ({ term, literal: false }));
  for (const requirement of filter.workRequirements || []) {
    if (requirement.enabled) rules.push(...exclusionsFromText(requirement.text));
  }
  rules.push(...exclusionsFromText(extraText));
  return [...new Map(rules.map((rule) => [normalize(rule.term) + ':' + rule.literal, rule])).values()];
}

export function needsCompanyIndustry(filter: AppConfig['filter'], extraText = ''): boolean {
  return configuredJobExclusions(filter, extraText).some((rule) => category(normalize(rule.term)) !== 'sales')
    || (filter.workRequirements || []).some((item) => item.enabled && /公司|企业|行业|主营|经营范围/.test(item.text))
    || /公司|企业|行业|主营|经营范围/.test(extraText);
}

export function unresolvedCompanyBusiness(job: JobExclusionEvidence, filter: AppConfig['filter'], extraText = ''): string[] {
  const company = job.companyInfo;
  if (!company || company.introduction.trim()
    || !/互联网|企业服务|商务服务|咨询|专业服务|其他/.test(company.industry)) return [];
  // Broad industry labels plus a list of permitted activities do not establish a company's main business.
  return configuredJobExclusions(filter, extraText).filter((rule) => category(normalize(rule.term)) !== 'sales')
    .map((rule) => rule.term);
}

/** Reject affirmative evidence before missing work conditions, model calls, or the review queue. */
export function findJobExclusion(job: JobExclusionEvidence | BossJobItem, filter: AppConfig['filter'],
  extraText = '', taskRules: JobExclusionRule[] = []): JobExclusionMatch | undefined {
  const fields = [
    { name: '公司名称', value: job.brandName || '', metadata: true },
    { name: '公司行业', value: job.brandIndustry || '', metadata: true },
    { name: '公司页行业', value: job.companyInfo?.industry || '', metadata: true },
    { name: '岗位名称', value: job.jobName || '', metadata: false },
    { name: '岗位标签', value: (job.skills || []).join('；'), metadata: false },
    { name: '岗位职责', value: 'jobDetail' in job ? job.jobDetail || '' : '', metadata: false },
    { name: '公司介绍', value: job.companyInfo?.introduction || '', metadata: false },
    { name: '公司经营范围', value: job.companyInfo?.businessScope || '', metadata: false },
  ];
  for (const rule of [...configuredJobExclusions(filter, extraText), ...taskRules]) {
    const term = normalize(rule.term);
    if (!term) continue;
    const kind = rule.literal ? undefined : category(term);
    for (const field of fields) {
      let value = field.value;
      let pattern: RegExp;
      const businessField = ['岗位职责', '公司介绍', '公司经营范围'].includes(field.name);
      if (!rule.literal && field.name === '公司经营范围') {
        value = value.replace(/[（(][^）)]*(?:不含|不包含|不包括|不得从事|不得经营|除外)[^）)]*[）)]/g, ' ');
      }
      if (kind === 'finance') {
        pattern = field.name === '公司经营范围'
          ? /助贷|信贷中介|贷款(?:中介|咨询|撮合)|融资(?:咨询|担保|中介|服务)|小额贷款|发放贷款|保险(?:代理|经纪)|证券(?:经纪|投资咨询)|期货经纪|信托业务|金融(?:服务|业务|信息咨询)|投资咨询/
          : field.metadata ? finance : businessField
          ? /助贷|信贷中介|贷款中介|贷款咨询|贷款撮合|抵押贷款|信用贷款|融资(?:咨询|服务|顾问|业务|方案|中介)|企业融资|投资咨询|金融(?:行业|业务|产品|服务|机构|科技|信息咨询)|(?:银行|证券|期货|基金|信托|信贷|贷款|理财|保险|信用卡|催收)(?:行业|业务|产品|客户|销售|推广|营销|顾问|服务|办理|申请|专员|经纪|代理|系统)|(?:办理|推广|销售|推销|申请|审核|催收).{0,10}(?:贷款|信贷|信用卡|保险产品|理财产品)|(?:银行|保险|证券|信贷|贷款)公司|(?:银行|证券)全资子公司/
          : finance;
        // Employee benefits and routine bookkeeping do not establish a financial industry.
        if (!field.metadata) value = value.replace(/(?:补充)?(?:医疗|养老|失业|工伤|生育|社会)保险|银行(?:转账|对账|流水|付款)|公益基金会/g, ' ');
      } else if (kind === 'property') {
        pattern = field.name === '公司经营范围' ? /房地产开发|房地产经纪|房地产中介|房产中介|住宅开发|楼盘销售/
          : businessField ? /房地产|房产(?:销售|经纪|中介|行业|业务|客户)|房屋(?:中介|租售)|置业顾问|带客看房|楼盘销售|地产开发/ : property;
      } else if (kind === 'sales') {
        // A company's registered permission to sell products does not make every role a sales role.
        if (!['岗位名称', '岗位标签', '岗位职责'].includes(field.name)) continue;
        pattern = field.name === '岗位职责'
          ? /电销|网销|电话(?:销售|营销)|销售(?:任务|目标|指标|业绩|提成)|(?:负责|从事|开展|承担)[^，。；;\n]{0,10}销售|(?:推销|销售|推广)(?:公司)?产品|陌生拜访|(?:开发|拓展).{0,4}(?:新)?客户|促成.{0,8}(?:交易|订单|签约|成交)|邀约.{0,6}客户.{0,8}(?:购买|成交)|(?:邀约|邀请)[^，。；;\n]{0,10}(?:试听|体验)课|课程(?:销售|顾问|推广)|招生(?:顾问|专员|推广|指标|任务)/
          : sales;
      } else {
        pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }
      const hit = rule.literal ? (normalize(value).includes(term) ? rule.term : undefined) : positiveMatch(value, pattern);
      if (hit) return { term: rule.term, field: field.name, evidence: hit,
        reason: '命中排除条件「' + rule.term + '」：' + field.name + '「' + hit + '」' };
    }
  }
  return undefined;
}
