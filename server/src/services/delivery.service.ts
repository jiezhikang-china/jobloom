import { boundedInteger, configManager } from '../config/config.manager.js';
import { stateManager, todayStr } from '../config/state.manager.js';
import { bossPageService, DOMJobCardInfo } from './boss.page.service.js';
import { filterService, Stage2Result } from './filter.service.js';
import { browserService } from './browser.service.js';
import { workConditionReviews } from './work-condition-reviews.js';
import { exclusionsFromText, findJobExclusion, needsCompanyIndustry } from './job-exclusions.js';
import { jobInformationIssue } from './job-information.js';
import { configuredWorkRequirements, hasEntryLevelRequirement } from './work-requirements.js';
import { DeliveryStats, DeliveryLogItem, BossJobItem } from '../types.js';

const LLM_FAILURE_PAUSE_THRESHOLD = 3;
const COOL_DOWN_SECONDS = 15 * 60;

interface PendingCandidate { jobCard: DOMJobCardInfo; job: BossJobItem; jobDetail: string; detail: Awaited<ReturnType<typeof bossPageService.loadJobDetail>>; }

export class DeliveryService {
  private stats: DeliveryStats = {
    status: 'idle',
    isPaused: false,
    needsCaptchaVerification: false,
    todayAppliedCount: 0,
    dailyMaxQuota: 80,
    totalScanned: 0,
    passedFilterCount: 0,
    markedNotSuitCount: 0,
    skippedByLlmErrorCount: 0,
  };

  private logs: DeliveryLogItem[] = [];
  private isStopRequested = false;
  private isTaskActive = false;
  private listeners: Array<(stats: DeliveryStats, log?: DeliveryLogItem) => void> = [];
  private consecutiveLlmFailures = 0;
  private evaluationAbort?: AbortController;

  constructor() {
    // 启动即恢复"今日已投递"计数（跨自然日会自动归零，避免隔天仍被判定配额已满）
    const quota = stateManager.loadQuota();
    this.stats.todayAppliedCount = quota.count;
    this.stats.quotaDate = quota.date;
    this.stats.dailyMaxQuota = configManager.getConfig().delivery.dailyMaxQuota;
  }

  public getStats(): DeliveryStats {
    return { ...this.stats };
  }

  public isActive(): boolean {
    return this.isTaskActive;
  }

  public getLogs(): DeliveryLogItem[] {
    return [...this.logs];
  }

