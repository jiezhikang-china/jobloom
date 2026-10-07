import type { AppConfig, BossMapPoint, BossWorkAddress, CommuteFilter, CommuteOrigin, JobCommute } from '../types.js';
import { convertMapPoint, wgs84ToGcj02 } from './coordinates.js';

const text = (v: unknown, max = 300) => typeof v === 'string' && v.length <= max;
export function isBossPoint(v: any): v is BossMapPoint {
  return ['boss', 'gcj02', 'bd09'].includes(v?.coordinateSystem) && typeof v.longitude === 'number' && Number.isFinite(v.longitude)
    && typeof v.latitude === 'number' && Number.isFinite(v.latitude)
    && v.longitude >= 70 && v.longitude <= 140 && v.latitude > 0 && v.latitude <= 60;
}
export function validCommuteOrigin(v: any): v is CommuteOrigin {
  return text(v?.name, 150) && Boolean(v.name.trim()) && text(v.address)
    && text(v.cityName, 30) && Boolean(v.cityName.trim()) && text(v.query, 150) && Boolean(v.query.trim())
    && (v.source === undefined || ['boss', 'amap', 'baidu', 'manual', 'openstreetmap'].includes(v.source)) && isBossPoint(v);
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
    && (v.maxDistanceKm === undefined || typeof v.maxDistanceKm === 'number' && Number.isFinite(v.maxDistanceKm) && v.maxDistanceKm >= 0 && v.maxDistanceKm <= 200);
}
export function normalizeCommuteFilter(v: unknown): CommuteFilter {
  if (!validateCommuteFilter(v)) return {};
  const input = v as CommuteFilter;
  return { ...(input.origin ? { origin: { ...normalizedCommuteOrigin(input.origin), name: input.origin.name.trim(), address: input.origin.address.trim(),
    cityName: input.origin.cityName.trim(), query: input.origin.query.trim() } } : {}),
    maxDistanceKm: input.maxDistanceKm || 0 };
}
/** Coordinate conversion is local; old saved positions remain usable after removing API settings. */
export function manualCommuteOrigin(input: any): CommuteOrigin {
  const { longitude, latitude, coordinateSystem } = input || {};
  if (!isBossPoint({ longitude, latitude, coordinateSystem: 'gcj02' }) || !['gcj02', 'bd09', 'wgs84'].includes(coordinateSystem)) {
    throw new Error('请填写有效经纬度并选择正确的坐标系');
  }
  const pair = coordinateSystem === 'wgs84' ? wgs84ToGcj02(longitude, latitude) : [longitude, latitude];
  const origin = { longitude: pair[0], latitude: pair[1], coordinateSystem: coordinateSystem === 'wgs84' ? 'gcj02' : coordinateSystem,
    name: input.name, address: input.address || '', cityName: input.cityName, query: input.name, source: 'manual' };
  if (!validCommuteOrigin(origin)) throw new Error('出发位置名称、城市或坐标无效');
  return origin;
}
export function hasCommuteLimits(filter: AppConfig['filter']): boolean {
  return Boolean(filter.commute?.maxDistanceKm);
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
export function currentCommute(origin: CommuteOrigin, workAddress?: BossWorkAddress, now = Date.now()): JobCommute {
  origin = normalizedCommuteOrigin(origin);
  const destination = workAddress ? normalizedWorkAddress(workAddress) : { address: '岗位未提供可核对的工作地址' };
  let distanceKm: number | undefined;
  if (destination.point && isBossPoint(destination.point)) {
    try { distanceKm = straightDistanceKm(origin, destination.point); } catch { /* Unknown legacy coordinates require a fresh position. */ }
  }
  return { origin, destination, ...(distanceKm !== undefined ? { distanceKm } : {}), checkedAt: new Date(now).toISOString() };
}
export function commuteDecision(job: { workAddress?: BossWorkAddress; commute?: JobCommute }, filter: AppConfig['filter']):
  { status: 'disabled' | 'passed' | 'failed' | 'unknown'; reason: string } {
  if (!hasCommuteLimits(filter)) return { status: 'disabled', reason: '' };
  const cfg = filter.commute!;
  if (!validCommuteOrigin(cfg.origin)) return { status: 'unknown', reason: '距离待确认：请先选择出发位置' };
  const result = currentCommute(cfg.origin, job.workAddress);
  if (result.distanceKm === undefined) return { status: 'unknown', reason: '距离待确认：未能核对岗位的实际工作地址和地图坐标' };
  if (cfg.maxDistanceKm && result.distanceKm > cfg.maxDistanceKm) return { status: 'failed',
    reason: '工作地点超出距离上限：直线约 ' + result.distanceKm.toFixed(1) + ' 公里，上限 ' + cfg.maxDistanceKm + ' 公里' };
  return { status: 'passed', reason: '地点符合：直线约 ' + result.distanceKm.toFixed(1) + ' 公里' };
}
export function validJobCommute(v: any): v is JobCommute {
  return v && validCommuteOrigin(v.origin) && validWorkAddress(v.destination)
    && typeof v.checkedAt === 'string' && Number.isFinite(Date.parse(v.checkedAt))
    && (v.distanceKm === undefined || typeof v.distanceKm === 'number' && Number.isFinite(v.distanceKm) && v.distanceKm >= 0);
}
