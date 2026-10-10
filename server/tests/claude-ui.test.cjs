// UI fixture: all APIs are local samples; never opens BOSS, DeepSeek or account data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'data');
const catalog = require('../resources/boss-positions.json');
const positions = catalog.categories.flatMap(category => category.children.flatMap(subcategory => subcategory.children.map(position => ({
  code: position.code, name: position.name, categoryCode: category.code, categoryName: category.name, subcategoryCode: subcategory.code, subcategoryName: subcategory.name,
}))));
const target = positions.find(item => item.name === '新媒体运营') || positions.find(item => item.name.includes('运营'));
assert.ok(target);
const requirements = [
  { id: 'hours', text: '每天工作不超过八小时', enabled: true, builtin: 'eightHours' },
  { id: 'rest', text: '每周双休', enabled: true, builtin: 'doubleRest' },
  { id: 'experience', text: '允许无经验入职', enabled: true, builtin: 'noExperience' },
];
let config = { llm: { connectionMode: 'deepseek-web', model: 'deepseek-v4-flash', baseUrl: '', apiKey: '', temperature: .7, thinking: 'enabled', webSearch: false, jobBatchSize: 5, minRequestIntervalSeconds: 30 },
  targetPosition: target, targetPositions: [target], filter: { cityName: '上海', cityCode: '101020100', salaryMin: 5, salaryMax: 8, degree: ['本科'], experience: [], experienceMatchMode: 'flexible', candidateLanguages: '', hrActiveDaysLimit: 3, companyBlacklist: ['金融', '销售'], requiredKeywords: [], minLlmMatchScore: 75, workRequirements: requirements, commute: {} },
  delivery: { dailyMaxQuota: 80, jobSource: 'saved_expectations' } };
const stats = { status: 'idle', isPaused: false, needsCaptchaVerification: false, todayAppliedCount: 12, dailyMaxQuota: 80, totalScanned: 126, passedFilterCount: 18, markedNotSuitCount: 23, skippedByLlmErrorCount: 0, aiRequestCount: 4, localDecisionCount: 87, cachedEvaluationCount: 6 };
const review = { id: 'ui-review', jobHref: 'https://www.zhipin.com/job_detail/local_fixture.html', jobName: '内容运营（双休 / 可接受应届生）', companyName: '界面测试公司', salary: '5–8K·13薪', reason: '每天工作时间需要确认', requirements,
  assessment: requirements.map(item => ({ requirementId: item.id, text: item.text, status: item.id === 'hours' ? 'unknown' : 'met', evidence: item.id === 'rest' ? '周末双休' : item.id === 'experience' ? '应届生可投' : '' })),
  question: '请问岗位的上下班时间？', evaluationSource: 'ai', score: 78, updatedAt: '2026-10-07T02:00:00.000Z' };
const source = { id: 'ui-resume', format: 'pdf', fileName: '测试简历.pdf', text: '内容运营求职简历\n参与校园活动策划与社交媒体内容制作，关注文案、数据和用户反馈。' };
const tailored = { targetRole: target.name, rewrittenResumeMarkdown: '', topHighlights: ['有内容制作与活动协作经验', '关注数据反馈，持续改进内容', '能够主动沟通并推进任务'], defaultGreetingPitch: '您好，我对这个岗位很感兴趣，希望有机会进一步沟通。',
  pdf: { id: 'ui-pdf', sourceId: source.id, targetRole: target.name, fileName: '测试简历_优化.pdf', pageCount: 1, downloadUrl: '/api/fixture.pdf', previewUrls: ['/api/fixture-preview.svg'], text: source.text,
    changes: [{ id: 'paragraph', page: 1, before: '负责内容', after: '参与内容策划与发布，并根据用户反馈调整内容。' }] } };
