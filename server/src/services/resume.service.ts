import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { llmService, ChatMessage } from './llm.service.js';
import { bossCatalogService, positionSelections } from './boss.catalog.service.js';
import { ResumeAnalysisResult, TailoredResumeResult } from '../types.js';

const MAX_RESUME_CHARS = 20000;

export class ResumeService {
  /**
   * 从用户上传的文件中提取简历纯文本
   */
  public async extractTextFromFile(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();
    // 异步读取：避免大文件阻塞事件循环（投递任务的 SSE 推送依赖同一事件循环）
    const buffer = await fs.promises.readFile(filePath);

    if (ext === '.pdf') {
      const data = await pdfParse(buffer);
      const text = data.text.trim();
      if (!text) throw new Error('PDF 中未提取到文本，可能是扫描件/图片型 PDF，请改用 .docx 或 .txt');
      return text.slice(0, MAX_RESUME_CHARS);
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim().slice(0, MAX_RESUME_CHARS);
    } else if (ext === '.doc') {
      throw new Error('暂不支持旧版 .doc 二进制格式，请在 Word 中另存为 .docx 后重新上传');
    } else if (ext === '.txt' || ext === '.md') {
      return buffer.toString('utf-8').trim().slice(0, MAX_RESUME_CHARS);
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
  public async rewriteForTargetRole(resumeText: string, targetRole: string): Promise<TailoredResumeResult> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是一名顶级技术简历优化专家。现在求职者确定将【${targetRole}】作为核心求职目标。
请你对用户的原始简历进行针对性深度润色与重构：
1. 强化与【${targetRole}】最相关的技术栈、项目经验和业务亮点，弱化弱相关内容。
2. 经历描述严格遵循 STAR 法则（情境、任务、行动、量化成果），突出工程深度、解决难题的能力和业务价值指标。
3. 提炼出 3 条求职者申请【${targetRole}】的最强核心卖点（topHighlights）。
4. 生成一条专用于 BOSS直聘向招聘方（HR/技术主管）开聊的破冰自荐语（defaultGreetingPitch，控制在 100 字以内，真诚、专业、突出与 JD 的硬核匹配）。

请严格返回如下格式的 JSON 对象：
{
  "targetRole": "${targetRole}",
  "rewrittenResumeMarkdown": "# 优化后的完整 Markdown 简历正文...",
  "topHighlights": ["亮点1", "亮点2", "亮点3"],
  "defaultGreetingPitch": "您好！我有X年研发经验，精通...主导过...看到贵司该职位与我的背景高度契合，希望能与您进一步交流！"
}`,
      },
      {
        role: 'user',
        content: `【目标岗位】：${targetRole}\n\n【原始简历全文】：\n${resumeText}`,
      },
    ];

    return await llmService.chatJson<TailoredResumeResult>(messages);
  }
}

export const resumeService = new ResumeService();
