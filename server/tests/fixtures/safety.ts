import { BossAutomationSafety, bossAutomationSafety } from '../../src/services/boss-automation-safety.js';
import { followupStore } from '../../src/services/followup-store.js';

/** Offline fixtures never clear or overwrite the real account's durable stop state. */
export function isolateBossSafety(): () => void {
  const fixture = new BossAutomationSafety(null);
  const restores: Array<() => void> = [];
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