  public subscribe(cb: (stats: DeliveryStats, log?: DeliveryLogItem) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private emit(log?: DeliveryLogItem): void {
    for (const listener of this.listeners) {
      try {
        listener(this.stats, log);
      } catch (err) {
        // 单个订阅者（如已断开的 SSE 连接）异常不影响主流程
      }
    }
  }

  public log(
    level: DeliveryLogItem['level'],
    message: string,
    extra?: { jobName?: string; companyName?: string; score?: number }
  ): void {
    const item: DeliveryLogItem = {
      id: Math.random().toString(36).slice(2),
      timestamp: new Date().toLocaleTimeString(),
      level,
      message,
      ...(extra || {}),
    };
    this.logs.unshift(item);
    if (this.logs.length > 500) this.logs.pop();
    this.emit(item);
  }

  public pause(): void {
    if (!this.isTaskActive || this.stats.status !== 'running') return;
    this.stats.isPaused = true;
    this.stats.status = 'paused';
    this.log('warn', '用户主动暂停了自动投递任务（点击【恢复运行】继续）');
  }

  public resume(): void {
    if (!this.isTaskActive || this.stats.status !== 'paused') return;
    this.stats.isPaused = false;
    this.stats.needsCaptchaVerification = false;
    this.stats.status = 'running';
    this.log('info', '任务已恢复运行');
  }

  public stop(): void {
    if (!this.isTaskActive) return;
    this.isStopRequested = true;
    this.evaluationAbort?.abort(new Error('投递任务已停止'));
    this.stats.status = 'idle';
    this.stats.isPaused = false;
    this.stats.needsCaptchaVerification = false;
    this.log('info', '正在停止投递任务...');
  }

  /** 跨自然日（服务常驻跨零点）时自动重置今日计数 */
  private ensureQuotaFresh(): void {
    const today = todayStr();
    if (this.stats.quotaDate !== today) {
      this.stats.quotaDate = today;
      this.stats.todayAppliedCount = 0;
      stateManager.saveQuota(today, 0);
      this.log('info', '已跨入新的一天，今日投递计数已重置为 0');
    }
  }

  private persistQuota(): void {
    stateManager.saveQuota(this.stats.quotaDate || todayStr(), this.stats.todayAppliedCount);
  }

  /**
   * 可中断 sleep：每秒检查一次停止标志。
   * 验证码等待、冷却、贤者时间全部走它，确保【停止任务】随时生效。
   * @returns 是否完整睡满（false 表示被停止打断）
   */
  private async sleepInterruptible(ms: number, onSecond?: (remainingSeconds: number) => void): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (this.isStopRequested) return false;
      const remain = ms - (Date.now() - start);
      await new Promise((r) => setTimeout(r, Math.min(1000, remain)));
      if (onSecond) onSecond(Math.max(0, Math.round((ms - (Date.now() - start)) / 1000)));
    }
    return !this.isStopRequested;
  }

  /**
   * 启动全真 DOM 拟人化自动投递主流程
   */
  public async startDelivery(params: {
    targetRole: string;
    positionCode?: string;
    keywords: string[];
    resumeText: string;
    defaultGreeting?: string;
    candidateSource?: 'resume' | 'requirements';
    rulesOnly?: boolean;
  }): Promise<void> {
    if (this.isTaskActive) {
      throw new Error('投递任务已经在运行中');
    }

    this.isTaskActive = true;
    const cfg = configManager.getConfig();
    this.ensureQuotaFresh();
    this.isStopRequested = false;
    this.evaluationAbort = new AbortController();
    this.consecutiveLlmFailures = 0;
    this.stats = {
      status: 'running',
      isPaused: false,
      needsCaptchaVerification: false,
      todayAppliedCount: this.stats.todayAppliedCount,
      dailyMaxQuota: cfg.delivery.dailyMaxQuota,
      quotaDate: this.stats.quotaDate,
      totalScanned: 0,
      passedFilterCount: 0,
      markedNotSuitCount: 0,
      skippedByLlmErrorCount: 0,
      localDecisionCount: 0,
      aiRequestCount: 0,
      cachedEvaluationCount: 0,
      pendingEvaluationCount: 0,
    };

    this.log(
      'info',
      `🚀 全真 DOM 拟人化投递任务启动！目标职业: ${params.targetRole}，检索关键词: ${params.keywords.join(', ')}，城市: ${cfg.filter.cityName || '不限'}`
    );

    let batchSuccessCount = 0; // 用于触发贤者时间批次计数
    const processedJobKeys = new Set<string>();
    let stoppedByUser = false;

    try {
      if (this.stats.todayAppliedCount >= this.stats.dailyMaxQuota) {
        this.log('warn', `今日投递已达预设配额上限 (${this.stats.todayAppliedCount}/${this.stats.dailyMaxQuota})`);
        this.stats.status = 'finished';
        this.emit();
        return;
      }
      const useSavedExpectations = cfg.delivery.jobSource === 'saved_expectations';
      const sources = useSavedExpectations ? await bossPageService.getSavedExpectationNames() : params.keywords;
      const openList = (source: string) => useSavedExpectations
        ? bossPageService.initJobPage(undefined, cfg.filter.cityCode, undefined, { expectationName: source })
        : bossPageService.initJobPage(source, cfg.filter.cityCode, params.positionCode);
      if (useSavedExpectations) this.log('info', 'BOSS 自选求职期望：' + sources.join('、'));
      for (const keyword of sources) {
        if (this.isStopRequested) {
          stoppedByUser = true;
          break;
        }
        this.log('info', useSavedExpectations ? '正在打开 BOSS 自选岗位：' + keyword : '正在搜索岗位：' + keyword);

        let pageReady = false;
        for (let attempt = 0; attempt < 2 && !this.isStopRequested; attempt++) {
          try {
            await openList(keyword);
            pageReady = true;
            break;
          } catch (error) {
            if (!/CAPTCHA_REQUIRED/.test((error as Error).message)) throw error;
            await this.handleCaptcha();
          }
        }
        if (this.isStopRequested) {
          stoppedByUser = true;
          break;
        }
        if (!pageReady) throw new Error('BOSS 安全验证后仍无法打开职位列表，任务已停止');
        let noNewJobScrollAttempts = 0;

        const pending: PendingCandidate[] = [];
        const aiBatchSize = boundedInteger(cfg.llm.jobBatchSize, 5, 1, 10);
        const exclusionText = params.candidateSource === 'requirements' ? params.resumeText : '';
        const detailOptions = { readIndustry: cfg.filter.skipMissingCompanyIntro === true || needsCompanyIndustry(cfg.filter, exclusionText), filter: cfg.filter, exclusionText };
        const processEvaluation = async (candidate: PendingCandidate, evaluation: Stage2Result, reopen: boolean): Promise<void> => {
          const { jobCard, job: mockJobItem } = candidate;
          if (JSON.stringify(configManager.getConfig().filter) !== JSON.stringify(cfg.filter)) {
            throw new Error('筛选条件已变化，请重新启动任务以重新评估岗位');
          }
          const exclusion = findJobExclusion({ ...mockJobItem, jobDetail: candidate.jobDetail }, cfg.filter, exclusionText);
          const informationIssue = jobInformationIssue({ jobDetail: candidate.jobDetail, companyInfo: mockJobItem.companyInfo }, cfg.filter);
          if (exclusion || informationIssue) {
            evaluation = { passed: false, score: 0, customGreeting: '', reason: exclusion?.reason || informationIssue!, evaluationSource: 'rules' };
            try { workConditionReviews.removeForJob(jobCard.jobHref); } catch {}
          }
          let cardLocator = jobCard.cardLocator;
          let detailRes = candidate.detail;
          const sourceLabel = evaluation.evaluationSource === 'rules' ? '本地筛选' : evaluation.evaluationSource === 'cache' ? '已有评估' : 'AI评估';
          const scoreLabel = evaluation.evaluationSource === 'rules' ? '' : ' - 得分 ' + evaluation.score;
          const scoreExtra = evaluation.evaluationSource === 'rules' ? {} : { score: evaluation.score };
          if (evaluation.evaluationSource === 'rules') this.stats.localDecisionCount = (this.stats.localDecisionCount || 0) + 1;
          if (evaluation.evaluationSource === 'cache') this.stats.cachedEvaluationCount = (this.stats.cachedEvaluationCount || 0) + 1;
          // 大模型不可用：跳过且不计入淘汰，避免"AI 挂了就盲投"
          if (evaluation.llmError) {
            this.consecutiveLlmFailures++;
            this.stats.skippedByLlmErrorCount++;
            this.log('error', `[AI 不可用·已跳过] ${mockJobItem.brandName} - ${jobCard.jobName}: ${evaluation.reason}`);
            const usingWebModel = configManager.getConfig().llm.connectionMode === 'deepseek-web';
            if (usingWebModel || this.consecutiveLlmFailures >= LLM_FAILURE_PAUSE_THRESHOLD) {
              this.log(
                'error',
                usingWebModel
                  ? 'DeepSeek 网页调用失败，已暂停投递。请到【设置】检查登录、网络或网页额度，恢复后点击【恢复运行】。'
                  : `大模型连续 ${LLM_FAILURE_PAUSE_THRESHOLD} 次调用失败，已暂停投递。请到【设置】检查模型连接后点击【恢复运行】。`
              );
              this.pause();
            }
            return;
          }
          this.consecutiveLlmFailures = 0;

          if (evaluation.needsReview && evaluation.requirementAssessment) {
            try {
              workConditionReviews.add({
                jobHref: jobCard.jobHref, jobName: jobCard.jobName, companyName: jobCard.companyName,
                salary: jobCard.salary, reason: evaluation.reason,
                requirements: configuredWorkRequirements(cfg.filter), assessment: evaluation.requirementAssessment,
                screening: { industry: mockJobItem.brandIndustry, jobDetail: candidate.jobDetail, skills: mockJobItem.skills,
                  ...(mockJobItem.companyInfo ? { companyInfo: mockJobItem.companyInfo } : {}),
                  ...(evaluation.needsCompanyConfirmation ? { needsCompanyConfirmation: true } : {}),
                  taskExclusions: exclusionsFromText(exclusionText) },
              });
              this.log('info', '[工作条件待确认·未投递] ' + jobCard.companyName + ' - ' + jobCard.jobName + '：' + evaluation.reason);
            } catch {
              this.log('error', '[未投递] 工作条件需要确认，但待确认记录保存失败：' + jobCard.companyName + ' - ' + jobCard.jobName);
            }
            this.emit();
            return;
          }

          while (this.stats.isPaused && !this.isStopRequested) await new Promise((resolve) => setTimeout(resolve, 1000));
          if (this.isStopRequested || this.stats.status === 'finished') return;
          this.ensureQuotaFresh();
          if (this.stats.todayAppliedCount >= this.stats.dailyMaxQuota) { this.stats.status = 'finished'; return; }
          if (JSON.stringify(configManager.getConfig().filter) !== JSON.stringify(cfg.filter)) {
            throw new Error('筛选条件已变化，请重新启动任务以重新评估岗位');
          }
          if (evaluation.passed && reopen) {
            if (!(await bossPageService.isJobListPage())) await openList(keyword);
            const freshCard = (await bossPageService.getVisibleJobCards()).find((card) =>
              new URL(card.jobHref, 'https://www.zhipin.com').pathname === new URL(jobCard.jobHref, 'https://www.zhipin.com').pathname
              && card.jobName === jobCard.jobName && card.companyName === jobCard.companyName);
            if (!freshCard) { this.log('warn', '[暂存跳过] 已无法定位原岗位：' + jobCard.companyName + ' - ' + jobCard.jobName); return; }
            if (freshCard.salary !== jobCard.salary || freshCard.degree !== jobCard.degree || freshCard.experience !== jobCard.experience
              || freshCard.cityName !== jobCard.cityName || JSON.stringify(freshCard.skills) !== JSON.stringify(jobCard.skills)) {
              this.log('warn', '[暂存已过期] 岗位字段已变化，需要重新评估：' + jobCard.companyName + ' - ' + jobCard.jobName); return;
            }
            cardLocator = freshCard.cardLocator;
            try { detailRes = await bossPageService.loadJobDetail(cardLocator, jobCard.jobName, jobCard.companyName, jobCard.jobHref,
              { ...detailOptions, refreshCompany: true }); }
            catch (error) {
              if (/CAPTCHA_REQUIRED/.test((error as Error).message)) { await this.handleCaptcha(); return; }
              if (/登录/.test((error as Error).message)) throw error;
              this.log('warn', '[暂存跳过] 无法重新读取岗位详情：' + jobCard.companyName + ' - ' + jobCard.jobName); return;
            }
            if (detailRes.jobDetailText.replace(/\s+/g, '') !== candidate.jobDetail.replace(/\s+/g, '')
              || !(await bossPageService.isDetailStillTarget(jobCard.jobName, jobCard.companyName, jobCard.jobHref))) {
              this.log('warn', '[暂存已过期] 描述或岗位身份已变化，需要重新评估：' + jobCard.companyName + ' - ' + jobCard.jobName); return;
            }
            if (detailRes.alreadyChatted) { try { workConditionReviews.removeForJob(jobCard.jobHref); } catch {} return; }
            if (!detailRes.chatButtonLocator) return;
            const recheck = filterService.evaluateStage1({ ...mockJobItem, brandIndustry: detailRes.brandIndustry,
              companyInfo: detailRes.companyInfo,
              activeTimeDesc: detailRes.activeTimeDesc || freshCard.activeTimeDesc }, detailRes.jobDetailText, cfg.filter, exclusionText);
            if (!recheck.passed) {
              this.log('warn', '[暂存淘汰] 最新岗位已不符合筛选：' + recheck.reason);
              try { workConditionReviews.removeForJob(jobCard.jobHref); } catch {}
              if (await bossPageService.markJobNotSuit(cardLocator, jobCard, recheck.reason)) this.stats.markedNotSuitCount++;
              this.emit(); return;
            }
            const companyFacts = (info: typeof detailRes.companyInfo) => {
              if (!info) return undefined;
              const { checkedAt: _checkedAt, ...facts } = info;
              return facts;
            };
            if (JSON.stringify(companyFacts(mockJobItem.companyInfo)) !== JSON.stringify(companyFacts(detailRes.companyInfo))) {
              this.log('warn', '[暂存已过期] 公司业务资料已变化，需要重新评估：' + jobCard.companyName + ' - ' + jobCard.jobName); return;
            }
          }

          if (!evaluation.passed) {
            try { workConditionReviews.removeForJob(jobCard.jobHref); } catch {}
            this.log('warn', `[${sourceLabel}${scoreLabel}] ${mockJobItem.brandName} - ${jobCard.jobName}: ${evaluation.reason}`, {
              jobName: jobCard.jobName,
              companyName: jobCard.companyName,
              ...scoreExtra,
            });
            const marked = await bossPageService.isCardStillTarget(cardLocator, jobCard.jobName, jobCard.companyName, jobCard.jobHref)
              && await bossPageService.markJobNotSuit(cardLocator, jobCard, evaluation.reason);
            if (marked) this.stats.markedNotSuitCount++;
            this.emit();
            return;
          }

          // 匹配达标！
          this.stats.passedFilterCount++;
          const finalGreeting = evaluation.customGreeting || params.defaultGreeting;
          this.log('success', `🎯 [${sourceLabel}通过${scoreLabel}] ${mockJobItem.brandName} - ${jobCard.jobName}，准备发起沟通...`, {
            jobName: jobCard.jobName,
            companyName: jobCard.companyName,
            ...scoreExtra,
          });

          // 拟人化随机阅览停顿（8~18 秒），可被停止打断
          const minSec = cfg.delivery.minDelaySeconds;
          const maxSec = Math.max(cfg.delivery.maxDelaySeconds, minSec);
          const delayMs = Math.floor((minSec + Math.random() * (maxSec - minSec)) * 1000);
          this.log('info', `⏳ 模拟真人阅读中，停顿 ${(delayMs / 1000).toFixed(1)} 秒后点击沟通...`);
          const slept = await this.sleepInterruptible(delayMs);
          if (!slept) {
            stoppedByUser = true;
            return;
          }

          while (this.stats.isPaused && !this.isStopRequested) {
            await new Promise((r) => setTimeout(r, 1000));
          }
          if (this.isStopRequested) {
            stoppedByUser = true;
            return;
          }
          if (this.stats.todayAppliedCount >= this.stats.dailyMaxQuota) {
            this.log('warn', '今日沟通配额已满，本轮停止');
            this.stats.status = 'finished';
            this.emit();
            return;
          }
          if (!(await bossPageService.isDetailStillTarget(jobCard.jobName, jobCard.companyName, jobCard.jobHref))) {
            this.log('warn', `[跳过] 发送前职位详情已变化: ${jobCard.companyName} - ${jobCard.jobName}`);
            return;
          }

          // 执行沟通点击与自适应弹窗注入
          if (!detailRes.chatButtonLocator) return;
          const chatResult = await bossPageService.executeChatClick(detailRes.chatButtonLocator, finalGreeting, {
            jobName: jobCard.jobName,
            companyName: jobCard.companyName,
            jobHref: jobCard.jobHref,
          });

          if (chatResult.targetChanged) {
            this.log('warn', `[跳过] 沟通前目标岗位已变化: ${jobCard.companyName} - ${jobCard.jobName}`);
            return;
          }
          if (chatResult.uncertain) {
            throw new Error(`岗位「${jobCard.companyName} - ${jobCard.jobName}」已触发沟通操作，但页面未确认结果；请人工检查会话后再启动新批次`);
          }

          if (chatResult.loginRequired) {
            throw new Error('BOSS 直聘登录态在沟通前失效，任务已停止；请重新扫码登录');
          }

          if (chatResult.needCaptcha) {
            await this.handleCaptcha();
            if (this.isStopRequested) {
              stoppedByUser = true;
              return;
            }
            if (!(await bossPageService.isJobListPage())) {
              await openList(keyword);
              return;
            }
            return;
          }

          if (chatResult.quotaExceeded) {
            this.log('warn', `平台提示沟通次数已达上限，停止今日投递`);
            this.stats.status = 'finished';
            this.emit();
            return;
          }

          if (chatResult.isCoolDown) {
            this.log('warn', `⚠️ 平台提示操作过于频繁，进入防封冷却模式，休眠 ${Math.round(COOL_DOWN_SECONDS / 60)} 分钟...`);
            this.stats.status = 'cool_down';
            this.stats.coolDownUntil = new Date(Date.now() + COOL_DOWN_SECONDS * 1000).toISOString();
            this.emit();
            const cooled = await this.sleepInterruptible(COOL_DOWN_SECONDS * 1000);
            this.stats.coolDownUntil = undefined;
            if (!cooled) {
              stoppedByUser = true;
              return;
            }
            this.stats.status = 'running';
            this.emit();
            if (!(await bossPageService.isJobListPage())) {
              await openList(keyword);
              return;
            }
            return;
          }

          if (chatResult.success) {
            try { workConditionReviews.removeForJob(jobCard.jobHref); } catch {
              this.log('warn', '已沟通，但移除旧的待确认记录失败，请手动刷新列表。');
            }
            this.stats.todayAppliedCount++;
            this.persistQuota();
            batchSuccessCount++;
            if (finalGreeting && !chatResult.greetingSent) {
              this.log('warn', `[自荐语未注入] 平台未显示打招呼输入框，沟通已建立但定制首语可能没有发送: ${jobCard.companyName} - ${jobCard.jobName}`);
            }
            this.log('success', `✅ 开聊成功: ${mockJobItem.brandName} - ${jobCard.jobName}！今日累计已开聊 ${this.stats.todayAppliedCount} 家`, {
              jobName: jobCard.jobName,
              companyName: jobCard.companyName,
              ...scoreExtra,
            });

            // 贤者时间（Sage Time）：每沟通 6 家强制长休眠 2~3 分钟打破机械特征
            if (batchSuccessCount >= 6) {
              batchSuccessCount = 0;
              const sageSeconds = 120 + Math.floor(Math.random() * 60); // 2~3 分钟
              await this.enterSageTime(sageSeconds);
              if (this.isStopRequested) {
                stoppedByUser = true;
                return;
              }
            }
          } else {
            this.log('warn', `❌ 未能确认沟通成功（未取得页面确认信号，不计入今日配额，请留意平台会话）: ${mockJobItem.brandName} - ${jobCard.jobName}`);
          }

          // 有些页面在开聊后跳到会话页。回到搜索页重新扫描，并用职位链接去重。
          if (!(await bossPageService.isJobListPage())) {
            await openList(keyword);
            return;
          }
        };
        const flushEvaluations = async (): Promise<void> => {
          if (!pending.length || this.isStopRequested) return;
          while (this.stats.isPaused && !this.isStopRequested) await new Promise((resolve) => setTimeout(resolve, 1000));
          if (this.isStopRequested) return;
          const candidates = pending.splice(0);
          this.stats.pendingEvaluationCount = candidates.length;
          this.log('info', '[批量评估] 已攒齐 ' + candidates.length + ' 个初筛岗位，共用一份简历/求职要求');
          const evaluations = await filterService.evaluateBatch(candidates.map((item) => ({
            job: item.job, jobDetail: item.jobDetail, jobHref: item.jobCard.jobHref,
          })), params.resumeText, useSavedExpectations ? keyword : params.targetRole, params.candidateSource || 'resume', {
            rulesOnly: params.rulesOnly,
            signal: this.evaluationAbort?.signal,
            onWait: (seconds) => this.log('info', '[AI 间隔] 等待 ' + seconds + ' 秒后再请求，可随时停止'),
            onRequest: () => { this.stats.aiRequestCount = (this.stats.aiRequestCount || 0) + 1; this.emit(); },
          });
          for (let index = 0; index < candidates.length; index++) {
            if (this.isStopRequested || this.stats.status === 'finished') break;
            await processEvaluation(candidates[index], evaluations[index], true);
            this.stats.pendingEvaluationCount = candidates.length - index - 1;
            this.emit();
          }
          this.stats.pendingEvaluationCount = 0;
        };


        while (!this.isStopRequested && noNewJobScrollAttempts < 6) {
          this.ensureQuotaFresh();

          // 检查每日配额
          if (this.stats.todayAppliedCount >= this.stats.dailyMaxQuota) {
            this.log('warn', `今日投递已达预设配额上限 (${this.stats.todayAppliedCount}/${this.stats.dailyMaxQuota})，任务自动圆满结束！`);
            this.stats.status = 'finished';
            this.emit();
            return;
          }

          // 暂停控制（可被停止打断）
          while (this.stats.isPaused && !this.isStopRequested) {
            await new Promise((r) => setTimeout(r, 1000));
          }
          if (this.isStopRequested) {
            stoppedByUser = true;
            break;
          }

          // 扫描当前页面可见卡片
          const cards = await bossPageService.getVisibleJobCards();
          let newlyFoundInThisBatch = 0;

          for (const jobCard of cards) {
            this.ensureQuotaFresh();
            if (this.stats.todayAppliedCount >= this.stats.dailyMaxQuota) {
              this.log('warn', `今日投递已达预设配额上限 (${this.stats.todayAppliedCount}/${this.stats.dailyMaxQuota})`);
              this.stats.status = 'finished';
              this.stats.currentProcessingJob = undefined;
              this.emit();
              return;
            }
            if (this.isStopRequested) {
              stoppedByUser = true;
              break;
            }

            while (this.stats.isPaused && !this.isStopRequested) {
              await new Promise((r) => setTimeout(r, 1000));
            }
            if (this.isStopRequested) {
              stoppedByUser = true;
              break;
            }

            const jobKey = new URL(jobCard.jobHref, 'https://www.zhipin.com').pathname;
            if (processedJobKeys.has(jobKey)) {
              continue;
            }
            processedJobKeys.add(jobKey);
            newlyFoundInThisBatch++;

            this.stats.totalScanned++;
            this.stats.currentProcessingJob = `${jobCard.companyName} - ${jobCard.jobName}`;
            this.emit();

            // 卡片身份校验：索引型 Locator 在列表重排后可能指向别的岗位
            let cardLocator = jobCard.cardLocator;
            if (!(await bossPageService.isCardStillTarget(cardLocator, jobCard.jobName, jobCard.companyName, jobCard.jobHref))) {
              const relocated = await bossPageService.relocateCard(jobCard.jobHref, jobCard.jobName, jobCard.companyName);
              if (!relocated) {
                this.log('warn', `[跳过] 列表已重排且无法重新定位该岗位: ${jobCard.companyName} - ${jobCard.jobName}`);
                continue;
              }
              cardLocator = relocated;
            }

            // 缺少关键筛选字段时跳过；匿名页与页面改版不能退化为无规则开聊。
            if ((cfg.filter.salaryMin || cfg.filter.salaryMax) && !jobCard.salary) {
              this.log('warn', `[跳过] 无法读取薪资: ${jobCard.companyName} - ${jobCard.jobName}`);
              continue;
            }
            if (cfg.filter.experience.length && !hasEntryLevelRequirement(cfg.filter) && !jobCard.experience) {
              this.log('warn', `[跳过] 无法读取经验要求: ${jobCard.companyName} - ${jobCard.jobName}`);
              continue;
            }
            if (cfg.filter.degree.length && !jobCard.degree) {
              this.log('warn', `[跳过] 无法读取学历要求: ${jobCard.companyName} - ${jobCard.jobName}`);
              continue;
            }
            if (cfg.filter.cityName && jobCard.cityName !== cfg.filter.cityName) {
              this.log('warn', `[跳过] 岗位城市与目标城市不符或无法读取: ${jobCard.companyName} - ${jobCard.jobName} (${jobCard.cityName || '未知'})`);
              if (jobCard.cityName && await bossPageService.markJobNotSuit(cardLocator, jobCard, '岗位城市与目标城市不符')) this.stats.markedNotSuitCount++;
              continue;
            }

            // Reject metadata mismatches before opening a detail panel or asking AI.
            const cardCheck = filterService.evaluateStage1({
              securityId: '', jobId: '', jobName: jobCard.jobName, lid: '', salaryDesc: jobCard.salary,
              jobExperience: jobCard.experience, jobDegree: jobCard.degree, cityName: jobCard.cityName,
              areaDistrict: '', brandName: jobCard.companyName, brandScaleName: '', brandIndustry: '',
              bossName: '', bossTitle: '', activeTimeDesc: jobCard.activeTimeDesc, skills: jobCard.skills, welfareList: [],
            }, '', cfg.filter, exclusionText);
            if (!cardCheck.passed) {
              try { workConditionReviews.removeForJob(jobCard.jobHref); } catch {}
              this.stats.localDecisionCount = (this.stats.localDecisionCount || 0) + 1;
              this.log('info', '[初筛淘汰] ' + jobCard.companyName + ' - ' + jobCard.jobName + '：' + cardCheck.reason);
              if (await bossPageService.isCardStillTarget(cardLocator, jobCard.jobName, jobCard.companyName, jobCard.jobHref)
                && await bossPageService.markJobNotSuit(cardLocator, jobCard, cardCheck.reason)) this.stats.markedNotSuitCount++;
              this.emit(); continue;
            }

            // 点击卡片，等待右侧载入完整 JD 与招聘者信息。
            let detailRes: Awaited<ReturnType<typeof bossPageService.loadJobDetail>>;
            try {
              detailRes = await bossPageService.loadJobDetail(cardLocator, jobCard.jobName, jobCard.companyName, jobCard.jobHref, detailOptions);
            } catch (err) {
              const message = (err as Error).message;
              if (/CAPTCHA_REQUIRED/.test(message)) {
                await this.handleCaptcha();
                if (this.isStopRequested) {
                  stoppedByUser = true;
                  break;
                }
                continue;
              }
              if (/登录/.test(message)) throw err;
              this.log('warn', `[跳过] 职位详情无法读取: ${jobCard.companyName} - ${jobCard.jobName}: ${message}`);
              if (!(await bossPageService.isJobListPage())) {
                await openList(keyword);
                break;
              }
              continue;
            }

            if (!(await bossPageService.isDetailStillTarget(jobCard.jobName, jobCard.companyName, jobCard.jobHref))) {
              this.log('warn', `[跳过] 右侧详情与岗位卡片不一致: ${jobCard.companyName} - ${jobCard.jobName}`);
              continue;
            }

            // 转换页面结构用于规则初筛。
            const mockJobItem: BossJobItem = {
              securityId: '',
              jobId: '',
              jobName: jobCard.jobName,
              lid: '',
              salaryDesc: jobCard.salary,
              jobExperience: jobCard.experience,
              jobDegree: jobCard.degree,
              cityName: jobCard.cityName,
              areaDistrict: '',
              brandName: jobCard.companyName,
              brandScaleName: '',
              brandIndustry: detailRes.brandIndustry,
              companyInfo: detailRes.companyInfo,
              bossName: '',
              bossTitle: '',
              activeTimeDesc: detailRes.activeTimeDesc || jobCard.activeTimeDesc,
              skills: jobCard.skills,
              welfareList: [],
            };

            if (cfg.filter.hrActiveDaysLimit > 0 && !mockJobItem.activeTimeDesc) {
              this.log('warn', `[跳过] 无法读取招聘者活跃时间: ${jobCard.companyName} - ${jobCard.jobName}`);
              continue;
            }

            // 阶段一：硬规则过滤
            const stage1 = filterService.evaluateStage1(mockJobItem, detailRes.jobDetailText, cfg.filter, exclusionText);
            if (!stage1.passed) {
              try { workConditionReviews.removeForJob(jobCard.jobHref); } catch {}
              this.stats.localDecisionCount = (this.stats.localDecisionCount || 0) + 1;
              this.log('info', `[初筛淘汰] ${mockJobItem.brandName} - ${jobCard.jobName}: ${stage1.reason}`);
              const marked = await bossPageService.isCardStillTarget(cardLocator, jobCard.jobName, jobCard.companyName, jobCard.jobHref)
                && await bossPageService.markJobNotSuit(cardLocator, jobCard, stage1.reason);
              if (marked) this.stats.markedNotSuitCount++;
              this.emit();
              continue;
            }

            if (detailRes.alreadyChatted) {
              try { workConditionReviews.removeForJob(jobCard.jobHref); } catch {}
              this.log('info', `[已沟通跳过] 该岗位此前已在沟通中: ${mockJobItem.brandName} - ${jobCard.jobName}`);
              continue;
            }

            if (!detailRes.chatButtonLocator) {
              this.log('warn', `[无法开聊] 未找到有效沟通按钮: ${mockJobItem.brandName} - ${jobCard.jobName}`);
              continue;
            }

            const candidate: PendingCandidate = { jobCard: { ...jobCard, cardLocator }, job: mockJobItem, jobDetail: detailRes.jobDetailText, detail: detailRes };
            const local = filterService.evaluateLocally(mockJobItem, detailRes.jobDetailText, params.rulesOnly === true && params.candidateSource === 'requirements', cfg.filter, exclusionText);
            if (local) {
              await processEvaluation(candidate, local, false);
            } else {
              pending.push(candidate);
              this.stats.pendingEvaluationCount = pending.length;
              this.log('info', '[初筛暂存 ' + pending.length + '/' + aiBatchSize + '] ' + jobCard.companyName + ' - ' + jobCard.jobName);
              if (pending.length >= aiBatchSize) await flushEvaluations();
            }
            if (this.stats.status === 'finished') return;
            if (this.isStopRequested) break;
          }

          if (this.isStopRequested) break;
          // Flush the final short batch before scrolling away from its cards.
          await flushEvaluations();
          if (this.stats.status === 'finished') return;

          // 如果本轮没发现新岗位，尝试向下滚动加载更多
          if (newlyFoundInThisBatch === 0) {
            noNewJobScrollAttempts++;
            this.log('info', `[DOM] 正在向下滑动以加载更多职位数据...`);
            await bossPageService.scrollDownForMore();
          } else {
            noNewJobScrollAttempts = 0;
          }
        }
      }

      if (stoppedByUser || this.isStopRequested) {
        this.stats.status = 'idle';
        this.stats.currentProcessingJob = undefined;
        this.log('info', `🛑 投递任务已按你的要求停止（今日累计已开聊 ${this.stats.todayAppliedCount} 家）`);
      } else {
        this.stats.currentProcessingJob = undefined;
        this.log('success', `🎉 本轮所有指定关键词与岗位扫描已顺利完成！`);
        this.stats.status = 'finished';
      }
      this.emit();
    } catch (err: any) {
      this.stats.currentProcessingJob = undefined;
      this.log(this.isStopRequested ? 'info' : 'error', this.isStopRequested ? '投递任务已停止' : `DOM 投递主循环异常中断: ${err.message}`);
      this.stats.status = this.isStopRequested ? 'idle' : 'failed';
      this.emit();
    } finally {
      this.isTaskActive = false;
      this.stats.pendingEvaluationCount = 0;
      this.evaluationAbort = undefined;
      this.emit();
    }
  }

  /**
   * 贤者时间：批次休眠机制，模拟真人去喝水/休息，彻底瓦解频控规则
   */
  private async enterSageTime(seconds: number): Promise<void> {
    this.stats.status = 'sage_time';
    this.stats.sageTimeRemainingSeconds = seconds;
    this.log('warn', `☕【贤者时间启动】已连续开聊一批岗位，模拟真人离开休息 ${seconds} 秒，深度防风控（可随时点【停止任务】中止）...`);

    const completed = await this.sleepInterruptible(seconds * 1000, (remaining) => {
      this.stats.sageTimeRemainingSeconds = remaining;
      if (remaining % 15 === 0 || remaining <= 5) this.emit();
    });

    this.stats.sageTimeRemainingSeconds = undefined;
    this.stats.status = 'running';
    if (completed) {
      this.log('info', `☕ 贤者时间结束，精神饱满地恢复投递！`);
    }
  }

  /**
   * 遭遇滑块验证码时的挂起与人机协作处理
   */
  private async handleCaptcha(): Promise<void> {
    this.stats.needsCaptchaVerification = true;
    this.stats.isPaused = true;
    this.stats.status = 'paused';
    this.log('error', `🚨 触发风控滑块验证码！已自动置顶唤醒 Chrome 窗口。请顺手在浏览器中完成滑块验证，完成后点击【我已完成验证】或等待系统自动恢复（也可直接点【停止任务】放弃）。`);

    try {
      const page = await browserService.getWorkerPage();
      await page.bringToFront();
    } catch {}

    // 阻塞等待用户解决滑块 —— 每轮都检查停止标志，避免用户放弃后任务永久空转
    while (this.stats.needsCaptchaVerification && !this.isStopRequested) {
      await new Promise((r) => setTimeout(r, 2000));
      const stillHasCaptcha = await browserService.checkCaptcha();
      if (!stillHasCaptcha && this.stats.needsCaptchaVerification) {
        this.log('success', `检测到滑块验证已完成，自动恢复投递流程！`);
        this.resume();
        break;
      }
    }
  }
}

export const deliveryService = new DeliveryService();
