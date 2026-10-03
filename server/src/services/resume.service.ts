import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import { extractPdfText, decodeResumeText, normalizeResumeText } from './resume-text.js';
import { llmService, ChatMessage } from './llm.service.js';
import { bossCatalogService, positionSelections } from './boss.catalog.service.js';
import { ResumeAnalysisResult, TailoredResumeResult } from '../types.js';
import { resumePdfService, type PdfEdit } from './resume-pdf.service.js';
import { configManager } from '../config/config.manager.js';

const MAX_RESUME_CHARS = 20000;
type PdfModelResult = { edits: PdfEdit[]; topHighlights: string[]; defaultGreetingPitch: string };
const pdfModelRequests = new Map<string, Promise<PdfModelResult>>();

async function cachedPdfModelResult(messages: ChatMessage[], sourceHash: string): Promise<PdfModelResult> {
  const llm = configManager.getConfig().llm;
  const key = createHash('sha256').update(JSON.stringify({ sourceHash, messages, connectionMode: llm.connectionMode,
    baseUrl: llm.baseUrl, model: llm.model, thinking: llm.thinking, webSearch: llm.webSearch })).digest('hex');
  const cacheFile = path.resolve(__dirname, '../../../data/resume-model-cache', key + '.json');
  const previous = await fs.promises.readFile(cacheFile, 'utf8').then(text => JSON.parse(text)).catch(() => null);
  if (previous?.edits?.length && Array.isArray(previous.topHighlights) && typeof previous.defaultGreetingPitch === 'string') {
    return previous;
  }
  let pending = pdfModelRequests.get(key);
  if (!pending) {
    pending = (async () => {
      const output = await llmService.chatJson<PdfModelResult>(messages);
      if (!Array.isArray(output.edits) || !Array.isArray(output.topHighlights) || typeof output.defaultGreetingPitch !== 'string') {
        throw new Error('AI 未返回有效的 PDF 简历优化内容，请重试');
      }
      // Save before local PDF export, so a layout repair never resubmits the same body to DeepSeek.
      await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.promises.writeFile(cacheFile, JSON.stringify(output), 'utf8');
      return output;
    })();
    pdfModelRequests.set(key, pending);
  }
  try { return structuredClone(await pending); }
  finally { if (pdfModelRequests.get(key) === pending) pdfModelRequests.delete(key); }
}

