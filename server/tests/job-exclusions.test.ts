import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configManager } from '../src/config/config.manager.js';
import { FilterService } from '../src/services/filter.service.js';
import { findJobExclusion, exclusionsFromText, needsCompanyIndustry } from '../src/services/job-exclusions.js';
import { llmService } from '../src/services/llm.service.js';
import { WorkConditionReviews } from '../src/services/work-condition-reviews.js';
import type { BossJobItem, WorkConditionReview } from '../src/types.js';

const original = configManager.getConfig();
const filter = { ...original.filter, companyBlacklist: ['金融', '房地产', '销售'], requiredKeywords: [],
  skipMissingCompanyIntro: false, skipVagueJobDescription: false,
  workRequirements: [{ id: 'hours', text: '每天工作不超过八小时', enabled: true }],
  salaryMin: 0, salaryMax: 0, degree: [], experience: [], hrActiveDaysLimit: 0 };
const base: BossJobItem = { securityId: '', jobId: '', jobName: '行政助理', lid: '', salaryDesc: '6-8K',
  jobExperience: '经验不限', jobDegree: '大专', cityName: '上海', areaDistrict: '', brandName: '测试公司',
  brandScaleName: '', brandIndustry: '企业服务', bossName: '', bossTitle: '', activeTimeDesc: '今日活跃', skills: [], welfareList: [] };
const cases: Array<[string, Partial<BossJobItem>, string, string | undefined]> = [
  ['银行归属金融', { jobName: '客户经理', brandName: '深圳信银', brandIndustry: '银行' }, '工作作息面议。', '金融'],
  ['互联网金融归属金融', { jobName: '纯客服', brandIndustry: '互联网金融' }, '每天工作8小时、双休、无经验可入职。', '金融'],
  ['证券归属金融', { brandIndustry: '证券/期货' }, '', '金融'],
  ['保险归属金融', { jobName: '行政助理', brandIndustry: '保险' }, '', '金融'],
  ['信贷归属金融', { brandIndustry: '消费金融' }, '', '金融'],
  ['基金归属金融', { brandIndustry: '基金' }, '', '金融'],
  ['投资融资归属金融', { brandIndustry: '投资/融资' }, '', '金融'],
  ['标题贷款', { jobName: '贷款顾问', brandIndustry: '' }, '', '金融'],
  ['无行业字段但职责是贷款', { jobName: '纯客服', brandIndustry: '' }, '为客户办理贷款业务，审核贷款申请资料。作息面议。', '金融'],
  ['无行业字段但职责是银行', { brandIndustry: '' }, '驻点信用卡服务和申请资料审核，提交到银行系统审核额度。', '金融'],
  ['保险产品销售', { jobName: '客服', brandIndustry: '' }, '负责保险产品推广与客户维护。', '金融'],
  ['房地产关联行业', { brandIndustry: '地产开发' }, '', '房地产'],
  ['隐藏房地产职责', { jobName: '客户顾问', brandIndustry: '' }, '负责带客看房和楼盘销售。', '房地产'],
  ['销售标题不等作息核实', { jobName: '8小时双休销售招满即止' }, '详细作息面议。', '销售'],
  ['无经验不是否定销售', { jobName: '无经验销售专员' }, '', '销售'],
  ['网销标题', { jobName: '纯网销，8小时双休' }, '', '销售'],
  ['电销标签', { jobName: '客服', skills: ['电销'] }, '', '销售'],
  ['营销标题', { jobName: '营销专员' }, '', '销售'],
  ['伪客服实际推销', { jobName: '纯客服无压力' }, '电话推销产品，并完成销售指标。', '销售'],
  ['客户开发职责', { jobName: '客户经理' }, '负责开发新客户，促成订单签约。', '销售'],
  ['课程营销不能用无后续成交绕过', { jobName: '纯邀约客服' }, '公司提供顾客资源，介绍课程信息，邀约试听课，不负责后续成交。', '销售'],
  ['标题明确销售但描述自称非销售', { jobName: '销售专员' }, '不涉及销售，作息面议。', '销售'],
  ['普通员工福利不是金融', {}, '负责文书。五险一金，补充医疗保险，养老保险。详细作息面议。', undefined],
  ['普通财务不是银行行业', { jobName: '财务助理' }, '负责银行对账、社保缴纳和凭证整理。', undefined],
  ['行政协助销售部门', {}, '协助销售部门整理表格，不涉及销售任务，无销售指标。', undefined],
  ['负责整理资料且不涉及销售', {}, '负责文书整理不涉及销售。', undefined],
  ['普通客服未知职责不猜销售', { jobName: '客服', skills: ['服务意识'] }, '接听售后咨询，处理投诉。', undefined],
  ['公益基金会不是金融', { brandName: '城市公益基金会', brandIndustry: '非盈利机构' }, '行政支持。', undefined],
  ['标题非销售', { jobName: '非销售岗位行政助理' }, '不需要销售，不承担销售指标。', undefined],
  ['房屋补贴不是房地产', {}, '提供房屋补贴与租房补贴。', undefined],
  ['否定地产业务', {}, '不从事房地产销售。', undefined],
  ['金融科技应用不等于金融公司', {}, '提供数字化运营服务以及产品工程服务，深入AI、大数据、金融科技和医疗等先进技术的应用。', undefined],
  ['技术外包服务银行客户不是银行业务', { jobName: '软件测试' }, '为银行客户提供软件开发和系统测试服务。', undefined],
  ['银行系统开发不等于办理金融业务', { jobName: '开发工程师' }, '负责银行系统开发及信息技术支持。', undefined],
  ['软件描述不能掩盖实际信贷职责', { jobName: '客服' }, '公司有软件开发部门，岗位为个人办理贷款业务，审核贷款申请。', '金融'],
];

