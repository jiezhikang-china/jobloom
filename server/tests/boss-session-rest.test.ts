import assert from 'node:assert/strict';
import { BossSessionRest } from '../src/services/boss-session-rest.js';

async function main() {
  let now = 100000, active = true, needed = true, journal: any = null;
  const events: string[] = [];
  const dependencies = {
    durationMs: 900000, now: () => now, needsRest: () => needed,
    close: async () => { events.push('close'); const wasActive = active; active = false; return wasActive; },
    open: async () => { assert.equal(active, false); events.push('open'); active = true; },
    complete: () => { events.push('complete'); needed = false; },
    assertAllowed: () => {}, persist: (state: any) => { journal = structuredClone(state); },
    sleep: async (ms: number) => { assert.equal(active, false, '整个休息期间浏览器必须关闭'); now += ms; },
  };
  const rest = new BossSessionRest(dependencies);
  assert.equal(await rest.runIfDue(), true);
  assert.equal(now, 1000000, '从真正关闭确认后计满15分钟');
  assert.deepEqual(events, ['close', 'open', 'complete']);
  assert.equal(journal, null);
  assert.equal(await rest.runIfDue(), false);
  for (let i = 0; i < 12; i++) { needed = true; await rest.runIfDue(); }
  assert.equal(events.filter(x => x === 'close').length, 13);
  assert.equal(events.filter(x => x === 'open').length, 13, '连续多轮休息都关闭并重开');

  needed = true; const controller = new AbortController();
  const interrupted = new BossSessionRest({ ...dependencies, sleep: async ms => {
    now += ms; controller.abort(new Error('用户停止'));
  } });
  const beforeStopOpens = events.filter(x => x === 'open').length;
  await assert.rejects(interrupted.runIfDue({ signal: controller.signal }), /用户停止/);
  assert.equal(active, false);
  assert.equal(events.filter(x => x === 'open').length, beforeStopOpens, '停止休息任务后不能自动重开');
  assert.ok(journal.resumeAt > now, '停止后仍保留未完成的休息记录');
  const resumeAt = journal.resumeAt;
  const restored = new BossSessionRest(dependencies); restored.restore(journal);
  await restored.runIfDue();
  assert.equal(now, resumeAt, '程序重启不刷新或提前完成未休息完的时间');

  needed = true; active = true;
  let allowed = true;
  const blocked = new BossSessionRest({ ...dependencies,
    assertAllowed: () => { if (!allowed) throw new Error('平台要求人工验证'); },
    sleep: async ms => { now += ms; allowed = false; },
  });
  const beforeBlocked = events.filter(x => x === 'open').length;
  await assert.rejects(blocked.runIfDue(), /人工验证/);
  assert.equal(events.filter(x => x === 'open').length, beforeBlocked, '平台验证不能走正常休息重开路径');

  let opens = 0, completions = 0;
  const closeFailed = new BossSessionRest({ ...dependencies,
    close: async () => { throw new Error('未确认浏览器关闭'); },
    open: async () => { opens++; }, complete: () => { completions++; },
  });
  await assert.rejects(closeFailed.runIfDue(), /未确认浏览器关闭/);
  assert.equal(opens, 0); assert.equal(completions, 0);
  const loginFailed = new BossSessionRest({ ...dependencies,
    open: async () => { throw new Error('登录已失效'); }, complete: () => { completions++; },
  });
  await assert.rejects(loginFailed.runIfDue(), /登录已失效/);
  assert.equal(completions, 0, '新页面没有确认登录不能清除累计检查和休息记录');

  let resumeChecks = 0, unpause!: () => void;
  const pauseGate = new Promise<void>(resolve => { unpause = resolve; });
  const paused = new BossSessionRest({ ...dependencies,
    open: async () => { opens++; }, complete: () => { completions++; },
  });
  const pauseRun = paused.runIfDue({ beforeResume: async () => {
    if (++resumeChecks === 2) await pauseGate;
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumeChecks, 2); assert.equal(opens, 0, '休息结束仍在人工暂停时不得重开');
  unpause(); await pauseRun; assert.equal(opens, 1);

  const reopened = new BossSessionRest(dependencies);
  reopened.restore({ closedAt: now - 900000, resumeAt: now });
  active = true; const externalOpenAt = now; await reopened.runIfDue();
  assert.equal(now - externalOpenAt, 900000, '休息期间被重新打开的浏览器必须重新关闭后计时');
  for (const invalid of [5, [], { closedAt: 2 }, { closedAt: 2, resumeAt: 1 }, { resumeAt: 3 }]) {
    assert.throws(() => rest.restore(invalid), /无法读取/);
  }
  console.log('PASS | 13轮关闭休息重开、关闭后完整计时、停止与重启、平台异常不恢复、关闭失败、登录失败、记录校验');
}
main().catch(error => { console.error(error); process.exitCode = 1; });