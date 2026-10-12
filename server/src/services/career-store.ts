import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './atomic-json.js';
export const careerStages = ['contacted', 'interview', 'offer', 'accepted', 'rejected', 'withdrawn'] as const;
export interface CareerEntry {
  id: string; jobHref: string; jobName: string; companyName: string; stage: typeof careerStages[number];
  interviewAt?: string; interviewPlace: string; notes: string; offerSalary: string; offerHours: string;
  offerRest: string; offerBenefits: string; offerDeadline?: string; resumeVersionId?: string;
  updatedAt: number; history: Array<{ at: number; stage: string }>;
}
export interface ResumeVersion { id: string; fileName: string; format: string; label: string; targetRole: string; createdAt: number; }
interface State { version: 1; entries: CareerEntry[]; resumes: ResumeVersion[]; }
export class CareerStore {
  private state: State = { version: 1, entries: [], resumes: [] }; private loadError = '';
  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as State;
      if (data.version !== 1 || !Array.isArray(data.entries) || !Array.isArray(data.resumes)
        || data.entries.some(e => !e || typeof e.id !== 'string' || !careerStages.includes(e.stage)
          || typeof e.jobName !== 'string' || typeof e.companyName !== 'string' || !Array.isArray(e.history))
        || data.resumes.some(r => !r || !/^resume_[0-9a-f-]+\.(pdf|docx|txt|md)$/.test(r.id))
        || new Set(data.entries.map(e => e.id)).size !== data.entries.length) throw new Error('求职进度文件格式错误');
      this.state = data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.loadError = '求职进度无法读取，已保留原文件：' + (error as Error).message; }
  }
  snapshot(): State { if (this.loadError) throw new Error(this.loadError); return structuredClone(this.state); }
  private change(fn: (next: State) => void) {
    const next = this.snapshot(); fn(next); if (this.file) writeJsonAtomic(this.file, next); this.state = next;
  }
  ensure(target: { jobHref: string; jobName: string; companyName: string }): void {
    if (this.state.entries.some(e => e.jobHref === target.jobHref)) return;
    this.change(next => next.entries.unshift({ jobHref: target.jobHref, jobName: target.jobName, companyName: target.companyName, id: randomUUID(), stage: 'contacted', interviewPlace: '', notes: '',
      offerSalary: '', offerHours: '', offerRest: '', offerBenefits: '', updatedAt: Date.now(), history: [{ at: Date.now(), stage: 'contacted' }] }));
  }
  update(id: string, raw: Partial<CareerEntry>): void {
    this.change(next => {
      const entry = next.entries.find(e => e.id === id); if (!entry) throw new Error('求职记录不存在');
      if (raw.stage !== undefined && !careerStages.includes(raw.stage)) throw new Error('求职阶段无效');
      for (const key of ['interviewAt', 'offerDeadline'] as const) {
        if (raw[key] !== undefined && raw[key] !== '' && !Number.isFinite(Date.parse(raw[key]!))) throw new Error('日期无效');
        if (raw[key] !== undefined) entry[key] = raw[key] || undefined;
      }
      for (const key of ['interviewPlace', 'notes', 'offerSalary', 'offerHours', 'offerRest', 'offerBenefits'] as const) {
        if (raw[key] !== undefined) { if (typeof raw[key] !== 'string' || raw[key]!.length > 3000) throw new Error('文字过长或格式无效'); entry[key] = raw[key]!; }
      }
      if (raw.resumeVersionId !== undefined) {
        if (raw.resumeVersionId && !next.resumes.some(r => r.id === raw.resumeVersionId)) throw new Error('简历版本不存在');
        entry.resumeVersionId = raw.resumeVersionId || undefined;
      }
      if (raw.stage && raw.stage !== entry.stage) { entry.stage = raw.stage; entry.history.push({ at: Date.now(), stage: raw.stage }); }
      entry.updatedAt = Date.now();
    });
  }
  recordResume(source: { id: string; fileName: string; format: string }): void {
    if (!/^resume_[0-9a-f-]+\.(pdf|docx|txt|md)$/.test(source.id)) throw new Error('简历版本标识无效');
    if (this.state.resumes.some(r => r.id === source.id)) return;
    this.change(next => next.resumes.unshift({ ...source, label: source.fileName, targetRole: '', createdAt: Date.now() }));
  }
  labelResume(id: string, label: unknown, targetRole: unknown): void {
    if (typeof label !== 'string' || !label.trim() || label.length > 200 || typeof targetRole !== 'string' || targetRole.length > 200) throw new Error('版本名称或目标岗位无效');
    this.change(next => { const entry = next.resumes.find(r => r.id === id); if (!entry) throw new Error('简历版本不存在'); entry.label = label.trim(); entry.targetRole = targetRole.trim(); });
  }
}
export const careerStore = new CareerStore(path.resolve(__dirname, '../../../data/career.json'));
