# Firefox Auto 身份回归（2026-10-17）

## 边界与状态

**最新结论：本机 Developer ID 签名候选已实际安装，原永久授权经原始 IPC 确认；真实项目 Firefox 的 Ping0 仍为 39 分、6 项异常，整站 FAIL。安装边界数据一致性通过；运行后已定位应用回收站和原会话字节的两份备份，但调用来源和逻辑 Cookie 状态仍未知，不能宣称运行后数据全部保持。旧坏 DMG 未上传；新独立 DMG、原 ZIP 和新校验单已公开为非 Latest 预发布，三个公开链接均完成匿名 HTTP 200 全量回读、大小和 SHA-256 匹配。未进行 Apple 公证；上传交付通过不等于实站验收通过。**

本轮基于 `4c6c13b` 修复源码。本节以下起始记录截至源码验收阶段，当时旧安装版及工作中的 Firefox / Chromium 尚未被替换或关闭；之后获批本机安装与实站执行的结果见本文末尾追加记录。源码、单测、构建的通过不能替代 Studio → 原始 preload IPC → BrowserManager → 项目 Firefox → Ping0 的实站验收。

用户反馈原值保留：

| 项目 | 用户提供值 | 用户提供分类 | 源码验收结束时的状态（历史） |
| --- | --- | --- | --- |
| 国家 / 时区 | `ip_country=US · tz=Asia/Shanghai` | 高危 | 尚未复验新代码 |
| RAF 帧间隔 | `39.25ms` | 记录 | 未读取本轮原始 rows/findings，不升级分类或宣布通过 |
| DNS | `resolver_count=0` | 致命 | 自然挑战链尚未重新关联取证 |

本轮未修改站点结果、DNS 计数、RAF、时间戳、全局 VPN 或安全设置。不把历史辅助 DoH 响应当作当前自然 DNS 事务，不把 HTTP 代理在远端解析目标等同于 fake-IP。

## 已确认的源码缺口

1. Chromium 已有代理 Geo Auto 解析，Firefox 却先从原始 meta 构造身份，仅显式时区非空才给子进程设置 `TZ`。保存的 `timezone=null / locale=null` 没有接到代理出口身份。
2. Firefox 早期复用只绑定原始请求；Auto 的有效时区、语言或实际 fallback 代理变化可能被原始空值掩盖。
3. 新建表单把 Firefox 的时区、语言与 Chromium 专属参数一起隐藏，却仍读取隐藏值；卡片还将 Firefox 模式固定显示为 off。
4. Geo 内存缓存键遗漏密码。更换密码可能切换出口路由，却仍读旧 Geo。缓存读取本身不续期，但保存检测结果的流程原来重新使用当前时间，可能让缓存看起来像新观测。
5. Window / Worker 时区偏移解析不能正确处理 `GMT-5` 等单数字小时；Worker 的嵌套源码还存在正则转义问题。隔离 realm 用例证明会退回宿主偏移。此项是 Date 偏移缺陷，不是 RAF 调度根因。

## 修复合同

- 显式合法时区 / 语言优先；managed Auto 从实际使用代理取得合法 Geo，再明确回退宿主。不能凭国家随意选择单一时区。
- 持久化空值仍为 Auto，不将启动计算值写回用户的手动设置。
- 同一有效身份进入载荷、语言 prefs、子进程 `TZ`、一致性预期及实例复用绑定；off 不进行受管 Geo 查询和注入。
- 保留请求 / PID / 二进制 / prefs / 沙箱 / 注册会话的原有拒绝检查。有效身份变化应要求正常重启，不能杀进程、清活实例记录或重写运行中 prefs。
- Geo 缓存用进程随机密钥的 HMAC 绑定传输身份与认证，不将明文凭据或可离线验证的稳定凭据摘要放入键。
- 通过 `proxyDetectionObservedAt()` 在原始结果对象上保留成功观测时间；缓存读取不续期，无已知观测时间则不伪造 Firefox 持久检测时间。
- Firefox 仅展示、提交已支持的字段；保留已有 Firefox 版本 pin，卡片使用实际模式。Auto 标为启动时解析 / 尚未确认，缓存元数据检查不代表实站一致性已通过。
- managed 与 off 仍共享既有调度 prefs；本轮未把 off 宣称为 stock Firefox 时序，也未以删调度 prefs 代替因果取证。

## 本轮验证记录

### 已执行

