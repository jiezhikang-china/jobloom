# DeepSeek 流式返回与位置 API 核查

核查日期：2026-10-03。按 research 技能只读核查公开源代码、官方文档和本地实现；本轮只更新研究文档，不修改业务代码，没有读取 data 中的账号、密钥或 Cookie，没有调用真实 DeepSeek。本文的“建议验证”不是已运行的测试。

## 1. DeepSeek：上游依据与误判位置

固定上游为 Chat2API 提交 **59f03ab2988867a4d7bacb97d98f3ee018b0e4d0**。依据是该提交的 [deepseek-stream.ts](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/deepseek-stream.ts) 和 [deepseek-stream.test.ts](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/tests/providers/deepseek-stream.test.ts)。这是一份网页反代实现和它的测试，不是 DeepSeek 官方保证长期稳定的网页协议。

### 1.1 能由固定上游确认的形状

- 初始对象可以通过 v.response 给出响应快照；fragments 的 THINK 为思考，ANSWER / RESPONSE 为正式答案。空片段也要先确定通道。
- 上游处理 p=response/fragments 的片段数组，以及 p=response 数组里嵌套的 p=response 对象。
- 后续片段可以仅含字符串 v；要沿当前通道累计，不要求每个包都有 p。
- 流式实现认 data: [DONE]，同时也在底层流 end 时收尾。不能据此断言任何网络断流都是完成。

