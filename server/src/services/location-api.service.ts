import type { BossMapPoint, BossWorkAddress, CommuteOrigin, LocationApiConfig } from '../types.js';
import { isBossPoint, validCommuteOrigin, validLocationApi } from './commute.js';
import { convertMapPoint } from './coordinates.js';

export class LocationApiService {
  constructor(private request: typeof fetch = fetch) {}
  private async get(endpoint: string, params: Record<string, string>, config: LocationApiConfig): Promise<any> {
    if (!validLocationApi(config) || config.provider === 'boss' || !config.apiKey?.trim()) throw new Error('请填写所选地图的 Web 服务 API Key / AK');
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ ...params, [config.provider === 'amap' ? 'key' : 'ak']: config.apiKey.trim() }).toString();
    let response: globalThis.Response;
    try { response = await this.request(url, { signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('地图 API 连接失败，请检查网络和所填 Key 的服务权限'); }
    if (!response.ok) throw new Error('地图 API 暂不可用（HTTP ' + response.status + '）');
    let data: any;
    try { data = await response.json(); } catch { throw new Error('地图 API 返回了无法识别的结果'); }
    const success = config.provider === 'amap' ? String(data?.status) === '1' : data?.status === 0;
    if (!success) {
      const code = String(config.provider === 'amap' ? data?.infocode : data?.status).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
      throw new Error('地图 API 未成功（' + code + '），请检查 Key、额度和服务权限；没有路线时请保留待确认');
    }
    return data;
  }
  public async searchOrigins(query: string, cityName: string, config: LocationApiConfig): Promise<CommuteOrigin[]> {
    const places: CommuteOrigin[] = [];
    if (config.provider === 'amap') {
      const data = await this.get('https://restapi.amap.com/v3/assistant/inputtips',
        { keywords: query, city: cityName, citylimit: 'true', datatype: 'poi', output: 'json' }, config);
      for (const row of Array.isArray(data.tips) ? data.tips : []) {
        if (typeof row.location !== 'string' || !/^\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*$/.test(row.location)) continue;
        const [longitude, latitude] = row.location.split(',').map(Number);
        const place = { longitude, latitude, coordinateSystem: 'gcj02' as const, name: row.name,
          address: [row.district, typeof row.address === 'string' ? row.address : ''].filter(Boolean).join(' '),
          cityName, query, source: 'amap' as const };
        if (validCommuteOrigin(place)) places.push(place);
      }
    } else if (config.provider === 'baidu') {
      const data = await this.get('https://api.map.baidu.com/place/v2/suggestion',
        { query, region: cityName, city_limit: 'true', output: 'json' }, config);
      for (const row of Array.isArray(data.result) ? data.result : []) {
        const place = { longitude: row.location?.lng, latitude: row.location?.lat, coordinateSystem: 'bd09' as const,
          name: row.name, address: [row.city, row.district, row.address].filter(v => typeof v === 'string').join(' '),
          cityName, query, source: 'baidu' as const };
        if (validCommuteOrigin(place)) places.push(place);
      }
    } else throw new Error('请选择高德或百度 API');
    return places.slice(0, 30);
  }
  public async manualOrigin(input: any, config: LocationApiConfig): Promise<CommuteOrigin> {
    const { longitude, latitude, coordinateSystem } = input || {};
    if (!isBossPoint({ longitude, latitude, coordinateSystem: 'gcj02' }) || !['gcj02', 'bd09', 'wgs84'].includes(coordinateSystem)) {
      throw new Error('请填写有效经纬度，并选择高德、百度或 GPS 坐标系');
    }
    let point: BossMapPoint;
    if (coordinateSystem === 'wgs84') {
      if (config.provider === 'amap') {
        const data = await this.get('https://restapi.amap.com/v3/assistant/coordinate/convert',
          { locations: longitude + ',' + latitude, coordsys: 'gps', output: 'json' }, config);
        const pair = typeof data.locations === 'string' ? data.locations.split(',').map(Number) : [];
        point = { longitude: pair[0], latitude: pair[1], coordinateSystem: 'gcj02' };
      } else if (config.provider === 'baidu') {
        const data = await this.get('https://api.map.baidu.com/geoconv/v2/',
          { coords: longitude + ',' + latitude, model: '2', output: 'json' }, config);
        point = { longitude: data.result?.[0]?.x, latitude: data.result?.[0]?.y, coordinateSystem: 'bd09' };
      } else throw new Error('GPS 坐标请先选择高德或百度 API，并填写自己的 Key 用于转换');
    } else point = { longitude, latitude, coordinateSystem };
    const place = { ...point, name: input.name, address: input.address || '', cityName: input.cityName,
      query: input.name, source: 'manual' as const };
    if (!validCommuteOrigin(place)) throw new Error('出发位置名称、城市或坐标无效');
    return place;
  }
  public async readTransit(origin: CommuteOrigin, destination: BossWorkAddress, config: LocationApiConfig,
    destinationCity: string): Promise<{ minutes: number; summary: string }> {
    if (!destination.point || !isBossPoint(destination.point)) throw new Error('岗位未提供可核对的工作地点坐标');
    const system = config.provider === 'amap' ? 'gcj02' : 'bd09';
    const from = convertMapPoint(origin, system), to = convertMapPoint(destination.point, system);
    let routes: any[], provider: string;
    if (config.provider === 'amap') {
      const data = await this.get('https://restapi.amap.com/v3/direction/transit/integrated',
        { origin: from.longitude + ',' + from.latitude, destination: to.longitude + ',' + to.latitude,
          city: origin.cityName, cityd: destinationCity || origin.cityName, strategy: '0', extensions: 'all', output: 'json' }, config);
      routes = Array.isArray(data.route?.transits) ? data.route.transits : []; provider = '高德地图';
    } else if (config.provider === 'baidu') {
      const data = await this.get('https://api.map.baidu.com/direction/v2/transit',
        { origin: from.latitude + ',' + from.longitude, destination: to.latitude + ',' + to.longitude,
          coord_type: 'bd09ll', tactics_incity: '4', output: 'json' }, config);
      routes = Array.isArray(data.result?.routes) ? data.result.routes : []; provider = '百度地图';
    } else throw new Error('请选择高德或百度 API 规划通勤');
    const valid = routes.filter(row => (typeof row.duration === 'number' || typeof row.duration === 'string' && /^\d+(?:\.\d+)?$/.test(row.duration))
      && Number.isFinite(Number(row.duration)) && Number(row.duration) >= 0 && Number(row.duration) <= 86400)
      .sort((a, b) => Number(a.duration) - Number(b.duration));
    if (!valid.length) throw new Error('地图 API 未给出可用公交／地铁路线');
    const route = valid[0], minutes = Math.ceil(Number(route.duration) / 60);
    const walk = Number(route.walking_distance);
    return { minutes, summary: provider + ' · 较快公共交通方案'
      + (Number.isFinite(walk) && walk > 0 ? ' · 步行约 ' + (walk / 1000).toFixed(1) + ' 公里' : '') };
  }
}
export const locationApiService = new LocationApiService();
