import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { browserService } from '../src/services/browser.service.js';
import { ResumeBossUploadService, ResumeCapacityError, ResumeUploadUncertainError, readResumeAttachments } from '../src/services/resume-boss-upload.service.js';
import { resumePdfService } from '../src/services/resume-pdf.service.js';
import type { CdpPage } from '../src/services/cdp.page.js';

function fixture() {
  const state = (window as any).resumeTest = { attachments: [
    { id: 'original_A_123', name: '原版中文.pdf' }, { id: 'original_B_123', name: '其他简历.pdf' }, { id: 'original_C_123', name: '其他.docx' },
  ], deletes: [] as string[], saves: 0, uploads: 0, syncs: 0, failUpload: false, saveUncertain: false };
  const parent = document.querySelector('.sider-resume') as any;
  const render = () => {
    parent.__vue__ = { resumeInfo: { attachmentList: state.attachments } };
    parent.innerHTML = '<div class="resume-attachment"><div class="sider-title-operate"><button class="operate-list-item">上传简历</button></div>' +
      '<div class="resume-type-title">文件（' + state.attachments.length + '/3）</div>' + state.attachments.map((item: any) =>
        '<div class="annex-item"><div class="annex-item-operate"><a href="https://docdownload.zhipin.com/wflow/zpgeek/download/download4geek?resumeId=' + item.id + '">下载</a><button class="annex-operate-delete" data-id="' + item.id + '">删除</button></div><div class="annex-content"><div class="basis"><a title="' + item.name + '">' + item.name + '</a></div><div class="desc">测试附件</div></div></div>').join('') + '</div>';
    parent.querySelectorAll('.annex-operate-delete').forEach((button: HTMLElement) => button.onclick = () => {
      const id = button.dataset.id!; const dialog = document.createElement('div'); dialog.className = 'resume-delete';
      dialog.innerHTML = '确定删除该附件简历？<button class="btn-sure">确定</button>'; document.body.append(dialog);
      (dialog.querySelector('button') as HTMLElement).onclick = () => { state.deletes.push(id); state.attachments = state.attachments.filter((item: any) => item.id !== id); dialog.remove(); render(); };
    });
    (parent.querySelector('.operate-list-item') as HTMLElement).onclick = () => {
      const dialog = document.createElement('div'); dialog.className = 'upload-resume-dialog';
      dialog.innerHTML = '<input type="file" accept="application/pdf,.docx"><button ka="dialog_close">关闭</button><div class="upload-result"></div>';
      document.body.append(dialog);
      (dialog.querySelector('[ka="dialog_close"]') as HTMLElement).onclick = () => dialog.remove();
      (dialog.querySelector('input') as HTMLInputElement).onchange = event => {
        state.uploads++; const file = (event.target as HTMLInputElement).files![0];
        if (state.failUpload && file.name !== '原版中文.pdf') {
          dialog.querySelector('.upload-result')!.textContent = '上传失败'; return;
        }
        dialog.querySelector('.upload-result')!.textContent = file.name + ' 上传成功';
        const sure = document.createElement('button'); sure.setAttribute('ka', 'user_resume_add_sure'); sure.textContent = '确定添加'; dialog.append(sure);
        sure.onclick = () => {
          state.saves++;
          state.attachments.push({ id: 'saved_native_' + state.saves, name: file.name }); render(); dialog.remove();
          const sync = document.createElement('div'); sync.className = 'siderResume-dialog'; sync.innerHTML = '<button ka="dialog_close">关闭</button><button class="sync">发送简历</button>'; document.body.append(sync);
          (sync.querySelector('[ka="dialog_close"]') as HTMLElement).onclick = () => sync.remove();
          (sync.querySelector('.sync') as HTMLElement).onclick = () => { state.syncs++; };
        };
      };
    };
  };
  render();
}
async function main() {
  const root = path.resolve(process.cwd(), '..');
  const folder = await fs.promises.mkdtemp(path.join(root, 'data/resume-upload-test-'));
  const id = randomUUID().replace(/-/g, ''); const source = path.join(folder, 'resume.pdf');
  await fs.promises.writeFile(source, '%PDF-test-content');
  const originals = { editor: browserService.withResumeEditor, result: resumePdfService.result, pdfPath: resumePdfService.pdfPath,
    record: resumePdfService.recordBossUpload, attempt: resumePdfService.uploadAttempt, recordAttempt: resumePdfService.recordUploadAttempt, fetch: global.fetch };
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const page = await browser.newPage(); const wait = page.waitForFunction.bind(page);
  await page.addInitScript('window.__name = (fn) => fn');
  let attempt: any = null, recorded: any = null, backupCalls = 0, failSaveCheck = false;
  try {
    await page.route('https://www.zhipin.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div class="sider-resume"></div>' }));
    const reset = async () => { await page.goto('https://www.zhipin.com/web/geek/resume/'); await page.evaluate(fixture); attempt = null; recorded = null; failSaveCheck = false; };
    await reset();
    (page as any).fileInput = async (selector: string, files: string[]) => page.locator(selector).setInputFiles(files);
    (page as any).cookiesFor = async () => [{ name: 'fixture-session', value: 'fixture-only' }];
    (page as any).waitForFunction = async (fn: any, arg: any, options: any) => {
      if (failSaveCheck && arg?.beforeIds) throw new Error('保存等待超时');
      return wait(fn, arg, options);
    };
    browserService.withResumeEditor = async callback => callback(page as unknown as CdpPage);
    resumePdfService.result = async () => ({ targetRole: '内容运营', rewrittenResumeMarkdown: '测试文字', topHighlights: [], defaultGreetingPitch: '',
      pdf: { id, sourceId: 'fixture', targetRole: '内容运营', fileName: '优化后的中文简历.pdf', pageCount: 1, changes: [], text: '测试文字',
        downloadUrl: '', previewUrls: [], createdAt: new Date().toISOString(), ...(recorded ? { bossUpload: { attachmentId: recorded.id } as any } : {}) } });
    resumePdfService.pdfPath = async () => source;
    resumePdfService.recordBossUpload = async (_id, saved) => { recorded = saved; };
    resumePdfService.uploadAttempt = async () => attempt;
    resumePdfService.recordUploadAttempt = async (_id, state) => { attempt = state; };
    global.fetch = (async (url: any, options: any) => {
      backupCalls++; assert.equal(new URL(url).hostname, 'docdownload.zhipin.com'); assert.equal(options.redirect, 'error');
      return new Response('%PDF-old-attachment', { headers: { 'content-type': 'application/pdf' } });
    }) as typeof fetch;
    const uploads = new ResumeBossUploadService();
    await assert.rejects(uploads.upload(id), error => error instanceof ResumeCapacityError && error.attachments.length === 3);
    assert.equal(backupCalls, 0); assert.equal(await page.evaluate(() => (window as any).resumeTest.deletes.length), 0, '容量满时不擅自删除');
    const saved = await uploads.upload(id, 'original_A_123');
    assert.equal(saved.name, '优化后的中文简历.pdf'); assert.equal(recorded.id, saved.id); assert.equal(attempt, null);
    assert.deepEqual(await page.evaluate(() => (window as any).resumeTest.deletes), ['original_A_123']);
    assert.equal(backupCalls, 1); assert.equal(await page.evaluate(() => (window as any).resumeTest.syncs), 0);
    await uploads.upload(id); assert.equal(await page.evaluate(() => (window as any).resumeTest.uploads), 1, '已保存附件不重复上传');
    await reset(); failSaveCheck = true;
    await assert.rejects(uploads.upload(id, 'original_A_123'), ResumeUploadUncertainError);
    assert.ok(attempt); assert.equal(recorded, null);
    const count = await page.evaluate(() => (window as any).resumeTest.uploads);
    failSaveCheck = false;
    const recovered = await uploads.upload(id);
    assert.equal(recovered.name, '优化后的中文简历.pdf'); assert.equal(attempt, null);
    assert.equal(await page.evaluate(() => (window as any).resumeTest.uploads), count, '保存结果不明时核对已有附件，不再次提交');
    await reset(); await page.evaluate(() => { (window as any).resumeTest.failUpload = true; });
    await assert.rejects(uploads.upload(id, 'original_A_123'), /已恢复旧附件/);
    assert.ok((await readResumeAttachments(page as unknown as CdpPage)).attachments.some(item => item.name === '原版中文.pdf'));
    console.log('PASS | 原生附件列表/容量、只替换所选项、备份、文件选择与确定添加、成功核对、重复及不明结果不重投、失败恢复、关闭同步提示');
  } finally {
    browserService.withResumeEditor = originals.editor; resumePdfService.result = originals.result; resumePdfService.pdfPath = originals.pdfPath;
    resumePdfService.recordBossUpload = originals.record; resumePdfService.uploadAttempt = originals.attempt; resumePdfService.recordUploadAttempt = originals.recordAttempt;
    global.fetch = originals.fetch; await browser.close();
    if (path.dirname(folder) === path.join(root, 'data') && path.basename(folder).startsWith('resume-upload-test-')) await fs.promises.rm(folder, { recursive: true, force: true });
    const backup = path.join(root, 'data/resume-backups', id);
    if (/^[a-f0-9]{32}$/.test(id) && path.dirname(backup) === path.join(root, 'data/resume-backups')) await fs.promises.rm(backup, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
