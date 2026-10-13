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
    candidateLanguages?: string;
    commute?: CommuteFilter;
    hrActiveDaysLimit: number;
    companyBlacklist: string[];
    requiredKeywords: string[];
    minLlmMatchScore: number;
    workRequirements?: WorkRequirement[];
  };
  delivery: {
    jobSource?: 'saved_expectations' | 'search' | 'recommendation' | 'message_recommendations';
    dailyMaxQuota: number;
  };
  targetPosition?: BossPositionSelection;
  targetPositions?: BossPositionSelection[];
}

export interface WorkRequirement {
  id: string;
  text: string;
  enabled: boolean;
  builtin?: 'eightHours' | 'doubleRest' | 'noExperience';
  policy?: 'required' | 'ask' | 'preference';
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
    needsDetailConfirmation?: boolean;
    needsEvaluationConfirmation?: boolean;
    needsQualificationConfirmation?: boolean;
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
export interface CommuteOrigin extends BossMapPoint { name: string; address: string; cityName: string; query: string; source?: 'boss' | 'amap' | 'baidu' | 'manual' | 'openstreetmap'; }
export interface CommuteFilter { origin?: CommuteOrigin; maxDistanceKm?: number; }
export interface BossWorkAddress { address: string; point?: BossMapPoint; }
export interface JobCommute {
  origin: CommuteOrigin;
  destination: BossWorkAddress;
  distanceKm?: number;
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
  pdf?: ResumePdfArtifact;
}
export interface ResumeSource { id: string; fileName: string; format: string; text: string; updatedAt: string; }
export interface ResumePdfChange { id: string; page: number; before: string; after: string; }
export interface ResumePdfArtifact {
  id: string; sourceId: string; targetRole: string; fileName: string; pageCount: number; createdAt: string;
  downloadUrl: string; previewUrls: string[]; text: string; changes: ResumePdfChange[];
  bossUpload?: { attachmentId: string; fileName: string; uploadedAt: string };
}
export interface BossResumeAttachment { id: string; name: string; description: string; canReplace: boolean; }

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
  recoveryCount?: number;
  sourceMetrics?: Array<{ source: string; unique: number; details: number; passed: number; sent: number; rejected: number; recovery: number; decisions: number; yield: number }>;
  passedFilterCount: number;
  markedNotSuitCount: number;
  skippedByLlmErrorCount: number;
  localDecisionCount?: number;
  aiRequestCount?: number;
  cachedEvaluationCount?: number;
  pendingEvaluationCount?: number;
  currentProcessingJob?: string;
  targetRoles?: string[];
  phase?: 'planning' | 'configuring' | 'screening' | 'evaluating' | 'delivering';
}
