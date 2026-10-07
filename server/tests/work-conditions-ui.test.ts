import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { apiRouter } from '../src/routes/api.router.js';
import { configManager } from '../src/config/config.manager.js';
import { browserService } from '../src/services/browser.service.js';
import { bossPageService } from '../src/services/boss.page.service.js';
import { deliveryService } from '../src/services/delivery.service.js';
import { workConditionReviews } from '../src/services/work-condition-reviews.js';
import type { WorkConditionReview } from '../src/types.js';
import { bossCatalogService, positionSelections } from '../src/services/boss.catalog.service.js';
import catalog from '../resources/boss-positions.json';
import { resumePdfService } from '../src/services/resume-pdf.service.js';
import { notSuitableStore } from '../src/services/not-suitable-store.js';
import { publicLocationService } from '../src/services/public-location.service.js';
import { deviceLocationService } from '../src/services/device-location.service.js';
import { isolateBossSafety } from './fixtures/safety.js';
import { bossAutomationSafety } from '../src/services/boss-automation-safety.js';

const restores: Array<() => void> = [];
function stub(object: any, key: string, replacement: any) {
  const original = object[key]; object[key] = replacement; restores.push(() => { object[key] = original; });
}
async function main() {
  restores.push(isolateBossSafety());
  const original = configManager.getConfig();
  let config = (configManager as any).normalize({ ...original, targetPosition: undefined, targetPositions: [], filter: {
    ...original.filter, salaryMin: 15, salaryMax: 40, workRequirements: [], commute: {},
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
    evaluationSource: 'ai', score: 58,
  };
  let reviews = [fixture];
  const starts: any[] = [];
  const reviewStarts: WorkConditionReview[][] = [];
  stub(configManager, 'getConfig', () => config);
  stub(configManager, 'updateConfig', (partial: any) => {
    config = (configManager as any).normalize({ ...config, ...partial, llm: { ...config.llm, ...partial.llm },
      filter: { ...config.filter, ...partial.filter }, delivery: { ...config.delivery, ...partial.delivery } });
    return config;
  });
  stub(browserService, 'checkLoginStatus', async () => ({ isLoggedIn: true, isBrowserActive: false, reasonCode: 'authenticated' }));
  stub(browserService, 'checkVisibleRestriction', async () => false);
  stub(bossCatalogService, 'getPositions', async () => catalog);
  stub(bossCatalogService, 'findPosition', async (code: string) => positionSelections(catalog.categories).find(item => item.code === code));
  stub(deliveryService, 'isActive', () => false);
  stub(resumePdfService, 'current', async () => null);
  stub(resumePdfService, 'latest', async () => null);
  stub(deliveryService, 'startDelivery', async (params: any) => { starts.push(params); });
  stub(deliveryService, 'startReviewDelivery', async (items: WorkConditionReview[]) => { reviewStarts.push(items); });
  stub(workConditionReviews, 'list', () => reviews);
  stub(workConditionReviews, 'pruneExcluded', () => ({ removed: 0 }));
  stub(workConditionReviews, 'remove', (id: string) => { reviews = reviews.filter((item) => item.id !== id); });
  const origin = { name: '人民广场', address: '上海市黄浦区人民大道185号', cityName: '上海', query: '上海人民广场',
    longitude: 121.481492, latitude: 31.234736, coordinateSystem: 'boss' };

  const app = express();
  let blocked = [{ id: 'f'.repeat(20), companyName: '界面测试屏蔽公司', jobs: [{ jobId: 'blocked', jobName: '旧岗位' }], updatedAt: new Date().toISOString() }];
  stub(notSuitableStore, 'list', () => blocked);
  stub(notSuitableStore, 'remove', (id: string) => { blocked = blocked.filter(row => row.id !== id); return true; });
  let publicLocations = 0, deviceLocations = 0, deviceAvailable = true;
  stub(publicLocationService, 'searchOrigins', async () => {
    publicLocations++; return [{ ...origin, coordinateSystem: 'gcj02', source: 'openstreetmap' }];
  });
  stub(deviceLocationService, 'getPosition', async () => {
    deviceLocations++;
    if (!deviceAvailable) throw Error('Windows 暂未提供当前位置，请直接搜索地址／地图选点');
    return { longitude: 121.4702, latitude: 31.2283, coordinateSystem: 'wgs84', accuracyMeters: 150, timestamp: new Date().toISOString() };
  });
  app.use(express.json()); app.use('/api', apiRouter);
  app.get('/health', (_req, res) => res.json({ app: 'boss-job-agent', integrationVersion: 29, status: 'ok' }));
  app.use(express.static(path.resolve(process.cwd(), '../client/dist')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1340, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ contentType: 'image/svg+xml', body:
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e6ece6"/><path d="M0 105H256M130 0V256" stroke="#fff" stroke-width="18"/><path d="M0 105H256M130 0V256" stroke="#c2d3cf" stroke-width="2"/></svg>' }));
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => void dialog.accept());
    await page.goto(base);
    await page.getByLabel('BOSS 职位来源', { exact: true }).selectOption('search');
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
    assert.match(await panel.innerText(), /AI 已评估.*匹配度 58 分/, '待确认岗位必须明确显示实际的 AI 介入');
    assert.equal(await panel.getByRole('button', { name: '复制询问内容', exact: true }).count(), 0);
    await panel.getByRole('button', { name: '投递岗位：' + fixture.jobName, exact: true }).click();
    await panel.getByRole('status').filter({ hasText: '已开始投递所选岗位' }).waitFor();
    assert.deepEqual(reviewStarts[0].map(item => item.id), [fixture.id], '卡片上的投递按钮必须启动实际投递入口');
    await panel.getByRole('checkbox', { name: '全选待确认岗位', exact: true }).check();
    await panel.getByRole('button', { name: '投递所选（1）', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: '已开始投递所选岗位' }).waitFor();
    assert.equal(reviewStarts.length, 2, '勾选后可批量投递');
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: path.resolve(process.cwd(), '../data/work-condition-reviews-preview.png') });
    await panel.getByRole('button', { name: '移除记录：' + fixture.jobName, exact: true }).click();
    await panel.getByText(/暂时没有待确认岗位/).waitFor();
    assert.equal(reviews.length, 0);
    await page.getByRole('button', { name: '筛选规则', exact: true }).click();
    assert.equal(await page.getByLabel('期望月薪下限').inputValue(), '');
    assert.equal(await page.getByLabel('期望月薪上限').inputValue(), '');
    const exclusions = page.getByRole('textbox', { name: '排除行业、岗位或公司（逗号分隔）', exact: true });
    const needed = page.getByRole('textbox', { name: '需求词', exact: true });
    await exclusions.fill('金融'); await exclusions.press('End'); await exclusions.pressSequentially(',');
    assert.equal(await exclusions.inputValue(), '金融,', '末尾逗号不能被重渲染吞掉');
    await exclusions.pressSequentially('销售');
    await exclusions.pressSequentially('，'); await exclusions.pressSequentially('助贷');
    await exclusions.pressSequentially('；'); await exclusions.pressSequentially('房产');
    assert.equal(await exclusions.inputValue(), '金融,销售，助贷；房产');
    await needed.fill('内容'); await needed.press('End'); await needed.pressSequentially(',');
    assert.equal(await needed.inputValue(), '内容,', '需求词同样保留正在编辑的分隔符');
    await needed.pressSequentially('编辑');
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/config') && r.request().method() === 'POST'),
      page.getByRole('button', { name: '保存配置', exact: true }).click()]);
    assert.deepEqual(config.filter.companyBlacklist, ['金融', '销售', '助贷', '房产']);
    assert.deepEqual(config.filter.requiredKeywords, ['内容', '编辑']);
    await page.reload(); await page.getByRole('button', { name: '筛选规则', exact: true }).click();
    assert.equal(await exclusions.inputValue(), '金融，销售，助贷，房产');
    // Restore this fixture's unrelated filters for the remaining interaction tests.
    await needed.fill('');
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/config') && r.request().method() === 'POST'),
      page.getByRole('button', { name: '保存配置', exact: true }).click()]);
    const pacing = page.getByRole('region', { name: '网页操作频率', exact: true });
    assert.equal(await pacing.count(), 0, '操作策略由程序管理，不提供用户设置');
    assert.equal(await page.getByText('选择岗位的浏览间隔（秒）', { exact: true }).count(), 0);
    const location = page.getByRole('region', { name: '位置与通勤筛选', exact: true });
    assert.equal(await location.getByLabel('定位接口来源').count(), 0);
    assert.equal(await location.getByLabel('地图 API Key').count(), 0);
    await location.getByLabel('出发城市', { exact: true }).fill('上海');
    await location.getByLabel('出发位置搜索', { exact: true }).fill('人民广场');
    await location.getByRole('button', { name: '搜索位置', exact: true }).click();
    await location.getByRole('button', { name: /人民广场.*人民大道185号/ }).click();
    await location.getByRole('checkbox', { name: '启用直线距离上限', exact: true }).check();
    await location.getByLabel('最大直线距离', { exact: true }).fill('12.5');
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/config') && r.request().method() === 'POST'),
      page.getByRole('button', { name: '保存配置', exact: true }).click()]);
    assert.equal(publicLocations, 1); assert.equal(config.filter.commute.origin.name, '人民广场');
    assert.equal(config.filter.commute.maxDistanceKm, 12.5); assert.equal(config.filter.commute.maxTransitMinutes, undefined);
    assert.equal(config.delivery.operationIntervalSeconds, undefined); assert.equal(config.delivery.operationBurstLimit, undefined);
    assert.equal(config.delivery.operationRestSeconds, undefined); assert.equal(config.delivery.feedbackIntervalSeconds, undefined);
    await page.reload(); await page.getByRole('button', { name: '筛选规则', exact: true }).click();
    assert.match(await location.innerText(), /出发位置：上海 · 人民广场/);
    assert.equal(await location.getByLabel('最大直线距离', { exact: true }).inputValue(), '12.5');
    assert.equal(await location.getByLabel('最大公交地铁通勤时间', { exact: true }).count(), 0);
    assert.equal(await pacing.count(), 0);
    await location.screenshot({ path: path.resolve(process.cwd(), '../data/location-filter-preview.png') });
    await location.getByText('手动填写经纬度', { exact: true }).click();
    await location.getByLabel('手动位置名称').fill('住处');
    await location.getByLabel('手动经度').fill('121.47'); await location.getByLabel('手动纬度').fill('31.23');
    await location.getByRole('button', { name: '使用这组坐标', exact: true }).click();
    await location.getByRole('status').filter({ hasText: '出发位置：上海 · 住处' }).waitFor();
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/config') && r.request().method() === 'POST'), page.getByRole('button', { name: '保存配置', exact: true }).click()]);
    assert.equal(config.filter.commute.origin.source, 'manual'); assert.equal('locationApi' in config.filter.commute, false);
    await page.reload(); await page.getByRole('button', { name: '筛选规则', exact: true }).click();
    assert.equal(await location.getByLabel('地图 API Key').count(), 0);
    assert.match(await location.innerText(), /出发位置：上海 · 住处/);
    await page.getByText('本地不感兴趣清单 · 1 家公司', { exact: true }).click();
    await page.getByRole('button', { name: '撤销本地屏蔽：界面测试屏蔽公司', exact: true }).click();
    await page.getByText('尚无本地屏蔽记录。', { exact: true }).waitFor();
    assert.equal(blocked.length, 0);
    for (const commute of [{ maxDistanceKm: -1 }, { origin: { ...origin, coordinateSystem: 'wgs84' } }]) {
      const invalid = await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filter: { commute } }) });
      assert.equal(invalid.status, 400);
    }
    assert.equal(config.filter.commute.maxDistanceKm, 12.5, '非法设置不能覆盖原距离');
    await location.getByRole('checkbox', { name: '启用直线距离上限', exact: true }).uncheck();
    await location.getByRole('button', { name: '清除出发位置', exact: true }).click();
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/config') && r.request().method() === 'POST'),
      page.getByRole('button', { name: '保存配置', exact: true }).click()]);
    assert.equal(config.filter.commute.origin, undefined); assert.equal(config.filter.commute.maxDistanceKm, 0);
    assert.equal(await location.getByLabel('地图 API Key').count(), 0, '免费地图不要求Key');
    const withoutClick = await fetch(base + '/api/location/device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(withoutClick.status, 400);
    const foreignPage = await fetch(base + '/api/location/device', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' }, body: JSON.stringify({ userInitiated: true }) });
    assert.equal(foreignPage.status, 403);
    assert.equal(deviceLocations, 0, '打开界面与配置不自动获取用户位置');
    await location.getByRole('button', { name: '获取当前位置', exact: true }).click();
    await location.getByLabel('确认地图出发点').waitFor();
    await location.getByText('系统返回的精度范围约 150 米，请核对地图标记。', { exact: true }).waitFor();
    assert.equal(deviceLocations, 1); assert.equal(config.filter.commute.origin, undefined, '定位只给候选，未确认不能覆盖原点');
    const map = location.getByLabel('出发位置地图', { exact: true });
    await map.locator('.leaflet-control-zoom-in').waitFor();
    await map.locator('.leaflet-overlay-pane .leaflet-interactive').first().waitFor();
    await map.click({ position: { x: 450, y: 130 } });
    await location.getByText('请核对地图标记；在地图点击可以调整位置。', { exact: true }).waitFor();
    await location.getByLabel('地图位置名称').fill('地图住处');
    await location.getByRole('button', { name: '使用此出发点', exact: true }).click();
    await location.getByRole('status').filter({ hasText: '出发位置：上海 · 地图住处' }).waitFor();
    assert.equal(config.filter.commute.origin, undefined, '选点仍需保存筛选规则');
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/config') && r.request().method() === 'POST'), page.getByRole('button', { name: '保存配置', exact: true }).click()]);
    assert.equal(config.filter.commute.origin.coordinateSystem, 'gcj02');
    assert.equal(config.filter.commute.origin.name, '地图住处');
    await page.reload(); await page.getByRole('button', { name: '筛选规则', exact: true }).click();
    assert.equal(deviceLocations, 1, '重载不会后台跟踪位置');
    await location.getByRole('button', { name: '地图选点', exact: true }).click();
    const convertedResponse = await page.waitForResponse(r => r.url().endsWith('/api/location/map-point'));
    assert.equal(convertedResponse.status(), 200, '已保存位置显示回OSM时转换坐标系');
    await map.locator('.leaflet-overlay-pane .leaflet-interactive').first().waitFor();
    await location.screenshot({ path: path.resolve(process.cwd(), '../data/public-location-ui-preview.png') });
    await location.getByRole('button', { name: '收起地图', exact: true }).click();
    deviceAvailable = false;
    await location.getByRole('button', { name: '获取当前位置', exact: true }).click();
    await location.getByRole('alert').filter({ hasText: 'Windows 暂未提供当前位置' }).waitFor();
    assert.equal(config.filter.commute.origin.name, '地图住处', '定位失败不覆盖已有位置');
    await location.getByLabel('出发位置搜索', { exact: true }).fill('人民广场');
    await location.getByRole('button', { name: '搜索位置', exact: true }).click();
    await location.getByRole('button', { name: /人民广场.*人民大道185号/ }).click();
    assert.equal(publicLocations, 2);
    await location.getByRole('button', { name: '清除出发位置', exact: true }).click();
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/config') && r.request().method() === 'POST'), page.getByRole('button', { name: '保存配置', exact: true }).click()]);
    await page.getByLabel('我的语言能力', { exact: true }).fill('英语 CET4；西班牙语 C1');
    assert.equal(await page.getByLabel('经验筛选方式', { exact: true }).inputValue(), 'flexible');
    await page.getByLabel('经验筛选方式', { exact: true }).selectOption('strict');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/config') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '保存配置', exact: true }).click(),
    ]);
    assert.equal(config.filter.experienceMatchMode, 'strict');
    await page.reload();
    await page.getByRole('button', { name: '筛选规则', exact: true }).click();
    assert.equal(await page.getByLabel('我的语言能力', { exact: true }).inputValue(), '英语 CET4；西班牙语 C1', '自己的语言能力须保存并恢复');
    assert.equal(await page.getByLabel('经验筛选方式', { exact: true }).inputValue(), 'strict', '严格模式须可保存并恢复');
    await page.getByLabel('经验筛选方式', { exact: true }).selectOption('flexible');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/config') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '保存配置', exact: true }).click(),
    ]);
    assert.equal(config.filter.experienceMatchMode, 'flexible');
    const invalidMode = await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { experienceMatchMode: 'invalid' } }) });
    assert.equal(invalidMode.status, 400);
    assert.equal(config.filter.experienceMatchMode, 'flexible', '非法筛选方式不能改变已保存的设置');
    const invalidLanguage = await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { candidateLanguages: ['英语'] } }) });
    assert.equal(invalidLanguage.status, 400);
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
    await page.getByRole('navigation').getByRole('button', { name: '开始投递', exact: true }).click();
    await page.getByLabel('BOSS 职位来源', { exact: true }).selectOption('saved_expectations');
    const targetPanel = page.getByRole('region', { name: 'BOSS 自选目标设置', exact: true });
    await targetPanel.getByLabel('具体岗位', { exact: true }).first().waitFor();
    const targetNames = ['网络客服', '数据采集', '数据标注/AI训练师'];
    for (let index = 0; index < targetNames.length; index++) {
      if (index) await targetPanel.getByRole('button', { name: '添加目标岗位', exact: true }).click();
      const slot = targetPanel.locator(`[aria-label="目标岗位${index + 1}"]`);
      const position = positionSelections(catalog.categories).find(item => item.name === targetNames[index])!;
      await slot.getByLabel('职位大类', { exact: true }).selectOption(position.categoryCode);
      await slot.getByLabel('职位子类', { exact: true }).selectOption(position.subcategoryCode);
      await slot.getByLabel('具体岗位', { exact: true }).selectOption(position.code);
    }
    assert.equal(await targetPanel.getByRole('button', { name: '添加目标岗位', exact: true }).count(), 0, '只能添加三个位置');
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/delivery/start') && response.request().method() === 'POST'),
      startButton.click(),
    ]);
    assert.equal(starts.length, 3);
    assert.deepEqual(starts[2].targetPositions.map((item: any) => item.name), targetNames);
    assert.equal(starts[2].rulesOnly, false, '按工作条件投递也须让通过初筛的岗位参与 AI 评估');
    assert.deepEqual(config.targetPositions.map((item: any) => item.name), targetNames);
    await page.reload();
    await page.waitForFunction((codes: string[]) => {
      const selected = [...document.querySelectorAll('[aria-label="BOSS 自选目标设置"] select[aria-label="具体岗位"]')];
      return selected.length === codes.length && codes.every((code, index) => (selected[index] as HTMLSelectElement).value === code);
    }, config.targetPositions.map((item: any) => item.code));
    for (let index = 0; index < targetNames.length; index++) {
      const slot = targetPanel.locator(`[aria-label="目标岗位${index + 1}"]`);
      assert.equal(await slot.getByLabel('具体岗位', { exact: true }).inputValue(), config.targetPositions[index].code, '重新打开须恢复全部目标');
    }
    await targetPanel.getByRole('button', { name: '移除目标2', exact: true }).click();
    assert.equal(await targetPanel.locator('[aria-label="目标岗位3"]').count(), 0);
    assert.deepEqual((await targetPanel.getByLabel('具体岗位', { exact: true }).allTextContents()).length, 2);
    const startsBeforeHold = starts.length;
    bossAutomationSafety.halt('user_reported_ban', '离线测试：BOSS 账号封禁，停止自动操作');
    await page.reload();
    const safetyPanel = page.getByRole('region', { name: 'BOSS 自动操作状态', exact: true });
    await safetyPanel.getByRole('heading', { name: 'BOSS 自动操作已停止', exact: true }).waitFor();
    assert.equal(await page.locator('.launch-submit').isDisabled(), true, '封禁停止状态下不能启动投递');
    const recovery = safetyPanel.getByRole('button', { name: '确认已恢复（不启动投递）', exact: true });
    assert.equal(await recovery.isDisabled(), true, '恢复需要明确人工确认');
    await safetyPanel.getByRole('checkbox').check();
    await recovery.click();
    await safetyPanel.waitFor({ state: 'detached' });
    assert.equal(starts.length, startsBeforeHold, '确认恢复不能自动投递');
    assert.deepEqual(errors, []);
    console.log('PASS | 三个自选目标、条件与定位设置、待确认投递、封禁横幅拦截、人工恢复不自动投递');
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const restore of restores.reverse()) restore();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
