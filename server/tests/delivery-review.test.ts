import assert from 'node:assert/strict';
import express from 'express';
import { apiRouter } from '../src/routes/api.router.js';
import { configManager } from '../src/config/config.manager.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';
import { DeliveryService, deliveryService } from '../src/services/delivery.service.js';
import { bossPageService } from '../src/services/boss.page.service.js';
import { browserService } from '../src/services/browser.service.js';
import { workConditionReviews } from '../src/services/work-condition-reviews.js';
import { llmService } from '../src/services/llm.service.js';
import type { BossJobItem, WorkConditionReview } from '../src/types.js';
import { jobCommuteService } from '../src/services/job-commute.service.js';
import { isolateBossSafety } from './fixtures/safety.js';

const restores: Array<() => void> = [];
function stub(object: any, key: string, replacement: any) { const previous = object[key]; object[key] = replacement; restores.push(() => { object[key] = previous; }); }
const original = configManager.getConfig();
let config = { ...original, filter: { ...original.filter, cityName: '', candidateLanguages: '', salaryMin: 0, salaryMax: 0,
  degree: [], experience: [], hrActiveDaysLimit: 0, companyBlacklist: ['金融'], requiredKeywords: [],
  skipMissingCompanyIntro: false, skipVagueJobDescription: false,
  commute: {},
  workRequirements: [{ id: 'hours', text: '每天工作不超过八小时', enabled: true }] },
  delivery: { ...original.delivery, dailyMaxQuota: 2 } };
const make = (n: number): WorkConditionReview => ({ id: n.toString(16).padStart(20, '0'), jobHref: 'https://www.zhipin.com/job_detail/review' + n + '.html',
  jobName: '内容运营' + n, companyName: '测试公司' + n, salary: '6-8K', reason: '每天工作不超过八小时需确认',
  requirements: config.filter.workRequirements, assessment: [{ requirementId: 'hours', text: '每天工作不超过八小时', status: 'unknown', evidence: '' }],
  question: '具体时间待询问', updatedAt: new Date().toISOString(), evaluationSource: 'ai', score: 52,
  screening: { industry: '计算机软件', jobDetail: '负责中文游戏内容运营，时间安排面议。', skills: [] } });
const job = (review: WorkConditionReview): BossJobItem => ({ securityId: '', jobId: '', lid: '', jobName: review.jobName, brandName: review.companyName,
  cityName: '上海', salaryDesc: '6-8K', jobExperience: '1-3年', jobDegree: '大专', brandIndustry: '计算机软件', skills: [],
  activeTimeDesc: '今日活跃', areaDistrict: '', brandScaleName: '', bossName: '', bossTitle: '', welfareList: [] });
