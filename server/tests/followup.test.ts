import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { careerStore } from '../src/services/career-store.js';
import { FollowupStore } from '../src/services/followup-store.js';
import { FollowupEngine, type FollowupDependencies } from '../src/services/followup-engine.js';
import { normalizeFollowupSettings, FollowupNotSubmittedError, type ChatSnapshot } from '../src/services/followup-types.js';
import { decideFollowup, inFollowupWindow } from '../src/services/followup-policy.js';
import { acquireBossTask, bossTaskOwner } from '../src/services/boss-task-lock.js';

const now = Date.parse('2026-10-12T02:00:00Z');
const target = { jobHref: 'https://www.zhipin.com/job_detail/local_fixture.html', jobName: '内容运营', companyName: '离线测试公司' };
const outgoing = { id: 'greet', direction: 'outgoing' as const, text: '您好', confirmed: true };
const makeSnapshot = (): ChatSnapshot => ({ ...target, accountId: 'account-fixture', conversationId: 'hr-fixture', messages: [outgoing] });
const enabled = normalizeFollowupSettings({ enabled: true, askConditions: false });
const contact = () => { const store = new FollowupStore(null); const id = store.recordContact(target, [], [], now - 72 * 3600000); store.ingest(id, makeSnapshot(), now); return { store, id }; };
let passed = 0;
function test(name: string, work: () => void) { work(); passed++; console.log('PASS | ' + name); }
async function testAsync(name: string, work: () => Promise<void>) { await work(); passed++; console.log('PASS | ' + name); }
async function finished(engine: FollowupEngine) { for (let i = 0; engine.status().busy && i < 500; i++) await new Promise(r => setTimeout(r, 2)); assert.equal(engine.status().busy, false); }
function harness(store: FollowupStore, change: Partial<FollowupDependencies> = {}) {
  let snapshot = makeSnapshot(), sent = 0;
  const deps: FollowupDependencies = {
    adapter: { read: async () => structuredClone(snapshot), send: async (_c, text) => {
      sent++; snapshot.messages.push({ id: 'sent-' + sent, direction: 'outgoing', text, confirmed: true }); return structuredClone(snapshot);
    } }, ready: async () => {}, busy: () => false, acquire: () => acquireBossTask('离线跟进测试'),
    scope: async (_signal, task) => task(), rest: async () => {}, now: () => now, ...change,
  };
  return { engine: new FollowupEngine(store, deps), count: () => sent, setSnapshot: (s: ChatSnapshot) => { snapshot = s; } };
}
async function main() {
  test('48 小时未回复才追聊；时段按北京时间计算', () => {
    const { store, id } = contact(), c = store.snapshot().contacts[0];
    assert.equal(decideFollowup(c, enabled, now).action?.kind, 'followup');
    store.update(id, c => { c.lastOutgoingAt = now - 47 * 3600000; });
    assert.equal(decideFollowup(store.snapshot().contacts[0], enabled, now).action, undefined);
    assert.equal(inFollowupWindow(enabled, Date.parse('2026-10-12T12:00:00Z')), false);
  });
  test('HR 已回复不催问；拒绝归档；面试邀请留下下一步', () => {
    const { store, id } = contact(); const s = makeSnapshot(); s.messages.push({ id: 'reply', direction: 'incoming', text: '可以来面试吗？' });
    store.ingest(id, s, now); let decision = decideFollowup(store.snapshot().contacts[0], enabled, now);
    assert.equal(decision.action, undefined); assert.match(decision.nextStep!, /面试/);
    s.messages.push({ id: 'reject', direction: 'incoming', text: '暂不考虑，谢谢' }); store.ingest(id, s, now);
    assert.equal(decideFollowup(store.snapshot().contacts[0], enabled, now).close, true);
  });
  test('只有明确授权的事实回答可以发送；多规则冲突不发送', () => {
    const { store, id } = contact(), s = makeSnapshot(); s.messages.push({ id: 'question', direction: 'incoming', text: '请问你的学历是什么？' }); store.ingest(id, s, now);
    const settings = { ...enabled, autoAnswerFacts: true, facts: [{ keywords: ['学历'], answer: '我的最高学历是本科。' }] };
    assert.equal(decideFollowup(store.snapshot().contacts[0], settings, now).action?.text, settings.facts[0].answer);
    assert.equal(decideFollowup(store.snapshot().contacts[0], { ...settings, autoAnswerFacts: false }, now).action, undefined);
    settings.facts.push({ keywords: ['学历'], answer: '冲突回答' });
    assert.equal(decideFollowup(store.snapshot().contacts[0], settings, now).action, undefined);
  });
  test('任意工作条件可询问，已明确符合的条件不重复问', () => {
    const { store, id } = contact(); store.update(id, c => { c.requirements = [{ id: 'custom', text: '公司提供午餐', enabled: true }]; });
    const settings = { ...enabled, askConditions: true };
    assert.match(decideFollowup(store.snapshot().contacts[0], settings, now).action!.text, /公司提供午餐/);
    store.update(id, c => { c.assessment = [{ requirementId: 'custom', text: '公司提供午餐', status: 'met', evidence: '包午餐' }]; });
    assert.equal(decideFollowup(store.snapshot().contacts[0], settings, now).action?.kind, 'followup');
  });
  test('消息编号与岗位绑定；陌生会话拒绝写入', () => {
    const { store, id } = contact(); const s = makeSnapshot(); s.conversationId = 'someone-else';
    assert.throws(() => store.ingest(id, s, now), /不一致/); assert.equal(store.snapshot().contacts[0].conversationId, 'hr-fixture');
    s.conversationId = 'hr-fixture'; s.accountId = 'other-account'; assert.throws(() => store.ingest(id, s, now), /账号/);
  });
  test('否定问句不冒充拒绝；未确认的手动消息不会引起追聊', () => {
    const { store, id } = contact(), s = makeSnapshot();
    s.messages.push({ id: 'question', direction: 'incoming', text: '是觉得这个岗位不合适吗？' }); store.ingest(id, s, now);
    assert.notEqual(decideFollowup(store.snapshot().contacts[0], enabled, now).close, true);
    s.messages.push({ id: 'pending', direction: 'outgoing', text: '还在发送', confirmed: false }); store.ingest(id, s, now);
    assert.equal(decideFollowup(store.snapshot().contacts[0], enabled, now).action, undefined);
  });
  test('重启后未确认的发送要有新增消息证明，旧的同文消息不算成功', () => {
    const { store, id } = contact(); const a = store.queue(id, { kind: 'followup', text: '您好', basis: 'test', conversationId: 'hr-fixture' }, now);
    store.update(id, c => { const action = c.actions[0]; action.state = 'sending'; action.attemptedAt = now; action.outgoingBefore = ['greet']; });
    store.ingest(id, makeSnapshot(), now); assert.equal(store.snapshot().contacts[0].status, 'uncertain');
    assert.equal(decideFollowup(store.snapshot().contacts[0], enabled, now).action, undefined);
    const s = makeSnapshot(); s.messages.push({ id: 'new-confirmed-message', direction: 'outgoing', text: '您好', confirmed: false }); store.ingest(id, s, now);
    assert.equal(store.snapshot().contacts[0].actions.find(x => x.id === a.id)!.state, 'uncertain');
    s.messages.at(-1)!.confirmed = true; store.ingest(id, s, now);
    assert.equal(store.snapshot().contacts[0].actions.find(x => x.id === a.id)!.state, 'sent');
  });
  test('原子台账跨重启保存，职位链接查询参数不制造重复联系人', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'jobloom-followup-')); const file = path.join(folder, 'ledger.json');
    const originalEnsure = careerStore.ensure; let crossTableWrites = 0; careerStore.ensure = () => { crossTableWrites++; };
    try { const store = new FollowupStore(file); store.settings(enabled); store.recordContact(target, [], [], now);
      store.recordContact({ ...target, jobHref: target.jobHref + '?ka=test' }, [], [], now);
      assert.equal(crossTableWrites, 0, '临时沟通台账不得写入实际求职进度');
      const restored = new FollowupStore(file); assert.equal(restored.snapshot().contacts.length, 1); assert.equal(restored.snapshot().settings.enabled, true);
      const badState = restored.snapshot(); badState.contacts[0].status = 'invalid' as any; fs.writeFileSync(file, JSON.stringify(badState)); assert.match(new FollowupStore(file).error(), /格式错误/);
      fs.writeFileSync(file, '{broken'); const broken = new FollowupStore(file); assert.match(broken.error(), /无法读取/);
      assert.throws(() => broken.recordContact(target), /无法读取/); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    } finally { careerStore.ensure = originalEnsure; assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir())); assert.ok(path.basename(folder).startsWith('jobloom-followup-')); fs.rmSync(folder, { recursive: true, force: true }); }
  });
  await testAsync('只读核对不发送；开启后发送一次；下一轮和重启不重复', async () => {
    const { store } = contact(); store.settings(enabled); const h = harness(store);
    await h.engine.tick(true); assert.equal(h.count(), 0);
    h.engine.start(); await finished(h.engine); assert.equal(h.count(), 1);
    await h.engine.tick(); assert.equal(h.count(), 1); h.engine.stop();
    const again = harness(store); again.setSnapshot({ ...makeSnapshot(), messages: store.snapshot().contacts[0].messages });
    again.engine.start(); await finished(again.engine); again.engine.stop(); assert.equal(again.count(), 0);
  });
  await testAsync('发送超时记为不确定，停止本轮，不盲目重试', async () => {
    const { store } = contact(); store.settings(enabled); let attempts = 0;
    const h = harness(store, { adapter: { read: async () => makeSnapshot(), send: async () => { attempts++; throw new Error('回执超时'); } } });
    h.engine.start(); await finished(h.engine); assert.equal(attempts, 1); assert.equal(h.engine.status().active, false);
    assert.equal(store.snapshot().contacts[0].actions[0].state, 'uncertain');
    h.engine.start(); await finished(h.engine); h.engine.stop(); assert.equal(attempts, 1);
  });
  await testAsync('未提交就取消动作，读取全部失败不能报告成功', async () => {
    const { store } = contact(); store.settings(enabled);
    const h = harness(store, { adapter: { read: async () => makeSnapshot(), send: async () => { throw new FollowupNotSubmittedError('已有用户草稿'); } } });
    h.engine.start(); await finished(h.engine); assert.equal(store.snapshot().contacts[0].actions[0].state, 'cancelled'); assert.equal(h.engine.status().active, false);
    const failure = harness(store, { adapter: { read: async () => { throw Error('找不到会话'); }, send: async () => makeSnapshot() } });
    await assert.rejects(() => failure.engine.tick(true), /未能读取.*找不到/); assert.equal(failure.count(), 0);
  });
  await testAsync('本机每日预算为零时不发消息', async () => {
    const { store } = contact(); store.settings({ ...enabled, dailyMaxMessages: 0 }); const h = harness(store);
    h.engine.start(); await finished(h.engine); h.engine.stop(); assert.equal(h.count(), 0); assert.equal(store.snapshot().contacts[0].actions.length, 0);
  });
  await testAsync('未登录或出现验证就停止，完全不进入消息发送', async () => {
    const { store } = contact(); store.settings(enabled); const h = harness(store, { ready: async () => { throw new Error('需要人工登录'); } });
    h.engine.start(); await finished(h.engine); assert.equal(h.count(), 0); assert.equal(h.engine.status().active, false); assert.match(h.engine.status().message, /登录/);
  });
  await testAsync('投递繁忙时不检查会话，工作流租约不会泄漏', async () => {
    const { store } = contact(); store.settings(enabled); const h = harness(store, { busy: () => true });
    h.engine.start(); await finished(h.engine); h.engine.stop(); assert.equal(h.count(), 0); assert.equal(bossTaskOwner(), '');
    const release = acquireBossTask('fixture'); assert.throws(() => acquireBossTask('other'), /正在执行/); release(); assert.equal(bossTaskOwner(), '');
  });
  await testAsync('停止会中止休息等待，后续不会提交消息', async () => {
    const { store } = contact(); store.settings(enabled); let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
    const h = harness(store, { rest: async signal => { entered(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
    h.engine.start(); await started; h.engine.stop(); await finished(h.engine); assert.equal(h.count(), 0); assert.equal(bossTaskOwner(), '');
  });
  console.log('PASS | ' + passed + ' followup scenarios; no real BOSS/DeepSeek requests or messages.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
