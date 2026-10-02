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
- 自选期望的“不合适”反馈已于 2026-10-02 完成在线验证，见下方补充。

BOSS 接入层现由 `server/src/services/browser.service.ts`（会话）、`server/src/services/cdp.page.ts`（页面连接）和 `server/src/services/boss.page.service.ts`（DOM 与交互）组成。旧的页面内接口调用和旧 DOM 驱动已移除。

## 公司行业与公司页补充（2026-10-02）

此次只读取职位页和公司页，没有沟通或发送操作。

- 当前列表右侧 `.job-detail-box` 没有公司行业。完整职位页的 `.sider-company a[ka="job-detail-brandindustry"]` 提供行业；例如深圳信银为“银行”，畅易融为“互联网金融”，上海志盈通信息公司为“投资/融资”。
- 从 `.sider-company .company-info a[href^="/gongsi/"]` 读取当前公司的链接及 `title` 名称。用完整页 `.job-banner .name h1` 核对职位身份，再用公司页 `.company-banner h1.name` 核对公司身份。
- 完整职位页只读标题为“职位描述”的 `.job-detail-section .job-sec-text`；公司介绍、薪资说明和推荐岗位使用其他区块，不能混为该岗位职责。
- 标题存在隐藏干扰字。例如 `h3` 的底层文字为“职位boss描述”，实际显示为“职位描述”。标题和正文都使用可见 `innerText`，不能用底层 `textContent` 比较标题。
- 公司页行业位于 `.company-banner a[href^="/i"]`；简介是 `.company-info-box .job-sec` 中标题为“公司简介”的 `.text`，经营范围是 `.company-business .business-detail li` 中“经营范围”一项。部分公司没有简介区块，但有工商经营范围，需如实保留缺失状态。
- 行业标签、简介和经营范围分别保存。普通公司的经营范围可能有“非居住房地产租赁”“互联网销售”等，不能仅靠这些许可项把公司或普通岗位判为房地产、销售。
- 行业与业务核对在独立后台页完成，沿用原 Chrome 会话。正常读取后关闭核对页；遇到登录或安全验证时保留并显示该页。扫码页和投递页保持各自身份。

## 自选期望与“不合适”反馈（2026-10-02）

- 「推荐」旁自选期望是 `.c-expect-select .expect-list .expect-item`，当前选中项为 `.expect-item.active`。数量和名称直接读取可见 DOM，切换后等待该期望选中且列表变化。自选期望在原职位页切换，不附加搜索关键词或岗位分类。
- `.job-detail-box .job-detail-operate .not-suitable` 是右侧详情的“不合适”，并非卡片上的控件。
- 点击后出现 `.zp-feedback-dialog`，标题为“选择原因，减少不合适职位推荐”。页面会保留隐藏副本，必须定位可见弹窗。
- 反馈选项在 `.zp-type-item`；其他反馈为 `textarea.zp-type-textarea`，最多 50 字。确定按钮是 `[ka="dialog_sure"].zp-btn-sure`，取消是 `[ka="dialog_cancel"]`。
- 实测填写淘汰原因并确认后，`.zp-toast` 显示“已进行反馈”，内含 `.zp-toast-icon-success`。卡片不一定立即移除。没有内容会提示“提交内容为空”，不能计成功。
- 读取、打开详情和反馈前均核对岗位名、公司名和链接。此次提交了缺失公司介绍岗位的反馈，没有向招聘者发送消息。
- 卡片的 `a.boss-info[href*="/gongsi/"]` 可直达公司资料页，优先使用可省去完整职位页的一次打开。公司页已加载但没有介绍时返回空简介。

## 按目标修改自选期望与薪资字体（2026-10-02）

- 期望编辑页使用干净的 `/web/geek/resume/`。三个全职位置满额时，职位页的“添加期望”只允许新增兼职，不能用于替换全职目标。
- 全职行是 `#purpose li[ka="user-resume-edit-expectation0"]` 等，含 `.position-item .label-text`、`.money-item`、`.city-item`。悬停该行后才显示对应的 `a[ka="user-resume-edit-expectation0"]` 编辑按钮。
- 表单是 `#purpose .expectation-form`；岗位入口 `[ka="resume_form_edit_positionName"]`，只读输入值是已选岗位。`.position-dialog` 按 `.position-category-wrap li` 大类、`.navs .stage-three` 子类、`.position-list .position-tooltip` 具体岗位依次点击；选择后弹窗关闭。
- 城市入口 `[ka="resume_form_edit_cityValue"] .ui-cascader-selection`，隐藏输入值形如 `101020000,101020100,0`；选城市后选地区“不限”。现有期望保留薪资，新位置选择“面议”，助手仍应用自身薪资筛选。
- 保存使用 `[ka="resume_form_expectation_ok"]`。保存前检查岗位与城市代码，保存后等表单关闭、对应行出现，再刷新个人页确认全部目标已持久保存。真实验证已保存当前目标“新媒体运营（上海）”并刷新确认，其他两个位置保留。此流程没有删除期望。
- CDP 初始化恢复 `Input.setIgnoreInputEvents(ignore=false)` 并开启焦点模拟。此次故障中悬停有效、原生点击被忽略，恢复后实际自选切换产生可信点击事件。原生按下和释放分别发送 `buttons=1` 和 `buttons=0`。
- 实际 `kanzhun-mix` / `kanzhun-Regular` 字体以 U+E031 至 U+E03A 对应0至9。已对照实际字体绘制结果核对十个数字并读取真实卡片薪资；页面读取、历史待确认显示和薪资解析共用还原规则，未知私用字符显示“薪资待确认”。
