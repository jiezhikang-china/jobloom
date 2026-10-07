# 牛人快跑浏览器生命周期源码复核

核对日期：2026-10-07（Asia/Shanghai）。本次只读访问 GitHub 公开源码；未运行上游程序，未访问 BOSS 账号，未发起投递。

## 固定版本与核对方法

研究项目为 [geekgeekrun/geekgeekrun](https://github.com/geekgeekrun/geekgeekrun)。GitHub commits/master API 本次返回 [c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a](https://github.com/geekgeekrun/geekgeekrun/commit/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a)，提交时间 2026-05-02T14:27:32Z。以下链接全部固定到该提交，不能推及其他版本或第三方修改版。

重新下载了该提交的 SageTime、核心 index、CLI main、GUI 主入口、CookieInvalidHandlePlugin、GtagPlugin、默认配置、任务启动与守护进程源码。SageTime、核心 index、CLI main、GUI 主入口、CookieInvalidHandlePlugin、默认配置与本机此前保存的源码逐字符一致。结论取自源码调用链，不以此前 docs/niuren-kuaipao-reference.md 的文字作为证据。

## 1. 默认累计休息没有关闭再打开浏览器

默认配置启用 SageTime，参数是 100 次检查点、15 分钟。[默认配置 boss.json 第 39–41 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/default-config-file/boss.json#L39-L41)

SageTime 的实际顺序为：判断计数 → sageTimeEnter hook → 等待 → sageTimeExit hook → 清零。整个函数没有关闭浏览器、重新启动、抛出控制性异常。判断是 recordedOpCount > sageTimeOpTimes；从零开始，默认前 101 次调用累加，第 102 次调用才进入休息。计数只在模块内存中。[sage-time.mjs 第 23–54 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/sage-time.mjs#L23-L54)

GUI 主入口注册的默认插件为 Dingtalk、Sqlite、Gtag 和 CookieInvalidHandlePlugin。核对这四个插件后，只有 GtagPlugin 注册 SageTime enter/exit，其内容只是记录事件，没有浏览器操作。因此默认 GUI 插件也没有把 SageTime 变成关闭再打开。[GUI 插件注册第 41–46 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/ui/src/main/flow/GEEK_AUTO_START_CHAT_WITH_BOSS_MAIN/index.ts#L41-L46)、[GtagPlugin 第 34–38 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/ui/src/main/utils/gtag/GtagPlugin.ts#L34-L38)、[Dingtalk 插件](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/dingtalk-plugin/index.mjs)、[Sqlite 插件](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/sqlite-plugin/src/index.ts)、[CookieInvalidHandlePlugin](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/ui/src/main/features/cookie-invalid-handle-plugin.ts)

检查点位于来源切换后、列表翻页后、详情读取后、平台“不合适”前、开聊前及部分二次确认前。一个岗位可能触发多个检查点；它不是“100 次投递”或“100 个原生 DOM 操作”。[来源与列表](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L888-L892)、[详情](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1145-L1148)、[反馈示例](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1176-L1179)、[开聊及确认](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1516-L1608)

## 2. 关闭再打开实际发生在哪里

| 场景 | 可核实的调用链 |
| --- | --- |
| 普通未处理异常 | 核心 mainLoop catch 调用 closeBrowserWindow 后抛出；CLI/GUI 外层记录普通异常、默认等待 5 秒，再次调用 mainLoop；后者重新 puppeteer.launch。 |
| 每日沟通额度用尽 | 先保存登录存储，抛出额度用尽错误；内部 catch 等待 60 分钟，再抛出，随后进入上述关闭与重跑链。浏览器并非在这 60 分钟开始时关闭。 |
| 遍历后无新岗位 | 等待 20–50 秒后导航回岗位页；切换来源等待 10–25 秒；没有关闭浏览器。 |
| 用户点“停止开聊” | 界面调用停止 IPC，主进程向守护进程发送 stop-worker；守护进程先写入 stoppedWorkers，再终止 worker，避免延时重启竞态。它是结束任务，不是自动休息后继续。 |

源码：[核心关闭、启动与存储第 1697–1771 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1697-L1771)、[额度等待与无岗位退避第 1653–1692 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1653-L1692)、[CLI 外层重试第 67–88 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/run-core-of-geek-auto-start-chat-with-boss/main.mjs#L67-L88)、[GUI 外层第 129–166 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/ui/src/main/flow/GEEK_AUTO_START_CHAT_WITH_BOSS_MAIN/index.ts#L129-L166)、[停止 IPC 第 218–242 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/ui/src/main/flow/OPEN_SETTING_WINDOW/ipc/index.ts#L218-L242)、[停止标志与 worker 终止第 365–401 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/pm/daemon.js#L365-L401)

closeBrowserWindow 调用 browser.close 后还尝试终止该 browser 的进程，并清空 browser/page 引用；不是只断开控制连接。[实现第 1744–1754 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1744-L1754)

## 3. 登录失效、强制下线与访问拒绝

初始进入岗位页后，核心检查用户信息响应。非零结果进入登录无效路径；403/error 页面另报 ACCESS_IS_DENIED。仅凭这两个条件，不能区分 Cookie 自然过期、账号被平台强制退出、限制或其他具体原因。[检查第 674–710 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L674-L710)

### HTTP 200 的业务错误也会被识别，但只证实身份接口这一条

上游在 index.mjs 第 675–681 行等待 /wapi/zpuser/wap/getUserInfo.json，直接读取 response.json()，没有要求 HTTP 401/403；第 703 行通过 JSON 的 code !== 0 判登录无效。GUI 插件第 77–98 行也以 code === 0 为成功，否则启动人工登录路径。因此 HTTP 200 加非零业务 code 在这个身份接口上也会触发处理。[核心 JSON 检查](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L675-L708)、[GUI JSON 检查](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/ui/src/main/features/cookie-invalid-handle-plugin.ts#L77-L98)

本次核对的核心与默认插件没有看到专门将 code 37 映射为“强制下线”的逻辑，也没有证实它对运行中所有业务接口都提供统一下线监听。开聊接口的 code === 0、bizCode 和提醒弹窗字段属于另一套业务判断；不能把任意非零 code 一律当成登录失效。[开聊响应判断](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/geek-auto-start-chat-with-boss/index.mjs#L1581-L1628)

对本项目的建议是：身份接口非零结果、明确的未登录/登录过期/被其他设备登录/强制退出消息、401/403/429、页面登录/安全验证状态分别分类。只观察响应，不为探测账号状态额外高频发请求；不记录完整个人信息响应。对于没有已知语义的错误码保留错误摘要并停止当前自动业务链，不推断成安全可重试。
GUI 的 CookieInvalidHandlePlugin 可先关闭浏览器、清空旧 Cookie、打开人工登录助手。登录完成后抛出 THROW_FOR_RETRY 让外层重新开始；取消登录则抛 LOGIN_STATUS_INVALID。此处重新登录需要人工，不是自动破解验证。[插件第 77–132 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/ui/src/main/features/cookie-invalid-handle-plugin.ts#L77-L132)

必须区分 CLI 与 GUI 的守护层：

- CLI daemon-main 对枚举内全部已知退出码停止，不重启。[daemon-main 第 32–46 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/run-core-of-geek-auto-start-chat-with-boss/daemon-main.mjs#L32-L46)
- GUI run-common 只禁止 85（浏览器不可用）、82（登录无效）、86（模型不可用）重启，没有加入 83（断网）和 84（访问拒绝）。因此 GUI 核心退出不等于最终停止；守护进程对未排除退出码可在 2 秒后重启。不能将上游概括成“遇到所有限制都持久停止”。[run-common 第 35–42 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/ui/src/main/features/run-common.ts#L35-L42)、[GUI 退出码](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/ui/src/common/enums/auto-start-chat.ts#L1-L8)、[守护层判断与重启第 247–325 行](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/packages/pm/daemon.js#L247-L325)

## 4. 对本项目可复用的生命周期方案

以下是本项目的工程建议，不是声称上游已有的完整实现，也不是平台认可的免限制参数：

1. 为正常累计休息单独建立流程：在当前读取/提交确认结束后冻结后续动作，保存来源位置、候选与已确认结果，关闭本项目专用 BOSS 浏览器，并确认进程确实结束。
2. 休息计时从实际关闭完成后开始；保留同一个本机 profile 和登录存储，避免丢失登录、重复发送或切换到其他账号。
3. 到时只在任务仍允许运行、无人工暂停/停止、无账号异常时重新打开；先检查页面与登录，再恢复选岗。任何旧 page/locator/句柄重新取得。
4. 账号强制下线、验证码、访问拒绝与正常休息分开记录；这些情况停止自动业务操作，等待人工处理，不能沿用普通异常重启去反复访问。
5. 关闭失败、重新打开失败和发送结果未知均不能当作休息完成。停止/暂停必须能取消计时及重开；跨进程重启也不能丢失这些状态。
6. 先用本地模拟页面与浏览器进程验证“关闭完成—完整休息—重新打开—登录检查—恢复位置”顺序，覆盖停止、暂停、关闭失败、限制信号和未知发送结果；不以真实账号连续投递来验证是否免风控。

## 5. 不能由当前证据证实的结论

- 不能证实该固定版本每次短停顿或 SageTime 长休息都关闭再打开浏览器；默认代码显示不是该流程。
- 未核对用户实际使用的上游发行包、历史版本或修改版，不能否定它们存在不同休息行为。
- 未得到本次真实被强制下线时完整的平台响应、时间线或平台归因，不能把具体原因断言为“唯一由未关闭浏览器造成”。
- 源码中的次数、延迟和重启只是作者实现；没有平台官方安全阈值、免封保证或能证明重启消除风控的对照实验。上游 README 也明确说明可能被强制退出、限制或封禁。[README 风险与兼容性说明](https://github.com/geekgeekrun/geekgeekrun/blob/c4ebdb0882d8dbecfd9864f980f6d13bd1eb4b2a/README.md#使用必读及免责声明)