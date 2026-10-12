import type { FollowupContact, FollowupSettings, FollowupAction } from './followup-types.js';
export const shanghaiDay = (time: number) => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
export function inFollowupWindow(settings: FollowupSettings, now: number): boolean {
  const hour = new Date(now + 8 * 3600000).getUTCHours();
  return hour >= settings.startHour && hour < settings.endHour;
}
export interface FollowupDecision { action?: Pick<FollowupAction, 'kind' | 'text' | 'basis' | 'conversationId'>; close?: boolean; nextStep?: string; }
export function decideFollowup(contact: FollowupContact, settings: FollowupSettings, now: number): FollowupDecision {
  if (contact.status === 'closed' || contact.status === 'uncertain' || !contact.conversationId
    || contact.actions.some(a => ['sending', 'uncertain', 'queued'].includes(a.state))) return {};
  const incoming = contact.messages.at(-1)?.direction === 'incoming' ? contact.messages.at(-1)! : undefined;
  if (incoming && !/[?？]|吗|么|是否|能否|不是不|并非不/.test(incoming.text) && /暂不招聘|已招满|岗位已关闭|已停止招聘|不合适|不考虑|暂不考虑|祝.{0,8}找到/.test(incoming.text)) return { close: true, nextStep: '招聘方已明确结束沟通' };
  if (contact.messages.at(-1)?.direction === 'outgoing' && contact.messages.at(-1)?.confirmed === false) return { nextStep: '最近一条消息尚未确认发送成功，请在 BOSS 会话中查看。' };
  const actionable = contact.requirements.filter(r => r.enabled && r.policy !== 'preference');
  const failed = contact.assessment.filter(a => a.status === 'not_met' && actionable.some(r => r.id === a.requirementId));
  if (incoming && failed.length) return { close: true, nextStep: '招聘方说明工作条件不符：' + failed.map(a => a.text + '（' + a.evidence + '）').join('；') };
  const answered = (basis: string) => contact.actions.some(a => a.basis === basis && a.state !== 'cancelled');
  if (incoming && /面试|电话|微信|联系方式|发.{0,6}(简历|作品)|提供.{0,6}(简历|作品)|薪资期望|期望薪资/.test(incoming.text)) {
    return { nextStep: '招聘方提出面试、资料或联系方式要求，请查看原文处理。' };
  }
  if (!settings.enabled || !inFollowupWindow(settings, now)) return {};
  if (incoming) {
    const basis = 'reply:' + incoming.id;
    if (settings.autoAnswerFacts && !answered(basis) && /[?？]|吗|么|请问|是否|能否|什么时候|多久|哪里/.test(incoming.text)) {
      const facts = settings.facts.filter(f => f.keywords.some(k => incoming.text.includes(k)));
      if (facts.length === 1) return { action: { kind: 'fact', text: facts[0].answer, basis, conversationId: contact.conversationId } };
      if (facts.length > 1) return { nextStep: '回复命中多条事实规则，请确认如何回答。' };
    }
    if (actionable.length && actionable.every(r => contact.assessment.some(a => a.requirementId === r.id && a.status === 'met'))) return { nextStep: '招聘方已说明工作条件符合，可以推进面试安排。' };
    return { nextStep: '招聘方已回复，请查看对话；没有匹配的已授权事实回答。' };
  }
  const missing = actionable.filter(r => !contact.assessment.some(a => a.requirementId === r.id && a.status !== 'unknown'));
  if (settings.askConditions && missing.length && !contact.actions.some(a => a.kind === 'conditions' && a.state !== 'cancelled') && now - contact.lastOutgoingAt >= 5 * 60000) {
    const text = '您好，想确认这个岗位是否满足：' + missing.map(r => r.text).join('；') + '。能否说明实际安排？谢谢。';
    if (text.length > 1000) return { nextStep: '工作条件过长，请精简后询问。' };
    return { action: { kind: 'conditions', text, basis: 'conditions', conversationId: contact.conversationId } };
  }
  const sent = contact.actions.filter(a => a.kind === 'followup' && ['sent', 'sending', 'uncertain'].includes(a.state));
  if (sent.length >= settings.maxFollowups || now - contact.lastOutgoingAt < settings.intervalHours * 3600000) return {};
  return { action: { kind: 'followup', text: settings.template.replaceAll('{job}', contact.jobName).replaceAll('{company}', contact.companyName),
    basis: 'followup:' + sent.length, conversationId: contact.conversationId } };
}
