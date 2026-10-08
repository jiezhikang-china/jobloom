import { browserService } from './browser.service.js';
import type { CdpPage } from './cdp.page.js';
import type { BossPositionSelection } from '../types.js';
import { clickBossAction } from './boss-action-scheduler.js';

export interface SavedExpectation { index: number; position: string; city: string; salary: string; }
export interface ExpectationChange { target: BossPositionSelection; slot: number; existing?: SavedExpectation; changed: boolean; }
export const MAX_EXPECTATIONS = 3;

/** Reserve already matching slots before replacing any unmatched slot. Never delete an expectation. */
export function planExpectationChanges(existing: SavedExpectation[], targets: BossPositionSelection[], city: string): ExpectationChange[] {
  if (!targets.length || targets.length > MAX_EXPECTATIONS || new Set(targets.map(item => item.code)).size !== targets.length) {
    throw new Error('请选择1至3个不同的 BOSS 官方目标岗位');
  }
  const used = new Set<number>();
  const plans = targets.map(target => {
    const match = existing.find(item => !used.has(item.index) && item.position === target.name && item.city === city);
    if (match) used.add(match.index);
    return { target, existing: match, slot: match?.index ?? -1, changed: !match };
  });
  for (const plan of plans.filter(item => item.changed)) {
    const previous = existing.find(item => !used.has(item.index) && item.position === plan.target.name)
      || existing.find(item => !used.has(item.index));
    const slot = previous?.index ?? Array.from({ length: MAX_EXPECTATIONS }, (_, index) => index).find(index => !used.has(index));
    if (slot === undefined) throw new Error('BOSS 自选岗位位置不足，已停止设置');
    plan.existing = previous; plan.slot = slot; used.add(slot);
  }
  return plans;
}

export async function readSavedExpectations(page: CdpPage): Promise<SavedExpectation[]> {
  return page.evaluate(() => [...document.querySelectorAll('#purpose li[ka^="user-resume-edit-expectation"]')]
    .map(item => ({ index: Number(item.getAttribute('ka')?.match(/(\d+)$/)?.[1]),
      position: item.querySelector('.position-item .label-text')?.textContent?.trim() || '',
      city: item.querySelector('.city-item')?.textContent?.trim() || '',
      salary: item.querySelector('.money-item')?.textContent?.trim() || '' }))
    .filter(item => Number.isInteger(item.index) && item.position && item.salary)); // Full-time rows include a salary.
}

async function clickText(page: CdpPage, selector: string, text: string): Promise<void> {
  await page.waitForFunction(({ selector, text }) => [...document.querySelectorAll(selector)]
    .some(node => node.textContent?.trim() === text && (node as HTMLElement).getBoundingClientRect().width > 0), { selector, text }, { timeout: 4000 });
  const nodes = await page.locator(selector).evaluateAll(items => items.map((node, index) => ({ index,
    text: node.textContent?.trim(), visible: (node as HTMLElement).getBoundingClientRect().width > 0,
    disabled: node.getAttribute('aria-disabled') === 'true' || (node instanceof HTMLButtonElement && node.disabled) })));
  const matches = nodes.filter(node => node.visible && !node.disabled && node.text === text);
  if (matches.length !== 1) throw new Error('BOSS 设置选项未找到或不唯一：' + text);
  await clickBossAction(page.locator(selector).nth(matches[0].index), 'control');
}

async function hoverText(page: CdpPage, selector: string, text: string): Promise<void> {
  await page.waitForFunction(({ selector, text }) => [...document.querySelectorAll(selector)]
    .some(node => node.textContent?.trim() === text && (node as HTMLElement).getBoundingClientRect().width > 0), { selector, text }, { timeout: 4000 });
  const indices = await page.locator(selector).evaluateAll(nodes => nodes.map((node, index) => ({
    index, text: node.textContent?.trim(), visible: Boolean((node as HTMLElement).getClientRects().length),
  })));
  const matches = indices.filter(item => item.visible && item.text === text);
  if (matches.length !== 1) throw new Error('BOSS 岗位分类未找到或不唯一：' + text + '（匹配' + matches.length + '项）');
  await page.locator(selector).nth(matches[0].index).hover();
  await clickText(page, selector, text);
}

