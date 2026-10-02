const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WebRequests, retryAfterSeconds } = require('../requests.cjs');

test('persists only uncertain request/session metadata across restarts', () => {
  const directory = fs.mkdtempSync(path.resolve(__dirname, '../../../data/request-test-'));
  const file = path.join(directory, 'pending.json');
  try {
    const store = new WebRequests(file);
    store.begin('local-request-123', 'owned-session-123');
    const restored = new WebRequests(file);
    assert.deepEqual(restored.list(), store.list());
    assert.deepEqual(Object.keys(restored.list()[0]).sort(), ['createdAt', 'requestId', 'sessionId']);
    restored.finish('local-request-123', { choices: ['in-memory answer'] });
    assert.equal(new WebRequests(file).list().length, 0);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('answer'), '回答只缓存内存，不写入持久化元数据');
    assert.deepEqual(restored.result('local-request-123'), { choices: ['in-memory answer'] });
    fs.writeFileSync(file, 'corrupt');
    assert.throws(() => new WebRequests(file), '损坏的未确认记录不能被当成不存在');
  } finally { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(directory); }
});

test('Retry-After supports complete seconds and HTTP dates without a 300-second cap', () => {
  const now = Date.UTC(2026, 9, 3);
  assert.equal(retryAfterSeconds('1800', 60, now), 1800);
  assert.equal(retryAfterSeconds(new Date(now + 3600000).toUTCString(), 60, now), 3600);
  assert.equal(retryAfterSeconds(new Date(now - 1000).toUTCString(), 60, now), 0);
  assert.equal(retryAfterSeconds('not a date', 60, now), 60);
});
