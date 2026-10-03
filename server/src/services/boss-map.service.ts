import type { BossWorkAddress, CommuteOrigin } from '../types.js';
import type { CdpPage } from './cdp.page.js';
import { isBossPoint, parseTransitMinutes, sameBossPoint, sameWorkAddress, validCommuteOrigin } from './commute.js';
import { decodeBossText } from './boss-text.js';
import { convertMapPoint } from './coordinates.js';

const DIALOG = '.boss-map-commuting-dialog';
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Actual workplace DOM, not the company's registered office or district/city centre. */
export async function readBossWorkAddress(page: CdpPage): Promise<BossWorkAddress | undefined> {
  const addresses = await page.evaluate(() => {
    const scopes = [...document.querySelectorAll('.job-detail-box .job-address, .job-location')]
      .filter(item => (item as HTMLElement).getClientRects().length > 0);
    return scopes.map(scope => {
      const address = (scope.querySelector('.job-address-desc, .location-address') as HTMLElement | null)?.innerText?.trim() || '';
      const map = scope.querySelector('.map-box-wrapper, .job-location-map') as any;
      let longitude: number | undefined, latitude: number | undefined;
      const attribute = map?.getAttribute('data-lat');
      if (attribute && /^\s*[0-9.]+\s*,\s*[0-9.]+\s*$/.test(attribute)) {
        [longitude, latitude] = attribute.split(',').map(Number); // BOSS names the longitude,latitude pair data-lat.
      } else if (map?.__vue__?.$props?.locationText?.trim() === address) {
        longitude = Number(map.__vue__.$props.location?.lng);
        latitude = Number(map.__vue__.$props.location?.lat);
      }
      return { address, longitude, latitude };
    }).filter(item => item.address);
  });
  const unique = [...new Map(addresses.map(item => [item.address.replace(/\s/g, ''), item])).values()];
  if (!unique.length) return undefined;
  if (unique.length > 1) return { address: unique.map(item => decodeBossText(item.address)).join(' / ').slice(0, 1000) };
  // BOSS sends the job endpoint to planRoute with endOriginMapName: 'gaode'.
  const value = unique[0], point = { longitude: value.longitude!, latitude: value.latitude!, coordinateSystem: 'gcj02' as const };
  return { address: decodeBossText(value.address).slice(0, 1000), ...(isBossPoint(point) ? { point } : {}) };
}

