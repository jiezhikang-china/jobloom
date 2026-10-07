import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';
import { DeliveryService } from '../src/services/delivery.service.js';
import { bossPageService, type DOMJobCardInfo } from '../src/services/boss.page.service.js';
import { workConditionReviews } from '../src/services/work-condition-reviews.js';
import { llmService } from '../src/services/llm.service.js';

const restores: Array<() => void> = [];
function stub(object: any, key: string, replacement: any) {
  const previous = object[key]; object[key] = replacement; restores.push(() => { object[key] = previous; });
}
const original = configManager.getConfig();
const filter = { ...original.filter, cityName: '上海', salaryMin: 0, salaryMax: 0, hrActiveDaysLimit: 0,
  degree: ['本科'], experience: [], companyBlacklist: ['金融', '房地产', '销售'], commute: {}, requiredKeywords: [],
  workRequirements: [{ id: 'hours', text: '每天工作不超过八小时', enabled: true }] };
const config = { ...original, filter, delivery: { dailyMaxQuota: 1, minDelaySeconds: 0, maxDelaySeconds: 0 } };
const card = (key: string, name = '行政助理'): DOMJobCardInfo => ({ index: 0, jobHref: '/job_detail/' + Buffer.from(key).toString('hex') + '.html',
  jobName: name, companyName: key, cityName: '上海', salary: '6-8K', experience: '1-3年', degree: '大专', skills: [],
  activeTimeDesc: '今日活跃', cardLocator: { key } as any });
let cards = [card('销售标题', '纯网销客服'), card('银行岗位'), card('助贷公司', '纯客服'), card('信贷中介'),
  card('课程营销', '纯邀约客服'), card('作息待定'), card('明确符合')];
let current = '';
let loads = new Map<string, number>();
let changingCompany = false;
const reviewed: any[] = [];
const sent: string[] = [];
let requests = 0;
let marked = 0;
const full = '负责行政文档整理与日常接待。每天工作8小时，周末双休，经验不限。';

async function main() {
  stub(configManager, 'getConfig', () => config);
  stub(stateManager, 'loadQuota', () => ({ date: todayStr(), count: 0 }));
  stub(stateManager, 'saveQuota', () => {});
  stub(bossPageService, 'initJobPage', async () => ({}));
  stub(bossPageService, 'getVisibleJobCards', async () => cards);
  stub(bossPageService, 'isCardStillTarget', async (locator: any, _name: string, company: string) => locator.key === company);
  stub(bossPageService, 'isDetailStillTarget', async (_name: string, company: string) => current === company);
  stub(bossPageService, 'isJobListPage', async () => true);
  stub(bossPageService, 'scrollDownForMore', async () => {});
  stub(bossPageService, 'markJobNotSuit', async () => { marked++; return true; });
  stub(bossPageService, 'loadJobDetail', async (_card: any, _name: string, company: string, _href: string, options: any) => {
    assert.equal(options.readIndustry, true, '配置排除金融时必须补读公司资料');
    const count = (loads.get(company) || 0) + 1; loads.set(company, count); current = company;
    if (changingCompany && count > 1) assert.equal(options.refreshCompany, true, '暂存后发送前须刷新公司业务，不能沿用缓存');
    return { activeTimeDesc: '今日活跃', alreadyChatted: false, chatButtonLocator: { key: company },
      brandIndustry: company === '银行岗位' ? '银行' : '商务服务',
      companyInfo: { url: 'https://www.zhipin.com/gongsi/company.html', name: company, industry: '商务服务',
        introduction: company === '助贷公司' || (changingCompany && count > 1) ? '公司主营助贷服务与融资咨询。' : '公司主营行政文档整理服务。',
        businessScope: company === '信贷中介' ? '经营贷款中介与贷款咨询服务。' : '信息咨询服务。', checkedAt: new Date().toISOString() },
      jobDetailText: company === '课程营销' ? '公司提供客户资源，介绍课程信息，邀约试听课，不负责后续成交。'
        : company === '作息待定' ? '负责行政资料归档和日常接待，工作作息面议。' : full };
  });
  stub(workConditionReviews, 'add', (input: any) => { reviewed.push(input); });
  stub(workConditionReviews, 'removeForJob', () => {});
  stub(bossPageService, 'executeChatClick', async (_button: any, _greeting: string, target: any) => {
    assert.equal(current, target.companyName); sent.push(target.companyName); return { success: true, greetingSent: true };
  });
  stub(llmService, 'chatJson', async (messages: any[], _retries: number, options: any) => {
    requests++; options?.onRequest?.();
    const jobs = JSON.parse(messages[1].content.split('【待评估岗位列表（逐个评估）】：\n')[1]);
    return { jobs: jobs.map((item: any) => ({ jobKey: item.jobKey, score: 90, passed: true, reason: '匹配', customGreeting: '您好' })) };
  });
  const service = new DeliveryService();
  await service.startDelivery({ targetRole: '工作条件', keywords: [''], resumeText: '希望每天工作八小时并且周末双休。',
    candidateSource: 'requirements', rulesOnly: true });
  assert.deepEqual(sent, ['明确符合']);
  assert.deepEqual(reviewed.map((item) => item.companyName), ['作息待定'], '明确排除的岗位不能进入待确认');
  assert.equal(reviewed[0].screening.companyInfo.industry, '商务服务', '待确认记录保留公司页业务依据');
  assert.equal(loads.has('销售标题'), true, '先打开详情，按详情进行脚本排除');
  assert.equal(requests, 0, '脚本能决定的岗位全程无需 AI');
  assert.equal(marked, 5);
  assert.equal(service.getStats().todayAppliedCount, 1);

  changingCompany = true; loads = new Map(); sent.length = 0; cards = [card('公司业务改变')];
  const stale = new DeliveryService();
  await stale.startDelivery({ targetRole: '行政助理', keywords: ['行政助理'], resumeText: '完整简历摘要。'.repeat(15), candidateSource: 'resume' });
  assert.equal(requests, 1);
  assert.equal(loads.get('公司业务改变'), 2);
  assert.deepEqual(sent, [], 'AI通过后复核公司出现助贷业务，也必须停止该岗位投递');
  assert.ok(stale.getLogs().some((log) => log.message.includes('最新岗位已不符合筛选') && log.message.includes('公司介绍')));
  console.log('PASS | 批量入口排除销售/银行/助贷/信贷中介/课程营销、待确认保留公司依据、零 AI 初筛、公司业务变化后不发送');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { for (const restore of restores.reverse()) restore(); });
