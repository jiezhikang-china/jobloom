import assert from 'node:assert/strict';
import { BossActionScheduler } from '../src/services/boss-action-scheduler.js';
import { bossOperationPolicy } from '../src/services/boss-operation-policy.js';

async function main() {
  let clock = 100000;
  const settings = { intervalMs: 2000, burst: 3, restMs: 20000, feedbackMs: 15000 };
  const scheduler = new BossActionScheduler(() => settings, () => clock, async ms => { clock += ms; });
  const starts: number[] = [];
  let simultaneous = 0, maximum = 0;
  await Promise.all(['control', 'input', 'control'].map(kind => scheduler.run(kind as any, async () => {
    simultaneous++; maximum = Math.max(maximum, simultaneous); starts.push(clock); await Promise.resolve(); simultaneous--;
  })));
  assert.equal(maximum, 1); assert.deepEqual(starts, [100000, 102000, 104000], '所有页面动作共用一条队列');
  await scheduler.run('control', async () => { starts.push(clock); });
  assert.equal(starts.at(-1), 124000, '达到连续操作次数后先短休息，不集中补发');
  await scheduler.run('submit', async () => {}); const writeAt = clock;
  await scheduler.run('confirm', async () => {});
  assert.equal(clock - writeAt, 600, '已发送后的继续沟通确认没有额外长停顿');
  await scheduler.run('feedback', async () => {});
  assert.ok(clock - writeAt >= 15000, '反馈和保存共用写入间隔');
  clock += 21000;
  await scheduler.run('route', async () => {}); const routeAt = clock;
  await scheduler.run('route', async () => {}); assert.ok(clock - routeAt >= 10000);

  let persisted: any;
  const limited = new BossActionScheduler(() => settings, () => clock, async ms => { clock += ms; }, state => { persisted = state; });
  limited.limit(120000); const blockedAt = clock;
  limited.limit(0); assert.equal(limited.status().level, 1, '同一时刻的重复限频信号只累计一次');
  const restored = new BossActionScheduler(() => settings, () => clock, async ms => { clock += ms; });
  restored.restore(persisted);
  await restored.run('navigation', async () => {});
  assert.ok(clock - blockedAt >= 120000, '重启仍遵守平台 Retry-After');
  clock += 1000; limited.limit(); assert.equal(limited.status().level, 2, '重复限频提高退避级别');

  let release: () => void = () => {};
  const entered = new Promise<void>(resolve => { release = resolve; });
  const cancellable = new BossActionScheduler(() => settings, () => clock, (_ms, signal) => new Promise((_resolve, reject) => {
    release(); signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await cancellable.run('control', async () => {});
  const controller = new AbortController(); let clicked = false;
  const pending = cancellable.withScope({ signal: controller.signal }, () => cancellable.run('submit', async () => { clicked = true; }));
  await entered; controller.abort(new Error('停止任务'));
  await assert.rejects(pending, /停止任务/); assert.equal(clicked, false, '停止后排队中的提交不能继续点击');
  clock += 21000;
  await cancellable.run('control', async () => { clicked = true; }); assert.equal(clicked, true, '取消不会破坏后续队列');
  let checkpointClock = 9000000, checkpointState: any;
  const checkpointPolicy = { intervalMs: 0, burst: 0, businessBurst: 3, restMs: 20000, feedbackMs: 0 };
  const checkpoints = new BossActionScheduler(() => checkpointPolicy, () => checkpointClock,
    async ms => { checkpointClock += ms; }, state => { checkpointState = structuredClone(state); });
  const beforeControls = checkpointClock;
  for (let i = 0; i < 80; i++) await checkpoints.run('control', async () => {});
  assert.equal(checkpointClock, beforeControls, '普通DOM动作不能再触发累计长休息');
  for (const kind of ['source', 'detail', 'feedback'] as const) await checkpoints.run(kind, async () => {});
  assert.equal(checkpoints.waitSeconds('control'), 20, '详情/来源/反馈按业务检查点累计');
  await checkpoints.run('confirm', async () => {});
  assert.equal(checkpointClock, beforeControls, '已有发送后的确认不能被业务休息堵住');
  const checkpointRestarted = new BossActionScheduler(() => checkpointPolicy, () => checkpointClock,
    async ms => { checkpointClock += ms; });
  checkpointRestarted.restore(checkpointState);
  await checkpointRestarted.run('detail', async () => {});
  assert.equal(checkpointClock, beforeControls + 20000, '业务检查点计数跨重启保留');

  let writeClock = 10000000;
  const normalPolicy = { intervalMs: 2000, burst: 0, businessBurst: 100, restMs: 900000, feedbackMs: 15000 };
  const normal = new BossActionScheduler(() => normalPolicy, () => writeClock, async ms => { writeClock += ms; });
  for (let i = 0; i < 10; i++) await normal.run('feedback', async () => {});
  assert.ok(normal.waitSeconds('submit') <= 15, '10次反馈不能再制造一小时的投递阻塞');
  const beforeSubmit = writeClock; await normal.run('submit', async () => {});
  assert.equal(writeClock - beforeSubmit, 15000, '反馈和投递仍遵守分散的写入间隔');
  normal.limit(60000);
  assert.equal(normal.canStartFeedback(), false, '明确平台限频时不能打开可选反馈弹窗');
  let stageClock = 20000000, stageState: any;
  const stage = new BossActionScheduler(() => bossOperationPolicy, () => stageClock,
    async ms => { stageClock += ms; }, state => { stageState = structuredClone(state); });
  await stage.run('detail', async () => {}); const detailAt = stageClock;
  for (let i = 0; i < 5; i++) await stage.run('control', async () => {});
  assert.equal(stageClock - detailAt, 2500, '普通控件半秒，不叠加读岗位等待');
  await stage.run('detail', async () => {});
  assert.equal(stageClock - detailAt, 3000, '控件/读取时间计入3秒详情间隔');
  stageClock += 10000; const alreadyRead = stageClock;
  await stage.run('detail', async () => {});
  assert.equal(stageClock, alreadyRead, '已经阅读10秒不能额外等待下一岗位');
  const afterRead = stageClock;
  for (let i = 0; i < 20; i++) await stage.run('control', async () => {});
  assert.equal(stageClock - afterRead, 10000, '超过12次普通动作不会产生整分钟停顿');
  await stage.run('list', async () => {}); const listAt = stageClock;
  await stage.run('list', async () => {}); assert.equal(stageClock - listAt, 5000);
  await stage.run('detail', async () => {});
  const restartedStage = new BossActionScheduler(() => bossOperationPolicy, () => stageClock, async ms => { stageClock += ms; });
  restartedStage.restore(stageState); const beforeRestart = stageClock;
  await restartedStage.run('detail', async () => {});
  assert.equal(stageClock - beforeRestart, 3000, '同类业务间隔跨重启仍保留');
  await stage.run('feedback', async () => {}); const feedbackAt = stageClock;
  await stage.run('submit', async () => {});
  assert.equal(stageClock - feedbackAt, 1000, '已确认目标的提交不再被15秒反馈间隔堵住');
  stage.limit(120000);
  assert.equal(stage.canStartFeedback(), false);
  console.log('PASS | 全页面单队列、连续操作短休息、快速继续沟通、写入与路线间隔、限频持久化、停止取消待执行提交');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
