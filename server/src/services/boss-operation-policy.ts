/** Internal stage pacing; all pages share one queue.
 * Business checkpoints follow the geekgeekrun reference, not individual UI clicks.
 * These timings are local scheduling choices, not platform safe thresholds.
 */
export const bossOperationPolicy = Object.freeze({
  intervalMs: 1000, burst: 0, businessBurst: 100, restMs: 15 * 60000, feedbackMs: 5000,
  kindIntervalsMs: Object.freeze({ control: 1000, input: 1200, detail: 3500, navigation: 2000, source: 3000, list: 5000, route: 2000 }),
  submitIntervalMs: 2500, aiBatchMaxWaitMs: 90000,
});
