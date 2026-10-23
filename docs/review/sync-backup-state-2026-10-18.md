# 同步、备份与显示状态一致性核验（2026-10-18）

## 状态与范围

本轮针对“推送成功后仍显示本地有改动”，同时核验数据落盘、上传/下载、原件保护与跨模块显示。**三轮修复、最终真实隔离应用整链验收、默认完整套件及九组相关深 E2E 均已通过。** 下文按时间保留失败、修复与复验过程，最终结论以“最终验收结果”一节为准；隔离验证不等于真实云端、默认 vault 或现有用户数据验收。

源码基线：`release/preview-macos-arm64-20261017`，`62e568920c5b3cef7177c94eb0194b92eb16bd79`。改动尚未提交、打包发行或安装。本轮没有恢复旧回收站、写入真实 S3，或退出当前用户工作实例。

## 第一轮：先保护原件与备份

- 扩展提交分别跟踪旧资源备份、新资源发布、配置提交；补偿只清理本次拥有的新资源。补偿失败保留唯一旧副本和恢复回执；提交后清理错误不伪装成回滚。
- LocalStorage 在目标同卷准备、验证和发布，验证 TAR checksum/结束块/路径/重复项及 CURRENT→MANIFEST 引用。保留旧数据库副本，结构校验不冒充数据库语义验收。
- 下载先准备本次所选 Cookie、Preferences、LocalStorage、扩展包，再修改正式数据。失败返回真实 applied/queued/skipped/failed/unknown 和提交事实，不假称跨资源全回滚。
- ZIP 采用目标同目录独占 staging、短读写检查、CRC/长度与源变化检查、fsync/关闭/有界读回后发布。默认不覆盖旧目标；显式替换也不先删除原备份。
- profile 移动、删除、回收与清除使用同一恢复锁，异步窗口内不提前释放。

主会话第一轮组合门禁：11 个测试文件，274 项通过，0 失败、0 跳过；类型和差异检查通过。

## 第二轮：实际上传快照与统一基线

- 两种 profile 查询入口共用确定性 portable 投影与 Preferences 原始字节证据；不再分别按更新时间、不同字段投影或随机/时间相关导入函数计算同步状态。
- V1 baseline 绑定目标、发布 snapshotId、内容 hash、Preferences presence/digest/bytes 与时间。旧标记、目标改变、读取失败为 unknown；getter 不写入或自动升级证据。
- push 冻结目标、配置、实际附件与包。主对象读回确认后，只把真正上传的 baseline 局部写入仍存在的 ID；上传期间的编辑保留并显示 dirty，新增不假标上传，删除不复活。
- 34 个 portable 字段往返；同 ID 本机 fonts 路径保留。旧快照未提供可选字段不代表明确清空。本机路径、基础设施密钥和账号密码字段不上传。
- 必需扩展包使用内容寻址键，先上传并按字节读回，再发布主对象。legacy unpacked 扩展的本地修复仅在发布后、源未变化时提交。
- Cookie available([]) 与 unavailable 分离；后者保留旧副本必须有明确警告。Cookie 类型不被静默强转；上传端提前执行接收端单项压缩/展开与总数预算。
- Preferences 总量、LocalStorage 总量按最终 captured/preserved 内容递减预算。未构造 50/500 MiB 的实大夹具；这两项只完成了代码路径对齐，不据此声明压力验收通过。
- 兼容 sidecar 恢复 native extension inventory，并执行有界字节读回；主提交后的附件失败/丢响应/取消保留 committed 事实。旧主对象不可读时拒绝覆盖，force 只绕过签出锁，不绕过格式验证。
- Compare 包含 Preferences-only 差异，拒绝自相矛盾或错 snapshotId 的证据，并列出未比较的 live Cookie、数据库和完整 profile 文件范围。

主会话第二轮最终组合门禁：20 个测试文件，595 项通过，0 失败、0 跳过；`tsc --noEmit --incremental false`、`git diff --check` 通过。

新增实际反例包括：推送后假 dirty、上传中编辑/新增/删除、Preferences-only 比较漏项、无效基线、损坏旧主对象、空 Cookie 复活旧云数据、保留与新 Cookie 总数超限、可上传却无法下载的压缩包、sidecar HTTP 200 但字节错误、兼容 inventory 漏写、最后一个附件取消假成功。新格式完整 push→fresh pull→磁盘/reload/两个查询入口覆盖 Chromium/Firefox 元数据；这不等于已验 Firefox DOM-storage 数据库恢复。

