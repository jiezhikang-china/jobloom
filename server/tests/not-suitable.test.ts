import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotSuitableStore, notSuitableStore } from '../src/services/not-suitable-store.js';
import { DeliveryService } from '../src/services/delivery.service.js';
import { bossPageService } from '../src/services/boss.page.service.js';
import { configManager } from '../src/config/config.manager.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-disinterest-'));
  const file = path.join(directory, 'blocked.json');
  const restores: Array<() => void> = [];
  const stub = (object: any, key: string, value: any) => { const old = object[key]; object[key] = value; restores.push(() => { object[key] = old; }); };
  try {
    const store = new NotSuitableStore(file);
    const target = { jobHref: '/job_detail/real-id_1.html?tracking=old', jobName: '客服', companyName: '被排除公司' };
    store.remember(target); store.remember({ ...target, jobHref: '/job_detail/real-id_1.html?tracking=new' });
    assert.equal(store.list().length, 1); assert.equal(store.list()[0].jobs.length, 1);
    const restarted = new NotSuitableStore(file);
    assert.equal(restarted.matches('/job_detail/another.html', '被排除 公司'), true, '同公司别的岗位也过滤');
    assert.equal(restarted.matches('/job_detail/real-id_1.html?new=1', '改名公司'), true, '岗位ID不受跟踪参数和展示公司名影响');
    assert.equal(restarted.matches('/job_detail/another.html', '被排除公司的供应商'), false, '不误封仅名称包含关键词的其他公司');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('tracking='));
    assert.deepEqual(Object.keys(store.list()[0]).sort(), ['companyName', 'id', 'jobs', 'updatedAt']);
    const cfg = configManager.getConfig();
    stub(configManager, 'getConfig', () => ({ ...cfg, delivery: { ...cfg.delivery, jobSource: 'search', dailyMaxQuota: 10 } }));
    stub(notSuitableStore, 'matches', (href: string, company: string) => store.matches(href, company));
    stub(stateManager, 'loadQuota', () => ({ date: todayStr(), count: 0 })); stub(stateManager, 'saveQuota', () => {});
    stub(bossPageService, 'initJobPage', async () => ({}));
    stub(bossPageService, 'getVisibleJobCards', async () => [{ ...target, companyName: target.companyName, salary: '', cityName: '上海', skills: [], cardLocator: {} }]);
    stub(bossPageService, 'isJobListPage', async () => true); stub(bossPageService, 'scrollDownForMore', async () => {});
    stub(bossPageService, 'loadJobDetail', async () => { throw new Error('已屏蔽公司不得重复读详情'); });
    const task = new DeliveryService();
    (task as any).sleepInterruptible = async () => true;
    await task.startDelivery({ targetRole: '客服', keywords: ['客服'], resumeText: '独立测试简历'.repeat(20) });
    assert.equal(task.getStats().totalScanned, 0); assert.equal(task.getStats().aiRequestCount, 0);
    store.remove(store.list()[0].id);
    assert.equal(store.matches(target.jobHref, target.companyName), false, '可撤销本地屏蔽');
    fs.writeFileSync(file, 'malformed');
    assert.throws(() => new NotSuitableStore(file).list(), /JSON/);
    console.log('PASS | 公司和岗位持久化屏蔽、跨重启/链接变化去重、同名包含不误封、零详情/AI重复筛选、可撤销、无私有理由保存');
  } finally {
    for (const restore of restores.reverse()) restore();
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