- 密码隔离回归：修前 `1 failed / 5 passed`，错误表现为新凭据返回旧时区结果。
- 加入观测时间接口的测试先出现缺失导出错误；实现后 `proxy-detector-cache.test.ts` **8/8** 通过，覆盖凭据隔离、真实 fake-clock 十分钟过期、读取不续期、原始观测时间与未知时间不造值。
- cache / hosting / launch snapshot 三文件 **19/19** 通过。
- `config-manager.test.ts` 在单次命令独立临时目录运行 **40/40** 通过。新用例直接读取落盘 JSON，再 reload、按 profile / proxy 精确查回并检索 Auto 配置，验证 Auto=null、显式值和原始检测时间均保留。
- `tsc --noEmit --incremental false` 通过。
- 后端第一阶段定向门禁：**16 文件 / 614 测试**通过；包含 exported launch、Firefox 身份 / 表面 / GPU / prefs、Chromium 共享身份与启动守卫、代理 snapshot / DNS 及 cache 回归。之后独立复核确认下述两个边界缺口，后端已恢复修正，不能把这一阶段结果当作最终稳定源门禁。
- 缓存与 JSON roundtrip 的独立静态复核未发现具体可行动问题；覆盖仅限所审源码，不替代真实网络检测或原始对象以外的观测时间证明。
- 首次全 unit 集成快照（两个 worker、单次命令隔离临时目录）实际结束：**179 文件，1 failed / 178 passed；4522 测试，4 failed / 4517 passed / 1 skipped**，95.87s。四项均在 UI 实现中的新回归：三项 VM fixture 缺少真实 DOM 的 `removeAttribute`，另一项证明空一致性数据仍在健康卡显示 `Pass`。这些失败保留，待 UI 稳定后统一重跑，不能记为整合通过。

### 独立复核追加的边界回归

1. 新的 UTC 解析可能在原生 Date 校验前返回 0，使 `Date.prototype.getTimezoneOffset.call(0)` 或可转换普通对象不再抛 `TypeError`。Window 和 Worker 均须先保留原生接收对象校验；非法 Date 仍应返回 NaN。
2. 启动入口的配置快照不含后续健康状态变化。若异步 BiDi / Geo 检查期间主代理变差、当前策略改选 fallback，原始请求 hash 不变，不足以证明旧路由仍可复用。须在 await / 副作用边界重查当前语义路由，不能把所有健康时间戳塞进 hash 造成无谓重启。

两项追加回归先出现 **10 failed / 7 passed / 177 skipped**：六个路由竞态、四个原生接收对象 / 跨 realm 用例失败；六个同路由元数据更新对照仍通过。最小修正后同一选择器 **17 passed / 177 skipped**，后端扩大门禁 **16 文件 / 630 测试**通过。Window / Worker 先验证原生 Date 并保留 NaN，再使用捕获的原生 epoch，避免调用自定义 valueOf；当前语义代理在 await / prefs / spawn / ownership 边界重新核对。观测时间用例也加强为只认原始检测对象。追加修正的独立闭环复核结论见下文；实现者的通过结果与独立复核分别记录。

### 已稳定的 UI 与静态门禁

- UI 初始 **3/3 RED**、扩展生命周期 **12/12 RED**；修正后 **5 文件 / 275 测试**通过。
- 原生内核可跳过身份 BiDi shim，不能一律写成“preferences + BiDi preload”。两处能力说明先补 **3/3 RED**，再改为已安装内核决定 native / preload 覆盖，双语 / HTML / fallback / 根镜像保持一致；同一 UI 门禁再次 **275/275** 通过。
- 主会话已运行 `check-i18n.mjs`：renderer **zh=1668 / en=1668**、main **zh=35 / en=35**，通过；marketing-copy、三个修改 JS 的语法检查、file-size baseline 与 `git diff --check` 均通过。
- 原有 MASQUE Go 辅助工具在既有开发输出内使用 `GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local npm run build:native` 编译通过，无新下载。这不是 Firefox 内核构建或实站验证。

### 最终稳定源全 unit 与闭环复核

