# Claude 风格 UI 技能核验

检查日期：2026-10-07。范围：公开仓库的技能正文、完整目录、许可与依赖；未安装技能、执行第三方代码或测试实际生成效果。

## 结论

确实有专门模仿 Claude 视觉的社区技能，也有 Anthropic 官方设计技能。对于本项目 Electron + React 工作台，建议用官方 frontend-design 负责设计与实现流程，再明确指定 Claude 风格；官方 brand-guidelines 可作为颜色参考。社区专用包更直接，但下面两项存在许可缺失或约束矛盾。此推荐是依据源码内容做出的判断，实际界面仍需截图验收。

## 官方技能

核验仓库：anthropics/skills，固定提交 683bc88e56f3e09ba94f7055977f3d3aa499f202。官方 README 说明这些是 Anthropic 的技能示例，实际行为与 Claude 产品内置能力可能不同。[仓库说明](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/README.md)

| 技能 | 实际作用 | 对 Claude 风格的适用性 |
| --- | --- | --- |
| frontend-design | 先定义颜色、字体、布局，再实现、审阅；要求可读文案、键盘焦点、减少无关装饰，并在环境支持时检查截图。 | 通用 UI 设计指导。正文提醒避免默认套用奶油底与陶土橙，但明确说明用户指定该风格时应遵从，因此与本次要求兼容。 |
| brand-guidelines | Anthropic 品牌颜色与字体规范。暖白 #faf9f5、深色 #141413、主强调色 #d97757；标题 Poppins、正文 Lora，附字体回退。 | 适合借鉴品牌视觉；没有 Claude 聊天产品的侧栏、组件、交互和尺寸规范。 |

分别核对了 [frontend-design 正文](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/skills/frontend-design/SKILL.md) 与 [brand-guidelines 正文](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/skills/brand-guidelines/SKILL.md)。

### 目录、依赖与许可

