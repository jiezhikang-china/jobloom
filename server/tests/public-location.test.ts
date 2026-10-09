import assert from 'node:assert/strict';
import { PublicLocationService, publicMapConfig } from '../src/services/public-location.service.js';
import { DeviceLocationService } from '../src/services/device-location.service.js';
import { mapPointToGps, wgs84ToGcj02 } from '../src/services/coordinates.js';
import { straightDistanceKm, validateCommuteFilter, manualCommuteOrigin } from '../src/services/commute.js';
import { JobCommuteService } from '../src/services/job-commute.service.js';
import type { AppConfig, BossJobItem } from '../src/types.js';

async function main() {
  let now = 1700000000000, calls = 0;
  const started: number[] = [];
  let response = new Response(JSON.stringify([
    { name: '人民广场', lon: '121.4702', lat: '31.2283', display_name: '人民广场, 黄浦区, 上海市, 中国', address: { city: '上海市' } },
    { name: '同名异城', lon: '116.4', lat: '39.9', display_name: '北京', address: { city: '北京市' } },
    { name: '坏数据', lon: '121.4oops', lat: '31.2', display_name: '上海市' },
  ]));
  const request = (async (raw: any, options: any) => {
    calls++; started.push(now);
    const url = new URL(String(raw));
    assert.equal(url.hostname, 'nominatim.openstreetmap.org');
    assert.equal(url.searchParams.get('countrycodes'), 'cn');
    assert.match(options.headers['User-Agent'], /Jobloom/);
    assert.equal(url.searchParams.has('key'), false); assert.equal(url.searchParams.has('ak'), false);
    return response.clone();
  }) as typeof fetch;
  const publicService = new PublicLocationService(request, () => now, async ms => { now += ms; });
  const [first, second] = await Promise.all([publicService.searchOrigins('人民广场', '上海'), publicService.searchOrigins('人民广场', '上海')]);
  assert.equal(calls, 1, '相同并发搜索只查询一次'); assert.deepEqual(first, second); assert.equal(first.length, 1);
  assert.equal(first[0].source, 'openstreetmap'); assert.equal(first[0].coordinateSystem, 'gcj02');
  const expected = wgs84ToGcj02(121.4702, 31.2283);
  assert.ok(Math.abs(first[0].longitude - expected[0]) < 1e-10, 'OSM GPS坐标转换一次再存储');
  const displayed = mapPointToGps(first[0]);
  assert.ok(Math.abs(displayed.longitude - 121.4702) < 1e-8 && Math.abs(displayed.latitude - 31.2283) < 1e-8, '再次地图显示不产生数百米偏移');
  first[0].name = '修改副本';
  assert.equal((await publicService.searchOrigins('人民广场', '上海'))[0].name, '人民广场');
  await publicService.searchOrigins('地铁站', '上海');
  assert.ok(started[1] - started[0] >= 1100, '所有网络搜索至少间隔1.1秒');
  response = new Response('{}', { status: 429, headers: { 'retry-after': '90' } });
  await assert.rejects(publicService.searchOrigins('另一地铁站', '上海'), /HTTP 429/);
  const beforeLimit = calls;
  await assert.rejects(publicService.searchOrigins('再次查询', '上海'), /正在限流/);
  assert.equal(calls, beforeLimit, 'Retry-After期间不重试请求');
  assert.ok(publicMapConfig().tileUrl.startsWith('https://tile.openstreetmap.org/'));

  const raw = { success: true, longitude: 121.4702, latitude: 31.2283, accuracyMeters: 150, timestamp: new Date(now).toISOString() };
  const device = new DeviceLocationService(async () => JSON.stringify(raw), 'win32', () => now);
  const position = await device.getPosition();
  assert.equal(position.coordinateSystem, 'wgs84'); assert.equal(position.accuracyMeters, 150);
  await assert.rejects(new DeviceLocationService(async () => '{', 'win32').getPosition(), /未完成/);
  await assert.rejects(new DeviceLocationService(async () => JSON.stringify({ success: false, code: 'permission_denied' }), 'win32').getPosition(), /未允许定位/);
  await assert.rejects(new DeviceLocationService(async () => JSON.stringify({ success: false, code: 'unavailable' }), 'win32').getPosition(), /暂未提供/);
  await assert.rejects(new DeviceLocationService(async () => JSON.stringify({ ...raw, longitude: 0 }), 'win32').getPosition(), /国内范围/);
  await assert.rejects(new DeviceLocationService(async () => JSON.stringify({ ...raw, timestamp: new Date(now - 301000).toISOString() }), 'win32', () => now).getPosition(), /已过期/);
  await assert.rejects(new DeviceLocationService(async () => { throw Error('must not run'); }, 'linux').getPosition(), /Windows/);
  const origin = manualCommuteOrigin({ ...position, name: '地图出发点', address: '', cityName: '上海' });
  assert.equal(validateCommuteFilter({ origin, maxDistanceKm: 15 }), true);
  assert.ok(straightDistanceKm(origin, { ...origin, longitude: expected[0], latitude: expected[1] }) < .000001);
  const job = { cityName: '上海', workAddress: { address: '工作地点', point: { ...origin, longitude: origin.longitude + .01 } } } as unknown as BossJobItem;
  const filter = { commute: { origin, maxDistanceKm: 15 } } as AppConfig['filter'];
  await new JobCommuteService().enrich(job, filter);
  assert.ok(job.commute!.distanceKm! > 0 && job.commute!.distanceKm! < 15);
  assert.equal('transitStatus' in job.commute!, false);
  console.log('PASS | 免Key公共搜索、并发缓存、限速/限流、异城和坏坐标排除、系统定位精度/拒绝/过期、本机GPS转换、公共地图位置与本地距离');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
