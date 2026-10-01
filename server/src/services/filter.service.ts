import { configManager } from '../config/config.manager.js';
import { llmService, ChatMessage } from './llm.service.js';
import { BossJobItem, JobFilterResult } from '../types.js';
import { checkEducationRequirement, normalizeCandidateDegrees } from './education.js';

const EXPERIENCE_TOKENS = ['应届生', '在校/应届', '在校', '应届', '1年以内', '1-3年', '3-5年', '5-10年', '10年以上', '10年及以上'];

export interface Stage2Result {
  passed: boolean;
  score: number;
  reason: string;
  customGreeting: string;
  /** 大模型不可用（网络/超时/凭据/输出非法）导致的判定失败，供上层区分"AI 淘汰"与"AI 不可用" */
  llmError?: boolean;
}

export class FilterService {
  /**
   * 阶段一：硬性规则过滤（HR 活跃度 / 黑名单 / 学历 / 工作经验 / 薪资区间）
   * 任一维度无法解析时一律放行，避免因解析失败误杀岗位。
   */
  public evaluateStage1(job: BossJobItem): { passed: boolean; reason?: string } {
    const filterCfg = configManager.getConfig().filter;

    // 1. HR 活跃度：按配置要求的天数阈值判定
    const activeDays = this.resolveActiveDays(job.activeTimeDesc || '');
    const activeLimit = Number(filterCfg.hrActiveDaysLimit) || 0;
    if (activeLimit > 0 && activeDays !== null && activeDays > activeLimit) {
      return { passed: false, reason: `HR 活跃度不达标（${job.activeTimeDesc}，要求 ${activeLimit} 日内活跃）` };
    }

    // 2. 公司黑名单（公司名 + 行业名）
    const companyName = job.brandName || '';
    const industry = job.brandIndustry || '';
    for (const black of filterCfg.companyBlacklist || []) {
      if (!black) continue;
      if (companyName.includes(black) || industry.includes(black)) {
        return { passed: false, reason: `命中黑名单关键词「${black}」` };
      }
    }

    // 3. 学历要求
    const degreeCheck = checkEducationRequirement(job.jobDegree || '', filterCfg.degree || []);
    if (!degreeCheck.passed) return { passed: false, reason: degreeCheck.reason };

    // 4. 工作经验
    const expCheck = this.checkExperience(job.jobExperience || '', filterCfg.experience || []);
    if (!expCheck.passed) return { passed: false, reason: expCheck.reason };

    // 5. 薪资区间（期望区间与岗位区间必须有重叠）
    const salaryCheck = this.checkSalary(job.salaryDesc || '', filterCfg.salaryMin, filterCfg.salaryMax);
    if (!salaryCheck.passed) return { passed: false, reason: salaryCheck.reason };

    return { passed: true };
  }

  /** 把 "刚刚活跃 / 3日内活跃 / 本周活跃 / 本月活跃" 归一为天数，无法识别返回 null */
  private resolveActiveDays(text: string): number | null {
    const t = text.trim();
    if (!t) return null;
    if (/刚刚|今日|今天|在线|分钟内|小时内/.test(t)) return 0;
    const dayMatch = t.match(/(\d+)\s*日内活跃/);
    if (dayMatch) return parseInt(dayMatch[1], 10);
    const weekMatch = t.match(/(\d+)\s*周内活跃/);
    if (weekMatch) return parseInt(weekMatch[1], 10) * 7;
    if (/本周活跃/.test(t)) return 7;
    if (/(\d+)\s*月内活跃/.test(t)) return parseInt((t.match(/(\d+)\s*月内活跃/) as RegExpMatchArray)[1], 10) * 30;
    if (/本月活跃/.test(t)) return 30;
    if (/半年|很久|年活跃|无记录|未活跃/.test(t)) return 999;
    return null;
  }

  private checkExperience(jobExperience: string, allowed: string[]): { passed: boolean; reason?: string } {
    if (!allowed.length) return { passed: true };
    if (!jobExperience || /不限/.test(jobExperience)) return { passed: true };
    const hit = EXPERIENCE_TOKENS.find((e) => jobExperience.includes(e));
    if (!hit) return { passed: true };
    const normalized = hit === '在校' ? '在校/应届' : hit === '应届' ? '应届生' : hit === '10年及以上' ? '10年以上' : hit;
    const allowList = allowed.map((e) =>
      e === '在校' ? '在校/应届' : e === '应届' ? '应届生' : e === '10年及以上' ? '10年以上' : e
    );
    if (!allowList.includes(normalized)) {
      return { passed: false, reason: `工作经验要求不符（岗位要求 ${hit}，期望 ${allowed.join('/')}）` };
    }
    return { passed: true };
  }

