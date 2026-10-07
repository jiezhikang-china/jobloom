import type { BossWorkAddress } from '../types.js';
import type { CdpPage } from './cdp.page.js';
import { isBossPoint } from './commute.js';
import { decodeBossText } from './boss-text.js';


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
