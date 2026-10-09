# GitHub 上传准备

更新日期：2026-10-09。计划使用公开仓库，仓库名 jobloom；应用名“拾职 · Jobloom”。实际推送状态以 Git remote 与远端记录为准。

## 已准备

- README 重写为项目介绍、功能状态、安装启动、数据边界与第三方声明。
- 简历优化明确标记为未实现，实验代码不作为功能承诺。
- .gitignore 排除 data/、账号与浏览器资料、简历、日志、环境文件、依赖及构建产物。
- 当前 Git 跟踪文件未命中本次扫描的常见 GitHub Token、sk- 密钥和私钥格式。此扫描不是完整审计，不覆盖全部凭据格式及历史版本。
- 本轮检查未发现已配置的 Git remote。

## 推送前检查

~~~powershell
git status --short
git remote -v
git ls-files data output .env .env.local
git log --oneline -10
~~~

第三条命令不应列出个人运行数据或环境配置。不要使用 git add -f 加入这些文件。即使当前文件删除了凭据，Git 历史仍可能保留；发现泄露时先撤销凭据并清理相关历史，再发布。

docs 中含有历史调试与平台测试记录，发布前应人工确认其中岗位链接、时间和本机路径是否适合公开。若只需要向他人展示代码，可以先使用私有仓库。

主项目尚无根目录 LICENSE，而第三方反代组件已使用 GPL-3.0-or-later。不要直接把整个仓库宣称为 MIT；保留第三方声明，核对分发许可后再决定根许可证。

## 创建仓库后推送

先在 GitHub 创建目标仓库，确认仓库名称、公开或私有，以及登录账号。新建空仓库时不要额外生成另一份 README，以免初次推送产生冲突。

将下列地址替换为实际仓库地址后执行：

~~~powershell
git remote add origin https://github.com/YOUR_NAME/jobloom.git
git push -u origin main
~~~

若 origin 已存在，先核对已有地址，不要盲目覆盖。首次推送包含 main 上可达的提交历史，不只是最新文件。

GitHub 插件可帮助查看仓库与处理发布流程，但需要先安装并完成 GitHub 授权；插件建议不代表已经安装或连接。也可以使用 Git 自身的登录方式。账号凭据不写入 README、命令参数或仓库。
