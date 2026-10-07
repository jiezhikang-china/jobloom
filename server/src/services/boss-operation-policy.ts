/** Internal stage pacing; all pages share one queue.
 * Business checkpoints follow the geekgeekrun reference, not individual UI clicks.
 * These timings are local scheduling choices, not platform safe thresholds.
 */
export const bossOperationPolicy = Object.freeze({
  intervalMs: 500, burst: 0, businessBurst: 100, restMs: 15 * 60000, feedbackMs: 3000,
  kindIntervalsMs: Object.freeze({ detail: 3000, navigation: 1500, source: 2500, list: 5000, route: 2000 }),
  submitIntervalMs: 1000, aiBatchMaxWaitMs: 90000,
});
