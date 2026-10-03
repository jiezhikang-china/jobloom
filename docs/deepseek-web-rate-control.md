# DeepSeek 网页反代：请求控制与失败恢复

核查日期：2026-10-03。研究只读取公开源码、公开文档和本地实现，没有发起真实模型请求、读取账号凭据或操作登录窗口。

## 结论

对于本项目的少量岗位评估，降低重复调用、保持单账号串行、遵守上游要求的等待时间，比给每次请求添加随机停顿更有用。本地初筛、批量评估和已有结果缓存应继续放在请求之前。这些措施减少负载，不能保证网页账号不会限流或触发验证。

本机提供的 OpenAI 格式是一个适配层。它把消息转换后调用 DeepSeek 网页内部接口，并没有变成官方开放平台 API。网页凭据、网页额度和网页协议不能用付费 API 的说明来推断。[本地协议入口](<D:/boss直聘脚本/vendor/deepseek-web-proxy/protocol.cjs:7>)、[来源记录](<D:/boss直聘脚本/vendor/deepseek-web-proxy/UPSTREAM.md:1>)

官方 API 错误文档区分了认证失败、参数错误、请求过快和服务过载，并建议后两者适当等待。这里描述的是开放平台 API；没有据此得到网页端每分钟或每天可安全请求多少次的结论。[DeepSeek API 错误说明](https://api-docs.deepseek.com/quick_start/error_codes/)

DeepSeek 服务条款允许服务方检查使用行为，也限制未授权自动获取内容等行为。因此，“请求少”或“来自开源项目”都不是网页反代获得官方授权的证明。本次研究没有寻找或建议绕过账号验证的方法。[DeepSeek 服务条款 §§3.3、3.5](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html)

## 核查上游源码

GitHub 公开目录接口在核查时返回的 main 提交仍为 59f03ab2988867a4d7bacb97d98f3ee018b0e4d0，与本地记录一致。可用[公开目录接口](https://api.github.com/repos/xiaoY233/Chat2API/git/trees/main?recursive=1)和[固定提交源码](https://github.com/xiaoY233/Chat2API/tree/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0)复核；固定链接用于描述本次检查的版本，不代表后续版本不变。

| 检查对象 | 已确认内容 | 对本项目的影响 |
| --- | --- | --- |
| [DeepSeek 适配器](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/deepseek.ts) | 使用网页登录、会话和聊天接口；缓存登录令牌及短期会话 | 接口兼容不等于官方 API；缓存网页登录与复用聊天上下文是两件事 |
| [流处理器](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/deepseek-stream.ts) | 读取消息编号、回答片段及结束状态 | 收到片段不代表完整回答，不能把半截 JSON 当成功 |
| [转发器](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/forwarder.ts) | 有转发重试及结束后会话清理逻辑 | 不应把上游的通用重试直接复制成网页请求策略 |
| [会话管理器](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/sessionManager.ts)、[管理端会话路由](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/routes/management/sessions.ts) | 管理路由从本地存储读取会话记录 | 本地“历史消息”不能补回从未收到的上游答案 |

首轮在以上固定上游文件中未找到可靠的网页历史恢复路径。后续主任务已在本项目既有会话中实测确认 GET /api/v0/chat/history_messages?chat_session_id=…；去掉缓存增量参数后，可读取完整 chat_messages，并核对 ASSISTANT FINISHED 与正式片段。该新增证据不是固定上游提供的保证，详见[后续接口记录](D:/boss直聘脚本/docs/response-and-location-api-notes.md)。不能凭猜测新增其他恢复接口。[流处理器源码](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/deepseek-stream.ts)

## 研究开始时的实际问题

以下是本轮修改前的观察，记录它们是为了说明为什么仅增加投递层重试还不够。本轮修正的最终状态在下节单独记录。

| 问题 | 原实现证据 | 后果 |
| --- | --- | --- |
| 冷却直接报错 | [主应用请求队列](<D:/boss直聘脚本/server/src/services/ai-request-queue.ts>)在冷却期间抛异常；[模型服务](<D:/boss直聘脚本/server/src/services/llm.service.ts>)遇到网页 429／503 后抛异常 | 等待没有留在队列里，最终表现为投递任务暂停 |
| 上游等待时间失真 | [网页协议处理](<D:/boss直聘脚本/vendor/deepseek-web-proxy/protocol.cjs>)只用数字解析 429 的 Retry-After，并压到 30–300 秒；503 未保留原状态及等待头 | HTTP 日期丢失，要求等待更长时会过早重试；503 退化为普通 502 |
| 超时证据被清除 | [聊天完成逻辑](<D:/boss直聘脚本/vendor/deepseek-web-proxy/protocol.cjs>)的 finally 无论成功、取消或断流都尝试删除本次聊天 | 后续无法通过保留的聊天检查原请求是否实际完成 |
| 没有请求去重状态 | [代理入口](<D:/boss直聘脚本/vendor/deepseek-web-proxy/main.cjs>)只有当前进程的 busy 标记；每次完成调用都创建聊天 | 本地连接断开后重试同一批岗位，可能再次生成；重启也丢失未完成状态 |
| 错误类型容易混合 | [网页协议错误处理](<D:/boss直聘脚本/vendor/deepseek-web-proxy/protocol.cjs>)部分业务错误、流错误被归到通用上游失败 | 账号需要操作、明确拒绝和结果未知被同样处理 |

已有几处应保留的控制：主应用共享串行队列；代理再保证单请求；请求间隔从上一轮结束计算；停止等待可取消；网页令牌有缓存；界面的普通状态轮询只查本机，只有主动刷新登录才访问网页验证。不能把界面每三秒查本机状态误称为每三秒请求 DeepSeek。[队列实现](<D:/boss直聘脚本/server/src/services/ai-request-queue.ts>)、[代理节奏控制](<D:/boss直聘脚本/vendor/deepseek-web-proxy/pacing.cjs>)、[登录与状态入口](<D:/boss直聘脚本/vendor/deepseek-web-proxy/main.cjs>)、[账号界面](<D:/boss直聘脚本/client/src/DeepSeekAccountPanel.tsx>)

岗位评估已经先执行本地规则，再合并幸存岗位；批量大小默认 5，已有成功评估按岗位资料、候选人资料、筛选与模型设置组成摘要缓存，保留约 30 分钟。重复失败不能写成“通过”的缓存结果。[筛选与评估缓存](<D:/boss直聘脚本/server/src/services/filter.service.ts:216>)

## 首轮已实施的修正与后续历史恢复

首轮完成状态（2026-10-03）：**代码修改、前后端构建与离线测试已完成；桌面后台版本 21 和 DeepSeek 组件版本 4 已加载。** 代理与桌面相关的 27 项离线测试通过；本轮没有调用真实模型，不能据此确认真实账号额度或风控阈值。

1. **失败批次留在队列中。** 普通暂时故障先等待，保留未成功的岗位，不跳过、不默认通过。批次退避按 30、60、120、240、300 秒增长，之后保持等待；用户仍能暂停或停止。这里只是本项目的请求策略，不是 DeepSeek 认可的安全频率。
2. **完整遵守上游等待时间。** Retry-After 支持秒数和 HTTP 日期。下一次请求取本地间隔、故障退避、上游要求等待三者中最晚的时间；长等待分段显示和取消，不能为避免长计时器而缩短上游要求。HTTP 对该头的两种格式有明确规定。[RFC 9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)
3. **区分明确拒绝与结果未知。** 提交聊天前的服务繁忙、完整确认的频率限制拒绝可以等待后重试；聊天 POST 已发出后，遇到连接超时、断流或缺失完成标记，先记为“待确认”，随后读取原聊天历史核对；历史无法证明完整完成时继续保留待确认。POST 可能已经执行，网络故障本身不能证明它未执行，这是禁止盲目自动重发的依据。[RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)
4. **提交前记录请求状态。** 主应用为逻辑请求分配 UUID 请求编号。代理在聊天 POST 发出前持久保存请求编号、会话编号和创建时间；文件仅有 requestId、sessionId、createdAt，不保存请求摘要、提示词、答案、简历正文或凭据。超时保留待确认记录及原聊天，重启后继续保留限制。只要存在待确认记录，该账号的其他新生成也会被阻止，直到用户处理。[请求记录实现](<D:/boss直聘脚本/vendor/deepseek-web-proxy/requests.cjs>)、[提交与确认判断](<D:/boss直聘脚本/vendor/deepseek-web-proxy/protocol.cjs:279>)
5. **给待确认结果一个可操作入口。** 设置页展示未完成聊天，提供“查看该聊天”和“确认未完成，允许重试”操作。只有用户明确允许后才清除对应请求编号的待确认记录；等待循环不会重复提交同编号或其他新请求。首轮仅支持用户确认；后续已新增经过现场核验的原会话历史恢复。只有完成状态、消息关系和正式答案均核对通过时才复用，未知结果仍保留用户确认入口。[设置页交互](<D:/boss直聘脚本/client/src/DeepSeekAccountPanel.tsx:100>)
6. **登录与验证等待用户处理。** 401 需要重新确认登录；403 或网页交互验证需要用户完成。保留当前批次并显示原因，完成后再试；不会重复提交错误登录，也不会自动处理验证码。400 参数问题或不支持的协议需要修正，不能只等待重复发送。

建议错误状态按如下方式表达，避免界面把所有异常叫“网络失败”。

| 状态 | 后续行为 | 是否可以重新提交聊天 |
| --- | --- | --- |
| 本机另一请求仍在处理 | 继续排队，本机轮询不访问网页 | 当前请求结束后可以 |
| 上游明确 429 拒绝 | 等待完整 Retry-After；没有有效等待头时使用本地退避 | 冷却结束后可以 |
| 聊天提交前上游 503／临时服务故障 | 遵守等待头，逐步退避 | 可以；聊天 POST 已发出后仍未确认则归入待确认 |
| 登录过期／需要网页验证 | 保留批次，提示处理登录或验证，处理后继续 | 凭据恢复且此前明确拒绝时可以 |
| 提交后的超时／断流 | 保留原聊天和请求编号；先读取原聊天历史核对；无法确认时继续阻止该账号新生成 | 可复用已确认的原答案；不得自动重新生成未知结果 |
| 参数、协议、格式问题 | 保留诊断，修正参数或适配器 | 修正后可以；不要高速重复原请求 |

## 会话复用要解决什么

应继续复用当前账号的持久登录窗口、Cookie 与短期令牌，并仅在失效或用户主动验证时刷新。这能减少重复登录验证请求。本地登录窗口成功后会保持显示；不会为制造“像真人”请求而更换登录环境。[本地登录实现](<D:/boss直聘脚本/vendor/deepseek-web-proxy/main.cjs>)、[令牌缓存](<D:/boss直聘脚本/vendor/deepseek-web-proxy/protocol.cjs>)

聊天会话的复用要先保证任务隔离。不同简历、条件或批次共用一段带上下文的聊天，会混入旧条件；当前本地请求的 parent_message_id 为 null，不能只保留会话编号就宣称实现了可靠多轮恢复。对于本任务，优先复用“同一逻辑请求”的状态，而不是把所有评估放进同一个历史聊天。正常完成的临时聊天可按既有规则清理；结果未知的聊天应保留到用户确认。[本地完成逻辑](<D:/boss直聘脚本/vendor/deepseek-web-proxy/protocol.cjs>)

## 后续建议与验证范围

以下是设计建议，不能把它们记为本轮已部署的功能。

- 把确定性条件继续交给脚本，只有描述含糊或需理解语义的岗位交给 AI。每批共享一次候选人资料，保持摘要和条件变更时缓存失效。
- 为成功结果缓存保留有限容量与有效期，并考虑后续账号和模型切换的隔离。当前成功结果仅在内存中复用，待确认记录独立持久化；后续改缓存不能把待确认记录作为过期缓存自动解除。
- 自动退避可少量向后增加抖动，防止恢复时多个本机调用同时醒来；抖动不能令实际请求提前到上游要求之前。这是客户端实现建议，并无网页“伪装真人”的依据。
- 日志仅记录故障类型、等待截止时间、请求阶段和计数。不要复制上游代码中打印账号资料或请求正文的调试做法；保存的请求与会话编号也应留在本机。
- 如果连续失败，延长等待并保留任务，避免每次刷新都建新聊天。账号验证、参数错误、协议变化要显示对应处理入口，不能无限掩盖成服务繁忙。

首轮离线验证覆盖以下行为。代理与桌面相关的 27 项离线测试通过，主任务同时完成前后端构建、投递恢复测试与运行版本检查。

| 验证内容 | 已验证结果 | 对应实现或测试 |
| --- | --- | --- |
| 上游等待时间 | 秒数、HTTP 日期及超过 300 秒的等待正确保留 | [requests.test.cjs](<D:/boss直聘脚本/vendor/deepseek-web-proxy/tests/requests.test.cjs>)、[protocol.test.cjs](<D:/boss直聘脚本/vendor/deepseek-web-proxy/tests/protocol.test.cjs>) |
| 明确拒绝恢复 | 完整确认拒绝后允许等待重试 | [protocol.test.cjs](<D:/boss直聘脚本/vendor/deepseek-web-proxy/tests/protocol.test.cjs>) |
| 断流及重复提交 | 原会话保留；同编号与不同新编号都不再提交上游 | [protocol.test.cjs](<D:/boss直聘脚本/vendor/deepseek-web-proxy/tests/protocol.test.cjs>) |
| 重启后的未确认状态 | 只保留三个元数据字段，重启仍能读取限制 | [requests.test.cjs](<D:/boss直聘脚本/vendor/deepseek-web-proxy/tests/requests.test.cjs>) |
| 成功请求复用 | 同编号返回内存缓存；答案不持久化，缓存最长约 30 分钟、最多 100 项 | [requests.cjs](<D:/boss直聘脚本/vendor/deepseek-web-proxy/requests.cjs:39>)、[protocol.test.cjs](<D:/boss直聘脚本/vendor/deepseek-web-proxy/tests/protocol.test.cjs>) |
| 等待与投递恢复 | 等待可停止；失败批次保留并按 30／60／120／240／300 秒恢复 | [ai-request-queue.ts](<D:/boss直聘脚本/server/src/services/ai-request-queue.ts>)、[ai-retry.ts](<D:/boss直聘脚本/server/src/services/ai-retry.ts>)、[delivery-batching.test.ts](<D:/boss直聘脚本/server/tests/delivery-batching.test.ts>) |
| 用户处理入口 | 设置页可查看原聊天，并明确允许重新请求 | [DeepSeekAccountPanel.tsx](<D:/boss直聘脚本/client/src/DeepSeekAccountPanel.tsx:100>) |
| 加载版本 | 桌面后台版本 21、DeepSeek 组件版本 4 已加载 | [后台健康版本](<D:/boss直聘脚本/server/src/index.ts>)、[代理健康版本](<D:/boss直聘脚本/vendor/deepseek-web-proxy/main.cjs:147>) |

首轮研究和离线验证没有调用真实 DeepSeek 模型。后续主任务只读核验了项目既有聊天的历史结果；本研究子任务没有读取私有会话或凭据，仍未验证账号实际额度、实际风控阈值或真实生成延迟。离线测试不能证明某个频率保证不会触发网页风控。

## 原始资料索引

- [DeepSeek 官方 API 错误说明](https://api-docs.deepseek.com/quick_start/error_codes/)：网页抓取暂时失败时使用同站搜索索引核查条目，不把 API 规则转用于网页账号。
- [DeepSeek 服务条款](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html)：核查时页面标注最近更新为 2026-03-27。
- [HTTP 语义 RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)：§9.2.2 非幂等重试、§10.2.3 等待头、§15.6.4 服务暂不可用。
- [HTTP 429 RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)：429 表示请求过多，服务器可以提供等待头。
- [Chat2API 固定提交](https://github.com/xiaoY233/Chat2API/tree/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0)：已检查 DeepSeek 适配器、流处理器、转发器、会话管理及管理路由。