/** Operate BOSS's own map controls and read their visible results. No copied map API key. */
export class BossMapService {
  private async open(page: CdpPage): Promise<void> {
    if (await page.locator(DIALOG).isVisible()) throw new Error('地图窗口正在使用，请先关闭后重试');
    const control = page.locator('.job-detail-box .job-address .map-box-wrapper, .job-location .js-open-map').filter({ visible: true }).first();
    if (!await control.isVisible({ timeout: 3000 })) throw new Error('BOSS 岗位没有可用的地图入口');
    try {
      await control.click();
      // Full job pages render their map control before the asynchronous handler is ready.
      const firstAttempt = Date.now() + 1500;
      while (Date.now() < firstAttempt && !await page.locator(DIALOG).isVisible()) await pause(150);
      if (!await page.locator(DIALOG).isVisible()) await control.click();
      await page.locator(DIALOG).waitFor({ timeout: 10000 });
      await page.locator(DIALOG + ' .start-point-select').waitFor({ timeout: 10000 });
    } catch (cause) {
      if (await page.locator(DIALOG).isVisible()) await this.close(page);
      throw new Error('BOSS 地图未能打开：' + (cause as Error).message);
    }
  }
  private async close(page: CdpPage): Promise<void> {
    const control = page.locator(DIALOG + ' .zp-close').filter({ visible: true }).first();
    if (await control.isVisible()) await control.click();
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && await page.locator(DIALOG).isVisible()) await pause(100);
    if (await page.locator(DIALOG).isVisible()) throw new Error('BOSS 地图未关闭，请先关闭地图');
  }
  private async suggestions(page: CdpPage, query: string, cityName: string): Promise<Array<CommuteOrigin & { domIndex: number }>> {
    const input = page.locator(DIALOG + ' .start-point-select input');
    if (!await input.isVisible()) await page.locator(DIALOG + ' .start-point-select').click();
    const search = query.startsWith(cityName) ? query : cityName + query;
    await input.fill(search);
    // BOSS debounces the address search; old suggestions must not become a different query's result.
    await pause(1100);
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const rows = await page.evaluate((q) => {
        const box = document.querySelector('.boss-map-commuting-dialog .path-plan-search') as any;
        const vm = box?.__vue__, input = box?.querySelector('.start-point-select input');
        if (!vm || input?.value !== q) return [];
        const dom = [...box.querySelectorAll('.search-address-list li')] as HTMLElement[];
        const list = vm.$data?.addressList;
        if (!Array.isArray(list) || list.length !== dom.length) return [];
        const mapperType = vm.getMapper?.()?.type;
        // Native suggestions use the active provider; never infer it from a URL/name.
        const coordinateSystem = mapperType === 1 ? 'bd09' : mapperType === 0 ? 'gcj02' : undefined;
        if (!coordinateSystem) return [];
        return list.map((item: any, index: number) => {
          const name = dom[index].querySelector('.address-title')?.textContent?.trim() || '';
          const address = dom[index].querySelector('.address-desc')?.textContent?.trim() || '';
          return name === item.name && address === String(item.desc || '').trim()
            ? { name, address, longitude: item.longitude, latitude: item.latitude, domIndex: index, coordinateSystem } : null;
        }).filter(Boolean);
      }, search);
      const valid = rows.map((row: any) => ({ ...row, cityName, query: search, source: 'boss' as const }))
        .filter((row: any): boolean => validCommuteOrigin(row));
      if (valid.length) return valid.slice(0, 20);
      await pause(250);
    }
    throw new Error('地图没有返回位置，请换成附近地铁站、楼宇或更完整的地址');
  }

  public async searchOrigins(page: CdpPage, query: string, cityName: string): Promise<CommuteOrigin[]> {
    let opened = false;
    try { await this.open(page); opened = true; return (await this.suggestions(page, query, cityName)).map(({ domIndex: _index, ...origin }) => origin); }
    finally { if (opened) await this.close(page); }
  }
  public async readTransit(page: CdpPage, origin: CommuteOrigin, expected: BossWorkAddress):
    Promise<{ minutes: number; summary: string }> {
    if (!validCommuteOrigin(origin) || !expected.point) throw new Error('出发点或岗位地图位置无效');
    if (!sameWorkAddress(await readBossWorkAddress(page), expected)) throw new Error('岗位工作地址已变化，需重新核对');
    let opened = false;
    try {
      await this.open(page); opened = true;
      await page.waitForFunction(() => {
        const vm = (document.querySelector('.boss-map-commuting-dialog .path-plan-search') as any)?.__vue__;
        return (vm?.mapLoaded ?? vm?.$props?.mapLoaded) === true && vm?.$data?.isFinish === true
          && Boolean(vm.$data.endAddress?.address) && typeof vm.selectStartPointAction === 'function'
          && [0, 1].includes(vm.getMapper?.()?.type);
      }, null, { timeout: 10000 });
      const native = await page.evaluate(() => {
        const vm = (document.querySelector('.boss-map-commuting-dialog .path-plan-search') as any)?.__vue__;
        const end = vm?.$data?.endAddress;
        return { mapperType: vm?.getMapper?.()?.type,
          end: end ? { longitude: end.longitude, latitude: end.latitude, address: end.address } : undefined };
      });
      if (!native.end || !sameWorkAddress({ address: native.end.address,
        point: { ...native.end, coordinateSystem: 'gcj02' } }, expected)) throw new Error('地图终点与岗位工作地址不同');
      const point = convertMapPoint(origin, native.mapperType === 1 ? 'bd09' : 'gcj02');
      // This is the site's own selected-POI handler. It also accepts a map/GPS point;
      // the source name need not be an exact search suggestion. It starts one route request.
      const selected = await page.evaluate(({ place, cityName }) => {
        const vm = (document.querySelector('.boss-map-commuting-dialog .path-plan-search') as any)?.__vue__;
        if (!(vm?.mapLoaded ?? vm?.$props?.mapLoaded) || !vm?.$data?.isFinish || typeof vm.selectStartPointAction !== 'function') return false;
        vm.currentPlanType = 'bus';
        vm.startCity = cityName;
        vm.selectStartPointAction(place);
        return true;
      }, { place: { name: origin.name, desc: origin.address, longitude: point.longitude, latitude: point.latitude }, cityName: origin.cityName });
      if (!selected) throw new Error('BOSS 地图的起点选择尚未就绪');
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const data = await page.evaluate(() => {
          const search = (document.querySelector('.boss-map-commuting-dialog .path-plan-search') as any)?.__vue__;
          const panel = (document.querySelector('.boss-map-commuting-dialog .path-plan-panel') as any)?.__vue__;
          const from = search?.$data?.startAddress, to = search?.$data?.endAddress;
          return { loading: panel?.$data?.isLoading !== false, mode: panel?.$data?.planType,
            mapperType: search?.getMapper?.()?.type,
            start: from ? { longitude: from.longitude, latitude: from.latitude, name: from.name } : undefined,
            end: to ? { longitude: to.longitude, latitude: to.latitude, address: to.address } : undefined,
            rows: [...document.querySelectorAll('.boss-map-commuting-dialog .path-plan-item')].map(row => ({
              time: row.querySelector('.path-plan-time')?.textContent?.trim() || '',
              lines: [...row.querySelectorAll('.plan-site-list li')].map(el => el.textContent?.trim()).filter(Boolean).join(' → '),
              description: row.querySelector('.path-plan-desc')?.textContent?.trim() || '' })),
            activeBus: Boolean(document.querySelector('.boss-map-commuting-dialog .path-way-bus.active')),
            security: /请完成安全验证|请进行安全验证/.test(document.body?.innerText || '') };
        });
        if (data.security) throw new Error('CAPTCHA_REQUIRED: BOSS 地图要求安全验证');
        const system: 'bd09' | 'gcj02' | undefined = data.mapperType === 1 ? 'bd09' : data.mapperType === 0 ? 'gcj02' : undefined;
        const start = data.start && system ? { ...data.start, coordinateSystem: system } : undefined;
        const end = data.end ? { ...data.end, coordinateSystem: 'gcj02' as const } : undefined;
        if (!data.loading && data.activeBus && data.start?.name === origin.name && sameBossPoint(start, origin)
          && data.end?.address.replace(/\s/g, '') === expected.address.replace(/\s/g, '') && sameBossPoint(end, expected.point)) {
          const plans = data.rows.map(row => ({ ...row, minutes: parseTransitMinutes(row.time) }))
            .filter((row): row is typeof row & { minutes: number } => row.minutes !== undefined).sort((a, b) => a.minutes - b.minutes);
          if (plans.length) return { minutes: plans[0].minutes,
            summary: [plans[0].lines, plans[0].description].filter(Boolean).join(' · ').slice(0, 500) };
        }
        await pause(250);
      }
      throw new Error('BOSS 地图暂无可核对的公交／地铁路线');
    } finally { if (opened) await this.close(page); }
  }
}
export const bossMapService = new BossMapService();
