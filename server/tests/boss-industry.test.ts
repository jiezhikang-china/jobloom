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
  let companyHref = '/gongsi/example-company.html';
  let anonymousCompany = false;
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
      <div class="sider-company"><div class="company-info">${anonymousCompany ? `<h3 class="company-name">${fullCompany}</h3>` : `<a href="${companyHref}" title="${fullCompany}">${fullCompany}</a>`}</div>
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
    const missingJobIndustry = await service.readJobCompanyInfo(href, '客户经理', '深圳信银');
    assert.equal(missingJobIndustry.brandIndustry, '银行', '职位页缺少行业时，仍读取公司页已有行业');
    assert.match(missingJobIndustry.jobDetailText, /银行系统/, '缺少行业不能算详情读取失败');
    companyIndustry = ''; companyIntroduction = '公司经营电子商务平台，为商家提供订单整理与运营支持。';
    const noIndustry = await service.loadJobDetail(card as any, '客户经理', '深圳信银', href,
      { readIndustry: true, refreshCompany: true });
    assert.equal(noIndustry.brandIndustry, '', '两页均无行业时保留为空，不能借用推荐区证券标签');
    assert.equal(noIndustry.companyInfo?.industry, '');
    assert.match(noIndustry.companyInfo!.introduction, /电子商务/);
    assert.ok(noIndustry.chatButtonLocator, '行业缺失不影响继续核对沟通入口');
    industry = '电子商务';
    const sourceIndustry = await service.readJobCompanyInfo(href, '客户经理', '深圳信银', { refreshCompany: true });
    assert.equal(sourceIndustry.brandIndustry, '电子商务', '公司页行业缺失不覆盖职位页已有行业');
    companyHref = ''; industry = ''; anonymousCompany = true;
    fullCompany = '上海某大型电子商务公司'; fullTitle = '商家运营支持（互联网大厂/周末双休）';
    const anonymous = await service.readJobCompanyInfo(href, fullTitle, fullCompany);
    assert.equal(anonymous.brandIndustry, '');
    assert.equal(anonymous.companyInfo, undefined, '没有公开公司链接时不伪造已核对的公司资料');
    assert.equal(anonymous.detailData.companyName, fullCompany);
    assert.match(anonymous.jobDetailText, /银行系统/, '匿名公司没有行业或公司链接时仍返回实际岗位内容');
    companyHref = '/gongsi/example-company.html'; anonymousCompany = false;
    fullTitle = '客服'; fullCompany = '示例信息咨询'; industry = '商务服务'; companyIndustry = '商务服务';
    companyIntroduction = '公司主营助贷服务，为企业和个人提供融资咨询与贷款撮合。';
    const companyDetail = await service.readJobCompanyInfo(href, fullTitle, fullCompany, { refreshCompany: true });
    assert.match(companyDetail.companyInfo!.introduction, /助贷/);
    const exclusions = { ...configManager.getConfig().filter, companyBlacklist: ['金融'], workRequirements: [] };
    assert.equal(findJobExclusion({ jobName: '客服', brandName: fullCompany, brandIndustry: '商务服务',
      companyInfo: companyDetail.companyInfo }, exclusions)?.field, '公司介绍', '助贷公司行业写商务服务，也须按公司页实际业务排除');
    industry = ''; companyIndustry = '';
    const unlabelledFinance = await service.readJobCompanyInfo(href, fullTitle, fullCompany, { refreshCompany: true });
    assert.equal(findJobExclusion({ jobName: '客服', brandName: fullCompany, brandIndustry: '',
      companyInfo: unlabelledFinance.companyInfo }, exclusions)?.field, '公司介绍', '没有行业标签也不能放过公司介绍明确的助贷业务');
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
    companyIndustry = ''; companyIntroduction = '公司经营电子商务平台，提供商家运营支持。';
    const directNoIndustry = await directService.loadJobDetail(card as any, '客户经理', '深圳信银', href,
      { readIndustry: true, refreshCompany: true, filter: { ...exclusions, companyBlacklist: [], commute: {}, skipMissingCompanyIntro: true } });
    assert.equal(directNoIndustry.brandIndustry, '');
    assert.match(directNoIndustry.companyInfo!.introduction, /商家运营/);
    await page.evaluate(() => {
      const industryLink = document.createElement('a'); industryLink.setAttribute('ka', 'job-detail-brandindustry');
      industryLink.textContent = '电子商务'; document.querySelector('.job-detail-box')!.appendChild(industryLink);
    });
    assert.equal((await directService.loadJobDetail(card as any, '客户经理', '深圳信银', href,
      { readIndustry: true, refreshCompany: true })).brandIndustry, '电子商务', '直接读取公司页时也保留岗位详情已有行业');
    browserService.withJobInspection = oldInspection;
    console.log('PASS | 完整职位页行业/隐藏干扰文字、公司页简介/经营范围/身份、助贷识别、排除推荐区域、公司信息复用、保持投递页、缺失行业继续筛选、匿名公司不重读、助贷业务仍排除');
  } finally {
    browserService.getWorkerPage = getWorker; browserService.withJobInspection = inspection;
    browserService.withCompanyInspection = companyInspection;
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
