import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { WorkConditionReview, WorkRequirementAssessment, WorkRequirement } from '../types.js';
import { normalizeWorkRequirements, validateWorkRequirements } from './work-requirements.js';

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
        salary: clipped(item.salary, 100), reason: clipped(item.reason), question: clipped(item.question),
        requirements, assessment, updatedAt: item.updatedAt,
      };
    }).slice(0, 200);
  }

  add(input: Omit<WorkConditionReview, 'id' | 'question' | 'updatedAt'>): WorkConditionReview {
    const jobHref = canonicalJobUrl(input.jobHref);
    const requirements = normalizeWorkRequirements(input.requirements);
    if (!validateWorkRequirements(requirements) || !requirements.some((item) => item.enabled)) throw new Error('工作条件无效');
    const labels = requirements.filter((item) => item.enabled).map((item) => item.text);
    const item: WorkConditionReview = {
      id: reviewId(jobHref), jobHref,
      jobName: clipped(input.jobName, 150), companyName: clipped(input.companyName, 150), salary: clipped(input.salary, 100),
      reason: clipped(input.reason), requirements, assessment: this.cleanAssessment(input.assessment, requirements),
      question: clipped('您好，想确认这个岗位是否满足：' + labels.join('、') + '？能否说明具体安排及是否有未注明的入职条件？'),
      updatedAt: new Date().toISOString(),
    };
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

  private cleanAssessment(input: WorkRequirementAssessment[], requirements: WorkRequirement[]): WorkRequirementAssessment[] {
    if (!Array.isArray(input)) throw new Error('工作条件依据无效');
    return requirements.filter((item) => item.enabled).map((requirement) => {
      const matches = input.filter((item) => item?.requirementId === requirement.id);
      const value = matches[0];
      if (matches.length !== 1 || !value || !['met', 'not_met', 'unknown'].includes(value.status) || typeof value.evidence !== 'string') {
        throw new Error('工作条件依据无效');
      }
      return { requirementId: requirement.id, text: requirement.text, status: value.status, evidence: clipped(value.evidence) };
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
