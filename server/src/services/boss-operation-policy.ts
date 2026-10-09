import { bossRecordedPace } from './boss-recorded-pace.js';
/** Internal pacing from the user's DOM trace; all pages share one queue.
 * Observed timings are scheduling inputs, not platform safety thresholds.
 * Unobserved workflows retain their existing intervals.
 */
export const bossOperationPolicy = Object.freeze({
  intervalMs: bossRecordedPace.minimumActionIntervalMs, intervalsFromStart: true,
  burst: 0, businessBurst: 100, restMs: 15 * 60000, feedbackMs: 5000,
  kindIntervalsMs: Object.freeze({ control: 1000, input: 1200, navigation: 2000, source: 3000, list: 5000, route: 2000 }),
  kindStartIntervalsMs: Object.freeze({ detail: bossRecordedPace.selectionIntervalsMs }),
  companyInspectionMs: 3000,
  pointerHoldMs: bossRecordedPace.pointerHoldMs ?? 104,
  confirmIntervalMs: 600, submitIntervalMs: 2500, aiBatchMaxWaitMs: 90000,
});
