import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commuteDecision, currentCommute, isBossPoint, normalizeCommuteFilter, parseTransitMinutes, straightDistanceKm, TRANSIT_CACHE_MS, validateCommuteFilter } from '../src/services/commute.js';
import { JobCommuteService } from '../src/services/job-commute.service.js';
import { FilterService } from '../src/services/filter.service.js';
import { WorkConditionReviews } from '../src/services/work-condition-reviews.js';
import { configManager } from '../src/config/config.manager.js';
import { llmService } from '../src/services/llm.service.js';
import type { AppConfig, BossJobItem, BossWorkAddress, CommuteOrigin, JobCommute } from '../src/types.js';

const original = configManager.getConfig(), get = configManager.getConfig, chat = llmService.chatJson;
const origin: CommuteOrigin = { name: '人民广场', address: '上海市黄浦区人民大道185号', cityName: '上海', query: '上海人民广场',
  longitude: 121.481492, latitude: 31.234736, coordinateSystem: 'bd09' };
const destination: BossWorkAddress = { address: '上海徐汇区模速空间(SMC)-B区202', point: { longitude: 121.46082827601207, latitude: 31.158109721277892, coordinateSystem: 'gcj02' } };
const filter: AppConfig['filter'] = { ...original.filter, salaryMin: 0, salaryMax: 0, hrActiveDaysLimit: 0, degree: [], experience: [],
  skipMissingCompanyIntro: false, skipVagueJobDescription: false, companyBlacklist: [], requiredKeywords: [], workRequirements: [],
  commute: { origin, maxDistanceKm: 15, maxTransitMinutes: 60 } };
const job: BossJobItem = { securityId: '', jobId: '', lid: '', jobName: '测试工程师', brandName: '测试公司', cityName: '上海',
  areaDistrict: '', brandScaleName: '', brandIndustry: '计算机软件', bossName: '', bossTitle: '', activeTimeDesc: '今日活跃',
  salaryDesc: '6-8K', jobExperience: '经验不限', jobDegree: '大专', skills: [], welfareList: [], workAddress: destination };
const route = (): JobCommute => ({ ...currentCommute(origin, destination), transitStatus: 'ok', transitMinutes: 49, transitSummary: '8号线 → 11号线' });

