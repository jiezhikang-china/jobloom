# BOSS 直聘求职与投递助手 (Boss-Job-Agent)

使用简历分析、岗位筛选和 BOSS 直聘网页 DOM 辅助求职。桌面窗口由 Electron 承载 React 控制台，BOSS 页面在独立 Chrome 窗口中打开。

---

## BOSS 网页接入

- 登录页和岗位页分开管理。Chrome 会在专用资料目录保存扫码 Cookie；下次启动会自动恢复会话，并在真实职位页确认登录。验证信息记在 `data/boss-session.json`，其中不包含 Cookie 值。浏览器连接故障、安全验证和登录失效会分别提示；只有确认登录失效才提示重新扫码。
- 新的 BOSS 页面模块按已登录页面的实际 DOM 识别职位卡片、右侧详情、登录提示和安全验证。空白页、加载中、明确无结果是不同状态；单有 `_security_check` 参数但职位卡片正常显示时仍按职位页处理。
- 批量操作按职位链接定位，发送前再次核对岗位和详情；没有确认沟通成功时停止任务并提示人工检查，避免继续批量操作。
- 旧的页面内 `fetch` 模拟接口已移除。BOSS 网站页面变动时，流程会停止并报告当前状态。
- 普通 Chrome 会话使用 `data/boss-profile-v3`。首次使用这个资料目录时需扫码一次，以后优先恢复已保存的会话。

---

## 🚀 快速启动

### Windows 桌面窗口

双击项目根目录的 [启动桌面版.vbs](启动桌面版.vbs)，即可在独立的 Electron 桌面窗口中使用现有的 React 控制台，包括批量投递、筛选设置和运行日志。首次使用请先运行 [启动桌面版-调试.cmd](启动桌面版-调试.cmd)，它会构建页面并启动窗口；之后可直接双击桌面入口。需要 Node.js、已安装项目依赖和 Google Chrome；桌面控制窗口本身不依赖 Python。

关闭窗口后，桌面入口启动的空闲服务会退出；若批量任务正在运行，服务会保留，重新双击入口即可查看进度。窗口只访问本机地址，BOSS 账号扫码仍在自动化专用的 Chrome 窗口中进行。项目目前通过 Electron 运行，尚未打包成独立安装程序。

### 1. 运行环境
- Node.js 18+ (推荐 Node.js 20+)
- 已安装 Google Chrome（路径：`C:\Program Files\Google\Chrome\Application\chrome.exe`）

### 2. 启动命令
进入项目服务端目录：
```powershell
cd D:\boss直聘脚本\server
npm run dev
```

