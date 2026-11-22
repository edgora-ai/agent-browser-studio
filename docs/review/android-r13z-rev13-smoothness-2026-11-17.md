# Android r13z rev13 — 定向流畅度优化与验证记录

日期：2026-11-17（Asia/Shanghai）。基线 Git HEAD：`d4f744d1a1c36c0350dce423d45c7ac9e3bbbbe4`。

## 交付状态

- 用户要求：在保留浏览记录、标签、代理/DIRECT、隔离和既有修复的条件下“优化一波”。
- 状态：**实现、主机回归、最终七源独立审阅、Java-only 编译及正式签名候选包的交付核验完成。** 原 wrapper post 失败与 analysis 历史环境证据缺口保留，不冒充设备或 fresh-server 验收。
- rev13 尚未安装；不清数据、不卸载、不操作用户日常标签、不提交或推送。
- **设备三标签滚动/切换、真实渲染/视觉、帧耗时与 Chrome 对比：NOT_RUN。** 本文不将源码风险移除或主机断言当成已测得的 FPS/延迟收益。

## 已实施

### 1. 历史读写不再阻塞 Android UI 线程

`BrowserHistoryStore` 的目录获取、文件读取、AtomicFile 恢复、反序列化、序列化、写入、文件同步和提交字节回读均在后台优先级的共享串行 worker 上执行。构造只排队加载。UI 保留受最大 200 个站点约束的模型和必要的内存操作；不是“主线程零工作”的承诺。

- `BrowserHistory.copy()` 为 worker 提供独占、深拷贝快照；后续 UI 修改不能改写在途保存内容。
- 通过 revision 和合并请求保持有序；2 秒防抖继续保留，在途写入后的新请求最多接续一个较新快照。
- 初始化前的访问、标题、删除、清空以原始顺序重放；访问时间在事件发生时捕获，不改写为加载结束时间。
- 标题在捕获前按既有规则截断；只有无中间访问/删除/清空的连续同站点标题更新可安全合并。
- 遇到未知 I/O 基线错误，保留编辑 journal；重读并合并成功前不以 pending-only 模型覆盖未知旧历史。明确的用户清空是有意重置，不等同于静默错误回退。
- `flush(callback)` 是非阻塞完成屏障：只有目标或较新快照真实写入、文件同步、AtomicFile 提交及完整字节回读成功后才回调 true。异常、静默提交失败与回读失败均回调 false，脏编辑保留供后续重试。**排队不等于保存成功。**
- 未增加主线程磁盘兜底、等待锁、轮询重试、目录 fsync 或断电持久性承诺。损坏/超限文件的既有空模型策略保留；不能宣称恢复了不可解析的历史内容。

### 2. 生命周期与恢复状态

Store 属于不可变 launch/application 的 `NativeBrowserRuntime`，不是每次 Activity 重建各开一个读写器。UI 注册可移除的持久加载/恢复监听；publication 与 registration 双门禁拒绝旧回调，close 时移除，不因普通 pause 丢失恢复通知。

NTP/历史面板区分“正在加载”“暂时无法读取”和真正空记录；两处在有部分 pending 记录时仍显示加载/失败状态；NTP 状态文本位于已有站点前，不能由新产生的少量记录掩盖未知旧基线。数据到达后刷新可见内容、保留历史查询，不抢地址栏焦点。显式重新打开失败的历史/NTP可发起后台重试，包括 clean 的超限/读取时增长失败；一次失败完成当前 fence 并停止，不形成 onLoaded→requestWrite 的重读自旋。

退出先 quiesce UI，再独立尝试历史 fence 与 native storage flush；双完成屏障等两方答复。历史失败或 quiesce 异常不能继承 native 成功。原 native outcome 保留；无 native 的 `NOT_ATTEMPTED` 也不能提前跳过历史保存。现有 5 秒超时、generation 检查、一次性 teardown 和下一主循环通知保持。

### 3. 减少预览重复工作，不降低预览质量

- 每个 dirty batch 最多排一个 next-frame 捕获任务；反复请求不再 remove/repost 同一个帧回调。
- PixelCopy 在途的新增 dirty 会在释放后接续一次；blocked/not-ready 不按帧轮询，真实生命周期/布局/paint 事件重新驱动。
- 捕获入口和每个取消点清理 posted gate；保留有界失败重试。
- 普通总览 dismiss/Back 不额外截图；每次真正重新打开仍请求同 URL 的新像素，保留滚动和动态页面的新鲜度。
- Activity/View 重复 show 幂等；相同结构中仅 active/title/URL/preview 或已回收绑定状态变化的卡片重新绑定。
- 保留 Shell/WebContents/URL/resumed/epoch 所有权验证（包括 A→B→A）、NTP 实际 draw 与 renderer PixelCopy 分支、已发布 bitmap 所有权和独立的结果回调 handler。未通过关闭预览、降低刷新率或放松隔离换速度。

