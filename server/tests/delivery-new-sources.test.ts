import './fixtures/activate-isolated-safety.js';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { ConfigManager, configManager } from '../src/config/config.manager.js';
import { DeliveryService } from '../src/services/delivery.service.js';
import { stateManager, todayStr } from '../src/config/state.manager.js';
import { bossPageService } from '../src/services/boss.page.service.js';
import { bossMessageRecommendations } from '../src/services/boss-message-recommendations.js';
import { browserService } from '../src/services/browser.service.js';
import { bossExpectationsService } from '../src/services/boss-expectations.js';
import { bossActionScheduler } from '../src/services/boss-action-scheduler.js';
import { llmService } from '../src/services/llm.service.js';
import { notSuitableStore } from '../src/services/not-suitable-store.js';
import { resetOfflineCandidates } from './fixtures/safety.js';
const restores: Array<() => void> = [];
const stub = (o: any, k: string, v: any) => { const old=o[k];o[k]=v;restores.push(()=>o[k]=old); };
async function run(mode: 'recommendation' | 'message_recommendations') {
  resetOfflineCandidates();
  const base=configManager.getConfig();
  const cfg={...base,filter:{...base.filter,cityName:'上海',cityCode:'101020100',salaryMin:0,salaryMax:0,experience:[],degree:[],hrActiveDaysLimit:0,
    skipMissingCompanyIntro:false,skipVagueJobDescription:false,companyBlacklist:['金融'],requiredKeywords:[],workRequirements:[],commute:{}},
    delivery:{...base.delivery,jobSource:mode,dailyMaxQuota:1}};
  stub(configManager,'getConfig',()=>cfg);
  stub(stateManager,'loadQuota',()=>({date:todayStr(),count:0}));stub(stateManager,'saveQuota',()=>{});
  stub(browserService,'closeAfterTask',async()=>false);stub(bossActionScheduler,'waitSeconds',()=>0);stub(bossActionScheduler,'isBusinessRestImminent',()=>false);
  stub(notSuitableStore,'matches',()=>false);
  stub(bossExpectationsService,'configure',async()=>{throw Error('新来源不得修改自选期望');});
  let opened=0,sent=0,requests=0,linkedReads=0,cardChecks=0,feedback=0;
  const cards=['bank','office'].map(id=>({index:0,jobHref:'https://www.zhipin.com/job_detail/'+mode+'-'+id+'~.html',jobName:'行政支持',companyName:'虚构'+id+'公司',
    salary:'6-8K',cityName:'上海',degree:'大专',experience:'经验不限',skills:[],activeTimeDesc:'今日活跃',cardLocator:mode==='recommendation'?{id}:null}));
  stub(bossPageService,'initJobPage',async(q:any,city:any,position:any,options:any)=>{assert.equal(mode,'recommendation');assert.equal(q,undefined);assert.equal(city,'101020100');assert.equal(position,undefined);assert.equal(options.recommendation,true);opened++;});
  stub(bossMessageRecommendations,'open',async()=>{assert.equal(mode,'message_recommendations');opened++;return {};});
  stub(bossMessageRecommendations,'cards',async()=>cards);stub(bossMessageRecommendations,'scroll',async()=>{});
  stub(bossPageService,'getVisibleJobCards',async()=>{assert.equal(mode,'recommendation','消息来源不能偷换成推荐或搜索列表');return cards;});
  stub(bossPageService,'isCardStillTarget',async()=>{assert.equal(mode,'recommendation');cardChecks++;return true;});
  stub(bossPageService,'isDetailStillTarget',async()=>true);stub(bossPageService,'isJobListPage',async()=>mode==='recommendation');
  stub(bossPageService,'scrollDownForMore',async()=>{});
  const detail=(href:string)=>{const c=cards.find(c=>c.jobHref===href)!;const bank=href.includes('-bank~');return {jobDetailText:bank?'从事银行贷款及金融服务业务。':'负责行政文件整理、办公用品登记及行政事务支持。',
    detailData:{...c},brandIndustry:bank?'金融':'软件开发',activeTimeDesc:'今日活跃',chatButtonLocator:{href},alreadyChatted:false,
    companyInfo:{name:c.companyName,url:'https://www.zhipin.com/gongsi/fixture.html',industry:bank?'金融':'软件开发',introduction:bank?'公司主营银行贷款和金融服务业务。':'公司主营企业软件开发及技术服务。',businessScope:'',checkedAt:new Date().toISOString()}};};
  stub(bossPageService,'loadJobDetail',async(_c:any,_n:any,_b:any,href:string)=>{assert.equal(mode,'recommendation');return detail(href);});
  stub(bossPageService,'loadCandidateJob',async(c:any)=>{assert.equal(mode,'message_recommendations');linkedReads++;return detail(c.jobHref);});
  stub(bossPageService,'markJobNotSuit',async()=>{feedback++;return false;});
  stub(llmService,'chatJson',async(_m:any,_r:any,options:any)=>{requests++;options.onRequest?.();return {jobs:[{jobKey:'job-0',score:90,passed:true,reason:'职责匹配',customGreeting:'您好'}]};});
  stub(bossPageService,'executeChatClick',async(_b:any,_g:any,target:any)=>{assert.ok(target.jobHref.includes('-office~'));sent++;return {success:true};});
  const service=new DeliveryService({runIfDue:async()=>false});(service as any).sleepInterruptible=async()=>true;
  await service.startDelivery({targetRole:'行政支持',keywords:['不应搜索的词'],resumeText:'虚构行政支持简历。'.repeat(10),candidateSource:'resume',positionCode:'100901'});
  assert.equal(sent,1);assert.equal(requests,1,'被排除的岗位不消耗AI；合格候选仍进入AI');
  assert.equal(service.getStats().totalScanned,2);assert.equal(service.getStats().passedFilterCount,1);
  assert.ok(service.getLogs().some(l=>l.message.includes('初筛淘汰')&&l.message.includes('金融')));
  assert.ok(opened>0);if(mode==='message_recommendations'){assert.equal(cardChecks,0);assert.ok(linkedReads>=2);assert.equal(feedback,0,'消息来源不发送不合适反馈');}
  restores.reverse().forEach(fn=>fn());restores.length=0;
}
async function main(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jobloom-source-config-'));
  try{const file=path.join(dir,'config.json');for(const source of ['recommendation','message_recommendations'] as const){new ConfigManager(file).updateConfig({delivery:{jobSource:source,dailyMaxQuota:0}});assert.equal(new ConfigManager(file).getConfig().delivery.jobSource,source,'设置跨重启保留，不能被归一成自选岗位');}}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
  await run('recommendation');await run('message_recommendations');
  console.log('PASS | both sources retain exclusion -> AI -> confirmed application, stable message links, config restart, no expectation edits, real requests/sends=0');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>restores.reverse().forEach(fn=>fn()));

