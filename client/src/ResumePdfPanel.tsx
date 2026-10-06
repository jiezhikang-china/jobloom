import { useState } from 'react';
import { Download, Upload, RefreshCw, FileText } from 'lucide-react';
import type { TailoredResumeResult, BossResumeAttachment } from './types.js';

export default function ResumePdfPanel({ result, disabled, disabledReason, onUpdate, onUse }: {
  result: TailoredResumeResult; disabled?: boolean; disabledReason?: string; onUpdate: (next: TailoredResumeResult) => void; onUse: () => void;
}) {
  const pdf = result.pdf;
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [attachments, setAttachments] = useState<BossResumeAttachment[]>([]);
  const [replaceId, setReplaceId] = useState('');
  const [showChoices, setShowChoices] = useState(false);
  if (!pdf) return <p role="status">此结果还没有 PDF，请重新优化原 PDF 简历。</p>;
  const busy = uploading || disabled;
  const upload = async (replace?: string) => {
    if (busy) return;
    setUploading(true); setError(''); setMessage('正在打开 BOSS 简历页并上传 PDF…');
    try {
      const response = await fetch('/api/resume/boss/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifactId: pdf.id, ...(replace ? { replaceId: replace } : {}) }) });
      const data = await response.json();
      if (!data.success || !response.ok) {
        if (data.code === 'ATTACHMENTS_FULL') {
          setAttachments(data.data.attachments); setShowChoices(true); setMessage('');
        }
        throw new Error(data.message || '上传失败，请重试');
      }
      onUpdate({ ...result, pdf: { ...pdf, bossUpload: { attachmentId: data.data.id, fileName: data.data.name, uploadedAt: new Date().toISOString() } } });
      setMessage('已上传到 BOSS 附件简历：' + data.data.name); setShowChoices(false);
    } catch (cause) { setMessage(''); setError((cause as Error).message); }
    finally { setUploading(false); }
  };
  const refresh = async () => {
    if (busy) return;
    setUploading(true); setError('');
    try {
      const response = await fetch('/api/resume/boss/attachments'); const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || '无法读取附件列表');
      setAttachments(data.data.attachments); setReplaceId(''); setShowChoices(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setUploading(false); }
  };
  return <section className="resume-pdf-panel" aria-label="优化 PDF 简历">
    <div className="resume-pdf-header"><div><h3><FileText size={18} /> 优化后的 PDF 简历</h3>
      <p>{pdf.fileName} · {pdf.pageCount} 页 · 润色 {pdf.changes.length} 段</p>
      <p>保留原 PDF 的页面、照片和排版；下方预览就是将上传的文件。</p></div>
      <div className="resume-pdf-actions"><a className="resume-download" href={pdf.downloadUrl} download={pdf.fileName}><Download size={16} /> 下载 PDF</a>
        <button type="button" disabled={busy} onClick={() => void upload()}><Upload size={16} /> {uploading ? '正在处理…' : pdf.bossUpload ? '核对 BOSS 上传状态' : '上传到 BOSS'}</button>
      </div>
    </div>
    {disabled && <p role="status">{disabledReason || '结束当前投递任务后，可以上传优化稿。'}</p>}
    {pdf.bossUpload && <p className="resume-upload-success" role="status">已保存到 BOSS：{pdf.bossUpload.fileName}</p>}
    {message && <p role="status" className="resume-upload-success">{message}</p>}
    {error && <p role="alert" className="work-review-error">{error}</p>}
    {showChoices && <div className="resume-replace-choice"><label>替换哪一份 BOSS 附件？
      <select aria-label="要替换的 BOSS 附件" disabled={busy} value={replaceId} onChange={event => setReplaceId(event.target.value)}>
        <option value="">请选择一份现有附件</option>{attachments.map(item => <option key={item.id} value={item.id} disabled={!item.canReplace}>{item.name} · {item.description}</option>)}
      </select></label>
      <p>替换前会把所选旧附件备份到本机。上传失败时尝试恢复旧附件。</p>
      <div className="resume-pdf-actions"><button type="button" disabled={busy || !replaceId} onClick={() => void upload(replaceId)}>替换并上传优化 PDF</button>
        <button type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} /> 刷新附件</button>
        <button type="button" disabled={busy} onClick={() => { setShowChoices(false); setError(''); }}>取消</button></div>
    </div>}
    <div className="resume-pdf-pages">{pdf.previewUrls.map((url, index) => <figure key={url}>
      <img src={url} alt={`优化 PDF 第 ${index + 1} 页`} loading="lazy" /><figcaption>第 {index + 1} / {pdf.pageCount} 页</figcaption>
    </figure>)}</div>
    <details className="resume-pdf-changes"><summary>查看润色前后（{pdf.changes.length} 段）</summary>{pdf.changes.map(change => <div key={change.id}>
      <p>原文：{change.before}</p><p>优化：{change.after}</p></div>)}</details>
    <details className="resume-pdf-changes"><summary>查看 PDF 提取文字</summary><pre>{pdf.text}</pre></details>
    <div className="resume-pdf-actions resume-use"><button type="button" disabled={busy} onClick={onUse}>使用此简历匹配岗位</button></div>
  </section>;
}
