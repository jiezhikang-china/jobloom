import './isolated-browser-profile.js';
import { BossAutomationSafety, bossAutomationSafety } from '../../src/services/boss-automation-safety.js';
import { workConditionReviews } from '../../src/services/work-condition-reviews.js';
import { candidateLedger, CandidateLedger } from '../../src/services/candidate-ledger.js';
import { followupStore } from '../../src/services/followup-store.js';

let offlineCandidates = new CandidateLedger(null);
export function resetOfflineCandidates(): void { offlineCandidates = new CandidateLedger(null); }

/** Offline fixtures never clear or overwrite the real account's durable stop state. */
export function isolateBossSafety(): () => void {
  const fixture = new BossAutomationSafety(null);
  const restores: Array<() => void> = [];
  for (const key of ['list', 'listEligible', 'remove', 'removeForJob'] as const) {
    const original = workConditionReviews[key];
    (workConditionReviews as any)[key] = () => key === 'list' || key === 'listEligible' ? [] : undefined;
    restores.push(() => { (workConditionReviews as any)[key] = original; });
  }
  resetOfflineCandidates();
  for (const key of ['list', 'get', 'discover', 'transition', 'shouldProcess', 'recoverable', 'migrateTechnical', 'sourceMetrics', 'summary', 'saveEvaluation', 'cachedEvaluation'] as const) {
    const original = candidateLedger[key];
    (candidateLedger as any)[key] = (...args: any[]) => (offlineCandidates[key] as any)(...args);
    restores.push(() => { (candidateLedger as any)[key] = original; });
  }
  const recordContact = followupStore.recordContact;
  followupStore.recordContact = () => 'offline-fixture';
  restores.push(() => { followupStore.recordContact = recordContact; });
  for (const key of ['status', 'assertAllowed', 'halt', 'confirmRecovery'] as const) {
    const original = bossAutomationSafety[key];
    (bossAutomationSafety as any)[key] = (...args: any[]) => (fixture[key] as any)(...args);
    restores.push(() => { (bossAutomationSafety as any)[key] = original; });
  }
  return () => { for (const restore of restores.reverse()) restore(); };
}