- 最终全 unit：**179 文件通过；4560 passed / 0 failed / 1 skipped（4561 total）**，90.85s。
- 唯一 skipped 是 `tests/unit/bundled-native-browsers-async.test.ts` 的原生 Windows 默认发现用例，本机 macOS 不执行该平台路径；不冒称跨平台全验。
- 运行前后选定的 **376 个源码 / 单测 / 构建配置文件**摘要一致：`152f3e93a8419a64c9b2504cc4745b7d70db73e2190c32cadbc7c34fbf2ae2be`。所有测试退出后再启动源码构建，不并发清理 dist。
- 全 unit 日志含运行记录测试 fixture 的 SQLite `no such table: news_run_results_v1` 清理警告，以及负例工具输出；断言通过不等于应用运行时无错误，不能拿该 suite 证明真实数据库或浏览器运行无异常。
- 独立、只读闭环复核确认此前两项具体问题均已关闭；所查源 / 测试摘要在复核期间不变。复核没有运行实际 Firefox，不扩成全局行为等价结论。
- 完整 `npm run build` **exit 0**：clean → TypeScript emit → renderer / preload / resources copy → 正式公钥注入 → Go 辅助工具编译。构建后实际读取 `dist/resources/license-pubkey.txt`，确认 Ed25519 公钥 SPKI SHA-256 仍为 `c1aafecf9cd3a42eb05caf104a29906bfda3b442320b26928c98f37598b6b55d`，不是 trial-only 构建；未读取私钥。
- 构建后重新摘要同一批 376 文件，与全 unit 前后摘要一致；HTML、profiles.js、active i18n.js 的构建副本与源码逐字节相同。编译产物包含新的 Auto / 观测时间数据流。
- 最新验盘：共享工件 APFS 可用 **10,301,788,160 bytes（约 9.59 GiB）**，仍低于 10 GiB。原有开发树在内置卷，源码构建没有迁移 / 新建大型运行工件；未生成新安装包、替换安装版或启动浏览器。

## 源码阶段未闭环项（历史；后续执行见下文）

- 新代码尚未经真实项目 Firefox 的 Date / Intl / Worker / DST 及 Ping0 验收；不能宣称国家 / 时区实站已通过。
- RAF 需要精确标签、生产 BiDi 会话与原生前台全检测期证据；最多两次普通刷新，不额外 rAF 预热或密集 JS 轮询。单次前台样本不能改写历史失败。
- DNS 需要本轮自然挑战创建、触发、轮询及 submit/findings 的关联。浏览器 HTTP 体也不等于完整 DNS / TLS 线上证据。
- 本轮尚未取得对当前安装版的合法认证及精确 context 绑定；现有公共 MCP evaluator 只选首个顶层标签，不能冒充已选中当前失败页面。不能绕过认证、扫描凭据、暴露进程调试器或误读其它账户标签。
- 共享工件卷仍低于既定 10 GiB 余量，相关运行 / 打包写入停止；不改用其它项目的独立卷，不偷偷回退内置盘存运行工件，不自动清理 / 扩容。源码与小型单测位于原有开发树，不是迁移运行工件。
- 候选替换须满足存储和用户工作会话的维护条件，保留配置、设备身份、vault、永久授权及正式发行公钥。当前不提交、推送、公开新包或进行 Apple 公证；按用户要求先试用最终候选，再决定公证。

## 2026-10-18：获批本机候选交付与实站执行记录

以下状态取代上节源码验收阶段的存储等待，不改写其历史结果：

- 用户要求“打包安装实际验证”，并明确选择新建本任务独立工作卷，以及候选签名核验通过后正常退出 Studio 与其当前项目 Firefox / Chromium 进行更新；正常退出受阻则停止，不强杀。
- 独立稀疏 APFS 卷已创建。虚拟上限 32 GiB，本任务实际保留数据额度 6 GiB，宿主与新 APFS 各保留 10 GiB。旧共享卷、旧包和其它项目均不清理、不扩容、不借用。
- 主会话独立执行严格检查器：**27 测试通过**；对准确新卷 UUID、映像、物理存储、owners、任务根及 2 GiB 剩余打包预算的真实检查 **exit 0**。准备时新 APFS 可用 34,070,372,352 bytes。就绪记录已直接读回，不将观察当成预留或免除后续复查。
- 第一次打包前门禁因脚本只列两个 ZIP 而拒绝正常的 `browsers-manifest.json`。该 133-byte 清单与当前安装版逐字节一致，包含 Chromium `152.0.7977.72`、Firefox `154.0`；将其完整摘要加入精确输入清单后继续。失败记录保留，没有删清单或修改旧内核。
- 候选 App 已组装；后台会话正式签名返回 `errSecInternalComponent`，同一后台的钥匙串设置查询返回 `User interaction is not allowed`。这不是签名通过。正常桌面 Terminal 的独立探测实际返回 `Aqua`、钥匙串设置查询 exit 0，因此沿用既有正常桌面签名路径，只补完该候选签名，不重新打包或改钥匙串 ACL / 安全策略。
- 本节最初追加时，桌面签名与独立包内核验仍在进行；其后实际完成结果如下，不能将签名或安装资产通过等同于 Ping0 实站通过。

