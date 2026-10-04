const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { ConfigManager } = require('../dist/config/config.manager.js');
const { bossOperationPolicy } = require('../dist/services/boss-operation-policy.js');
const { BossActionScheduler } = require('../dist/services/boss-action-scheduler.js');
const { desktopAuth } = require('../dist/desktop-auth.js');

async function main() {
  const base = path.resolve(__dirname, '../../data');
  const dir = fs.mkdtempSync(path.join(base, 'internal-policy-test-'));
  let server;
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ delivery: { dailyMaxQuota: 7, minDelaySeconds: 0, maxDelaySeconds: 0,
      operationIntervalSeconds: 0, operationBurstLimit: 100000, operationRestSeconds: 0, writeMaxPerHour: 9999 } }));
    const config = new ConfigManager(file);
    assert.deepEqual(Object.keys(config.getConfig().delivery).sort(), ['dailyMaxQuota', 'jobSource']);
    assert.equal(config.getConfig().delivery.dailyMaxQuota, 7);
    config.updateConfig({ delivery: { dailyMaxQuota: 3, operationIntervalSeconds: 0, maxDelaySeconds: 0 } });
    assert.deepEqual(config.getConfig().delivery, { jobSource: 'saved_expectations', dailyMaxQuota: 3 });
    assert.equal(JSON.parse(fs.readFileSync(file)).delivery.operationIntervalSeconds, undefined);
    assert.equal(Object.isFrozen(bossOperationPolicy), true);
    let clock = 100000, persisted;
    const policy = { intervalMs: 0, burst: 2, restMs: 900000, feedbackMs: 0 };
    const queue = new BossActionScheduler(() => policy, () => clock, async ms => { clock += ms; }, state => { persisted = structuredClone(state); });
    await queue.run('control', async () => {}); await queue.run('control', async () => {});
    const restarted = new BossActionScheduler(() => policy, () => clock, async ms => { clock += ms; });
    restarted.restore(persisted); await restarted.run('control', async () => {});
    assert.equal(clock, 100000 + 900000, '重启也须完成累计操作后的15分钟休息');
    const app = express(); app.use('/api', desktopAuth('fixture-token')); app.get('/api/config', (_req, res) => res.json({ ok: true }));
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/api/config';
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { 'x-boss-desktop-token': 'wrong-token' } })).status, 401);
    assert.equal((await fetch(url, { headers: { 'x-boss-desktop-token': 'fixture-token' } })).status, 200);
    console.log('PASS | 风控配置不可覆盖、旧字段自动迁移、长休息跨重启、桌面服务凭据校验');
  } finally { if (server) await new Promise(resolve => server.close(resolve)); assert.ok(dir.startsWith(base + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
