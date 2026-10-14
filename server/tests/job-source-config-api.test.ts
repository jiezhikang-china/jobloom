import './fixtures/activate-isolated-safety.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { ConfigManager, configManager } from '../src/config/config.manager.js';
import { apiRouter } from '../src/routes/api.router.js';

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jobloom-source-api-'));
  const file = path.join(directory, 'config.json');
  const store = new ConfigManager(file);
  store.updateConfig({ filter: { ...store.getConfig().filter, commute: { maxDistanceKm: 12.5 } } });
  const oldGet = configManager.getConfig, oldUpdate = configManager.updateConfig;
  configManager.getConfig = () => store.getConfig();
  configManager.updateConfig = partial => store.updateConfig(partial);
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const endpoint = 'http://127.0.0.1:' + (server.address() as any).port + '/api/config';
    const before = store.getConfig().filter;
    for (const source of ['saved_expectations', 'search', 'recommendation', 'message_recommendations']) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delivery: { jobSource: source } }) });
      assert.equal(response.status, 200, source + ' must pass the real HTTP validation');
      assert.equal((await response.json()).data.delivery.jobSource, source);
      assert.equal((await (await fetch(endpoint)).json()).data.delivery.jobSource, source);
      assert.equal(new ConfigManager(file).getConfig().delivery.jobSource, source);
      assert.deepEqual(store.getConfig().filter, before, '切换来源不能改掉筛选条件');
    }
    const saved = fs.readFileSync(file, 'utf8');
    for (const source of ['invalid', '', null, 1]) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delivery: { jobSource: source } }) });
      assert.equal(response.status, 400); assert.equal(fs.readFileSync(file, 'utf8'), saved);
    }
    console.log('PASS | four source modes POST/GET/restart, filters preserved, invalid values rejected without overwriting; no account operations');
  } finally {
    configManager.getConfig = oldGet; configManager.updateConfig = oldUpdate;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