## 第三轮：操作、显示与调用方接线

- 服务层共享 push/pull owner，IPC、REST、automation 共用；冲突返回 SYNC_BUSY，不暗中排队。status 提供 active 阶段与 last 终态，事件只发 operationId/generation/scopes/结果事实，不发配置正文或凭据。
- comparisonToken 绑定用户所见本地内容、远端内容和目标；发生变化时，在 live 数据修改前要求重新比较。它不是跨设备 CAS。
- 设置在局部事务验证、落盘后才发布；验证失败不改变 live consent/config。严格布尔/字符串类型检查避免 `"false"` 等静默变义。
- Cookie 运行态请求取消/超时不代表写入停止；恢复锁与共享 owner 等待实际请求 settle，已发生或未知的副作用保持 partial/unknown。
- automation 只有在失败且 localCommit/remoteCommit 均明确为 none 时才自动重试；partial、unknown、recovery-required 和无类型运输错误不自动重放。
- profile unknown、旧 marker、dirty、scope/reason 分开显示；列表、编辑、版本、角色请求按世代失效。保留搜索、选择与未保存表单，基线改变只提醒、不自动覆盖。
- 归档 overwrite 经调用方明确传递；选目录不代表批量覆盖许可。取消、零产出、全 skipped、partial、warnings 不再假绿；15 秒只作软提示，busy/dedupe 保留到真实 settle，普通调用的超时策略不变。

目前的模块证据（有重叠，不相加为总量）：

| 核验 | 实际结果 | 证明边界 |
|---|---|---|
| 主会话后端/安全重试组合，22 文件 | 667/667，0 失败/跳过 | 隔离真实配置与磁盘；运输由 fixture 控制 |
| 主会话最终 operation-state | 17/17 | owner、终态、陈旧决策、设置/权限及未 settle 取消 |
| 原始 preload/注册 IPC/REST callback 适配专项 | 原 46/46；补 REST detail 后 56/56 | 原始薄适配代码；受控 helper，不冒充真实 socket/磁盘分类 |
| profile/accounts renderer 专项交回 | 新增 41/41；必要回归 422/422 | whole-module 合成 DOM/异步请求，不是真实窗口 |
| Sync/Proxies/Extensions 与有效翻译 | 2 文件 61/61；补静态 scope 文案后相关 120/120 | 原始模块的请求世代、失效与有限 DOM；3 个文案 RED 已转绿 |
| 归档调用方专项交回 | 新增 41；5 文件 176/176 | 原始调用方、真实 ZIP 故障/CRC 读回及受控 dialog |
| account-store 旧夹具整合 | 59/59；相关 122/122 | 加载真实新事件/team 依赖，保留实际磁盘/引用/检索验证 |

### 真实应用与全面回归的追加发现

- 完整快速套件首跑：202 文件，5285 通过、11 失败、1 跳过；其中真实 Electron core journey 17/17 通过，已实际查看 Sync 截图。Windows 原生默认发现测试在 macOS 上按平台跳过。11 项失败分别是旧夹具未加载新增事件、翻译 own-key 数量、预先占用 ZIP 目标，以及源码字符串断言；仍逐项修复/复验，不把未核实的失败归为旧问题。
- 首次真实 acceptance 在原始 preload/UI Push、loopback S3 主对象/扩展包精确读回、认证 401/401/200、并发 push/pull 409 与 active publishing 后，发现 **REST 按 ID 查询缺少 syncStatus/scope/reason**，而 IPC/REST 列表正常。已将该分支接入同一 `readProfileSyncState`，并新增 10 项薄适配回归。首次失败后的 Cookie/LevelDB/WAL 链未执行，不能算通过。
- 实际截图同时暴露：未配置/禁用时静态支持范围仍写“已同步/Synced”。已用中英有效词典与 HTML fallback 的 3 个 RED 复现，改为支持数据、采集限制与操作结果说明；不宣称书签或整个目录已完成备份。
- REST/detail 与 scope 文案修复候选已重新构建，source 在构建期间保持不变，正式发行者公钥保持不变。该候选 source SHA-256 为 `525ba1167fdc00353e098768a16dad9c747de69d2cc2b901433caa8821eca34e`，不是后续改动的最终哈希。
- 旧测试整合后完整非 GUI 套件：201 文件，5299 通过、0 失败、1 个 Windows 平台跳过；这不代替最终默认套件与真实恢复语义验收。GPU 两个旧字符串断言已在原 HEAD 的完整源码只读回放中复现，才按测试漂移处理。
- 继续真实验收后发现 **Chromium 152 默认使用 SQLite `Default/LocalStorage` 与 `LocalStorage-wal`**，而现有同步仅识别 `Local Storage/leveldb`。实际 Cookie/LocalStorage 页面业务值可读，SQLite 主库/WAL 文件及 header 已观察到；缺少旧路径不是 stop 丢数据的证据。正在补齐 SQLite/WAL 采集与恢复，不能通过强制旧格式、伪造 CURRENT 或忽略数据来通过。
- 真实夹具的 afterAll 还曾使用仅能在 test 内调用的 `expect.poll`，原 receipt 如实保留 cleanup-failed。已改普通有界轮询，另行核对 owned executable 为 0 后清理；不把后续清理伪写成原运行成功。

