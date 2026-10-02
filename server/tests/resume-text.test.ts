import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeResumeText, extractPdfText, orderedPdfText } from '../src/services/resume-text.js';

function sampleChinesePdf(): Buffer {
  // Synthetic GBK CID font without ToUnicode: extraction requires the bundled Chinese CMaps.
  const stream = 'BT /F1 12 Tf 40 760 Td <bdccd3fdbeadc0fa> Tj 0 -24 Td <d7cab8f1d6a4cae9> Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /GBK-EUC-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /DW 1000 /FontDescriptor 8 0 R >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream',
    '<< /CodexDocTag (CODEX-SYNTHETIC-CMAP-READ-TEST) >>',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [-250 -250 1200 1000] /Ascent 880 /Descent -120 /CapHeight 700 /ItalicAngle 0 /StemV 80 >>',
  ];
  let body = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

async function main() {
  const run = (str: string, x: number, y: number, width = str.length * 12) => ({ str, width, height: 12, transform: [12, 0, 0, 12, x, y] });
  const text = orderedPdfText([run('历', 76, 700), run('计算机科学与技术', 160, 675), run('教育经', 40, 700.2), run('本科', 40, 675)]);
  assert.equal(text, '教育经历\n本科  计算机科学与技术', '中文标题应按同一基线拼合，日期/专业等列保留间隔');
  assert.equal(decodeResumeText(Buffer.from('中文简历\r\n本科', 'utf8')), '中文简历\n本科');
  assert.equal(decodeResumeText(Buffer.from([0xff, 0xfe, 0x2c, 0x67, 0xd1, 0x79])), '本科');
  assert.equal(decodeResumeText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), '中文');
  const chinese = await extractPdfText(sampleChinesePdf());
  assert.match(chinese, /教育经历/); assert.match(chinese, /资格证书/);
  if (process.argv[2]) {
    const actual = await extractPdfText(fs.readFileSync(process.argv[2]));
    for (const label of ['工作经历', '教育经历', '资格证书', '计算机科学与技术', '具体实现']) assert.ok(actual.includes(label), label);
    assert.doesNotMatch(actual, /\uFFFD|[\uE000-\uF8FF]/);
  }
  console.log('PASS | 中文 CMap、文字排序、中文文本编码和保留 PDF 的实际读取');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
