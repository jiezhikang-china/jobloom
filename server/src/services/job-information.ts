import type { AppConfig, BossCompanyInfo } from '../types.js';

const actions = /接待|接听|答疑|回复|解答|处理|整理|归档|录入|登记|统计|核对|审核|结算|对账|开票|收银|采购|备货|配送|运送|驾驶|装卸|分拣|包装|质检|检测|加工|组装|操作|维修|维护|巡检|巡查|值守|清洁|打扫|洗涤|烹饪|切配|制作|设计|绘制|开发|编写|测试|排查|部署|配置|搭建|实施|评测|标注|翻译|撰写|拍摄|剪辑|策划|运营|发布|教学|授课|辅导|护理|照护|看护|诊疗|招聘|面试|办理|跟进|对接|沟通|联系|邀约|销售|推广|演示|分析|研究|支持|管理|收集|修剪|种植|养护|配菜|理货|盘点|服务/g;
const generic = /负责|协助|完成|进行|开展|担任|从事|做好|安排|服从|领导|上级|主管|老板|公司|部门|团队|日常|相关|其他|基础|简单|本职|临时|交办|交代|分配|要求|任务|事务|工作|内容|职责|事宜|事项|岗位|即可|就行|面议|面谈|详谈|具体|详情|私聊|加微信|咨询|沟通能力|管理能力|服务意识|身体健康|积极主动|吃苦耐劳|认真负责|责任心|年龄|学历|经验|不限|优先|有无|均可|接受|无须|无需|不需要|提供|正在|诚聘|急聘|急招|招聘中/g;
const placeholder = /^(?:(?:公司|企业)?(?:介绍|简介)[：:]?)?(?:暂无(?:(?:公司|企业)?(?:内容|介绍|简介|信息))?|无|未(?:填写|提供|发布)(?:(?:公司|企业)?(?:内容|介绍|简介|信息))?|暂未(?:填写|提供)(?:(?:公司|企业)?(?:内容|介绍|简介|信息))?|待完善|敬请期待)[。.!！]*$/;

export function hasCompanyIntroduction(info: BossCompanyInfo): boolean {
  const text = info.introduction.normalize('NFKC').replace(/\s+/g, '').trim();
  return !!text && !placeholder.test(text);
}

/** A concrete activity plus its subject; schedules and character traits alone do not establish duties. */
export function hasClearJobDuties(description: string): boolean {
  const text = description.normalize('NFKC');
  const responsibility = text.replace(/(?:岗位职责|工作内容|职位描述|工作职责|职责描述|主要职责|岗位内容)\s*[：:]/g, '\n');
  return responsibility.split(/[\n。；;！!]/).some((line) => {
    const value = line.replace(/^[\s\d、.：（）()【】\[\]-]+/, '').trim();
    if (!value || /^(?:任职要求|岗位要求|任职资格|应聘要求|要求|需具备|应具备|具有|具备|有.{0,12}经验|熟悉|熟练|擅长|年龄|学历|薪资|工资|福利|待遇|工作时间|上班时间)/.test(value)) return false;
    if (/\b(?:handle|maintain|develop|design|test|process|deliver|prepare|operate|clean|teach|manage)\b.{3,}/i.test(value)) return true;
    const operative = value.replace(/沟通能力|管理能力|服务意识|沟通技巧|服务态度|工作态度|招聘中/g, '');
    actions.lastIndex = 0;
    if (!actions.test(operative)) return false;
    actions.lastIndex = 0;
    const subject = value.replace(generic, '').replace(actions, '').replace(/[\s\p{P}\p{N}]/gu, '');
    return /[\p{L}]{2}/u.test(subject);
  });
}

export function jobInformationIssue(evidence: { jobDetail?: string; companyInfo?: BossCompanyInfo },
  filter: AppConfig['filter']): string | undefined {
  if (filter.skipVagueJobDescription === true && evidence.jobDetail !== undefined && !hasClearJobDuties(evidence.jobDetail)) {
    return '岗位职责不清晰：描述中没有明确的工作动作及工作对象';
  }
  if (filter.skipMissingCompanyIntro === true && evidence.companyInfo && !hasCompanyIntroduction(evidence.companyInfo)) {
    return '公司页没有公司介绍：不以行业标签或工商经营范围代替介绍';
  }
  return undefined;
}
