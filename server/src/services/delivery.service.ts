import { boundedInteger, configManager } from '../config/config.manager.js';
import { stateManager, todayStr } from '../config/state.manager.js';
import { bossPageService, DOMJobCardInfo, type ChatResult } from './boss.page.service.js';
import { filterService, Stage2Result } from './filter.service.js';
import { browserService } from './browser.service.js';
import { workConditionReviews } from './work-condition-reviews.js';
import { exclusionsFromText, findJobExclusion, needsCompanyIndustry } from './job-exclusions.js';
import { jobInformationIssue } from './job-information.js';
import { configuredWorkRequirements, hasEntryLevelRequirement } from './work-requirements.js';
import { bossExpectationsService } from './boss-expectations.js';
import { planTargetPositions } from './target-planner.js';
import { languageQualificationIssue, candidateLanguageEvidence } from './language-qualification.js';
import { jobCommuteService } from './job-commute.service.js';
import { commuteDecision } from './commute.js';
import { evaluationRetrySeconds } from './ai-retry.js';
import { normalizedJobName, sameJobLink } from './job-identity.js';
import { notSuitableStore } from './not-suitable-store.js';
import { DeliveryStats, DeliveryLogItem, BossJobItem, BossPositionSelection, WorkConditionReview, AppConfig } from '../types.js';

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
  private evaluationAbort?: AbortController;
  private nextSelectionAt = 0;

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

  /** Rate browsing at selection time; reading and AI time count toward the interval. */
  private async paceJobSelection(delivery: AppConfig['delivery']): Promise<boolean> {
    const remaining = Math.max(0, this.nextSelectionAt - Date.now());
    if (remaining > 0) {
      this.log('info', '[浏览间隔] ' + (remaining / 1000).toFixed(1) + ' 秒后选择下一岗位');
      if (!(await this.sleepInterruptible(remaining))) return false;
    }
    while (this.stats.isPaused && !this.isStopRequested) await new Promise(resolve => setTimeout(resolve, 250));
    if (this.isStopRequested) return false;
    const min = Math.max(0, delivery.minDelaySeconds);
    const max = Math.max(min, delivery.maxDelaySeconds);
    this.nextSelectionAt = Date.now() + (min + Math.random() * (max - min)) * 1000;
    return true;
  }

  private recordConfirmedChat(target: { jobHref: string; jobName: string; companyName: string }, result: ChatResult): void {
    this.stats.todayAppliedCount++;
    this.persistQuota();
    try { workConditionReviews.removeForJob(target.jobHref); }
    catch { this.log('warn', '已沟通，但移除旧的待确认记录失败，请刷新列表。'); }
    if (result.continued) this.log('info', '[已继续沟通] ' + target.companyName + ' - ' + target.jobName);
    if (result.continuationFailed) {
      throw new Error('已确认向「' + target.companyName + ' - ' + target.jobName + '」发送消息并计入配额，但“继续沟通”未完成；请处理当前弹窗后继续，勿重复投递');
    }
  }

  /** User-selected review applications share the same task lock, quota and verified send flow. */
  public async startReviewDelivery(reviews: WorkConditionReview[]): Promise<void> {
    if (this.isTaskActive) throw new Error('投递任务已经在运行中');
    this.isTaskActive = true;
    this.isStopRequested = false;
    this.nextSelectionAt = 0;
    this.ensureQuotaFresh();
    const cfg = configManager.getConfig();
    this.stats = { status: 'running', isPaused: false, needsCaptchaVerification: false, todayAppliedCount: this.stats.todayAppliedCount,
      quotaDate: this.stats.quotaDate, dailyMaxQuota: cfg.delivery.dailyMaxQuota, totalScanned: 0, passedFilterCount: 0,
      markedNotSuitCount: 0, skippedByLlmErrorCount: 0, localDecisionCount: 0, aiRequestCount: 0, pendingEvaluationCount: 0,
      phase: 'delivering', targetRoles: ['待确认岗位'] };
    this.log('info', '[手动投递] 已选择 ' + reviews.length + ' 个待确认岗位，逐个复核后投递');
    try {
      for (const review of reviews) {
        this.ensureQuotaFresh();
        if (this.isStopRequested) break;
        if (this.stats.todayAppliedCount >= cfg.delivery.dailyMaxQuota) {
          this.log('warn', '今日投递已达预设配额上限，尚未投递的待确认记录已保留'); break;
        }
        if (!(await this.paceJobSelection(cfg.delivery))) break;
        if (!workConditionReviews.listEligible(cfg.filter).some(item => item.id === review.id)) {
          this.log('warn', '[手动跳过] 记录已移除或不符合排除条件：' + review.companyName + ' - ' + review.jobName); continue;
        }
        this.stats.currentProcessingJob = review.companyName + ' - ' + review.jobName;
        this.stats.totalScanned++; this.emit();
        await browserService.withReviewApplication(review.jobHref, async page => {
          const detail = await bossPageService.loadReviewJob(page, review, cfg.filter);
          if (this.isStopRequested) return;
          if (JSON.stringify(configManager.getConfig().filter) !== JSON.stringify(cfg.filter)) throw new Error('筛选条件已变化，请重新选择待确认岗位投递');
          const context = { text: review.screening?.languageEvidence || '', source: 'resume' as const };
          const exclusion = findJobExclusion({ ...detail.job, jobDetail: detail.jobDetailText }, cfg.filter, '', review.screening?.taskExclusions);
          const first = filterService.evaluateStage1(detail.job, detail.jobDetailText, cfg.filter, '', context);
          const local = filterService.evaluateLocally(detail.job, detail.jobDetailText, true, cfg.filter, '', context);
          const requiredFieldsMissing = ((cfg.filter.salaryMin || cfg.filter.salaryMax) && !detail.job.salaryDesc)
            || (cfg.filter.degree.length && !detail.job.jobDegree) || (cfg.filter.cityName && !detail.job.cityName);
          if (requiredFieldsMissing) throw new Error('岗位关键筛选字段无法读取，未发起沟通');
          if (exclusion || !first.passed || (local && !local.passed && !local.needsReview)) {
            this.log('warn', '[手动淘汰] ' + review.companyName + ' - ' + review.jobName + '：' + (exclusion?.reason || first.reason || local?.reason));
            this.stats.localDecisionCount = (this.stats.localDecisionCount || 0) + 1;
            workConditionReviews.remove(review.id); return;
          }
          if (detail.alreadyChatted) {
            workConditionReviews.remove(review.id);
            this.log('info', '[已沟通跳过] ' + review.companyName + ' - ' + review.jobName); return;
          }
          await jobCommuteService.enrich(detail.job, cfg.filter, () => bossPageService.readJobTransit(review, cfg.filter.commute!.origin!,
            detail.job.workAddress!, page));
          const commute = commuteDecision(detail.job, cfg.filter);
          if (commute.status === 'unknown') {
            this.log('warn', '[手动暂未投递] ' + review.companyName + ' - ' + review.jobName + '：' + commute.reason + '；记录已保留'); return;
          }
          if (commute.status === 'failed') {
            this.log('warn', '[手动淘汰] ' + review.companyName + ' - ' + review.jobName + '：' + commute.reason);
            workConditionReviews.remove(review.id); return;
          }
          if (!detail.chatButtonLocator) throw new Error('未找到该岗位的沟通按钮');
          while (this.stats.isPaused && !this.isStopRequested) await new Promise(resolve => setTimeout(resolve, 250));
          if (this.isStopRequested) return;
          if (JSON.stringify(configManager.getConfig().filter) !== JSON.stringify(cfg.filter)) throw new Error('筛选条件已变化，请重新选择待确认岗位投递');
          this.ensureQuotaFresh();
          if (this.stats.todayAppliedCount >= cfg.delivery.dailyMaxQuota) return;
          this.stats.passedFilterCount++;
          this.log('info', '[手动投递] ' + review.companyName + ' - ' + review.jobName + '，按你的选择发起沟通');
          const result = await bossPageService.executeChatClick(detail.chatButtonLocator,
            '您好，我关注贵司的【' + review.jobName + '】岗位，希望与您交流岗位详情。', review);
          if (result.success) {
            this.recordConfirmedChat(review, result);
            this.log('success', '✅ 投递成功：' + review.companyName + ' - ' + review.jobName + '，今日累计 ' + this.stats.todayAppliedCount + ' 家');
          } else if (result.uncertain) throw new Error('已触发沟通，但尚未确认发送结果；请查看平台会话后继续，勿重复投递');
          else if (result.loginRequired) throw new Error('BOSS 登录失效，请登录后投递');
          else if (result.needCaptcha) { await this.handleCaptcha(); throw new Error('验证已处理，请重新选择尚未投递的岗位'); }
          else if (result.quotaExceeded) { this.stats.status = 'finished'; this.isStopRequested = true; this.log('warn', 'BOSS 提示沟通次数已达上限，剩余记录已保留'); }
          else if (result.isCoolDown) { this.stats.status = 'cool_down'; this.emit(); await this.sleepInterruptible(COOL_DOWN_SECONDS * 1000); throw new Error('平台频率限制已冷却，尚未投递的记录已保留'); }
          else this.log('warn', '[手动未投递] 目标岗位已变化或沟通未确认，保留记录：' + review.jobName);
        });
        this.emit();
      }
      this.stats.status = this.isStopRequested && this.stats.status !== 'finished' ? 'idle' : 'finished';
      this.log('info', '[手动投递结束] 尚未投递的岗位继续保留在待确认列表');
    } catch (error) {
      this.stats.status = this.isStopRequested ? 'idle' : 'failed';
      this.log(this.isStopRequested ? 'info' : 'error', this.isStopRequested ? '手动投递已停止' : '手动投递中断：' + (error as Error).message);
    } finally {
      this.isTaskActive = false; this.stats.currentProcessingJob = undefined; this.stats.pendingEvaluationCount = 0;
      this.stats.isPaused = false; this.stats.needsCaptchaVerification = false; this.emit();
    }
  }

  /**
   * 启动全真 DOM 拟人化自动投递主流程
   */
  public async startDelivery(params: {
    targetRole: string;
    positionCode?: string;
    targetPositions?: BossPositionSelection[];
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
    this.nextSelectionAt = 0;
    this.evaluationAbort = new AbortController();
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
      phase: 'planning',
    };

    this.log(
      'info',
      `🚀 全真 DOM 拟人化投递任务启动！目标职业: ${params.targetRole}，检索关键词: ${params.keywords.join(', ')}，城市: ${cfg.filter.cityName || '不限'}`
    );

    const processedJobKeys = new Set<string>();
    const readFailures = new Map<string, number>();
    let stoppedByUser = false;

    try {
      if (this.stats.todayAppliedCount >= this.stats.dailyMaxQuota) {
        this.log('warn', `今日投递已达预设配额上限 (${this.stats.todayAppliedCount}/${this.stats.dailyMaxQuota})`);
        this.stats.status = 'finished';
        this.emit();
        return;
      }
      const useSavedExpectations = cfg.delivery.jobSource === 'saved_expectations';
      let sources = params.keywords;
      if (useSavedExpectations) {
        let targets = params.targetPositions || [];
        if (!targets.length) {
          this.log('info', '[AI 目标规划] 根据当前简历/求职条件选择最多3个 BOSS 官方岗位');
          let retries = 0;
          while (!targets.length && !this.isStopRequested) {
            if (JSON.stringify(configManager.getConfig().filter) !== JSON.stringify(cfg.filter)) throw new Error('筛选条件已变化，请重新启动任务');
            try {
              targets = await planTargetPositions(params.resumeText, params.candidateSource || 'resume', {
                signal: this.evaluationAbort?.signal,
                beforeRequest: async () => {
                  while (this.stats.isPaused && !this.isStopRequested) await new Promise(resolve => setTimeout(resolve, 250));
                  this.evaluationAbort?.signal.throwIfAborted();
                },
                onWait: seconds => this.log('info', '[AI 间隔] 等待 ' + seconds + ' 秒后规划目标'),
                onRequest: () => { this.stats.aiRequestCount = (this.stats.aiRequestCount || 0) + 1; this.emit(); },
              });
            } catch (error) {
              this.evaluationAbort?.signal.throwIfAborted();
              const seconds = evaluationRetrySeconds(++retries, configManager.getConfig().llm.minRequestIntervalSeconds);
              this.log('warn', '[AI 目标规划等待重试] ' + (error as Error).message + '；' + seconds + ' 秒后再试，可暂停或停止');
              if (!(await this.sleepInterruptible(seconds * 1000))) break;
            }
          }
        }
        this.evaluationAbort?.signal.throwIfAborted();
        this.stats.targetRoles = targets.map(item => item.name);
        this.stats.phase = 'configuring'; this.emit();
        this.log('info', '[设置自选岗位] 正在按目标修改 BOSS 推荐旁的求职期望：' + this.stats.targetRoles.join('、'));
        const configured = await bossExpectationsService.configure(targets, { code: cfg.filter.cityCode, name: cfg.filter.cityName }, {
          signal: this.evaluationAbort?.signal, onChange: message => this.log('info', message),
        });
        this.evaluationAbort?.signal.throwIfAborted();
        await bossPageService.initJobPage();
        const saved = await bossPageService.getSavedExpectationNames();
        sources = configured.map(name => {
          const actual = saved.find(value => value.normalize('NFKC') === name.normalize('NFKC'));
          if (!actual) throw new Error('BOSS 职位页未显示已设置的目标：' + name);
          return actual;
        });
      } else this.stats.targetRoles = [params.targetRole];
      this.stats.phase = 'screening'; this.emit();
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
        const candidateContext = { text: params.resumeText, source: params.candidateSource || 'resume' as const };
        const detailOptions = { readIndustry: cfg.filter.skipMissingCompanyIntro === true || needsCompanyIndustry(cfg.filter, exclusionText), filter: cfg.filter, exclusionText, candidateContext };
        const retainDetail = (card: DOMJobCardInfo, reason: string, detail?: PendingCandidate['detail']) => {
          try {
            workConditionReviews.add({ jobHref: card.jobHref, jobName: card.jobName, companyName: card.companyName,
              salary: card.salary, reason: '详情待确认，已保留：' + reason, requirements: configuredWorkRequirements(cfg.filter), assessment: [],
              screening: { industry: detail?.brandIndustry || '', jobDetail: detail?.jobDetailText || '', skills: card.skills,
                needsDetailConfirmation: true, companyInfo: detail?.companyInfo,
                taskExclusions: exclusionsFromText(exclusionText), languageEvidence: candidateLanguageEvidence(cfg.filter.candidateLanguages, candidateContext) } });
          } catch (error) { this.log('warn', '详情待确认记录保存失败：' + (error as Error).message); }
        };
        const deferDetail = (card: DOMJobCardInfo, key: string, reason: string) => {
          const count = (readFailures.get(key) || 0) + 1; readFailures.set(key, count);
          if (count < 3) processedJobKeys.delete(key);
          else retainDetail(card, reason);
          this.log('warn', (count < 3 ? '[详情待重读 ' + count + '/2] ' : '[详情待确认·未投递] ')
            + card.companyName + ' - ' + card.jobName + '：' + reason);
        };
        const processEvaluation = async (candidate: PendingCandidate, evaluation: Stage2Result, reopen: boolean): Promise<void> => {
          const { jobCard, job: mockJobItem } = candidate;
          if (notSuitableStore.matches(jobCard.jobHref, jobCard.companyName)) return;
          if (JSON.stringify(configManager.getConfig().filter) !== JSON.stringify(cfg.filter)) {
            throw new Error('筛选条件已变化，请重新启动任务以重新评估岗位');
          }
          const exclusion = findJobExclusion({ ...mockJobItem, jobDetail: candidate.jobDetail }, cfg.filter, exclusionText);
          const informationIssue = jobInformationIssue({ jobDetail: candidate.jobDetail, companyInfo: mockJobItem.companyInfo }, cfg.filter);
          const languageIssue = languageQualificationIssue(mockJobItem, candidate.jobDetail, cfg.filter, candidateContext);
          if (exclusion || languageIssue || informationIssue) {
            evaluation = { passed: false, score: 0, customGreeting: '', reason: exclusion?.reason || languageIssue || informationIssue!, evaluationSource: 'rules' };
            try { workConditionReviews.removeForJob(jobCard.jobHref); } catch {}
          }
          const locationDecision = commuteDecision(mockJobItem, cfg.filter);
          if (!exclusion && !languageIssue && !informationIssue && locationDecision.status === 'failed') {
            evaluation = { passed: false, score: 0, customGreeting: '', reason: locationDecision.reason, evaluationSource: 'rules' };
          }
          if (evaluation.passed && locationDecision.status === 'unknown') {
            evaluation = { passed: false, score: 0, customGreeting: '', reason: locationDecision.reason, evaluationSource: 'rules',
              needsReview: true, needsCommuteConfirmation: true, requirementAssessment: [] };
          }
          let cardLocator = jobCard.cardLocator;
          let detailRes = candidate.detail;
          const sourceLabel = evaluation.evaluationSource === 'rules' ? '本地筛选' : evaluation.evaluationSource === 'cache' ? '已有评估' : 'AI评估';
          const scoreLabel = evaluation.evaluationSource === 'rules' ? '' : ' - 得分 ' + evaluation.score;
          const scoreExtra = evaluation.evaluationSource === 'rules' ? {} : { score: evaluation.score };
          if (evaluation.evaluationSource === 'rules') this.stats.localDecisionCount = (this.stats.localDecisionCount || 0) + 1;
          if (evaluation.evaluationSource === 'cache') this.stats.cachedEvaluationCount = (this.stats.cachedEvaluationCount || 0) + 1;
          // Failed evaluations are retained and retried by flushEvaluations.
          if (evaluation.llmError) {
            return;
          }

          if (evaluation.needsReview && evaluation.requirementAssessment) {
            try {
              workConditionReviews.add({
                jobHref: jobCard.jobHref, jobName: jobCard.jobName, companyName: jobCard.companyName,
                salary: jobCard.salary, reason: evaluation.reason,
                evaluationSource: evaluation.evaluationSource, ...(evaluation.evaluationSource !== 'rules' && !evaluation.responseIssue ? { score: evaluation.score } : {}),
                requirements: configuredWorkRequirements(cfg.filter), assessment: evaluation.requirementAssessment,
                screening: { industry: mockJobItem.brandIndustry, jobDetail: candidate.jobDetail, skills: mockJobItem.skills,
                  ...(mockJobItem.companyInfo ? { companyInfo: mockJobItem.companyInfo } : {}),
                  ...(evaluation.needsCompanyConfirmation ? { needsCompanyConfirmation: true } : {}),
                  ...(evaluation.responseIssue ? { needsEvaluationConfirmation: true } : {}),
                  ...(evaluation.needsCommuteConfirmation ? { needsCommuteConfirmation: true } : {}),
                  ...(mockJobItem.workAddress ? { workAddress: mockJobItem.workAddress } : {}),
                  ...(mockJobItem.commute ? { commute: mockJobItem.commute } : {}),
                  taskExclusions: exclusionsFromText(exclusionText), languageEvidence: candidateLanguageEvidence(cfg.filter.candidateLanguages, candidateContext) },
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
              sameJobLink(card.jobHref, jobCard.jobHref) && normalizedJobName(card.jobName) === normalizedJobName(jobCard.jobName)
              && normalizedJobName(card.companyName) === normalizedJobName(jobCard.companyName));
            if (!freshCard) { retainDetail(jobCard, '列表已变化，需从原岗位链接重新核对'); return; }
            if ((freshCard.salary && jobCard.salary && freshCard.salary !== jobCard.salary)
              || (freshCard.degree && jobCard.degree && freshCard.degree !== jobCard.degree)
              || (freshCard.experience && jobCard.experience && freshCard.experience !== jobCard.experience)
              || (freshCard.cityName && jobCard.cityName && freshCard.cityName !== jobCard.cityName)
              || JSON.stringify(freshCard.skills) !== JSON.stringify(jobCard.skills)) {
              processedJobKeys.delete(new URL(jobCard.jobHref, 'https://www.zhipin.com').pathname);
              retainDetail(jobCard, '岗位资料已变化，需要重新核对'); return;
            }
            cardLocator = freshCard.cardLocator;
            try { detailRes = await bossPageService.loadJobDetail(cardLocator, jobCard.jobName, jobCard.companyName, jobCard.jobHref,
              { ...detailOptions, refreshCompany: true }); }
            catch (error) {
              if (/CAPTCHA_REQUIRED/.test((error as Error).message)) { await this.handleCaptcha(); return; }
              if (/登录/.test((error as Error).message)) throw error;
              retainDetail(jobCard, '无法重新读取原岗位详情'); return;
            }
            for (const field of ['salary', 'degree', 'experience', 'cityName'] as const) {
              const actual = freshCard[field] || detailRes.cardData?.[field];
              if (actual && actual !== jobCard[field]) {
                this.log('warn', '[资料已更新] 岗位' + ({ salary: '薪资', degree: '学历', experience: '经验', cityName: '城市' }[field]) + '已变化，保留重新评估：' + jobCard.jobName);
                retainDetail(jobCard, '岗位资料已更新，需要重新评估', detailRes);
                processedJobKeys.delete(new URL(jobCard.jobHref, 'https://www.zhipin.com').pathname); return;
              }
            }
            if (detailRes.jobDetailText.replace(/\s+/g, '') !== candidate.jobDetail.replace(/\s+/g, '')
              || !(await bossPageService.isDetailStillTarget(jobCard.jobName, jobCard.companyName, jobCard.jobHref))) {
              processedJobKeys.delete(new URL(jobCard.jobHref, 'https://www.zhipin.com').pathname);
              retainDetail(jobCard, '描述或岗位身份已变化，需要重新核对'); return;
            }
            if (detailRes.alreadyChatted) { try { workConditionReviews.removeForJob(jobCard.jobHref); } catch {} return; }
            if (!detailRes.chatButtonLocator) return;
            const freshJob = { ...mockJobItem, brandIndustry: detailRes.brandIndustry,
              companyInfo: detailRes.companyInfo,
              workAddress: detailRes.workAddress, activeTimeDesc: detailRes.activeTimeDesc || freshCard.activeTimeDesc };
            await jobCommuteService.enrich(freshJob, cfg.filter, () => bossPageService.readJobTransit(jobCard, cfg.filter.commute!.origin!, freshJob.workAddress!));
            const freshLocation = commuteDecision(freshJob, cfg.filter);
            if (freshLocation.status === 'unknown') {
              await processEvaluation({ ...candidate, job: freshJob, detail: detailRes }, { ...evaluation, passed: false,
                needsReview: true, needsCommuteConfirmation: true, reason: freshLocation.reason,
                requirementAssessment: evaluation.requirementAssessment || [] }, false);
              return;
            }
            const recheck = filterService.evaluateStage1(freshJob, detailRes.jobDetailText, cfg.filter, exclusionText, candidateContext);
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
              processedJobKeys.delete(new URL(jobCard.jobHref, 'https://www.zhipin.com').pathname);
              retainDetail(jobCard, '公司业务资料已变化，需要重新评估', detailRes); return;
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
          this.stats.phase = 'delivering'; this.emit();
          const finalGreeting = evaluation.customGreeting || params.defaultGreeting;
          this.log('success', `🎯 [${sourceLabel}通过${scoreLabel}] ${mockJobItem.brandName} - ${jobCard.jobName}，准备发起沟通...`, {
            jobName: jobCard.jobName,
            companyName: jobCard.companyName,
            ...scoreExtra,
          });

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
            retainDetail(jobCard, '沟通前详情已变化，已保留原岗位等待核对');
            return;
          }
          if (JSON.stringify(configManager.getConfig().filter) !== JSON.stringify(cfg.filter)) throw new Error('筛选条件已变化，请重新启动任务');

          // 执行沟通点击与自适应弹窗注入
          if (!detailRes.chatButtonLocator) { retainDetail(jobCard, '岗位暂时没有可用沟通按钮', detailRes); return; }
          const chatResult = await bossPageService.executeChatClick(detailRes.chatButtonLocator, finalGreeting, {
            jobName: jobCard.jobName,
            companyName: jobCard.companyName,
            jobHref: jobCard.jobHref,
          });

          if (chatResult.targetChanged) {
            retainDetail(jobCard, '沟通前目标岗位已变化，原岗位已保留');
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
            this.recordConfirmedChat(jobCard, chatResult);
            if (finalGreeting && !chatResult.greetingSent && !chatResult.platformGreeting) {
              this.log('warn', `[自荐语未注入] 平台未显示打招呼输入框，沟通已建立但定制首语可能没有发送: ${jobCard.companyName} - ${jobCard.jobName}`);
            }
            this.log('success', `✅ 开聊成功: ${mockJobItem.brandName} - ${jobCard.jobName}！今日累计已开聊 ${this.stats.todayAppliedCount} 家`, {
              jobName: jobCard.jobName,
              companyName: jobCard.companyName,
              ...scoreExtra,
            });

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
          this.stats.phase = 'evaluating';
          this.log('info', '[AI 批量评估] 已攒齐 ' + candidates.length + ' 个初筛岗位，正在评估职责、资格与工作条件');
          let remaining = candidates;
          let retryAttempt = 0;
          while (remaining.length && !this.isStopRequested && this.stats.status !== 'finished') {
            while (this.stats.isPaused && !this.isStopRequested) await new Promise(resolve => setTimeout(resolve, 250));
            if (this.isStopRequested) break;
            if (JSON.stringify(configManager.getConfig().filter) !== JSON.stringify(cfg.filter)) throw new Error('筛选条件已变化，请重新启动任务');
            const evaluations = await filterService.evaluateBatch(remaining.map(item => ({
              job: item.job, jobDetail: item.jobDetail, jobHref: item.jobCard.jobHref,
            })), params.resumeText, useSavedExpectations ? keyword : params.targetRole, params.candidateSource || 'resume', {
              rulesOnly: params.rulesOnly, signal: this.evaluationAbort?.signal,
              onWait: seconds => this.log('info', '[AI 间隔] 等待 ' + seconds + ' 秒后再请求，可随时停止'),
              beforeRequest: async () => {
                while (this.stats.isPaused && !this.isStopRequested) await new Promise(resolve => setTimeout(resolve, 250));
                this.evaluationAbort?.signal.throwIfAborted();
                if (JSON.stringify(configManager.getConfig().filter) !== JSON.stringify(cfg.filter)) throw new Error('筛选条件已变化，请重新启动任务');
              },
              onRequest: () => { this.stats.aiRequestCount = (this.stats.aiRequestCount || 0) + 1; this.emit(); },
            });
            const failed: PendingCandidate[] = [];
            for (let index = 0; index < remaining.length; index++) {
              if (this.isStopRequested || this.getStats().status === 'finished') break;
              if (evaluations[index].llmError) failed.push(remaining[index]);
              else await processEvaluation(remaining[index], evaluations[index], true);
              this.stats.pendingEvaluationCount = remaining.length - index - 1 + failed.length;
              this.emit();
            }
            remaining = failed;
            if (remaining.length && !this.isStopRequested && this.getStats().status !== 'finished') {
              const seconds = evaluationRetrySeconds(++retryAttempt, configManager.getConfig().llm.minRequestIntervalSeconds);
              this.stats.phase = 'evaluating'; this.stats.pendingEvaluationCount = remaining.length;
              const reason = evaluations.find(item => item.llmError)?.reason || '请求失败';
              this.log('warn', '[AI 等待重试] ' + remaining.length + ' 个岗位已保留，第 ' + retryAttempt + ' 次重试将在 '
                + seconds + ' 秒后进行。' + reason + '；可随时暂停或停止');
              if (!(await this.sleepInterruptible(seconds * 1000))) break;
            }
          }
          this.stats.pendingEvaluationCount = 0;
          this.stats.phase = 'screening'; this.emit();
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
            if (notSuitableStore.matches(jobCard.jobHref, jobCard.companyName)) continue;
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
                deferDetail(jobCard, jobKey, '列表已重排，尚未重新定位原岗位');
                continue;
              }
              cardLocator = relocated;
            }

            // Only explicit metadata mismatches reject a card; missing fields are read from its own detail.
            if (cfg.filter.cityName && jobCard.cityName && jobCard.cityName !== cfg.filter.cityName) {
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
            }, '', cfg.filter, exclusionText, candidateContext);
            if (!cardCheck.passed) {
              try { workConditionReviews.removeForJob(jobCard.jobHref); } catch {}
              this.stats.localDecisionCount = (this.stats.localDecisionCount || 0) + 1;
              this.log('info', '[初筛淘汰] ' + jobCard.companyName + ' - ' + jobCard.jobName + '：' + cardCheck.reason);
              if (await bossPageService.isCardStillTarget(cardLocator, jobCard.jobName, jobCard.companyName, jobCard.jobHref)
                && await bossPageService.markJobNotSuit(cardLocator, jobCard, cardCheck.reason)) this.stats.markedNotSuitCount++;
              this.emit(); continue;
            }

            // 点击卡片，等待右侧载入完整 JD 与招聘者信息。
            if (!(await this.paceJobSelection(cfg.delivery))) { stoppedByUser = true; break; }
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
              deferDetail(jobCard, jobKey, message);
              if (!(await bossPageService.isJobListPage())) {
                await openList(keyword);
                break;
              }
              continue;
            }

            if (!(await bossPageService.isDetailStillTarget(jobCard.jobName, jobCard.companyName, jobCard.jobHref))) {
              deferDetail(jobCard, jobKey, '页面切换期间岗位尚未核对');
              continue;
            }

            for (const field of ['salary', 'degree', 'experience', 'cityName'] as const) {
              if (!jobCard[field] && detailRes.cardData?.[field]) jobCard[field] = detailRes.cardData[field];
            }
            const missingFields = [((cfg.filter.salaryMin || cfg.filter.salaryMax) && !jobCard.salary) && '薪资',
              (cfg.filter.degree.length && !jobCard.degree) && '学历', (cfg.filter.cityName && !jobCard.cityName) && '城市',
              (cfg.filter.experienceMatchMode === 'strict' && cfg.filter.experience.length && !hasEntryLevelRequirement(cfg.filter) && !jobCard.experience) && '经验'].filter(Boolean);
            if (missingFields.length) {
              const reason = '平台未提供可核对的' + missingFields.join('、') + '，已保留待确认';
              this.log('warn', '[资料待确认·未投递] ' + jobCard.companyName + ' - ' + jobCard.jobName + '：' + reason);
              try { workConditionReviews.add({ jobHref: jobCard.jobHref, jobName: jobCard.jobName, companyName: jobCard.companyName,
                salary: jobCard.salary, reason, requirements: configuredWorkRequirements(cfg.filter), assessment: [],
                screening: { industry: detailRes.brandIndustry, jobDetail: detailRes.jobDetailText, skills: jobCard.skills, needsDetailConfirmation: true,
                  companyInfo: detailRes.companyInfo, taskExclusions: exclusionsFromText(exclusionText),
                  languageEvidence: candidateLanguageEvidence(cfg.filter.candidateLanguages, candidateContext) } }); }
              catch (error) { this.log('warn', '待确认记录保存失败：' + (error as Error).message); }
              continue;
            }
            if (cfg.filter.cityName && jobCard.cityName !== cfg.filter.cityName) {
              this.log('info', '[初筛淘汰] ' + jobCard.jobName + '：岗位城市与目标城市不符');
              if (await bossPageService.markJobNotSuit(cardLocator, jobCard)) this.stats.markedNotSuitCount++;
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
              workAddress: detailRes.workAddress,
              bossName: '',
              bossTitle: '',
              activeTimeDesc: detailRes.activeTimeDesc || jobCard.activeTimeDesc,
              skills: jobCard.skills,
              welfareList: [],
            };

            if (cfg.filter.hrActiveDaysLimit > 0 && !mockJobItem.activeTimeDesc) {
              this.log('info', `[活跃度未知] 平台未提供招聘者活跃时间，继续核对岗位：${jobCard.companyName} - ${jobCard.jobName}`);
            }

            // 阶段一：硬规则过滤
            const stage1 = filterService.evaluateStage1(mockJobItem, detailRes.jobDetailText, cfg.filter, exclusionText, candidateContext);
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
            const beforeRoute = filterService.evaluateLocally(mockJobItem, detailRes.jobDetailText, params.rulesOnly === true && params.candidateSource === 'requirements', cfg.filter, exclusionText, candidateContext);
            if (!beforeRoute || beforeRoute.needsCommuteConfirmation) {
              await jobCommuteService.enrich(mockJobItem, cfg.filter, () => bossPageService.readJobTransit(jobCard, cfg.filter.commute!.origin!, mockJobItem.workAddress!));
              if (mockJobItem.commute) {
                const location = commuteDecision(mockJobItem, cfg.filter);
                this.log('info', '[地点核对] ' + jobCard.companyName + ' - ' + jobCard.jobName + '：' + (location.reason
                  || '直线约 ' + mockJobItem.commute.distanceKm?.toFixed(1) + ' 公里'));
              }
            }
            const local = filterService.evaluateLocally(mockJobItem, detailRes.jobDetailText, params.rulesOnly === true && params.candidateSource === 'requirements', cfg.filter, exclusionText, candidateContext);
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