### SQLite/WAL 与工具入口的闭合进展

- 已用真实停止后的 Chromium 152 SQLite 直接查询业务 key/value、`integrity_check=ok` 证明源数据存在；旧候选推送仍返回 LocalStorage `absent`，这是实际遗漏，不是 stop 丢数据的归因。
- SQLite 主库/可选 WAL 按组采集并做二次 stat/hash 核对；组上限 64 MiB，页/帧、schema、SQL 总量、Worker 堆与 5 秒校验期限均有界。只在 owned scratch 上 read-only 打开，固定查询、禁扩展/mmap，schema 表达式不作为 SQL 执行。Worker V8 限制不是 SQLite native heap 的 OS 硬上限。取消/期限后等实际 Worker exit 才清理和释放。
- SQLite 同卷 old/new transaction、独占 pending/published/recovery 回执与逐项补偿；失败不删除唯一原件，补偿不完整时保留 live/backup 两处材料并阻止再次覆盖。成功也保留旧库，单测完整性检查不是删除旧库的许可。拒绝孤立 WAL、坏 checksum/salt、非空 rollback journal、危险路径、混合布局和跨格式覆盖；不承诺跨版本迁移或任意外来 WAL 的业务来源真实性。
- 该专项新增 62/62；与既有 8 文件组合 204/204。主会话已读完捕获/校验与发布/补偿源码；这些仍不等于真实 Chromium 恢复验收。
- MCP list/info、本地 agent list 补齐同步投影；两个 SDK 保留 HTTP status 和完整有界结构化错误正文，超限显式标记，不用截断 JSON 冒充完整回执。新增 17 项与必要旧回归两组共 230/230；strict account-store VM 真实加载 SQLite/ZIP 新依赖，非 SQLite 账户恢复路径仍禁止启动 Worker。
- 最新源码构建实际 exit 0，构建期间 source 未变，正式发行公钥保持。该候选 source SHA-256：`60ac71f0b2d2af41c7385e7af0c81a168313d918d7f2d034d49b4294fe87ae97`。未安装、签名或发布。
- 本次整合首次命令误写了排除路径，实际包含 core GUI：205 文件 5386 通过、15 失败、1 跳过。失败为 core journey 14 项（多数 5 秒限时）及 Firefox identity cache 1 项（11.36 秒），不把它们自动认定为历史问题。正确排除 GUI 并将并发限制为 4 后，最新非 GUI 204 文件 **5384 通过、0 失败、1 个 Windows 平台跳过**；原失败的 Firefox cache 也包含在通过结果中。最新构建的 core GUI 和默认完整套件仍待复核。
- 新候选真实窗口已核对源端 clean badge、advisory backup hint、Compare 范围、MCP socket list/info 与 JS/Python SDK list/detail 状态一致；双语支持范围和 custody 文案通过原始 locale setter 验证。新 Python 验收 helper 最初用同步子进程，导致 stale 检查所需的同进程 S3 GET 被阻塞；原失败回执保留，已改异步 native 子进程，不降低产品断言。
- 异步驱动重跑已取得真实 Electron **Node 24.16.0** 的 SQLite 采集通过：停止后源库业务值可查、integrity ok，Push 从原 `absent` 变为 `captured`；JS/Python SDK 的 busy/stale 均保留结构化 409。另一个无刻意 settle 等待的分支“写新 key → 生产 stop → 同 profile 重开”读回确切值，已经通过。
- 该重跑随后在归档菜单点击失败：旧公共 helper 先赋 `details.open`，再由 Playwright 滚动寻找按钮；实际日志包括 stop 后卡片被替换、菜单关闭及元素 detached。原失败截图/回执保留，不能把后续 WAL ZIP 或接收端当作通过。当前验收改用先滚动可见 trigger、再真实点击 summary 和按钮，仅对 detached 前端定位进行有界重试；不强点、不直接调用导出绕过 UI，也未移除生产的菜单关闭保护。
- 真实长对话框超过 15.6 秒、busy 和去重断言随后已到达；晚完成第一次选择了 app allowed roots 外的任务根路径，生产路径保护正确拒绝并显示红色错误，原运行仍记失败。验收已改为真实 appData 下独占备份子目录，未放宽或绕过 allowlist；完整 ZIP 与接收端链仍在重跑。

