import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserService } from '../src/services/browser.service.js';
import { BossPageService } from '../src/services/boss.page.service.js';
import { findJobExclusion } from '../src/services/job-exclusions.js';
import { configManager } from '../src/config/config.manager.js';

async function main() {
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const page = await browser.newPage();
  const inspect = await browser.newPage();
  const companyPage = await browser.newPage();
  const getWorker = browserService.getWorkerPage;
  const inspection = browserService.withJobInspection;
  const companyInspection = browserService.withCompanyInspection;
  const service = new BossPageService();
  let fullCompany = '深圳信银';
  let fullTitle = '客户经理';
  let industry = '银行';
  let companyIndustry = '银行';
  let companyIntroduction = '公司主营银行客户服务。';
  let profileName = '';
  let companyReads = 0;
  try {
    await page.route('**/web/geek/jobs**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <body><ul class="rec-job-list"><li class="job-card-box">
      <a class="job-name" href="/job_detail/example.html">客户经理</a>
      <div class="job-card-footer"><span class="boss-name">深圳信银</span></div></li></ul>
      <div class="job-detail-box"><div class="job-detail-info"><span class="job-name">客户经理</span></div>
      <a class="more-job-btn" href="/job_detail/example.html?from=list">查看更多信息</a>
      <div class="job-detail-body"><p class="desc">负责客户资料审核与驻点服务，具体工作作息面议。</p>
      <div class="company-name">深圳信银</div><div class="job-boss-info">深圳信银 今日活跃</div></div><a class="op-btn-chat">立即沟通</a></div></body>` }));
    await inspect.route('**/job_detail/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <body><style>.noise{display:none}</style><div class="job-banner"><div class="name"><h1>${fullTitle}<span class="noise">boss</span></h1></div></div>
      <div class="sider-company"><div class="company-info"><a href="/gongsi/example-company.html" title="${fullCompany}">${fullCompany}</a></div>
      <p><i class="icon-industry"></i><a ka="job-detail-brandindustry" href="/i100201/">${industry}</a></p></div>
      <div class="job-detail-section"><h3>职位<span class="noise">boss</span>描述</h3><div class="job-sec-text">为客户办理信用卡服务，提交到银行系统审核额度。详细工作作息面议。</div></div>
      <div class="similar-jobs"><a href="/i100202/">证券</a><div class="job-sec-text">推荐金融岗位，销售指标。</div></div></body>` }));
    await companyPage.route('**/gongsi/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <body><style>.noise{display:none}</style><div class="company-banner"><h1 class="name">${profileName || fullCompany}<span class="noise">boss</span><br>收藏</h1><a href="/i100207/">${companyIndustry}</a></div>
      <div class="company-info-box"><div class="job-sec"><h3>公司<span class="noise">boss</span>简介</h3><div class="text">${companyIntroduction}</div></div>
      <div class="job-sec company-business"><div class="business-detail"><ul><li>经营范围：信息咨询服务；企业管理咨询。</li></ul></div></div></div>
      <div class="recommend-company">其他金融公司：主营贷款中介业务</div></body>` }));
    (browserService as any).getWorkerPage = async () => page;
    (inspect as any).refreshUrl = async () => inspect.url();
    (companyPage as any).refreshUrl = async () => companyPage.url();
    (browserService as any).withJobInspection = async (href: string, read: (page: any) => Promise<any>) => {
      await inspect.goto(new URL(href, 'https://www.zhipin.com').href);
      return read(inspect);
    };
    (browserService as any).withCompanyInspection = async (href: string, read: (page: any) => Promise<any>) => {
      companyReads++;
      await companyPage.goto(new URL(href, 'https://www.zhipin.com').href);
      return read(companyPage);
    };
    await page.goto('https://www.zhipin.com/web/geek/jobs');
    const href = '/job_detail/example.html';
    const card = page.locator('.job-card-box');
    assert.equal((await service.loadJobDetail(card as any, '客户经理', '深圳信银', href)).brandIndustry, '', '右侧列表详情没有行业时不能假定有');
    const detail = await service.loadJobDetail(card as any, '客户经理', '深圳信银', href, { readIndustry: true });
    assert.equal(detail.brandIndustry, '银行', '启用行业排除时，补读真实完整职位页的公司基本信息');
    assert.match(detail.jobDetailText, /银行系统/);
    assert.equal(detail.companyInfo?.industry, '银行');
    assert.equal(detail.companyInfo?.businessScope, '信息咨询服务；企业管理咨询。');
    await service.readCompanyInfo('/gongsi/example-company.html', '深圳信银');
    assert.equal(companyReads, 1, '同一公司短时间重复岗位复用已核查的业务信息');
    await service.readCompanyInfo('/gongsi/example-company.html', '深圳信银', true);
    assert.equal(companyReads, 2, '发送前的公司复核可强制读取最新资料');
    assert.doesNotMatch(detail.jobDetailText, /推荐金融岗位/, '不把推荐岗位内容混入当前职位');
    assert.equal(new URL(page.url()).pathname, '/web/geek/jobs', '核对公司行业不能改变投递页');
    fullCompany = '其他公司';
    assert.equal((await service.readJobCompanyInfo(href, '客户经理', '深圳信银')).detailData.companyName, '其他公司',
      '公司名称以当前详情为准，不能按卡片旧名称拒绝');
    fullCompany = '深圳信银'; fullTitle = '其他职位';
    assert.equal((await service.readJobCompanyInfo(href, '客户经理', '深圳信银')).detailData.jobName, '其他职位',
      '当前详情标题变化应返回真实标题');
    fullTitle = '客户经理'; industry = '';
    await assert.rejects(service.readJobCompanyInfo(href, '客户经理', '深圳信银'), /无法.*读取行业/,
      '当前公司没有行业时，不能借用推荐岗位的行业');
    fullTitle = '客服'; fullCompany = '示例信息咨询'; industry = '商务服务'; companyIndustry = '商务服务';
    companyIntroduction = '公司主营助贷服务，为企业和个人提供融资咨询与贷款撮合。';
    const companyDetail = await service.readJobCompanyInfo(href, fullTitle, fullCompany);
    assert.match(companyDetail.companyInfo!.introduction, /助贷/);
    const exclusions = { ...configManager.getConfig().filter, companyBlacklist: ['金融'], workRequirements: [] };
    assert.equal(findJobExclusion({ jobName: '客服', brandName: fullCompany, brandIndustry: '商务服务',
      companyInfo: companyDetail.companyInfo }, exclusions)?.field, '公司介绍', '助贷公司行业写商务服务，也须按公司页实际业务排除');
    profileName = '不相关公司';
    assert.equal((await new BossPageService().readCompanyInfo('/gongsi/example-company.html', fullCompany)).name, '不相关公司',
      '按详情链接打开的公司页应采用页面名称，避免品牌简称与公司全称造成误拒绝');
    profileName = '深圳信银'; companyIntroduction = ''; companyIndustry = '企业服务';
    await page.evaluate(() => {
      const link = document.createElement('a'); link.className = 'boss-info'; link.href = '/gongsi/direct-company.html';
      document.querySelector('.job-detail-box')!.appendChild(link);
    });
    const directService = new BossPageService();
    const oldInspection = browserService.withJobInspection;
    (browserService as any).withJobInspection = async () => { throw new Error('详情已有公司链接，不应再打开完整职位页'); };
    const direct = await directService.loadJobDetail(card as any, '客户经理', '深圳信银', href,
      { readIndustry: true, filter: { ...exclusions, companyBlacklist: [], skipMissingCompanyIntro: true } });
    assert.equal(direct.companyInfo?.introduction, '', '已加载但没有介绍的公司页应返回明确的空简介');
    assert.equal(direct.companyInfo?.name, '深圳信银');
    browserService.withJobInspection = oldInspection;
    console.log('PASS | 完整职位页行业/隐藏干扰文字、公司页简介/经营范围/身份、助贷识别、排除推荐区域、公司信息复用、保持投递页、缺失信息不放行');
  } finally {
    browserService.getWorkerPage = getWorker; browserService.withJobInspection = inspection;
    browserService.withCompanyInspection = companyInspection;
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
