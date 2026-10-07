'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
async function main() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-manual-pace-test-'));
  const child = spawn(process.execPath, [path.join(__dirname, 'recorder.cjs')], {
    env: { ...process.env, BOSS_MANUAL_PACE_DATA_DIR: data }, stdio: 'ignore',
  });
  let url;
  try {
    for (let i = 0; i < 60; i++) {
      try { url = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json'), 'utf8')).url; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(url, '本地计时服务启动');
    const post = async action => {
      const response = await fetch(url + 'api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return { status: response.status, value: await response.json() };
    };
    let result = await post('manual-start');
    assert.equal(result.value.status, 'recording'); assert.equal(result.value.manualMode, true);
    assert.equal(result.value.rounds.length, 1); assert.equal(result.value.connected, false);
    assert.equal((await post('manual-start')).status, 400, '不能覆盖正在记录的样本');
    assert.equal((await post('round')).value.rounds[0].complete, true);
    result = await post('round'); assert.equal(result.value.rounds.length, 2); assert.equal(result.value.rounds[1].complete, false);
    assert.equal((await post('pause')).value.status, 'paused');
    assert.equal((await post('resume')).value.status, 'recording');
    result = await post('finish');
    assert.equal(result.value.status, 'finished'); assert.equal(result.value.rounds.length, 2);
    assert.ok(result.value.rounds.every(round => round.complete && round.durationMs >= 0));
    const saved = JSON.parse(fs.readFileSync(path.join(data, result.value.id + '.json'), 'utf8'));
    assert.equal(saved.manualMode, true); assert.equal(saved.rounds.length, 2);
    assert.equal(saved.summary.detailReading.count, 0, '手动模式不编造逐步操作时间');
    console.log('PASS 手动两轮计时、暂停恢复、保存与禁止覆盖；没有启动浏览器或访问 BOSS');
  } finally {
    child.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });