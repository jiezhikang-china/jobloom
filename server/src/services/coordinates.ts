// Adapted from wandergis/coordtransform, Copyright (c) 2015 记忆的残骸.
// MIT; full license in coordinates.LICENSE. Approximate WGS84 / GCJ02 / BD09 conversion.
import type { BossMapPoint } from '../types.js';

const xPi = Math.PI * 3000 / 180;
export function bd09ToGcj02(longitude: number, latitude: number): [number, number] {
  const x = longitude - 0.0065, y = latitude - 0.006;
  const z = Math.hypot(x, y) - 0.00002 * Math.sin(y * xPi);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * xPi);
  return [z * Math.cos(theta), z * Math.sin(theta)];
}
export function gcj02ToBd09(longitude: number, latitude: number): [number, number] {
  const z = Math.hypot(longitude, latitude) + 0.00002 * Math.sin(latitude * xPi);
  const theta = Math.atan2(latitude, longitude) + 0.000003 * Math.cos(longitude * xPi);
  return [z * Math.cos(theta) + 0.0065, z * Math.sin(theta) + 0.006];
}
export function convertMapPoint(point: BossMapPoint, target: 'gcj02' | 'bd09'): BossMapPoint {
  if (point.coordinateSystem === 'boss') throw new Error('旧位置的坐标系尚未核对，请重新获取出发位置');
  const pair = point.coordinateSystem === target ? [point.longitude, point.latitude]
    : target === 'gcj02' ? bd09ToGcj02(point.longitude, point.latitude) : gcj02ToBd09(point.longitude, point.latitude);
  return { longitude: pair[0], latitude: pair[1], coordinateSystem: target };
}

export function wgs84ToGcj02(longitude: number, latitude: number): [number, number] {
  if (!(longitude > 73.66 && longitude < 135.05 && latitude > 3.86 && latitude < 53.55)) return [longitude, latitude];
  const x = longitude - 105, y = latitude - 35, pi = Math.PI;
  let dLat = -100 + 2 * x + 3 * y + .2 * y * y + .1 * x * y + .2 * Math.sqrt(Math.abs(x));
  dLat += (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
  dLat += (20 * Math.sin(y * pi) + 40 * Math.sin(y / 3 * pi)) * 2 / 3;
  dLat += (160 * Math.sin(y / 12 * pi) + 320 * Math.sin(y * pi / 30)) * 2 / 3;
  let dLon = 300 + x + 2 * y + .1 * x * x + .1 * x * y + .1 * Math.sqrt(Math.abs(x));
  dLon += (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
  dLon += (20 * Math.sin(x * pi) + 40 * Math.sin(x / 3 * pi)) * 2 / 3;
  dLon += (150 * Math.sin(x / 12 * pi) + 300 * Math.sin(x / 30 * pi)) * 2 / 3;
  const rad = latitude / 180 * pi, magic = 1 - .00669342162296594323 * Math.sin(rad) ** 2, sqrt = Math.sqrt(magic);
  return [longitude + dLon * 180 / (6378245 / sqrt * Math.cos(rad) * pi),
    latitude + dLat * 180 / (6378245 * (1 - .00669342162296594323) / (magic * sqrt) * pi)];
}
/** Iteratively invert the local approximation; never send a selected coordinate to a third-party service. */
export function mapPointToGps(point: BossMapPoint): { longitude: number; latitude: number; coordinateSystem: 'wgs84' } {
  const gcj = convertMapPoint(point, 'gcj02');
  let longitude = gcj.longitude, latitude = gcj.latitude;
  for (let i = 0; i < 5; i++) {
    const next = wgs84ToGcj02(longitude, latitude);
    longitude += gcj.longitude - next[0]; latitude += gcj.latitude - next[1];
  }
  return { longitude, latitude, coordinateSystem: 'wgs84' };
}
