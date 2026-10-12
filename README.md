# 拾职 · Jobloom

<img src="assets/brand/jobloom-icon.png" alt="Jobloom 应用图标" width="96" height="96">

基于 Electron 的 Windows 求职辅助工具，通过独立 Chrome 窗口读取 BOSS 直聘网页，结合本地规则和 AI 评估筛选岗位，提供待确认岗位管理与投递辅助。

**项目处于持续开发阶段。简历优化尚未实现，不属于当前可用功能。** 当前提供源码运行方式，尚无独立安装包。

## 功能状态

| 功能 | 当前状态 |
| --- | --- |
| Electron 桌面界面、设置和运行日志 | 已接入 |
| BOSS 扫码登录与专用浏览器会话保存 | 已接入，实际会话由平台决定 |
| 官方岗位分类、目标岗位与自选期望设置 | 已接入 |
| 脚本初筛、公司详情核查、AI 批量评估 | 已接入 |
| 自定义需求词、排除项和工作条件 | 已接入，工作条件支持必须确认／投递后追问／偏好 |
| 候选持久化、原链接恢复、技术异常重试 | 已接入，通过隔离回归 |
| 搜索来源轮转与去重转化统计 | 已接入，真实效果待验收 |
| 面试进度、日历导出、录用比较、简历版本 | 已接入，本地记录 |
| 自动投递、待确认岗位单条或批量投递 | 已接入，发送结果需核对 |
| 沟通台账、消息监控、工作条件询问、规则追聊 | 已接入；真实登录消息页只读核对通过，真实发送待验收 |
| 每日投递上限 | 可设置 0–150 |
| 地图选点、系统定位与岗位距离筛选 | 已接入，距离为直线距离 |
| 公交、地铁路线与交通时间 | 不支持，不应作为筛选依据 |
| 简历上传、文本读取与分析 | 已有基础能力 |
| **简历优化、按原 PDF 排版生成优化稿并上传 BOSS** | **未实现，现有实验代码或界面入口不代表功能已完成** |
| 独立 Windows 安装程序 | 未提供 |

详见 [功能状态](docs/FEATURE_STATUS.md)。历史开发记录不作为当前功能承诺。

## 安装与启动

### 环境

- Windows 与 Google Chrome。
- Node.js 和 npm；开发验证环境使用 Node.js 24。
- Chrome 默认检测标准安装路径，可用 BOSS_CHROME_PATH 指定其他位置。
- 项目目录需要写入权限，用于保存本机配置、登录资料和日志。

在项目根目录打开终端，安装三个目录的依赖：

~~~powershell
npm ci
npm --prefix server ci
npm --prefix client ci
~~~

首次启动并构建：

~~~powershell
npm run desktop
~~~

也可双击根目录的 启动桌面版-调试.cmd。构建完成后，日常可使用 启动桌面版.vbs，或运行：

~~~powershell
npm run desktop:open
~~~

更新代码后先停止任务、关闭旧窗口，再运行 npm run desktop 重新构建。desktop:open 和 VBS 入口不会自动重新构建。

## 使用流程

1. 在设置中配置 AI。默认集成本地 DeepSeek 网页适配进程，打开其登录窗口后手动登录，再测试连接；也保留兼容 API 配置方式。
2. 打开 BOSS 登录窗口并手动扫码。BOSS 与模型账号分别保存在本机，不共用登录资料。
3. 选择简历匹配或手动指定目标，填写目标岗位、城市、每日数量以及筛选条件。
4. 可指定 1–3 个 BOSS 官方岗位。按自选来源运行时，工具会修改并保存 BOSS 求职期望中的岗位和城市；已有匹配项优先保留。
5. 先由脚本初筛，再暂存合格候选，合并请求 AI。每条工作条件可选必须确认、投递后追问或偏好；原有条件默认必须确认。读取和 AI 格式错误会进入系统恢复队列。
6. 启动任务后查看运行记录。暂停、停止和再次开始均由用户控制，不会因应用重启自动投递。
7. 投递成功的岗位会自动进入“沟通跟进”。可先只读核对，再保存设置并主动开启自动跟进。旧岗位可以手动加入。详细边界见 [沟通跟进](docs/followup.md)。
8. 在“求职进度”查看候选恢复、面试、录用条件和简历版本。新版完整改进与验收见 [系统改进总任务](docs/improvement-roadmap.md)。

岗位要求“大专”不会直接排除本科学历。经验默认宽泛处理，列表中的“1–3年”标签不单独作为硬性淘汰依据。金融、助贷、销售等排除项根据真实岗位职责、公司行业及业务介绍判断，不因介绍提到银行客户或金融科技应用就直接排除。

