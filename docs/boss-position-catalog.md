# BOSS 官方岗位分类接入

采集日期：2026-10-01。数据来自 BOSS 公开网页，不依赖用户登录。

来源链路：BOSS 首页 https://www.zhipin.com/ 加载 https://static.zhipin.com/zhipin-geek-seo/v5476/web/geek/js/main.js ，其 Search.loadPositionData 调用下面的全国岗位分类接口：

https://www.zhipin.com/wapi/zpCommon/data/getCityShowPosition?cityCode=100010000

响应通过 zpData.position / subLevelModelList 提供三级分类。本次采集包含 28 个大类、161 个子类、1098 个岗位条目；按代码去重后是 848 个岗位。跨分组重复的官方分类关系保留。各层代码和名称来自实际响应。

例：互联网/AI (1010000) → 前端/移动开发 (1000030) → 前端开发工程师 (100901)。

界面支持名称搜索、三级选择、手动更新。服务端接口为 /api/boss/positions。安装快照为 server/resources/boss-positions.json，运行缓存为 data/boss-position-catalog.json，含来源及采集时间。缓存期限为 24 小时，更新失败时显示原因并使用现有官方数据。

投递时验证 positionCode 对应真实叶子岗位，采用官方名称。BOSS 职位 URL 使用 position 参数；搜索词为空时不额外附加 query。重新搜索和恢复职位列表继续保留分类代码。简历分析提供官方岗位列表给 AI，并校验、映射返回的代码。

验证记录：

- 客户端、服务端生产构建通过。
- AI 协议、岗位分类、投递入口、页面读取和批量配额回归通过。
- 当前保存的 GLM-4.7-Flash 设置返回合法 JSON。旧请求强制启用深度思考，小请求耗时约 81 秒；修正后默认关闭，实测约 34 秒。耗时随网络和模型负载变化。
- 支持填写完整 chat/completions 地址；JSON 约束合并为单一系统消息；不把思考内容作为最终结果。
- 运行中的第 8 版后端返回 28 个大类、848 个岗位，BOSS 登录状态有效。
- 实际 Windows 窗口显示了官方分类。用户按 Escape 停止窗口检查后，停止所有窗口操作。没有向招聘方真实投递。

模型参数依据：https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash 和 https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode 。