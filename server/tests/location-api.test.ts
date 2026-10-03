import assert from 'node:assert/strict';
import { LocationApiService } from '../src/services/location-api.service.js';
import { bd09ToGcj02, gcj02ToBd09, wgs84ToGcj02, mapPointToGps } from '../src/services/coordinates.js';
import { currentCommute, normalizeCommuteFilter, straightDistanceKm, validateCommuteFilter } from '../src/services/commute.js';
import type { CommuteOrigin } from '../src/types.js';

async function main() {
  const origin: CommuteOrigin = { name: '住处', address: '上海测试地址', cityName: '上海', query: '住处', source: 'manual',
    longitude: 121.47, latitude: 31.23, coordinateSystem: 'gcj02' };
  const converted = gcj02ToBd09(origin.longitude, origin.latitude), back = bd09ToGcj02(...converted);
  assert.ok(Math.abs(back[0] - origin.longitude) < 0.000001 && Math.abs(back[1] - origin.latitude) < 0.000001);
  const baidu = { ...origin, longitude: converted[0], latitude: converted[1], coordinateSystem: 'bd09' as const };
  assert.ok(straightDistanceKm(origin, baidu) < 0.0002, '跨地图相同位置转换后不被误判几百米之外');
  const legacy = { ...baidu, coordinateSystem: 'boss' as const };
  assert.equal(normalizeCommuteFilter({ origin: legacy }).origin?.coordinateSystem, 'bd09');
  const actual = currentCommute(legacy, { address: '相同地方', point: { ...origin, coordinateSystem: 'boss' } });
  assert.ok(actual.distanceKm! < 0.0002, '旧boss标签按出发点BD09/岗位GCJ02角色迁移');
  assert.equal(validateCommuteFilter({ locationApi: { provider: 'amap', apiKey: 'fake-key' } }), true);
  assert.equal(validateCommuteFilter({ locationApi: { provider: 'arbitrary-url', apiKey: 'key' } }), false);
  assert.equal(validateCommuteFilter({ origin: { ...origin, source: 'unverified' } }), false);

  let payload: any = {}, seen: URL[] = [];
  const service = new LocationApiService((async (url) => {
    seen.push(new URL(String(url))); return new Response(JSON.stringify(payload));
  }) as typeof fetch);
  const amapConfig = { provider: 'amap' as const, apiKey: 'fake-amap-key' };
  const baiduConfig = { provider: 'baidu' as const, apiKey: 'fake-baidu-key' };
  payload = { status: '1', tips: [{ name: '无坐标公交线', location: [] }, { name: '地铁站', location: '121.47,31.23', district: '上海', address: '路口' }] };
  const places = await service.searchOrigins('地铁站', '上海', amapConfig);
  assert.equal(places.length, 1); assert.equal(places[0].coordinateSystem, 'gcj02');
  assert.equal(seen.at(-1)?.searchParams.get('citylimit'), 'true');
  payload = { status: 0, result: [{ name: '无坐标' }, { name: '地铁站', location: { lng: converted[0], lat: converted[1] }, city: '上海' }] };
  const bdPlaces = await service.searchOrigins('地铁站', '上海', baiduConfig);
  assert.equal(bdPlaces.length, 1); assert.equal(bdPlaces[0].coordinateSystem, 'bd09');
  assert.equal(seen.at(-1)?.pathname, '/place/v2/suggestion');

  payload = { status: '1', route: { transits: [{ duration: '3000', walking_distance: '1200' }, { duration: '1801', walking_distance: '800' }, { duration: '' }] } };
  const destination = { address: '实际岗位工作地址', point: { ...origin, longitude: 121.49 } };
  assert.equal((await service.readTransit(baidu, destination, amapConfig, '上海')).minutes, 31);
  let url = seen.at(-1)!;
  assert.ok(url.searchParams.get('origin')!.startsWith('121.'), '高德使用经度,纬度');
  assert.equal(url.searchParams.get('destination'), '121.49,31.23');
  payload = { status: 0, result: { routes: [{ duration: 1200 }] } };
  assert.equal((await service.readTransit(origin, destination, baiduConfig, '上海')).minutes, 20);
  url = seen.at(-1)!;
  assert.ok(url.searchParams.get('origin')!.startsWith('31.'), '百度路线使用纬度,经度');
  assert.equal(url.searchParams.get('coord_type'), 'bd09ll');
  assert.ok(Math.abs(Number(url.searchParams.get('destination')!.split(',')[1]) - gcj02ToBd09(121.49, 31.23)[0]) < 1e-8);
  for (const failed of [{ status: 1001, result: {} }, { status: 0, result: { routes: [] } }, { status: 0, result: { routes: [{ duration: null }] } }]) {
    payload = failed; await assert.rejects(service.readTransit(origin, destination, baiduConfig, '上海'), /地图 API/);
  }
  payload = { status: 0, result: { routes: [{ duration: 0 }] } };
  assert.equal((await service.readTransit(origin, { address: '同一个位置', point: origin }, baiduConfig, '上海')).minutes, 0);

  const beforeManual = seen.length;
  assert.equal((await service.manualOrigin(origin, { provider: 'boss' })).source, 'manual');
  assert.equal(seen.length, beforeManual, '已知GCJ02/BD09手动坐标无API请求');
  const gps = { ...origin, coordinateSystem: 'wgs84' };
  const local = await service.manualOrigin(gps, { provider: 'open' });
  assert.equal(seen.length, beforeManual, 'GPS 在本机转换，不需要地图Key');
  assert.equal(local.coordinateSystem, 'gcj02');
  assert.ok(Math.abs(local.longitude - wgs84ToGcj02(origin.longitude, origin.latitude)[0]) < 1e-10);
  const gpsBack = mapPointToGps(local);
  assert.ok(Math.abs(gpsBack.longitude - gps.longitude) < 1e-8 && Math.abs(gpsBack.latitude - gps.latitude) < 1e-8);
  payload = { status: '1', locations: '121.47,31.23' };
  assert.equal((await service.manualOrigin({ ...origin, coordinateSystem: 'wgs84' }, amapConfig)).coordinateSystem, 'gcj02');
  assert.equal(seen.at(-1)?.searchParams.get('coordsys'), 'gps');
  payload = { status: 0, result: [{ x: converted[0], y: converted[1] }] };
  assert.equal((await service.manualOrigin({ ...origin, coordinateSystem: 'wgs84' }, baiduConfig)).coordinateSystem, 'bd09');
  assert.equal(seen.at(-1)?.pathname, '/geoconv/v2/'); assert.equal(seen.at(-1)?.searchParams.get('model'), '2');
  payload = { status: '1', locations: 'bad' };
  await assert.rejects(service.manualOrigin({ ...origin, coordinateSystem: 'wgs84' }, amapConfig), /无效/);
  await assert.rejects(service.searchOrigins('地铁站', '上海', { provider: 'amap', apiKey: '' }), /Key/);
  console.log('PASS | 高德/百度搜索与通勤格式、经纬度顺序、BD09/GCJ02转换、旧数据迁移、GPS转换、缺失路线不当0、无API手动输入');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
