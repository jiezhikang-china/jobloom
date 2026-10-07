/** Internal scheduling policy, informed by geekgeekrun's business checkpoints.
 * DOM actions share a queue; source/list/detail/feedback/submit count toward the long break.
 * These are application limits, not platform-published safe thresholds.
 */
export const bossOperationPolicy = Object.freeze({
  intervalMs: 2000, burst: 0, businessBurst: 100, restMs: 15 * 60000, feedbackMs: 15000,
  maxPerMinute: 12, maxPerHour: 240,
  selectionMinMs: 8000, selectionMaxMs: 18000, aiBatchMaxWaitMs: 90000,
});