依据：[快照、片段与嵌套响应](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/deepseek-stream.ts#L246)、[字符串增量](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/deepseek-stream.ts#L317)、[结束后的收尾](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/deepseek-stream.ts#L419)。

上游测试提供了思考与正文分离、裸 v 字符串、[DONE] 与 end 不重复收尾、相对 BATCH 搜索补丁等用例；测试里仅有思考的响应，其正式 content 仍为空。它们是上游单元 fixture 的证据，不等于本轮抓取了真实账号网络流。依据：[通道测试](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/tests/providers/deepseek-stream.test.ts#L190)、[相对补丁测试](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/tests/providers/deepseek-stream.test.ts#L221)。

### 1.2 本地研究开始时的遗漏

以下是本轮开始时读取 [protocol.cjs](D:/boss直聘脚本/vendor/deepseek-web-proxy/protocol.cjs) 的直接发现。主任务已同时修复该文件；这里保留原因及检查点，避免把历史缺陷误写成仍未修复。

| 响应形状 | 旧实现的问题 | 可执行处理 |
| --- | --- | --- |
| 显式 p 为空字符串 | 用 if(event.p) 判断，遗漏根补丁并保留旧路径 | 按字段类型判断“是否有 p”，空路径也是有效根 |
| 根路径 o=BATCH | 无 lastPath 时不进入 patch | 允许根批次；每个子项合成绝对或相对路径 |
| p=response 数组里的子 p=response | 被拼成 response/response，初始快照丢失 | response 与 response/ 开头均视为绝对路径 |
| 相对 p=-1/content、0/type 等 | 相对路径需基于父补丁，负索引需基于当前 fragments | 统一 joinPath；先建空片段及类型，再接正文 |
| 无 p 的字符串 v | lastPath 停在 response 时未累计正文或思考 | 结合当前片段和通道累计；显式 SET 快照不能重复追加 |
| event: finish 后只有空行 | 只有解析 data 后才标记完成 | 原始流解析可单独处理终止事件；见下方兼容边界 |
| 一个事件有多行 data | 逐行 JSON.parse 会把完整 JSON 错判非法 | 一个 SSE 事件收齐 data 行后用换行拼接，再解析 |
| THINK 后出现空 ANSWER / RESPONSE | 若只凭非空 content 切通道，会继续把答案塞进思考 | 通道由片段 type 决定，不由内容是否为空决定 |
| 内容本身包含 FINISHED | 删除字符串会破坏合法正文、JSON | 只看结构化完成状态，保留答案中的原文字串 |

最后一项也是上游实现中可见的风险，不能照搬字符串替换做法；依据：[上游 removeFinished 调用处](https://github.com/xiaoY233/Chat2API/blob/59f03ab2988867a4d7bacb97d98f3ee018b0e4d0/src/main/proxy/adapters/deepseek-stream.ts#L350)。

### 1.3 完成、恢复和兼容边界

标准 SSE 使用 UTF-8，事件由空行分隔，多行 data 合并；**只有 event: finish、没有 data 的帧不会被标准 EventSource 当成消息派发**。对原始字节流接受这种终止帧，是适配网页端的兼容行为。依据：[WHATWG SSE 解释规则](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)。

固定上游未提供足够证据证明 response.status 的 DONE、CLOSE 或 CLOSED 是网页端正式枚举，也没有证明空 p 或 finish 无 data 来自本轮真实流。可以为这些形状编写兼容 fixture，但应保留这个证据边界，不把别名写成官方协议承诺。

建议成功条件分两层：

1. 收到明确终止后，要有正式答案；只有 THINK 不能算业务结果。
2. 若业务明确要求 JSON，流正常结束且正式答案是完整合法的预期 JSON，可以在已有字节上恢复；仍由业务层验证所需字段。截断 JSON、显式错误、只有思考或空答案应保留待确认状态。

修正解析器、从已收到的答案恢复，均不需要再次提交生成。研究早期仅靠固定上游没有核实到网页历史接口；主任务随后在项目自己的既有聊天中实测确认了下节的历史读取路径。恢复应读取原会话，不能自动新建聊天弥补。既有待确认会话的行为见 [频率与重试研究](D:/boss直聘脚本/docs/deepseek-web-rate-control.md)。

本轮末次只读观察时，本地 protocol 已包含空根、joinPath、裸字符串通道、事件缓冲、终止事件、DONE / CLOSED 别名，以及限定 jsonExpected 的 EOF JSON 恢复。此观察不代表本研究执行了功能测试或真实模型验证。

### 1.4 后续现场证据：原聊天历史已可读取

2026-10-03，主任务在本项目自己的既有会话中核验了 **GET /api/v0/chat/history_messages?chat_session_id=…**。去掉网页请求中的缓存增量参数后，可读到完整 chat_messages：USER 的 REQUEST 片段，以及 ASSISTANT 的 FINISHED 状态和 THINK / RESPONSE / TIP 片段。该会话的正式 RESPONSE 中存在含 5 个 jobs 的最终 JSON。这是主任务现场观察的新增证据；研究子任务没有读取该私有会话，没有发起新的模型生成。

当前本地恢复实现可供复核：[protocol.cjs 的 recoverPending](D:/boss直聘脚本/vendor/deepseek-web-proxy/protocol.cjs:404)。它经 request 层解包后核对 chat_session.id、chat_messages，检查唯一 USER / ASSISTANT 的 parent_id 与 message_id 关系、ASSISTANT status=FINISHED，且 incomplete_message / has_pending_fragment 不得为 true；仅提取 ANSWER / RESPONSE，忽略 THINK / TIP 作为最终答案。

恢复仍应绑定原 sessionId 和 requestId，不因历史接口成功就放宽消息关系校验。只有完整正式答案且业务 JSON 验证通过时，才解除该请求的待确认并复用答案；历史为空、仍生成、片段未完成、关系不符或解析失败时继续等待。这里只读历史，不重复提交 completion，不删除待核实的原聊天。

该接口属于网页内部接口，不是官方付费 API 合同；以后结构变化需要重新核对。现场证据补足了早期“未核实历史接口”的限制，并不证明所有账号、所有网页版本或所有中断都可恢复。

## 2. 高德 REST：用户自填 Web 服务 Key

高德开放平台使用 **GCJ-02**。设备 GPS 的 WGS84、百度 BD09 均应先转换，不能混用。依据：[高德官方坐标说明](https://lbs.amap.com/faq/advisory/others/39838)。

| 功能 | 官方 endpoint 与请求参数 | 成功返回和注意点 |
| --- | --- | --- |
| 位置提示 | GET https://restapi.amap.com/v3/assistant/inputtips；key、keywords 必填；city、citylimit=true、datatype=poi、output=json | status 为字符串 1；tips[] 的 name、district、adcode、location；location 是经度,纬度字符串 |
| 坐标转换 | GET https://restapi.amap.com/v3/assistant/coordinate/convert；key、locations=经度,纬度；coordsys=gps / baidu / mapbar / autonavi | status=1；locations 为转换后高德坐标；多点输入用竖线，返回用分号 |
| 公交地铁 | GET https://restapi.amap.com/v3/direction/transit/integrated；key、origin、destination、city；起终点均经度,纬度；跨城填 cityd | status=1；route.transits[]；duration 为方案总秒数，walking_distance 为步行米数；strategy=0 选择较快方案 |

分别依据：[输入提示](https://lbs.amap.com/api/webservice/guide/api-advanced/inputtips)、[坐标转换](https://lbs.amap.com/api/webservice/guide/api/convert)、[v3 公交规划](https://lbs.amap.com/api/webservice/guide/api/direction/)。

补充实施点：

- Key 类型应为 Web 服务。不要把 BOSS 城市编号 101… 直接当高德 citycode；用服务商的城市名或合法代码。
- 提示中的公交线路可能没有 location；跳过无有效坐标结果，或通过 POI 详情补齐。不能让缺坐标位置参与距离计算。依据：[输入提示的 datatype 与 location 说明](https://lbs.amap.com/api/webservice/guide/api-advanced/inputtips)。
- 若用 v5 新版公交，不要混用 v3 参数及返回路径；v5 使用 city1 / city2，扩展字段受 show_fields 控制。依据：[v5 路线规划](https://lbs.amap.com/api/webservice/guide/api/newroute)。
- 空 transits、服务错误、不可解析的 duration 均为“无法确认通勤”，不能用 0 分钟表示成功。

## 3. 百度 REST：用户自填服务端 AK

| 功能 | 官方 endpoint 与请求参数 | 成功返回和坐标 |
| --- | --- | --- |
| 位置提示 | GET https://api.map.baidu.com/place/v2/suggestion；query、region、ak 必填；city_limit=true、output=json | status=0；**result[]**，其中 name、location.lng / lat、uid；默认 BD09，可用 ret_coordtype=gcj02ll |
| 坐标转换 | GET https://api.map.baidu.com/geoconv/v2/；ak、coords=经度,纬度；多点用分号；model 指定转换方向 | status=0；result[] 的 x 为经度、y 为纬度 |
| 公交地铁 | GET https://api.map.baidu.com/direction/v2/transit；ak、origin、destination 必填；起终点均**纬度,经度** | status=0；result.routes[] 的 duration 为方案耗时；1001 表示无方案，result 为 null |

分别依据：[位置提示与检索文档](https://lbsyun.baidu.com/docs/webapi?title=placev3%2Fguide%2Fwebservice-placeapiV3%2FinterfaceDocumentV2)、[现行 geoconv v2](https://lbsyun.baidu.com/docs/webapi?title=geoconv%2Fguide%2Fchangeposition-base)、[v2 公交 REST](https://lbsyun.baidu.com/docs/webapi?title=directionv2%2Fwebservice-direction%2Ftransit)。

这里必须分别格式化坐标，不能全局复用一个 toString：

- suggestion 的可选 location 是纬度,经度；其 coord_type 为数值 1 / 2 / 3 / 4。
- geoconv 的 coords 是经度,纬度。v2 使用 model：1 为 GCJ→BD09，2 为 GPS→BD09，5 为 BD09→GCJ。**不要把旧 v1 的 from / to 参数写进 v2 请求。**
- transit 的 coord_type 为字符串 bd09ll（默认）/ bd09mc / gcj02 / wgs84；ret_coordtype 默认为 bd09ll。tactics_incity=4 为时间较短。
- 普通地点检索 search 返回 results[]，位置提示 suggestion 返回 result[]，两个数组名不同。

依据分别为上表对应官方文档。公交 SDK 文档将规范化 duration 定义为秒，但其参数说明还写“公交不支持 coord_type”；不能将微信 SDK 的适配说明替代 REST 参数表。保守实现可先统一成 BD09，再调用百度 REST。依据：[官方微信 SDK 公交说明](https://lbsyun.baidu.com/docs/jsapi?title=wxjsapi%2Fguide%2Fguide%2Ftransit)。

百度的无方案应展示为无法规划；同样不能当 0 分钟。如果计算多个方案，使用合法 duration 中的最短值，并保留方案摘要与计算时间，界面称为预计通勤。

## 4. 获取位置、BOSS 坐标和无额外 Key 的转换

### 4.1 位置功能应该明确来源

地址搜索给用户可选择的楼宇、地铁站、地址结果；坐标取自选中的同一结果。输入一个模糊地址后，不能默认第一条就是用户的家或出发点。手填时至少保存经度、纬度、坐标系和位置名称，验证数值范围及非空。

若“获取当前位置”指设备定位，Web 服务 Key 本身不能读取设备 GPS。浏览器 Geolocation 需要位置权限，其 latitude / longitude 使用 WGS84；取得后再转换到地图服务商坐标系。依据：[W3C Geolocation 标准](https://www.w3.org/TR/geolocation/)。

### 4.2 BOSS：岗位终点与原生搜索出发点不同坐标系

后续证据已补齐，不能再统一把 coordinateSystem: boss 当作一种真实坐标系。主任务在当前岗位页面核对了职位编号与所选链接一致，jobInfo.longitude / latitude、map-box-wrapper 的 location 和原生通勤 endAddress 数值一致；它们都是**岗位终点的原始值**。同值并不代表搜索出发点也用相同坐标系。

关键现场调用为 path-plan-panel 的 planAction：planRoute 使用 start、end、startCity、endCity，并显式指定 **endOriginMapName: gaode**。下面是该调用与公开 SDK 组合后能确认的关系。

| 数据来源 | 当前坐标系 | 直接依据 |
| --- | --- | --- |
| 当前 SPA jobInfo → 地图 props.location → 原生 endAddress | **GCJ02** | planAction 将 endOriginMapName 指为 gaode |
| 当前 BMapGL 原生搜索的 addressList / 起点 | **BD09** | 百度适配器 searchPlace 直接返回 poi.point；路线起点未指定转换 |
| 路线接口真正收到的终点 | **BD09** | SDK 将 endOriginMapName 传入 getPoint，默认目标 baidu，将 GCJ02 转为 BD09 |
| 高德服务商原生搜索（如果以后 type=0） | **GCJ02** | SDK 该分支使用 AMap.PlaceSearch，不能继续按百度起点标记 |
| 独立岗位页 job-location-map 的 data-lat | 待该页调用链核对 | 不能仅凭字段名、DOM 类名或同样的网址路径判定 |

公开 [bossMap-esm-0.2.7.min.js](https://static.zhipin.com/assets/zhipin/geek/boss-map/bossMap-esm-0.2.7.min.js) 中：planRoute 将 endOriginMapName / endTargetMapName 传给 getPoint；有转换选项时，getPoint 调 convertCoordinates。其默认目标为 baidu，current 也归为 baidu，gaode 对应 COORDINATES_GCJ02，baidu 对应 COORDINATES_BD09。无转换选项时直接构造 BMapGL.Point。上述不是根据名称推测。

当前 [公开 WebGL SDK](https://amap-proxy-bz.zhipin.com/_BMapServiceV2/zhipin-js-4c/getscript?v=1.0&type=webgl) 也确认默认 coordType 为 BMAP_COORD_BD09，并有 GCJ→BD09 和反向转换。**去掉 type 参数的 getscript 会返回旧 BMap 版本，不能拿它代替现场 WebGL 版本的依据。** 本轮只读公开源码，输出前屏蔽了非坐标枚举字符串，没有打印任何地图 Key / ak。

#### 服务商判别与角色迁移

SDK 工厂依据动态配置选择服务商；mapper 对外 **type** 可判别：0 为高德，1 为百度 / BMapGL。基础类构造时将配置 type 存入 this.type。不要用 getMapType 判断服务商，它表示底图种类；getMapInfo 是远程配置接口，不要为了判别类型输出可能含 Key 的整个配置。依据：[SDK 工厂 Ji 与基础类 gt](https://static.zhipin.com/assets/zhipin/geek/boss-map/bossMap-esm-0.2.7.min.js)。

对已核实由当前 type=1 地图产生的旧记录，可以按角色迁移：原生搜索 origin 的 boss → BD09；当前 SPA 岗位 point / endAddress 的 boss → GCJ02。新位置应该根据本次 mapper.type 标注来源，再将出发点与岗位终点转到同一坐标系计算距离。未来服务商变化、来源不明或独立页未核实的历史值，不能套用同一个迁移假设。

高德静态图 URL 含 /amap_proxy/，只能证明图像服务路径，不能单独证明输入坐标。静态图可能由服务端生成或接受明确 coordtype；本次岗位坐标判定以实际 planAction 的 gaode 参数为直接依据。

现场页面业务脚本来源为 [app~0](https://static.zhipin.com/zhipin-geek-spa/web/v6748/static/js/app~0.9231ac09.js)、[app~2](https://static.zhipin.com/zhipin-geek-spa/web/v6748/static/js/app~2.1a6c0514.js)、[app~3](https://static.zhipin.com/zhipin-geek-spa/web/v6748/static/js/app~3.b0324736.js)。研究子任务直接读取这些条目未定位到相关组件方法，因此不把这三条脚本单独列作 planAction 的源码证明；该方法来自主任务的页面现场观察，转换逻辑由上面的公开地图 SDK 独立核对。

### 4.3 GCJ↔BD09 本地函数与许可证

原项目 [wandergis/coordtransform](https://github.com/wandergis/coordtransform) 的 [index.js](https://github.com/wandergis/coordtransform/blob/master/index.js) 提供 gcj02tobd09 与 bd09togcj02；[LICENSE](https://github.com/wandergis/coordtransform/blob/master/LICENSE) 为 MIT，版权为 2015 记忆的残骸。复制或改写相关实现，应保留版权及许可全文。

公式依据是该原库，不是百度或高德官方发布的转换精度保证。其两方向使用 π×3000/180、经纬偏移 0.0065 / 0.006 和三角扰动。可以用于本地近似互转；应验证正常坐标、边界与往返误差，不宣称完全等同官方转换结果。

高德用户无需为了转换再申请百度 AK：需要 BD09→GCJ 时，可用用户自己的高德 convert 接口及 coordsys=baidu；若需要反向本地近似转换，可采用上述 MIT 函数。输入和输出都保留坐标系，避免反复转换。官方接口依据：[高德 convert](https://lbs.amap.com/api/webservice/guide/api/convert)。

## 5. 后续验证清单

本轮没有运行这些验证；它们供实现者选择覆盖实际风险：

- SSE：根快照、显式空 p、相对 BATCH、嵌套 response、无 p 字符串、空 THINK→空 ANSWER→正文、SET 不重复、多行 data、中文 UTF-8 跨块。
- 完成：DONE 幂等、终止事件无 data、正常 EOF 完整 JSON、断流或截断 JSON、只有 THINK、答案中合法 FINISHED 字符串、显式错误与未知状态。
- 位置：两家不同坐标顺序、不同成功码、百度 result / results 区别、高德提示缺 location、无路线、非法 duration；转换后来源标签不丢失。
- BOSS：按 mapper.type 与出发点/岗位终点角色标注坐标系；旧 boss 标签分别迁移；同一岗位工作地址与其坐标匹配；公交结果起终点一致。独立页坐标未核实或来源不明时明确展示原因。

## 6. BOSS「不合适」：动态平台理由与自由文字

只读来源：[当前页面 runtime](https://static.zhipin.com/zhipin-geek-spa/web/v6748/static/js/app~3.b0324736.js) 解析出 lazy chunk 2298；其公开 [boss-zp-ui-core 组件](https://static.zhipin.com/zhipin-geek-spa/web/v6748/static/js/boss-zp-ui-core-351f5c61.a8b9c7b1.js) 导出 NegativeFeedback。主任务现场入口使用 scene=4 和当前 jobDetails。本轮没有打开实际反馈窗口、读取私有理由响应或提交反馈。

### 6.1 公开组件明确的规则

| 项目 | 源码可确认的行为 |
| --- | --- |
| 理由来源 | 先用传入 reasonList；否则读取 reasons.json 的 result，不是写死一份选项文本 |
| 显示选项 | setReasonList 排除 code=5，按 type 分组；title 为组标题，children 为具体理由；按钮显示及 tooltip 均使用 item.text.content，标识为 item.code |
| 选择操作 | 点新理由设置 activedCode 并清空 feedbackReason；再次点同理由回到 code=5 |
| 自由文字 | 独立“其他反馈”输入框；输入非空文字会切换为 code=5 |
| 必填限制 | handleSubmit 在 code=5 且 feedbackReason 为空时提示空内容并返回；其他 code 的前端提交没有要求自由文字 |
| 按钮状态 | 默认 activedCode=5，因此不能只看按钮是否可点来判断可无文字提交 |
| 保存字段 | scene、code、feedbackReason、securityId、lid、encryptExpectId；可选平台理由时发送空 feedbackReason |

源码中的理由路径是 /wapi/zpgeek/negativefeedback/reasons.json，保存路径是 /wapi/zpgeek/negativefeedback/save.json。这些仅用于说明组件行为，本轮未调用这些接口。前端允许空文字不等于本轮已验证后端保存成功。

### 6.2 执行偏好与实际反馈

- 用户随后明确授权选择现有理由，重点是让公司和岗位不再出现。实现优先选与当前公司匹配的内置公司选项，缺少公司选项时选已有可见选项；不上传本地筛选日志、公司分析、AI 判断或简历条件。
- 本版 code=5 的“其他反馈”需要自由文字，因此自动流程应取消；不能为满足必填而填写内部判断。
- 静态源码未提供当前账号的具体 option 标签及 code 含义。“某职位”可能是组标题，也可能是具体选项；不能只凭文字出现就假设可以提交。需要主任务只读现场的 type / title / code / text.content，核对目标是当前岗位，且选中后 code 非5、feedbackReason 仍为空。仅输出这些平台选项字段，不输出 jobDetails 或 securityId。
- 主任务实际打开并取消自选职位的反馈弹窗，看到公司、距离远、重复推荐和停招选项。只确认界面结构，未在真实岗位提交。空文字公司选项与成功信号使用离线 CDP 页面验证。
- 若以后平台将具体选项加入必填文字或其他额外输入，按现场状态取消，不能仅依赖本版源码的 code=5 检查。

这里保留的是平台界面操作的验证建议，不建议绕过界面直接调用保存 API；选项与校验由平台实时提供。

## 7. 本项目实施与验证（2026-10-03）

- 右侧详情：岗位路径编号与 Vue jobInfo.encryptId 交叉核对，忽略跟踪参数；标题用可见文本、NFKC 和空白归一化；loading 时等待。读不到不视为不合适，重读两次后保存待确认。
- 公司与岗位：不合适目标写入本地 not-suitable.json，按公司及岗位编号过滤；筛选规则页可撤销本地屏蔽。内部淘汰原因不写入平台字段。
- 独立页也已核对：job-location-map 的 data-lat 是 longitude,latitude；planAction 同样传 endOriginMapName='gaode'。岗位终点为 GCJ02，当前 type1 原生搜索出发点为 BD09。
- 旧测试地点混算约8.744公里；统一坐标后直线约7.977公里。直线距离为近似值；公共交通按所选地图预计时间比较。
- 定位：可填自己的高德 Web 服务 Key 或百度 AK，手动搜索和选择位置；可直接输入 GCJ02/BD09，GPS 坐标通过自己的地图 API 转换。地图 Key 不进入 AI 提示。
- DeepSeek：THINK 与 RESPONSE/ANSWER 分开读取，完成后不继续等连接断开；兼容多行 SSE、根 BATCH、代码围栏、前后说明、文本数组与尾逗号。缺结论、多个无对应答案等进入待确认，不以网络失败自动重新生成。
- 原请求已在新版代理真实恢复：读取完整 history_messages，校验用户 REQUEST、父子消息及模型/思考/搜索选项，读回含5个 jobs 的最终答案；pending 由1变0，状态 ready。没有新的生成请求。
- 验证覆盖：CDP 卡片/详情与反馈、界面保存恢复、跨坐标系和地图请求格式、公司清单跨重启去重与撤销、详情补字段/未知活跃度/失败保留、AI 格式待确认、重试批次保留及思考原聊天恢复。未向真实招聘者测试投递，也未使用用户地图 Key 测试。
