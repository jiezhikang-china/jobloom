import path from 'node:path';

export interface PdfTextRun { str: string; transform: number[]; width: number; height: number; }

export function normalizeResumeText(text: string): string {
  return text.normalize('NFKC').replace(/\u0000|[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** PDF drawing order is not reading order. Reassemble runs by their baseline and left edge. */
export function orderedPdfText(items: PdfTextRun[]): string {
  const runs = items.filter((item) => item.str && item.transform?.length >= 6)
    .map((item) => ({ ...item, x: item.transform[4], y: item.transform[5],
      size: Math.max(1, item.height || Math.hypot(item.transform[2], item.transform[3])) }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<{ y: number; size: number; runs: typeof runs }> = [];
  for (const run of runs) {
    const line = lines.at(-1);
    if (line && Math.abs(line.y - run.y) <= Math.min(line.size, run.size) * 0.3) { line.runs.push(run); line.size = Math.max(line.size, run.size); }
    else lines.push({ y: run.y, size: run.size, runs: [run] });
  }
  return lines.map((line) => {
    line.runs.sort((a, b) => a.x - b.x);
    let text = ''; let right = 0;
    for (const run of line.runs) {
      const gap = run.x - right;
      if (text && !/\s$/.test(text) && !/^\s/.test(run.str) && gap > line.size * 0.22) text += gap > line.size * 2 ? '  ' : ' ';
      text += run.str; right = Math.max(right, run.x + run.width);
    }
    return text;
  }).join('\n');
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  // Dynamic import preserves PDF.js's ESM build when this server is compiled as CommonJS.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const packageRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const task = getDocument({ data: new Uint8Array(buffer),
    cMapUrl: path.join(packageRoot, 'cmaps').replace(/\\/g, '/') + '/', cMapPacked: true,
    standardFontDataUrl: path.join(packageRoot, 'standard_fonts').replace(/\\/g, '/') + '/',
    useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
  try {
    const pdf = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      pages.push(orderedPdfText(content.items.filter((item): item is PdfTextRun & { dir: string; fontName: string; hasEOL: boolean } => 'str' in item)));
      page.cleanup();
    }
    const text = normalizeResumeText(pages.join('\n\n'));
    if (!text) throw new Error('PDF 是扫描件或图片，未读取到文字。请上传带文字层的 PDF、Word 或文本简历。');
    if (/\uFFFD|[\uE000-\uF8FF]/.test(text)) throw new Error('PDF 字体缺少有效的文字映射，无法完整读取。请从原文件重新导出 PDF 或上传 Word。');
    return text;
  } finally { await task.destroy(); }
}

export function decodeResumeText(buffer: Buffer): string {
  let text: string;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(buffer);
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(buffer);
  else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { text = new TextDecoder('gb18030', { fatal: true }).decode(buffer); }
  }
  return normalizeResumeText(text);
}
