# DeepSeek 网页反代组件

来源：[xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API)，固定提交 `59f03ab2988867a4d7bacb97d98f3ee018b0e4d0`（2026-05-28）。上游发布版本已核实为 v1.4.0；本目录是精简改编源码，不是其完整桌面发行包。

协议依据：`src/main/proxy/adapters/deepseek.ts`、`deepseek-stream.ts`、`providerModelOptions.ts`、`src/main/lib/challenge.ts`、`src/main/oauth/inAppLogin.ts`。

Copyright (C) 2026 Chat2API Team. 本组件和改编文件使用 **GPL-3.0-or-later**，完整授权见 [LICENSE](LICENSE)。2026-10-01 的本地集成修改也按此授权提供。主应用通过标准本机 HTTP 接口调用独立进程。

## 本地修改

- 只保留单个 DeepSeek 网页账号；监听 `127.0.0.1` 随机空闲端口，由求职助手自动管理，不需要 Docker 或另装管理台。
- 当前使用已验证的网页默认模型，使用内部适配器标识 `deepseek-v4-flash`、发送 `model_type: default`。它是本机映射标识；返回的 `model` 也沿用请求标识，不能据此确认网页实际模型版本。原适配器的 Pro / expert 入口已移除；官方 API 提供的 Pro 模型与网页账号的可用模式是两回事。
- 登录窗口由用户手动操作，成功后保持显示到用户关闭。规范化 `userToken` 裸字符串、JSON 字符串或 `{value: string}`，通过网页当前用户接口验证后保存。
- 使用 Windows 当前用户的 Electron safeStorage 加密保存；不提供明文降级。不记录 token、Cookie、简历正文或模型正文。
- 深度思考与联网搜索由用户分别选择，默认关闭。请求分别映射到网页的 `thinking_enabled` 和 `search_enabled`，仍使用 `model_type: default`。非流式返回经过 SSE 分段解析，思考内容独立返回。保留答案里的 `FINISHED`，修正空片段切换及 UTF-8 边界。
- 联网返回中的检索片段与最终回答分开，只在联网请求中移除答案开头的 SEARCH / WEB_SEARCH / SEARCHING 控制标记；不把搜索来源追加到 JSON 正文。对应处理依据固定版本的 `deepseek-stream.ts`。
- 网页没有 OpenAI 的原生 `response_format`、`temperature`、`max_tokens`。JSON 使用提示词和主应用解析校验；不能保证所有模型任务都返回合法 JSON。
- 一次处理一个模型请求，从上一轮结束到下一轮发出默认等待30秒，可设10至300秒。主应用的简历分析、改写、连接测试和岗位匹配共用请求队列；组件也执行同样的间隔下限。网页限流遵循 Retry-After，不轮换账号、不自动重复调用。不处理账号验证码或交互验证。
- 2026-10-02 增加调用间隔控制，组件版本为3；本机专用字段 min_request_interval_seconds 仅控制本机等待，在调用网页适配器前移除，不会发给 DeepSeek 网页接口。等待可被取消，180秒请求计时从等待结束后开始。
- 2026-10-03 组件更新为4。429和503保留完整 Retry-After 秒数或HTTP日期；主应用保留失败批次，等待后重试，不自动暂停。
- 每次请求创建独立临时聊天，明确完成或明确拒绝后只尝试删除本次创建的聊天，不调用 `delete_all`；删除失败不丢弃已完成答案。提交后断流或超时保留原聊天和本地请求编号，重启后仍阻止自动重复提交；设置页可查看原聊天，用户确认未完成后允许重试。没有接入未经验证的上游历史恢复接口。
- 已完成回答按本地请求编号在内存缓存30分钟，重复相同编号复用答案；待确认记录持久化只包含请求编号、会话编号和时间，不包含提示词、回答或凭据。
- 本地 WASM 在工作线程中执行网页协议计算，最长 20 秒；请求最长 180 秒。WASM 是该提交的原文件，SHA-256：`b3fca8cc072c1defbd60c02266a8e48bd307a1804aaff4314900aea720e72f7d`。

## 启动与校验

项目根目录安装现有 Electron 依赖，构建后启动求职助手。进入“设置 → DeepSeek 网页账号”，打开登录窗口并手动登录，再点击“保存并测试连接”。代理自动在后台启动；网页登录和 BOSS 登录保存于独立目录。

组件离线测试：`node --test vendor/deepseek-web-proxy/tests/protocol.test.cjs vendor/deepseek-web-proxy/tests/pacing.test.cjs vendor/deepseek-web-proxy/tests/requests.test.cjs`。

代理没有模型或账号配额探测接口；`/v1/models` 列出固定适配器支持的标识，不等同于上游当前账号能力。实际网页协议变动需要更新适配器并重新验证。

本机只提供 OpenAI 格式的非流式文本聊天接口，不提供 Anthropic 接口。实际请求发送到 `chat.deepseek.com/api/v0`，使用网页登录凭据和网页 PoW 校验；不调用官方 `api.deepseek.com`，也不使用开放平台 API Key。官方模型命名规则与这个本机别名独立，说明见项目 README。

下载的完整源码副本和压缩包已从本机清理；当前改编源码、WASM 与授权保留在本目录。对应上游源码可从[固定提交](https://github.com/xiaoY233/Chat2API/tree/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0)获取。
