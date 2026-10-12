import { Router, type Request, type Response } from 'express';
import { followupService } from '../services/followup.service.js';
import { browserService } from '../services/browser.service.js';
import { bossAutomationSafety } from '../services/boss-automation-safety.js';
import { configManager } from '../config/config.manager.js';
import { configuredWorkRequirements } from '../services/work-requirements.js';
import { bossTaskOwner } from '../services/boss-task-lock.js';

export const followupRouter = Router();
const endpoint = (work: (req: Request) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
  try { const data = await work(req); res.json({ success: true, data }); }
  catch (error) { res.status(400).json({ success: false, message: (error as Error).message }); }
};
async function verifySession(): Promise<void> {
  if (bossTaskOwner()) throw new Error('BOSS 正在执行' + bossTaskOwner());
  const hold = bossAutomationSafety.status().hold;
  const login = await browserService.verifyManualSession();
  if (!login.isLoggedIn || await browserService.checkVisibleRestriction()) throw new Error(login.reason || '请先完成 BOSS 登录或验证');
  if (hold) bossAutomationSafety.confirmRecovery(hold.id);
}
followupRouter.get('/', endpoint(() => followupService.status()));
followupRouter.post('/settings', endpoint(req => { followupService.configure(req.body); return followupService.status(); }));
followupRouter.post('/start', endpoint(async () => {
  // Explicit start reuses the same visible login verification as task start.
  await verifySession();
  followupService.start(); return followupService.status();
}));
followupRouter.post('/stop', endpoint(() => { followupService.stop(); return followupService.status(); }));
followupRouter.post('/scan', endpoint(async () => { await verifySession(); await followupService.tick(true); return followupService.status(); }));
followupRouter.post('/open', endpoint(async () => {
  if (bossTaskOwner()) throw new Error('BOSS 正在执行' + bossTaskOwner() + '，请先停止任务');
  const login = await browserService.checkLoginStatus({ restore: false });
  if (bossAutomationSafety.status().blocked || !login.isLoggedIn) await browserService.openManualRecovery();
  else await browserService.getCommunicationPage();
  return followupService.status();
}));
followupRouter.post('/contacts', endpoint(req => {
  if (followupService.status().busy || followupService.status().active) throw new Error('请停止监控后加入记录');
  const { jobHref, jobName, companyName, contactedAt } = req.body;
  if (typeof jobHref !== 'string' || typeof jobName !== 'string' || !jobName.trim() || jobName.length > 200
    || typeof companyName !== 'string' || !companyName.trim() || companyName.length > 200 || !Number.isFinite(contactedAt)
    || contactedAt <= 0 || contactedAt > Date.now()) throw new Error('请填写有效的岗位、公司和过去的沟通时间');
  followupService.store.recordContact({ jobHref, jobName: jobName.trim(), companyName: companyName.trim() }, configuredWorkRequirements(configManager.getConfig().filter), [], contactedAt);
  return followupService.status();
}));
followupRouter.post('/close', endpoint(req => { followupService.closeContact(String(req.body.id)); return followupService.status(); }));
followupRouter.post('/resolve', endpoint(req => {
  if (followupService.status().busy || followupService.status().active) throw new Error('请停止监控后核对发送结果');
  if (typeof req.body.sent !== 'boolean') throw new Error('请明确核对已发送或未发送');
  followupService.store.update(String(req.body.id), contact => {
    const action = contact.actions.find(a => a.id === req.body.actionId);
    if (!action || action.state !== 'uncertain') throw new Error('待核对的发送记录不存在');
    action.state = req.body.sent ? 'sent' : 'cancelled'; action.error = undefined;
    if (req.body.sent) action.sentAt = action.attemptedAt || Date.now();
    contact.lastOutgoingAt = Date.now(); contact.status = 'waiting'; contact.nextStep = undefined;
  }); return followupService.status();
}));
