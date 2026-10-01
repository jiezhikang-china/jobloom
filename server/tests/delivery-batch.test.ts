import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';
import { DeliveryService } from '../src/services/delivery.service.js';
import { bossPageService } from '../src/services/boss.page.service.js';
import { filterService } from '../src/services/filter.service.js';

const restores: Array<() => void> = [];
function stub(object: any, key: string, replacement: any): void {
  const original = object[key];
  object[key] = replacement;
  restores.push(() => { object[key] = original; });
}

async function main(): Promise<void> {
  const originalConfig = configManager.getConfig();
  const testConfig = {
    ...originalConfig,
    filter: {
      ...originalConfig.filter,
      cityCode: '101020100', cityName: '上海', salaryMin: undefined, salaryMax: undefined,
      experience: [], degree: [], hrActiveDaysLimit: 0, companyBlacklist: [],
    },
    delivery: { dailyMaxQuota: 1, minDelaySeconds: 0, maxDelaySeconds: 0 },
  };
  const cards = [
    { index: 0, jobHref: '/job_detail/a.html', jobName: '前端开发', companyName: '甲公司', cityName: '上海', salary: '15-25K', activeTimeDesc: '', experience: '3-5年', degree: '本科', skills: [], cardLocator: {} },
    { index: 1, jobHref: '/job_detail/b.html', jobName: '前端开发', companyName: '乙公司', cityName: '上海', salary: '20-30K', activeTimeDesc: '', experience: '3-5年', degree: '本科', skills: [], cardLocator: {} },
  ];
  let sent = 0;

  try {
    stub(configManager, 'getConfig', () => testConfig);
    stub(stateManager, 'loadQuota', () => ({ date: todayStr(), count: 0 }));
    stub(stateManager, 'saveQuota', () => {});
    const searches: any[][] = [];
    stub(bossPageService, 'initJobPage', async (...args: any[]) => { searches.push(args); return {}; });
    stub(bossPageService, 'getVisibleJobCards', async () => cards);
    stub(bossPageService, 'isCardStillTarget', async () => true);
    stub(bossPageService, 'isDetailStillTarget', async () => true);
    stub(bossPageService, 'loadJobDetail', async () => ({
      jobDetailText: '负责前端架构和复杂业务开发，需要多年 TypeScript 与 React 项目经验。',
      activeTimeDesc: '今日活跃', brandIndustry: '互联网', alreadyChatted: false, chatButtonLocator: {},
    }));
    stub(bossPageService, 'executeChatClick', async () => { sent++; return { success: true, greetingSent: true }; });
    stub(bossPageService, 'isJobListPage', async () => true);
    stub(bossPageService, 'scrollDownForMore', async () => {});
    stub(filterService, 'evaluateStage1', () => ({ passed: true }));
    stub(filterService, 'evaluateStage2', async () => ({ passed: true, score: 90, reason: '匹配', customGreeting: '你好' }));

    const service = new DeliveryService();
    await service.startDelivery({ targetRole: '前端开发', positionCode: '100901', keywords: ['前端开发'], resumeText: '完整简历'.repeat(20) });
    assert.deepEqual(searches[0], ['前端开发', '101020100', '100901']);
    assert.equal(sent, 1, '达到每日配额后不能处理同页的下一张卡片');
    assert.equal(service.getStats().todayAppliedCount, 1);
    assert.equal(service.getStats().status, 'finished');
    assert.equal(service.isActive(), false);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stub(bossPageService, 'initJobPage', async () => { await gate; return {}; });
    const second = new DeliveryService();
    const running = second.startDelivery({ targetRole: '前端开发', keywords: ['前端开发'], resumeText: '完整简历'.repeat(20) });
    assert.equal(second.isActive(), true);
    second.pause();
    await assert.rejects(
      second.startDelivery({ targetRole: '前端开发', keywords: ['前端开发'], resumeText: '完整简历'.repeat(20) }),
      /已经在运行中/
    );
    second.stop();
    release();
    await running;
    assert.equal(second.isActive(), false);
    assert.equal(second.getStats().status, 'idle');
    assert.equal(sent, 1, '停止期间不能再发送');

    stub(bossPageService, 'initJobPage', async () => ({}));
    stub(bossPageService, 'executeChatClick', async () => ({ success: false, uncertain: true }));
    const uncertain = new DeliveryService();
    await uncertain.startDelivery({ targetRole: '前端开发', keywords: ['前端开发'], resumeText: '完整简历'.repeat(20) });
    assert.equal(uncertain.getStats().status, 'failed', '沟通结果不确定时必须停止批量任务');
    assert.equal(uncertain.getStats().todayAppliedCount, 0, '未确认成功不能计入配额');

    process.stdout.write('PASS | 批量任务：同页配额、暂停时防重复启动、停止、未知发送结果熔断\n');
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
