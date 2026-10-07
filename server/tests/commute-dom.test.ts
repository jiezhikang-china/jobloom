import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { readBossWorkAddress } from '../src/services/boss-map.service.js';
import type { CdpPage } from '../src/services/cdp.page.js';

const fixture = `<!doctype html><meta charset="utf-8"><body>
  <div class="company-address">注册地址：另一座城市</div>
  <div class="job-location"><div class="location-address">上海徐汇区模速空间B区202</div>
    <button class="job-location-map js-open-map" data-lat="121.460828,31.158110">地图</button></div>
<script>window.mapClicks = 0; document.querySelector(".js-open-map").onclick = () => window.mapClicks++;</script></body>`;

async function main() {
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const page = await browser.newPage();
  const api = page as unknown as CdpPage;
  try {
    await page.setContent(fixture);
    const destination = await readBossWorkAddress(api);
    assert.equal(destination?.point?.longitude, 121.460828, 'BOSS data-lat 实际先经度，不能颠倒');
    assert.equal(destination?.point?.latitude, 31.158110);
    assert.equal(destination?.address, '上海徐汇区模速空间B区202', '注册地址不能代替工作地点');
    assert.equal(await page.evaluate(() => (window as any).mapClicks), 0, '读取工作坐标不打开地图，不触发路线查询');
    await page.setContent('<div class="job-detail-box"><div class="job-address"><span class="job-address-desc">上海工作地</span><button class="map-box-wrapper">地图</button></div></div>');
    await page.evaluate(() => { (document.querySelector('.map-box-wrapper') as any).__vue__ = { $props: { locationText: '另一个地址', location: { lng: 121.46, lat: 31.15 } } }; });
    assert.equal((await readBossWorkAddress(api))?.point, undefined, '列表缓存坐标的地址不一致，不能使用');
    await page.evaluate(() => { (document.querySelector('.map-box-wrapper') as any).__vue__.$props.locationText = '上海工作地'; });
    assert.equal((await readBossWorkAddress(api))?.point?.longitude, 121.46);
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="job-location"><span class="location-address">上海另一工作地</span><button class="job-location-map" data-lat="121.50,31.22">地图</button></div>'));
    assert.equal((await readBossWorkAddress(api))?.point, undefined, '多个工作地点需确认，不能自动取最近一个');
    console.log('PASS | 工作地点DOM、经纬度顺序、注册地址不混用、坐标对应地址、多个工作地点待确认、无地图点击');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
