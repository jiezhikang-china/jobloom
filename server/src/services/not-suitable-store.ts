import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bossJobId, normalizedJobName } from './job-identity.js';

export interface NotSuitableCompany {
  id: string; companyName: string; updatedAt: string; scope?: 'job' | 'company';
  jobs: Array<{ jobId: string; jobName: string }>;
}
type Target = { jobHref: string; jobName: string; companyName: string; scope?: 'job' | 'company' };

/** A private reversible list. No screening reasons or recruiter messages. */
export class NotSuitableStore {
  private stamp = '';
  private records: NotSuitableCompany[] = [];
  private companies = new Set<string>();
  private jobs = new Set<string>();
  constructor(private readonly file = path.resolve(process.cwd(), '../data/not-suitable.json')) {}
  private refresh(): void {
    const stat = fs.existsSync(this.file) ? fs.statSync(this.file) : undefined;
    const stamp = stat ? stat.mtimeMs + ':' + stat.size : 'missing';
    if (stamp === this.stamp) return;
    const value = stat ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : [];
    if (!Array.isArray(value) || value.some(row => !/^[a-f0-9]{20}$/.test(row?.id) || typeof row.companyName !== 'string'
      || !row.companyName.trim() || (row.scope !== undefined && !['job', 'company'].includes(row.scope)) || !Array.isArray(row.jobs) || row.jobs.some((job: any) => typeof job?.jobId !== 'string' || typeof job.jobName !== 'string'))) {
      throw new Error('本地不感兴趣清单格式错误，原文件已保留');
    }
    this.records = value; this.stamp = stamp;
    this.companies = new Set(value.filter(row => row.scope !== 'job').map(row => normalizedJobName(row.companyName)));
    this.jobs = new Set(value.flatMap(row => row.jobs.map((job: any) => job.jobId)));
  }
  private save(rows: NotSuitableCompany[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(rows, null, 2), 'utf8');
    fs.renameSync(temporary, this.file); this.stamp = ''; this.refresh();
  }
  public list(): NotSuitableCompany[] { this.refresh(); return structuredClone(this.records); }
  public matches(jobHref: string, companyName: string): boolean {
    this.refresh(); return this.companies.has(normalizedJobName(companyName)) || this.jobs.has(bossJobId(jobHref));
  }
  public remember(target: Target): void {
    const jobId = bossJobId(target.jobHref), name = normalizedJobName(target.companyName);
    if (!jobId || !name) throw new Error('不感兴趣岗位身份无效');
    const rows = this.list(), id = createHash('sha256').update(name).digest('hex').slice(0, 20);
    let company = rows.find(row => row.id === id);
    if (!company) { company = { id, companyName: target.companyName.slice(0, 150), jobs: [], updatedAt: '', ...(target.scope ? { scope: target.scope } : {}) }; rows.unshift(company); }
    else if (target.scope === 'company') company.scope = 'company';
    if (company.jobs.some(job => job.jobId === jobId)) { this.save(rows); return; }
    company.jobs.push({ jobId, jobName: target.jobName.slice(0, 150) });
    company.updatedAt = new Date().toISOString(); this.save(rows);
  }
  public remove(id: string): boolean {
    const rows = this.list(), remaining = rows.filter(row => row.id !== id);
    if (rows.length === remaining.length) return false;
    this.save(remaining); return true;
  }
}
export const notSuitableStore = new NotSuitableStore();