## 源码与冻结记录

七个既有 Java 文件：`BrowserHistory.java`、`BrowserHistoryStore.java`、`NativeBrowserRuntime.java`、`NativeBrowserActivity.java`、`NewTabPage.java`、`HistoryPanel.java`、`TabSwitcherView.java`。

最终冻结记录；与独立审阅所核 final-3 相比，仅 Store host 新增 callback 内 update→flush→clear→flush 的异步重入测试，七个生产源未再改变：

`.tmp-apk/proxy-fix-work/v13z-rev13-tests/final-4.FhenXq/source-freeze.json`

该轮测试前/后 36 项输入 SHA-256 一致。保留原工作区的既有 stager、rev12 input patch、测试和其他未提交内容；只对旧 runtime 早返回源码断言做双屏障适配，未改安全保护语义。


| 最终生产文件 | SHA-256 |
| --- | --- |
| `BrowserHistory.java` | `abc97b8c2d4c28a715406db5398fb1eb6f04ac6b09241db5d927e51c5355fe42` |
| `BrowserHistoryStore.java` | `98a3ff49cb0caa663668fa72cfbf68284678b78842a6870f9438ef2db18f203f` |
| `NativeBrowserRuntime.java` | `31054c060895598b7df4959462a4c0a850035c374f8cf180b0e68f933e286995` |
| `NativeBrowserActivity.java` | `b082cca916d839f9ee26a32ef27118d3464486885d2516b432dd1e45cdcaa741` |
| `NewTabPage.java` | `06a587b68b3bb91c969c770cde9f36ea1445f3701fafd42778885f3ffa0dbcae` |
| `HistoryPanel.java` | `37cc2ef44a22e3bff5a2d8d61dc38c2c9165fcf389be72d27caed4a38215bfc3` |
| `TabSwitcherView.java` | `dcd104e8ee11376fea9539a1bc17dd7c3b517323d719d1d81e0addbd1bada070` |

## 回归证据

JDK17 编译统一 `--release 17 -Xlint:all -Werror`。以下均为源码/实际生产 Java 搭配受控主机 fake 的证据，不是 Android framework/runtime 接受证据。

| 范围 | 该轮结果 |
| --- | --- |
| 历史纯模型 | 274 checks，0 failures |
| UI 源码契约 | 706 checks，0 failures |
| 指纹种子存储 host | 13 checks，0 failures |
| 实际 runtime/Activity 提取 lifecycle host | 1120 checks，0 failures |
| 焦点 host | 437 checks + 17 source contracts，0 failures |
| 调色 host | 47 checks，0 failures |
| 实际 TabSwitcherView host | 402 checks；6 个行为变异定向拒绝 |
| 系统栏 host | 1976 checks，通过 |
| 字体所有权/reflow host | 1011 checks，通过 |
| 预览/恢复 host | 512 checks；20 个行为变异定向拒绝 |
| 网络 freeze/verify Java host | 760 checks，通过 |
| 实际 Store/model 异步 I/O host | 22 cases / 978 checks，通过；含 clean size-cap 重读、不自旋、callback 内修改/清空再 flush 的异步一次性链 |
| NTP constrained-layout host | 108 cases / 540 states + 24 empty cases / 120 states；266015 assertions；17 个变异拒绝（含 partial rows 掩盖状态的反例） |
| 现有注册 state root 下 source-stage suite | 18 tests，OK |

最终全量日志：`.tmp-apk/proxy-fix-work/v13z-rev13-tests/final-4.FhenXq/`。NTP 与18项 stage 复跑日志保留在 `final-3.FDrWLY/`；相关生产/测试输入与最终 freeze 一致。NTP 独立保留目录：`.tmp-apk/proxy-fix-work/v13j-font-tests/tests.080fx5/`。

首次全量发现 Focus fake 缺少新提取字段，已补字段而非删除生产方法；source-stage 原先断言无 native 立即 finish，已改为 outcome 记录并等待双屏障。两项旧测试假设适配后重跑通过，没有绕过 runner 或 fake state marker。