### 本地候选与安装资产的历史核验（不代表当前 DMG 状态）

- 桌面路径逐项完成 **16 个原生组件**的正式 Developer ID 签名。Team `Y62N77529N`，证书 SHA-1 `512B8645689F92E8C75CB65AF43A91281F5F36DF`；安全时间戳、hardened runtime、无 get-task-allow，`codesign --verify --deep --strict` 通过。签名前后原生编译前缀与非签名资源相同。
- 独立核验器已检查实际包内六项编译代码、源码摘要、两套内核 ZIP、版本清单及原正式公钥。新 ASAR **8,197,101 bytes**，SHA-256 `ff985adb153e48a9d7cb6daaeb99487f59653fa031e23189d75a912a10b60d9a`；与旧安装 ASAR `c1ca14bb80ec55661774637bcd46a09cfb2770f2871eb15754b75e0446996fb0` 不同。证书提取可选参数初次写法错误的失败记录保留，改为明确 `--extract-certificates=<prefix>` 后实际读回公开证书并匹配摘要，没有重签或读取私钥。
- **ZIP：414,035,052 bytes**，SHA-256 `e06f5e7c5602e6c693ae906000a2d49eb8afacee097f749e6648721db238c70d`。完整 CRC 检查及流式 ASAR 读回一致。
- **旧 DMG 的历史核验（仅记录当时）：415,794,339 bytes**，SHA-256 `c50dba7bdcf692e9dc19a77d98299444670652c9e2bc8d37659b620db6652e9a`。DMG Developer ID 签名、映像校验、只读挂载后 App 签名 / ASAR / 公钥 / 内核资源检查通过；已正常 detach。初次 `/var` 与 `/private/var` 非规范路径比较失败保留，核实唯一对应的只读映像、设备与规范路径后完成原有映像核验，未重新生成掩盖失败。**这些是历史结果，不能认证当前旧 DMG；本次上传前复核失败见文末追加。**
- 本地 `SHA256SUMS` 与最终资产记录均新建、fsync、直接读回并检索。新候选 fuse 的只读 REA 证据 `ev_2d2e0c613bdac128e6e62e08c6c1f2542903bd132054ec97188222b2032ca42f` 确认 `EnableNodeCliInspectArguments=enabled`；这只说明临时自有调试进程可使用 CLI Inspector，不代表已经连接到生产 Firefox。
- 本节最初追加时，正在执行正常退出与安全安装。源码确认 Studio 直接退出或 `browser.stop` 会走带 SIGKILL 后备的生命周期，因此维护流程先对准确拥有的 Firefox / Chromium PID 请求 Cocoa 正常退出，确认关闭后才退出 Studio；不依赖强杀来满足安装条件。后续实际结果如下。
- 未进行 Apple 公证、提交、推送或公开发行新候选。

### 实际安装与永久授权：通过，限定安装边界

- 旧 Firefox、Chromium 正常退出后，旧 Studio 正常退出；无强杀。候选已替换到 `/Applications/Agent Browser Studio.app`，保留本轮及上一轮两个旧版 rollback，不清理它们。
- 安装准备阶段曾因 `codesign -R` 的 literal requirement 缺少前导 `=`、将 `/Applications` 当 mountpoint 查询、stage 根目录及 14 个 symlink 的 metadata 不同而拒绝继续。失败记录保留。最终仅修正自有 stage 的已核验源 metadata，再执行完整 source / stage / old tree 核验及 exclusive rename；未更改真实用户目录权限、ACL 或系统安全策略。
- 安装完成、首次启动前的直接文件核验确认：**3 份原配置、所清点 Cookie/session、设备身份、license、vault key 与冷基线一致**。冷备份只有关键配置、license、vault；Cookie/session 是清点校验，不是完整可恢复备份。该结果不能外推为应用运行后永远不发生变化。
- 新安装版实际启动后，经原始 `window.agentBrowserAPI.license.status()` 返回 `plan=lifetime`、`expired=false`、`maxProfiles=null`、`expiresAt=null`、`canActivate=true`。使用原真实 HOME / userData 与正式发行公钥，未重置试用或替换 issuer。

### 真实存储环境限制：严格 no-mock 不满足