### 当前真实整链与最后交叉边界

- `60ac71…` 候选已经跑到真实 A→B 全部业务断言和 owned cleanup：接收端 SQLite main/WAL 字节组与发布快照相同，直接只读分析 integrity ok，浏览器读取 `acceptance_session=synthetic-cookie-business-value` 与 `acceptance_order=synthetic-localStorage-business-value`；Cookie queue 在真实启动后消费。MCP 与两种 SDK 三次 list/detail 读回状态一致，viewer REST/SDK 写入 403 且本地/远端未改变。
- 真 ZIP 导出约 10 MiB，主库/WAL 逐字节一致；仅在 WAL 的订单记录导入新 ID 后 `integrity_check=ok`，按确切 payload 检索读回。长对话框晚完成成功 toast 仅一次，取消不产生额外 ZIP。正常源保留时的 `(2)` 名称碰撞与 `ProfileInfo` 不包含 note 的既有契约已在测试中纠正；note 仍由 ZIP 元数据、真实 REST detail、磁盘/reload 精确核对，未降低数据保真断言。
- 该次 JSON assertion report 为 1/1 passed、receipt 为 passed/completed、cleanup 无错误，但 Vitest 进程 exit 1；未将该次计为绿色门禁。保持相同候选与断言，用 default+JSON 双 reporter 原样复跑后 **1/1 passed、进程 exit 0、cleanup 无错误**（约 50 秒），没有再报告非断言错误；旧次只有 JSON reporter、未保留原因，**不能宣称已经定位旧次异常退出的根因**，原报告与退出码保留。
- 同一候选单独复验 core GUI journey：**17/17、exit 0**，截图已查看；不再沿用首轮高并发限时失败作为当前结论。仍需归档兼容边界修复后的最终完整默认套件和相关深 E2E。
- 最后交叉检查新增真实 RED：成功同步后保留的 `.sqlite-localstorage-backup-*` 被 ZIP 带入新 ID，原 ID/绝对路径绑定回执令随后真实 sync push 返回 `LOCAL_STORAGE_RECOVERY_REQUIRED`。源树、旧 WAL-only 行与 ZIP 均未被改变。已单列修复：未解决/损坏材料 fail closed；已完成历史材料保留到明确警告的 inert 归档子树，不将旧设备事务当新配置提交证明，也不能删除唯一救援字节。该边界专项和最终重建/真实复验仍在进行。

### 末轮归档修复与独立复核

- 归档边界已最小修复并冻结：完成的 SQLite 历史在导入 staging 中移至 `.profile-archive-recovery/<原ID>/Default/<事务名>`；canonical bounded JSON、原 ID/规范 POSIX/Windows 目标、published hash、old 清单与文件 hash、new 空目录和无告警均逐项核对。旧目标路径只作字符串身份验证，不读旧设备路径。legacy 原位保留，外部已记录告警/缺 live/内嵌告警仍拒绝；无法从旧 ZIP 未记录的外部告警中反推状态。
- 新专项及既有同步/ZIP 相关 **11 文件 356/356、exit 0**；主会话已阅读新增产品逻辑。正式公钥保全最终构建 **exit 0**，source 在构建中未变；source SHA-256 为 `749419604575d49dd5d331ffb6d44b4307612551dd917a0fd857a7aef8d611b7`。
- 最终候选的扩展真实验收已取得“源端真实 Pull 产生旧库事务 → 原 IPC ZIP 导出/新 ID 导入 → 原与 inert 六项文件/空目录逐项 hash 相同 → 原 UI Push 三个 profile → 新 ID LocalStorage captured/baseline 落盘 → reload 后 synced”的全部业务断言和截图。没有删旧回执刷绿；原 ZIP、源救援材料和 inert 副本均未变。
- 双 reporter 明确抓到该次全断言通过但 exit 1 的原因：两项未处理 `read ECONNRESET`。已用与原 fixture 完全相同的 native `CONNECT` 拒绝代码，加一个本机测试客户端读取 403 后主动 reset，独立复现相同 Socket 未处理错误和进程 exit 1。该问题在验收夹具而非同步产品里；当前只对**已主动拒绝的 CONNECT socket**统计预期 reset/EPIPE，并在每次验收中强制执行该 native 反例。S3/REST、未知 socket 和全局进程错误不被忽略；其他错误继续失败。最终同候选重跑已经 **1/1 passed、exit 0、约 65 秒、无未处理错误、cleanup 无错误**；native 反例确实触发并计入 `ECONNRESET: 1`，`unexpectedFailures: []`，没有关闭全局错误检测。接收端业务值和重导入后的真实 Push 截图均已实际查看。

