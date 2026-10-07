import './fixtures/activate-isolated-safety.js';
import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';
import { DeliveryService } from '../src/services/delivery.service.js';
import { bossPageService } from '../src/services/boss.page.service.js';
import { workConditionReviews } from '../src/services/work-condition-reviews.js';
import { llmService } from '../src/services/llm.service.js';
import { bossExpectationsService } from '../src/services/boss-expectations.js';

const restores: Array<() => void> = [];
function stub(object: any, key: string, replacement: any) { const old = object[key]; object[key] = replacement; restores.push(() => { object[key] = old; }); }
const base = configManager.getConfig();
const config = { ...base, filter: { ...base.filter, skipMissingCompanyIntro: true, skipVagueJobDescription: true,
  cityName: '上海', hrActiveDaysLimit: 0, companyBlacklist: [], requiredKeywords: [], salaryMin: 0, salaryMax: 0,
  degree: [], experience: [], workRequirements: [] },
  delivery: { ...base.delivery, jobSource: 'saved_expectations' as const, dailyMaxQuota: 150, minDelaySeconds: 0, maxDelaySeconds: 0 } };
const names = ['客服(上海)', '数据采集(上海)', '行政(上海)', '新加的岗位(上海)'];
const selected = names.slice(0, 3);
const targets = selected.map((name, index) => ({ code: String(130100 + index), name: name.split('(')[0], categoryCode: '1', categoryName: '客服/运营', subcategoryCode: '2', subcategoryName: '客服' }));

async function main() {
  let active = ''; const opened: string[] = []; const marked: string[] = [];
  let requests = 0; let greetings = 0; let reviews = 0;
  stub(configManager, 'getConfig', () => config);
  stub(stateManager, 'loadQuota', () => ({ date: todayStr(), count: 0 })); stub(stateManager, 'saveQuota', () => {});
  stub(bossPageService, 'getSavedExpectationNames', async () => names);
  stub(bossExpectationsService, 'configure', async (input: any, city: any) => {
    assert.deepEqual(input, targets); assert.equal(city.name, '上海'); return selected;
  });
  stub(bossPageService, 'initJobPage', async (query: unknown, _city: string, position: unknown, options: any) => {
    assert.equal(query, undefined); assert.equal(position, undefined);
    if (options?.expectationName) { active = options.expectationName; opened.push(active); } return {};
  });
  stub(bossPageService, 'getVisibleJobCards', async () => [{ index: 0, jobHref: '/job_detail/' + names.indexOf(active) + '.html',
    jobName: '资料整理', companyName: active, salary: '6-8K', experience: '1-3年', degree: '大专',
    cityName: '上海', skills: [], activeTimeDesc: '今日活跃', cardLocator: {} }]);
  stub(bossPageService, 'isCardStillTarget', async () => true); stub(bossPageService, 'isDetailStillTarget', async () => true);
  stub(bossPageService, 'isJobListPage', async () => true); stub(bossPageService, 'scrollDownForMore', async () => {});
  stub(bossPageService, 'loadJobDetail', async (_card: any, _name: string, company: string, _href: string, options: any) => {
    assert.equal(options.readIndustry, true, '未排除行业时，缺失简介规则仍需读取公司页');
    return { jobDetailText: '录入订单信息。', brandIndustry: '企业服务', activeTimeDesc: '今日活跃', alreadyChatted: false,
      chatButtonLocator: {}, companyInfo: { name: company, url: 'https://www.zhipin.com/gongsi/example.html',
        industry: '企业服务', introduction: '', businessScope: '信息咨询服务。', checkedAt: new Date().toISOString() } };
  });
  stub(bossPageService, 'markJobNotSuit', async (_card: any, target: any, reason: string) => {
    assert.equal(target.companyName, active); assert.match(reason, /公司介绍/); marked.push(active); return true;
  });
  stub(bossPageService, 'executeChatClick', async () => { greetings++; return { success: true }; });
  stub(workConditionReviews, 'add', () => { reviews++; }); stub(workConditionReviews, 'removeForJob', () => {});
  stub(llmService, 'chatJson', async () => { requests++; throw new Error('不应问 AI'); });
  const service = new DeliveryService({ runIfDue: async () => false });
  await service.startDelivery({ targetRole: 'BOSS 自选求职期望', keywords: ['不使用的搜索词'], positionCode: '100901',
    resumeText: '希望寻找工作内容明确并且公司有介绍的岗位。', candidateSource: 'requirements', targetPositions: targets });
  assert.deepEqual(opened, selected); assert.deepEqual(marked, [], '缺失公司介绍只在本地淘汰，不发送网站反馈');
  assert.equal(requests, 0); assert.equal(greetings, 0); assert.equal(reviews, 0);
  assert.equal(service.getStats().markedNotSuitCount, 0); assert.equal(service.getStats().totalScanned, 3);
  console.log('PASS | 按三个目标设置并遍历自选期望、忽略无关期望与搜索分类、缺失介绍先淘汰、零 AI 和零发送');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => restores.reverse().forEach((restore) => restore()));