let records: WorkConditionReview[] = []; const sends: string[] = []; const opened: string[] = []; const chronology: string[] = [];
let active = false; let loggedIn = true; let sendResult: any = { success: true, verified: true, platformGreeting: true, continued: true };
let detailFor: (review: WorkConditionReview) => any = review => ({ job: job(review), jobDetailText: review.screening!.jobDetail, alreadyChatted: false, chatButtonLocator: {} });
async function main() {
  restores.push(isolateBossSafety());
  stub(configManager, 'getConfig', () => config);
  stub(stateManager, 'loadQuota', () => ({ date: todayStr(), count: 0 })); stub(stateManager, 'saveQuota', () => {});
  stub(llmService, 'chatJson', async () => { throw new Error('手动选择的已评估岗位不应重复问AI'); });
  stub(workConditionReviews, 'listEligible', () => records);
  stub(workConditionReviews, 'remove', (id: string) => { records = records.filter(item => item.id !== id); });
  stub(workConditionReviews, 'removeForJob', (href: string) => { records = records.filter(item => item.jobHref !== href); });
  stub(browserService, 'checkLoginStatus', async () => ({ isLoggedIn: loggedIn, reasonCode: loggedIn ? undefined : 'login_required' }));
  stub(browserService, 'withReviewApplication', async (href: string, apply: any) => { opened.push(href); chronology.push('open:' + href); return apply({}); });
  stub(bossPageService, 'loadReviewJob', async (_page: any, review: WorkConditionReview) => detailFor(review));
  stub(bossPageService, 'executeChatClick', async (_button: any, greeting: string, review: WorkConditionReview) => {
    assert.notEqual(greeting, review.question, '直接发起岗位沟通，不把询问内容当作投递动作');
    sends.push(review.jobHref); chronology.push('send:' + review.jobHref); return sendResult;
  });
  stub(deliveryService, 'isActive', () => active);
  const queued: WorkConditionReview[][] = [];
  stub(deliveryService, 'startReviewDelivery', async (items: WorkConditionReview[]) => { queued.push(items); });
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/delivery/work-condition-reviews/apply';
  const post = async (ids: unknown) => { const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }); return response.status; };
  try {
    records = [make(1), make(2)];
    assert.equal(await post([]), 400); assert.equal(await post(['../file']), 400);
    assert.equal(await post([records[0].id, records[0].id]), 400);
    assert.equal(await post([make(9).id]), 400, '只能投递当前可选的待确认记录');
    active = true; assert.equal(await post([records[0].id]), 409); active = false;
    loggedIn = false; assert.equal(await post([records[0].id]), 401); loggedIn = true;
    assert.equal(await post(records.map(item => item.id)), 200); assert.equal(queued.length, 1); assert.equal(queued[0].length, 2);
    config.delivery.dailyMaxQuota = 0; assert.equal(await post([records[0].id]), 400); config.delivery.dailyMaxQuota = 2;

    records = [make(1), make(2), make(3), make(4), make(5)];
    detailFor = review => ({ job: job(review), jobDetailText: review.id === make(2).id ? '公司主营助贷，岗位负责贷款撮合服务。'
      : review.id === make(3).id ? '熟练掌握哥斯达黎加本土西班牙语（核心要求），负责音频转写。'
      : review.screening!.jobDetail, alreadyChatted: review.id === make(4).id, chatButtonLocator: {} });
    const selected = [...records]; const service = new DeliveryService(); await service.startReviewDelivery(selected);
    assert.deepEqual(sends, [make(1).jobHref, make(5).jobHref], '手动投递允许尚未确认作息，但仍排除最新助贷/语言硬门槛且跳过已沟通');
    assert.equal(records.length, 0); assert.equal(service.getStats().todayAppliedCount, 2); assert.equal(service.getStats().aiRequestCount, 0);
    assert.equal(service.getStats().status, 'finished');
    records = [make(6)]; sends.length = 0; opened.length = 0;
    config.delivery.dailyMaxQuota = 0; const zero = new DeliveryService(); await zero.startReviewDelivery([...records]);
    assert.equal(opened.length, 0); assert.equal(records.length, 1); assert.equal(zero.getStats().todayAppliedCount, 0);
    config.delivery.dailyMaxQuota = 1; sendResult = { success: false, uncertain: true };
    const uncertain = new DeliveryService(); await uncertain.startReviewDelivery([...records]);
    assert.equal(uncertain.getStats().status, 'failed'); assert.equal(uncertain.getStats().todayAppliedCount, 0); assert.equal(records.length, 1);
    sendResult = { success: true, verified: true, continuationFailed: true };
    const continuation = new DeliveryService(); await continuation.startReviewDelivery([...records]);
    assert.equal(continuation.getStats().status, 'failed'); assert.equal(continuation.getStats().todayAppliedCount, 1);
    assert.equal(records.length, 0, '已发送但继续失败的记录不能留下来再投递');
    records = [make(7), make(8)]; sends.length = 0; chronology.length = 0;
    config.delivery.dailyMaxQuota = 2;
    sendResult = { success: true, verified: true, continued: true };
    const paced = new DeliveryService(); (paced as any).sleepInterruptible = async () => { chronology.push('selection-wait'); return true; };
    await paced.startReviewDelivery([...records]);
    assert.deepEqual(chronology, ['open:' + make(7).jobHref, 'send:' + make(7).jobHref, 'open:' + make(8).jobHref, 'send:' + make(8).jobHref],
      '共享队列控制实际操作，流程不再叠加额外的岗位等待');
    records = [make(9), make(10)]; opened.length = 0;
    const stopped = new DeliveryService(); let selections = 0;
    (stopped as any).paceJobSelection = async () => { if (selections++ > 0) stopped.stop(); return selections === 1; };
    await stopped.startReviewDelivery([...records]);
    assert.equal(stopped.getStats().status, 'idle'); assert.equal(opened.length, 1); assert.equal(records.length, 1, '停止不投递后续记录');

    config.filter.commute = { origin: { name: '出发点', address: '上海人民广场', cityName: '上海', query: '上海人民广场',
      longitude: 121.48, latitude: 31.23, coordinateSystem: 'boss' }, maxDistanceKm: 5 };
    records = [make(11), make(12), make(13), make(14)]; sends.length = 0;
    detailFor = review => ({ job: { ...job(review), workAddress: review.id === make(12).id ? undefined
      : { address: review.id === make(11).id ? '很远的办公地址' : '附近办公地址',
        point: { longitude: review.id === make(11).id ? 121.9 : 121.49, latitude: 31.23, coordinateSystem: 'boss' } } },
      jobDetailText: review.screening!.jobDetail, alreadyChatted: false, chatButtonLocator: {} });
    const located = new DeliveryService(); await located.startReviewDelivery([...records]);
    assert.deepEqual(sends, [make(13).jobHref, make(14).jobHref], '手动选择核对当前距离；未知地点不直接投递，已废弃交通查询');
    assert.deepEqual(records.map(item => item.id), [make(12).id], '未知工作地点保留待确认，过远淘汰');
    assert.equal(located.getStats().todayAppliedCount, 2);
    console.log('PASS | 待确认单条/批量入口、并发锁、登录、每日0/配额、最新排除复核、未知条件手动投递、零重复AI、已沟通去重、计数、继续失败防重投、浏览节奏、停止、最新距离/通勤复核');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => restores.reverse().forEach(restore => restore()));