## 最终验收结果

最终产品源码 SHA-256：`749419604575d49dd5d331ffb6d44b4307612551dd917a0fd857a7aef8d611b7`。以下门禁使用同一构建；结束时再次核对源码未变、真实验收记录中的 14 个 dist 文件与 2 个 SDK 实现文件的长度和 SHA-256 逐项相同。既有正式发行者公钥保持不变，没有使用测试发行者替换。

| 最终门禁 | 实际结果 |
|---|---|
| 当前源码 `npm run build` | exit 0；构建前后源码相同，正式公钥保全 |
| 默认完整套件，`vitest.config.ts --maxWorkers=2` | 206 文件通过；5415 项通过、0 失败、1 个 Windows 专用项在 macOS 跳过；exit 0，无未处理错误 |
| 默认套件内真实 core GUI journey | 17/17，包含在上一行，不重复计数 |
| F01/F02/F08/F09/J56/J57/J62/J64/J65 深 E2E，串行 | 9 文件、55/55，0 失败、0 跳过；exit 0，无未处理错误 |
| 原件保护、SQLite/ZIP 历史边界专项 | 11 文件、356/356，exit 0；与默认套件有重叠，不相加为总量 |
| 最终扩展真实应用整链 | 1/1，exit 0，约 65 秒；Electron Node 24.16.0，真实受管 Chromium，7 张截图已保留并查看关键阶段 |
| 最终类型与语法 | `tsc --noEmit --incremental false` exit 0；11 个改动 JS/CJS/MJS 文件语法通过；Python SDK compile 通过且未生成 pycache |
| 显示契约及翻译 | main/SDK/renderer 的 4 状态、1 scope、9 reason 一致；两份 i18n 字节相同；本轮 80 键无缺项、占位符差异或影子，不扩称历史 UI 全量审计 |
| 差异和清理 | `git diff --check` 通过；最终查到的本任务 Electron/Chromium 残留进程为 0；未退出或终止用户工作实例 |

### 真实数据链，不仅检查返回值

- 原始 preload IPC、真实窗口 Push/Compare/Pull、受控 loopback 对象存储完整发布与精确读回；原始文件、服务 reload、按 ID 检索、REST 列表/详情、MCP list/info、JS/Python SDK 与 DOM 状态一致。
- 实际受管 Chromium 写 Cookie/LocalStorage，正常停止后按 SQLite main/WAL 组上传；接收端字节组相同，只读分析副本 `integrity_check=ok`。接收端实际浏览器读回 `acceptance_session=synthetic-cookie-business-value` 与 `acceptance_order=synthetic-localStorage-business-value`；启动后 Cookie 队列消费，不把 queued 冒充已经写入浏览器。
- 独立无刻意 settle 分支执行“写新 key → 生产 stop → 同 profile 重开”，读回确切新值。主链首次写入允许测量的 settle，这一独立分支没有插入 flush/settle 等待。
- 真实 ZIP 导入新 ID 后，SQLite 主库及 WAL-only 已提交订单记录通过 `integrity_check`、逐行比对和按业务 payload 检索；portable 元数据、Preferences 与依赖提示保留。原生对话框等待 15.6 秒不假失败，晚完成成功提示仅一次；取消后额外 ZIP 数为 0。
- 最后交叉边界执行“源端真实 Pull 生成 SQLite 救援历史 → ZIP 导出/新 ID 导入 → 原与 inert 的六项文件/空目录逐项 hash 比对 → 原 UI 再 Push 三个 profile”。新 ID LocalStorage captured、baseline 落盘、reload 后 synced；源救援历史、inert 副本及输入 ZIP 均未改变。
- 公开 health 200，REST/MCP 缺/错认证 401、正确认证 200；viewer 真实 REST/两种 SDK 写入 403，且本地与远端未变；busy/stale 409 的结构化结果保留，partial/unknown 不被自动重试或翻译为成功。
- 验收夹具 native 拒绝 CONNECT/reset 反例强制执行，确实计入 `ECONNRESET: 1`，`unexpectedFailures: []`；仅处理主动拒绝 socket 的预期错误，未忽略全局/S3/REST 错误。owned bulky 数据清理成功，仅保留截图及小回执。

