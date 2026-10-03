// Adapted from wandergis/coordtransform, Copyright (c) 2015 记忆的残骸.
// MIT; full license in coordinates.LICENSE. Approximate GCJ02 / BD09 conversion.
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