  /**
   * 解析岗位薪资描述的月薪区间（单位 K）。
   * 支持 "15-25K"、"15-25K·13薪"、"1.5-2.5万"、"20K以上"、"面议"；
   * 日薪/时薪（如 "200-300元/天"）无法与月薪比较，返回 null 交上层放行。
   */
  public parseSalaryRangeK(desc: string): { min: number; max: number } | null {
    const text = (desc || '').replace(/\s/g, '');
    if (!text || /面议|保密|议薪/.test(text)) return null;
    if (/\/天|每天|元\/时|小时|日薪|时薪/.test(text)) return null;
    if (/万/.test(text) && !/K|k/.test(text)) {
      const m = text.match(/(\d+(?:\.\d+)?)[-~至](\d+(?:\.\d+)?)万/);
      if (m) return { min: parseFloat(m[1]) * 10, max: parseFloat(m[2]) * 10 };
      const single = text.match(/(\d+(?:\.\d+)?)万/);
      if (single) return { min: parseFloat(single[1]) * 10, max: parseFloat(single[1]) * 10 };
    }
    const range = text.match(/(\d+(?:\.\d+)?)[-~至](\d+(?:\.\d+)?)/);
    if (range) {
      const a = parseFloat(range[1]);
      const b = parseFloat(range[2]);
      return { min: Math.min(a, b), max: Math.max(a, b) };
    }
    const single = text.match(/(\d+(?:\.\d+)?)[Kk]/);
    if (single) {
      const v = parseFloat(single[1]);
      return { min: v, max: v };
    }
    return null;
  }

  private checkSalary(desc: string, cfgMin?: number, cfgMax?: number): { passed: boolean; reason?: string } {
    const lo = typeof cfgMin === 'number' && cfgMin > 0 ? cfgMin : 0;
    const hi = typeof cfgMax === 'number' && cfgMax > 0 ? cfgMax : Number.POSITIVE_INFINITY;
    if (lo === 0 && hi === Number.POSITIVE_INFINITY) return { passed: true };
    const jobRange = this.parseSalaryRangeK(desc);
    if (!jobRange) return { passed: true };
    const hasOverlap = jobRange.max >= lo && jobRange.min <= hi;
    if (!hasOverlap) {
      return {
        passed: false,
        reason: `薪资区间不重叠（岗位 ${desc || '未知'}，期望 ${lo}~${hi === Number.POSITIVE_INFINITY ? '不限' : hi}K）`,
      };
    }
    return { passed: true };
  }

