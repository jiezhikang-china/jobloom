export interface AppConfig {
  llm: {
    connectionMode?: 'api' | 'deepseek-web';
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens?: number;
    timeoutMs?: number;
    thinking?: 'enabled' | 'disabled';
    webSearch?: boolean;
    minRequestIntervalSeconds?: number;
    jobBatchSize?: number;
  };
  filter: {
    cityCode: string;
    cityName: string;
    salaryMin?: number;
    salaryMax?: number;
    experience: string[];
    experienceMatchMode?: 'flexible' | 'strict';
    skipMissingCompanyIntro?: boolean;
    skipVagueJobDescription?: boolean;
    degree: string[]; // 用户最高学历，0 或 1 项
    hrActiveDaysLimit: number;
    companyBlacklist: string[];
    requiredKeywords: string[];
    minLlmMatchScore: number;
    workRequirements?: WorkRequirement[];
  };
  delivery: {
    jobSource?: 'saved_expectations' | 'search';
    dailyMaxQuota: number;
    minDelaySeconds: number;
    maxDelaySeconds: number;
  };
  targetPosition?: BossPositionSelection;
}

export interface WorkRequirement {
  id: string;
  text: string;
  enabled: boolean;
  builtin?: 'eightHours' | 'doubleRest' | 'noExperience';
}
export interface ConditionEvidence { status: 'met' | 'not_met' | 'unknown'; evidence: string; }
export interface WorkRequirementAssessment extends ConditionEvidence { requirementId: string; text: string; }
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
    companyInfo?: { url: string; name: string; industry: string; introduction: string; businessScope: string; checkedAt: string };
    needsCompanyConfirmation?: boolean;
    taskExclusions?: Array<{ term: string; literal: boolean }>;
  };
  question: string;
  updatedAt: string;
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
  categories: BossPositionNode[];
  positionCount: number;
  stale?: boolean;
  warning?: string;
}

export interface ModelPreset {
  connectionMode?: 'api' | 'deepseek-web';
  id: string;
  name: string;
  badge: string;
  baseUrl: string;
  model: string;
  applyUrl: string;
  description: string;
}

export interface CareerRecommendation {
  positionCode?: string;
  roleTitle: string;
  matchScore: number;
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
  quotaDate?: string;
  totalScanned: number;
  passedFilterCount: number;
  markedNotSuitCount: number;
  skippedByLlmErrorCount: number;
  localDecisionCount?: number;
  aiRequestCount?: number;
  cachedEvaluationCount?: number;
  pendingEvaluationCount?: number;
  currentProcessingJob?: string;
}