- 实际安全投影为 `secretBackend=file`、`encryptionAvailable=true`、原因 `existing local vault`；既有 `.secret-vault-key` 使产品保持原加密 file vault。`src/main/services/secrets.ts` 选择已有 vault 后，`src/main/index.ts` 在 macOS 为 Electron 自己的 Cookie/session OSCrypt 追加 `use-mock-keychain` switch。
- 本轮 controller 没有传 `--use-mock-keychain`、isolated-file-secrets、假 HOME、userData 或发行公钥 override；但产品内部确实追加了该 switch，因此仍记录 **`strictNoMockSatisfied=false`**。最初严格前置拒绝保留，随后仅观察真实既有存储环境，不称之为严格 no-mock 验收通过。
- 未迁移、替换或降级 vault，未改钥匙串 ACL、partition list、TCC、Gatekeeper 或 quarantine；这也不是用户另行批准改变秘密存储后端。

### Studio → 原始 IPC → 项目 Firefox → Ping0：已实测，FAIL

- 通过真实 Studio 表单新建专用 Firefox QA，未复制真实账户 Cookie；managed/macOS，`timezone=null`、`locale=null`、`preset=null`，只调用一次原始 `browser.launch`。
- 本轮安装版 Studio PID `71612`、Firefox PID `82159`，绑定已安装 ASAR 的 runtime table 与原生产注册 BiDi：entry 的 engine / PID / port、`entry.bidiConn`、`getRegisteredFirefoxSession(port)` 和开放连接对象前后一致。没有 `session.new`、重连或 standalone 浏览器替代。
- Firefox 为包内更新后实际展开的 `154.0`。启动前代理新鲜观测 `detectedAt=1792258780484`，Geo 为 `Asia/Tokyo`；实际 Firefox 进程 `TZ=Asia/Tokyo`、`user.js` 请求语言 `ja-JP`，持久 Auto 字段仍为 null。Studio 主进程未设置 `TZ`。这证明 Auto 数据流已实际接入，不证明它匹配所有站点出口。
- 一次自然导航、**0 次 reload**，检测 `finished=true`、无 pending rows，report ID `REPORT_ID_REDACTED`，**39 分 / critical / 6 项异常 / site-findings-only FAIL**：

| 原始 finding | 本轮原值或摘要 | 站点分类 / 权重 |
| --- | --- | --- |
| `net.isidc` | `true` | warn / 8 |
| `stealth.raf_timing` | `37.38`，`fail=true` | info / 3；保留“记录”级别，不手动升级 |
| `xc.dns_blackhole` | `resolver_count=0` | critical / 15 |
| `xc.ip_lang` | `ip_country=DE`、`primary_lang=ja-JP` | warn / 8 |
| `xc.ip_tz` | `ip_country=DE`、`tz=Asia/Tokyo` | danger / 10 |
| `xc.multi_geo_ip` | 18 个 distinct_v4、2 个 distinct_v6，DE / JP 结果 | critical / 20 |

- 站点确实观测多个出网 IP 与 DE / JP 国家结果；代理分流 / 轮换、Geo 数据库分歧等具体机制仍未充分证明。不能靠手工固定一个时区冒充所有出口一致，更没有改站点结果。
- 自然 HTTP 采集 `OBSERVED_WITHIN_WINDOW`，242,857 retained bytes，dropped=0、errors=[]。engine GET / POST 均 HTTP 200；8 次 `/envdetect/probe/dnsleak` POST 均 HTTP 200，原始返回均为 `resolver_count=0`、resolvers/items 为空；submit HTTP 200，原始 score / findings / evidence 已保留。
- 100 个自然 challenge resource 出现 TLS/security fetchError，类型包括 `SSL_ERROR_NO_CYPHER_OVERLAP`、`SSL_ERROR_UNRECOGNIZED_NAME_ALERT`、`SSL_ERROR_BAD_CERT_DOMAIN`，未声称每类已精确计数。**`dnsTransactionsVerified=false`**：HTTP 体和浏览器错误仍不是完整 DNS wire、TLS peer 归属或权威服务端日志证据，不能据此断言“完全没出网 / VPN fake-IP / 全球服务故障”。未关闭 TLS 校验、泄漏本地 DNS 或填造计数。
- RAF 检测期原生前台采样覆盖约 83.9 秒，798 个样本均为 QA Firefox PID，最大样本间隔 125ms；页面报告 visible / hasFocus。它是约 100ms 采样，不是每帧连续 key-window / scheduler 证明，但本轮证据不支持再断言“仅激活前台即可修好”。
- Window / Worker 组合 probe 为 **INCONCLUSIVE**，没有可用 Worker / DST 成功原始结果。finished 后只读检查原 conn 的 `browsingContext.getTree` 返回 `contexts=[]`；未改选 first context，也未新建 context / session 补绿，原因未知。
- 已实际读取并目视原生 Firefox 截图：检测完成、39 分、6 项异常，与原始结果一致；本轮未见无效启动参数横幅。地址栏远控 / BiDi 提示没有被遮掉，也不能由此次 Firefox 观测关闭全局 Chromium 横幅任务。

