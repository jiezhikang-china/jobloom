import { followupStore } from './followup-store.js';
import { FollowupEngine } from './followup-engine.js';
import { BossFollowupDom } from './boss-followup-dom.js';
import { browserService } from './browser.service.js';
import { deliveryService } from './delivery.service.js';
import { resumeBossUploadService } from './resume-boss-upload.service.js';
import { bossAutomationSafety } from './boss-automation-safety.js';
import { bossSessionRest } from './boss-session-rest.js';
import { bossActionScheduler } from './boss-action-scheduler.js';
import { acquireBossTask, bossTaskOwner } from './boss-task-lock.js';

async function ready(): Promise<void> {
  bossAutomationSafety.assertAllowed();
  if (await browserService.checkVisibleRestriction()) throw new Error('BOSS 页面需要人工登录或验证，请打开消息页处理');
  const login = await browserService.checkLoginStatus({ restore: false });
  if (!login.isLoggedIn) throw new Error(login.reason || 'BOSS 尚未登录，请打开消息页完成登录');
}
export const followupService = new FollowupEngine(followupStore, {
  adapter: new BossFollowupDom(() => browserService.getCommunicationPage()), ready,
  busy: () => deliveryService.isActive() || resumeBossUploadService.isBusy() || Boolean(bossTaskOwner()),
  acquire: () => acquireBossTask('沟通跟进'),
  scope: (signal, task) => bossActionScheduler.withScope({ signal, managedBusinessRest: true, beforeAction: async () => { signal.throwIfAborted(); bossAutomationSafety.assertAllowed(); } }, task),
  rest: async signal => { await bossSessionRest.runIfDue({ signal }); },
});