在浏览器打开：**[http://localhost:3001](http://localhost:3001)** 即可进入现代化可视化控制台！

> 服务默认只监听 `127.0.0.1`（接口无鉴权且持有大模型密钥与会话 Cookie，不应暴露到局域网）。
> 确需局域网访问时：`$env:HOST="0.0.0.0"; npm run dev`
>
> 基础自检：`npm run selftest`；投递入口、会话恢复和批量流程测试位于 `server/tests/`。

---

## 📖 使用指引

1. **连接 DeepSeek 网页**：在【设置】选择 DeepSeek 网页，点击【打开 DeepSeek 登录】并手动登录。窗口会自动验证并保存账号，保持显示直到你手动关闭；之后启动自动复用。再点击【保存并测试连接】确认 JSON 调用。此方式无需购买官方 API Key。
2. **选择投递方式**：在【开始投递】选择【用简历匹配岗位】或【手动指定目标】。简历路径上传简历后可直接开始，也可以先到【简历分析】获取推荐岗位；手动路径只需填写目标岗位和至少 10 个字的筛选要求。简历改写是可选功能。
3. **核对条件并启动**：选择搜索城市，按需填写搜索词；留空时使用目标岗位搜索。每日数量、需求词和淘汰词在【筛选规则】中设置。点击【开始投递】时会保存条件并检查 BOSS 会话。
4. **处理网页登录提示**：首次使用专用 Chrome 资料目录时扫码一次；后续优先恢复保存的会话。若 BOSS 页面要求安全验证，需在 Chrome 中手动完成。任务进度、暂停与停止在【运行记录】中查看。页面没有出现可验证的“不合适”控件时不会尝试标记。

已在登录后的真实 BOSS 职位页验证会话恢复、15 张职位卡片读取、岗位链接匹配与完整描述读取；离线页面测试覆盖沟通确认和批量控制。真实沟通发送与“不合适”控件尚未实投验证，运行批次时请留意日志。页面结构记录见 [BOSS 页面 DOM 基线](docs/boss-dom-baseline.md)。

## DeepSeek 网页模型

已接入 [Chat2API](https://github.com/xiaoY233/Chat2API) 的 DeepSeek 网页适配器精简版本，在独立本机进程中运行。来源、固定版本、GPL 授权及修改记录见 [组件说明](vendor/deepseek-web-proxy/UPSTREAM.md)。

- 单账号顺序处理。深度思考与联网搜索分别设置，默认均关闭；可单独开启，也可同时开启。网页频率或额度受限时暂停任务，由用户检查后恢复。
- 使用已验证的网页默认模型，内部使用适配器标识 `deepseek-v4-flash`，实际发送网页参数 `model_type: default`。这个标识不代表已确认网页底层模型版本。AI 设置已移除 GLM 和 Pro 预设。
- 网页凭据使用当前 Windows 用户的 safeStorage 保存到 `data/deepseek-web-credential.json`，浏览器资料在 `data/deepseek-web-profile`；与 BOSS 会话独立。不会把旧 GLM Key 发送给网页代理。
- 不保存简历或模型正文到代理日志；JSON 依靠提示词与解析校验，网页接口没有原生 JSON 模式或输出 token 限制。
- 进入设置时自动准备本机服务；登录窗口关闭不会结束模型服务。退出空闲桌面助手会停止空闲代理，仍打开的登录窗口会继续保留。
- 也可以选择其他兼容 API 并手动填写地址、模型和对应 Key。网页账号与官方 API Key 是不同凭据。

校验：`node --test vendor/deepseek-web-proxy/tests/protocol.test.cjs`、`cd server; npx tsx tests/deepseek-web.test.ts`。真实 DeepSeek 调用需先由用户完成网页登录。

在“设置 → 网页功能”选择“深度思考”和“联网搜索”，点击“保存设置”。前者控制网页思考功能，后者允许网页模型检索相关信息；两者独立于本机模型标识。设置用于后续简历分析、改写及岗位匹配，不会修改自定义 API 的请求格式。网页登录窗口中手动切换按钮不会覆盖助手保存的选项。

### 反代与官方 API 的区别

当前调用链：求职助手 → 本机 `/v1/chat/completions` → `https://chat.deepseek.com/api/v0/chat/completion`。本机组件把 OpenAI 格式转换成网页聊天协议，再把网页返回内容包装成 OpenAI 格式。

它读取已保存的网页登录凭据，验证账号后创建临时聊天，完成网页要求的 PoW 请求校验，发送聊天内容并读取返回流。每次请求结束只尝试删除本次临时聊天。本机接口的密钥仅用于本机认证，与 DeepSeek 官方 API Key 无关。

| 项目 | 当前网页反代 | DeepSeek 官方 API |
| --- | --- | --- |
| 上游地址 | `chat.deepseek.com/api/v0/chat/completion` | `api.deepseek.com/chat/completions` |
| 认证 | 网页账号登录凭据 | 开放平台申请的 API Key |
| 请求转换 | 将消息转成网页提示词，返回流转成完整回答 | 直接使用官方兼容协议 |
| 本项目支持的接口 | OpenAI 格式的文本、非流式聊天；未实现 Anthropic 接口 | 官方提供 OpenAI 和 Anthropic 兼容入口 |
| 使用限制 | 跟随网页账号及网页接口限制 | 跟随官方 API 的额度与计费 |

截至 2026-10-01，[DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/)列出的模型名为 `deepseek-flash` 和 `deepseek-v4-pro`；旧名 `deepseek-v4-flash` 的官方 API 请求由 V4.1-Flash 提供服务。这是官方 API 的模型规则，不能套用到本机网页适配器的同名标识上。网页底层模型由网站决定，本项目没有确认具体版本。

本机网页代理没有原生 JSON 模式、输出 token 限制或完整的 OpenAI 参数支持。若选择设置中的“其他兼容 API”，可填写官方地址 `https://api.deepseek.com`、模型 `deepseek-flash` 和官方 API Key，改为直接调用官方接口；这个入口使用 OpenAI 格式。

## 项目文件

- `client/`：React 控制台；`server/`：配置、筛选与 BOSS DOM 投递服务。
- `desktop/`：Electron 桌面入口；`vendor/deepseek-web-proxy/`：当前使用的网页代理源码、WASM、授权与测试。
- `docs/`：设计依据和历史验证记录；`server/tests/`：回归测试。
- `data/`：本机账号、简历、配置、运行记录与私有备份，全部排除在 Git 之外。
- `node_modules/` 和前后端 `dist/` 是当前启动所需的依赖与构建结果。

2026-10-01 已清理旧版及测试浏览器资料、下载的完整上游源码副本、临时探测脚本、历史截图、文档网页快照和安装缓存。旧代码审查与工作日志归档到 `data/private-backups/`；当前登录资料和简历保留。

## 学历筛选

在“筛选规则 → 我的最高学历”选择自己的学历。岗位学历按最低门槛比较：本科可匹配大专、专科、本科及学历不限岗位，硕士可匹配本科及以下岗位。明确限制学历的岗位保留其限制。不设置学历时不做这一项硬筛。

## 本地 Git 管理

项目已在 main 分支纳入 Git。账号、Cookie、简历、密钥、依赖、运行缓存和构建输出通过 .gitignore 排除。初始版本与后续修复分别提交，可通过 git log 查看历史，通过 git diff 查看未提交改动。第一次自行提交前，可在本仓库配置自己的 Git 作者姓名和邮箱。
