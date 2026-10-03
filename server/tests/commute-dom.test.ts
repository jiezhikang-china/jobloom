import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { BossMapService, readBossWorkAddress } from '../src/services/boss-map.service.js';
import type { CdpPage } from '../src/services/cdp.page.js';
import { gcj02ToBd09 } from '../src/services/coordinates.js';

const fixture = `<!doctype html><meta charset="utf-8"><body>
  <div class="company-address">注册地址：另一座城市</div>
  <div class="job-location"><div class="location-address">上海徐汇区模速空间B区202</div>
    <button class="job-location-map js-open-map" data-lat="121.460828,31.158110">地图</button></div>
  <script>
    window.chosenIndex = -1;
    window.mapperType = 1; window.routeCalls = 0; window.searchCalls = 0;
    document.querySelector('.js-open-map').onclick = () => {
      const dialog = document.createElement('div'); dialog.className = 'boss-map-commuting-dialog';
      dialog.innerHTML = '<button class="zp-close">关闭</button><div class="path-plan-search">' +
        '<div class="start-point-select"><input></div><ul class="search-address-list"></ul></div>' +
        '<div class="path-plan-panel"><button class="path-way-bus active">公交</button></div>';
      document.body.appendChild(dialog);
      const search = dialog.querySelector('.path-plan-search'), panel = dialog.querySelector('.path-plan-panel');
      const places = [{ name: '无效旧位置', desc: '缺少坐标' },
        { name: '人民广场', desc: '上海市黄浦区人民大道185号', longitude: 121.481492, latitude: 31.234736 }];
      const data = { addressList: [], isFinish: true, startCity: '北京市', currentPlanType: 'drive',
        endAddress: { address: '上海徐汇区模速空间B区202', longitude: 121.460828, latitude: 31.158110 } };
      search.__vue__ = { getMapper: () => ({ type: window.mapperType }), $props: { mapLoaded: true }, $data: data,
        get startCity() { return data.startCity; }, set startCity(value) { data.startCity = value; },
        get currentPlanType() { return data.currentPlanType; }, set currentPlanType(value) { data.currentPlanType = value; },
        selectStartPointAction(place) {
          window.routeCalls++; data.startAddress = place;
          window.selectedPoint = place; window.selectedCity = data.startCity; window.selectedMode = data.currentPlanType;
          panel.__vue__.$data.isLoading = true;
          setTimeout(() => {
            panel.__vue__.$data.isLoading = false;
            panel.innerHTML = '<button class="path-way-bus active">公交</button>' +
              '<div class="path-plan-item"><span class="path-plan-time">1小时11分钟</span><ul class="plan-site-list"><li>慢线</li></ul></div>' +
              '<div class="path-plan-item"><span class="path-plan-time">49分钟</span><ul class="plan-site-list"><li>8号线</li><li>11号线</li></ul><div class="path-plan-desc">9站 · 步行1.6千米</div></div>';
          }, 100);
        } };
      panel.__vue__ = { $data: { isLoading: true } };
      dialog.querySelector('input').oninput = () => {
        window.searchCalls++;
        search.__vue__.$data.addressList = places;
        const list = dialog.querySelector('ul'); list.innerHTML = '';
        places.forEach((place, index) => {
          const row = document.createElement('li'); row.innerHTML = '<b class="address-title">' + place.name + '</b><span class="address-desc">' + place.desc + '</span>';
          row.onclick = () => {
            window.chosenIndex = index; search.__vue__.selectStartPointAction(place);
          }; list.appendChild(row);
        });
      };
      dialog.querySelector('.zp-close').onclick = () => setTimeout(() => dialog.remove(), 200);
    };
  </script></body>`;

