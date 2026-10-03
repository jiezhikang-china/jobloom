import assert from 'node:assert/strict';
import { bd09ToGcj02, gcj02ToBd09, wgs84ToGcj02, mapPointToGps } from '../src/services/coordinates.js';
import { currentCommute, normalizeCommuteFilter, straightDistanceKm, validateCommuteFilter, manualCommuteOrigin } from '../src/services/commute.js';
import type { CommuteOrigin } from '../src/types.js';

const origin: CommuteOrigin = { name: '住处', address: '上海测试地址', cityName: '上海', query: '住处', source: 'manual',
  longitude: 121.47, latitude: 31.23, coordinateSystem: 'gcj02' };
const converted = gcj02ToBd09(origin.longitude, origin.latitude), back = bd09ToGcj02(...converted);
assert.ok(Math.abs(back[0] - origin.longitude) < 0.000001 && Math.abs(back[1] - origin.latitude) < 0.000001);
const baidu = { ...origin, longitude: converted[0], latitude: converted[1], coordinateSystem: 'bd09' as const };
assert.ok(straightDistanceKm(origin, baidu) < 0.0002);
const legacy = { ...baidu, coordinateSystem: 'boss' as const };
assert.equal(normalizeCommuteFilter({ origin: legacy }).origin?.coordinateSystem, 'bd09');
const actual = currentCommute(legacy, { address: '相同地方', point: { ...origin, coordinateSystem: 'boss' } });
assert.ok(actual.distanceKm! < 0.0002);
const migrated = normalizeCommuteFilter({ origin: legacy, maxDistanceKm: 15,
  locationApi: { provider: 'amap', apiKey: 'legacy-private-key' } } as any);
assert.equal('locationApi' in migrated, false, '迁移删除地图 API 配置及旧 Key');
assert.equal(migrated.maxDistanceKm, 15); assert.equal(migrated.origin?.name, '住处');
assert.equal(validateCommuteFilter({ origin: { ...origin, source: 'unverified' } }), false);
assert.deepEqual(manualCommuteOrigin(origin), { ...origin, query: '住处' });
const gps = { ...origin, coordinateSystem: 'wgs84' };
const local = manualCommuteOrigin(gps);
assert.equal(local.coordinateSystem, 'gcj02');
assert.ok(Math.abs(local.longitude - wgs84ToGcj02(origin.longitude, origin.latitude)[0]) < 1e-10);
const gpsBack = mapPointToGps(local);
assert.ok(Math.abs(gpsBack.longitude - gps.longitude) < 1e-8 && Math.abs(gpsBack.latitude - gps.latitude) < 1e-8);
for (const invalid of [{ ...gps, longitude: 0 }, { ...origin, coordinateSystem: 'unknown' }, { ...origin, name: '' }]) {
  assert.throws(() => manualCommuteOrigin(invalid), /无效|正确|范围|名称|坐标/);
}
console.log('PASS | 本机坐标转换、旧坐标迁移、删除旧地图 Key、保留原出发点和距离条件');
