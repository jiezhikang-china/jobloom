import assert from 'node:assert/strict';
import { configManager } from '../src/config/config.manager.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';
import { DeliveryService } from '../src/services/delivery.service.js';
import { bossPageService, type DOMJobCardInfo } from '../src/services/boss.page.service.js';
import { workConditionReviews } from '../src/services/work-condition-reviews.js';
import { llmService } from '../src/services/llm.service.js';

const restores: Array<() => void> = [];
function stub(object: any, key: string, replacement: any) { const previous = object[key]; object[key] = replacement; restores.push(() => { object[key] = previous; }); }
const original = configManager.getConfig();
const config = { ...original, filter: { ...original.filter, cityName: '上海', candidateLanguages: '英语CET4',
  salaryMin: 0, salaryMax: 0, degree: [], experience: [], hrActiveDaysLimit: 0, companyBlacklist: [], requiredKeywords: [],
  skipMissingCompanyIntro: false, skipVagueJobDescription: false,
  workRequirements: [{ id: 'hours', text: '每天工作不超过八小时', enabled: true }] },
  delivery: { jobSource: 'search' as const, dailyMaxQuota: 1, minDelaySeconds: 0, maxDelaySeconds: 0 } };
const card = (key: string, name = '数据标注'): DOMJobCardInfo => ({ index: 0, jobHref: '/job_detail/' + key + '.html', jobName: name,
  companyName: key, cityName: '上海', salary: '6-8K', experience: '经验不限', degree: '大专', skills: [], activeTimeDesc: '今日活跃', cardLocator: { key } as any });
const cards = [card('西语口音', '哥斯达黎加数据标注'), card('日语岗位', '日语N1数据标注'), card('英语流利'), card('普通标注')];
const marked: string[] = []; const loaded: string[] = []; const sent: string[] = [];
let current = ''; let requests = 0; let reviewed = 0;
async function main() {
  stub(configManager, 'getConfig', () => config); stub(stateManager, 'loadQuota', () => ({ date: todayStr(), count: 0 })); stub(stateManager, 'saveQuota', () => {});
  stub(bossPageService, 'initJobPage', async () => ({})); stub(bossPageService, 'getVisibleJobCards', async () => cards);
  stub(bossPageService, 'isCardStillTarget', async () => true); stub(bossPageService, 'isDetailStillTarget', async (_name: string, company: string) => current === company);
  stub(bossPageService, 'isJobListPage', async () => true); stub(bossPageService, 'scrollDownForMore', async () => {});
  stub(bossPageService, 'loadJobDetail', async (_card: any, _name: string, company: string, _href: string, options: any) => {
    assert.equal(options.candidateContext.source, 'requirements'); loaded.push(company); current = company;
    return { jobDetailText: company === '西语口音' ? '负责语音转写。熟练掌握哥斯达黎加本土西班牙语（核心要求）。作息面议。提供培训。'
      : company === '日语岗位' ? '负责语音转写，必须日语 N1。作息面议。'
      : company === '英语流利' ? '负责音频转写。必须英语口语流利。作息面议。'
      : '负责中文图片标注与文本核对。英语优先。每天工作8小时。', brandIndustry: '企业服务', activeTimeDesc: '今日活跃', alreadyChatted: false, chatButtonLocator: {} };
  });
  stub(bossPageService, 'markJobNotSuit', async (_card: any, target: any, reason: string) => { assert.match(reason, /语言硬要求/); marked.push(target.companyName); return true; });
  stub(workConditionReviews, 'add', () => { reviewed++; }); stub(workConditionReviews, 'removeForJob', () => {});
  stub(bossPageService, 'executeChatClick', async (_button: any, _greeting: string, target: any) => { assert.equal(current, target.companyName); sent.push(target.companyName); return { success: true, greetingSent: true }; });
  stub(llmService, 'chatJson', async (messages: any[], _retries: number, options: any) => {
    requests++; options.onRequest?.(); const batch = JSON.parse(messages[1].content.split('【待评估岗位列表（逐个评估）】：\n')[1]);
    assert.deepEqual(batch.map((item: any) => item.companyName), ['普通标注'], '不满足语言门槛的岗位不得进入 AI 暂存');
    return { jobs: batch.map((item: any) => ({ jobKey: item.jobKey, score: 90, passed: true, reason: '匹配', customGreeting: '您好' })) };
  });
  const service = new DeliveryService();
  await service.startDelivery({ targetRole: '数据标注', keywords: ['数据标注'], resumeText: '希望八小时双休的无经验工作。', candidateSource: 'requirements' });
  assert.deepEqual(marked, ['西语口音', '日语岗位', '英语流利']); assert.equal(loaded.includes('日语岗位'), true, '补读全文确认硬性门槛，避免误判优先或可培训');
  assert.deepEqual(sent, ['普通标注']); assert.equal(reviewed, 0); assert.equal(requests, 1);
  assert.equal(service.getStats().localDecisionCount, 3); assert.equal(service.getStats().todayAppliedCount, 1);
  assert.equal(service.getStats().status, 'finished');
  console.log('PASS | 投递主循环语言硬门槛先淘汰、原原因标记不合适、零待确认、零无用AI、普通岗位保留');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => restores.reverse().forEach(restore => restore()));
