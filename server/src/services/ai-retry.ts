/** Slow repeated failures down; never retry faster than the user's minimum request interval. */
export function evaluationRetrySeconds(attempt: number, minimumInterval = 30): number {
  const base = Math.max(30, Math.min(300, Number.isFinite(minimumInterval) ? minimumInterval : 30));
  return Math.min(300, base * 2 ** Math.max(0, Math.min(4, attempt - 1)));
}
