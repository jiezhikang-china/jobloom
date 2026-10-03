export interface AppConfig {
  llm: {
    connectionMode?: 'api' | 'deepseek-web';
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    /** 单次请求最大输出 token，默认 16384；遇到 provider 上限报错会自动降级重试 */
    maxTokens?: number;
    /** 单次请求超时（毫秒），默认 120000 */
    timeoutMs?: number;
    /** GLM 官方接口 / DeepSeek 网页深度思考开关；默认关闭。 */
    thinking?: 'enabled' | 'disabled';
    /** DeepSeek 网页联网搜索；与深度思考独立，默认关闭。 */
    webSearch?: boolean;
    /** Time from the previous webpage response to the next request. */
    minRequestIntervalSeconds?: number;
    /** Jobs evaluated together after local filtering. */
    jobBatchSize?: number;
  };
  filter: {
    cityCode: string; // 城市代码，如 101010100 (北京), 101020100 (上海), 101280100 (广州), 101280600 (深圳), 101210100 (杭州)
    cityName: string;
    salaryMin?: number;
    salaryMax?: number;
    experience: string[]; // ['应届生', '1-3年', '3-5年', '5-10年']
    experienceMatchMode?: 'flexible' | 'strict'; // 默认宽泛，经验标签仅供参考；严格模式使用标签范围
    skipMissingCompanyIntro?: boolean;
    skipVagueJobDescription?: boolean;
    degree: string[]; // 用户最高学历，0 或 1 项；空数组不限制，岗位按最低门槛比较
    candidateLanguages?: string; // 用户声明的语言、水平、证书和口音能力；不是岗位需求
    commute?: CommuteFilter;
    hrActiveDaysLimit: number; // 3天内活跃为 3；<=0 表示不限制
    companyBlacklist: string[]; // 公司、行业、岗位与明确业务职责的排除词
    requiredKeywords: string[]; // 职位名称、技能标签或完整 JD 命中任意一个才进入 AI 评估
    minLlmMatchScore: number; // 默认 75 分
    workRequirements?: WorkRequirement[];
    /** Legacy settings, migrated to the editable requirements list. */
    workConditions?: WorkConditions;
  };
  delivery: {
    jobSource?: 'saved_expectations' | 'search';
    dailyMaxQuota: number; // 每日最大投递数，0~150；0 表示停止自动投递
    minDelaySeconds: number; // 最小等待秒数，默认 8
    maxDelaySeconds: number; // 最大等待秒数，默认 20
  };
  targetPosition?: BossPositionSelection;
  targetPositions?: BossPositionSelection[];
}

export interface WorkConditions {
  eightHours: boolean;
  doubleRest: boolean;
  noExperience: boolean;
}
export type ConditionStatus = 'met' | 'not_met' | 'unknown';
export interface ConditionEvidence { status: ConditionStatus; evidence: string; }
export type WorkConditionAssessment = Record<keyof WorkConditions, ConditionEvidence>;
export interface WorkRequirement {
  id: string;
  text: string;
  enabled: boolean;
  builtin?: keyof WorkConditions;
}
export interface WorkRequirementAssessment extends ConditionEvidence {
  requirementId: string;
  text: string;
}
export interface WorkConditionReview {
  id: string;
  jobHref: string;
  jobName: string;
  companyName: string;
  salary: string;
  reason: string;
  requirements: WorkRequirement[];
  assessment: WorkRequirementAssessment[];
  screening?: {
    industry: string;
    jobDetail: string;
    skills: string[];
    companyInfo?: BossCompanyInfo;
    needsCompanyConfirmation?: boolean;
    needsDetailConfirmation?: boolean;
    needsEvaluationConfirmation?: boolean;
    taskExclusions?: Array<{ term: string; literal: boolean }>;
    languageEvidence?: string;
    workAddress?: BossWorkAddress;
    commute?: JobCommute;
    needsCommuteConfirmation?: boolean;
  };
  question: string;
  updatedAt: string;
  evaluationSource?: 'rules' | 'ai' | 'cache';
  score?: number;
}