### 自有调试实例正常退出；安装包运行后再核验

- 只对本轮自有 QA Firefox 与 debug Studio 请求 Cocoa 正常退出，确认不存在其它用户浏览器工作后才退出 Studio；未调用带强杀后备的 stop API。
- 旧 main Inspector、Studio CDP、QA BiDi 端口实际检查已关闭。安装版以正常 `open -a` 启动，最后记录 PID `89330`、UID 501，无显式 inspect / remote-debugging / isolated-file-secrets / mock-keychain 启动参数。产品内部默认追加 mock switch 的上述限制仍然存在。
- 旧 `studio-launch.json` / PID / BiDi port 只是已退出会话的历史证据，不再连接或当作当前会话；正常用户实例不因补验而自动重启。
- `2026-10-17T18:15:31.808Z` 的独立只读补验再次通过：原 376 文件源码摘要仍为 `152f3e93a8419a64c9b2504cc4745b7d70db73e2190c32cadbc7c34fbf2ae2be`；当前安装 ASAR 仍为 8,197,101 bytes / `ff985adb153e48a9d7cb6daaeb99487f59653fa031e23189d75a912a10b60d9a`；正式公钥摘要及 pinned certificate 的 `codesign --verify --deep --strict -R ...` 通过。包内 `fullPing0Acceptance=false` 保留。该补验不读写真实 userData，不启动 / 停止应用；`git diff --check` exit 0。

### 运行后完整性复查：发现差异，未标通过

- 安装前后的一致性记录真实有效；但后续运行与正常重启后的再审计，原配置 3 份、当前仍 3 份，实际为 **原 3 − 1 份回收站配置 + 新 QA 1 = 3**。另一份原配置仅 `syncedAt` / `syncedHash` 改变。license.json、vault key 原字节及 deviceId 仍一致，调试端口已关闭。
- 最后“原数据全部相同”的断言实际失败，`final-local-validation.json` **未生成**。没有删断言补绿，也没有用冷备份覆盖现状。
- 独立只读调查找到缺失配置的准确目录位于 `<userData>/trash/profiles/<original-id>`；不是仅凭清单存在就判可恢复。实际目录存在，410 个 regular files 已检查且不跟随 symlink；其中冷基线覆盖的 **24 个选定 Cookie/session 文件、共 309,526 bytes，长度与内容 HMAC 全部匹配**。这不代表全部 410 文件均有完整冷基线或可恢复证明。

| 时间（2026-10-17 UTC） | 直接记录 |
| --- | --- |
| 17:03:21 | 冷基线包含 3 份元数据，随后缺失的原配置根为 directory |
| 17:12:29 | 安装完成、首次启动前，3 份原配置及清点数据一致 |
| 17:27:16.180 | 应用 trash/index.json 中该配置被移入回收站，`deletionAttempted=false` |
| 17:27:16.200 | audit.log.jsonl 同一准确配置的 `profile / trash` 事件 |
| 17:28:06.314 | 另一份原配置的 syncedAt 更新，差异仅两个同步记录字段 |

- 回收站元数据与冷基线也仅 `syncedAt` / `syncedHash` 不同，未发现同一配置的后续 restore / purge / hard-delete audit。支持“安装后发生应用回收站操作、所清点数据可定位”，不支持“安装器已永久删除数据”。
- **调用者未知**。`trashBrowserProfile` 的 audit `actor=user` 是代码常量，不是物理用户点击的证明；renderer 的确认删除及批量删除均可调用该 IPC。同步 push / pull 都可能更新时间字段，保留日志不能证明本次具体同步方向或触发源，不归咎用户、同步或迁移。
- 将该 trash 路径视为原配置搬迁后的 root 后，原选定文件 **90 条内容一致、2 条变化、1 条仍未定位**，另有 **5 个新增选定文件**。剩余差异继续精准只读归类，不能仅凭文件类型猜测为正常缓存 / WAL 清理。
- **不得为查看回收站而调用 `profile:trash-list`**：其 handler 会先调用 `purgeExpiredTrash()`，不是只读。此次仅直接文件观察，没有调用它，没有恢复、移动、删除、重建 profile 或更改真实数据库；正常 Studio 不动。

