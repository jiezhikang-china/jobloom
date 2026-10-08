'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PaceSession, percentile } = require('./model.cjs');

test('按真实选岗时刻分轮，沟通与继续沟通不会开启新轮', () => {
  let now = 1700000000000; const s = new PaceSession(() => now); s.start();
  now += 4000; s.record('select'); now += 1000; s.record('detail_ready');
  now += 18000; s.record('company'); now += 2000; s.record('company_ready');
  now += 26000; s.record('detail_visible'); now += 9000; s.record('submit');
  now += 1400; s.record('confirm'); now += 6000; s.record('select');
  assert.equal(s.view().rounds[0].durationMs, 63400);
  assert.equal(s.view().rounds[0].outcome, '已点继续沟通');
  assert.equal(s.view().summary.detailReading.medianMs, 13500);
  assert.equal(s.view().summary.companyReading.medianMs, 26000);
});
test('暂停十分钟不计入阅读或每轮用时', () => {
  let now = 1700000000000; const s = new PaceSession(() => now); s.start(); s.record('select'); s.record('detail_ready');
  now += 12000; s.pause(); now += 600000;
  assert.equal(s.record('select'), false); assert.equal(s.view().elapsedMs, 12000);
  s.resume(); now += 8000; s.record('round'); s.finish();
  assert.equal(s.view().rounds[0].durationMs, 20000); assert.equal(s.view().pausedMs, 600000);
  assert.equal(s.view().summary.detailReading.medianMs, 20000);
});
test('暂停时结束也不会把离开时间加回', () => {
  let now = 1700000000000; const s = new PaceSession(() => now); s.start(); s.record('select');
  now += 35000; s.pause(); now += 240000; s.finish();
  assert.equal(s.view().elapsedMs, 35000); assert.equal(s.view().rounds[0].durationMs, 35000);
});
test('时钟异常不产生负时间，未知事件和任意内容不保存', () => {
  let now = 1700000000000; const s = new PaceSession(() => now); s.start();
  assert.equal(s.record('password'), false); now += 1000; s.record('select', 1);
  assert.equal(s.view().events[0].elapsedMs, 1000);
  const row = s.view().events[0]; assert.deepEqual(Object.keys(row).sort(), ['at', 'elapsedMs', 'kind', 'label', 'n']);
});
test('重新采样使用新编号，未完成轮不作为完整样本', () => {
  let now = 1700000000000; const s = new PaceSession(() => now); s.start(); const first = s.id;
  s.record('select'); now += 18000; assert.equal(s.view().summary.rounds.count, 0);
  s.finish(); assert.equal(s.view().summary.rounds.count, 1);
  s.start(); assert.notEqual(s.id, first); assert.equal(s.view().events.length, 0);
});
test('中位数和四分位数用于呈现分布，未采样不编造间隔', () => {
  assert.equal(percentile([], .5), null); assert.equal(percentile([60, 10, 20], .5), 20);
  assert.equal(new PaceSession().view().summary.rounds.medianMs, null);
});test('DOM 元信息只保存结构与类型，拒绝正文、链接和值', () => {
  const s = new PaceSession(() => 1700000000000); s.start();
  s.record('click', 1700000000000, { target: 'button.other-control', page: 'chat', action: 'click',
    text: '私有正文', href: 'https://example.com', value: '密码' });
  assert.equal(s.events[0].target, 'button.other-control'); assert.equal(s.events[0].page, 'chat');
  assert.equal(s.events[0].action, 'click');
  s.record('input', 1700000000000, { target: 'input[value="密码"]', page: 'https://example.com', action: '私有正文' });
  assert.equal(s.events[1].target, undefined); assert.equal(s.events[1].page, undefined);
  assert.equal(s.events[1].action, undefined);
  assert.doesNotMatch(JSON.stringify(s.events), /私有正文|example|密码/);
});
