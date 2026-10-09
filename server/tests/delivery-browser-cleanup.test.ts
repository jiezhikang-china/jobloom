import './fixtures/activate-isolated-safety.js';
import assert from 'node:assert/strict';
import { DeliveryService } from '../src/services/delivery.service.js';
import { bossAutomationSafety } from '../src/services/boss-automation-safety.js';
async function main() {
  let closes = 0, releases = 0;
  const make = () => new DeliveryService({ runIfDue: async () => false }, {
    closeAfterTask: async () => { closes++; return true; }, releaseRestGate: () => { releases++; },
  }) as any;
  for (const stop of [false, true]) {
    const service = make();
    await service.withOperations(async () => { service.stats.status = stop ? 'idle' : 'finished'; service.isStopRequested = stop; });
    assert.equal(service.isActive(), false);
    assert.ok(service.getLogs().some((log: any) => log.message.includes('[浏览器已关闭]')));
  }
  assert.equal(closes, 2);
  const failed = make();
  await failed.withOperations(async () => { failed.stats.status = 'failed'; });
  assert.equal(closes, 2, '故障弹窗保留');
  const blocked = make();
  await blocked.withOperations(async () => { blocked.stats.status = 'finished'; bossAutomationSafety.halt('verification', '离线验证'); });
  assert.equal(closes, 2, '验证页保留');
  bossAutomationSafety.confirmRecovery(bossAutomationSafety.status().hold!.id);
  let finishClose!: () => void;
  const gate = new Promise<void>(resolve => { finishClose = resolve; });
  const concurrent = new DeliveryService({ runIfDue: async () => false }, {
    closeAfterTask: async () => { await gate; return true; }, releaseRestGate: () => {},
  }) as any;
  const pending = concurrent.withOperations(async () => { concurrent.stats.status = 'finished'; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(concurrent.isActive(), true);
  await assert.rejects(concurrent.withOperations(async () => {}), /已经在运行/);
  finishClose(); await pending; assert.equal(concurrent.isActive(), false);
  const closeFailed = new DeliveryService({ runIfDue: async () => false }, {
    closeAfterTask: async () => { throw new Error('离线关闭失败'); }, releaseRestGate: () => { releases++; },
  }) as any;
  await closeFailed.withOperations(async () => { closeFailed.stats.status = 'finished'; });
  assert.ok(closeFailed.getLogs().some((log: any) => log.message.includes('[浏览器关闭失败]')));
  assert.equal(closeFailed.isActive(), false); assert.equal(releases, 5);
  console.log('PASS | 任务关闭、验证保留、清理互斥与失败报告');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
