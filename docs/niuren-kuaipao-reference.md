# 牛人快跑源码参考：Electron 与内部操作节奏

研究日期：2026-10-05（Asia/Shanghai）。只读查看公开源码，未执行上游代码，未访问 BOSS 账号。

## 项目与固定版本

准确项目为 [geekgeekrun/geekgeekrun](https://github.com/geekgeekrun/geekgeekrun)，固定检查 commit [c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a](https://github.com/geekgeekrun/geekgeekrun/tree/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a)。README 明确名称为“牛人快跑 - GeekGeekRun”。[README](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/README.md)

## Electron 架构

桌面使用 Electron、Vue 3、electron-vite、electron-builder；浏览器自动化使用 Puppeteer。[桌面依赖](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/ui/package.json)、[根依赖](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/package.json)

主窗口使用 BrowserWindow 和 preload，生产加载本地 HTML，开发加载开发服务器；后台消息经主进程转发至渲染窗口。preload 通过 contextBridge 暴露 API，但还有无上下文隔离回退，窗口设置 sandbox:false；这些权限选择不作为本项目安全模板。[主窗口](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/ui/src/main/window/mainWindow.ts#L7-L59)、[preload](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/ui/src/preload/index.ts)

GUI 启动独立守护进程。所有窗口关闭时退出并断开客户端；守护进程按启动任务的连接记录所属 worker，连接断开后停止这些 worker。显式停止先记录停止标志再终止进程，防止重启竞态。[窗口关闭](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/ui/src/main/flow/OPEN_SETTING_WINDOW/index.ts#L49-L90)、[后台启动](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/ui/src/main/flow/OPEN_SETTING_WINDOW/launch-daemon.ts#L24-L41)、[客户端关闭处理](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/pm/daemon.js#L86-L101)、[任务归属](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/pm/daemon.js#L185-L218)、[停止实现](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/pm/daemon.js#L365-L398)

可参考本地界面、隔离 preload、任务生命周期与显式停止。无须为了参考上游把 React 改为 Vue。

## SageTime 统计的准确单位

默认开启，参数 100、15 分钟。模块内计数器每次调用检查点函数加一；并非每个 DOM 动作、请求或岗位加一。条件是 recordedOpCount > sageTimeOpTimes：从零开始时前 101 次调用增加到 101，第 102 次进入休息，休息后清零。没有持久化计数。[默认配置](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/default-config-file/boss.json#L39-L41)、[完整实现](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/sage-time.mjs#L24-L53)

| 检查点 | 动作和源码 |
| --- | --- |
| afterJobSourceChosen | [职位来源切换后](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L888-L892) |
| afterJobListPageFetched | [列表翻页获取后](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1098-L1103) |
| afterJobDetailFetched | [详情获取后](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1145-L1150) |
| beforeJobNotSuitMarked | 公司、活跃度、城市、经验、岗位内容、薪资分支执行平台“不合适”前。[示例](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1176-L1180)、[其它分支](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1217-L1389) |
| beforeJobChatStartup | [开聊前](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1516-L1527) |
| beforeJobChatStartupAfterTwiceConfirm | [部分沟通确认弹窗前](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1585-L1609) |

一个岗位可涉及详情与开聊两个检查点，平台标记不合适也计数，纯本地评估不会自动计入。统一 DOM 队列逐动作计数是本项目自己的保守设计，不能声称与上游 100 的单位一致。

## 分散延迟与退避

随机延迟函数为基础值加 0–1000 毫秒。[sleep.mjs](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/utils/sleep.mjs)

上游列表筛选循环基础 2500 毫秒；详情点击前固定 500 毫秒、详情响应后基础 2000 毫秒；列表翻页后固定 5000 毫秒；开聊前基础 1000 毫秒再固定 500 毫秒；沟通响应后基础 3000 毫秒。没有统一动作队列，滚轮循环仍可每 100 毫秒滚动。[列表循环](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L830-L847)、[翻页和详情](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1080-L1149)、[开聊阶段](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1516-L1547)

无匹配岗位时基础 25 秒后换条件；所有来源遍历后等待 20–50 秒再次遍历。每日沟通额度用完等待 60 分钟再抛错，由外围循环恢复。[分支退避和循环](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1646-L1692)

可采用分阶段节奏、累计活动后休息、无岗位时退避。不采用额度用尽后自动恢复，不恢复用户要求删除的模拟阅读 16 秒停顿。本项目发送后的“继续沟通”属于结果确认，应及时处理。

## 异常停止与登录存储

403/error 页面抛出访问拒绝；核心入口对登录失效、网络断开、访问拒绝用明确退出码。其它异常关闭浏览器并默认 5 秒重跑；守护进程对非排除退出码默认 2 秒重启。[页面检查](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L685-L708)、[核心退出和重试](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/run-core-of-geek-auto-start-chat-with-boss/main.mjs#L22-L88)、[守护进程重启](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/pm/daemon.js#L247-L325)

登录助手等待登录成功与页面跳转，安全检查页等待人工导航，随后读取 cookie 并存本机。主循环恢复 cookies/localStorage，成功沟通后更新保存，存储位于用户目录 .geekgeekrun/storage。[登录保存](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/launch-bosszhipin-login-page-with-preload-extension/index.mjs#L64-L114)、[加载和保存](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1713-L1770)、[存储目录](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/runtime-file-utils.mjs)

本项目保留更严格的持久停止：验证码、频率限制、访问限制、封禁及未知发送结果不通用重启。窗口关闭停止任务，任务结束不删除登录态。

## 不直接采用的部分

上游启用了 stealth 和匿名 UA 插件；这些是浏览器特征伪装，不纳入本次重构，不采用验证码绕过、代理轮换、账号轮换。[初始化源码](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L88-L107)

README 自述可能出现退出登录、限制使用、封禁，未保证规避。上游默认参数是项目实现，**不是 BOSS 官方安全阈值**；本次没有得到免封依据。[上游说明](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/README.md)

按用户要求，操作节奏、累计休息、滚动限额、异常停止由内部策略管理，不暴露用户配置开关；每日投递数量和岗位条件等业务设置仍可调。已报告封禁账号继续停止，本次无真实投递及压力测试。

## 2026-10-07 真实长测后的校正

旧实现把 60 次原生动作作为长休息单位，还设置每小时 10 次共享写入限制。约 24 分钟基线实测扫描 15 个岗位、9 次反馈、0 次投递；2 个候选被未能完成的下一次反馈阻塞，日志等待 2343 秒。两项均是本项目自己的保守设计，不能归因于牛人快跑。

用户指出过于保守后，再次核对上游默认配置及 SageTime。改为约 100 次实际业务动作后休息 15 分钟：来源切换、列表加载、详情选择、反馈、提交计数，普通控件操作不计入长休息。详情重读或失败的业务动作也计数。统一 DOM 队列、分钟/小时操作节奏、持久异常停止继续使用。删除共享的每小时 10 次写入上限；保留写入间隔，不增加用户配置项。

本项目计数记录可跨重启保存，比上游内存计数多这一项。其检查点通过动作分类实现，不能声称调用次数与上游完全相同。详情选择仍使用本项目现行的浏览间隔。候选等待超过 90 秒或即将进入长休息时，提前合并短批次评估，AI 自身的请求间隔仍有效。

基线记录保存在本机忽略目录 data/live-delivery-long-test-baseline；修改后续测见 real-delivery-long-test.md。账号已由用户确认解封，本轮最多 30 个真实投递得到明确授权。