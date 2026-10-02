const test = require('node:test');
const assert = require('node:assert/strict');
const { WebRequestPacing, requestInterval } = require('../pacing.cjs');

test('local proxy enforces interval after completion, clamps settings and honors cancellation', async () => {
  let time = 0;
  const waits = [];
  const pacing = new WebRequestPacing({ now: () => time, sleep: async (ms, signal) => {
    signal?.throwIfAborted(); waits.push(ms); time += ms;
  } });
  await pacing.wait();
  assert.deepEqual(waits, [], 'no wait before the first request');
  time += 5000; pacing.finished(); time += 2000;
  await pacing.wait();
  assert.deepEqual(waits, [28000]);
  pacing.finished(); await pacing.wait(0);
  assert.equal(waits[1], 10000);
  assert.equal(requestInterval(999), 300); assert.equal(requestInterval('bad'), 30);
  const controller = new AbortController(); controller.abort(new Error('stop'));
  await assert.rejects(pacing.wait(30, controller.signal), /stop/);
  assert.equal(waits.length, 2);
});

test('cooldown cannot be shortened by another error', () => {
  let time = 0;
  const pacing = new WebRequestPacing({ now: () => time });
  pacing.coolDown(180); time += 1000; pacing.coolDown(3);
  assert.equal(pacing.retryAfterSeconds, 179);
  time += 179000; assert.equal(pacing.retryAfterSeconds, 0);
});
