# BOSS 直聘已登录页面 DOM 基线（2026-10-01）

本记录来自专用 Chrome 资料目录中的已登录会话。检查使用只读 DOM 查询，并点击职位卡片以核对右侧详情；没有点击“立即沟通”或发送消息。BOSS 页面随时可能更新，下面的选择器应在运行时再次验证。

## 会话与页面状态

- 扫码后 Chrome 在 `data/boss-profile-v3/Default/Network/Cookies` 加密保存了 `wt2`、`zp_at` 等 Cookie。程序只在 `data/boss-session.json` 记录验证时间、Cookie 名称和到期时间，不复制 Cookie 值。
- 重启后，职位页可能先跳到 `/web/passport/zp/security.html`，几秒后自行回到 `/web/geek/jobs`。应等待真实 DOM 出现，再判定登录状态。
- 正常的职位页可能带 `_security_check` 查询参数；参数本身不是验证码。此次页面带该参数时仍显示 15 张职位卡片。
- 登录成功需要同时看到有效会话 Cookie 与可读的职位页 DOM。单有 Cookie 或单有页面都不足以确认。

## 已登录职位页实测

| 区域 | 已观察到的 DOM | 处理方式 |
| --- | --- | --- |
| 职位卡片 | `ul.rec-job-list li.job-card-box`，一次显示 15 张 | 只读可见卡片，一次性提取 |
| 职位链接 | 卡片内 `a.job-name[href^="/job_detail/"]` | 用岗位链接路径作为去重和身份键 |
| 公司与位置 | `.job-card-footer .boss-name`、`.company-location` | 字段缺失时跳过该岗位 |
| 薪资与标签 | `.job-salary`、`.tag-list li` | 读取可见文本；筛选要求的字段缺失时跳过 |
| 搜索框 | `input[placeholder="搜索职位、公司"]` | 用输入框当前值验证 `query` 参数是否生效 |
| 右侧职位名 | `.job-detail-info .job-name` | 必须与点击的卡片职位名一致 |
| 右侧岗位链接 | `.job-detail-box a.more-job-btn[href]` | 查询参数会不同，但与卡片链接的路径相同；发送前再核对 |
| 完整描述 | `.job-detail-body p.desc` | 使用可见 `innerText`，避免把隐藏混淆文本送入筛选 |
| 沟通按钮 | `.job-detail-box .op-btn-chat`，当前为“立即沟通” | 发送前检查目标；只有明确反馈才计成功 |

点击首张卡片后，右侧职位名与卡片相同，两条岗位链接的路径一致，描述可读，沟通按钮可见。`a.more-job-btn` 的完整 URL 含不同查询参数，因此不能逐字比较 URL。

## 尚未在线验证的动作

- 没有向真实招聘者发送消息；沟通浮层、发送后状态和频控反馈只通过本地模拟页面测试。结果不明时任务会停止，避免重复发送。
- 已登录卡片未出现可验证的“不合适”控件；程序只在实际出现该控件且有反馈时才计标记成功。

BOSS 接入层现由 `server/src/services/browser.service.ts`（会话）、`server/src/services/cdp.page.ts`（页面连接）和 `server/src/services/boss.page.service.ts`（DOM 与交互）组成。旧的页面内接口调用和旧 DOM 驱动已移除。
