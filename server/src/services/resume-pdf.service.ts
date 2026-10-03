import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { TailoredResumeResult, ResumePdfArtifact, ResumeSource, ResumePdfChange } from '../types.js';
import { extractPdfText } from './resume-text.js';

const root = path.resolve(__dirname, '../../..');
export const resumesDir = path.join(root, 'data', 'resumes');
const exportsDir = path.join(root, 'data', 'resume-exports');
const sourceManifest = path.join(resumesDir, 'current.json');

export interface PdfRegion { id: string; page: number; text: string; editable: boolean; maxChars: number; }
export interface PdfLayout { sha256: string; pageCount: number; pages: Array<{ width: number; height: number; rotation: number }>; regions: PdfRegion[]; }
export interface PdfEdit { id: string; text: string; }

function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120).trim() || '简历';
}
export class ResumePdfService {
  private python?: { command: string; prefix: string[] };
  private readonly sourceDir: string;
  private readonly outputDir: string;
  private readonly manifest: string;
  constructor(options: { resumesDir?: string; exportsDir?: string } = {}) {
    this.sourceDir = options.resumesDir || resumesDir;
    this.outputDir = options.exportsDir || exportsDir;
    this.manifest = options.resumesDir ? path.join(this.sourceDir, 'current.json') : sourceManifest;
  }
  public sourcePath(id: string): string {
    if (!/^resume_[0-9a-f-]+\.(pdf|docx|txt|md)$/.test(id)) throw new Error('简历文件标识无效，请重新上传原文件');
    const file = path.join(this.sourceDir, id);
    if (!fs.existsSync(file)) throw new Error('原简历文件不存在，请重新上传');
    return file;
  }
  public async saveSource(file: string, fileName: string, text: string): Promise<ResumeSource> {
    const id = path.basename(file); this.sourcePath(id);
    const source: ResumeSource = { id, fileName: safeFileName(fileName), format: path.extname(file).slice(1), text,
      updatedAt: new Date().toISOString() };
    await fs.promises.mkdir(this.sourceDir, { recursive: true });
    await fs.promises.writeFile(this.manifest + '.tmp', JSON.stringify(source), 'utf8');
    await fs.promises.rename(this.manifest + '.tmp', this.manifest);
    return source;
  }
  public async current(extract: (file: string) => Promise<string>): Promise<ResumeSource | null> {
    if (fs.existsSync(this.manifest)) {
      try {
        const source = JSON.parse(await fs.promises.readFile(this.manifest, 'utf8')) as ResumeSource;
        this.sourcePath(source.id); return source;
      } catch { /* Recover from a deleted prior source using the original upload files below. */ }
    }
    const files = (await fs.promises.readdir(this.sourceDir).catch(() => []))
      .filter(name => /^resume_[0-9a-f-]+\.(pdf|docx|txt|md)$/.test(name));
    const latest = files.map(name => ({ name, time: fs.statSync(path.join(this.sourceDir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)[0];
    if (!latest) return null;
    const file = this.sourcePath(latest.name);
    return this.saveSource(file, '已上传简历' + path.extname(file), await extract(file));
  }
  private command(command: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: root, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '', done = false;
      const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(out); };
      const timer = setTimeout(() => { child.kill(); finish(new Error('PDF 处理超时，请检查原文件后重试')); }, timeoutMs);
      child.stdout.on('data', part => { out += part.toString('utf8'); if (out.length > 8_000_000) { child.kill(); finish(new Error('PDF 内容过多，请使用简历正文文件')); } });
      child.stderr.on('data', part => { err = (err + part.toString('utf8')).slice(-12000); });
      child.once('error', () => finish(new Error('无法启动 PDF 处理组件')));
      child.once('close', code => {
        if (code === 0) return finish();
        let message = err.trim();
        try { message = JSON.parse(message.split('\n').at(-1)!).error || message; } catch {}
        finish(new Error(message || 'PDF 处理失败'));
      });
    });
  }
  private async runtime(): Promise<{ command: string; prefix: string[] }> {
    if (this.python) return this.python;
    const candidates = [
      ...(process.env.BOSS_PDF_PYTHON ? [{ command: process.env.BOSS_PDF_PYTHON, prefix: [] }] : []),
      { command: 'python', prefix: [] }, { command: 'py', prefix: ['-3'] }, { command: 'python3', prefix: [] },
    ];
    for (const candidate of candidates) {
      try {
        const probe = await this.command(candidate.command, [...candidate.prefix, '-X', 'utf8', '-c',
          `import sys;sys.path.insert(0,${JSON.stringify(path.join(root, 'vendor', 'pdf-runtime'))});import pymupdf;print(pymupdf.VersionBind)`], 10000);
        if (/\d+\.\d+/.test(probe)) { this.python = candidate; return candidate; }
      } catch {}
    }
    throw new Error('PDF 组件尚未就绪，请运行 npm run setup:pdf 安装后重试');
  }
  private async run(args: string[]): Promise<any> {
    const runtime = await this.runtime();
    const result = await this.command(runtime.command, [...runtime.prefix, '-X', 'utf8', path.join(root, 'server', 'resources', 'resume-pdf.py'), ...args], 60000);
    // Some PDF engines print non-fatal font diagnostics before the structured result.
    try { return JSON.parse(result.trim().split(/\r?\n/).at(-1)!); } catch { throw new Error('PDF 组件返回异常，请重试'); }
  }
  public async inspect(sourceId: string): Promise<PdfLayout> {
    const source = this.sourcePath(sourceId);
    if (path.extname(source) !== '.pdf') throw new Error('保留原排版需要 PDF 原文件，请上传原始 PDF 简历');
    return this.run(['inspect', '--input', source]);
  }
  public async export(sourceId: string, targetRole: string, layout: PdfLayout, edits: PdfEdit[], result: TailoredResumeResult): Promise<ResumePdfArtifact> {
    const fresh = await this.inspect(sourceId);
    if (fresh.sha256 !== layout.sha256) throw new Error('原简历已变更，请重新优化');
    const id = randomUUID().replace(/-/g, '');
    const dir = path.join(this.outputDir, id);
    await fs.promises.mkdir(dir, { recursive: true });
    try {
      const editPath = path.join(dir, 'edits.json');
      await fs.promises.writeFile(editPath, JSON.stringify(edits), 'utf8');
      const output = await this.run(['edit', '--input', this.sourcePath(sourceId), '--edits', editPath, '--output', path.join(dir, 'resume.pdf')]);
      const text = await extractPdfText(await fs.promises.readFile(path.join(dir, 'resume.pdf')));
      const source = await this.current(async () => '');
      const fileName = safeFileName(path.basename(source?.id === sourceId ? source.fileName : '简历', '.pdf') + '_' + targetRole + '_优化') + '.pdf';
      const artifact: ResumePdfArtifact = { id, sourceId, targetRole, fileName, pageCount: output.pageCount,
        changes: output.changes as ResumePdfChange[], text, createdAt: new Date().toISOString(),
        downloadUrl: '/api/resume/pdf/' + id, previewUrls: Array.from({ length: output.pageCount }, (_, index) => `/api/resume/pdf/${id}/pages/${index + 1}`) };
      const final = { ...result, rewrittenResumeMarkdown: text, pdf: artifact };
      await fs.promises.writeFile(path.join(dir, 'result.json'), JSON.stringify(final), 'utf8');
      await fs.promises.writeFile(path.join(this.outputDir, 'latest.json') + '.tmp', JSON.stringify({ id }), 'utf8');
      await fs.promises.rename(path.join(this.outputDir, 'latest.json') + '.tmp', path.join(this.outputDir, 'latest.json'));
      return artifact;
    } catch (error) {
      // Only delete the newly generated, validated UUID directory; the uploaded source is never modified.
      if (path.dirname(dir) === this.outputDir && /^[a-f0-9]{32}$/.test(path.basename(dir))) await fs.promises.rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  public async result(id: string): Promise<TailoredResumeResult> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('优化简历标识无效');
    try { return JSON.parse(await fs.promises.readFile(path.join(this.outputDir, id, 'result.json'), 'utf8')); }
    catch { throw new Error('优化 PDF 不存在，请重新生成'); }
  }
  public async latest(): Promise<TailoredResumeResult | null> {
    try { return await this.result(JSON.parse(await fs.promises.readFile(path.join(this.outputDir, 'latest.json'), 'utf8')).id); }
    catch { return null; }
  }
  public async pdfPath(id: string): Promise<string> { await this.result(id); return path.join(this.outputDir, id, 'resume.pdf'); }
  public async pagePath(id: string, page: number): Promise<string> {
    const result = await this.result(id);
    if (!Number.isInteger(page) || page < 1 || page > (result.pdf?.pageCount || 0)) throw new Error('简历页码无效');
    return path.join(this.outputDir, id, `page-${page}.png`);
  }
  public async recordBossUpload(id: string, uploaded: { name: string; id: string }): Promise<void> {
    const result = await this.result(id);
    if (!result.pdf) throw new Error('简历没有 PDF 输出');
    result.pdf.bossUpload = { attachmentId: uploaded.id, fileName: uploaded.name, uploadedAt: new Date().toISOString() };
    await fs.promises.writeFile(path.join(this.outputDir, id, 'result.json'), JSON.stringify(result), 'utf8');
  }
  public async uploadAttempt(id: string): Promise<{ beforeIds: string[]; fileName: string } | null> {
    await this.result(id);
    const file = path.join(this.outputDir, id, 'boss-upload-attempt.json');
    try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('附件保存记录无法读取，请先核对 BOSS 附件列表'); }
  }
  public async recordUploadAttempt(id: string, attempt: { beforeIds: string[]; fileName: string } | null): Promise<void> {
    await this.result(id);
    const file = path.join(this.outputDir, id, 'boss-upload-attempt.json');
    if (attempt) await fs.promises.writeFile(file, JSON.stringify(attempt), 'utf8');
    else await fs.promises.rm(file, { force: true });
  }
}
export const resumePdfService = new ResumePdfService();
