'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('./calibrate.cjs');
function fixture() {
  const row = (n, kind, elapsedMs, target, action = 'click') => ({ n, kind, elapsedMs, target, page: 'list', action });
  return { capture: 'dom', status: 'finished', id: 'fixture', elapsedMs: 20000, events: [
    row(1, 'select', 0, 'a.job-name'),
    row(2, 'detail_ready', 440, 'div.job-detail-box', 'ready'),
    row(3, 'select', 543, 'a.job-name'),
    row(4, 'focus', 1100, 'a.job-name', 'focus'),
    row(5, 'select', 1204, 'a.job-name'),
    row(6, 'click', 1300, 'div.boss-login-dialog-mask'),
    row(7, 'submit', 2100, 'a.op-btn-chat'),
    row(8, 'select', 19000, 'a.job-name'),
    row(9, 'detail_ready', 19440, 'div.job-detail-box', 'ready'),
    row(10, 'select', 20000, 'a.job-name'),
  ] };
}
test('保留小于1秒的选岗，剔除登录弹窗与沟通混入的周期', () => {
  const result = analyze(fixture());
  assert.deepEqual(result.selectionIntervalsMs, [543, 661, 1000]);
  assert.equal(result.selection.medianMs, 661); assert.equal(result.minimumActionIntervalMs, 543);
  assert.deepEqual(result.excluded, [{ from: 5, to: 8, reason: 'login_or_verification' }]);
  assert.deepEqual(result.pointerHoldSamplesMs, [104]); assert.equal(result.pointerHoldMs, 104);
  assert.ok(result.unmeasured.includes('company')); assert.ok(result.unmeasured.includes('confirm'));
});
test('不把开始/加载、最后返回导出表的时间当成相邻选岗间隔', () => {
  const input = fixture();
  input.events.push({ n: 11, kind: 'finish', elapsedMs: 100000 });
  assert.deepEqual(analyze(input).selectionIntervalsMs, [543, 661, 1000]);
  input.events[3].kind = 'click';
  assert.equal(analyze(input).pointerHoldMs, null, '没有焦点到点击样本则不编造按下时间');
});
test('拒绝未结束、非DOM、倒退或缺少足够选岗的记录', () => {
  const input = fixture();
  assert.throws(() => analyze({ ...input, status: 'recording' }), /已结束/);
  assert.throws(() => analyze({ ...input, capture: 'manual' }), /DOM/);
  input.events[2].elapsedMs = -1; assert.throws(() => analyze(input), /单调/);
  assert.throws(() => analyze({ ...fixture(), events: fixture().events.slice(0, 3) }), /不足/);
});