### 命令与保留证据

`VALIDATION_ROOT` 指本机存储索引中已登记的 `sync-state-validation-jaolc2oj` 任务根；runner 提供独占 HOME、临时目录、显式既有浏览器、2 GiB 总预算、磁盘保留线和双 reporter。不要脱离隔离 runner 将这些测试指向真实用户数据。真实 acceptance 还要求显式 opt-in 和本任务中新建的空 owned root。

```sh
python3 "$VALIDATION_ROOT/build-current.py"
# buildExit: 0; buildSourcesUnchangedDuringBuild: true
# officialIssuerPublicKeyPreserved: true

python3 "$VALIDATION_ROOT/run-tests.py" frozen-full-suite \
  --config vitest.config.ts --maxWorkers=2 --reporter=default
# 206 files passed; 5415 passed | 1 Windows-only skipped; exit 0

python3 "$VALIDATION_ROOT/run-tests.py" frozen-related-e2e \
  --config vitest.config.e2e.ts --maxWorkers=1 --reporter=default \
  tests/e2e/f01-sync-pull-artifacts.test.ts \
  tests/e2e/f02-sync-credentials.test.ts \
  tests/e2e/f08-profile-archive-metadata.test.ts \
  tests/e2e/f09-profile-trash-consistency.test.ts \
  tests/e2e/j56-sync-diff-preview.test.ts \
  tests/e2e/j57-sync-lock.test.ts \
  tests/e2e/j62-sync-merge-strategy.test.ts \
  tests/e2e/j64-rest-sync-strategy.test.ts \
  tests/e2e/j65-profile-archive.test.ts
# 9 files passed; 55 passed; exit 0

ABS_SYNC_ACCEPTANCE=1 ABS_SYNC_ACCEPTANCE_DIST_READY=1 \
ABS_SYNC_ACCEPTANCE_ROOT="$FRESH_EMPTY_OWNED_ROOT" \
python3 "$VALIDATION_ROOT/run-tests.py" frozen-scoped-socket \
  --config vitest.config.e2e.ts --reporter=default \
  tests/e2e/sync-state-acceptance.test.ts
# 1 passed; exit 0; receipt passed/completed; no unhandled errors

./node_modules/.bin/tsc --noEmit --incremental false
git diff --check
# both exit 0
```

任务根内保留：
- `frozen-full-suite-o2_f6vs5/{summary.json,vitest.json,vitest.log}`：最终默认完整套件，约 217 秒。
- `frozen-related-e2e-dleell55/{summary.json,vitest.json,vitest.log}`：最终九组深 E2E，约 106 秒。
- `archive-sync-final-gates-lndvfmhu/summary.json`：356 项专项门禁。
- `frozen-scoped-socket-wvqpz2qj/{summary.json,vitest.json,vitest.log}`：最终真实扩展整链的退出码与双 reporter。
- `frozen-scoped-socket-root-a3y6_km8/sync-state-Itd93A/receipt.json` 及 7 张 PNG：直接数据库/浏览器业务值、原件和历史树保全、16 项文件身份、权限、取消与清理证据。

**交付状态：代码与用户指南已修改，未 git commit/push，未生成新发行包、安装或发布。当前已安装应用尚未替换为这次修复版。**

## 追加：当前代码覆盖率（2026-10-18 实测）

为回答当前覆盖率，另在同一独占隔离 runner 中执行完整默认套件的 V8 覆盖率采集，未改测试门槛或产品源码。实际 **206 文件、5415 通过、0 失败、1 个 Windows 平台跳过、进程 exit 0、无未处理错误**；覆盖率门槛也通过。测量结束后产品源码 SHA-256 仍为 `749419604575d49dd5d331ffb6d44b4307612551dd917a0fd857a7aef8d611b7`。

