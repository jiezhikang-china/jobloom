import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { apiRouter } from '../src/routes/api.router.js';
import { configManager } from '../src/config/config.manager.js';
import { deepseekProxyService } from '../src/services/deepseek.proxy.service.js';

const originalGet = configManager.getConfig;
const originalUpdate = configManager.updateConfig;
let config = (configManager as any).normalize({ ...configManager.getConfig(), llm: {
  ...configManager.getConfig().llm, connectionMode: 'deepseek-web', apiKey: '', baseUrl: '', model: 'deepseek-v4-flash',
} });
configManager.getConfig = () => config;
configManager.updateConfig = (partial) => {
  config = (configManager as any).normalize({ ...config, ...partial, llm: { ...config.llm, ...partial.llm } });
  return config;
};

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  app.use(express.static(path.resolve(process.cwd(), '../client/dist')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  let browser;
  try {
    const statusResult: any = await (await fetch(`${base}/api/llm/web/status`)).json();
    assert.equal(statusResult.success, true);
    assert.equal(statusResult.data.running, true);
    assert.equal(statusResult.data.models.length, 2);
    const blocked = await fetch(`${base}/api/llm/web/login`, { method: 'POST', headers: { Origin: 'https://foreign.example' } });
    assert.equal(blocked.status, 403, 'foreign webpages must not open login windows');
    const invalid = await fetch(`${base}/api/llm/web/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"token":"invalid token with spaces"}' });
    assert.equal(invalid.status, 502);
    assert.match((await invalid.json() as any).message, /格式无效/);
    if (!statusResult.data.hasCredential) {
      const test = await fetch(`${base}/api/llm/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ llm: config.llm }) });
      assert.equal(test.status, 502);
      assert.match((await test.json() as any).message, /登录/);
    }
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1320, height: 950 } });
    const uiErrors: string[] = [];
    page.on('pageerror', (error) => uiErrors.push(error.message));
    await page.route('**/api/browser/status', (route) => route.fulfill({ json: { success: true, data: { isLoggedIn: true, reasonCode: 'authenticated' } } }));
    await page.route('**/api/boss/positions', (route) => route.fulfill({ json: { success: true, data: { fetchedAt: new Date().toISOString(), categories: [], positionCount: 0 } } }));
    await page.goto(base);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const panel = page.getByRole('region', { name: 'DeepSeek 网页账号' });
    await panel.waitFor();
    await page.getByRole('button', { name: '打开 DeepSeek 登录', exact: true }).waitFor();
    const presets = page.locator('select').first();
    assert.equal(await presets.inputValue(), 'deepseek-web-flash');
    await presets.selectOption('deepseek-web-pro');
    await page.waitForFunction(() => document.querySelector('header')?.textContent?.includes('deepseek-v4-pro'));
    assert.equal(config.llm.connectionMode, 'deepseek-web');
    assert.equal(config.llm.apiKey, '');
    await presets.selectOption('custom-api');
    await page.getByText('接口地址（Base URL）', { exact: true }).waitFor();
    assert.equal(config.llm.connectionMode, 'api');
    assert.equal(config.llm.apiKey, '');
    await presets.selectOption('deepseek-web-flash');
    await panel.waitFor();
    assert.deepEqual(uiErrors, []);
    const screenshot = path.resolve(process.cwd(), '../data/deepseek-settings-preview.png');
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log('PASS | DeepSeek account panel, model switch, local proxy, login gating and origin protection');
  } finally {
    await browser?.close();
    await deepseekProxyService.stopIfIdle();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    configManager.getConfig = originalGet;
    configManager.updateConfig = originalUpdate;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
