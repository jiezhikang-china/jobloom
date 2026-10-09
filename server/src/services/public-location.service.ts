import type { CommuteOrigin } from '../types.js';
import { validCommuteOrigin } from './commute.js';
import { wgs84ToGcj02 } from './coordinates.js';

export const PUBLIC_MAP_TILE_URL = process.env.LOCATION_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const searchUrl = process.env.LOCATION_SEARCH_URL || 'https://nominatim.openstreetmap.org/search';
const attribution = process.env.LOCATION_MAP_ATTRIBUTION || '© OpenStreetMap contributors';
export function publicMapConfig() {
  // Environment override permits a self-hosted service without releasing another app version.
  if (!/^https:\/\//.test(PUBLIC_MAP_TILE_URL) || !['{z}', '{x}', '{y}'].every(part => PUBLIC_MAP_TILE_URL.includes(part))) {
    throw new Error('公共地图地址需为包含 z/x/y 的 HTTPS 瓦片地址');
  }
  return { tileUrl: PUBLIC_MAP_TILE_URL, attribution, attributionUrl: 'https://www.openstreetmap.org/copyright' };
}
const number = (value: unknown) => typeof value === 'number' ? value
  : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;

/** Explicit human address searches only: no autocomplete, job geocoding, polling, or AI calls. */
export class PublicLocationService {
  private cache = new Map<string, { places: CommuteOrigin[]; expires: number }>();
  private queue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  constructor(private request: typeof fetch = fetch, private now = Date.now,
    private sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), private endpoint = searchUrl) {}
  public async searchOrigins(query: string, cityName: string): Promise<CommuteOrigin[]> {
    if (query.trim().length < 2 || query.length > 100 || cityName.trim().length < 2 || cityName.length > 30) throw new Error('请填写城市和地点名称');
    const key = cityName.trim() + '\n' + query.trim();
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const saved = this.cache.get(key);
      if (saved && saved.expires > this.now()) return structuredClone(saved.places);
      const delay = this.nextRequestAt - this.now();
      if (delay > 15000) throw new Error('公共位置服务正在限流，请稍后再试，或切换 BOSS 地址搜索');
      if (delay > 0) await this.sleep(delay);
      this.nextRequestAt = this.now() + 1100;
      const url = new URL(this.endpoint);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('公共位置服务配置无效');
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('公共位置服务需要 HTTPS');
      url.search = new URLSearchParams({ q: query.includes(cityName) ? query.trim() : cityName.trim() + ' ' + query.trim(),
        format: 'jsonv2', limit: '8', addressdetails: '1', countrycodes: 'cn', 'accept-language': 'zh-CN,zh' }).toString();
      let response: Response;
      try { response = await this.request(url, { headers: { 'User-Agent': 'Jobloom/1.0 (Windows desktop; user-initiated commute setup)',
        Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); }
      catch { throw new Error('公共地址搜索连接失败，可切换 BOSS 地址搜索或直接在地图选点'); }
      if (!response.ok) {
        if (response.status === 429 || response.status === 503) {
          const raw = response.headers.get('retry-after') || '';
          const wait = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - this.now();
          this.nextRequestAt = this.now() + (Number.isFinite(wait) && wait > 0 ? wait : 60000);
        }
        throw new Error('公共地址搜索暂不可用（HTTP ' + response.status + '），可切换 BOSS 地址搜索');
      }
      let data: any;
      try { data = await response.json(); } catch { throw new Error('公共地址搜索返回格式异常'); }
      if (!Array.isArray(data)) throw new Error('公共地址搜索返回格式异常');
      const places: CommuteOrigin[] = [];
      for (const row of data.slice(0, 8)) {
        const longitude = number(row?.lon), latitude = number(row?.lat);
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < 70 || longitude > 140 || latitude <= 0 || latitude > 60) continue;
        const actualCity = [row.address?.city, row.address?.town, row.address?.state].find(v => typeof v === 'string' && v.includes(cityName.replace(/市$/, '')));
        if (!actualCity && !(typeof row.display_name === 'string' && row.display_name.includes(cityName.replace(/市$/, '')))) continue;
        const pair = wgs84ToGcj02(longitude, latitude);
        const place = { longitude: pair[0], latitude: pair[1], coordinateSystem: 'gcj02' as const, source: 'openstreetmap' as const,
          name: (typeof row.name === 'string' && row.name || typeof row.display_name === 'string' && row.display_name.split(',')[0] || query).slice(0, 150),
          address: typeof row.display_name === 'string' ? row.display_name.slice(0, 300) : '', cityName, query };
        if (validCommuteOrigin(place)) places.push(place);
      }
      this.cache.set(key, { places: structuredClone(places), expires: this.now() + 24 * 60 * 60 * 1000 });
      while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
      return places;
    } finally { release(); }
  }
}
export const publicLocationService = new PublicLocationService();
