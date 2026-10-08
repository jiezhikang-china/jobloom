import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserService } from '../src/services/browser.service.js';
import { BossExpectationsService, planExpectationChanges, readSavedExpectations } from '../src/services/boss-expectations.js';
import { positionSelections } from '../src/services/boss.catalog.service.js';
import catalog from '../resources/boss-positions.json';

const positions = positionSelections(catalog.categories);
const find = (name: string) => { const item = positions.find(item => item.name === name); assert.ok(item); return item; };
const initial = [
  { index: 0, position: '网络客服', city: '上海', salary: '7-8K' },
  { index: 1, position: '数据采集', city: '上海', salary: '9-10K' },
  { index: 2, position: '数据标注/AI训练师', city: '上海', salary: '9-10K' },
];

// Captured BOSS controls with synthetic data and local persistence. No real account or messages.
function editorFixture() {
  let rows = JSON.parse(localStorage.getItem('rows') || JSON.stringify((window as any).initial));
  const roles = (window as any).roles as typeof positions;
  document.addEventListener('click', event => {
    const key = event.isTrusted ? 'nativeClicks' : 'scriptClicks';
    localStorage.setItem(key, String(Number(localStorage.getItem(key) || 0) + 1));
  }, true);
  const root = document.querySelector('#purpose')!;
  const render = () => {
    root.innerHTML = '<a ka="user-resume-add-expectation">添加</a>' + rows.map((row: any) =>
      `<li ka="user-resume-edit-expectation${row.index}"><div class="expectation-list"><span class="position-item"><span class="label-text">${row.position}</span></span><span class="money-item">${row.salary}</span><span class="city-item">${row.city}</span></div><a ka="user-resume-edit-expectation${row.index}">编辑</a></li>`).join('');
    root.querySelectorAll('a[ka^="user-resume-edit-expectation"]').forEach((link: any) => link.onclick = () => edit(Number(link.getAttribute('ka').match(/\d+$/)[0])));
    (root.querySelector('[ka="user-resume-add-expectation"]') as HTMLElement).onclick = () => edit(rows.length);
  };
  const edit = (index: number) => {
    const row = rows[index] || { index, position: '', city: '', salary: '' };
    const form = document.createElement('div'); form.className = 'expectation-form';
    form.innerHTML = '<label class="radio-checked">全职</label><div ka="resume_form_edit_positionName"><input readonly></div>'
      + '<div class="salary-scope"><div class="ui-select-selection">薪资</div><div class="ui-select-dropdown" style="display:none"><li>面议</li></div></div>'
      + '<div ka="resume_form_edit_cityValue"><div class="ui-cascader"><div class="ui-cascader-selection"><input type="hidden"><input type="text" readonly></div>'
      + '<div class="ui-select-dropdown" style="display:none"><div class="ui-cascader-menu"><ul><li>热门城市</li></ul></div></div></div></div><button ka="resume_form_expectation_ok">完成</button>';
    root.append(form);
    const input = form.querySelector('[ka="resume_form_edit_positionName"] input') as HTMLInputElement; input.value = row.position;
    const cityHidden = form.querySelector('input[type="hidden"]') as HTMLInputElement;
    const cityInput = form.querySelector('input[type="text"]') as HTMLInputElement; cityInput.value = row.city;
    cityHidden.value = row.city ? '101020000,101020100,0' : '';
    const cityDrop = form.querySelector('[ka="resume_form_edit_cityValue"] .ui-select-dropdown') as HTMLElement;
    (form.querySelector('.ui-cascader-selection') as HTMLElement).onclick = () => { cityDrop.style.display = ''; };
    (cityDrop.querySelector('li') as HTMLElement).onclick = () => {
      const second = document.createElement('div'); second.className = 'ui-cascader-menu'; second.innerHTML = '<li>上海</li><li>杭州</li>';
      cityDrop.querySelector('.ui-cascader-menu')!.append(second);
      second.querySelectorAll('li').forEach((node: any) => node.onclick = () => {
        const city = node.textContent; const third = document.createElement('div'); third.className = 'ui-cascader-menu'; third.innerHTML = '<li>不限</li>';
        cityDrop.querySelector('.ui-cascader-menu')!.append(third);
        (third.querySelector('li') as HTMLElement).onclick = () => { cityInput.value = city; cityHidden.value = city === '杭州' ? '101210000,101210100,0' : '101020000,101020100,0'; cityDrop.style.display = 'none'; };
      });
    };
    (form.querySelector('.salary-scope .ui-select-selection') as HTMLElement).onclick = () => { (form.querySelector('.salary-scope .ui-select-dropdown') as HTMLElement).style.display = ''; };
    (form.querySelector('.salary-scope li') as HTMLElement).onclick = () => { row.salary = '面议'; };
    (form.querySelector('[ka="resume_form_edit_positionName"]') as HTMLElement).onclick = () => {
      const dialog = document.createElement('div'); dialog.className = 'position-dialog';
      const categories = [...new Set(roles.map(item => item.categoryName))];
      dialog.innerHTML = '<div class="position-category-wrap">' + categories.map(name => '<li>' + name + '</li>').join('') + '</div><div class="navs"></div><div class="position-list"></div>';
      document.body.append(dialog);
      dialog.querySelectorAll('.position-category-wrap li').forEach((node: any) => node.onclick = () => {
        const matching = roles.filter(item => item.categoryName === node.textContent);
        dialog.querySelector('.navs')!.innerHTML = [...new Set(matching.map(item => item.subcategoryName))].map(name => '<span class="stage-three">' + name + '</span>').join('');
        dialog.querySelectorAll('.stage-three').forEach((sub: any) => sub.onclick = () => {
          dialog.querySelector('.position-list')!.innerHTML = matching.filter(item => item.subcategoryName === sub.textContent).map(item => '<div class="position-tooltip">' + item.name + '</div>').join('');
          dialog.querySelectorAll('.position-tooltip').forEach((leaf: any) => leaf.onclick = () => { input.value = leaf.textContent; dialog.remove(); });
        });
      });
    };
    (form.querySelector('[ka="resume_form_expectation_ok"]') as HTMLElement).onclick = () => {
      rows[index] = { index, position: input.value, city: cityInput.value, salary: row.salary };
      localStorage.setItem('rows', JSON.stringify(rows)); localStorage.setItem('saves', String(Number(localStorage.getItem('saves') || 0) + 1)); render();
    };
  };
  render();
}