### 后续精准归类：原会话字节已定位，整体完整性仍不作通过判断

上述“1 条未定位”是当时按原相对路径比较的结果。后续只补做一次有界白名单映射，定位这 8 项差异都属于**仍保留的同一份原 Firefox 配置**，不是移入回收站的配置：

| 差异 | 标准文件名 / 类型 | 冷基线 → 当前长度 |
| --- | --- | --- |
| 内容变化 | `sessionCheckpoints.json`，会话生命周期检查点 | 288 → 90 bytes |
| 内容变化 | `storage/default/<origin-redacted>/.metadata-v2`，QuotaManager 元数据 | 80 → 80 bytes |
| 原路径缺失 | 根目录 `sessionstore.jsonlz4` | 2,255 bytes → 原路径不存在 |
| 新增 | `sessionstore-backups/previous.jsonlz4` | 无 → 2,255 bytes |
| 新增 | `sessionstore-backups/upgrade.jsonlz4-20260902091224` | 无 → 2,255 bytes |
| 新增 | `sessionstore-backups/recovery.jsonlz4` | 无 → 3,292 bytes |
| 新增 | `sessionstore-backups/recovery.baklz4` | 无 → 3,254 bytes |
| 新增 | `cookies.sqlite-wal` | 无 → 65,616 bytes |

- 原根目录 `sessionstore.jsonlz4` 的**完整 2,255-byte 内容 HMAC**，与当前 `previous.jsonlz4`、`upgrade.jsonlz4-20260902091224` 两份备份都相等；其旧字节没有失踪。四份会话备份均有 mozLz4 格式标识，没有解压或输出账户 / 标签页内容。文件字节匹配不等于实际浏览器恢复流程已验收，未自动执行恢复。
- Cookie WAL 的独立格式检查为 v3007000、page size 32,768、32-byte header + 2 个完整 frame、无尾余；header / 滚动 checksum / salt 均有效，第 2 个 frame 带 dbsize=3 的 commit 标记。旁边 `cookies.sqlite` 98,304 bytes，内容 HMAC 仍等于冷基线，SHM / rollback journal 不存在。
- **不能将 Cookie 主文件字节相同升级为逻辑 Cookie 内容相同**：WAL 有有效提交事务结构，本轮没有解析 Cookie 值、读取账户内容或重放该事务来宣称业务状态一致。
- 检查点当前为有效 JSON 对象，含三个布尔字段；`.metadata-v2` 时间形前缀及 mtime 均在 17:23:27 UTC 附近。未独立解码元数据字段语义，也不能仅凭标准文件名或时间推断具体写入者、正常退出、同步或人工操作。
- 唯一有界重建只哈希 97 个白名单文件、25,467,109 bytes，非选定文件内容哈希数为 0。七个现存差异文件首读 / 复读内容相等且 stat 稳定，精确文件 `lsof` 无可见持有者；这不是全 profile 原子快照，也不能回溯证明此前审计时没有 writer。
- 已停止扩大数据读取；未改真实配置、Cookie、数据库或回收站，没有调用生产 API，也没有为补证再启动 / 退出应用。已确认的位置 / 字节关系与尚未知的调用归属 / 逻辑 Cookie 状态分开记录。

**交付边界：签名、安装和原永久授权已实证；整站修复、Worker / DST、严格 no-mock、运行后全部数据完整性仍未闭环。保留真实失败与未知，不以单测、包体或安装成功替代。**

## 上传前资产复核追加：旧 DMG 失败与新候选独立核验

- **旧 DMG 不可上传**：本次实际摘要与上文历史值不同，`codesign` 报 `invalid signature`，`hdiutil` 报 HFS 内部 CRC 校验失败。变化和损坏的原因未知，不能据此推断具体写入者、复制过程或篡改来源。
- 旧 DMG 文件与历史记录均未覆盖、未删除、未上传；保留历史成功和当前失败，不重新计算历史记录来接受变化后的旧文件。
- 当前源 App 的严格签名核验通过，ZIP 摘要仍与原资产记录匹配。这些是各自范围内的检查，不会使旧 DMG 重新有效，也不替代 Ping0 或用户数据状态验收。
- 本节首次追加时，新的独立 DMG 正在准备，尚无其签名、映像 CRC、只读挂载及包内一致性核验成功结论；该时点没有预写成功或沿用旧 DMG 的证明，随后本地核验结果单独记录如下。
- 下述新资产的本地核验仅支持**未公证公开预览版**的资产检查。实站仍为 39 分、6 项异常；严格 no-mock 不满足，Worker／DST、数据操作调用来源及逻辑 Cookie 状态仍未知。不得宣传为实站修复通过或运行后全部数据完整性已验证。

