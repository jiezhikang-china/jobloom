import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { apiRouter } from '../src/routes/api.router.js';
import { configManager } from '../src/config/config.manager.js';
import { resumeService } from '../src/services/resume.service.js';
import { resumePdfService } from '../src/services/resume-pdf.service.js';
import { resumeBossUploadService, ResumeCapacityError } from '../src/services/resume-boss-upload.service.js';
import { browserService } from '../src/services/browser.service.js';
import { deliveryService } from '../src/services/delivery.service.js';
import { bossCatalogService, positionSelections } from '../src/services/boss.catalog.service.js';
import catalog from '../resources/boss-positions.json';
import type { TailoredResumeResult } from '../src/types.js';
import { workConditionReviews } from '../src/services/work-condition-reviews.js';
import { notSuitableStore } from '../src/services/not-suitable-store.js';
import { isolateBossSafety } from './fixtures/safety.js';

const restores: Array<() => void> = [];
function stub(object: any, key: string, replacement: any) { const original = object[key]; object[key] = replacement; restores.push(() => { object[key] = original; }); }
async function main() {
  restores.push(isolateBossSafety());
  const root = path.resolve(process.cwd(), '..'), folder = await fs.promises.mkdtemp(path.join(root, 'data/resume-ui-test-'));
  const preview = path.join(folder, 'page.png');
  await fs.promises.writeFile(preview, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64'));
  const position = positionSelections(catalog.categories).find(item => item.name === '新媒体运营')!;
  const source = { id: 'resume_abcdef123456.pdf', fileName: '测试原简历.pdf', format: 'pdf', text: '•频道内容策划、发布与互动经验。'.repeat(6), updatedAt: new Date().toISOString() };
  const id = 'a'.repeat(32);
  let result: TailoredResumeResult | null = null, uploads: Array<string | undefined> = [], rewrites = 0;
  const app = express(); let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const attachments = [{ id: 'old_A_123456', name: '旧版简历.pdf', description: '第一份', canReplace: true },
    { id: 'old_B_123456', name: '其他简历.pdf', description: '第二份', canReplace: true }, { id: 'old_C_123456', name: '文档简历.docx', description: '第三份', canReplace: true }];
  let config = { ...configManager.getConfig(), targetPosition: position, targetPositions: [position] };
  stub(configManager, 'getConfig', () => config); stub(configManager, 'updateConfig', (partial: any) => { config = { ...config, ...partial }; return config; });
  stub(bossCatalogService, 'getPositions', async () => catalog); stub(browserService, 'checkLoginStatus', async () => ({ isLoggedIn: true, isBrowserActive: false }));
  stub(deliveryService, 'isActive', () => false); stub(deliveryService, 'subscribe', () => () => {});
  stub(deliveryService, 'getStats', () => ({ status: 'idle', isPaused: false, needsCaptchaVerification: false, todayAppliedCount: 0, dailyMaxQuota: 5 }));
  stub(deliveryService, 'getLogs', () => []);
  stub(workConditionReviews, 'listEligible', () => []); stub(notSuitableStore, 'list', () => []);
  stub(resumePdfService, 'current', async () => source); stub(resumePdfService, 'latest', async () => result);
  stub(resumePdfService, 'result', async () => result); stub(resumePdfService, 'pagePath', async () => preview);
  stub(resumeService, 'rewriteForTargetRole', async (sourceId: string, targetRole: string) => {
    assert.equal(sourceId, source.id); assert.equal(targetRole, position.name); rewrites++;
    result = { targetRole, rewrittenResumeMarkdown: '•规划与发布内容，完成评论区互动。', topHighlights: ['内容发布与互动'], defaultGreetingPitch: '您好，我有频道内容经验。',
      pdf: { id, sourceId, targetRole, fileName: '测试原简历_优化.pdf', pageCount: 1, changes: [{ id: 'p1-r1', page: 1, before: '频道内容发布与互动', after: '规划与发布内容，完成评论区互动。' }],
        text: '•规划与发布内容，完成评论区互动。', createdAt: new Date().toISOString(), downloadUrl: '/api/resume/pdf/' + id, previewUrls: ['/api/resume/pdf/' + id + '/pages/1'] } };
    return result;
  });
  stub(resumeBossUploadService, 'list', async () => ({ attachments, capacity: 3 }));
  stub(resumeBossUploadService, 'upload', async (artifactId: string, replaceId?: string) => {
    assert.equal(artifactId, id); uploads.push(replaceId);
    if (!replaceId) throw new ResumeCapacityError(attachments, 3);
    assert.equal(replaceId, attachments[0].id);
    result!.pdf!.bossUpload = { attachmentId: 'saved_123456', fileName: result!.pdf!.fileName, uploadedAt: new Date().toISOString() };
    return { id: 'saved_123456', name: result!.pdf!.fileName, description: '已保存', canReplace: true };
  });
  app.use(express.json()); app.use('/api', apiRouter); app.get('/health', (_req, res) => res.json({ app: 'boss-job-agent', integrationVersion: 25, status: 'ok' }));
  app.use(express.static(path.join(root, 'client/dist')));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  try {
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1340, height: 1000 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await page.getByRole('button', { name: '简历优化（可选）', exact: true }).click();
    await page.locator('.resume-source-help').filter({ hasText: '原 PDF：测试原简历.pdf，分析步骤可跳过。' }).waitFor();
    await page.getByRole('button', { name: '优化并生成原版式 PDF', exact: true }).click();
    const panel = page.getByRole('region', { name: '优化 PDF 简历', exact: true }); await panel.waitFor();
    assert.equal(rewrites, 1); assert.equal(await panel.getByRole('link', { name: '下载 PDF', exact: true }).getAttribute('href'), '/api/resume/pdf/' + id);
    const image = panel.getByAltText('优化 PDF 第 1 页'); await image.waitFor();
    await page.waitForFunction(() => (document.querySelector('.resume-pdf-pages img') as HTMLImageElement)?.naturalWidth > 0);
    await panel.getByRole('button', { name: '上传到 BOSS', exact: true }).click();
    await panel.getByLabel('要替换的 BOSS 附件', { exact: true }).waitFor();
    const replace = panel.getByRole('button', { name: '替换并上传优化 PDF', exact: true });
    assert.equal(await replace.isDisabled(), true); assert.deepEqual(uploads, [undefined]);
    await panel.getByLabel('要替换的 BOSS 附件', { exact: true }).selectOption(attachments[0].id); await replace.click();
    await panel.getByRole('status').filter({ hasText: '已保存到 BOSS' }).waitFor(); assert.deepEqual(uploads, [undefined, attachments[0].id]);
    await panel.getByText('查看润色前后（1 段）', { exact: true }).click(); assert.match(await panel.innerText(), /原文：频道内容发布与互动/);
    await page.reload(); await page.getByRole('button', { name: '简历优化（可选）', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: '已保存到 BOSS' }).waitFor();
    await panel.locator('.resume-pdf-header').screenshot({ path: path.join(root, 'data/resume-pdf-ui-preview.png') });
    assert.deepEqual(errors, []);
    console.log('PASS | 不分析即可优化、PDF 下载和预览、容量选择无默认删除、明确替换、成功状态、前后对照、跨重载恢复');
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const restore of restores.reverse()) restore();
    if (path.dirname(folder) === path.join(root, 'data') && path.basename(folder).startsWith('resume-ui-test-')) await fs.promises.rm(folder, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
