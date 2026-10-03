import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';
import { DeliveryService } from '../src/services/delivery.service.js';
import { bossPageService, type DOMJobCardInfo, type JobDetailData } from '../src/services/boss.page.service.js';
import { llmService } from '../src/services/llm.service.js';
import { notSuitableStore } from '../src/services/not-suitable-store.js';
import { workConditionReviews } from '../src/services/work-condition-reviews.js';
import { sameJobLink } from '../src/services/job-identity.js';

const restores: Array<() => void> = [];
function stub(object: any, key: string, replacement: any) {
  const original = object[key]; object[key] = replacement; restores.push(() => { object[key] = original; });
}
const cfg = configManager.getConfig();
const config = { ...cfg, llm: { ...cfg.llm, jobBatchSize: 3 }, filter: { ...cfg.filter,
  cityName: '上海', cityCode: '101020100', salaryMin: 3, salaryMax: 10, degree: ['本科'],
  experience: [], hrActiveDaysLimit: 0, companyBlacklist: ['金融'], requiredKeywords: [], commute: {},
  skipMissingCompanyIntro: false, skipVagueJobDescription: false, minLlmMatchScore: 75,
  workRequirements: [{ id: 'hours', text: '每天工作不超过八小时', enabled: true }] },
  delivery: { dailyMaxQuota: 2, minDelaySeconds: 0, maxDelaySeconds: 0 } };
const preview = (key: string): DOMJobCardInfo => ({ index: 0,
  jobHref: '/job_detail/preview-' + key + '.html', jobName: '银行销售', companyName: '卡片金融',
  salary: '1-2K', degree: '博士', experience: '5-10年', cityName: '北京', activeTimeDesc: '',
  skills: ['卡片过时标签'], cardLocator: { key } as any });
const cards = ['good', 'blocked', 'review'].map(preview);
const actual = (key: string): JobDetailData => ({
  jobHref: 'https://www.zhipin.com/job_detail/actual-' + key + '.html', jobName: '行政助理（详情）',
  companyName: '详情公司-' + key, salary: '6-8K', degree: '大专', experience: '经验不限', cityName: '上海', skills: ['文书'] });
let currentHref = '';
let aiCalls = 0;
const opened: string[] = [], applied: any[] = [], reviews: any[] = [], rejected: any[] = [];

async function main() {
  stub(configManager, 'getConfig', () => config);
  stub(stateManager, 'loadQuota', () => ({ date: todayStr(), count: 0 }));
  stub(stateManager, 'saveQuota', () => {});
  stub(notSuitableStore, 'matches', () => false);
  stub(workConditionReviews, 'add', (review: any) => { reviews.push(review); });
  stub(workConditionReviews, 'removeForJob', () => {});
  stub(bossPageService, 'initJobPage', async () => ({}));
  stub(bossPageService, 'getVisibleJobCards', async () => cards);
  stub(bossPageService, 'isJobListPage', async () => true);
  stub(bossPageService, 'scrollDownForMore', async () => {});
  stub(bossPageService, 'isCardStillTarget', async (locator: any, _name: string, _company: string, href: string) =>
    sameJobLink(href, '/job_detail/preview-' + locator.key + '.html'));
  stub(bossPageService, 'isDetailStillTarget', async (_name: string, _company: string, href: string) => sameJobLink(currentHref, href));
  stub(bossPageService, 'loadJobDetail', async (locator: any) => {
    opened.push(locator.key);
    const detailData = actual(locator.key);
    if (locator.key === 'good' && opened.filter(key => key === 'good').length > 1) {
      detailData.jobName = '行政助理（急招）'; detailData.companyName = '详情公司-good正式名称';
    }
    currentHref = detailData.jobHref;
    return { detailData, activeTimeDesc: '今日活跃', brandIndustry: '企业服务', alreadyChatted: false,
      jobDetailText: '负责行政资料整理与文档归档。' + (locator.key === 'review' ? '具体作息面议。' : '每天工作8小时。'),
      companyInfo: { url: 'https://www.zhipin.com/gongsi/' + locator.key + '.html', name: detailData.companyName,
        industry: '企业服务', introduction: locator.key === 'blocked' ? '公司主营助贷服务与贷款撮合。' : '公司提供文档整理服务。',
        businessScope: '文书服务。', checkedAt: new Date().toISOString() }, chatButtonLocator: { key: locator.key } };
  });
  stub(bossPageService, 'markJobNotSuit', async (_card: any, target: any) => { rejected.push(target); return true; });
  stub(bossPageService, 'executeChatClick', async (button: any, _greeting: string, target: any) => {
    assert.equal(target.jobHref, currentHref);
    assert.deepEqual(target, { jobHref: actual(button.key).jobHref, jobName: '行政助理（急招）', companyName: '详情公司-good正式名称' },
      '详情标题展示词或公司全称更新后，发送也采用最新详情');
    applied.push(target); return { success: true, greetingSent: true };
  });
  stub(llmService, 'chatJson', async (messages: any[], _retries: number, options: any) => {
    aiCalls++; options.onRequest();
    const jobs = JSON.parse(messages[1].content.split('【待评估岗位列表（逐个评估）】：\n')[1]);
    assert.deepEqual(jobs.map((job: any) => job.companyName), ['详情公司-good', '详情公司-review']);
    assert.ok(jobs.every((job: any) => job.jobName === '行政助理（详情）'), 'AI 应读取详情标题');
    assert.doesNotMatch(messages[1].content, /银行销售|卡片金融|1-2K|博士|过时标签/, '不能把卡片的旧信息传给 AI');
    // Changing a preview after AI evaluation must not invalidate unchanged real details.
    cards[0].jobName = '另一个卡片标题'; cards[0].companyName = '卡片别名'; cards[0].salary = '50-80K';
    return { jobs: jobs.map((job: any) => ({ jobKey: job.jobKey, passed: true, score: 90,
      customGreeting: '您好', workRequirements: [{ requirementId: 'hours', status: job.companyName.endsWith('review') ? 'unknown' : 'met',
        evidence: job.companyName.endsWith('review') ? '作息面议' : '每天工作8小时' }] })) };
  });

  const service = new DeliveryService();
  await service.startDelivery({ targetRole: '行政助理', keywords: ['行政'],
    resumeText: '详情优先测试：擅长文档归档和行政工作。' + Date.now(), candidateSource: 'resume' });
  assert.equal(service.getStats().status, 'finished');
  assert.equal(aiCalls, 1, '本地淘汰后，剩余岗位只批量请求一次');
  assert.equal(applied.length, 1);
  assert.equal(rejected[0].companyName, '详情公司-blocked', '助贷排除应针对真实详情公司');
  assert.deepEqual(reviews.map(item => [item.jobHref, item.jobName, item.companyName, item.salary]), [
    [actual('review').jobHref, actual('review').jobName, actual('review').companyName, '6-8K'] ], '待确认记录也使用真实详情');
  assert.equal(opened.filter(key => key === 'good').length, 2, 'AI 通过后重新读取最新详情');
  assert.equal(opened.filter(key => key === 'blocked').length, 1, '明确助贷岗位无需请求 AI');
  assert.equal(cards[1].companyName, '卡片金融', '读取详情不能改写浏览器列表快照');
  console.log('PASS | 详情覆盖卡片、实际链接/学历/薪资/城市初筛、助贷本地排除、AI与待确认读取详情、卡片更新不否定同一详情');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { restores.reverse().forEach(restore => restore()); });
