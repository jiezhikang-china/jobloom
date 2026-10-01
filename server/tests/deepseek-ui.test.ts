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
const originalStatus = deepseekProxyService.status;
const originalImport = deepseekProxyService.importToken;
const originalConnection = deepseekProxyService.connection;
let config = (configManager as any).normalize({ ...configManager.getConfig(), llm: {
  ...configManager.getConfig().llm, connectionMode: 'deepseek-web', apiKey: '', baseUrl: '', model: 'deepseek-v4-flash',
} });
configManager.getConfig = () => config;
configManager.updateConfig = (partial) => {
  config = (configManager as any).normalize({ ...config, ...partial, llm: { ...config.llm, ...partial.llm } });
  return config;
};
const webStatus = { running: true, state: 'not_logged_in', message: '请登录 DeepSeek 网页账号', hasCredential: false,
  loginWindowOpen: false, busy: false, retryAfterSeconds: 0, models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek 网页' }] };
(deepseekProxyService as any).status = async () => webStatus;
(deepseekProxyService as any).importToken = async () => { throw new Error('DeepSeek 登录凭据格式无效'); };
(deepseekProxyService as any).connection = async () => { throw new Error('请先登录 DeepSeek 网页账号'); };

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
    assert.equal(statusResult.data.models.length, 1);
    const available = await (await fetch(`${base}/api/presets`)).json() as any;
    assert.deepEqual(available.data.map((item: any) => item.id), ['deepseek-web-flash']);
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
    page.on('dialog', (dialog) => void dialog.accept());
    await page.route('**/api/browser/status', (route) => route.fulfill({ json: { success: true, data: { isLoggedIn: true, reasonCode: 'authenticated' } } }));
    await page.route('**/api/boss/positions', (route) => route.fulfill({ json: { success: true, data: { fetchedAt: new Date().toISOString(), categories: [], positionCount: 0 } } }));
    await page.goto(base);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const panel = page.getByRole('region', { name: 'DeepSeek 网页账号' });
    await panel.waitFor();
    await page.getByRole('button', { name: '打开 DeepSeek 登录', exact: true }).waitFor();
    const presets = page.getByLabel('AI 连接方式');
    assert.equal(await presets.inputValue(), 'deepseek-web-flash');
    const options = await presets.locator('option').allTextContents();
    assert.equal(options.length, 2, '仅保留 DeepSeek 网页与自定义接口');
    assert.ok(options.every((text) => !/GLM|\bPro\b/i.test(text)));
    assert.match(await page.locator('header').innerText(), /DeepSeek 网页/);
    assert.equal(config.llm.connectionMode, 'deepseek-web');
    assert.equal(config.llm.apiKey, '');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/config') && response.request().method() === 'POST'),
      presets.selectOption('custom-api'),
    ]);
    await page.getByText('接口地址（Base URL）', { exact: true }).waitFor();
    assert.equal(config.llm.connectionMode, 'api');
    assert.equal(config.llm.apiKey, '');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/config') && response.request().method() === 'POST'),
      presets.selectOption('deepseek-web-flash'),
    ]);
    await panel.waitFor();
    await page.getByRole('button', { name: '筛选规则', exact: true }).click();
    const degree = page.getByLabel('我的最高学历');
    assert.equal(await degree.inputValue(), '本科');
    await degree.selectOption('大专');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/config') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '保存配置', exact: true }).click(),
    ]);
    assert.deepEqual(config.filter.degree, ['大专']);
    await degree.selectOption('本科');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/config') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '保存配置', exact: true }).click(),
    ]);
    assert.deepEqual(config.filter.degree, ['本科']);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    assert.deepEqual(uiErrors, []);
    const screenshot = path.resolve(process.cwd(), '../data/deepseek-settings-preview.png');
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log('PASS | 精简 DeepSeek 设置、移除 GLM/Pro、最高学历选择与保存、自定义接口、登录提示和来源保护');
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    configManager.getConfig = originalGet;
    configManager.updateConfig = originalUpdate;
    deepseekProxyService.status = originalStatus;
    deepseekProxyService.importToken = originalImport;
    deepseekProxyService.connection = originalConnection;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
