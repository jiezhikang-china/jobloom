import fs from 'fs';
import path from 'path';
import { AppConfig } from '../types.js';
import { sanitizeApiKey } from './credentials.js';
import { normalizeCandidateDegrees } from '../services/education.js';
import { normalizeWorkRequirements } from '../services/work-requirements.js';
import { normalizeCommuteFilter } from '../services/commute.js';

const CONFIG_FILE_PATH = path.resolve(process.cwd(), '../data/config.json');

export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
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

export const FREE_MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'deepseek-web-flash', connectionMode: 'deepseek-web',
    name: 'DeepSeek 网页', badge: '使用已登录账号',
    baseUrl: '', model: 'deepseek-v4-flash', applyUrl: 'https://github.com/xiaoY233/Chat2API',
    description: '使用已接入的 Chat2API DeepSeek 协议。手动登录网页一次后自动保存，单账号按顺序处理，适合个人少量使用。',
  },
];

const DEFAULT_CONFIG: AppConfig = {
  llm: {
    connectionMode: 'deepseek-web',
    baseUrl: '',
    apiKey: '',
    model: 'deepseek-v4-flash',
    temperature: 0.7,
    maxTokens: 16384,
    timeoutMs: 210000,
    thinking: 'disabled',
    webSearch: false,
    minRequestIntervalSeconds: 30,
    jobBatchSize: 5,
  },
  filter: {
    cityCode: '101010100', // 默认北京
    cityName: '北京',
    salaryMin: 15,
    salaryMax: 40,
    experience: [],
    experienceMatchMode: 'flexible',
    skipMissingCompanyIntro: true,
    skipVagueJobDescription: true,
    degree: ['本科'],
    candidateLanguages: '',
    hrActiveDaysLimit: 3,
    companyBlacklist: [
      '外包', '人力资源', '劳务派遣', '中软国际', '软通动力', '法本信息',
      '文思海辉', '博彦科技', '诚迈科技', '信华信', '易宝软件', '拓保软件'
    ],
    requiredKeywords: [],
    minLlmMatchScore: 75,
    workRequirements: [],
  },
  delivery: {
    jobSource: 'saved_expectations',
    dailyMaxQuota: 80,
    minDelaySeconds: 8,
    maxDelaySeconds: 18,
    operationIntervalSeconds: 2,
    operationBurstLimit: 20,
    operationRestSeconds: 20,
    feedbackIntervalSeconds: 15,
    operationMaxPerMinute: 12,
    operationMaxPerHour: 240,
    writeMaxPerHour: 10,
  },
};

export class ConfigManager {
  private config: AppConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  public getConfig(): AppConfig {
    return { ...this.config };
  }

  public updateConfig(partial: Partial<AppConfig>): AppConfig {
    this.config = this.normalize({
      ...this.config,
      ...partial,
      llm: { ...this.config.llm, ...(partial.llm || {}) },
      filter: { ...this.config.filter, ...(partial.filter || {}) },
      delivery: { ...this.config.delivery, ...(partial.delivery || {}) },
    });
    this.saveConfig();
    return this.config;
  }

