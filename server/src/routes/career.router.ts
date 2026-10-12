import { Router, type Request, type Response } from 'express';
import { careerStore } from '../services/career-store.js';
import { candidateLedger } from '../services/candidate-ledger.js';
import { followupStore } from '../services/followup-store.js';
import { deliveryService } from '../services/delivery.service.js';
import { resumeService } from '../services/resume.service.js';
import { resumePdfService } from '../services/resume-pdf.service.js';
import fs from 'node:fs';
import path from 'node:path';
export const careerRouter = Router();
const endpoint = (work: (req: Request) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await work(req) }); }
  catch (error) { res.status(400).json({ success: false, message: (error as Error).message }); }
};
careerRouter.get('/', endpoint(() => {
  // Import confirmed contacts without inventing an interview or an offer from message keywords.
  for (const c of followupStore.snapshot().contacts) {
    careerStore.ensure(c);
    if (!candidateLedger.get(c.jobHref)) {
      candidateLedger.discover({ ...c, salary: '' }, 'imported-contact', 'imported-contact', '已有沟通');
      candidateLedger.transition(c.jobHref, 'sent', '从已有沟通台账导入；历史筛选过程未知');
    }
  }
  const resumes = path.resolve(__dirname, '../../../data/resumes');
  if (fs.existsSync(resumes)) for (const id of fs.readdirSync(resumes).filter(id => /^resume_[0-9a-f-]+\.(pdf|docx|txt|md)$/.test(id))) {
    careerStore.recordResume({ id, fileName: id, format: path.extname(id).slice(1) });
  }
  const contacts = followupStore.snapshot().contacts;
  return { ...careerStore.snapshot(), candidates: candidateLedger.list().map(({ jobHref, jobName, companyName, status, reason, attempts, updatedAt, history }) => ({ jobHref, jobName, companyName, status, reason, attempts, updatedAt, history })), summary: candidateLedger.summary(),
    replies: contacts.filter(c => c.lastIncomingAt).length, nextSteps: contacts.filter(c => c.nextStep).map(c => ({ jobHref: c.jobHref, text: c.nextStep })) };
}));
careerRouter.post('/entries/:id', endpoint(req => { careerStore.update(req.params.id, req.body); return careerStore.snapshot(); }));
careerRouter.post('/resumes/:id', endpoint(req => { careerStore.labelResume(req.params.id, req.body.label, req.body.targetRole); return careerStore.snapshot(); }));
careerRouter.post('/resumes/:id/activate', endpoint(async req => {
  if (deliveryService.isActive()) throw new Error('请停止投递后切换简历');
  const version = careerStore.snapshot().resumes.find(r => r.id === req.params.id);
  if (!version) throw new Error('简历版本不存在');
  const file = resumePdfService.sourcePath(version.id);
  return resumePdfService.saveSource(file, version.fileName, await resumeService.extractTextFromFile(file));
}));
careerRouter.get('/entries/:id/calendar', (req, res) => {
  try {
    const entry = careerStore.snapshot().entries.find(e => e.id === req.params.id);
    if (!entry?.interviewAt) throw new Error('请先保存面试时间');
    const stamp = (value: number) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, match => '\\' + match);
    const begin = Date.parse(entry.interviewAt);
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jobloom//Interview//ZH', 'BEGIN:VEVENT', 'UID:' + entry.id + '@jobloom',
      'DTSTAMP:' + stamp(Date.now()), 'DTSTART:' + stamp(begin), 'DTEND:' + stamp(begin + 3600000),
      'SUMMARY:' + escape(entry.companyName + ' - ' + entry.jobName + ' 面试'), 'LOCATION:' + escape(entry.interviewPlace),
      'DESCRIPTION:' + escape(entry.notes), 'END:VEVENT', 'END:VCALENDAR'];
    res.type('text/calendar').setHeader('Content-Disposition', 'attachment; filename="interview.ics"');
    res.send(lines.join('\r\n') + '\r\n');
  } catch (error) { res.status(400).json({ success: false, message: (error as Error).message }); }
});
careerRouter.get('/resumes/:id/file', (req, res) => {
  try { res.download(resumePdfService.sourcePath(req.params.id)); } catch (error) { res.status(404).json({ success: false, message: (error as Error).message }); }
});
careerRouter.post('/candidates/resolve', endpoint(req => {
  if (deliveryService.isActive()) throw new Error('请停止投递后核对发送结果');
  const c = candidateLedger.get(String(req.body.jobHref));
  if (!c || !['sending', 'send_unknown'].includes(c.status) || typeof req.body.sent !== 'boolean') throw new Error('请明确核对待确认的发送结果');
  candidateLedger.transition(c.jobHref, req.body.sent ? 'sent' : 'read_retry', '用户已核对：' + (req.body.sent ? '已沟通' : '未发送'));
  if (req.body.sent) { followupStore.recordContact(c); careerStore.ensure(c); }
  return candidateLedger.summary();
}));
