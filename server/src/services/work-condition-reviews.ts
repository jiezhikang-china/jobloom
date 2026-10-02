import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AppConfig, WorkConditionReview, WorkRequirementAssessment, WorkRequirement } from '../types.js';
import { normalizeWorkRequirements, validateWorkRequirements } from './work-requirements.js';
import { configManager } from '../config/config.manager.js';
import { findJobExclusion } from './job-exclusions.js';
import { jobInformationIssue } from './job-information.js';
import { decodeBossText, readableBossSalary } from './boss-text.js';
import { languageQualificationIssue } from './language-qualification.js';

function canonicalJobUrl(value: string): string {
  const url = new URL(value, 'https://www.zhipin.com');
  if (url.protocol !== 'https:' || url.hostname !== 'www.zhipin.com' || url.port || url.username || url.password
    || !/^\/job_detail\/[^/]+\.html$/.test(url.pathname)) throw new Error('岗位链接无效');
  url.search = ''; url.hash = '';
  return url.href;
}
const clipped = (value: string, limit = 500): string => String(value || '').slice(0, limit);
const reviewId = (url: string): string => createHash('sha256').update(url).digest('hex').slice(0, 20);

/** Private local shortlist. Never includes a resume, credential or an outbound message. */
export class WorkConditionReviews {
  constructor(private readonly file = path.resolve(process.cwd(), '../data/work-condition-reviews.json')) {}