招聘描述只能表明招聘方公开写出的条件，不能证明实际工时、双休和入职要求一定执行。

## 浏览器操作与人工恢复

BOSS 页面共用操作队列。选岗节奏采用人工 DOM 记录，普通控件、输入、导航和写入分别管理间隔；公司页暂定至少保留约 3 秒，加载与分析时间计入其中。累计业务检查达到阈值后关闭专用浏览器休息，再重新核对登录。正常完成、达到本地配额或主动停止后也会关闭专用浏览器并保留登录资料；人工验证或故障处理页面保留。

检测到登录失效、安全验证或账号限制时停止自动操作。通过普通登录按钮打开或唤起现有页面；完成登录或验证后，点击“验证登录”或主动开始任务，系统核对当前页面后继续。界面没有独立的停止状态面板、恢复勾选框或全局禁用按钮。工具不自动处理验证码，也不保证账号不会被平台限制。

“不合适”仅用于用户明确排除的岗位或公司，AI 分数低不单独触发网站反馈。

## AI 接入说明

DeepSeek 网页模式使用 vendor/deepseek-web-proxy 中的本地适配组件，来源与改动见 [上游声明](vendor/deepseek-web-proxy/UPSTREAM.md)。该模式使用网页登录凭据，通过本机兼容接口调用网页服务，**不是 DeepSeek 官方开放平台 API**。

深度思考与联网开关独立配置。网页模式的本地模型标识不代表官方 API 模型版本。账号能力、网页协议和服务可用性变化可能导致调用失败；失败、输出不完整或发送结果不明时，应按界面提示处理。

岗位评估会向所选模型服务发送所需的简历文本、求职要求及岗位／公司资料。使用前应确认发送范围，并自行去除不希望外传的内容；不要将“文件保存在本机”等同于“所有分析都在本机完成”。

## 地图与距离

地图采用 Leaflet 和 OpenStreetMap，可搜索地点、手动选点或主动获取 Windows 系统位置。系统定位受权限与设备能力影响。岗位坐标可核对时计算直线距离；坐标缺失则保留待确认，不以城市中心代替实际地址。

公共地图和搜索服务需要网络，并遵循各自的使用政策。项目不要求个人地图 API Key。组件授权见 [第三方声明](client/THIRD_PARTY_NOTICES.md)。

## 项目结构

~~~text
client/                    React + TypeScript 桌面界面
desktop/                   Electron 主进程、preload 与桌面协议
server/                    本地后台、网页 DOM 与业务流程
vendor/deepseek-web-proxy/  独立模型网页适配组件
docs/                      功能边界、使用与开发记录
data/                      本机运行数据，不纳入 Git
~~~

## 开发与验证

构建前后端：

~~~powershell
npm run desktop:prepare
~~~

以下测试使用模拟对象、虚拟时间或离线页面，不需要真实投递：

~~~powershell
npm --prefix server run test:pace-calibration
npm --prefix server run test:company-pacing
npm --prefix server run test:boss-safety
npm --prefix server run test:candidates
npm --prefix server run test:delivery-batching
npm --prefix server run test:followup
npm --prefix server run test:exclusions
npm --prefix server run test:industry
npm run test:desktop
~~~

部分浏览器测试需要本机 Chrome。测试通过不代表真实平台当前可用，也不代表已完成所有功能的端到端验证。历史账号测试记录仅用于排查当时的问题。

开发时可分别运行 npm run dev:server 与 npm run dev:client。本地后台默认监听 127.0.0.1；不要直接对公网开放。

## 数据与 GitHub 上传

data/、简历、浏览器资料、账号配置、运行日志、依赖和构建产物通过 .gitignore 排除。不要通过压缩整个工作目录的方式上传，也不要强制加入被忽略的目录。

准备发布前请阅读 [GitHub 上传说明](docs/GITHUB_UPLOAD.md)，检查当前文件及 Git 历史中的个人资料与凭据。

## 第三方许可

- 地图组件：见 [Leaflet 声明](client/THIRD_PARTY_NOTICES.md)。
- DeepSeek 网页适配组件：GPL-3.0-or-later，保留 [上游说明](vendor/deepseek-web-proxy/UPSTREAM.md) 与 [许可证](vendor/deepseek-web-proxy/LICENSE)。
- 实验 PDF 组件涉及独立的第三方许可，不因“简历优化未实现”而免除分发时的许可义务。

主项目目前没有根目录 LICENSE 文件；package.json 中的 MIT 字段不代表已完成仓库许可整理。正式选择仓库许可证前，应核对主项目及第三方组件的分发要求。