## 独立审阅与构建

- 独立只读审阅：task-27 completed；逐项独立 SHA-256 与 final-3 receipt 一致，未发现可确认的 P0/P1。复核 worker/snapshot/unknown baseline、revision/fence/失败重试、listener 取消、双完成退出/5 秒超时、native callback UI-thread 上游契约、预览 gate/epoch/bitmap、卡片跳绑。两个 P2 已修复并定向回归：部分记录掩盖失败状态、clean size-cap 错误无法显式重读。
- rev12 native input guard ASAN+UBSAN 方法级回归：`.tmp-apk/proxy-fix-work/v13z-rev12-host-test/run-m5nps7l3/result.json`；baseline 6 PASS / 5 expected FAIL、patched 11 PASS，`CONTROL_FLOW_ONLY_EXPECTED_RED_GREEN`。不构成 Chromium/手势/设备证明。
- 候选构建：task-28，源码/测试/审阅门禁全部通过后才允许 allowlist staging。
- 基于 rev12 的 103 项 effective inputs；只允许上述七个既有 Java 和 metadata manifest 变化，GNI、native、DNS/security/input guard 保持冻结。
- 首轮预检在 staging 前因工具脚本错误地固定 Ninja log v5 而拒绝；稳定 FD 诊断确认实机格式为 v6、bundled Ninja 1.12.1。旧脚本和失败 receipt 原样保留；`attempt2/` 只隔离输出路径/日志名，并将 header 严格改为实测 v6。Lead 独立比对最小差异、全部 pins 和 36 项 freeze，重跑原 11 项守卫及 5 项 v6 反例全部通过，才授权第二次。
- `attempt2/build-rev13.log` 的实际 Java-only 增量编译返回 0：10 个 ACTION，含 product javac、DEX、APK create、wrapper deps、product errorprone 与 product deps；无 CXX/CC/SOLINK/GN。两个 product analysis ACTION 各一次。idle wait 也返回 0。
- 但原 wrapper 在 post 的 analysis-header freshness 断言返回 1：`buildserver.log.0` 是旧日志，所有 7 个同名 slot 均未更新，不能以旧日志证明本次检查完成。**实际编译成功不等于原 wrapper 全流程通过**；失败现场保留，没有再触发编译。后续按非 TTY/PIPE 下同步分析的实际实现、两 stamp/Ninja rows 与 ACTION 记录准备独立只读完成校验，不伪写 server 日志 fresh PASS。
- 独立只读完成器在新的明确 Lead GO 后单次执行并返回 0：`attempt2/completion-readonly/complete_readonly_rev13.py` SHA `0cd8ff901e2e6eacd3dee82a462cf146778121336abe2354e323fc15f30d4041`；plan SHA `48293e3e4588004cbb9156eb78372c5410f9b05ee07cb3d10596f12b313c2e79`。Lead 独立重跑 53 项本地反例/契约测试通过（子进程与网络禁止），复核 23 份原失败证据 pins 和 36 项 source freeze。仅 remote final / 稳定 FD APK download，未触发 staging、Ninja、analysis、idle 或设备动作。
- 下载前后完整 post inventory 相等：103 项输入、远端 HEAD、graph、6 个 native 文件及全部 6 个 Ninja rows 保持；3 个 Java JAR/DEX/APK 的 SHA、mtime 和 rows 均新；两个 analysis stamp/rows、10 个编译/派发实现源码 FD 身份保持。原失败 receipt/旧脚本不修改，原 7 个失败下游输出路径仍不存在；新结果单独存放。
- **analysis 证据限制不降格成假 PASS**：实际初始 `AUTONINJA_STDOUT_NAME` / `AUTONINJA_BUILD_ID` / `INVOKED_BY_BUILD_SERVER` 未采样，原 CLEAN 不含 `env -i`，也未明确 unset 这三项。真实 PIPE + 无预设有效 stdout 的源码分支可复现为同步执行，但不能冒称历史环境直接观测。异步分支会派发后立即 touch stamp，因此新 stamp 不能独立证明后台分析完成。保留 ACTION/rc0、stamp/rows、旧日志未更新与实际源码的相互印证，`freshServerAnalysisPass=false`、`unqualifiedHistoricalSynchronousExecutionClaim=false`；旧日志标记 `NOT_FRESH_NOT_USED`。Lead 接受这一**带明确证据限制的候选包**，不将它改记成原 wrapper 全通过或后台分析已直接观测完成。


