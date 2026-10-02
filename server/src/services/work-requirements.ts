import type { AppConfig, BossJobItem, WorkConditions, WorkRequirement, WorkRequirementAssessment } from '../types.js';
import { CONDITION_KEYS, WORK_CONDITION_LABELS } from './work-conditions.js';
import { assessLocalRequirement } from './local-work-requirements.js';
export { assessLocalRequirement } from './local-work-requirements.js';

export const MAX_WORK_REQUIREMENTS = 20;

export function normalizeWorkRequirements(input: unknown, legacy?: Partial<WorkConditions>): WorkRequirement[] {
  if (!Array.isArray(input)) {
    return CONDITION_KEYS.filter((key) => legacy?.[key] === true).map((key) => ({
      id: 'preset-' + key, text: WORK_CONDITION_LABELS[key], builtin: key, enabled: true,
    }));
  }
  const seen = new Set<string>();
  return input.slice(0, MAX_WORK_REQUIREMENTS).flatMap((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.text !== 'string' || !item.text.trim()) return [];
    let id = typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(item.id) ? item.id : 'condition-' + index;
    if (seen.has(id)) id = 'condition-' + index;
    seen.add(id);
    const text = item.text.trim().slice(0, 500);
    const builtin = CONDITION_KEYS.includes(item.builtin) && text === WORK_CONDITION_LABELS[item.builtin as keyof WorkConditions]
      ? item.builtin as keyof WorkConditions : undefined;
    return [{ id, text, enabled: item.enabled === true, ...(builtin ? { builtin } : {}) }];
  });
}

export function validateWorkRequirements(input: unknown): boolean {
  if (!Array.isArray(input) || input.length > MAX_WORK_REQUIREMENTS) return false;
  const ids = new Set<string>();
  return input.every((item) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id)
      || ids.has(item.id) || typeof item.enabled !== 'boolean' || typeof item.text !== 'string'
      || item.text.trim().length < 2 || item.text.length > 500) return false;
    ids.add(item.id); return true;
  });
}

export function configuredWorkRequirements(filter: AppConfig['filter']): WorkRequirement[] {
  return normalizeWorkRequirements(filter.workRequirements, filter.workConditions).filter((item) => item.enabled);
}

export function hasEntryLevelRequirement(filter: AppConfig['filter']): boolean {
  return configuredWorkRequirements(filter).some((item) => item.builtin === 'noExperience'
    || (/无经验|无工作经验|零经验|经验不限|不要求.{0,5}经验|无需.{0,5}经验|小白/.test(item.text)
      && !/不接受|不允许|拒绝|不欢迎/.test(item.text)));
}

const compact = (text: string) => text.replace(/\s+/g, '').toLowerCase();

/** Each arbitrary user requirement needs its own status and a quote from this job. */
export function assessWorkRequirements(
  job: BossJobItem, detail: string, requirements: WorkRequirement[], modelProof?: unknown,
  experienceMode: 'flexible' | 'strict' = 'flexible',
): WorkRequirementAssessment[] {
  const active = normalizeWorkRequirements(requirements).filter((item) => item.enabled);
  const sources = [detail, job.jobName, job.brandName, job.brandIndustry, job.brandScaleName, job.cityName,
    job.activeTimeDesc, ...(job.skills || []), ...(job.welfareList || []), job.jobExperience || '',
    job.jobDegree || '', job.salaryDesc || '', job.companyInfo?.industry || '', job.companyInfo?.introduction || '',
    job.companyInfo?.businessScope || ''].filter((value) => typeof value === 'string');
  const proofs: unknown[] = Array.isArray(modelProof) ? modelProof : [];
  return active.map((item) => {
    const local = assessLocalRequirement(job, detail, item, experienceMode);
    if (local) return { requirementId: item.id, text: item.text, ...local };
    const result = { requirementId: item.id, text: item.text, status: 'unknown' as const, evidence: '' };
    const matches = proofs.filter((entry: any) => entry?.requirementId === item.id);
    if (matches.length !== 1) return result;
    const candidate = matches[0] as Partial<WorkRequirementAssessment>;
    if (!['met', 'not_met', 'unknown'].includes(String(candidate.status)) || typeof candidate.evidence !== 'string') return result;
    const quote = candidate.evidence.trim();
    if (quote.length < 3 || quote.length > 500 || !sources.some((source) => compact(source).includes(compact(quote)))) return result;
    return { ...result, status: candidate.status!, evidence: quote };
  });
}

export function summarizeWorkRequirements(assessment: WorkRequirementAssessment[]) {
  return { failed: assessment.filter((item) => item.status === 'not_met'), missing: assessment.filter((item) => item.status === 'unknown') };
}
