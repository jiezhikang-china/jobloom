import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { apiRouter } from '../src/routes/api.router.js';
import { configManager } from '../src/config/config.manager.js';
import { browserService } from '../src/services/browser.service.js';
import { deliveryService } from '../src/services/delivery.service.js';
import { workConditionReviews } from '../src/services/work-condition-reviews.js';
import type { WorkConditionReview } from '../src/types.js';

const restores: Array<() => void> = [];
function stub(object: any, key: string, replacement: any) {
  const original = object[key]; object[key] = replacement; restores.push(() => { object[key] = original; });
}
async function main() {
  const original = configManager.getConfig();
  let config = (configManager as any).normalize({ ...original, targetPosition: undefined, filter: {
    ...original.filter, salaryMin: 15, salaryMax: 40, workRequirements: [],
  }, delivery: { ...original.delivery, dailyMaxQuota: 5 } });
  const fixture: WorkConditionReview = {
    id: 'abcdef0123456789abcd', jobHref: 'https://www.zhipin.com/job_detail/ui_fixture.html',
    jobName: '行政助理（测试岗位）', companyName: '测试公司', salary: '4-6K', reason: '需确认：每天实际工作不超过八小时',
    requirements: [
      { id: 'hours', text: '每天工作不超过八小时', enabled: true, builtin: 'eightHours' },
      { id: 'rest', text: '每周双休', enabled: true, builtin: 'doubleRest' },
      { id: 'experience', text: '允许无经验入职', enabled: true, builtin: 'noExperience' },
    ],
    assessment: [
      { requirementId: 'hours', text: '每天工作不超过八小时', status: 'unknown', evidence: '' },
      { requirementId: 'rest', text: '每周双休', status: 'met', evidence: '每周双休' },
      { requirementId: 'experience', text: '允许无经验入职', status: 'met', evidence: '经验不限' },
    ],
    question: '您好，请问具体的上下班时间是什么？是否有强制加班？', updatedAt: new Date().toISOString(),
  };
  let reviews = [fixture];
  const starts: any[] = [];
  stub(configManager, 'getConfig', () => config);
  stub(configManager, 'updateConfig', (partial: any) => {
    config = (configManager as any).normalize({ ...config, ...partial, llm: { ...config.llm, ...partial.llm },
      filter: { ...config.filter, ...partial.filter }, delivery: { ...config.delivery, ...partial.delivery } });
    return config;
  });
  stub(browserService, 'checkLoginStatus', async () => ({ isLoggedIn: true, isBrowserActive: false, reasonCode: 'authenticated' }));
  stub(deliveryService, 'isActive', () => false);
  stub(deliveryService, 'startDelivery', async (params: any) => { starts.push(params); });
  stub(workConditionReviews, 'list', () => reviews);
  stub(workConditionReviews, 'remove', (id: string) => { reviews = reviews.filter((item) => item.id !== id); });
  const app = express();
  app.use(express.json()); app.use('/api', apiRouter);
  app.use(express.static(path.resolve(process.cwd(), '../client/dist')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1340, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => void dialog.accept());
    await page.route('**/api/boss/positions', (route) => route.fulfill({ json: { success: true, data: {
      fetchedAt: new Date().toISOString(), categories: [], positionCount: 0,
    } } }));
    await page.goto(base);
    const startButton = page.getByRole('main').getByRole('button', { name: '开始投递', exact: true });
    await startButton.click();
    await page.getByRole('status').filter({ hasText: '请从 BOSS 官方分类中选择具体岗位' }).waitFor();
    assert.equal(starts.length, 0);
    await page.getByRole('checkbox', { name: '不限岗位，按工作条件找', exact: true }).check();
    const conditions = page.getByRole('region', { name: '工作条件', exact: true });
    const labels = ['每天工作不超过八小时', '每周双休', '允许无经验入职'];
    for (const label of labels) assert.equal(await conditions.getByRole('checkbox', { name: '启用条件：' + label, exact: true }).isChecked(), true);
    await page.getByRole('button', { name: '薪资改为不限', exact: true }).click();
    for (const label of labels) await conditions.getByRole('checkbox', { name: '启用条件：' + label, exact: true }).uncheck();
    await startButton.click();
    await page.getByRole('status').filter({ hasText: '请至少选择一项工作条件' }).waitFor();
    assert.equal(starts.length, 0);
    await conditions.getByRole('button', { name: '加入八小时·双休·无经验', exact: true }).click();
    await conditions.getByLabel('新增工作条件', { exact: true }).fill('不做销售');
    await conditions.getByRole('button', { name: '添加条件', exact: true }).click();
    assert.equal(await conditions.getByRole('checkbox', { name: '启用条件：不做销售', exact: true }).isChecked(), true);
    await page.getByLabel('补充要求').fill('不做销售，优先文职岗位。');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/delivery/start') && response.request().method() === 'POST'),
      startButton.click(),
    ]);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].positionCode, undefined);
    assert.equal(starts[0].candidateSource, 'requirements');
    assert.deepEqual(new Set(starts[0].keywords), new Set(['八小时', '双休', '经验不限']));
    assert.match(starts[0].resumeText, /不做销售/);
    assert.equal(config.filter.salaryMin, 0);
    assert.equal(config.filter.salaryMax, 0, '薪资不限必须真正保存并替代旧的 15-40K 范围');
    assert.equal(config.filter.workRequirements.length, 4);
    assert.equal(config.filter.workRequirements.find((item: any) => item.text === '不做销售').enabled, true);
    assert.match(starts[0].resumeText, /不做销售/);
    const panel = page.getByRole('region', { name: '待确认岗位', exact: true });
    await panel.getByText(fixture.jobName, { exact: true }).waitFor();
    assert.equal(await panel.getByRole('link', { name: fixture.jobName }).getAttribute('href'), fixture.jobHref);
    assert.match(await panel.innerText(), /记录时未自动投递/);
    assert.match(await panel.innerText(), /岗位描述未提供明确依据/);
    await panel.getByRole('button', { name: '复制询问内容', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: '询问内容已复制' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fixture.question);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.resolve(process.cwd(), '../data/work-condition-reviews-preview.png'), fullPage: true });
    await panel.getByRole('button', { name: '移除记录：' + fixture.jobName, exact: true }).click();
    await panel.getByText(/暂时没有待确认岗位/).waitFor();
    assert.equal(reviews.length, 0);
    await page.getByRole('button', { name: '筛选规则', exact: true }).click();
    assert.equal(await page.getByLabel('期望月薪下限').inputValue(), '');
    assert.equal(await page.getByLabel('期望月薪上限').inputValue(), '');
    await conditions.getByRole('checkbox', { name: '启用条件：' + labels[0], exact: true }).uncheck();
    await conditions.getByRole('textbox', { name: '工作条件1', exact: true }).fill('每天工作不超过七小时');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/config') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '保存配置', exact: true }).click(),
    ]);
    await page.reload();
    await page.getByRole('button', { name: '筛选规则', exact: true }).click();
    assert.equal(await conditions.getByRole('checkbox', { name: '启用条件：每天工作不超过七小时', exact: true }).isChecked(), false);
    assert.equal(await conditions.getByRole('checkbox', { name: '启用条件：' + labels[1], exact: true }).isChecked(), true);
    assert.equal(await conditions.getByRole('checkbox', { name: '启用条件：' + labels[2], exact: true }).isChecked(), true);
    assert.equal(config.filter.workRequirements[0].builtin, undefined);
    await conditions.getByLabel('新增工作条件', { exact: true }).fill('必须缴纳五险一金');
    await conditions.getByRole('button', { name: '添加条件', exact: true }).click();
    await page.screenshot({ path: path.resolve(process.cwd(), '../data/work-conditions-preview.png'), fullPage: true });
    await conditions.getByRole('button', { name: '删除条件：必须缴纳五险一金', exact: true }).click();
    assert.equal(await conditions.getByRole('textbox', { name: '工作条件5', exact: true }).count(), 0);
    for (const label of labels.slice(1)) await conditions.getByRole('checkbox', { name: '启用条件：' + label, exact: true }).uncheck();
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/config') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '保存配置', exact: true }).click(),
    ]);
    await page.getByRole('navigation').getByRole('button', { name: '开始投递', exact: true }).click();
    await page.getByRole('checkbox', { name: '不限岗位，按工作条件找', exact: true }).check();
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/delivery/start') && response.request().method() === 'POST'),
      startButton.click(),
    ]);
    assert.equal(starts.length, 2);
    assert.deepEqual(starts[1].keywords, [''], '仅自定义条件时不能将“不做销售”错误用作岗位搜索词');
    assert.equal(config.filter.workRequirements.filter((item: any) => item.enabled).length, 1,
      '开启按条件搜索不能强制恢复三个预设');
    assert.deepEqual(errors, []);
    console.log('PASS | 自由添加/编辑/删除/启用条件、重启保存、仅自定义条件搜索、预设快捷添加、待确认原文与复制');
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const restore of restores.reverse()) restore();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