export class BossExpectationsService {
  async configure(targets: BossPositionSelection[], city: { code: string; name: string },
    options: { signal?: AbortSignal; onChange?: (message: string) => void } = {}): Promise<string[]> {
    if (!city.code || !city.name) throw new Error('请先选择目标城市');
    return browserService.withExpectationEditor(async page => {
      await page.waitForFunction(() => Boolean(document.querySelector('#purpose li[ka^="user-resume-edit-expectation"], #purpose [ka="user-resume-add-expectation"]')), null, { timeout: 15000 });
      const existing = await readSavedExpectations(page);
      const plans = planExpectationChanges(existing, targets, city.name);
      if (plans.some(plan => plan.changed)) await page.bringToFront();
      for (const plan of plans) {
        options.signal?.throwIfAborted();
        if (!plan.changed) { options.onChange?.('自选岗位已符合目标：' + plan.target.name + '（' + city.name + '）'); continue; }
        if (plan.existing) {
          const row = page.locator(`#purpose li[ka="user-resume-edit-expectation${plan.slot}"]`);
          await row.hover();
          await clickBossAction(page.locator(`#purpose a[ka="user-resume-edit-expectation${plan.slot}"]`), 'control');
        } else {
          await clickBossAction(page.locator('#purpose [ka="user-resume-add-expectation"]'), 'control');
        }
        const form = page.locator('#purpose .expectation-form').filter({ visible: true }).first();
        await form.waitFor({ timeout: 5000 });
        const selectedType = await form.locator('.radio-checked').innerText();
        if (!selectedType.includes('全职')) await clickText(page, '#purpose .expectation-form label.radio', '全职');
        await clickBossAction(form.locator('[ka="resume_form_edit_positionName"]'), 'control');
        await page.locator('.position-dialog').filter({ visible: true }).first().waitFor({ timeout: 5000 });
        await hoverText(page, '.position-dialog .position-category-wrap li', plan.target.categoryName);
        await page.waitForFunction(({ name }) => [...document.querySelectorAll('.position-dialog .navs .stage-three')]
          .some(node => node.textContent?.trim() === name && (node as HTMLElement).getClientRects().length), { name: plan.target.subcategoryName }, { timeout: 4000 });
        await hoverText(page, '.position-dialog .navs .stage-three', plan.target.subcategoryName);
        await page.waitForFunction(({ name }) => [...document.querySelectorAll('.position-dialog .position-list .position-tooltip')]
          .some(node => node.textContent?.trim() === name && (node as HTMLElement).getClientRects().length), { name: plan.target.name }, { timeout: 4000 });
        await clickText(page, '.position-dialog .position-list .position-tooltip', plan.target.name);
        await page.waitForFunction(({ name }) => (document.querySelector('#purpose [ka="resume_form_edit_positionName"] input') as HTMLInputElement | null)?.value === name,
          { name: plan.target.name }, { timeout: 4000 });
        options.signal?.throwIfAborted();
        const cityValue = await form.locator('[ka="resume_form_edit_cityValue"] input[type="hidden"]').inputValue();
        if (!cityValue.split(',').includes(city.code)) {
          await clickBossAction(form.locator('[ka="resume_form_edit_cityValue"] .ui-cascader-selection'), 'control');
          await clickText(page, '#purpose [ka="resume_form_edit_cityValue"] .ui-cascader > .ui-select-dropdown > .ui-cascader-menu:first-child li', '热门城市');
          await page.waitForFunction(({ name }) => [...document.querySelectorAll('#purpose [ka="resume_form_edit_cityValue"] .ui-cascader-menu:nth-child(2) li')]
            .some(node => node.textContent?.trim() === name), { name: city.name }, { timeout: 3000 });
          await clickText(page, '#purpose [ka="resume_form_edit_cityValue"] .ui-cascader-menu:nth-child(2) li', city.name);
          await page.waitForFunction(() => Boolean(document.querySelector('#purpose [ka="resume_form_edit_cityValue"] .ui-cascader-menu:nth-child(3) li')), null, { timeout: 3000 });
          await clickText(page, '#purpose [ka="resume_form_edit_cityValue"] .ui-cascader-menu:nth-child(3) li', '不限');
        }
        // A new slot must have a salary; 面议 keeps the app's configurable salary filter in charge.
        if (!plan.existing) {
          await clickBossAction(form.locator('.salary-scope .ui-select-selection').first(), 'control');
          await clickText(page, '#purpose .salary-scope .ui-select-dropdown li', '面议');
        }
        const input = await form.locator('[ka="resume_form_edit_positionName"] input').inputValue();
        const actualCity = await form.locator('[ka="resume_form_edit_cityValue"] input[type="hidden"]').inputValue();
        if (input !== plan.target.name || !actualCity.split(',').includes(city.code)) throw new Error('BOSS 自选岗位设置未生效，已停止保存');
        options.signal?.throwIfAborted();
        await clickBossAction(form.locator('[ka="resume_form_expectation_ok"]'), 'submit');
        await page.waitForFunction(({ role, city }) => !document.querySelector('#purpose .expectation-form')
          && [...document.querySelectorAll('#purpose .expectation-list')].some(node => node.querySelector('.position-item .label-text')?.textContent?.trim() === role
            && node.querySelector('.city-item')?.textContent?.trim() === city), { role: plan.target.name, city: city.name }, { timeout: 10000 });
        options.onChange?.('已保存 BOSS 自选岗位：' + plan.target.name + '（' + city.name + '）');
      }
      // Reload from BOSS to confirm persistence, rather than trusting the edited input.
      options.signal?.throwIfAborted();
      await page.goto('https://www.zhipin.com/web/geek/resume/');
      await page.waitForFunction(() => Boolean(document.querySelector('#purpose .expectation-list')), null, { timeout: 10000 });
      const saved = await readSavedExpectations(page);
      if (!targets.every(target => saved.some(item => item.position === target.name && item.city === city.name))) {
        throw new Error('BOSS 未持久保存全部目标岗位，投递已停止；请查看自选岗位设置');
      }
      return targets.map(target => target.name + '(' + city.name + ')');
    });
  }
}

export const bossExpectationsService = new BossExpectationsService();
