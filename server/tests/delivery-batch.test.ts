import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';
import { DeliveryService } from '../src/services/delivery.service.js';
import { bossPageService } from '../src/services/boss.page.service.js';
import { filterService } from '../src/services/filter.service.js';
import { workConditionReviews } from '../src/services/work-condition-reviews.js';

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

    let queued = 0;
    let marked = 0;
    let evaluated = 0;
    testConfig.filter.workRequirements = [{ id: 'hours', text: '每天工作不超过八小时', enabled: true, builtin: 'eightHours' }];
    stub(workConditionReviews, 'removeForJob', () => {});
    stub(workConditionReviews, 'add', (input: any) => { queued++; assert.equal(input.jobHref, cards[0].jobHref); });
    stub(bossPageService, 'markJobNotSuit', async () => { marked++; return true; });
    stub(filterService, 'evaluateStage2', async () => {
      evaluated++;
      return evaluated === 1
        ? { passed: false, score: 99, reason: '缺少工时依据', customGreeting: '', needsReview: true,
          requirementAssessment: [{ requirementId: 'hours', text: '每天工作不超过八小时', status: 'unknown', evidence: '' }] }
        : { passed: true, score: 90, reason: '匹配', customGreeting: '你好' };
    });
    const reviewing = new DeliveryService();
    await reviewing.startDelivery({ targetRole: '行政助理', keywords: ['双休'], resumeText: '八小时双休允许无经验。', candidateSource: 'requirements' });
    assert.equal(queued, 1, '信息不足的岗位必须进入待确认列表');
    assert.equal(marked, 0, '待确认岗位不能点击网站的不合适按钮');
    assert.equal(sent, 2, '本次只发送第二个符合条件的岗位');
    assert.equal(reviewing.getStats().todayAppliedCount, 1, '待确认不占投递配额');
    stub(filterService, 'evaluateStage2', async () => ({ passed: true, score: 90, reason: '匹配', customGreeting: '你好' }));

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
    assert.equal(sent, 2, '停止期间不能再发送');

    stub(bossPageService, 'initJobPage', async () => ({}));
    stub(bossPageService, 'executeChatClick', async () => ({ success: false, uncertain: true }));
    const uncertain = new DeliveryService();
    await uncertain.startDelivery({ targetRole: '前端开发', keywords: ['前端开发'], resumeText: '完整简历'.repeat(20) });
    assert.equal(uncertain.getStats().status, 'failed', '沟通结果不确定时必须停止批量任务');
    assert.equal(uncertain.getStats().todayAppliedCount, 0, '未确认成功不能计入配额');

    process.stdout.write('PASS | 批量任务：待确认不投递不标记、同页配额、暂停时防重复启动、停止、未知发送结果熔断\n');
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