async function main() {
  const getConfig = configManager.getConfig;
  const chat = llmService.chatJson;
  const temporary = fs.mkdtempSync(path.resolve(process.cwd(), '../data/exclusion-test-'));
  let currentFilter = filter;
  configManager.getConfig = () => ({ ...original, filter: currentFilter });
  let calls = 0;
  llmService.chatJson = (async () => { calls++; throw new Error('排除测试不应调用 AI'); }) as typeof chat;
  try {
    for (const [name, patch, detail, expected] of cases) {
      const job = { ...base, ...patch };
      assert.equal(findJobExclusion({ ...job, jobDetail: detail }, filter)?.term, expected, name);
      if (expected) {
        const local = new FilterService().evaluateLocally(job, detail, false, filter);
        assert.equal(local?.passed, false, name);
        assert.equal(local?.needsReview, undefined, name + '应先淘汰，不进入待确认');
        assert.match(local!.reason, /命中排除条件/);
      }
    }
    const service = new FilterService();
    const results = await service.evaluateBatch([
      { job: { ...base, jobName: 'AI销售', brandIndustry: '' }, jobDetail: '工作内容和作息面议。' },
      { job: { ...base, brandIndustry: '银行' }, jobDetail: '工作内容和作息面议。' },
      { job: { ...base, jobName: '电话客服', brandIndustry: '' }, jobDetail: '为客户办理信贷业务，详细作息面议。' },
    ], '希望文职工作', '文职', 'requirements');
    assert.equal(calls, 0, '被排除行业/职责不进入 AI 批次');
    assert.ok(results.every((result) => !result.passed && !result.needsReview && result.evaluationSource === 'rules'));

    const custom = { ...filter, companyBlacklist: [], workRequirements: [
      ...filter.workRequirements, { id: 'exclude', text: '不考虑金融行业和销售岗位，必须离地铁近', enabled: true },
    ] };
    assert.equal(findJobExclusion({ ...base, brandIndustry: '银行' }, custom)?.term, '金融', '复合条件中的否定项也须先执行');
    assert.equal(findJobExclusion({ ...base, jobName: '网销' }, custom)?.term, '销售');
    assert.equal(findJobExclusion({ ...base, brandIndustry: '银行' }, { ...custom,
      workRequirements: [{ ...custom.workRequirements[1], enabled: false }] }), undefined, '关闭条件后不再应用');
    currentFilter = { ...filter, companyBlacklist: [], workRequirements: filter.workRequirements };
    const manual = await service.evaluateStage2({ ...base, brandIndustry: '银行' }, '作息面议，需要确认。',
      '不考虑金融行业，不做销售，希望文职工作。', '文职', 'requirements');
    assert.equal(manual.needsReview, undefined);
    assert.match(manual.reason, /排除条件/);
    assert.equal(calls, 0, '手动要求中的排除项不能等到 AI 才判断');
    llmService.chatJson = (async () => { calls++; return { jobs: [{ jobKey: 'job-0', score: 90, passed: true, workRequirements: [] }] }; }) as typeof chat;
    const resume = await service.evaluateStage2({ ...base, brandIndustry: '银行' }, '作息面议，需要确认。',
      '过往经历：不做销售。', '文职', 'resume');
    assert.equal(resume.needsReview, true, '不能把简历中的经历误当额外排除项');
    assert.equal(resume.evaluationSource, 'ai'); assert.equal(calls, 1, '未命中当前排除条件的岗位应参与 AI 评估');
    assert.equal(findJobExclusion({ ...base, jobDetail: 'No SALES tasks.' }, { ...filter, companyBlacklist: ['test.company'] }), undefined,
      '自定义词作为字面词，不能成为正则通配符');
    assert.equal(findJobExclusion({ ...base, jobName: 'TypeScript工程师' }, { ...filter, companyBlacklist: ['typescript'] })?.term, 'typescript');
    assert.deepEqual(exclusionsFromText('不做销售，需要五险一金。'), [{ term: '销售', literal: false }]);
    assert.equal(needsCompanyIndustry({ ...filter, companyBlacklist: ['销售'], workRequirements: [] }), false);
    assert.equal(needsCompanyIndustry({ ...filter, companyBlacklist: ['金融'], workRequirements: [] }), true);
    assert.equal(needsCompanyIndustry({ ...filter, companyBlacklist: [], workRequirements: [
      { id: 'literal-company', text: '不得包含：助贷', enabled: true },
    ] }), true, '自定义字面排除词也须核对公司页');
    assert.equal(needsCompanyIndustry({ ...filter, companyBlacklist: [], workRequirements: [
      { id: 'company-product', text: '公司拥有自有软件产品', enabled: true },
    ] }), true, '自定义公司要求应读取公司资料，而不依赖预设行业词');
    const company = { url: 'https://www.zhipin.com/gongsi/example.html', name: '某咨询公司', industry: '商务服务',
      introduction: '公司主营助贷，为企业和个人提供贷款撮合及融资咨询服务。', businessScope: '信息咨询服务。', checkedAt: new Date().toISOString() };
    assert.equal(findJobExclusion({ ...base, companyInfo: company }, filter)?.field, '公司介绍');
    const technologyCompany = { ...company, name: '纬致芯创科技', industry: '计算机软件',
      introduction: '提供数字化运营服务以及产品工程服务，深入AI、大数据、金融科技和医疗等先进技术\n的应用，持续与客户携手前行。纬致科技致力于成为富有责任感的企业公民，十分重视环境保护。',
      businessScope: '信息技术咨询服务；软件开发；信息系统集成服务。' };
    for (const jobName of ['游戏垂类内容运营（小红书/包餐/双休）', '游戏垂类内容运营（新游、世界观方向）', '游戏垂类内容运营-试用期不打折-包三餐双休']) {
      const technologyJob = { ...base, jobName, brandName: technologyCompany.name, brandIndustry: technologyCompany.industry, companyInfo: technologyCompany };
      assert.equal(findJobExclusion(technologyJob, filter), undefined, '用户贴出的科技公司介绍不得误判金融：' + jobName);
      assert.equal(service.evaluateStage1(technologyJob, '负责游戏内容运营，每周双休。', filter).passed, true);
      assert.equal(service.evaluateLocally(technologyJob, '负责游戏内容运营，每周双休。', false, filter), undefined,
        '技术应用领域不产生初筛淘汰，应进入后续批量 AI 分析');
    }
    assert.equal(findJobExclusion({ ...base, companyInfo: { ...technologyCompany,
      introduction: '为银行、保险及金融机构提供软件开发、信息技术外包和系统测试服务。' } }, filter), undefined);
    assert.equal(findJobExclusion({ ...base, companyInfo: { ...technologyCompany,
      introduction: technologyCompany.introduction + '公司实际主营助贷，提供贷款撮合。' } }, filter)?.term, '金融',
      '忽略应用领域后仍须继续查找真实助贷证据');
    assert.equal(findJobExclusion({ ...base, companyInfo: { ...technologyCompany,
      introduction: '公司主营金融服务与软件开发。' } }, filter)?.term, '金融', '主营金融服务不能被技术词覆盖');
    assert.equal(findJobExclusion({ ...base, companyInfo: { ...technologyCompany,
      introduction: '主营网上旅游信息服务、酒店订房与旅游产品运营。', businessScope: '科技咨询，市场咨询，投资咨询，信息服务，订房服务。' } }, filter), undefined,
      '旅游主营明确时，宽泛工商许可投资咨询不能单独判为金融公司');
    assert.equal(findJobExclusion({ ...base, companyInfo: technologyCompany }, { ...filter, companyBlacklist: ['金融科技'] })?.term, '金融科技',
      '用户明确排除字面词时仍执行该自定义条件');
    assert.equal(findJobExclusion({ ...base, companyInfo: { ...company, introduction: '企业管理咨询。', businessScope: '经营贷款中介服务。' } }, filter)?.field,
      '公司经营范围');
    assert.equal(findJobExclusion({ ...base, companyInfo: { ...company, introduction: '办公地址在东方金融广场。',
      businessScope: '企业管理咨询（不得从事金融业务）。' } }, filter), undefined, '地址或禁止从事的业务不能当作实际经营业务');
    assert.equal(findJobExclusion({ ...base, companyInfo: { ...company, introduction: '为企业提供信息技术服务。',
      businessScope: '市场营销策划；互联网销售。' } }, filter), undefined, '公司注册销售许可不能证明行政岗位从事销售');
    assert.equal(findJobExclusion({ ...base, companyInfo: { ...company, introduction: '为企业提供信息技术服务。',
      businessScope: '信息咨询服务（不含金融、证券、期货业务）。' } }, filter), undefined, '经营范围排除的业务不算金融经营证据');
    assert.equal(findJobExclusion({ ...base, companyInfo: { ...company, introduction: '为企业提供信息技术服务。',
      businessScope: '非居住房地产租赁；以自有资金从事投资活动；接受金融机构委托从事信息技术外包。' } }, filter), undefined,
      '办公房产租赁、自有资金投资、允许技术外包不能证明公司属于被否定的行业');
    const unclear = service.evaluateLocally({ ...base, companyInfo: { ...company, introduction: '', businessScope: '信息咨询服务。' } },
      '负责资料整理，每天工作8小时。', true, filter);
    assert.equal(unclear?.needsCompanyConfirmation, true, '宽泛行业且没有简介，不能直接认定实际业务符合排除条件');
    assert.equal(unclear?.passed, false);
    const customUnclear = service.evaluateLocally({ ...base, companyInfo: { ...company, introduction: '' } },
      '负责资料整理，每天工作8小时。', true, { ...filter, companyBlacklist: ['劳务派遣'] });
    assert.equal(customUnclear?.needsCompanyConfirmation, true, '业务资料缺失时，自定义公司排除条件同样不能直接认定符合');
    const concise = service.evaluateLocally({ ...base, companyInfo: { ...company, introduction: '公司主营行政文档整理服务。' } },
      '负责资料整理，每天工作8小时。', true, filter);
    assert.equal(concise?.passed, true, '简短但明确的公司简介不能因字数少而被当作缺失');

    const file = path.join(temporary, 'reviews.json');
    const store = new WorkConditionReviews(file);
    const input: Omit<WorkConditionReview, 'id' | 'question' | 'updatedAt'> = {
      jobHref: '/job_detail/normal.html', jobName: '行政助理', companyName: '某企业', salary: '6-8K', reason: '作息待确认',
      requirements: filter.workRequirements, assessment: [{ requirementId: 'hours', text: filter.workRequirements[0].text, status: 'unknown', evidence: '' }],
      screening: { industry: '企业服务', jobDetail: '负责行政文书和日常接待，作息面议。', skills: [] },
    };
    store.add(input);
    store.add({ ...input, jobHref: '/job_detail/finance.html', screening: { ...input.screening!, industry: '银行' } });
    store.add({ ...input, jobHref: '/job_detail/sales.html', jobName: '纯网销八小时' });
    store.add({ ...input, jobHref: '/job_detail/hidden-sales.html', jobName: '客服',
      screening: { ...input.screening!, jobDetail: '负责开发新客户，促成订单签约。' } });
    assert.equal(store.list().length, 4);
    const before = fs.readFileSync(file, 'utf8');
    currentFilter = filter;
    assert.deepEqual(store.listEligible().map((item) => item.jobHref), ['https://www.zhipin.com/job_detail/normal.html']);
    const cleanup = store.pruneExcluded();
    assert.equal(cleanup.removed, 3);
    assert.equal(fs.readFileSync(cleanup.backup!, 'utf8'), before, '清理前须备份完整原始记录');
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].screening?.jobDetail, input.screening?.jobDetail, '保留完整描述，便于以后重筛');
    assert.throws(() => store.add({ ...input, jobHref: '/job_detail/loan-company.html',
      screening: { ...input.screening!, companyInfo: company } }), /排除条件/, '公司页显示助贷的职位不能进入待确认');
    assert.equal(store.pruneExcluded().removed, 0, '重复重筛不再创建备份或删除合格记录');
    assert.throws(() => store.add({ ...input, jobName: '电销客服' }), /排除条件/, '持久化入口也不能接收已排除岗位');
    const taskRules = exclusionsFromText('不做销售');
    assert.throws(() => store.add({ ...input, jobName: '客服', screening: { ...input.screening!,
      jobDetail: '电话推销产品，并完成销售指标。', taskExclusions: taskRules } }), /排除条件/);
    store.add({ ...input, jobHref: '/job_detail/company-only.html', requirements: [], assessment: [],
      screening: { ...input.screening!, companyInfo: { ...company, introduction: '' }, needsCompanyConfirmation: true } });
    const companyOnly = store.list().find((item) => item.jobHref.endsWith('/company-only.html'));
    assert.ok(companyOnly?.question.includes('公司的主要业务'), '没有启用工作条件时，公司业务未知仍可独立保存待确认');
    fs.writeFileSync(file, '{invalid', 'utf8');
    assert.throws(() => store.pruneExcluded(), SyntaxError);
    assert.equal(fs.readFileSync(file, 'utf8'), '{invalid', '损坏文件不能因重筛而被覆盖');
    currentFilter = { ...filter, companyBlacklist: [], workRequirements: [{ id: 'product', text: '公司拥有自有软件产品', enabled: true }] };
    const productCompany = { ...company, introduction: '公司主营自有软件产品研发与销售。' };
    const metadataService = new FilterService();
    llmService.chatJson = (async (messages: any[]) => {
      calls++;
      const jobs = JSON.parse(messages[1].content.split('【待评估岗位列表（逐个评估）】：\n')[1]);
      assert.equal(jobs[0].companyInfo.introduction, productCompany.introduction, '复杂要求的批量评估必须收到对应公司的真实介绍');
      return { jobs: [{ jobKey: 'job-0', score: 90, passed: true, workRequirements: [
        { requirementId: 'product', status: 'met', evidence: productCompany.introduction },
      ] }] };
    }) as typeof chat;
    const withCompany = { ...base, companyInfo: productCompany };
    const matched = await metadataService.evaluateStage2(withCompany, '负责产品资料整理与客户信息归档。', '希望在自有软件产品公司工作。', '文职', 'requirements');
    assert.equal(matched.passed, true, '自定义公司条件须能验证本公司介绍中的原文');
    const repeated = await metadataService.evaluateStage2({ ...withCompany, companyInfo: { ...productCompany, checkedAt: new Date(Date.now() + 1000).toISOString() } },
      '负责产品资料整理与客户信息归档。', '希望在自有软件产品公司工作。', '文职', 'requirements');
    assert.equal(repeated.evaluationSource, 'cache');
    assert.equal(calls, 2, '只更新核查时间，不应触发重复 AI 请求');
    console.log('PASS | ' + cases.length + ' 类行业/职责与误判案例、否定条件优先、零 AI 请求、手动要求/关闭条件、待确认复筛与原记录备份');
  } finally {
    configManager.getConfig = getConfig;
    llmService.chatJson = chat;
    for (const file of fs.readdirSync(temporary)) fs.unlinkSync(path.join(temporary, file));
    fs.rmdirSync(temporary);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
