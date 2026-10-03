import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ResumeService } from '../src/services/resume.service.js';
import { ResumePdfService, resumePdfService, type PdfLayout } from '../src/services/resume-pdf.service.js';
import { llmService } from '../src/services/llm.service.js';

async function main() {
  const root = path.resolve(process.cwd(), '..');
  const folder = await fs.promises.mkdtemp(path.join(root, 'data/resume-service-test-'));
  const cacheDir = path.join(root, 'data/resume-model-cache');
  const cachesBefore = new Set(await fs.promises.readdir(cacheDir).catch(() => []));
  const service = new ResumePdfService({ resumesDir: folder, exportsDir: path.join(folder, 'exports') });
  const sourceId = 'resume_' + randomUUID() + '.pdf'; const file = path.join(folder, sourceId);
  await fs.promises.writeFile(file, '%PDF-fixture');
  const originalInspect = resumePdfService.inspect, originalExport = resumePdfService.export, originalChat = llmService.chatJson;
  try {
    await service.saveSource(file, '中文原简历.pdf', '本机正文');
    assert.equal((await service.current(async () => ''))?.fileName, '中文原简历.pdf');
    assert.throws(() => service.sourcePath('../private.pdf'), /无效/);
    assert.equal(await service.latest(), null);
    const nonce = randomUUID().replace(/-/g, '');
    const text = '•负责测试公司有限公司的频道内容发布，每日筛选15条素材，并完成标题优化与评论区互动。';
    const layout: PdfLayout = { sha256: nonce, pageCount: 1, pages: [{ width: 420, height: 560, rotation: 0 }], regions: [
      { id: 'p1-name', page: 1, text: '测试姓名', editable: false, maxChars: 4 },
      { id: 'p1-contact', page: 1, text: '13800000000 contact@example.test', editable: false, maxChars: 31 },
      { id: 'p1-school', page: 1, text: '示例大学', editable: false, maxChars: 4 },
      { id: 'p1-company', page: 1, text: '测试公司有限公司', editable: false, maxChars: 8 },
      { id: 'p1-body', page: 1, text, editable: true, maxChars: text.length },
    ] };
    let requests = 0, exports = 0;
    resumePdfService.inspect = async () => layout;
    llmService.chatJson = async (messages: any) => {
      requests++;
      const prompt = messages.map((m: any) => m.content).join('\n');
      for (const privateValue of ['测试姓名', '13800000000', 'contact@example.test', '示例大学', '测试公司有限公司']) {
        assert.equal(prompt.includes(privateValue), false, '模型只能收到脱敏正文');
      }
      assert.match(prompt, /〔资料A〕/); assert.match(prompt, /15条素材/);
      return { edits: [{ id: 'p1-body', text: '•负责〔资料A〕的频道内容发布，每日筛选15条素材，优化标题并完成评论区互动。' }],
        topHighlights: ['频道内容发布'], defaultGreetingPitch: '您好，我有内容发布经验。' } as any;
    };
    resumePdfService.export = async (_id, _role, _layout, edits) => {
      exports++; assert.match(edits[0].text, /测试公司有限公司/); assert.equal(edits[0].text.includes('〔资料'), false);
      if (exports === 1) throw new Error('本机排版暂时失败');
      return { id: 'a'.repeat(32), sourceId, targetRole: '内容运营', fileName: '测试优化.pdf', pageCount: 1,
        changes: [], text: edits[0].text, createdAt: new Date().toISOString(), downloadUrl: '', previewUrls: [] };
    };
    const resumes = new ResumeService();
    await assert.rejects(resumes.rewriteForTargetRole(sourceId, '内容运营'), /本机排版暂时失败/);
    const result = await resumes.rewriteForTargetRole(sourceId, '内容运营');
    assert.equal(requests, 1, 'PDF 排版失败后重试复用 AI 结果，不再次请求');
    assert.equal(exports, 2); assert.match(result.rewrittenResumeMarkdown, /15条素材/);
    assert.equal(result.pdf?.pageCount, 1);
    console.log('PASS | 中文源文件恢复、路径校验、仅脱敏正文送模型、占位符还原、本机失败后复用结果、输出取真实 PDF 正文');
  } finally {
    resumePdfService.inspect = originalInspect; resumePdfService.export = originalExport; llmService.chatJson = originalChat;
    for (const name of await fs.promises.readdir(cacheDir).catch(() => [])) {
      if (!cachesBefore.has(name) && /^[a-f0-9]{64}\.json$/.test(name)) await fs.promises.rm(path.join(cacheDir, name));
    }
    if (path.dirname(folder) === path.join(root, 'data') && path.basename(folder).startsWith('resume-service-test-')) {
      await fs.promises.rm(folder, { recursive: true, force: true });
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