  /**
   * 统一清洗：API Key 去脏前缀、黑名单按分隔符拆分为独立关键词。
   * 历史配置里存在 "金融、房地产" 这类整串写法，不拆分会永远匹配不到公司名。
   */
  private normalize(cfg: AppConfig): AppConfig {
    const isWeb = cfg.llm?.connectionMode === 'deepseek-web';
    const cleanedKey = sanitizeApiKey(cfg.llm?.apiKey);
    const rawModel = String(cfg.llm?.model || '').trim();
    const model = /^glm-4\.7-flash$/i.test(rawModel) ? 'glm-4.7-flash' : rawModel;
    const quota = Number(cfg.delivery?.dailyMaxQuota);
    const { workConditions: legacyWorkConditions, ...filter } = cfg.filter;
    const targets = (Array.isArray(cfg.targetPositions) ? cfg.targetPositions : cfg.targetPosition ? [cfg.targetPosition] : [])
      .filter((item, index, list) => /^\d{6}$/.test(item?.code) && list.findIndex(value => value?.code === item.code) === index).slice(0, 3);
    return {
      ...cfg,
      targetPositions: targets,
      targetPosition: targets[0],
      llm: { ...cfg.llm, connectionMode: isWeb ? 'deepseek-web' : 'api',
        baseUrl: isWeb ? '' : cfg.llm.baseUrl, apiKey: isWeb ? '' : cleanedKey,
        model: isWeb ? 'deepseek-v4-flash' : model, thinking: cfg.llm?.thinking === 'enabled' ? 'enabled' : 'disabled',
        webSearch: cfg.llm?.webSearch === true,
        minRequestIntervalSeconds: boundedInteger(cfg.llm?.minRequestIntervalSeconds, 30, 10, 300),
        jobBatchSize: boundedInteger(cfg.llm?.jobBatchSize, 5, 1, 10) },
      filter: {
        ...filter,
        experienceMatchMode: filter.experienceMatchMode === 'strict' ? 'strict' : 'flexible',
        skipMissingCompanyIntro: filter.skipMissingCompanyIntro !== false,
        skipVagueJobDescription: filter.skipVagueJobDescription !== false,
        degree: normalizeCandidateDegrees(cfg.filter?.degree),
        candidateLanguages: typeof filter.candidateLanguages === 'string' ? filter.candidateLanguages.trim().slice(0, 1000) : '',
        commute: normalizeCommuteFilter(filter.commute),
        companyBlacklist: this.splitKeywords(cfg.filter?.companyBlacklist),
        requiredKeywords: this.splitKeywords(cfg.filter?.requiredKeywords),
        workRequirements: normalizeWorkRequirements(cfg.filter?.workRequirements, legacyWorkConditions),
      },
      delivery: {
        ...cfg.delivery,
        operationIntervalSeconds: boundedInteger(cfg.delivery?.operationIntervalSeconds, 2, 1, 10),
        operationBurstLimit: boundedInteger(cfg.delivery?.operationBurstLimit, 20, 5, 100),
        operationRestSeconds: boundedInteger(cfg.delivery?.operationRestSeconds, 20, 5, 300),
        feedbackIntervalSeconds: boundedInteger(cfg.delivery?.feedbackIntervalSeconds, 15, 10, 120),
        operationMaxPerMinute: boundedInteger(cfg.delivery?.operationMaxPerMinute, 12, 1, 30),
        operationMaxPerHour: boundedInteger(cfg.delivery?.operationMaxPerHour, 240, 30, 1000),
        writeMaxPerHour: boundedInteger(cfg.delivery?.writeMaxPerHour, 10, 1, 30),
        jobSource: cfg.delivery?.jobSource === 'search' ? 'search' : 'saved_expectations',
        dailyMaxQuota: Number.isFinite(quota) ? Math.max(0, Math.min(150, Math.trunc(quota))) : DEFAULT_CONFIG.delivery.dailyMaxQuota,
      },
    };
  }

  private splitKeywords(list: unknown): string[] {
    if (!Array.isArray(list)) return [];
    return list
      .flatMap((item) => String(item ?? '').split(/[，,、;；|/\s]+/))
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private loadConfig(): AppConfig {
    try {
      if (fs.existsSync(CONFIG_FILE_PATH)) {
        const data = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
        const parsed = JSON.parse(data);
        const normalized = this.normalize({
          ...DEFAULT_CONFIG,
          ...parsed,
          llm: { ...DEFAULT_CONFIG.llm, ...(parsed.llm || {}),
            connectionMode: parsed.llm?.connectionMode || (parsed.llm ? 'api' : DEFAULT_CONFIG.llm.connectionMode) },
          filter: { ...DEFAULT_CONFIG.filter, ...(parsed.filter || {}),
            workRequirements: normalizeWorkRequirements(parsed.filter?.workRequirements, parsed.filter?.workConditions) },
          delivery: { ...DEFAULT_CONFIG.delivery, ...(parsed.delivery || {}) },
        });
        if (JSON.stringify(normalized) !== JSON.stringify(parsed)) this.saveConfigDirect(normalized);
        return normalized;
      }
    } catch (err) {
      console.warn('读取配置文件失败，使用默认配置:', err);
    }
    this.saveConfigDirect(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  private saveConfig(): void {
    this.saveConfigDirect(this.config);
  }

  private saveConfigDirect(cfg: AppConfig): void {
    try {
      const dir = path.dirname(CONFIG_FILE_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
    } catch (err) {
      console.error('保存配置文件失败:', err);
    }
  }
}

export const configManager = new ConfigManager();