export class ResumeService {
  /**
   * 从用户上传的文件中提取简历纯文本
   */
  public async extractTextFromFile(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();
    // 异步读取：避免大文件阻塞事件循环（投递任务的 SSE 推送依赖同一事件循环）
    const buffer = await fs.promises.readFile(filePath);

    if (ext === '.pdf') {
      const text = await extractPdfText(buffer);
      return text.slice(0, MAX_RESUME_CHARS);
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ buffer });
      return normalizeResumeText(result.value).slice(0, MAX_RESUME_CHARS);
    } else if (ext === '.doc') {
      throw new Error('暂不支持旧版 .doc 二进制格式，请在 Word 中另存为 .docx 后重新上传');
    } else if (ext === '.txt' || ext === '.md') {
      return decodeResumeText(buffer).slice(0, MAX_RESUME_CHARS);
    } else {
      throw new Error(`不支持的文件格式: ${ext}，支持 .pdf, .docx, .txt, .md`);
    }
  }

  /**
   * 分析用户简历并推荐 3~5 个匹配的职业方向
   */
  public async diagnoseResume(resumeText: string): Promise<ResumeAnalysisResult> {
    if (!resumeText || resumeText.length < 50) {
      throw new Error('简历内容过短，无法进行有效分析，请确认上传了完整简历。');
    }

    const catalog = await bossCatalogService.getPositions();
    const positions = [...new Map(positionSelections(catalog.categories).map((item) => [item.code, item])).values()];
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是一名资深的互联网/高科技行业招聘专家与职业规划师。
你的任务是深入诊断求职者的简历，分析其核心技能树、业务领域经历与潜在竞争力，并给出 3~5 个最适合在招聘平台（如 BOSS 直聘）上寻找的目标职业方向。
推荐岗位必须来自下面 BOSS 官方分类列表，positionCode 和 roleTitle 必须使用同一项的原始代码及名称，不得编造岗位分类。具体级别和技能方向写进推荐理由及搜索词。
【BOSS 官方岗位列表，格式：代码=名称】
${positions.map((item) => `${item.code}=${item.name}`).join('\n')}

请严格返回如下格式的 JSON 对象：
{
  "candidateName": "求职者姓名（若未提及可填未知）",
  "summary": "求职者核心竞争力画像与综合评估（150字以内）",
  "coreSkills": ["技能1", "技能2", "技能3", ...],
  "recommendations": [
    {
      "positionCode": "BOSS 官方岗位代码",
      "roleTitle": "对应代码的官方岗位名",
      "matchScore": 88,
      "recommendedReason": "推荐理由阐述",
      "advantages": ["核心胜任优势1", "核心胜任优势2"],
      "gapAdvice": ["针对该岗位的技能补强或准备建议1"],
      "keywords": ["用于BOSS搜索的核心关键词1", "关键词2", "关键词3"]
    }
  ]
}`,
      },
      {
        role: 'user',
        content: `以下是求职者的简历全文内容：\n\n${resumeText}\n\n请进行深度职业分析并输出职业方向推荐。`,
      },
    ];

    const result = await llmService.chatJson<ResumeAnalysisResult>(messages);
    if (!Array.isArray(result.recommendations)) throw new Error('AI 未返回有效的岗位推荐');
    result.recommendations = result.recommendations.map((recommendation) => {
      const position = positions.find((item) => item.code === recommendation.positionCode)
        || positions.find((item) => item.name === recommendation.roleTitle);
      if (!position) throw new Error('AI 推荐了官方分类中不存在的岗位，请重试分析或直接选择官方岗位投递');
      return { ...recommendation, positionCode: position.code, roleTitle: position.name };
    });
    return result;
  }

  /**
   * 按照选定的目标岗位，对原始简历进行针对性优化和重写
   */
  public async rewriteForTargetRole(sourceId: string, targetRole: string): Promise<TailoredResumeResult> {
    const layout = await resumePdfService.inspect(sourceId);
    const regions = layout.regions.filter(region => region.editable);
    if (!regions.length) throw new Error('原 PDF 没有可润色的经历正文，请确认上传了完整的文字 PDF 简历');
    // Only editable body paragraphs are sent to the model. Personal/contact/education/employer headers stay local.
    const protectedValues = layout.regions.filter(region => !region.editable).flatMap((region, index) => {
      const tokens: string[] = region.text.match(/[\w.+-]+@[\w.-]+|1[3-9]\d{9}|[\p{Script=Han}A-Za-z（）()]{2,40}(?:有限公司|大学|学院|学校)/gu) || [];
      if (index === 0 && /^[\p{Script=Han}]{2,6}$/u.test(region.text)) tokens.push(region.text);
      return tokens;
    });
    const masks = new Map<string, string>();
    let maskIndex = 0;
    const anonymous = (text: string) => {
      for (const value of protectedValues) if (value && text.includes(value)) {
        if (!masks.has(value)) masks.set(value, `〔资料${String.fromCharCode(65 + maskIndex++)}〕`);
        text = text.split(value).join(masks.get(value)!);
      }
      return text.replace(/[\w.+-]+@[\w.-]+|1[3-9]\d{9}/g, '〔联系资料〕');
    };
    const modelRegions = regions.map(({ id, text, maxChars, page }) => ({ id, page, text: anonymous(text), maxChars }));
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是一名简历编辑。目标岗位为【${targetRole}】，需要在原 PDF 版式内润色经历正文。
原 PDF 的图片、标题、个人资料和事实信息由本机直接保留，不提供给你。
你只允许修改用户给出的可编辑区域。每项使用原 id，text 为纯文本，不得返回 Markdown 或新章节。
将表达写得简洁、具体，与目标岗位相关。事实只来自原简历，不得编造经验、技能、成果、平台、年限或资质。
不得添加或删除任何数字、百分比，也不得把“借助 AI 完成”写成独立精通编程；保留实际能力边界。
每项文字长度必须小于 maxChars，优先压缩到原文的 85%至95%，给中文字体和英文词留足排版空间。
保持原段落的项目符号，每个区域只写一个段落。原文换行由 PDF 排版负责。纠正多余的项目符号和不自然的空格。
如果出现〔资料A〕等占位符，必须完整保留，占位符由本机还原。
从原事实中提炼最多3条核心亮点；生成100字以内的开聊自荐语，同样不能虚构事实。
返回 JSON：{"edits":[{"id":"原区域id","text":"润色后的完整段落"}],"topHighlights":["亮点"],"defaultGreetingPitch":"自荐语"}`,
      },
      {
        role: 'user',
        content: `【目标岗位】：${targetRole}\n【脱敏后的经历正文，仅可使用这些事实】：\n${JSON.stringify(modelRegions)}`,
      },
    ];

    const output = await cachedPdfModelResult(messages, layout.sha256);
    if (!Array.isArray(output.edits) || !Array.isArray(output.topHighlights) || typeof output.defaultGreetingPitch !== 'string') {
      throw new Error('AI 未返回有效的 PDF 简历优化内容，请重试');
    }
    for (const edit of output.edits) {
      if (!edit || typeof edit.text !== 'string') throw new Error('AI 返回的段落无效，请重试');
      const original = modelRegions.find(region => region.id === edit.id);
      if (!original) throw new Error('AI 返回了不存在的简历段落');
      for (const [value, mask] of masks) {
        if (original.text.includes(mask) && !edit.text.includes(mask)) throw new Error('AI 删除了需要保留的事实，请重试');
        edit.text = edit.text.split(mask).join(value);
      }
    }
    const restore = (text: string) => { for (const [value, mask] of masks) text = text.split(mask).join(value); return text; };
    const result: TailoredResumeResult = { targetRole, rewrittenResumeMarkdown: '',
      topHighlights: output.topHighlights.filter(item => typeof item === 'string').slice(0, 3).map(restore),
      defaultGreetingPitch: restore(output.defaultGreetingPitch).slice(0, 150) };
    result.pdf = await resumePdfService.export(sourceId, targetRole, layout, output.edits, result);
    result.rewrittenResumeMarkdown = result.pdf.text;
    return result;
  }
}

export const resumeService = new ResumeService();