GitHub 完整递归目录核验显示，两包各只有 SKILL.md 与 LICENSE.txt，没有脚本、字体资源、React 组件或安装钩子。[固定提交目录 API](https://api.github.com/repos/anthropics/skills/git/trees/683bc88e56f3e09ba94f7055977f3d3aa499f202?recursive=1)

两包都采用 Apache-2.0；实际许可文件分别为 [frontend-design/LICENSE.txt](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/skills/frontend-design/LICENSE.txt) 与 [brand-guidelines/LICENSE.txt](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/skills/brand-guidelines/LICENSE.txt)。技能本身没有模型账号或 API Key 要求。

brand-guidelines 的技术段提到用 python-pptx 给文档着色；这是其文档场景说明，不是运行网页 UI 所必需的依赖。字体没有打包，中文字体也需按项目实际环境另行定义。[brand-guidelines 正文](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/skills/brand-guidelines/SKILL.md)

### Codex 可用性

两包都是带 name、description 的 Markdown 技能目录，符合本机技能安装器支持的结构；其设计指令可供 Codex 读取。这个结论是格式与依赖的静态检查，不代表已在 Codex 安装或实测。安装时需保留同目录的 LICENSE.txt。上游 README 中的 Claude Code /plugin 命令属于其自己的安装流程。[上游格式与安装说明](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/README.md)

本机官方技能安装器成功获取 OpenAI curated 列表，未列出这两项或 Claude 品牌技能；这两个候选需从 Anthropic GitHub 仓库安装。此项是本次工具检查记录。

## 社区专用候选

以下由同一研究任务对固定提交的正文与完整目录进行了核验。

### catyiqian/claude-design-style

- 固定提交：bf81d61a4dbb3320ec0fd35b0187aa7085fc9ed4。
- 直接规定暖底 #FAF8F5、陶土橙 #D97757、圆角、serif 标题与系统正文字体，带 CSS 示例，并声明适用于 HTML/React，目标比官方品牌规范更接近 Claude 风格网页。[技能正文](https://github.com/catyiqian/claude-design-style/blob/bf81d61a4dbb3320ec0fd35b0187aa7085fc9ed4/SKILL.md)
- 完整目录只有 .gitignore、SKILL.md；未提供 LICENSE，GitHub 许可元数据为 null。正文自称 official 不能证明 Anthropic 官方来源。没有脚本、安装钩子或 API 请求要求，也没有中文字体适配。[完整目录](https://api.github.com/repos/catyiqian/claude-design-style/git/trees/bf81d61a4dbb3320ec0fd35b0187aa7085fc9ed4?recursive=1)、[仓库元数据](https://api.github.com/repos/catyiqian/claude-design-style)
- 本机按 sRGB 相对亮度计算：白字/橙色按钮对比度约 3.12:1，白字/hover 按钮约 3.99:1，灰字/暖底约 2.78:1。示例按钮 15px、字重 500，需要调整到适合普通文字的可读性；WCAG AA 普通文字门槛为 4.5:1，大字为 3:1。计算不是网页渲染验收。[样式依据](https://github.com/catyiqian/claude-design-style/blob/bf81d61a4dbb3320ec0fd35b0187aa7085fc9ed4/SKILL.md)、[W3C 对比度说明](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- 结论：适合作为视觉方向参考；若复制并长期分发技能内容，先明确许可。

### bergside/awesome-design-skills 中的 claude

- 固定提交：f631a09b4fcc0166f2e2c1a8c81906ef680c57e8。
- 包内为 skills/claude/SKILL.md 与 DESIGN.md，无脚本。仓库 MIT 许可，版权标注 2026 Bergside。[目录](https://api.github.com/repos/bergside/awesome-design-skills/git/trees/f631a09b4fcc0166f2e2c1a8c81906ef680c57e8?recursive=1)、[许可](https://github.com/bergside/awesome-design-skills/blob/f631a09b4fcc0166f2e2c1a8c81906ef680c57e8/LICENSE)
- 约束有矛盾：SKILL.md 要求按钮圆角 0px，DESIGN.md 元数据却列出 4px/8px 圆角；描述陶土强调色但 token 未完整定义对应色。指定 Anthropic Sans，却没有字体文件或回退链。[SKILL.md](https://github.com/bergside/awesome-design-skills/blob/f631a09b4fcc0166f2e2c1a8c81906ef680c57e8/skills/claude/SKILL.md)、[DESIGN.md](https://github.com/bergside/awesome-design-skills/blob/f631a09b4fcc0166f2e2c1a8c81906ef680c57e8/skills/claude/DESIGN.md)
- 结论：更偏品牌网站视觉，需要整理约束后才能用于本项目；不宜直接作为 Claude 聊天 App 的完整设计系统。

## 本项目落地时需要补齐

设计 brief 应指定暖白背景、少量陶土橙强调、清晰留白与中文字体，并按求职工作台的实际任务组织侧栏、列表和详情。技能包未提供中文组件成品；应在 Electron 中核验中文字形、薪资显示、按钮对比度、窗口缩放与键盘操作。当前报告只完成技能来源与内容核验，项目界面未修改。

## 安装记录（2026-10-07）

用户批准后，已使用本机 skill-installer 安装 Anthropic 官方固定提交 683bc88e56f3e09ba94f7055977f3d3aa499f202 的 frontend-design 与 brand-guidelines。

- 安装目录：C:/Users/Administrator/.codex/skills/frontend-design 与 C:/Users/Administrator/.codex/skills/brand-guidelines。
- 两包均保留 SKILL.md 与 LICENSE.txt；已检查技能名、description、严格 UTF-8 解码和 Apache-2.0 许可内容。
- frontend-design/SKILL.md SHA-256：D91970639E9F5C37682AC7AB60094D35F1C7C1F38D731BD56396563AEE10C1D3。
- brand-guidelines/SKILL.md SHA-256：1120B3769E2985CEFB3D25BE981B1F914ABEBA57AE079B83C20C666C164FA9FE。

安装成功；按本机技能安装流程，下一轮对话可加载使用。实际界面生成效果仍需在 UI 修改时验收。