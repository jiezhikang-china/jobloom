# DeepSeek 网页反代组件

来源：[xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API)，固定提交 `59f03ab2988867a4d7bacb97d98f3ee018b0e4d0`（2026-05-28）。上游发布版本已核实为 v1.4.0；本目录是精简改编源码，不是其完整桌面发行包。

协议依据：`src/main/proxy/adapters/deepseek.ts`、`deepseek-stream.ts`、`providerModelOptions.ts`、`src/main/lib/challenge.ts`、`src/main/oauth/inAppLogin.ts`。

Copyright (C) 2026 Chat2API Team. 本组件和改编文件使用 **GPL-3.0-or-later**，完整授权见 [LICENSE](LICENSE)。2026-10-01 的本地集成修改也按此授权提供。主应用通过标准本机 HTTP 接口调用独立进程。

## 本地修改

- 只保留单个 DeepSeek 网页账号；监听 `127.0.0.1` 随机空闲端口，由求职助手自动管理，不需要 Docker 或另装管理台。
- Flash / Pro 是此提交的代理模型标识，分别发送 `model_type: default` / `expert`；未声称账号一定拥有对应模式或额度。
- 登录窗口由用户手动操作，成功后保持显示到用户关闭。规范化 `userToken` 裸字符串、JSON 字符串或 `{value: string}`，通过网页当前用户接口验证后保存。
- 使用 Windows 当前用户的 Electron safeStorage 加密保存；不提供明文降级。不记录 token、Cookie、简历正文或模型正文。
- 深度思考由用户选择；联网搜索关闭。非流式返回经过 SSE 分段解析，思考内容独立返回。保留答案里的 `FINISHED`，修正空片段切换及 UTF-8 边界。
- 网页没有 OpenAI 的原生 `response_format`、`temperature`、`max_tokens`。JSON 使用提示词和主应用解析校验；不能保证所有模型任务都返回合法 JSON。
- 一次处理一个模型请求，两次完成之间至少间隔 2 秒；网页限流遵循等待提示，不轮换账号、不自动重复调用。不处理账号验证码或交互验证。
- 每次请求创建独立临时聊天，结束后只尝试删除本次创建的聊天，不调用 `delete_all`；删除失败不丢弃已完成答案。
- 本地 WASM 在工作线程中执行网页协议计算，最长 20 秒；请求最长 180 秒。WASM 是该提交的原文件，SHA-256：`b3fca8cc072c1defbd60c02266a8e48bd307a1804aaff4314900aea720e72f7d`。

## 启动与校验

项目根目录安装现有 Electron 依赖，构建后启动求职助手。进入“设置 → DeepSeek 网页账号”，打开登录窗口并手动登录，再点击“保存并测试连接”。代理自动在后台启动；网页登录和 BOSS 登录保存于独立目录。

组件离线测试：`node --test vendor/deepseek-web-proxy/tests/protocol.test.cjs`。

代理没有模型或账号配额探测接口；`/v1/models` 列出固定适配器支持的标识，不等同于上游当前账号能力。实际网页协议变动需要更新适配器并重新验证。