async function main() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-commute-test-'));
  try {
    assert.ok(Math.abs(straightDistanceKm(origin, destination.point!) - 7.9771) < 0.001, 'BOSS 起点BD09、终点GCJ02统一后直线约8.0公里');
    assert.equal(straightDistanceKm(origin, origin), 0);
    assert.throws(() => straightDistanceKm(origin, { ...origin, coordinateSystem: 'wgs84' } as any), /坐标/);
    assert.equal(isBossPoint({ ...origin, longitude: NaN }), false);
    assert.equal(isBossPoint({ ...origin, latitude: 0 }), false);
    assert.equal(isBossPoint({ ...origin, longitude: '121.48' }), false);
    assert.equal(validateCommuteFilter({ maxDistanceKm: -1 }), false);
    assert.equal(validateCommuteFilter({ maxTransitMinutes: 241 }), false);
    assert.equal(validateCommuteFilter({ maxTransitMinutes: 30.5 }), false);
    assert.equal(validateCommuteFilter({ origin: { ...origin, query: '' } }), false);
    assert.equal(validateCommuteFilter({ origin, maxDistanceKm: 0.5, maxTransitMinutes: 0 }), true);
    assert.equal(normalizeCommuteFilter({ origin, maxDistanceKm: 15 }).origin?.name, origin.name);
    for (const [label, minutes] of [['49分钟', 49], ['1小时11分钟', 71], ['2小时', 120], ['约 1 小时 5 分钟', 65], ['0分钟', 0],
      ['', undefined], ['无法规划', undefined], ['9站 · 步行1.6千米', undefined]] as const) assert.equal(parseTransitMinutes(label), minutes);
    assert.equal(commuteDecision(job, { ...filter, commute: {} }).status, 'disabled');
    assert.equal(commuteDecision(job, { ...filter, commute: { maxDistanceKm: 10 } }).status, 'unknown');
    assert.equal(commuteDecision({ ...job, workAddress: undefined }, filter).status, 'unknown', '不能用公司注册地址或城市替代岗位坐标');
    assert.equal(commuteDecision(job, filter).status, 'unknown', '直线近不能证明公交通勤合格');
    const good = { ...job, commute: route() };
    assert.equal(commuteDecision(good, filter).status, 'passed');
    assert.equal(commuteDecision(good, { ...filter, commute: { origin, maxDistanceKm: 7 } }).status, 'failed');
    assert.equal(commuteDecision(good, { ...filter, commute: { origin, maxTransitMinutes: 48 } }).status, 'failed');
    assert.equal(commuteDecision(good, { ...filter, commute: { origin, maxTransitMinutes: 49 } }).status, 'passed');
    const exact = straightDistanceKm(origin, destination.point!);
    assert.equal(commuteDecision(good, { ...filter, commute: { origin, maxDistanceKm: exact } }).status, 'passed');
    assert.equal(commuteDecision(good, { ...filter, commute: { origin, maxDistanceKm: exact - 0.0001 } }).status, 'failed', '比较实际值，不按显示四舍五入提前放行');
    assert.equal(commuteDecision({ ...good, workAddress: { ...destination, address: '另一工作地址' } }, filter).status, 'unknown');
    assert.equal(commuteDecision({ ...good, commute: { ...route(), checkedAt: new Date(Date.now() - TRANSIT_CACHE_MS - 1).toISOString() } }, filter).status, 'unknown');
    assert.equal(commuteDecision(good, { ...filter, commute: { ...filter.commute, origin: { ...origin, longitude: origin.longitude + 0.05 } } }).status, 'unknown');

    const service = new JobCommuteService(); let requests = 0;
    const read = async () => { requests++; return { minutes: 49, summary: '8号线 → 11号线' }; };
    const prepared = { ...job };
    await service.enrich(prepared, filter, read); await service.enrich({ ...job }, filter, read);
    assert.equal(requests, 1, '相同出发点和工作地址复用路线，不重复查询');
    await service.enrich({ ...job }, { ...filter, commute: { origin, maxDistanceKm: 7, maxTransitMinutes: 60 } }, read);
    assert.equal(requests, 1, '直线过远时不再请求公共交通');
    await service.enrich({ ...job }, { ...filter, commute: { origin, maxDistanceKm: 15 } }, read);
    assert.equal(requests, 1, '未启用通勤上限时只本地计算直线');
    await service.enrich({ ...job, workAddress: undefined }, filter, read); assert.equal(requests, 1);
    await service.enrich({ ...job }, { ...filter, commute: { ...filter.commute, origin: { ...origin, name: '新出发点', longitude: origin.longitude + 0.01 } } }, read);
    assert.equal(requests, 2, '更改出发位置必须重新查询');
    const unavailable = { ...job };
    await new JobCommuteService().enrich(unavailable, filter, async () => { throw new Error('暂无路线'); });
    assert.equal(commuteDecision(unavailable, filter).status, 'unknown');

    let calls = 0; configManager.getConfig = () => ({ ...original, filter });
    llmService.chatJson = (async () => { calls++; throw new Error('地点不明或过远不应调用 AI'); }) as typeof chat;
    const results = await new FilterService().evaluateBatch([
      { job: { ...job, workAddress: undefined }, jobDetail: '负责应用测试、缺陷记录与回归验证。' },
      { job: { ...job, commute: { ...route(), transitMinutes: 90 } }, jobDetail: '负责应用测试、缺陷记录与回归验证。' },
    ], '希望上海文职岗位', '测试', 'requirements');
    assert.equal(calls, 0); assert.equal(results[0].needsCommuteConfirmation, true); assert.equal(results[1].passed, false); assert.equal(results[1].needsReview, undefined);
    llmService.chatJson = (async () => { calls++; return { jobs: [{ jobKey: 'job-0', score: 90, passed: true }] }; }) as typeof chat;
    const cached = new FilterService();
    const preparedCandidate = { job: { ...job, commute: route() }, jobDetail: '负责应用测试、缺陷记录与回归验证。' };
    assert.equal((await cached.evaluateBatch([preparedCandidate], '虚构简历', '测试'))[0].passed, true);
    const rechecked = { ...preparedCandidate, job: { ...preparedCandidate.job, commute: { ...preparedCandidate.job.commute!, checkedAt: new Date(Date.now() - 1).toISOString() } } };
    assert.equal((await cached.evaluateBatch([rechecked], '虚构简历', '测试'))[0].evaluationSource, 'cache');
    assert.equal(calls, 1, '重新核对路线时间戳不会导致重复AI请求');
    const store = new WorkConditionReviews(path.join(folder, 'reviews.json'));
    const saved = store.add({ jobHref: '/job_detail/commute-review.html', jobName: job.jobName, companyName: job.brandName,
      salary: job.salaryDesc, reason: results[0].reason, requirements: [], assessment: [],
      screening: { industry: job.brandIndustry, jobDetail: '负责应用测试、缺陷记录与回归验证。', skills: [], needsCommuteConfirmation: true } });
    assert.equal(store.listEligible().length, 1, '未知地点可独立进入待确认，没有其他工作条件也能保存');
    assert.equal(store.list()[0].id, saved.id);
    console.log('PASS | BOSS起終点不同坐标系统一、距离边界、路线时间、缺失/过期/起终点变化、路线缓存、零AI地点硬筛与独立待确认');
  } finally {
    configManager.getConfig = get; llmService.chatJson = chat;
    for (const name of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder, name));
    fs.rmdirSync(folder);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
