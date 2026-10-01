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
  };
  filter: {
    cityCode: string; // 城市代码，如 101010100 (北京), 101020100 (上海), 101280100 (广州), 101280600 (深圳), 101210100 (杭州)
    cityName: string;
    salaryMin?: number;
    salaryMax?: number;
    experience: string[]; // ['应届生', '1-3年', '3-5年', '5-10年']
    degree: string[]; // 用户最高学历，0 或 1 项；空数组不限制，岗位按最低门槛比较
    hrActiveDaysLimit: number; // 3天内活跃为 3；<=0 表示不限制
    companyBlacklist: string[]; // 外包、劳务、人力资源、某某中介
    requiredKeywords: string[]; // 职位名称、技能标签或完整 JD 命中任意一个才进入 AI 评估
    minLlmMatchScore: number; // 默认 75 分
  };
  delivery: {
    dailyMaxQuota: number; // 每日最大投递数，0~150；0 表示停止自动投递
    minDelaySeconds: number; // 最小等待秒数，默认 8
    maxDelaySeconds: number; // 最大等待秒数，默认 20
  };
  targetPosition?: BossPositionSelection;
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
  currentProcessingJob?: string;
}