  /** 把大模型返回的任何 score 形式归一为 0~100 的数字，无法解析返回 NaN */
  private normalizeScore(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN;
    if (!Number.isFinite(n)) return NaN;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  /**
   * 阶段二：LLM 语义精细打分与针对性打招呼生成。
   * 大模型不可用时一律 fail-closed（不投递），避免退化为"全量盲投"。
   */
  public async evaluateStage2(
    job: BossJobItem,
    jobDetail: string,
    candidateResumeText: string,
    targetRole: string,
    candidateSource: 'resume' | 'requirements' = 'resume'
  ): Promise<Stage2Result> {
    const filterCfg = configManager.getConfig().filter;
    const minScore = filterCfg.minLlmMatchScore ?? 75;
    const required = filterCfg.requiredKeywords || [];
    if (required.length) {
      const searchable = [job.jobName, ...(job.skills || []), jobDetail].join(' ').toLocaleLowerCase();
      if (!required.some((word) => searchable.includes(word.toLocaleLowerCase()))) {
        return {
          passed: false,
          score: 0,
          reason: `未命中需求词（${required.join('、')}）`,
          customGreeting: '',
        };
      }
    }

    const isManual = candidateSource === 'requirements';
    const candidateDegree = normalizeCandidateDegrees(filterCfg.degree)[0];
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是一名严谨的技术招聘总监。请根据${isManual ? '用户明确填写的求职目标与筛选要求' : '求职者简历'}与目标岗位 JD，进行严谨的匹配度评估与打分（0~100分）。
评估维度包括：
1. 核心技术栈重合度（硬性门槛）
2. 业务项目经历契合度
3. 岗位层级与工作年限匹配度
${isManual ? '用户没有提供简历。只依据其填写的要求及明确设置的最高学历评估，不得推测未提供的经历、技能或学历。' : '只依据提供的简历及用户明确设置的信息判断，不得捏造经历。'}
学历按岗位最低门槛比较：本科满足大专/专科要求，硕士满足本科及以下要求，博士满足硕士及以下要求。
不得仅因求职者学历高于岗位最低要求而扣分或淘汰。明确限定“仅限某学历”及全日制、专业等额外条件另行判断；用户未提供的学历不得推测。

如果打分 >= ${minScore} 分，请生成一条不超过 80 字的专业打招呼首语。不得声称用户具备未提供的经历或技能。
如果打分 < ${minScore} 分，请给出清晰的淘汰原因。

请严格返回如下格式的 JSON 对象：
{
  "score": 85,
  "passed": true,
  "reason": "技术栈与业务场景高度吻合...",
  "customGreeting": "您好，我关注贵司的${targetRole}岗位，希望了解岗位要求并与您交流。"
}`,
      },
      {
        role: 'user',
        content: `【目标职业】：${targetRole}

【${isManual ? '用户指定的岗位方向与筛选要求' : '求职者简历信息摘要'}】：
${candidateResumeText.slice(0, 2000)}
${candidateDegree ? `\n【用户明确设置的最高学历】：${candidateDegree}` : ''}

【招聘岗位信息】：
- 岗位名称：${job.jobName}
- 公司：${job.brandName} (${job.brandScaleName})
- 薪资：${job.salaryDesc}
- 岗位学历要求：${job.jobDegree || '未注明'}
- 技能标签：${job.skills.join(', ')}
- 详细职责与要求：
${jobDetail.slice(0, 1500)}`,
      },
    ];

    try {
      const result = await llmService.chatJson<{
        score?: number | string;
        passed?: boolean;
        reason?: string;
        customGreeting?: string;
      }>(messages);

      const score = this.normalizeScore(result?.score);
      if (!Number.isFinite(score)) {
        return {
          passed: false,
          score: 0,
          reason: '大模型返回的评分无法解析，已跳过该岗位',
          customGreeting: '',
          llmError: true,
        };
      }

      const passed = score >= minScore;
      let customGreeting = typeof result?.customGreeting === 'string' ? result.customGreeting.trim() : '';
      if (passed && !customGreeting) {
        customGreeting = `您好，我对贵司的【${job.jobName}】岗位很感兴趣，希望能与您交流岗位详情。`;
      }
      const reason =
        typeof result?.reason === 'string' && result.reason.trim()
          ? result.reason.trim()
          : passed
          ? '语义匹配达标'
          : '大模型判定为不匹配（未给出具体原因）';

      return { passed, score, reason, customGreeting };
    } catch (err) {
      // fail-closed：宁可跳过，也不能在大模型不可用时无差别群发
      return {
        passed: false,
        score: 0,
        reason: `大模型评估失败，已跳过（不投递）：${(err as Error).message}`,
        customGreeting: '',
        llmError: true,
      };
    }
  }

  /**
   * 完整综合过滤评估
   */
  public async evaluateJob(
    job: BossJobItem,
    jobDetail: string,
    resumeText: string,
    targetRole: string,
    candidateSource: 'resume' | 'requirements' = 'resume'
  ): Promise<JobFilterResult> {
    const stage1 = this.evaluateStage1(job);
    if (!stage1.passed) {
      return {
        job,
        passedStage1: false,
        stage1Reason: stage1.reason,
        passedStage2: false,
      };
    }

    const stage2 = await this.evaluateStage2(job, jobDetail, resumeText, targetRole, candidateSource);
    return {
      job,
      passedStage1: true,
      llmScore: stage2.score,
      passedStage2: stage2.passed,
      stage2Reason: stage2.reason,
      customGreeting: stage2.customGreeting,
    };
  }
}

export const filterService = new FilterService();