  list(): WorkConditionReview[] {
    if (!fs.existsSync(this.file)) return [];
    const data: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!Array.isArray(data)) throw new Error('待确认岗位文件格式错误，已保留原文件');
    return data.map((item) => {
      if (!item || typeof item !== 'object') throw new Error('待确认岗位记录无效');
      const jobHref = canonicalJobUrl(item.jobHref);
      if (item.id !== reviewId(jobHref) || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) {
        throw new Error('待确认岗位记录无效');
      }
      const requirements = normalizeWorkRequirements(item.requirements, item.conditions);
      const previousAssessment = Array.isArray(item.assessment) ? item.assessment : requirements.map((requirement) => ({
        requirementId: requirement.id, text: requirement.text, ...item.assessment?.[requirement.builtin!],
      }));
      const assessment = this.cleanAssessment(previousAssessment, requirements);
      return {
        id: item.id, jobHref, jobName: clipped(item.jobName, 150), companyName: clipped(item.companyName, 150),
        salary: readableBossSalary(clipped(item.salary, 100)), reason: decodeBossText(clipped(item.reason)), question: clipped(item.question),
        requirements, assessment, updatedAt: item.updatedAt,
        ...(['rules', 'ai', 'cache'].includes(item.evaluationSource) ? { evaluationSource: item.evaluationSource } : {}),
        ...(Number.isFinite(item.score) && item.score >= 0 && item.score <= 100 ? { score: item.score } : {}),
        ...(item.screening ? { screening: this.cleanScreening(item.screening) } : {}),
      };
    }).slice(0, 200);
  }

  add(input: Omit<WorkConditionReview, 'id' | 'question' | 'updatedAt'>): WorkConditionReview {
    const jobHref = canonicalJobUrl(input.jobHref);
    const requirements = normalizeWorkRequirements(input.requirements);
    if (!validateWorkRequirements(requirements) || (!requirements.some((item) => item.enabled)
      && !(input.screening?.needsCompanyConfirmation === true && input.screening.companyInfo))) throw new Error('工作条件无效');
    const labels = requirements.filter((item) => item.enabled).map((item) => item.text);
    const item: WorkConditionReview = {
      id: reviewId(jobHref), jobHref,
      jobName: clipped(input.jobName, 150), companyName: clipped(input.companyName, 150), salary: readableBossSalary(clipped(input.salary, 100)),
      reason: clipped(input.reason), requirements, assessment: this.cleanAssessment(input.assessment, requirements),
      ...(input.evaluationSource ? { evaluationSource: input.evaluationSource } : {}),
      ...(input.score !== undefined ? { score: input.score } : {}),
      ...(input.screening ? { screening: this.cleanScreening(input.screening) } : {}),
      question: clipped('您好，' + (labels.length ? '想确认这个岗位是否满足：' + labels.join('、') + '？' : '')
        + (input.screening?.needsCompanyConfirmation ? '请说明公司的主要业务及该岗位的实际工作职责。' : '')
        + '能否说明具体安排及是否有未注明的入职条件？'),
      updatedAt: new Date().toISOString(),
    };
    const excluded = this.exclusionFor(item, configManager.getConfig().filter);
    if (excluded) throw new Error(typeof excluded === 'string' ? excluded : excluded.reason);
    const existing = this.list().filter((entry) => entry.id !== item.id);
    this.save([item, ...existing].slice(0, 200));
    return item;
  }

  remove(id: string): void {
    if (!/^[a-f0-9]{20}$/.test(id)) throw new Error('记录标识无效');
    this.save(this.list().filter((item) => item.id !== id));
  }

  removeForJob(jobHref: string): void {
    const id = reviewId(canonicalJobUrl(jobHref));
    const items = this.list();
    if (items.some((item) => item.id === id)) this.save(items.filter((item) => item.id !== id));
  }

  listEligible(filter = configManager.getConfig().filter): WorkConditionReview[] {
    return this.list().filter((item) => !this.exclusionFor(item, filter));
  }

  /** Keep a recoverable copy before removing records that contradict the current exclusions. */
  pruneExcluded(filter = configManager.getConfig().filter): { removed: number; backup?: string } {
    const items = this.list();
    const remaining = items.filter((item) => !this.exclusionFor(item, filter));
    if (remaining.length === items.length) return { removed: 0 };
    const backup = this.file + '.before-exclusions-' + Date.now() + '.bak';
    fs.copyFileSync(this.file, backup, fs.constants.COPYFILE_EXCL);
    this.save(remaining);
    return { removed: items.length - remaining.length, backup };
  }

  private exclusionFor(item: WorkConditionReview, filter: AppConfig['filter']) {
    return languageQualificationIssue({ jobName: item.jobName, skills: item.screening?.skills }, item.screening?.jobDetail || '', filter,
      { text: item.screening?.languageEvidence || '', source: 'resume' })
      || (item.screening && jobInformationIssue({ jobDetail: item.screening.jobDetail, companyInfo: item.screening.companyInfo }, filter))
      || findJobExclusion({ jobName: item.jobName, brandName: item.companyName,
      brandIndustry: item.screening?.industry, skills: item.screening?.skills,
      companyInfo: item.screening?.companyInfo,
      jobDetail: item.screening?.jobDetail || item.assessment.map((entry) => entry.evidence).join('\n') },
    filter, '', item.screening?.taskExclusions || []);
  }

  private cleanScreening(value: NonNullable<WorkConditionReview['screening']>): NonNullable<WorkConditionReview['screening']> {
    if (typeof value.industry !== 'string' || typeof value.jobDetail !== 'string' || value.jobDetail.length > 100000
      || !Array.isArray(value.skills) || value.skills.some((item) => typeof item !== 'string')
      || (value.needsCompanyConfirmation !== undefined && typeof value.needsCompanyConfirmation !== 'boolean')
      || (value.languageEvidence !== undefined && (typeof value.languageEvidence !== 'string' || value.languageEvidence.length > 2000))
      || (value.taskExclusions !== undefined && (!Array.isArray(value.taskExclusions) || value.taskExclusions.length > 100
        || value.taskExclusions.some((rule) => typeof rule?.term !== 'string' || typeof rule.literal !== 'boolean')))) {
      throw new Error('岗位排除条件依据无效，已保留原文件');
    }
    let companyInfo = value.companyInfo;
    if (companyInfo) {
      const url = new URL(companyInfo.url);
      if (url.protocol !== 'https:' || url.hostname !== 'www.zhipin.com' || url.port || url.username || url.password
        || !/^\/gongsi\/[^/]+\.html$/.test(url.pathname) || typeof companyInfo.name !== 'string' || typeof companyInfo.industry !== 'string'
        || typeof companyInfo.introduction !== 'string' || typeof companyInfo.businessScope !== 'string'
        || companyInfo.introduction.length > 100000 || companyInfo.businessScope.length > 100000
        || typeof companyInfo.checkedAt !== 'string' || !Number.isFinite(Date.parse(companyInfo.checkedAt))) {
        throw new Error('公司页业务依据无效，已保留原文件');
      }
      url.search = ''; url.hash = '';
      companyInfo = { url: url.href, name: clipped(companyInfo.name, 200), industry: clipped(companyInfo.industry, 200),
        introduction: companyInfo.introduction, businessScope: companyInfo.businessScope, checkedAt: companyInfo.checkedAt };
    }
    return { industry: clipped(value.industry, 200), jobDetail: value.jobDetail, ...(companyInfo ? { companyInfo } : {}),
      ...(value.languageEvidence ? { languageEvidence: value.languageEvidence } : {}),
      ...(value.needsCompanyConfirmation ? { needsCompanyConfirmation: true } : {}),
      skills: value.skills.slice(0, 100).map((item) => clipped(item, 200)),
      ...(value.taskExclusions ? { taskExclusions: value.taskExclusions.map((rule) => ({ term: clipped(rule.term, 100), literal: rule.literal })) } : {}) };
  }

  private cleanAssessment(input: WorkRequirementAssessment[], requirements: WorkRequirement[]): WorkRequirementAssessment[] {
    if (!Array.isArray(input)) throw new Error('工作条件依据无效');
    return requirements.filter((item) => item.enabled).map((requirement) => {
      const matches = input.filter((item) => item?.requirementId === requirement.id);
      const value = matches[0];
      if (matches.length !== 1 || !value || !['met', 'not_met', 'unknown'].includes(value.status) || typeof value.evidence !== 'string') {
        throw new Error('工作条件依据无效');
      }
      return { requirementId: requirement.id, text: requirement.text, status: value.status, evidence: decodeBossText(clipped(value.evidence)) };
    });
  }

  private save(items: WorkConditionReview[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(items, null, 2), 'utf8');
    fs.renameSync(temporary, this.file);
  }
}

export const workConditionReviews = new WorkConditionReviews();