/** Coordinates from the same BOSS map; never mix with raw GPS/another provider. */
export interface BossMapPoint { longitude: number; latitude: number; coordinateSystem: 'boss' | 'gcj02' | 'bd09'; }
export interface CommuteOrigin extends BossMapPoint { name: string; address: string; cityName: string; query: string; source?: 'boss' | 'amap' | 'baidu' | 'manual'; }
export interface LocationApiConfig { provider: 'boss' | 'amap' | 'baidu'; apiKey?: string; }
export interface CommuteFilter { origin?: CommuteOrigin; maxDistanceKm?: number; maxTransitMinutes?: number; locationApi?: LocationApiConfig; }
export interface BossWorkAddress { address: string; point?: BossMapPoint; }
export interface JobCommute {
  origin: CommuteOrigin;
  destination: BossWorkAddress;
  distanceKm?: number;
  transitMinutes?: number;
  transitSummary?: string;
  transitStatus: 'ok' | 'unknown' | 'not_requested';
  transitReason?: string;
  checkedAt: string;
}

export interface BossPositionNode {
  code: string;
  name: string;
  children: BossPositionNode[];
}

export interface BossPositionSelection {
  code: string;
  name: string;
  categoryCode: string;
  categoryName: string;
  subcategoryCode: string;
  subcategoryName: string;
}

export interface BossPositionCatalog {
  fetchedAt: string;
  sourceUrl: string;
  cityCode: string;
  categories: BossPositionNode[];
  positionCount: number;
  stale?: boolean;
  warning?: string;
}

export interface CareerRecommendation {
  positionCode?: string;
  roleTitle: string;
  matchScore: number; // 0-100
  recommendedReason: string;
  advantages: string[];
  gapAdvice: string[];
  keywords: string[];
}

export interface ResumeAnalysisResult {
  candidateName?: string;
  summary: string;
  coreSkills: string[];
  recommendations: CareerRecommendation[];
}

export interface TailoredResumeResult {
  targetRole: string;
  rewrittenResumeMarkdown: string;
  topHighlights: string[];
  defaultGreetingPitch: string;
}

export interface BossCompanyInfo {
  url: string;
  name: string;
  industry: string;
  introduction: string;
  businessScope: string;
  checkedAt: string;
}

export interface BossJobItem {
  securityId: string;
  jobId: string;
  jobName: string;
  lid: string;
  salaryDesc: string;
  jobExperience: string;
  jobDegree: string;
  cityName: string;
  areaDistrict: string;
  businessDistrict?: string;
  brandName: string;
  brandScaleName: string;
  brandIndustry: string;
  companyInfo?: BossCompanyInfo;
  workAddress?: BossWorkAddress;
  commute?: JobCommute;
  bossName: string;
  bossTitle: string;
  activeTimeDesc: string; // 如 "刚刚活跃", "今日活跃", "3日内活跃", "本月活跃"
  skills: string[];
  welfareList: string[];
  hasApplied?: boolean;
}

export interface JobFilterResult {
  job: BossJobItem;
  passedStage1: boolean;
  stage1Reason?: string;
  llmScore?: number;
  passedStage2: boolean;
  stage2Reason?: string;
  customGreeting?: string;
}

export interface DeliveryLogItem {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  jobName?: string;
  companyName?: string;
  score?: number;
}

export interface DeliveryStats {
  status: 'idle' | 'running' | 'paused' | 'cool_down' | 'sage_time' | 'finished' | 'failed';
  isPaused: boolean;
  needsCaptchaVerification: boolean;
  coolDownUntil?: string;
  sageTimeRemainingSeconds?: number;
  todayAppliedCount: number;
  dailyMaxQuota: number;
  quotaDate?: string; // 计数所属自然日，跨天自动归零
  totalScanned: number;
  passedFilterCount: number;
  markedNotSuitCount: number;
  skippedByLlmErrorCount: number; // 因大模型不可用而跳过的岗位数
  localDecisionCount?: number;
  aiRequestCount?: number;
  cachedEvaluationCount?: number;
  pendingEvaluationCount?: number;
  currentProcessingJob?: string;
  targetRoles?: string[];
  phase?: 'planning' | 'configuring' | 'screening' | 'evaluating' | 'delivering';
}
