import type { WorkRequirement, WorkRequirementAssessment } from '../types.js';

export interface FollowupSettings {
  enabled: boolean;
  intervalHours: number;
  maxFollowups: number;
  dailyMaxMessages: number;
  startHour: number;
  endHour: number;
  pollMinutes: number;
  askConditions: boolean;
  autoAnswerFacts: boolean;
  facts: Array<{ keywords: string[]; answer: string }>;
  template: string;
}
export interface ChatMessage {
  id: string; direction: 'incoming' | 'outgoing'; text: string;
  confirmed?: boolean; timestamp?: number; kind?: 'text' | 'card';
}
export interface ChatSnapshot { accountId: string; conversationId: string; jobHref: string; jobName: string; companyName: string; messages: ChatMessage[]; }
export interface FollowupAction {
  id: string; kind: 'followup' | 'conditions' | 'fact'; text: string;
  basis: string; conversationId: string;
  state: 'queued' | 'sending' | 'sent' | 'uncertain' | 'cancelled';
  createdAt: number; attemptedAt?: number; sentAt?: number; error?: string;
  outgoingBefore?: string[];
}
export interface FollowupContact {
  id: string; jobHref: string; jobName: string; companyName: string;
  contactedAt: number; lastOutgoingAt: number; lastIncomingAt?: number;
  conversationId?: string; status: 'waiting' | 'replied' | 'needs_user' | 'closed' | 'uncertain';
  nextStep?: string; requirements: WorkRequirement[]; assessment: WorkRequirementAssessment[];
  messages: ChatMessage[]; actions: FollowupAction[]; updatedAt: number;
}
export interface FollowupState { version: 1; accountId?: string; settings: FollowupSettings; contacts: FollowupContact[]; }
export class FollowupNotSubmittedError extends Error {
  constructor(message: string, public readonly retryNextScan = false) { super(message); this.name = 'FollowupNotSubmittedError'; }
}
export const defaultFollowupSettings: FollowupSettings = {
  enabled: false, intervalHours: 48, maxFollowups: 2, dailyMaxMessages: 10,
  startHour: 9, endHour: 18, pollMinutes: 5, askConditions: true, autoAnswerFacts: false,
  facts: [], template: '您好，想跟进一下【{job}】岗位目前是否仍在招聘？如需补充资料，欢迎告诉我。',
};

export function normalizeFollowupSettings(value: unknown): FollowupSettings {
  const raw = value as Partial<FollowupSettings> | undefined;
  const n = (key: keyof FollowupSettings, lo: number, hi: number) => {
    const v = raw?.[key];
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.trunc(v))) : Number(defaultFollowupSettings[key]);
  };
  const result: FollowupSettings = {
    enabled: raw?.enabled === true, intervalHours: n('intervalHours', 1, 720), maxFollowups: n('maxFollowups', 0, 10),
    dailyMaxMessages: n('dailyMaxMessages', 0, 150), startHour: n('startHour', 0, 23), endHour: n('endHour', 1, 24),
    pollMinutes: n('pollMinutes', 1, 120), askConditions: raw?.askConditions !== false, autoAnswerFacts: raw?.autoAnswerFacts === true,
    facts: Array.isArray(raw?.facts) ? raw.facts.slice(0, 30).filter(f => Array.isArray(f?.keywords) && typeof f?.answer === 'string')
      .map(f => ({ keywords: f.keywords.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim().slice(0, 40)).slice(0, 10), answer: f.answer.trim().slice(0, 300) }))
      .filter(f => f.keywords.length && f.answer) : [],
    template: typeof raw?.template === 'string' && raw.template.trim() ? raw.template.trim().slice(0, 300) : defaultFollowupSettings.template,
  };
  if (result.endHour <= result.startHour) throw new Error('发送结束时段须晚于开始时段');
  return result;
}
