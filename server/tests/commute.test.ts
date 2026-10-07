import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commuteDecision, currentCommute, isBossPoint, normalizeCommuteFilter, straightDistanceKm, validateCommuteFilter, validJobCommute } from '../src/services/commute.js';
import { JobCommuteService } from '../src/services/job-commute.service.js';
import { FilterService } from '../src/services/filter.service.js';
import { ConfigManager, configManager } from '../src/config/config.manager.js';
import { llmService } from '../src/services/llm.service.js';
import type { AppConfig, BossJobItem, BossWorkAddress, CommuteOrigin } from '../src/types.js';

const original = configManager.getConfig(), get = configManager.getConfig, chat = llmService.chatJson;
const origin: CommuteOrigin = { name: '人民广场', address: '上海市黄浦区人民大道185号', cityName: '上海', query: '上海人民广场',
  longitude: 121.481492, latitude: 31.234736, coordinateSystem: 'bd09' };
const destination: BossWorkAddress = { address: '上海徐汇区模速空间(SMC)-B区202', point: { longitude: 121.46082827601207, latitude: 31.158109721277892, coordinateSystem: 'gcj02' } };
const filter: AppConfig['filter'] = { ...original.filter, salaryMin: 0, salaryMax: 0, hrActiveDaysLimit: 0, degree: [], experience: [],
  skipMissingCompanyIntro: false, skipVagueJobDescription: false, companyBlacklist: [], requiredKeywords: [], workRequirements: [],
  commute: { origin, maxDistanceKm: 15 } };
const job: BossJobItem = { securityId: '', jobId: '', lid: '', jobName: '测试工程师', brandName: '测试公司', cityName: '上海',
  areaDistrict: '', brandScaleName: '', brandIndustry: '计算机软件', bossName: '', bossTitle: '', activeTimeDesc: '今日活跃',
  salaryDesc: '6-8K', jobExperience: '经验不限', jobDegree: '大专', skills: [], welfareList: [], workAddress: destination };

async function main() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-commute-test-'));
  try {
    assert.ok(Math.abs(straightDistanceKm(origin, destination.point!) - 7.9771) < .001);
    assert.equal(straightDistanceKm(origin, origin), 0);
    assert.throws(() => straightDistanceKm(origin, { ...origin, coordinateSystem: 'wgs84' } as any), /坐标/);
    assert.equal(isBossPoint({ ...origin, longitude: NaN }), false);
    assert.equal(validateCommuteFilter({ maxDistanceKm: -1 }), false);
    assert.equal(validateCommuteFilter({ maxDistanceKm: 201 }), false);
    const old = { origin, maxDistanceKm: 15, maxTransitMinutes: 60 };
    assert.deepEqual(normalizeCommuteFilter(old), { origin, maxDistanceKm: 15 }, '迁移旧设置，删除交通时间但保留位置和距离');
    const file = path.join(folder, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ filter: { commute: old } }));
    const manager = new ConfigManager(file);
    assert.deepEqual(manager.getConfig().filter.commute, { origin, maxDistanceKm: 15 });
    manager.updateConfig({ filter: { commute: old } } as any);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).filter.commute.maxTransitMinutes, undefined);
    assert.equal(commuteDecision(job, { ...filter, commute: { origin, maxTransitMinutes: 60 } as any }).status, 'disabled', '旧的单独交通限制不会偷偷继续筛选');
    assert.equal(commuteDecision(job, filter).status, 'passed');
    assert.equal(commuteDecision({ ...job, workAddress: undefined }, filter).status, 'unknown', '不使用公司注册地址代替工作地点');
    assert.equal(commuteDecision(job, { ...filter, commute: { maxDistanceKm: 10 } }).status, 'unknown');
    const exact = straightDistanceKm(origin, destination.point!);
    assert.equal(commuteDecision(job, { ...filter, commute: { origin, maxDistanceKm: exact } }).status, 'passed');
    assert.equal(commuteDecision(job, { ...filter, commute: { origin, maxDistanceKm: exact - .0001 } }).status, 'failed');
    const legacyEvidence = { ...currentCommute(origin, destination), transitStatus: 'unknown', transitReason: '终点不符', checkedAt: '2020-01-01T00:00:00Z', distanceKm: 0 };
    assert.equal(validJobCommute(legacyEvidence), true, '旧待确认记录仍可读取');
    assert.equal(commuteDecision({ ...job, commute: legacyEvidence }, filter).status, 'passed', '旧交通失败和过期数据不阻塞距离筛选');
    const far = { ...job, workAddress: { address: '新工作地点', point: { ...destination.point!, longitude: 122 } }, commute: legacyEvidence };
    assert.equal(commuteDecision(far, filter).status, 'failed', '最新工作地点重新计算，不能复用旧的零公里缓存');
    const prepared = { ...job, commute: legacyEvidence };
    await new JobCommuteService().enrich(prepared, filter);
    assert.ok(prepared.commute!.distanceKm! > 7);
    assert.equal('transitStatus' in prepared.commute!, false);
    let calls = 0; configManager.getConfig = () => ({ ...original, filter });
    llmService.chatJson = (async () => { calls++; throw Error('地点不明或过远不应调用 AI'); }) as typeof chat;
    const results = await new FilterService().evaluateBatch([
      { job: { ...job, workAddress: undefined }, jobDetail: '负责应用测试、缺陷记录与回归验证。' },
      { job: far, jobDetail: '负责应用测试、缺陷记录与回归验证。' },
    ], '希望上海文职岗位', '测试', 'requirements');
    assert.equal(calls, 0); assert.equal(results[0].needsCommuteConfirmation, true);
    assert.equal(results[1].passed, false); assert.equal(results[1].needsReview, undefined);
    console.log('PASS | 旧交通设置迁移、本地距离、坐标转换与边界、旧记录兼容、最新工作地点复核、零AI地点筛选');
  } finally {
    configManager.getConfig = get; llmService.chatJson = chat;
    for (const name of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder, name));
    fs.rmdirSync(folder);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
