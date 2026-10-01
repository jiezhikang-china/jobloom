# 模型反代候选核实记录

核实时间：2026-10-01。初次记录时用户等待指定模型；随后用户选择 Chat2API 的 DeepSeek 网页反代，用于个人少量使用。此研究只读取项目文档、固定提交源码及版本元数据，不运行第三方项目、不传入凭证、不修改应用代码。应用接入工作由主任务完成。

## Chat2API

- 项目：[xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API)。核实提交 [`59f03ab2988867a4d7bacb97d98f3ee018b0e4d0`](https://github.com/xiaoY233/Chat2API/commit/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0)，提交日期 2026-05-28。
- Electron / Node.js 桌面代理，文档提供 Windows 包名称和 Node.js 18+ 源码启动方式，无需 Docker；README 的 v1.3.0 徽标尚未与真实发布文件核对。[安装说明](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/README_CN.md)
- DeepSeek 源码列出 `deepseek-v4-flash`、`deepseek-v4-pro`；上游 `https://chat.deepseek.com/api/v0/chat/completion`，需要网页账户的 `userToken`。标识来自该提交，未实测上游可用性。[DeepSeek 配置](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/providers/builtin/deepseek.ts)
- 国际 Qwen 源码列出 `Qwen3.7-Max`、`Qwen3.6-Plus`、`Qwen3.6-35B-A3B`、`Qwen3.6-27B`、`Qwen3-Coder`。最后一项映射 `qwen3-coder-plus`，其余对应小写标识。上游 `chat.qwen.ai`，认证为网页 Local Storage 的 `token` JWT，需要 Qwen 网页账户，不能使用现有 GLM 官方 Key。[Qwen 配置](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/providers/builtin/qwen-ai.ts)
- `/v1/chat/completions` 接受模型和消息，支持非流式 JSON 包装；已读路由没有处理 `response_format`，尚不能保证模型输出受 JSON 约束。路由向日志模块传入请求和返回。进一步审查确认默认 includeBodies=false，不保留完整请求体；但 userInput 仍保留最多 500 字符，可能包含简历文本。[路由源码](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/routes/chat.ts)
- 文档把网页登录入口称为 OAuth，同时列出网页 token / cookie 认证。登录、验证码和挑战实现尚未完整审查，不能据此认定使用标准 OAuth。[认证说明](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/README_CN.md)

## Qwen Web Proxy

- 项目：[SternI/qwen-web-proxy](https://github.com/SternI/qwen-web-proxy)。核实提交 [`1730e13b4d1e7c160a57cf67cf75e3421bcd0ea9`](https://github.com/SternI/qwen-web-proxy/commit/1730e13b4d1e7c160a57cf67cf75e3421bcd0ea9)，提交日期 2026-09-13。
- Python / aiohttp 加 Tampermonkey 或 Violentmonkey 脚本，需要用户登录 `chat.qwen.ai` 或 `chat.qwenlm.ai` 并保持网页打开。文档启动入口 `python qwen-proxy.py`，无需 Docker；本次未安装依赖验证 Windows / Python 3.12。[部署说明](https://github.com/SternI/qwen-web-proxy/blob/1730e13b4d1e7c160a57cf67cf75e3421bcd0ea9/README.md)
- 源码模型表：`qwen-chat`、`qwen-search`、`qwen-deep-search`、`qwen-deep-research`、`qwen-agent`、`qwen-image`、`qwen-image-3.0-pro`。它们是网页功能别名，不能当成指定底层模型版本。[实现源码](https://github.com/SternI/qwen-web-proxy/blob/1730e13b4d1e7c160a57cf67cf75e3421bcd0ea9/qwen-proxy.py)
- 默认 `http://127.0.0.1:1338/v1`；支持非流式 `choices[0].message.content`，思考文本单独放在 `reasoning_content`。源码没有读取 `response_format`，需用实际简历 JSON 任务验证；会向终端打印部分返回文本。[实现源码](https://github.com/SternI/qwen-web-proxy/blob/1730e13b4d1e7c160a57cf67cf75e3421bcd0ea9/qwen-proxy.py)
- 未审查完整浏览器脚本，未核实验证码行为、实际选模及网页配额。现有 GLM 官方 Key 无效。

## CLIProxyAPI

- 项目：[router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)。核实提交 [`fd48ea6840f5572deb53aeb5657740937ac9daaa`](https://github.com/router-for-me/CLIProxyAPI/commit/fd48ea6840f5572deb53aeb5657740937ac9daaa)，提交日期 2026-10-01。
- GitHub 正式发布 [`v8.0.8`](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.8)，发布时间 2026-10-01 03:33:40 UTC；实际资产列表有 `CLIProxyAPI_8.0.8_windows_amd64.zip`、Windows ARM64 包及 `checksums.txt`，可直接采用 Windows 二进制，无需 Docker。本次未下载或运行。
- 文档声明支持 OpenAI 兼容的流式与非流式、Codex / Claude / Gemini / Grok 等账户登录及兼容上游 API Key。需要所选服务的账户权限或相应 Key；赞助商不是必需上游。[能力说明](https://github.com/router-for-me/CLIProxyAPI/blob/fd48ea6840f5572deb53aeb5657740937ac9daaa/README.md)
- 已读配置默认端口 `8317`，客户端密钥 `access.api-keys` 与上游凭证独立，账户文件目录 `oauth.auth-dir`。部署时应明确本机监听地址及自己的客户端密钥。[配置源码](https://github.com/router-for-me/CLIProxyAPI/blob/fd48ea6840f5572deb53aeb5657740937ac9daaa/config.example.yaml)
- 用户所需具体模型 ID、登录源域名、JSON 模式转换及真实配额未核实；不能直接用 README 宣传名称配置。选定后检查对应执行器和实际 `/v1/models`。

## 接入前待办

1. 用户已指定 Chat2API DeepSeek 网页反代；其实现核实详见下节。
2. 核对指定版本的 Windows 包校验值或源码入口，检查对应模型的登录、凭证保存、请求路径；不自动处理账户验证码。
3. 实测 `/v1/models`、非流式聊天及应用的简历分析 / 岗位评分 JSON 输出，明确 `response_format` 行为。普通文字连接测试不足以证明兼容。
4. 当前三项均未本机实测，只能判断部署前提，尚不足以推荐具体模型或声称完成替换。

## 已选 Chat2API DeepSeek：实现核实

固定版本 `59f03ab2988867a4d7bacb97d98f3ee018b0e4d0`，`package.json` 实际版本 **1.4.0**（README 徽标仍为 1.3.0）。主任务已取得该提交源码；以下依据该源码，不代表 DeepSeek 当前网站已实测。

### 后台启动及本机接口

- `src/main/proxy/server.ts` 导出 `ProxyServer` 及单例 `proxyServer`，启动签名 `start(port?: number, host?: string): Promise<boolean>`，可以明确传入 `127.0.0.1`。`src/main/index.ts` 的 setupApp 无条件创建管理窗口，没有现成的纯 Node 后台启动脚本。模块依赖 Electron 的 safeStorage / app，精简 Electron 启动入口应在 app ready 后初始化存储再启动代理，避免导入原 main/index.ts。此调用路线已从源码确认，但本研究没有运行验证。[服务源码](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/server.ts)、[原桌面入口](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/index.ts)
- `GET /health` 返回 status、uptime、计数；`GET /stats` 返回统计；`GET /v1/models` 与 `/v1/models/:model` 仅列有 active 账户的 enabled 供应商，并叠加别名。`POST /v1/chat/completions` 是应用接入口。API Key 校验只有 `enableApiKey && apiKeys.length>0` 才启用，默认关闭；health / stats 无需 Key。管理接口默认关闭。[服务与认证](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/server.ts)、[模型路由](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/routes/models.ts)

### 模型、登录和持久化

- `resolveDeepSeekChatOptions(request)`：`deepseek-v4-flash` → `model_type: default`，`deepseek-v4-pro` / expert → `expert`；默认 thinking 和 search 关闭。带 think / r1 / reasoner 别名或 reasoning_effort 会开启思考，search 别名或 web_search 会开启搜索。[模型映射](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/providerModelOptions.ts)
- `oauthManager.startInAppLogin(providerId, providerType, timeout?, proxyMode?)` 打开站点让用户手动登录，读取 Local Storage `userToken`；返回 credentials，不自行保存账户。`localStorage.getItem()` 返回 string/null；Chat2API 处理**裸 token 字符串**或**JSON 对象字符串中的 value**。源码不能证明当前网页必用其中哪一种，需现场检查或验证 API。不要将对象直接 String() 成 `[object Object]`。[提取配置](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/oauth/tokenExtractionConfig.ts)、[提取实现](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/oauth/inAppLogin.ts)
- OAuth 验证接受 `credentials.token || credentials.userToken`，但请求适配器只读 `token || apiKey || refreshToken`。接入必须规范为 `{token: string}`，验证成功后另行持久化。原 `AccountManager.create(...)` / `storeManager.addAccount(account)` 保存账户；原目录 `homedir()/.chat2api/data.json`，个别凭证通过 safeStorage.encryptString 加密，原代码加密失败会退回明文；主任务拟独立存储并禁止明文降级。[OAuth 管理器](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/oauth/manager.ts)、[账户存储](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/store/store.ts)
- 原登录默认超时 5 分钟，complete() 在成功时自动关闭窗口；它不满足用户要求的保留窗口，精简接入应另行实现用户主动关闭的生命周期。[登录窗口实现](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/oauth/inAppLogin.ts)

### 实际上游请求及会话行为

- 此 DeepSeek 路径的凭证请求均指向 `chat.deepseek.com`：`GET /api/v0/users/current`；`POST /api/v0/chat_session/create`；`POST /api/v0/chat/create_pow_challenge`；`POST /api/v0/chat/completion`。后两者通过本地 bundled WASM 计算 PoW 后发送 X-Ds-Pow-Response。读取的该路径未发现把凭证发送到第三方服务器；不等于对完整仓库及所有供应商作了审计。WASM 路径为开发 app.getAppPath() 或打包 resourcesPath 下的 `sha3_wasm_bg.7b9ca65ddd.wasm`，没有远程求解服务。[适配器](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/deepseek.ts)、[本地 WASM 加载](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/lib/challenge.ts)
- 请求包含 chat_session_id、parent_message_id=null、prompt、model_type、ref_file_ids=[]、search_enabled、thinking_enabled、preempt=false。temperature / max_tokens / response_format 未传到该上游，JSON 约束依赖提示词及输出校验；上游响应总是流，代理负责汇总非流式结果。账户的 session 缓存 5 分钟。[适配器请求](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/deepseek.ts)
- 请求后删除由 `sessionManager.shouldDeleteAfterChat()` 控制，该函数实际返回配置 deleteAfterTimeout，默认 false；开启时 forwarder 删除本次 session。`/chat_session/delete_all` 只由显式“清空所有聊天”操作调用，不应带进默认请求流程。[转发器](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/forwarder.ts)、[会话配置](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/sessionManager.ts)、[IPC 操作](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/ipc/handlers.ts)

### SSE 与 JSON 输出

- 初始事件可包含 `v.response.fragments`，片段 type 为 THINK、ANSWER、RESPONSE；后续 `p=response/fragments, o=APPEND, v=[fragment]` 切换片段。内容增量可能为字符串 v；原解析器用当前片段类型决定归入 reasoning_content 或 content。源码测试有标为 HAR 来源的 initial fragment / APPEND / results fixtures；本研究没有捕获当前网站真实 SSE，不能宣称所有 p/o/v 变体已核实。[流转换源码](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/deepseek-stream.ts)、[项目 fixtures](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/tests/providers/deepseek-stream.test.ts)
- 非流式转换把思考单独累积到 reasoning_content，最终正文到 message.content；没有通用 JSON 解析或去代码围栏功能。应用需要自己做 JSON 提示与校验。为纯 JSON 任务关闭搜索，避免自动在正文追加来源引用。[非流式转换](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/deepseek-stream.ts)
- 原解析器有两个需修正的明确缺陷：片段 content 为空时不更新 THINK / ANSWER 当前通道；任意字符串 v 都可能被当正文，且全局去掉文本 FINISHED。精简解析应在 type 出现时就更新通道，只拼接明确的 content 路径（支持继承路径及 BATCH 子路径），忽略 status/type/usage 元数据，并保留正文里的字面 FINISHED。BATCH 与省略路径行为仍需由实际响应验证，不能只复制原实现。[原 processChunk / handleNonStream](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/deepseek-stream.ts)

### 明确要去除的敏感日志

- 请求适配器 deepseek.ts:113 输出完整账户凭证；oauth/manager.ts:495 输出成功后的完整 token；store/store.ts:665–669 输出更新及解密旧凭证；inAppLogin 多处输出 token 前缀或完整网页 console 值。精简接入应删除这些输出，禁止原 console 流直接写入应用日志。[请求适配器](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/deepseek.ts)、[OAuth 管理器](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/oauth/manager.ts)、[存储源码](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/store/store.ts)
- 原请求日志默认 enabled=true、includeBodies=false、maxEntries=200，仍保留 userInput 最多 500 字符；开启 includeBodies 才保存截断的完整请求及返回。主任务的精简服务无需带入该日志模块。[默认配置](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/store/types.ts)、[日志清理实现](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/requestLogs/sanitizer.ts)
