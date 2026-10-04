/** Internal scheduling policy. Configuration/API callers cannot override platform protection.
 * Reference: geekgeekrun/geekgeekrun, cumulative work followed by a 15-minute break.
 * Our counter covers ALL native DOM actions, so its numeric budget is deliberately different.
 */
export const bossOperationPolicy = Object.freeze({
  intervalMs: 2000, burst: 60, restMs: 15 * 60000, feedbackMs: 15000,
  maxPerMinute: 12, maxPerHour: 240, writesPerHour: 10,
  selectionMinMs: 8000, selectionMaxMs: 18000,
});