### 新独立 publication DMG：本地核验通过，远端发布尚未完成

- 新独立文件为 `Agent-Browser-Studio-1.0.1-preview-20261018-mac-arm64.dmg`，**415,839,685 bytes**，签名后 SHA-256 为 `c42c5eb74baec3bc80801e057e006373b0c4bdeb82d1b7acd4dac537acf11333`。使用同一已验证源 App，没有重编或修改 ASAR，也未覆盖旧坏 DMG。
- 严格 pinned Developer ID 签名、`hdiutil` 校验、只读挂载后的 App 签名，以及 **554 条（含根）的 content / mode / link 比对**均通过；映像已正常 detach。Python 与 `shasum` 两种方法得到相同的签名后摘要。
- ZIP 仍为 **414,035,052 bytes**，SHA-256 `e06f5e7c5602e6c693ae906000a2d49eb8afacee097f749e6648721db238c70d`，摘要与原资产记录匹配。新 DMG 的成功不改变旧 DMG 的摘要差异、无效签名、HFS 内部 CRC 失败及原因未知结论；旧文件和旧记录继续保留，旧坏 DMG 未上传。
- 15 个源码／测试文件的提交 `044a3d4` 已推至公开 preview 分支。**本次追加时，GitHub 新 release 仍为草稿，ZIP 上传尚在进行**；尚无远端资产完整回读及摘要核验成功结论，不能写成“已发布”或“远端验证通过”。
- 上述仅为当时的本地资产核验及发布准备状态，不把 39 分／6 项异常、严格 no-mock 不满足、Worker／DST 未知或运行后数据状态未闭环改写为通过。

### 公开预发布与完整远端回读：上传交付通过

- 预发布已公开：[preview-macos-arm64-1.0.1-20261018](https://github.com/edgora-ai/agent-browser-studio/releases/tag/preview-macos-arm64-1.0.1-20261018)。状态为 prerelease、非 draft、非 Latest；原稳定 Latest `v0.1.0` 未变，未覆盖旧发行或旧资产。
- 发行 tag 经 GitHub ref 直接读回指向源码提交 `044a3d4d9e1005c8b8ce4d6baf5d4f5571f81c68`。四份脱敏检测文档另以 `2a942aa` 推至同一 preview 分支；真实报告标识、stamp、完整挑战域和内部存储定位未公开。
- 三个远端资产的 `state=uploaded`、大小及服务端 SHA-256 均与本地新校验单一致；发行说明经直接读回与本地版本匹配。只上传下列明确文件，没有上传失败旧 DMG、运行日志、用户配置、Cookie、vault 或激活数据。

| 公开资产 | bytes | SHA-256 |
| --- | ---: | --- |
| `Agent-Browser-Studio-1.0.1-preview-20261018-mac-arm64.dmg` | 415,839,685 | `c42c5eb74baec3bc80801e057e006373b0c4bdeb82d1b7acd4dac537acf11333` |
| `Agent-Browser-Studio-1.0.1-local-auto-20261018-mac-arm64.zip` | 414,035,052 | `e06f5e7c5602e6c693ae906000a2d49eb8afacee097f749e6648721db238c70d` |
| `SHA256SUMS` | 251 | `58c9cc38d1303c2e36f136e7918cb543091d3b62218e79a920d903b1ad8d811e` |

- 对上述三个**公开下载 URL** 分别执行匿名 HTTPS 完整流式下载，不传 GitHub 认证、不关闭 TLS 校验；均返回 **HTTP 200 / curl exit 0**，完整字节数和 SHA-256 与上表一致。不是仅 HEAD、API 元数据、部分 Range 或退出码验证；下载二进制未再落盘堆积。
- 代码和文档已提交、推送，但保留其它来源未确认的未跟踪内容，不纳入本轮提交。worktree 最终清点仍仅当前主工作区，无额外或 stale 注册工作树，删除数量为 0，未强删或删除分支。
- **这一节只关闭本次代码提交和预览安装包上传／回读流程**。原始 Ping0 失败、严格 no-mock、Worker／DST、数据操作归属和逻辑 Cookie 状态未升级为通过；未公证，也未为上传再次退出或重启正常用户应用。
