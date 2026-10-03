import type { AppConfig, BossJobItem, JobCommute } from '../types.js';
import { commuteDecision, currentCommute, validCommuteOrigin, TRANSIT_CACHE_MS } from './commute.js';
import { locationApiService } from './location-api.service.js';

export class JobCommuteService {
  private cache = new Map<string, { result: JobCommute; expires: number }>();
  public async enrich(job: BossJobItem, filter: AppConfig['filter'], readTransit: () => Promise<{ minutes: number; summary: string }>): Promise<void> {
    const cfg = filter.commute;
    if (!validCommuteOrigin(cfg?.origin)) { delete job.commute; return; }
    const result = currentCommute(cfg.origin, job.workAddress);
    job.commute = result;
    // Straight distance and an exceeded distance limit require no route request.
    if (!cfg.maxTransitMinutes || !job.workAddress?.point || commuteDecision(job, filter).status === 'failed') return;
    const key = JSON.stringify({ from: result.origin, to: result.destination, provider: cfg.locationApi?.provider || 'boss' });
    const saved = this.cache.get(key);
    if (saved && saved.expires > Date.now()) { job.commute = structuredClone(saved.result); return; }
    this.cache.delete(key);
    try {
      const route = cfg.locationApi && ['amap', 'baidu'].includes(cfg.locationApi.provider)
        ? await locationApiService.readTransit(result.origin, result.destination, cfg.locationApi, job.cityName) : await readTransit();
      if (!Number.isFinite(route.minutes) || route.minutes < 0 || route.minutes > 1440) throw new Error('地图时间无效');
      result.transitStatus = 'ok'; result.transitMinutes = route.minutes; result.transitSummary = route.summary;
    } catch (cause) {
      const reason = (cause as Error).message;
      if (/CAPTCHA_REQUIRED|登录|未关闭|正在使用/.test(reason)) throw cause;
      result.transitStatus = 'unknown'; result.transitReason = reason.slice(0, 500);
    }
    result.checkedAt = new Date().toISOString();
    this.cache.set(key, { result: structuredClone(result), expires: Date.now() + (result.transitStatus === 'ok' ? TRANSIT_CACHE_MS : 30000) });
    while (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
  }
}
export const jobCommuteService = new JobCommuteService();