async function main() {
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const page = await browser.newPage();
  const api = page as unknown as CdpPage, maps = new BossMapService();
  try {
    await page.setContent(fixture);
    const destination = await readBossWorkAddress(api);
    assert.equal(destination?.point?.longitude, 121.460828, 'BOSS data-lat 实际先经度，不能颠倒');
    assert.equal(destination?.point?.latitude, 31.158110);
    assert.equal(destination?.address, '上海徐汇区模速空间B区202', '注册地址不能代替工作地点');
    const origins = await maps.searchOrigins(api, '人民广场', '上海');
    assert.equal(origins.length, 1, '无坐标的旧候选不能作为出发位置');
    assert.equal(origins[0].query, '上海人民广场');
    assert.equal(await page.locator('.boss-map-commuting-dialog').isVisible(), false, '等待关闭动画结束');
    const route = await maps.readTransit(api, origins[0], destination!);
    assert.equal(route.minutes, 49);
    assert.match(route.summary, /8号线 → 11号线.*步行1.6千米/);
    assert.equal(await page.evaluate(() => (window as any).routeCalls), 1, '原生起点选择只发起一次路线查询');
    assert.equal(await page.evaluate(() => (window as any).searchCalls), 1, '已保存的出发点不用重复地址搜索');
    assert.equal(await page.evaluate(() => (window as any).selectedCity), '上海', '不能沿用地图默认的北京市');
    assert.equal(await page.evaluate(() => (window as any).selectedMode), 'bus', '用户地图上次选择驾车时也应查询公交');
    assert.equal(await page.locator('.boss-map-commuting-dialog').isVisible(), false);

    const manual = { ...origins[0], name: '任意地图选点', query: '自定义出发点', source: 'openstreetmap' as const,
      longitude: 121.47, latitude: 31.20, coordinateSystem: 'gcj02' as const };
    assert.equal((await maps.readTransit(api, manual, destination!)).minutes, 49, '不在原生搜索候选中的地图坐标也能查询');
    const selected = await page.evaluate(() => (window as any).selectedPoint);
    const converted = gcj02ToBd09(manual.longitude, manual.latitude);
    assert.ok(Math.abs(selected.longitude - converted[0]) < 1e-8 && Math.abs(selected.latitude - converted[1]) < 1e-8,
      '原生地图是百度时，公共地图起点须转换 BD09');
    await page.evaluate(() => { (window as any).mapperType = 0; });
    await maps.readTransit(api, manual, destination!);
    assert.equal((await page.evaluate(() => (window as any).selectedPoint)).longitude, manual.longitude, '高德原生地图直接使用 GCJ02');
    assert.equal(await page.evaluate(() => (window as any).searchCalls), 1, '地图选点的路线不调用公共或原生地理编码');
    await page.evaluate(() => {
      const button = document.querySelector('.js-open-map') as HTMLButtonElement, open = button.onclick;
      button.onclick = null; setTimeout(() => { button.onclick = open; }, 300);
    });
    assert.equal((await maps.searchOrigins(api, '人民广场', '上海'))[0].name, '人民广场', '地图按钮早于事件初始化时，等待后重新打开');
    assert.equal(await page.locator('.boss-map-commuting-dialog').isVisible(), false);
    await assert.rejects(maps.readTransit(api, origins[0], { ...destination!, address: '过期地址' }), /地址已变化/);
    assert.equal(await page.locator('.boss-map-commuting-dialog').count(), 0, '旧工作地点不能查询路线');

    await page.setContent('<div class="job-detail-box"><div class="job-address"><span class="job-address-desc">上海工作地</span><button class="map-box-wrapper">地图</button></div></div>');
    await page.evaluate(() => { (document.querySelector('.map-box-wrapper') as any).__vue__ = { $props: { locationText: '另一个地址', location: { lng: 121.46, lat: 31.15 } } }; });
    assert.equal((await readBossWorkAddress(api))?.point, undefined, '列表缓存坐标的地址不一致，不能使用');
    await page.evaluate(() => { (document.querySelector('.map-box-wrapper') as any).__vue__.$props.locationText = '上海工作地'; });
    assert.equal((await readBossWorkAddress(api))?.point?.longitude, 121.46);
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="job-location"><span class="location-address">上海另一工作地</span><button class="job-location-map" data-lat="121.50,31.22">地图</button></div>'));
    assert.equal((await readBossWorkAddress(api))?.point, undefined, '多个工作地点需确认，不能自动取最近一个');
    console.log('PASS | 实际地图DOM、地图选点原生路线、BD09/GCJ02转换、城市与公交模式、一次查询、不重复搜地址、工作地点与关闭动画');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