async function main() {
  const targets = ['新媒体运营', '数据采集', '数据标注/AI训练师'].map(find);
  const plans = planExpectationChanges(initial, targets, '上海');
  assert.deepEqual(plans.map(item => item.slot), [0, 1, 2]); assert.deepEqual(plans.map(item => item.changed), [true, false, false]);
  assert.throws(() => planExpectationChanges(initial, [targets[0], targets[0]], '上海'));
  assert.throws(() => planExpectationChanges(initial, [...targets, find('网络客服')], '上海'));
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const original = browserService.withExpectationEditor;
  try {
    const page = await browser.newPage();
    await page.addInitScript('window.__name = (fn) => fn');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    const roles = ['网络客服', '新媒体运营', '数据采集', '数据标注/AI训练师', '自动化测试'].map(find);
    const html = '<!doctype html><meta charset="utf-8"><style>li,span,a,button,input{display:inline-block;padding:6px} .position-dialog{position:fixed;inset:10px;background:white;overflow:auto}</style><div id="purpose"></div>'
      + '<script>window.initial=' + JSON.stringify(initial) + ';window.roles=' + JSON.stringify(roles) + ';(' + editorFixture.toString() + ')();</script>';
    await page.route('https://www.zhipin.com/web/geek/resume/', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
    (browserService as any).withExpectationEditor = async (callback: any) => { await page.goto('https://www.zhipin.com/web/geek/resume/'); return callback(page); };
    const service = new BossExpectationsService();
    assert.deepEqual(await service.configure(targets, { code: '101020100', name: '上海' }), targets.map(item => item.name + '(上海)'));
    assert.equal(await page.evaluate(() => localStorage.getItem('saves')), '1', '已有匹配项不应重复改写');
    assert.equal(await page.evaluate(() => localStorage.getItem('scriptClicks')), null, '自选编辑不再调用脚本点击');
    assert.ok(await page.evaluate(() => Number(localStorage.getItem('nativeClicks'))) >= 6, '编辑、分类选择和保存使用实际指针点击');
    const second = ['网络客服', '新媒体运营', '自动化测试'].map(find);
    await service.configure(second, { code: '101210100', name: '杭州' });
    const saved = await readSavedExpectations(page as any);
    assert.deepEqual(saved.map(item => item.position).sort(), second.map(item => item.name).sort());
    assert.ok(saved.every(item => item.city === '杭州')); assert.equal(await page.evaluate(() => localStorage.getItem('saves')), '4');
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('rows', '[]'); });
    await service.configure([find('网络客服')], { code: '101020100', name: '上海' });
    assert.deepEqual(await readSavedExpectations(page as any), [{ index: 0, position: '网络客服', city: '上海', salary: '面议' }]);
    assert.deepEqual(errors, [], '离线编辑页不能有脚本错误');
    console.log('PASS | 三个目标按官方层级原生点击编辑、保留匹配项、切换城市、新增位置、保存后重新读取验证');
  } finally { browserService.withExpectationEditor = original; await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
