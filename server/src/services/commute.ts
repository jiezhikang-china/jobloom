import type { AppConfig, BossMapPoint, BossWorkAddress, CommuteFilter, CommuteOrigin, JobCommute } from '../types.js';
import { convertMapPoint } from './coordinates.js';

export const TRANSIT_CACHE_MS = 10 * 60 * 1000;
const text = (v: unknown, max = 300) => typeof v === 'string' && v.length <= max;
export function isBossPoint(v: any): v is BossMapPoint {
  return ['boss', 'gcj02', 'bd09'].includes(v?.coordinateSystem) && typeof v.longitude === 'number' && Number.isFinite(v.longitude)
    && typeof v.latitude === 'number' && Number.isFinite(v.latitude)
    && v.longitude >= 70 && v.longitude <= 140 && v.latitude > 0 && v.latitude <= 60;
}
export function validCommuteOrigin(v: any): v is CommuteOrigin {
  return text(v?.name, 150) && Boolean(v.name.trim()) && text(v.address)
    && text(v.cityName, 30) && Boolean(v.cityName.trim()) && text(v.query, 150) && Boolean(v.query.trim())
    && (v.source === undefined || ['boss', 'amap', 'baidu', 'manual'].includes(v.source)) && isBossPoint(v);
}
/** The former 'boss' tag conflated native BD09 suggestions with GCJ02 job endpoints. */
export function normalizedCommuteOrigin(origin: CommuteOrigin): CommuteOrigin {
  return origin.coordinateSystem === 'boss' ? { ...origin, coordinateSystem: 'bd09', source: 'boss' } : origin;
}
export function normalizedWorkAddress(address: BossWorkAddress): BossWorkAddress {
  return address.point?.coordinateSystem === 'boss' ? { ...address, point: { ...address.point, coordinateSystem: 'gcj02' } } : address;
}
export function validWorkAddress(v: any): v is BossWorkAddress {
  return v && text(v.address, 1000) && Boolean(v.address.trim()) && (v.point === undefined || isBossPoint(v.point));
}
export function validateCommuteFilter(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && (v.origin === undefined || validCommuteOrigin(v.origin))
    && (v.locationApi === undefined || validLocationApi(v.locationApi))
    && (v.maxDistanceKm === undefined || typeof v.maxDistanceKm === 'number' && Number.isFinite(v.maxDistanceKm) && v.maxDistanceKm >= 0 && v.maxDistanceKm <= 200)
    && (v.maxTransitMinutes === undefined || typeof v.maxTransitMinutes === 'number' && Number.isInteger(v.maxTransitMinutes) && v.maxTransitMinutes >= 0 && v.maxTransitMinutes <= 240);
}
export function validLocationApi(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && ['boss', 'amap', 'baidu'].includes(v.provider)
    && (v.apiKey === undefined || typeof v.apiKey === 'string' && v.apiKey.length <= 512 && !/[\r\n\s]/.test(v.apiKey));
}
export function normalizeCommuteFilter(v: unknown): CommuteFilter {
  if (!validateCommuteFilter(v)) return {};
  const input = v as CommuteFilter;
  return { ...(input.origin ? { origin: { ...normalizedCommuteOrigin(input.origin), name: input.origin.name.trim(), address: input.origin.address.trim(),
    cityName: input.origin.cityName.trim(), query: input.origin.query.trim() } } : {}),
    maxDistanceKm: input.maxDistanceKm || 0, maxTransitMinutes: input.maxTransitMinutes || 0,
    ...(input.locationApi ? { locationApi: { provider: input.locationApi.provider, apiKey: input.locationApi.apiKey || '' } } : {}) };
}
export function hasCommuteLimits(filter: AppConfig['filter']): boolean {
  return Boolean(filter.commute?.maxDistanceKm || filter.commute?.maxTransitMinutes);
}
/** Approximate straight-line distance after putting known grids in GCJ02. */
export function straightDistanceKm(a: BossMapPoint, b: BossMapPoint): number {
  if (!isBossPoint(a) || !isBossPoint(b)) throw new Error('地图坐标无效或来源不同');
  if (a.coordinateSystem !== 'boss' && b.coordinateSystem !== 'boss') {
    a = convertMapPoint(a, 'gcj02'); b = convertMapPoint(b, 'gcj02');
  } else if (a.coordinateSystem !== b.coordinateSystem) throw new Error('旧位置的坐标系尚未核对，请重新获取位置');
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function sameBossPoint(a: BossMapPoint | undefined, b: BossMapPoint | undefined): boolean {
  try { return Boolean(a && b && isBossPoint(a) && isBossPoint(b) && straightDistanceKm(a, b) < 0.002); } catch { return false; }
}
export function sameWorkAddress(a?: BossWorkAddress, b?: BossWorkAddress): boolean {
  return Boolean(a && b && a.address.replace(/\s/g, '') === b.address.replace(/\s/g, '')
    && ((!a.point && !b.point) || sameBossPoint(a.point, b.point)));
}
export function currentCommute(origin: CommuteOrigin, workAddress?: BossWorkAddress, saved?: JobCommute, now = Date.now()): JobCommute {
  origin = normalizedCommuteOrigin(origin);
  const destination = workAddress ? normalizedWorkAddress(workAddress) : { address: '岗位未提供可核对的工作地址' };
  let distanceKm: number | undefined;
  if (destination.point && isBossPoint(destination.point)) {
    try { distanceKm = straightDistanceKm(origin, destination.point); } catch { /* Unknown legacy coordinates require a fresh position. */ }
  }
  const fresh = saved && sameBossPoint(origin, normalizedCommuteOrigin(saved.origin)) && saved.origin.cityName === origin.cityName
    && sameWorkAddress(destination, normalizedWorkAddress(saved.destination)) && Number.isFinite(Date.parse(saved.checkedAt))
    && now - Date.parse(saved.checkedAt) >= 0 && now - Date.parse(saved.checkedAt) < TRANSIT_CACHE_MS;
  return { origin, destination, ...(distanceKm !== undefined ? { distanceKm } : {}),
    ...(fresh ? { transitMinutes: saved.transitMinutes, transitSummary: saved.transitSummary, transitStatus: saved.transitStatus,
      transitReason: saved.transitReason, checkedAt: saved.checkedAt } : { transitStatus: 'not_requested' as const, checkedAt: new Date(now).toISOString() }) };
}
export function commuteDecision(job: { workAddress?: BossWorkAddress; commute?: JobCommute }, filter: AppConfig['filter']):
  { status: 'disabled' | 'passed' | 'failed' | 'unknown'; reason: string } {
  if (!hasCommuteLimits(filter)) return { status: 'disabled', reason: '' };
  const cfg = filter.commute!;
  if (!validCommuteOrigin(cfg.origin)) return { status: 'unknown', reason: '距离待确认：请先选择出发位置' };
  const result = currentCommute(cfg.origin, job.workAddress, job.commute);
  if (result.distanceKm === undefined) return { status: 'unknown', reason: '距离待确认：未能核对岗位的实际工作地址和地图坐标' };
  if (cfg.maxDistanceKm && result.distanceKm > cfg.maxDistanceKm) return { status: 'failed',
    reason: '工作地点超出距离上限：直线约 ' + result.distanceKm.toFixed(1) + ' 公里，上限 ' + cfg.maxDistanceKm + ' 公里' };
  if (cfg.maxTransitMinutes) {
    if (result.transitStatus !== 'ok' || typeof result.transitMinutes !== 'number' || !Number.isFinite(result.transitMinutes)) {
      return { status: 'unknown', reason: '通勤待确认：' + (result.transitReason || '尚未取得该出发点到岗位的公交／地铁路线') };
    }
    if (result.transitMinutes > cfg.maxTransitMinutes) return { status: 'failed',
      reason: '工作地点超出通勤上限：公交／地铁预计 ' + result.transitMinutes + ' 分钟，上限 ' + cfg.maxTransitMinutes + ' 分钟' };
  }
  return { status: 'passed', reason: '地点符合：直线约 ' + result.distanceKm.toFixed(1) + ' 公里'
    + (result.transitStatus === 'ok' ? '，公交／地铁预计 ' + result.transitMinutes + ' 分钟' : '') };
}
export function parseTransitMinutes(value: string): number | undefined {
  const t = value.replace(/\s/g, '').replace(/^约/, '');
  const match = t.match(/^(?:(\d+)小时)?(?:(\d+)分钟)?$/);
  if (!match || (!match[1] && !match[2])) return undefined;
  const minutes = Number(match[1] || 0) * 60 + Number(match[2] || 0);
  return minutes >= 0 && minutes <= 1440 ? minutes : undefined;
}
export function validJobCommute(v: any): v is JobCommute {
  return v && validCommuteOrigin(v.origin) && validWorkAddress(v.destination) && ['ok', 'unknown', 'not_requested'].includes(v.transitStatus)
    && typeof v.checkedAt === 'string' && Number.isFinite(Date.parse(v.checkedAt))
    && (v.distanceKm === undefined || typeof v.distanceKm === 'number' && Number.isFinite(v.distanceKm) && v.distanceKm >= 0)
    && (v.transitMinutes === undefined || typeof v.transitMinutes === 'number' && Number.isFinite(v.transitMinutes) && v.transitMinutes >= 0 && v.transitMinutes <= 1440)
    && (v.transitStatus !== 'ok' || typeof v.transitMinutes === 'number')
    && (v.transitSummary === undefined || text(v.transitSummary, 500)) && (v.transitReason === undefined || text(v.transitReason, 500));
}
