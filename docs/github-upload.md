# GitHub 上传备用方式

普通 Git 上传连接异常时，可在项目根目录运行 `npm run git:upload:api`。

它使用现有 Git 登录凭据，通过 GitHub 官方 Git Database API 和 IPv4 上传已提交的差异，不需要重新生成账号密钥。凭据只保存在进程内存中，不打印或写入文件。接口连接超过20秒会退出。

每个文件、目录树、提交都要与本地SHA完全一致，之后才更新远端分支。更新使用非强制快进，远端有新改动或本地存在未提交文件时停止。完成后再次读取远端，确认与本地HEAD一致并更新本地远端跟踪记录。

目前只支持HTTPS的github.com远端、普通单父提交和文件差异；签名提交、额外提交头、子模块或不属于快进的历史需要使用Git原生上传。

依据：[GitHub提交API](https://docs.github.com/en/rest/git/commits)、[目录树API](https://docs.github.com/en/rest/git/trees)。