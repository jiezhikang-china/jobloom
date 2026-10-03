import fs from 'node:fs';
import path from 'node:path';
import type { BossResumeAttachment } from '../types.js';
import { browserService } from './browser.service.js';
import type { CdpPage } from './cdp.page.js';
import { resumePdfService } from './resume-pdf.service.js';
import { clickBossAction, runBossAction } from './boss-action-scheduler.js';

const backupRoot = path.resolve(__dirname, '../../../data/resume-backups');
export class ResumeCapacityError extends Error {
  constructor(public attachments: BossResumeAttachment[], public capacity: number) {
    super(`BOSS 附件简历已满（${attachments.length}/${capacity}），请选择要替换的一份附件`);
  }
}
export class ResumeUploadUncertainError extends Error {}
export async function readResumeAttachments(page: CdpPage): Promise<{ attachments: BossResumeAttachment[]; capacity: number }> {
  return page.evaluate(() => {
    const scope = document.querySelector('.resume-attachment');
    if (!scope) throw new Error('没有找到 BOSS 附件管理');
    const attachments = [...scope.querySelectorAll('.annex-item')].flatMap(row => {
      const name = row.querySelector('.annex-content .basis a[title]')?.getAttribute('title')?.trim();
      const href = row.querySelector<HTMLAnchorElement>('a[href*="download4geek"]')?.href;
      const id = href && new URL(href).searchParams.get('resumeId');
      if (!name || !id) return [];
      return [{ id, name, description: row.querySelector('.desc')?.textContent?.trim() || '', canReplace: Boolean(row.querySelector('.annex-operate-delete')) }];
    });
    const quota = scope.querySelector('.resume-type-title')?.textContent?.match(/文件\s*[（(]\s*(\d+)\s*\/\s*(\d+)\s*[）)]/);
    if (!quota || Number(quota[1]) !== attachments.length) throw new Error('BOSS 附件列表尚未加载完整，请稍后重试');
    return { attachments, capacity: Number(quota[2]) };
  });
}
export class ResumeBossUploadService {
  private busy = false;
  public isBusy(): boolean { return this.busy; }
  private async ready(page: CdpPage): Promise<void> {
    await page.waitForFunction(() => {
      if (/请完成安全验证|请进行安全验证/.test(document.body?.innerText || '') || location.pathname.startsWith('/web/user/')) return true;
      const container = document.querySelector('.sider-resume') as any;
      return Array.isArray(container?.__vue__?.resumeInfo?.attachmentList)
        && Boolean(document.querySelector('.resume-attachment .resume-type-title'));
    }, undefined, { timeout: 30000 });
    const issue = await page.evaluate(() => location.pathname.startsWith('/web/user/') ? 'BOSS 登录已失效，请在浏览器重新登录'
      : /请完成安全验证|请进行安全验证/.test(document.body?.innerText || '') ? 'BOSS 需要完成安全验证后再上传' : '');
    if (issue) throw new Error(issue);
    await readResumeAttachments(page);
  }
  public async list(): Promise<{ attachments: BossResumeAttachment[]; capacity: number }> {
    if (this.busy) throw new Error('简历正在上传，请等待完成');
    return browserService.withResumeEditor(async page => { await this.ready(page); return readResumeAttachments(page); });
  }
  private row(page: CdpPage, id: string) {
    if (!/^[a-zA-Z0-9_-]{8,180}$/.test(id)) throw new Error('BOSS 附件标识无效');
    return page.locator('.resume-attachment .annex-item').filter({ has: page.locator(`a[href*="resumeId=${id}"]`) }).first();
  }
  private async backup(page: CdpPage, attachment: BossResumeAttachment, artifactId: string): Promise<string> {
    const href = await this.row(page, attachment.id).locator('a[href*="download4geek"]').evaluate(el => (el as HTMLAnchorElement).href);
    const url = new URL(href);
    if (url.hostname !== 'docdownload.zhipin.com' || url.protocol !== 'https:'
      || url.pathname !== '/wflow/zpgeek/download/download4geek' || url.searchParams.get('resumeId') !== attachment.id) throw new Error('原附件备份链接不正确');
    const cookies = await page.cookiesFor(href);
    const response = await runBossAction(page, 'navigation', () => fetch(href, { redirect: 'error',
      headers: { Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
        Referer: 'https://www.zhipin.com/web/geek/resume/', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60000) }));
    if (!response.ok || /json|html/.test(response.headers.get('content-type') || '')) throw new Error('未能备份旧附件，已保留原文件；请稍后重试');
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > 20 * 1024 * 1024 || /^(?:\s*<|\s*\{)/.test(data.subarray(0, 16).toString())) throw new Error('旧附件备份无效，已保留原文件');
    const folder = path.join(backupRoot, artifactId);
    await fs.promises.mkdir(folder, { recursive: true });
    const file = path.join(folder, attachment.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150));
    await fs.promises.writeFile(file, data);
    await fs.promises.writeFile(path.join(folder, 'attachment.json'), JSON.stringify(attachment), 'utf8');
    return file;
  }
  private async remove(page: CdpPage, attachment: BossResumeAttachment): Promise<void> {
    const fresh = (await readResumeAttachments(page)).attachments.find(item => item.id === attachment.id);
    if (!fresh || fresh.name !== attachment.name || !fresh.canReplace) throw new Error('待替换附件已经变化，请重新选择');
    const row = this.row(page, attachment.id);
    await row.locator('.annex-item-operate').hover();
    await row.locator('.annex-operate-delete').click();
    const dialog = page.locator('.resume-delete').filter({ visible: true }).first();
    await dialog.waitFor({ timeout: 5000 });
    const text = await dialog.evaluate(el => (el as HTMLElement).innerText);
    if (!/删除该附件简历/.test(text)) throw new Error('BOSS 删除确认内容不一致，已停止替换');
    await clickBossAction(dialog.locator('.btn-sure'), 'submit', async () => {
      const current = (await readResumeAttachments(page)).attachments.find(item => item.id === attachment.id);
      if (!current || current.name !== attachment.name) throw new Error('待替换附件已经变化，未确认删除');
    });
    await page.waitForFunction(id => ![...document.querySelectorAll('.resume-attachment a[href*="download4geek"]')]
      .some(el => new URL((el as HTMLAnchorElement).href).searchParams.get('resumeId') === id), attachment.id, { timeout: 15000 });
  }
  public async uploadFile(page: CdpPage, file: string, expectedName: string,
    onSaving?: (beforeIds: string[]) => Promise<void>): Promise<BossResumeAttachment> {
    const before = (await readResumeAttachments(page)).attachments;
    const menu = page.locator('.resume-attachment .sider-title-operate').first();
    await menu.hover();
    await menu.locator('.operate-list-item:has-text("上传简历")').click();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>('.upload-resume-dialog input[type="file"][accept*="application/pdf"]')]
      .some(el => Boolean(el.getClientRects().length)), undefined, { timeout: 10000 });
    const marker = await page.evaluate(() => {
      const input = [...document.querySelectorAll<HTMLInputElement>('.upload-resume-dialog input[type="file"][accept*="application/pdf"]')]
        .find(el => Boolean(el.getClientRects().length));
      if (!input) throw new Error('没有找到可用的 PDF 附件上传控件');
      input.setAttribute('data-agent-resume-file', 'selected');
      return 'input[data-agent-resume-file="selected"]';
    });
    await page.fileInput(marker, [file]);
    await page.waitForFunction(() => {
      const dialog = [...document.querySelectorAll('.upload-resume-dialog')].find(el => el.getClientRects().length);
      return dialog?.querySelector('[ka="user_resume_add_sure"]') || /上传失败|重新选择.*失败/.test((dialog as HTMLElement)?.innerText || '');
    }, undefined, { timeout: 130000 });
    const dialog = page.locator('.upload-resume-dialog').filter({ visible: true }).first();
    const body = await dialog.evaluate(el => (el as HTMLElement).innerText);
    if (/上传失败/.test(body) || !body.includes(expectedName)) throw new Error('BOSS 未成功接收指定 PDF 附件，请重试上传');
    try {
      await clickBossAction(dialog.locator('[ka="user_resume_add_sure"]'), 'submit', async () => { await onSaving?.(before.map(item => item.id)); });
      await page.waitForFunction(({ beforeIds, name }) => [...document.querySelectorAll('.resume-attachment .annex-item')].some(row => {
      const link = row.querySelector<HTMLAnchorElement>('a[href*="download4geek"]');
      const id = link && new URL(link.href).searchParams.get('resumeId');
      return id && !beforeIds.includes(id) && row.querySelector('.basis a[title]')?.getAttribute('title') === name;
      }), { beforeIds: before.map(item => item.id), name: expectedName }, { timeout: 45000 });
    } catch {
      throw new ResumeUploadUncertainError('已确认添加附件，但 BOSS 保存结果尚未核对；请查看附件列表，暂不重复上传或恢复旧附件');
    }
    const saved = (await readResumeAttachments(page)).attachments.find(item => item.name === expectedName && !before.some(old => old.id === item.id));
    if (!saved) throw new Error('BOSS 附件列表未确认保存成功');
    // Native upload can suggest syncing the new file to prior contacts or updating the online resume.
    // Close those optional dialogs; uploading an attachment does not authorize sending recruiter messages.
    for (const selector of ['.siderResume-dialog', '.upload-resume-dialog']) {
      const extra = page.locator(selector).filter({ visible: true }).first();
      if (await extra.isVisible()) await extra.locator('[ka="dialog_close"]').click().catch(() => {});
    }
    return saved;
  }
  public async upload(artifactId: string, replaceId?: string): Promise<BossResumeAttachment> {
    if (this.busy) throw new Error('简历正在上传，请等待完成');
    this.busy = true;
    try {
      const result = await resumePdfService.result(artifactId);
      if (!result.pdf) throw new Error('请先生成优化 PDF');
      const original = await resumePdfService.pdfPath(artifactId);
      const bytes = await fs.promises.readFile(original);
      if (bytes.subarray(0, 5).toString() !== '%PDF-' || bytes.length > 20 * 1024 * 1024) throw new Error('优化 PDF 格式无效或超过 BOSS 的 20MB 限制');
      const named = path.join(path.dirname(original), result.pdf.fileName);
      await fs.promises.copyFile(original, named);
      return await browserService.withResumeEditor(async page => {
        await this.ready(page);
        const { attachments, capacity } = await readResumeAttachments(page);
        const already = attachments.find(item => item.id === result.pdf!.bossUpload?.attachmentId && item.name === result.pdf!.fileName);
        if (already) return already;
        const attempt = await resumePdfService.uploadAttempt(artifactId);
        if (attempt) {
          const recovered = attachments.find(item => !attempt.beforeIds.includes(item.id) && item.name === attempt.fileName);
          if (!recovered) throw new ResumeUploadUncertainError('上次添加附件的结果仍未确认，请查看 BOSS 附件列表后再核对，暂不重复提交');
          await resumePdfService.recordBossUpload(artifactId, recovered);
          await resumePdfService.recordUploadAttempt(artifactId, null);
          return recovered;
        }
        if (!replaceId && attachments.length >= capacity) throw new ResumeCapacityError(attachments, capacity);
        const replacement = replaceId ? attachments.find(item => item.id === replaceId) : undefined;
        if (replaceId && !replacement) throw new Error('要替换的附件不存在，请刷新列表后重新选择');
        let backup: string | undefined;
        if (replacement) {
          if (!replacement.canReplace) throw new Error('BOSS 不允许替换选中的附件');
          backup = await this.backup(page, replacement, artifactId);
          await this.remove(page, replacement);
        }
        try {
          const uploaded = await this.uploadFile(page, named, result.pdf!.fileName, async beforeIds => {
            await resumePdfService.recordUploadAttempt(artifactId, { beforeIds, fileName: result.pdf!.fileName });
          });
          await resumePdfService.recordBossUpload(artifactId, uploaded);
          await resumePdfService.recordUploadAttempt(artifactId, null);
          return uploaded;
        } catch (error) {
          // If upload failed after removing the selected file, restore that exact backed-up attachment.
          const current = await readResumeAttachments(page).catch(() => null);
          if (!(error instanceof ResumeUploadUncertainError) && current && backup && replacement && current.attachments.length < capacity
            && !current.attachments.some(item => item.name === result.pdf!.fileName)) {
            try {
              const visible = page.locator('.upload-resume-dialog').filter({ visible: true }).first();
              if (await visible.isVisible()) await visible.locator('[ka="dialog_close"]').click();
              await this.uploadFile(page, backup, replacement.name);
              throw new Error((error as Error).message + '；已恢复旧附件，可以重试');
            } catch (restoreError) {
              if ((restoreError as Error).message.includes('已恢复旧附件')) throw restoreError;
              throw new Error((error as Error).message + '；旧附件已备份在本机，BOSS 暂未恢复，请检查附件管理后重试');
            }
          }
          throw error;
        }
      });
    } finally { this.busy = false; }
  }
}
export const resumeBossUploadService = new ResumeBossUploadService();