const diagnosis = { summary: '你有内容制作和活动协作经验，可以从运营助理或新媒体运营方向开始，积累实际项目经验。', coreSkills: ['内容制作', '活动协作', '沟通表达'], recommendations: [{ roleTitle: target.name, positionCode: target.code, matchScore: 84, recommendedReason: '已有经历与内容、运营协作相关，适合从执行岗位积累经验。', advantages: ['有内容制作经历', '能根据反馈改进工作'], gapAdvice: ['准备一份作品示例'], keywords: ['内容运营', '新媒体运营'] }] };
const requests = [];
const blocked = true;
const app = express();
app.use(express.json());
app.use('/api', (req, res) => {
  requests.push({ path: req.path, method: req.method });
  if (req.path === '/delivery/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ type: 'init', stats, logs: [
      { id: '1', timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'success', message: '本地测试：候选岗位已通过 AI 评估。', score: 78 },
      { id: '2', timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'info', message: '本地测试：已完成公司介绍与工作条件初筛。' },
    ] }) + '\n\n'); return;
  }
  if (req.path === '/fixture-preview.svg') {
    res.type('svg').send('<svg xmlns="http://www.w3.org/2000/svg" width="595" height="842"><rect width="595" height="842" fill="white"/><text x="50" y="90" font-family="Microsoft YaHei" font-size="26" fill="#141413">测试简历 · 内容运营</text><path d="M50 115H545" stroke="#b7b4aa"/><text x="50" y="170" font-family="Microsoft YaHei" font-size="16" fill="#47463f">这是本地界面测试样本，未使用真实简历。</text></svg>'); return;
  }
  if (req.path === '/config' && req.method === 'POST') config = { ...config, ...req.body };
  const data = req.path === '/config' ? config
    : req.path === '/resume/current' ? { source, tailored }
    : req.path === '/resume/diagnose' ? diagnosis
    : req.path === '/boss/positions' ? catalog
    : req.path === '/presets' ? [{ id: 'deepseek-web-flash', name: 'DeepSeek 网页', badge: '网页登录', connectionMode: 'deepseek-web', model: config.llm.model, baseUrl: '', description: '使用本机保存的 DeepSeek 网页账号。', applyUrl: '' }]
    : req.path === '/browser/status' ? { isLoggedIn: true, isBrowserActive: true, reasonCode: 'authenticated' }
    : req.path === '/boss/automation-safety' ? { blocked, hold: blocked ? { id: 'ui-hold', reason: 'platform_verification', message: '本地测试：BOSS 页面需要人工验证。', detectedAt: new Date().toISOString() } : null }
    : req.path === '/delivery/work-condition-reviews' ? [review]
    : req.path === '/delivery/not-suitable' ? []
    : req.path === '/llm/web/status' ? { state: 'ready', message: '本地测试：登录状态已保存。', hasCredential: true, busy: false, retryAfterSeconds: 0, loginWindowOpen: false }
    : req.path === '/location/map' ? { tileUrl: '/api/tiles/{z}/{x}/{y}.svg', attribution: 'OpenStreetMap 界面测试' } : null;
  if (req.path.startsWith('/tiles/')) { res.type('svg').send('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e9e7db"/><path d="M0 120H256M90 0V256" stroke="#fffefc" stroke-width="18"/></svg>'); return; }
  if (data === null) { res.status(404).json({ success: false, message: 'Fixture endpoint unavailable: ' + req.path }); return; }
  res.json({ success: true, data });
});
app.use(express.static(path.join(root, 'client/dist')));
async function main() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1320, height: 860 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const hostname = new URL(route.request().url()).hostname;
      return hostname === '127.0.0.1' ? route.continue() : route.abort();
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.locator('.launch-summary').getByText('上海', { exact: true }).waitFor();
    const main = page.getByRole('main');
    const nav = page.getByRole('navigation');
    await page.waitForFunction(() => !document.querySelector('.launch-submit').disabled);
    assert.equal(await page.locator('.nav-item[aria-current="page"]').getAttribute('aria-label'), '开始投递');
    const start = main.getByRole('button', { name: '开始投递', exact: true });
    const box = await start.boundingBox();
    assert.ok(box.y + box.height < 860, 'Start action must be visible in the desktop viewport');
    await page.screenshot({ path: path.join(output, 'claude-ui-launch.png') });
    await page.getByLabel('筛选城市', { exact: true }).selectOption('101210100');
    assert.match(await page.locator('.summary-details').innerText(), /杭州/);
    await page.getByLabel('筛选城市', { exact: true }).selectOption('101020100');
    const secondTarget = positions.find(item => item.name === '网络客服');
    assert.ok(secondTarget);
    const targets = page.getByRole('region', { name: 'BOSS 自选目标设置', exact: true });
    await targets.getByRole('button', { name: '添加目标岗位', exact: true }).click();
    const secondSlot = targets.locator('[aria-label="目标岗位2"]');
    await secondSlot.getByLabel('职位大类', { exact: true }).selectOption(secondTarget.categoryCode);
    await secondSlot.getByLabel('职位子类', { exact: true }).selectOption(secondTarget.subcategoryCode);
    await secondSlot.getByLabel('具体岗位', { exact: true }).selectOption(secondTarget.code);
    assert.ok((await page.locator('.summary-section').first().innerText()).includes(secondTarget.name));
    await page.getByLabel('BOSS 职位来源', { exact: true }).selectOption('search');
    assert.ok(!(await page.locator('.summary-section').first().innerText()).includes(secondTarget.name),
      'Search summary must show only the current category, not saved expectation slots');
    await page.getByRole('checkbox', { name: '不限岗位，按工作条件找', exact: true }).check();
    assert.ok((await page.locator('.summary-section').first().innerText()).includes('按工作条件找岗位'));
    await page.getByRole('checkbox', { name: '不限岗位，按工作条件找', exact: true }).uncheck();
    await page.getByLabel('BOSS 职位来源', { exact: true }).selectOption('saved_expectations');
    await targets.getByRole('button', { name: '移除目标2', exact: true }).click();
    await main.evaluate(node => { node.scrollTop = 550; });
    const stickyBox = await start.boundingBox();
    assert.ok(stickyBox.y > 80 && stickyBox.y + stickyBox.height < 860, 'Start action remains visible while editing');
    await nav.getByRole('button', { name: '运行记录', exact: true }).click();
    await main.getByText(review.salary, { exact: false }).waitFor();
    await page.screenshot({ path: path.join(output, 'claude-ui-delivery.png') });
    await main.getByRole('region', { name: '待确认岗位', exact: true }).screenshot({ path: path.join(output, 'claude-ui-review.png') });
    await nav.getByRole('button', { name: '简历分析', exact: true }).click();
    await main.getByRole('button', { name: '分析简历与推荐岗位', exact: true }).click();
    await main.getByText(diagnosis.summary, { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'claude-ui-resume.png') });
    await nav.getByRole('button', { name: '简历优化', exact: true }).click();
    await main.getByRole('region', { name: '优化 PDF 简历' }).waitFor();
    await page.screenshot({ path: path.join(output, 'claude-ui-pdf.png') });
    await nav.getByRole('button', { name: '设置', exact: true }).click();
    await main.getByRole('region', { name: 'DeepSeek 网页账号' }).getByText('已登录', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'claude-ui-settings.png') });
    await nav.getByRole('button', { name: '筛选规则', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'claude-ui-rules.png') });
    for (const width of [900, 390]) {
      await page.setViewportSize({ width, height: 860 });
      for (const label of ['开始投递', '运行记录', '筛选规则', '简历分析', '简历优化', '设置']) {
        await nav.getByRole('button', { name: label, exact: true }).click();
        await page.waitForTimeout(80);
        const sizes = await page.evaluate(() => ({ body: document.documentElement.scrollWidth, viewport: innerWidth, main: document.querySelector('main').scrollWidth, client: document.querySelector('main').clientWidth }));
        assert.ok(sizes.body <= sizes.viewport + 1 && sizes.main <= sizes.client + 1, label + ' has horizontal overflow at ' + width + ': ' + JSON.stringify(sizes));
      }
      await nav.getByRole('button', { name: '开始投递', exact: true }).click();
      await page.screenshot({ path: path.join(output, 'claude-ui-' + width + '.png') });
    }
    assert.ok(!requests.some(item => item.path === '/delivery/start' || item.path === '/resume/boss/upload'), 'Reviewing UI must not deliver jobs or upload resumes');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'claude-ui-verification.json'), JSON.stringify({ passed: true, pages: 6, widths: [1320, 900, 390], startVisible: true, stickyAction: true, summaryUpdates: true, pageErrors: errors }, null, 2));
    assert.equal(await page.getByRole('heading', { name: 'BOSS 自动操作已停止', exact: true }).count(), 0);
    assert.equal(requests.some(request => request.path === '/boss/automation-safety'), false, '界面不轮询全局停止状态');
    console.log('PASS | Claude workspace: six pages, three widths, sticky start, live summary, Chinese and salary rendering.');
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });