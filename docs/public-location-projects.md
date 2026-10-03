# 不要求个人地图 Key 的定位项目调研

验证日期：2026-10-03。范围：当前 Windows / Electron / React / Node 桌面项目；仅核对公开官方文档和项目原仓库。本轮没有获取用户位置、查询用户 IP、读取私密配置、调用登录账号，或修改业务代码。现有 Electron 版本为 38.8.6。

## 1. 可执行选择

建议组合为 **Leaflet 地图选点 + OpenStreetMap 地图 + 用户主动提交的 Nominatim 地址搜索 + Windows 系统定位尝试 + coordtransform 本机坐标转换**。用户无需申请个人高德或百度 Key。每一层都有具体开源项目；地图展示、地名搜索和设备定位是不同能力，不能用其中一个项目宣称三项都已解决。来源及服务条件见以下各节。

建议用户操作：打开地图 → 点击“获取当前位置”或搜索公开地点 → 显示候选位置与精度 → 点击地图/拖动标记修正 → 确认作为出发点。系统定位无数据时仍允许完整地图选点。定位结果与搜索结果只作为候选，不自动以粗糙位置筛掉岗位。

公交通勤继续读取 BOSS 原生路线结果。下列地图、搜索、定位及坐标转换项目本身不提供当前中国公交实时路线；直线距离与公交时间应分别展示。既有 BOSS 坐标来源记录见 [接口及坐标研究](response-and-location-api-notes.md)。

## 2. 具体 GitHub 项目

| 项目原仓库 | 在本项目中的作用 | 实际边界 |
| --- | --- | --- |
| [Leaflet](https://github.com/Leaflet/Leaflet) | 地图点击、可拖动出发标记、精度圆 | 库为 BSD-2-Clause；地图数据/瓦片另有使用条件，库不含定位后端 |
| [leaflet-control-geocoder](https://github.com/perliedman/leaflet-control-geocoder) | 可选地址搜索控件，默认支持 Nominatim，另有 Photon 等适配器 | 接入控件仍须遵守选定搜索服务的政策 |
| [leaflet-locatecontrol](https://github.com/domoritz/leaflet-locatecontrol) | 浏览器定位按钮与地图显示 | 包装浏览器 Geolocation，不能消除 Electron 的 Google 服务依赖 |
| [Microsoft Geolocation sample](https://github.com/microsoft/Windows-universal-samples/tree/main/Samples/Geolocation) | Windows.Devices.Geolocation 的真实系统定位参考实现 | Windows 官方样例，需按桌面应用的权限和打包方式适配，不是即装即用的 Electron 包 |
| [NodeRT](https://github.com/NodeRT/NodeRT) | 从 Node / Electron 调用 WinRT 定位接口的可选桥接 | 需要 Windows SDK 和原生模块构建；本轮未验证 Electron 38 的 ABI 兼容性 |
| [Nominatim](https://github.com/osm-search/Nominatim) | 将地点文字查为坐标；可自建或选择合规服务 | 公共实例有严格限流；自建涉及数据库和地图数据导入 |
| [Photon](https://github.com/komoot/photon) | 支持多语言、容错的地点搜索，可作可切换备选 | 官方 demo 只允许合理小量使用，无可用性保证；全球自建资源较重 |
| [ip2region](https://github.com/lionsoul2014/ip2region) | 可选离线 IP 所属地区识别 | 自带数据库返回国家/省/市/运营商等，不含精确住宅位置或经纬度 |
| [coordtransform](https://github.com/wandergis/coordtransform) | 本机 WGS84 / GCJ02 / BD09 转换 | MIT，社区近似算法，保留原始坐标、坐标系与精度 |

[React Leaflet](https://github.com/PaulLeCam/react-leaflet) 是另一种 React 包装方式。当前项目可直接在 React 组件中使用 Leaflet，避免为了地图控件强行迁移 React 主版本；是否采用包装库应先核对它的 peer dependencies。

## 3. 获取当前位置：Windows 与 Electron 的区别

### 3.1 浏览器定位不能在 Electron 中默认承诺免 Key

Electron 官方明确：使用其 Geolocation 服务须配置 GOOGLE_API_KEY，在 Google 平台启用服务并关联账单。允许 geolocation 权限只是在应用侧允许访问，不会创建定位后端。因此直接调用 navigator.geolocation、Leaflet map.locate 或 locatecontrol，不能作为当前“无需申请个人 Key”的唯一获取位置实现。来源：[Electron 环境变量](https://www.electronjs.org/docs/latest/api/environment-variables)、[Session 权限接口](https://www.electronjs.org/docs/latest/api/session)。

### 3.2 GeoCoordinateWatcher 是可尝试的轻量兼容路径

System.Device.Location.GeoCoordinateWatcher 属于 .NET Framework 的 System.Device.dll，可从 Windows PowerShell 辅助进程调用。它向已安装的位置提供器取数，不要求地图开发者 Key；实际位置源可能是 GPS、Wi-Fi 或其他提供器，设备和系统设置决定是否可得位置。来源：[微软类文档](https://learn.microsoft.com/en-us/dotnet/api/system.device.location.geocoordinatewatcher?view=netframework-4.8.1)。

实现要点：

- 仅在用户点击“获取当前位置”时启动隐藏辅助进程；不要持续后台跟踪。
- TryStart 的 true 只代表在指定时间内开始获取，不代表已经有有效坐标。继续检查 Status、Permission、Position.Location.IsUnknown、数值范围与更新时间。
- TryStart 是同步调用，不能阻塞 Electron 界面或主进程。允许用户取消，结束后停止并释放 watcher。
- suppressPermissionPrompt 参数控制权限提示；静默启动不能当成已经获准，拒绝/禁用/无数据/超时均返回明确状态。
- 返回 HorizontalAccuracy 的米数并显示。缺失、非有限、未知或非常粗糙精度应让用户确认地图位置，不宣称已精确定位。

来源：[TryStart 参数、返回值及阻塞行为](https://learn.microsoft.com/en-us/dotnet/api/system.device.location.geocoordinatewatcher.trystart?view=netframework-4.8.1)、[HorizontalAccuracy 单位](https://learn.microsoft.com/en-us/dotnet/api/system.device.location.geocoordinate.horizontalaccuracy?view=netframework-4.8.1)、[GeoCoordinate 有效性字段](https://learn.microsoft.com/en-us/dotnet/api/system.device.location.geocoordinate?view=netframework-4.8.1)。

**兼容性限制：**旧 Win32 Location API 的官方文档提示后续系统可能更改或不再提供此接口，建议使用 Windows.Devices.Geolocation。GeoCoordinateWatcher 的可调用性不能证明当前 Windows 11 台式机有可用位置提供器。本轮只读文档，未执行任何私人位置测试。来源：[微软旧位置 API 提示](https://learn.microsoft.com/en-us/windows/win32/api/locationapi/nf-locationapi-ilatlongreport-getlatitude)。

### 3.3 现代系统接口有公开原项目，但集成成本更高

长期路径可参考微软 Geolocation sample，用 WinRT Geolocator.RequestAccessAsync / GetGeopositionAsync，保留权限、状态、时间、Accuracy 和 PositionSource。微软 UWP 示例要求前台 UI 线程申请访问及 location capability；不能把示例的权限流程直接原样复制进隐藏 PowerShell 后认为 Electron 已满足条件。定位被禁用时可引导打开 ms-settings:privacy-location。来源：[微软获取位置指引](https://learn.microsoft.com/en-us/windows/uwp/maps-and-location/get-location)、[Geocoordinate 元数据](https://learn.microsoft.com/en-us/uwp/api/windows.devices.geolocation.geocoordinate?view=winrt-26100)。

NodeRT 原仓库展示从 Node 调用 windows.devices.geolocation，也明确支持 Electron。它是可研究的现成桥接项目，但仍需相应 Windows SDK、编译和 Electron 原生模块适配。本轮没有建立它在本项目版本上的可用证明。来源：[NodeRT README 与定位示例](https://github.com/NodeRT/NodeRT)。

### 3.4 追加核查：现代 WinRT 不能按隐藏脚本免权限处理

2026-10-03 再查微软当前桌面应用指引：Windows.Devices.Geolocation 可用于 WinUI 3 桌面；未打包应用不要求 manifest 中的 Location capability，但仍需调用 RequestAccessAsync，请求时在前台 UI 线程。本轮未找到微软保证隐藏 PowerShell / .NET 脚本可以省略该请求而直接 GetGeopositionAsync 的文档例外。来源：[Windows 桌面获取位置指引](https://learn.microsoft.com/en-us/windows/apps/develop/maps-and-location/get-location)、[RequestAccessAsync 官方要求](https://learn.microsoft.com/en-us/uwp/api/windows.devices.geolocation.geolocator.requestaccessasync?view=winrt-26100)、[GetGeopositionAsync 权限与超时](https://learn.microsoft.com/en-us/uwp/api/windows.devices.geolocation.geolocator.getgeopositionasync?view=winrt-26100)。

微软 Win32 位置/Wi-Fi 行为变更另说明：首次精确位置权限提示由 RequestAccessAsync 触发，进程须在用户上下文且位于 C:\Windows\System32 之外，调用应与用户需要定位的操作对齐。因此仅加载 WinRT 类型或移植 PowerShell 调用示例，不足以证明已完成当前系统的权限与应用身份适配。若升级，应做真正的前台桌面桥接及权限流程；本轮不执行位置请求。来源：[Win32 精确位置权限变化](https://learn.microsoft.com/en-us/windows/win32/nativewifi/wi-fi-access-location-changes)。

## 4. 地图与公共地址搜索的使用范围

### 4.1 OpenStreetMap 标准瓦片

无须个人 API Key 的标准 HTTPS 瓦片可用于正常交互地图。必须显示 OpenStreetMap contributors 署名，发送合适应用标识/页面 Referer，按 HTTP 缓存头缓存；不能批量预下载、模拟拖图抓取或默认禁用缓存。公共瓦片是尽力提供，可能限制访问，地址应可切换。来源：[OSMF Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)。

Leaflet 的 click 事件和可拖动 marker 足够实现手动选点；设备位置可用精度圆表达。默认显示投影 EPSG3857 与输入地理经纬度是不同概念，不能把投影数字当作经纬度存储。来源：[Leaflet 官方 API](https://leafletjs.com/reference.html)。

### 4.2 Nominatim：只做少量用户主动地点查询

**接入公共实例前必须遵守 [Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/)。**政策要求开发者知情选择并承担使用责任；公共实例不得作为自动生成平台提供的通用地理编码服务。

本项目若将其限定为少量用户主动的出发地点查询，需要落实：

- 整个应用总计不超过每秒 1 次，排队、缓存相同查询，使用可识别本应用的 User-Agent 或有效 Referer。
- 按下“搜索”才请求；禁止输入联想/自动补全、周期后台扫描或系统化岗位地址抓取。
- 展示数据署名；服务地址可在不更新软件的情况下切换。
- 不自动向公共服务上传精确当前位置或其他个人/机密信息。可以搜索公共站点、路口、建筑，然后在本地地图修正。

来源同上。这里没有把公共服务的最高限额当作可用性或永久安全频率保证。

接口示例是 GET /search，q、format=jsonv2、limit、addressdetails、accept-language、countrycodes 可用于明确查找范围；返回 lat / lon 字符串及 display_name，应展示候选由用户选择。countrycodes=cn 为硬性国家过滤，viewbox + bounded 可进一步限制搜索范围。来源：[Nominatim Search 官方文档](https://nominatim.org/release-docs/latest/api/Search/)。

### 4.3 中国覆盖与 Photon 备选

OSM 有中国及上海地图资料、中文名称与地址标记规范；原社区文档也说明中国地址有时不能完整套入标准地址结构。它不能证明每个小区/楼栋都有数据或每个中文地址都能搜索成功。本轮未进行实际中国地址或中国网络可达性测试；用户手动选点/坐标输入需在查不到结果或服务不可达时保留。来源：[OSM 中国地图与地址标记资料](https://wiki.openstreetmap.org/wiki/China)。

Photon 官方提供 photon.komoot.io demo，允许合理小量项目使用，但可限流或封禁过量调用，且没有可用性保证。它支持多语言搜索及输入容错，可作为可切换备选，不能虚构固定“安全额度”。当前原仓库指出全球数据库约 95GB、推荐 64GB 内存；自建全球实例不适合这个低用量个人桌面项目。来源：[Photon 原仓库](https://github.com/komoot/photon)。

## 5. IP 定位只适合辅助城市视图

ip2region 默认离线库按 IP 返回国家、省、市、运营商、ISO 代码，没有自带精确经纬度。不能用它决定住址到岗位的公里数。来源：[ip2region 原仓库](https://github.com/lionsoul2014/ip2region)。

IP-API 公共免费接口无需个人 Key，但仅 HTTP、每 IP 每分钟 45 次、限定非商业用途，数据也可能不准确。即便返回 lat/lon，仍不等于当前门牌或设备 GPS。若采用，只用于候选城市/地图初始视野并明确其来源；也可以直接使用用户已选择的岗位城市而省去 IP 请求。来源：[IP-API JSON 接口](https://ip-api.com/docs/api:json)、[官方条款](https://ip-api.com/docs/legal)。

## 6. 坐标转换与距离计算

Windows 平台默认空间参考 ID 为 4326 / WGS84，这是现代 Geopoint 文档的明确说明。旧 GeoCoordinateWatcher 文档本身不返回 SRID，采用 WGS84 是平台默认约定的推断，应保存 Windows 来源并用地图让用户核对，不能把推断写成现场已测。来源：[微软 SpatialReferenceId 文档](https://learn.microsoft.com/en-us/uwp/api/windows.devices.geolocation.geopoint.spatialreferenceid?view=winrt-26100)。

OSM 地图选点与地理编码点用 WGS84 保存；coordtransform 提供 wgs84togcj02、gcj02towgs84、gcj02tobd09、bd09togcj02，在本机转换，无需上传到地图坐标转换 API。其算法为社区实现，GCJ02 逆变换为近似，不能保证官方测绘精度。MIT 许可要求保留版权和许可声明。来源：[原实现](https://github.com/wandergis/coordtransform/blob/master/index.js)、[MIT 许可](https://github.com/wandergis/coordtransform/blob/master/LICENSE)。

当前已核验的 BOSS SPA 岗位坐标是 GCJ02；BOSS 原生地点搜索的出发点依 mapper.type 而定，Baidu 为 BD09、Gaode 为 GCJ02。这两种角色不可都标成“boss”。新地图的候选是 WGS84；本实现确认时转换并明确标记为 GCJ02，再按目标地图提供者转换，避免混用。公开 SDK 及现场证据见 [既有研究 4.2 节](response-and-location-api-notes.md)。

直线距离只使用同一坐标系的两个有效点。查不到岗位坐标、坐标系未知或位置尚未确认时，显示“距离待确认”，不生成虚假距离，也不把失败当成距离超限。系统定位精度不足时先显示候选，让用户核对或在地图修正。

## 7. 实施验证边界

本文件是公开资料研究，未证明公共瓦片/搜索在用户网络上的连通性、当前设备的真实定位能力或新功能已加载。需要实现端检查：用户点击后才定位、拒绝/无数据/取消均可恢复、地图选点可保存、公共搜索受控且可切换、坐标不重复转换、公里数和公交通勤各有真实来源。有关程序构建和离线测试结果由主任务单独记录。


## 8. 追加：BOSS 新版公交起点的公开组件入口

验证日期：2026-10-03。只读静态源码，未打开地图、调用登录接口或运行组件。公开 runtime 列出地图与 UI 异步 chunk；新版组件在 [boss-zp-ui-core-351f5c61.a8b9c7b1.js](https://static.zhipin.com/zhipin-geek-spa/web/v6748/static/js/boss-zp-ui-core-351f5c61.a8b9c7b1.js)。[map-path-planing.a090ec08.js](https://static.zhipin.com/zhipin-geek-spa/web/v6748/static/js/map-path-planing.a090ec08.js) 是另一套直接使用 AMap 的旧组件，不能据它认定当前页面实现。

### 8.1 已核实字段与调用关系

| 项目 | 新版源码事实 |
| --- | --- |
| 起点入口 | selectStartPointAction(candidate)：保存候选并收起输入；已有终点地址时调用 handlePlanAction |
| 候选最低字段 | name 非空，longitude / latitude 为经纬度；desc 仅用于展示；入口不验证 POI 编号或是否来自搜索列表 |
| 起点城市 | 单独的 startCity 数据字段；候选的 cityName 不会用于发出的规划事件；缺失时回落北京市 |
| 终点 | jobAddressQuery 将岗位返回项映射为 addressId、cityCode、address、cityName、longitude、latitude；getEndPointList 按指定 addressId 选项或取首项 |
| 事件 | handlePlanAction 发 on-plan，把起点/终点各变成 [经度,纬度]，携带出行模式与两端城市 |
| 父组件 | planAction 重置结果并进入加载状态；通过 mapper.planRoute 调用对应路线类型，仅终点显式标为 gaode 来源 |

候选入口自身不要求匹配搜索建议，故可以把本项目经核对的 GPS/Leaflet 点交给它。这是静态代码的可行性结论，未证明用户当前浏览器版本能实际调用成功，也未证明任意点一定有公交路线。调用端仍需验证有效坐标和目标岗位身份，不修改岗位终点。

### 8.2 调用前状态与避免重复规划

- mapLoaded 是子组件 **prop**，读取 vm.mapLoaded / vm.$props.mapLoaded；isFinish 是 data。外层创建 mapper 后等待地图初始化完成，在下一次更新时设置 mapLoaded；子组件获取并选定终点后设置 isFinish。仅能读 mapper.type 不代表地图已初始化。
- 子 init 要求两项状态都就绪。选点入口自身未检查这些状态，调用端应先确认二者为 true、终点地址及坐标有效；isFinish 为 true 本身不能证明终点列表非空。
- currentPlanType 是可写的 data，初值读取已保存偏好，可能为驾车/步行/骑行。模式入口 selectPlanWayAction({type:'bus'}) 在模式改变时立即触发规划。
- 若需恰好发起一次公交规划，可先仅设置 vm.currentPlanType='bus' 与起点城市，再调用一次起点入口；该数据字段没有自动规划的 watcher。若沿用真实模式点击，需避免已有旧起点导致多规划一次。
- 起点入口已经触发父流程，不应再额外点击规划。它不返回路线 Promise；以父组件新的 planNo、isLoading 和可见结果判断本次完成，不读取旧路线冒充新结果。

本节模式调整方式是依据组件数据和方法关系提出的集成建议，未在运行页面执行。

### 8.3 起点须提前转换成当前地图提供者的坐标

[公开 bossMap 0.2.7 SDK](https://static.zhipin.com/assets/zhipin/geek/boss-map/bossMap-esm-0.2.7.min.js) 的 AMap、BMap、BMapGL 三个 getPoint 实现均只在指定来源/目标地图参数时进行转换，否则按该提供者原生坐标直接建点。新版父规划参数仅给终点 endOriginMapName:'gaode'，没有给起点对应参数；所以起点不会自动从 WGS84 或 GCJ02 转换。

因此本项目 GPS/OSM 的 WGS84 点应先离线转换：已核验 mapper.type 为 0 对应高德，使用 GCJ02；为 1 对应百度，使用 BD09。未知类型或 SDK 版本变化时先标为待确认，不能仅凭 BMap/AMap 全局名字猜测。类型和岗位终点角色的更早源码证据见 [接口研究 4.2 节](response-and-location-api-notes.md)。

岗位终点继续保留原始 GCJ02，交由原生 endOriginMapName 标识处理。本项目在用户确认 GPS/OSM 点时转换并保存为明确标记的 GCJ02，原始 WGS84 候选用于地图核对；原生路线再按当前提供者转换这份已标记的起点，避免再次当作 WGS84 重复转换。

### 8.4 研究边界

这里已核实当前固定版本的函数、最低字段、状态来源和坐标转换条件。没有确认当前正在运行的页面组件实例位置、调用权限、目标岗位接口结果、所选地图 provider 的实时值或路线成功率。本研究没有读取或输出地图 Key，也没有请求地图路线或公司/岗位账号接口。