| 指标 | 实际覆盖 | 命中 / 总数 | 当前全局门槛 |
|---|---:|---:|---:|
| 行 | 70.35% | 12970 / 18435 | 40% |
| 语句 | 66.98% | 15173 / 22653 | 40% |
| 函数 | 70.76% | 2302 / 3253 | 40% |
| 分支 | 61.80% | 11700 / 18929 | 35% |

统计范围严格来自 `vitest.config.ts`：**136 个 main 文件，即 services 116 个、IPC 20 个**，不是全应用百分比。services 行/分支分别为 74.11% / 64.21%；IPC 为 16.79% / 8.04%。原项目 `coverage/lcov.info` 的时间为 2026-09-20 UTC，不用它代表本轮当前代码；新报告使用独占目录，旧报告未覆盖。

| 本轮关键模块 | 行 | 分支 |
|---|---:|---:|
| `sync-service.ts` | 79.31% | 68.64% |
| `sync/profile-state.ts` | 75.00% | 80.43% |
| `sync/operation-state.ts` | 95.00% | 83.33% |
| `sync/sqlite-local-storage.ts` | 87.23% | 70.96% |
| `profile-archive.ts` | 79.72% | 70.71% |
| `zip-writer.ts` | 74.43% | 64.61% |
| `extension-repository.ts` | 92.45% | 75.57% |
| `ipc/sync.ts` | 83.33% | 82.35% |
| `ipc/profile.ts` | 62.90% | 43.10% |
| `rest-api-server.ts` | 38.79% | 31.54% |
| `mcp-server.ts` | 20.63% | 17.84% |
| `local-agent.ts` | 47.09% | 38.68% |

**已知统计与测试缺口：**
- IPC 整体较弱，`ipc/browser.ts` 在本次报告中行/分支均为 0%；REST、MCP 和 local-agent 也仍有大量分支未命中。当前全局门槛较低，整体过门槛不代表每个入口都充分覆盖；不能将低值全部归因于统计方式而忽略真实单测缺口。
- renderer 和 JS/Python SDK 不在当前 coverage include 中；其行为测试通过不能换算为本报告百分比。部分 renderer/JS SDK 测试用 VM/转译代码，Python SDK 在单独 Python 进程中执行；未单独建立这几部分的完整覆盖率统计。
- 真实 GUI E2E 在独立 Electron/Chromium 进程中执行，现有启动/关闭链没有启用、回收和合并这些进程的 V8 coverage。因此真实 E2E 是单独的行为证据，不会自动补进主进程覆盖率；IPC 的某路径报告为 0% 也不等于它从未被真实 E2E 操作过。
- SQLite 校验器包含 eval Worker 字符串；外层模块命中不能代替其字符串内部逐行覆盖证明。该内部逻辑另有故障/安全边界与真实数据库结果测试，但当前百分比不作同等范围承诺。

实际命令通过 runner 增加 `--coverage --coverage.reportOnFailure --coverage.reportsDirectory="$OWNED_COVERAGE_REPORT"` 及 text/json-summary/lcov/html reporters，保留默认 include 和 thresholds；没有修改产品代码或放宽测试限时。保留证据位于已登记任务根：
- `current-full-coverage-li353icr/{summary.json,vitest.json,vitest.log}`：完整用例结果、退出码及覆盖率文本。
- `current-coverage-report-mhekvhij/coverage-summary.json`：总量和逐文件精确统计。
- `current-coverage-report-mhekvhij/index.html`、`lcov.info`：可下钻的覆盖/未覆盖行及分支报告。

结论：本轮同步、存储与归档核心已有较多测试，但不是全覆盖；后续优先补接口层负例/权限/取消/部分提交和 IPC 的直接测试，并补齐 renderer、SDK 与真实子进程覆盖率采集，而不是仅用用例数量证明质量。

## 不承诺的范围

不承诺真实 S3 的部署行为、现有用户会话/默认 vault、跨设备加密 Cookie 可用性、Firefox DOM-storage 全库恢复、跨资源/跨设备全局原子性、断电恢复或全应用 agent-store 备份。profile ZIP 和同步基线不是这些保证的替代品。Docker 部署配置未改，容器运行/重建不作为本轮 Electron 验收证据。