## 已签名候选包与独立交付检查

交付目录：`.tmp-apk/proxy-fix-work/v13z-rev13-smoothness/attempt2/completion-readonly/`。

| 项目 | 实际结果 |
|---|---|
| 文件 | `ABS-Browser-v1.0.0-r13z-rev13-arm64-release-candidate.apk` |
| 包名 / 版本 / ABI | `com.ahoo.abs.browser` / `1.0.0 (10000)` / ARM64 |
| 大小 | `372374043` bytes |
| APK SHA-256 | `cf6f7955903b340ba9b284b6706639f931dcdcf07c88fb17933c29624bb2d61a` |
| 签名证书 SHA-256 | `0f186dd70f80892e04443b7105842eef2ac9e641e9ecefa15015158317f1402f`（与已装 rev12 相同） |
| Manifest | 与 rev12 字节一致；独立固定 SHA `9802851532837e850d661f0085386eeeec8af633b6cd69dea5ad123ad0062262`；nondebuggable |
| 签名 | 专用 release helper 签名，再独立 verify，均返回 0；APK v3 / 单签名者 / RSA4096 |
| 原 unsigned | SHA `43112c9ddf1ac8dfe63c6a8f35da52e185c4219cf4b31488d2d04a3f0f34f824`，签名输入未修改 |

Lead 的独立 `verify_delivery.py` SHA `2e9e0e387e9205d93c51a06357dde57b7edd455b43ca311328429c4c02a42abe` 返回 `REV13_SIGNED_CANDIDATE_PACKAGING_VERIFIED`：

- 最终重新核对 36 个冻结输入。unsigned/signed 的非签名 ZIP payload 全部一致，无重复 entry。
- 3 份 DEX 的 header/file size/endian、Adler32、SHA-1、string/type/class_def 表均校验；共有 **27923 个真实 class_def**，七个产品类和 Store 的 `$FlushCallback` / `$LoadListener` 共九项定义全部存在，而非仅以字符串匹配充数。
- 三个 native SO 各自为 ELF、ZIP_STORED、4096 和 16384 对齐；unsigned/signed 的 bytes/SHA-256 相同。除比对构建 receipt 外，还以独立固定的 rev12 三组 bytes/SHA 校验，不要求签名前后文件 offset 假性相同。
- 主 native `libagent_browser_product.so` 保持 `315101312` bytes / SHA `6687cb2820650e5a9c22b312914a0bab1fc55c94780fe73ddff15bf8dd357c0a`。本轮没有原生内核调参或替换。
- `installed=false`；runtime / performance / visual acceptance 均为 `NOT_RUN`。签名和包体检查不改变上节 analysis 历史环境证据限制。

交付 receipts 的 SHA-256：

| 文件（相对交付目录） | SHA-256 |
|---|---|
| `unsigned-candidate-completion-rev13.json` | `9857154f2b640fd533ccf2021fb37027e66d77e490b49c72f50b4df41059cd46` |
| `signing-rev13.json` | `3f77e6e47c4cf8670118ea42428eb98d09450be2d2bcd29e14f147b2d71b78ae` |
| `signature-independent-rev13.json` | `c7407175935debe82ddc7edc7fd1645ed88c9ef233d75291c874114003e40df4` |
| `signed-delivery-verification-rev13.json` | `2c643cc43d831715f13c3838da3608f4de5e27bf746edccedb8af25fc82213ac` |

## 未验证与残余限制

1. 没有 rev13 实机帧时间、真实 PixelCopy/滚动截图、三标签交互或 Android 文本渲染/无障碍证据；主机 layout 数量不能替代人工视觉或设备验收。
2. 历史文件长期持续不可读取时，为不丢失未知旧基线上的访问/删除意图，任意事件数的 journal 及最终 replay 时间仍可能增长；这里只限制单条标题并安全合并连续标题。没有通过静默丢编辑设置假硬上限。
3. 无强杀、崩溃注入或断电试验。成功 fence 之前不承诺进程异常终止后的保存；文件同步+回读不等于目录断电持久性证明。
4. Chromium 引擎、Surface/container 切换链和应用层预览仍存在；本轮并未使自定义浏览器等同原生 Chrome，也不能从消除两个应用层风险推导整体帧率。
5. 保留 rev12 input lifecycle guard；其方法级主机控制流及同 native ELF 不构成真实手势输送或原三标签问题已解决的证据。
