# Android r13z rev14 性能调优与验收（2026-11-17）

状态：**未验收，不交付 rev14-fix1；没有已证明的整体提速。** 源码、独立完整主机回归、Java-only 构建、签名及独立包体验证已完成，但首候选 paired2 短滑失败；fix1 的 paired3 因设备身份检查超时中断，functional4 因 userdata 磁盘不足未启动功能测试。functional5 第3个200px向下短滑快速重开失败：`Active card not visibly reachable: 0`。本轮失败运行已经有限关闭，真实终态及独立闭合审查均已完成；缺失的后续guest阶段仍为 NOT_RUN，不因闭合而通过。最后保存的失败界面树是原生浏览器页，不是已观察到的“总览内活动卡片滑出屏幕”；根因及惯性关系仍 NOT_PROVEN。本文保留失败链、缺测和相对已交付 rev13 的增量。

## 范围与归因边界

用户场景是三个标签间切换，尤其 ping0.cc 的滚动和显示恢复，以及此前模拟器观察到的性能开销。上一轮证据见 [rev13 模拟器报告](android-r13z-rev13-emulator-performance-2026-11-17.md)。静态列表 A → ping0 → A 的 CPU 差异是前台内容/渲染活动关联，尚不能确定网页、Chromium 合成或模拟器图形路径分别承担多少根因。

本轮只改原生 Java 壳层中能够由源码确认的重复工作。不禁用广告/网页动画/视频，不限网页帧率，不暂停总览下面的活动 WebContents，不降低预览清晰度，不改网络/DNS/proxy/安全策略、输入生命周期补丁或签名策略。

## 实施契约

### 总览暖卡片复用

旧代码在每次普通 dismiss 时移除全部行和卡片，下一次真正 show 会重新构造整套 View、Drawable、字体/主题绑定。本轮保留最多当前标签数（产品上限 10）的卡片结构，重开时先检查 Shell 身份/顺序、列数、density/fontScale，再做差量绑定；结构或度量变更仍重新建树。

隐藏不是保留预览的借口：清除 ImageView、boundPreview、保留模型中的 bitmap 引用，不 recycle 已发布 bitmap。隐藏卡片不强持有 Shell；当前活跃 Shell 由 manager 持有，卡片弱身份仅用于复用比较。真正 closeNativeView 和 View detach 完整 release，释放回调、绑定和全部身份/结构。

保留每次真正打开的 200ms 入场动画、活动卡片展示、滚动/晚到 inset 锚点、主题/大字适配和真实卡片点击对象；已显示时重复 show 仍不重启动画。

### 改变卡片内部的字段级绑定

rev13 已经只重绑变化的卡片，本轮不把它误记为新优化。残余目标是 bitmap-only 改变不重复写标题/URL/无障碍描述、选择样式或主题 drawables；标题、URL、选中、预览分别比较。实际主题切换仍无条件更新所有保留绑定，初次主题注册只应用一次。

### 加载反馈固定占位

保留 URL 行下方既有 3dp 加载反馈槽，idle 使用真正 INVISIBLE 而非 GONE；loading 为 VISIBLE。统一幂等 setter，仅状态变化时写 View visibility。原有 loadingShell 身份、首次有效绘制/load-stop、销毁与恢复语义不变；pause/stop/关闭停止反馈动画。

权衡：空闲网页相比旧版永久少 3dp 的高度，换取同一版本导航开始/完成不再因这条反馈槽改变页面/共享 SurfaceView 可用尺寸。不是 overlay，也不宣称消除了全部 resize 或解决 ping0 持续高 CPU。

## 证据与当前结果

证据根目录（本地、不公开原始 IP/位置截图）：

`.tmp-apk/proxy-fix-work/v13z-rev14-performance-20261117-7hdlm6mc/`

- `initial-source-freeze.json`：调优前 36 项 source/test 输入与 rev13 最终 freeze 完全一致；`baseline/` 保存原字节。
- 已完成加载反馈定向主机回归（JDK17、`--release 17 -Xlint:all -Werror`）：`loading-tests.kk9Dds/`。含重复显示/隐藏、未建 View、标签 owner 切换/销毁、pause/stop/resume 和取消幂等；恢复 host 新增 3 个行为变异定向拒绝。它们不是 Android 实际布局、性能或动画接受证据。
- 初次临时定向命令遗漏 BrowserHistory 编译依赖，在执行 host 行为前编译拒绝；保留 `focused-tests.T3j9xT/focus.log`。补齐依赖后两次定向运行通过，未改生产代码绕过测试。
- Lead 首候选全量回归：`final-tests.W6AX3b/`，host runner 与 source-stage 均 exit 0。36 项 source/test 输入在测试前后 SHA 一致；相对 rev13 只改变两个生产 Java 和四个测试；当时 index 为空、`git diff --check` 通过。这不是后续纠正源码的回归结果。
- 首候选 freeze：`final-tests.W6AX3b/source-freeze.json`，SHA-256 `4b3e105ffa94d73781135dea6febfd9c187bc61a8a893e2703e6cd5e7a933b80`，保留不改写。
- 首候选受控 Java-only 构建已完成：73.81 秒、exit 0；独立二审和 41 项包装门禁通过，实际只执行 10 个允许的 Java ACTION。下载、专用签名和独立包体验证已完成，但后续隔离 Android 短滑实测失败；不能把包体验证当成完整验收，不能宣称性能提升百分比或原问题根治。

| 首候选 rev14 历史主机回归范围 | 当时结果（不是 fix1 计数） |
|---|---|
| 历史纯模型 / 指纹存储 | 274 / 13 checks，通过 |
| UI 源码契约 | 732 checks，通过 |
| 实际 runtime/Activity 方法提取 lifecycle / focus | 1120 / 451 checks +17 source contracts，通过 |
| 主题 palette / 系统栏 / 字体所有权-reflow | 47 / 1976 / 1011 checks，通过 |
| 实际 TabSwitcherView 配受控 Android fake | 1121 checks +9 个行为变异定向拒绝，通过 |
| 预览/恢复/加载反馈 | 517 checks +23 个行为变异定向拒绝，通过 |
| 网络 freeze/verify Java | 760 checks，通过 |
| 实际历史 Store/model 异步 I/O host | 22 cases /978 checks，通过 |
| 既有注册 state root 的 source-stage | 18 tests，通过 |

暖复用的精确 host 证据：5 张卡片、3 行、16 次 dismiss→show，所有卡片/行对象身份不变、grid.removeAllViews/removals 增量为 0、palette/font 绑定数不增长。bitmap-only 更新连同 20 次重复 visible show 只写一次变化的 ImageView，五张卡的文本/a11y 写入增量为 0，preview gradient 的 colors 数组身份不变（排除 applyPalette 内固定新数组的路径）。这些证明指定 fake 遍历不替换行/holder、不走相应 setter，**不是 Android 实际分配量或帧率统计**。

## 测量与归因口径

源码/host 计数只证明相应操作被移除、所有权和契约，不等于 Android FPS。本轮仅保留模拟器壳窗口 gfxinfo 记录，未采 FrameTimeline 或 Chromium SurfaceView 网页呈现/输入链路证据；不能据此称网页 FPS 或端到端输入延迟。公开站点的缓存/网络/动画内容有波动；少量前后采样不构成统计显著性证明。最终分别报告布局/交互实测、壳窗口指标、独立 PID CPU 和 PSS 端点，保留未测项与异常。

未操作真机/日常 profile、其它 AVD 或 ADB server 设置；未 commit/push。最终产物是本地签名候选，不代表发布。

## 受控构建链

- `build/PREP-READY-rev14-v2.md`、`reviewed-hashes-rev14-v2.json` 固定最终 launcher、六个 helper、v2 config/plan/payload。先用隔离、禁止 bytecode 写入且非优化的 Python，以 stable-FD 校验并编译保留字节，才执行自定义代码；41 项正负向门禁通过，包含 helper/config/freeze 漂移在副作用前拒绝以及 `-O`/非隔离启动拒绝。
- 独立只读二审与 Lead 哈希复核完成后，单独放行 Java-only：103 个受保护输入，实际仅两份 Java 和生成 source manifest 共 3 项 staging writes。8 项构建图身份、6 个 native 输出及对应全部 6 条 Ninja rows 固定，未 GN regeneration/native 编译，未触碰停止态旧 worker。
- dry-run 精确 11 个既有 Java action 描述；实际执行 10 个唯一允许 Java ACTION，包括 compile、dex、APK create、errorprone 和 validate_deps。三项 build-server dispatch 变量明确 unset，实际 stdout 为 pipe，记录 `PIPE_SYNC`、return code 0；两组分析 stamp/row 位于本次 73.8135 秒构建窗口，不能用旧 analysis server log 冒充本次通过。
- `build/java-execution-receipt-rev14.json`：SHA-256 `450175f3ae40259a475798161d8da4249b756c4c586f6216f6266c94bcd316a5`。`post-guard-rev14.json`：SHA-256 `b3b7c71c5c1ff01a3273ad000cc699b5a974c69a366272ad39e36d0c77b35930`。
- 远端新构建、尚非专用 release-signed 的 APK：372319296 bytes，SHA-256 `6788f93ec569f4d1a18be4ed1d34051fa097cbf79dbf689076e608c479e64df6`。构建后本地复核 registry 16 文件、freeze 36 文件、允许写集、native/graph/action/分析 freshness 全部通过。首次本地审计因 pre/prebuild 的附加 `syncProbe` 与纯 stage inventory 直接比较而拒绝，按既有契约仅剔除该附加诊断字段后通过；无远端重试，post/final 仍要求完整精确相等。

## 首次隔离启动的历史基线（不与候选比较）

隔离 AVD `ABS_Rev14_Perf_Isolated`，API 35 ARM64、1080×2400、420dpi、4 核、2048MiB；仅操作本轮创建的 guest 与本地静态 fixture。三个标签为 ping0.cc、可控静态 A、静态 B。本节是原 boot `53b0ac49-8f82-402e-b9c0-f7e756019f75` 的历史基线。原 guest 在候选安装前已退出，以下 CPU/gfx 数字不与新 guest 的候选直接比较；保留它们用于协议及异常上下文。

- 不开 Perfetto 的 A → ping0 → A 各约 20 秒 CPU：按唯一 PID + startTicks 去重、实际采样时长和 CLK_TCK=100 计算；100% 代表一个逻辑核心，不是整机满载。旧版 app 及子进程合计约 **0.098% → 90.416% → 0.493%**，7 个身份稳定且样本完整；ping0 阶段 privileged 49.697%、renderer 37.089%、browser 3.581%。只能定位活动前台内容/渲染关联，尚未定位高 CPU 根因。
- 壳窗口只采精确 `com.ahoo.abs.browser:browser` 的 NativeBrowserActivity、Flags=0 且 0<duration<10s 的有效 gfxinfo 帧；每组 3 次验证 warmup 后 reset，12 次总览打开/关闭并逐次保留快照。按 PID + window + IntendedVsync 合并环形缓冲区重复记录。它既不覆盖全部帧，也不包含 Chromium SurfaceView 网页 FPS。
- 静态 A 两组独立基线：第 1 组 n=172，p50/p95/max 为 **19.51/39.68/114.89ms**；第 2 组 n=160，为 **21.96/43.38/61.19ms**。另列 ping0 活动组 n=188、p95=51.94ms；不与静态组混池。初次错误采到 manager 进程、无 PROFILEDATA 的尝试保留为 UNAVAILABLE，不能记 0 jank；随后正式计时全部按正确进程重启，保留失败证据。
- 实测旧版网页 top：导航前/加载中/稳定后 **244/252/244px**。候选预期固定 **252/252/252px**，仍须实际验收；稳定态网页高度永久比旧版少 8px，非免费消除重排。
- 额外 9 标签真实快滑只做功能，不混入 3 标签计时：两个方向 80ms swipe 后立即 dismiss/reopen，同一 shell batch 的操作间隔 0.241/0.229 秒；旧版活动卡片可见、可选且 URL 正确，网页 5 个文本锚点中位移 −1193px，证明网页确实滚动。最后恢复原 3 标签及顺序。期间首次 receipt 重名拒绝写入是观察脚本问题，成功动作证据保留，唯一新 receipt 完成清理，未重跑/覆盖 CPU 与计时。
- 浅色 1.0、深色 1.0、深色 1.3 的有限矩阵均看过真实截图；长标题省略、当前标记、返回/新建可读且关键区域不重叠，最后恢复 font_scale=1.0、浅色。不是全产品视觉验收，TalkBack/heap GC 未测。
- baseline 日志审计窗口 78,667 行，package/采样 child PID 相关 25,864 行；宽 marker 包含一条 9 标签补充时的 renderer `has died`。原始上下文为 browser 主动 stopping child connection → 系统 has-died → Zygote clean exit(0)，分类为观测到的 clean renderer teardown；不隐藏该条，也不误记 app crash。另一个宽匹配属于系统 wellbeing。存在一次 UIA/日志采集缺口和分段恢复，不能声称全时段完整覆盖或绝对没有子进程问题。

## 签名候选与独立包体验证

下载/签名另行取得哈希绑定授权后，一次 stable-FD stream 下载新 unsigned APK；下载前后完整 remote final JSON 均与构建后 inventory 精确相同（SHA-256 `b3b7c71c5c1ff01a3273ad000cc699b5a974c69a366272ad39e36d0c77b35930`），无远端重建、写入、重试或覆盖。

- 专用 helper 本地签名，最终候选为 `build/ABS-Browser-v1.0.0-r13z-rev14-arm64.apk`，**372372743 bytes**，SHA-256 **`811a3d1b5dbf80efc0684b899081ad36429faea33c213bc6233f024275e5a7ee`**；包名 `com.ahoo.abs.browser`，1.0.0(10000)，ARM64，`debuggable=false`。
- `build/signed-delivery-verification-rev14.json` SHA-256 `5e2fcc189eea6f56cfa64b02e274f067339fd986f7f4ef4d58634cdfe5f55c83`。源 freeze 36、受保护输入 103、原生 3 libraries 的 hash/ZIP_STORED/4K+16K 对齐与 AndroidManifest 保持不变；`classes.dex`、`classes2.dex`、`classes3.dex` 有变化。两种独立纯 snapshot 路径核实 unsigned → signed 的全部非签名 ZIP payload 与 27923 个实际 class definitions 一致，9 个要求的真实生产类定义均存在。
- 专用证书 SHA-256 `0f186dd70f80892e04443b7105842eef2ac9e641e9ecefa15015158317f1402f`。本次 `apksigner verify --verbose --print-certs` 原始输出为 **v3=true**，v1/v2/v3.1/v3.2/v4=false、1 signer；不能由 sign 的请求参数推断已验证方案。它同时输出当前 JDK 的 future native-access warning，实际 verify 成功，未更改工具或绕过校验。
- Lead 安装前再次独立 stable-FD 校验 signed 全文件 SHA、大小、身份与 delivery receipt；见 `lead-signed-identity.json`。构建和完成 job 均已 collect、exit 0。签名和该 receipt 本身不是 runtime/performance/视觉验收，仍标 `NOT_RUN`；只读 receipt 不会在后续验收后倒改。

## 首次启动失效与成对恢复

候选安装前 host-only 身份预检发现原 QEMU PID 79577 已不存在，立即停止，未运行任何 guest ADB/force-stop/install，候选未装入原 guest。失败 job 已 collect、exit 1；`runtime/candidate-preflight-failure.json` 与 `candidate-host-resource-stop.json` 保留原始事实。原 fixture、logcat 及 wrapper PID 也均不存在，没有发送 kill 或将 pin 换成别的进程。旧 job handles 在 teammate 恢复后的 registry 为 unknown，只能保留此前 running 观察，不能补造退出码。emulator log 末尾是 graceful shutdown、snapshot disabled；约 18:13 的 mtime 与当时 turn 结束接近，但原因**未证实**，不是 app crash 证据。

已另行授权在 `runtime/paired2/` 创建全新 isolated guest，同规格、同 fixture、同协议，在同一活跃测试 turn 内连续运行 rev13 → rev14 → 审计 → 精确 owned cleanup。新 PID/birth/bootId 另立身份，不修改原 pin；旧基线不重用。这是顺序前后对照，不是随机化/交叉重复试验。两版 CPU/gfx/三页滚动/geometry/IME 块已完成；rev14 在后置新增短滑测试失败后停止，不能把整个成对验收记为通过。

## paired2 首候选失败（保留，不重测覆盖）

- 同 bootId `1b603df3-7cdd-4b38-b4d1-47cd3dba3502`；正式计时脚本的 14 份 mechanical adaptation 已由 Lead 独立核对，只更换证据根和两处更严格的路径断言。额外安装前 host stable-FD/guest APK 身份操作及两版启动/cache 顺序差异另见 `runtime/paired2/outside-phase-safety-operations.json`，并非严格完全同态实验。
- 两版 full-height 80ms 双向滑动→dismiss→reopen 已通过；rev14-only 后置 200px/80ms 短滑 down 通过，up 失败。up 前原 A 活动卡片 `[553,346][1030,833]`、`当前` badge 可见；重开后的首份 raw UIA 已无该行和任何 `当前` badge，可见列表从 Fixture B 开始。Lead 对两份原始 XML 独立解析复核了这一事实，而非仅转述断言字符串。
- 保留 `runtime/paired2/rev14-runtime/fling-failure.json` 与 `raw/1794914218389609000-rev14-fling-supplemental-short-up-top-active-reopened-try1.out`；candidate job exit 1。6 个额外标签尚未恢复、theme/font 未执行，后续仅允许 guarded 静态失败取证、日志审计和精确 owned cleanup，不自动重复失败交互来把结果洗成通过。
- **在 paired2 当时**尚无旧版同一短滑场景结果，因此当时不能断言新增回归，也不能据此前 full-height 通过宣称问题不存在；后文 paired3 已补充旧版 short-down 失败。没有直接 OverScroller 速度/内部状态证据，原短滑根因仍未证实。
- 计时观测没有一致改善，且 rev14 A-idle-1 发生 sampled PID churn，不能把不完整 aggregate 直接与完整 rev13 样本比大小。保留正式原始块，纠正版本另立 freeze、APK 文件名后缀/证据目录，Android package 保持不变，不改写本失败。

## rev14-fix1 源码纠正与独立完整回归

此纠正仅相对首候选改变 `TabSwitcherView.java` 和两份总览 host/source-contract 测试，36 项冻结输入中另外 33 项字节不变；`NativeBrowserActivity.java` 仍为 `2b818ea9e2a558b2a1b5bef5fdb2e44ed53dd079aa06abedc51f4c28dfd30975`。首候选包、源码冻结和 paired2 失败记录不覆盖。

- 生产 helper 在保存/恢复 `internalScroll` 的 try/finally 内，依次以公开 API 执行 `scrollTo(0, currentY)`（按当前子树范围夹紧）、`fling(0)`、同步 `computeScroll()`。只在三个边界使用：隐藏 show、dismiss 变为 GONE 之后、以及 `super.onLayout` 后的一次性活动卡片定位之前。不在普通 DOWN/滚轮/按键/无障碍导航的取消入口、实时刷新、调色或每次 layout 中停止运动。
- [官方 API35 SDK 源码归档](https://dl.google.com/android/repository/source-35_r01.zip) 的具体实现支持这一有限机制：范围内零速度重建后，同步消费仍可返回一次的最终绝对位置，避免稍后覆盖活动卡片定位；范围外零速度仍可能进入边缘 bounce/BALLISTIC/CUBIC 过程，因此必须先夹紧。归档和两份源码 SHA 留在 `fix1-tests/android-35-reference/receipt.json`。这不是公开文档保证的通用 stop-animation 契约，不证明实际失败时内部速度、精确 guest/OEM 实现或 EdgeEffect 等其它输入/绘制来源；原短滑失败根因仍未直接证明。
- 新冻结 `fix1-tests/source-freeze.json` SHA-256 `a5041c3eb183274b05043e71ce5322ca0aaaa3594b9d0e2d79e88ba3239bd882`；相对首候选的完整三文件补丁 SHA-256 `70d2c7a2977657ce2928069b42f7cc46ba74ef70e4e91cec15853f3ec5ee804f`。生产总览 SHA-256 `4142c04721e38213f39c771ff967df5c79473cc09b754e629c495f1a0cedd725`。
- 作者完整 native-history/Store 和 18 项 source-stage 回归均 exit 0；新增后为 **754 条 UI 源码契约、1231 条总览 host 检查、18/18 个编译成功的行为变异定向拒绝**，其它既有套件均通过。host 模型覆盖夹紧、在途绝对位置、隐藏时新运动和 super-layout 后新工作，不模拟真实速度/时序或渲染。
- Lead 在独占 `lead-fix1-review/full-regression/` 再次完整运行相同两套回归，均 exit 0；36 项冻结输入在前后逐字节/大小/SHA 校验不变，空 index、diff-check 和补丁 reverse-check 通过。独立完成 receipt SHA-256 `e2ac8edd328ff9a83137e6e3ac7d289eefa13c45e5da8c938966bff0011c619c`，job `bash-1266da59d80242b5` 已收集 exit 0。
- 作者第一次 focused 运行保留了旧变异触发断言顺序不符的失败，未删任何断言；第一次 source-stage 调用因专用 tests 父目录尚未创建，在测试开始前失败，原日志也保留。修正测试准备/断言顺序后 focused2 与全量回归通过。作者完成 receipt 为 `fix1-tests/regression-completion.json`，SHA-256 `49d1407ae2fba46819f101e2b0fa1271dfe5bb44cd58921a8745e17c8ada029e`。

上述源码/主机结果本身不是 Android 功能、像素、帧率或性能通过。修正版本另用 `build-fix1/`、`runtime/paired3-fix1/`、`rev14-fix1` APK 文件名。受控 Java-only 构建、签名及独立验证已完成；之后实际执行的 paired3 因基线 short-down 失败、候选 identity guard 超时而关闭为不完整，详见后文。原计划的完整限定成对协议没有完成，不再把已中断轮次表述为尚未开始的待测。


## rev14-fix1 受控重构建（签名完成；后续成对实测已中断）

- 仅将总览源码和产品 source manifest 两项同步到远端，103 项输入中其余 101 项不变；8 项构建图、6 个原生文件及对应 6 行 Ninja 记录保持。没有 GN 或 native 编译。
- Java-only 命令实际完成 7 个允许的 ACTION，exit 0、64.573978304 秒；两个 analysis 文件及对应行的时间落在真实构建区间。历史 server log 不作为新鲜运行证明。
- 远端 unsigned 包 372319060 字节，SHA-256 `e11f0392667371dd0c11df6c7c0a4f6d6a5dd2dddd373e7d6f3991a16685901d`。完整 post inventory SHA-256 `cb6f992f138a49648e20f4dd359b408b19f8cdced37b476c9d985b604df5e68c`；执行 receipt SHA-256 `103d368995d6277777f7dbf71a2a8fc174c7926c86743044c7d12ae942d8284c`。
- Lead 独立复核 canonical projection、全部输入/脚本 pin、真实 build log 的 7 项 ACTION、两个新鲜 analysis stamps/rows、所有保护项和 36 份本地冻结输入，审计 receipt `lead-fix1-review/postbuild-audit.json` SHA-256 `482155e846a5aecbd08ee7096fc058e527bc53a8cab72af87c88fc23e560b5a8`。Lead 第一次重复 schema 检查误把 `localFrozenPins` 列表当字典，纯本地计算退出 1；纠正读取类型后全部检查通过，未改构建器或输入、未重试远端构建，原失败记录保留。
- 构建 job `bash-decac7da75b34e46` 由 owner 实际收集 completed/exit 0；Lead 的跨 session 读取不可用，**不称 Lead 独立重收了该 job**。owner receipt SHA-256 `1e725e0514133d19499c5a035d89d67ed439d220a8fa2cb317f0a7efa500a353`。
- 相对任务开始的 rev13 快照，只有两份生产 Java 和四份相关测试有增量；其余 30/36 冻结输入不变，原先 16 条 tracked dirty 路径未增减，其中无关的 10 份字节不变，index 仍空。未动受保护 DNS patch，未 commit/push/publish。见 `lead-fix1-review/source-preservation-pre-runtime.json`。

## paired2 独立原始数据复核与覆盖范围纠正

独立只读审计重新计算了全部 60 份 CPU stat、78 份 gfx 捕获及 24 个 PSS 端点，所保留算术均一致；rev14 A1 的 CPU 仍因子进程消失而不完整，不能比较整体收益。PSS 也保留一个不完整端点：rev13 CPU A1-before 的已读 subtotal 为 **439421 KiB / INCOMPLETE**，因 PID4418 的 TOTAL PSS 无法取得，不能当完整进程 aggregate；缺测不是 0。PS/stat inventory 完整与 PSS 可读完整是两个不同条件。审计没有运行原脚本、重测、构建、签名或接触设备，也未检查 fix1。

审计发现旧 `child-inclusive-stability-review.json` 和 `FINAL-REJECTED-PAIR.md` 漏记基线 `PID4418/startTicks26580`：它已在 memoryBefore 端点出现，启动早于窗口，在窗口内由系统以 isolated-not-needed 结束。已知归属范围应为基线至少 **17**、候选 **17**，不是旧文件所写的 16/17；补入后，指定范围内的 fatal/ANR/旧 gesture CHECK 保留标记仍为 0。这是归属覆盖缺陷，**不是新发现的崩溃证据，也不是覆盖全部瞬态子进程的保证**。旧文件不改写，补充结果在 `lead-fix1-review/paired2-independent-audit.json`，SHA-256 `d419172aeacdfd2ce20373fc9686c66eaeb75b5945ac95f213c5e8dbd80a761f`。

另有证据边界：旧 finalizer 的终态 job 字段是 owner 汇总断言，不是独立保留的工具终态转录；此审计只确认脚本/身份/信号目标及记录彼此一致，不能独立重收历史 job 或重查实时 host。PSS helper 理论上未传播 snapshot inventory completeness，但这 24 个端点的 raw PS/stat 核对没有遗漏 PID，未改变旧端点结论；新轮另做逐端点独立完整性审计。以上纠正均不改变 SHA811a 首候选的拒绝结论。


## rev14-fix1 专用签名与独立包体验证（不是 Android 验收）

- 在完整审阅完成 helper、计划及独立离线审计后，另行发出绑定 entry/plan SHA 的下载签名 GO；以 `python3 -I -B` 执行 retained stable-FD 已审字节。下载前后全量只读 final 均为 post SHA `cb6f992f138a49648e20f4dd359b408b19f8cdced37b476c9d985b604df5e68c`，未新增远端写入或构建。
- 新签名包为 `build-fix1/ABS-Browser-v1.0.0-r13z-rev14-fix1-arm64.apk`，**372372507 字节**，SHA-256 **`7a53ecf326a9a6e339d2c45e8ec3239ab0acff15edc06321a963ec552858a4d3`**。unsigned 仍为 372319060 字节 / `e11f0392667371dd0c11df6c7c0a4f6d6a5dd2dddd373e7d6f3991a16685901d`。
- 实际 `apksigner verify --verbose --print-certs`：Verifies，**v3=true**；v1、v2、v3.1、v3.2、v4 和 SourceStamp 均 false，不把它们误报为 true。一个专用 RSA-4096 signer，证书 SHA-256 `0f186dd70f80892e04443b7105842eef2ac9e641e9ecefa15015158317f1402f`；正式包 `com.ahoo.abs.browser`、非 debuggable。JDK native-access warning 原文保留，未为隐藏 warning 改签名参数。
- unsigned/signed 非签名 ZIP payload 和 **27923 个实际 DEX class_defs** 一致，含 9 个必要生产定义；相比原 rev14 只有三份 DEX payload 改变。三项 native 库和 Manifest 字节不变；native 为 ZIP_STORED、偏移同时满足 4KiB/16KiB 对齐。此验证不是完整 ELF ABI/segment 或 DEX 方法正确性证明，更不是安装/执行证明。
- 包装 owner 的唯一 job `bash-29411706b7e34d86` 已实际收集 completed/exit 0、无重试；owner collection receipt SHA-256 `8fada7c900e05cfd4a26b2a5916ecc289a98c509c7a01d197c2a4b6bf4c3a032`。Lead 没有声称跨 session 独立重收 job。signed delivery receipt SHA-256 `de1ebced2c4123302d37156464e13e921def46199b97103cfe7e5c47b9140a37`。
- Lead 另外独立读取并验证 signed/unsigned/baseline 包、非签名 entry 集、全部实际 class_defs、native/Manifest/layout 和专用证书；重新投影本地冻结及 build 输入，空 index/diff-check 通过。独立 receipt `lead-fix1-review/independent-signed-apk-verification.json` SHA-256 **`654d7b8bd9250be5ab183b4cd967cca95bb5db1f197ef15e90eabaa5cd803174`**；审批/独立审阅/GO 历史补充 receipt SHA-256 `0b76930fe247b853311ed4c525de3ea978c8bce6853cf8edb004004b19b92623`。原失败 APK 和其 freeze 不改写。

签名准备的 15 个 post 漂移单测只证明外层整值比较；synthetic APK 反例不是完整真实 ZIP/ELF 破损样本；actual class_def presence 不是完整 DEX 验证。真实签名执行与上述独立包体验证已补充完成，**runtime/performance/visual 仍未因此变成 PASS**。

## paired3-fix1 准入准备及独立批准（历史准备；实际失败与关闭见下文）

新轮固定同一 fresh boot 按 rev13 → fix1 执行相同 CPU、三个独立总览块、切换/网页滚动、几何、IME/Back、三组主题字号并恢复，再做九标签的 full-height down/up 和 200px/80ms down/up 四场景。双方主题都在 race 前；基线短滑失败将保留失败，只有独立 failure-SHA/owned-identity GO 才允许最多关闭六个已验 URL 的额外标签以恢复对照条件，不会补写基线 PASS；候选失败直接停止。

独立只读准备审计在任何设备动作前发现并阻断：游离 candidate 授权没有强绑定父 GO、assert 可被优化模式移除、stable-FD 边界依赖操作者顺序，以及离线收据额外检查的 provenance 缺口。准备脚本已完成最小六脚本 v2 修订，旧 v1 共 48 文件/20 脚本及原冻结、收据和 diff 全部保留。日志归属已明确保守 PID-union 的过归属边界，不能把 retained PID 集当完整生命周期或根因证据。这些是**在设备动作前拦截并修正的复测工具准入问题，不是 APK 运行失败或通过结果**。


- v2 只改 gate/候选安装/基线安装/stable-FD/授权派生/审计措辞六脚本，其余 14 脚本字节不变，5 个测量/捕获核心 helper 仍与 predecessor 一致；plan 继续为 `cbc15b2ef6bd2001723ee1fa1185f6bd384ddeb7011c7f2c78f7fae6a4d2aa5a`。v2 manifest SHA-256 `723af33443a5fe18b43e49e74f9e1a5891e9c42c87b3f00777bf792d690636d4`。
- Lead 独立重建六脚本 diff、稳定读取全部 20 项，并实际运行纯离线 validator，18 组检查 exit 0；含真实 `-O` 和继承 `PYTHONOPTIMIZE=1` 的显式拒绝、12 个父/子候选绑定反例、两个 installer fresh stable-FD 必调顺序、24 个旧端点和 **6 份 retained exit-info 快照中的 52 条记录**。52 条是封顶历史快照记录，不是当前窗口 52 次退出，旧 v1 对此额外检查的 provenance 局限不改写。Lead 实际运行 receipt SHA-256 `ecb804744562986d206553ec9b10de4ccf1e905c97a62a0a7fa6c238a395c50c`。
- 另一个只读独立审阅者核对全部 20 SHA/大小、48 份 v1 文件、精确六脚本 diff、父 GO 绑定和实际命令观察，独立重算 exit regex 为 52/6；原 high/medium 准入问题无残留。审阅 receipt SHA-256 `3b5add2fdf5464204bd76a7952831f0449a9ea0dc8cdfbe8e22154e4115cb29f`。
- Lead 在新鲜 stable-FD 重哈两 APK 后，另建真实 `runtime-authorization.json`，SHA-256 **`8573e87082861ef7070ac371b88003610b31fc9f32a9becca2eff2af6d105a36`**，只授权该 plan/manifest/7a53 修正版及 delivery receipt 的 fresh owned 隔离对照。此时不授权基线失败后的恢复或失败清理信号，它们须另有精确 failure/owned-identity GO；不得重试失败 race 变相写 PASS。
- stable-FD 只证明该 FD 读取区间身份和内容，不是 FD 原子交接给 adb；后续 guest installed SHA 在继续启动 app 前另查。授权/manifest 也非持续文件锁，依赖可信受控 host。准入时 actual-run PID 复用/标记、端点完整性和 Android 功能尚未验证；**准入批准不等于 runtime/performance/visual PASS**。实际运行及中断事实如下。

## paired3 实际失败链与关闭（未完整验收）

1. **旧版确实也出现短滑定位失败。** rev13 的三 CPU/三独立总览块、三页切换滚动/几何/IME 和限定主题矩阵已执行，双向 full-height race 通过；首个 200px/80ms short-down 重开总览后，没有可见的 `当前` 卡片，short-up 未执行。Lead 独立复核原始 XML：此前 7 张可见卡片、1 个 `当前`，之后 8 张、0 个 `当前`。首次 failure SHA `565603604ced06ab2c3213b257f832fa1f4349745303f8f45c1d8068ba9416e9` 不改写。故 paired2 时“尚无旧版短滑结果”的信息现已补齐，但不是同方向 paired2 short-up 的直接复现，也不能证明所有旧版短滑或根因。
2. **恢复测试条件，不把基线洗成通过。** 另行绑定失败/owned identity 的一次性 GO，只关闭 6 个 URL 已核实的临时标签，恢复原始三页和活动 A；baseline-control-ready SHA `da15f211b3e6cdb96407ca3afd14e7e2357633356e96a937aebfb32bb82bae09`，基线仍为 FAILED。随后安装 fix1 的 host stable-FD 与 guest installed SHA 均为 `7a53ecf3…858a4d3`。更新安装后保留的标签数曾为 1，故重建并验证原始三页；`tabsRecreated=true`，startup/cache 条件并非完全等价，不能声称严格因果对照。
3. **修正版候选中断，不是产品断言通过。** candidate 唯一计时 job 实际 exit 1：三 CPU 阶段和两个 A 总览 gfx 块之后，在准备 ping0 总览块、打开总览选择活动页时，下一次原有 12 秒 read-only identity guard 超时。实际耗时 12.3290735 秒、rc 124、stdout/stderr 均 0 字节；failure SHA `f825ae7f592ca6a1bc2d29deb9145a1ad4a1c905030c45875183600d9f7b1917`。第三 gfx 块、切换滚动、主题、四个 race 和 completion 均未完成。没有放宽 guard、自动重试或补写 PASS，也不能由此认定为 Chromium/app 崩溃或纯基础设施故障。
4. **较晚的静态诊断有用但有限。** 另行授权的固定只读脚本一次完成 exit-info、lastanr、input-state、截图和 UIA；每项前仍用原 guard，并新鲜核实同 boot。`lastanr` 明确为 `<no ANR has occurred since boot>`。较晚截图显示三标签总览，A 为当前，符合尚未选到 ping0 的现场位置；这是迟到静态画面，不是超时发生帧、不证明此前连续可响应或已修好卡住。没有再发送 app 输入、继续验收或覆盖 failure；原始截图含公网 IP/位置信息，不作为公开交付物。
5. **精确 owned 清理和真实终态。** 冻结的原 cleanup gate 不适用这次 identity timeout，未修改或伪造其 completion/fling-failure。另审 80 行 host-only reaper，真实 GO SHA `f3c0ae8ef31f2b89025967a8c6169d808353d28fbe85080637911884739ef907`：三个目标全部预检、每次信号前再核 PID/birth/full argv，仅 SIGTERM owned logcat/fixture/QEMU。cleanup 实际 exit 0；全部 13 个 managed jobs 由 owner 真正 collect，日志 wrapper=0/child=-15、QEMU wrapper/child=0 分开保留。5 个精确 owned PID 均 absent，5690/5691/24571 均无 listener 且 bind 成功。全局 ADB PID7869 的原 birth 匹配、未触碰；历史完整 cmd 字节未留存，因此不能声称已证明 cmd 未变。macOS ps→kill 不是原子 pidfd 交接，保留 TOCTOU 局限。
6. **证据已整体关闭。** `runtime/paired3-fix1/closed-evidence.json` SHA `6b40ecc3e818423c967241b41b689631f53d2a8042036c01acf8aaa1363b6357`；终态核实 receipt SHA `c5ede9b8ad0c000b66784ef9c62120a1039634ec30f937227cadcb3502a4c8c1`。保留日志 17710946 字节，SHA `17289e170c36ce38d3d28b15d19aa51efc2b133569eb255f2500c2209a0171d8`；command ledger 共 2555 行，超时前 2545 行前缀不变，之后只有已授权静态探针的 10 行。owner 40 份观察逐项保留哈希；Lead 只核实其留存，不称跨 session 独立重收了 owner 的 API jobs。

## 独立审计与功能补验边界

独立 stdlib metric verifier 的 15 个回归检查及闭合 paired2 重算已通过。另一份独立 log/process/exit verifier 经 Lead 全部 366 行源码审阅、真实重跑 **34/34** subprocess 用例通过（含 7 个 stable-reader 子探针和闭合 paired2）；实际均 nice10，receipt SHA `f9caa59a1c4c7561b49fbd547a748fcf823fbd7935d5ecdf22d7b18c9ec630ba`。它包含保留 PSS 缺失 PID4418、原始 PS/递归 PPID、stat22、全日志 PID 重用和 exit 不完整等反例；只证明审计工具的指定覆盖，不是 app 的 runtime PASS。

关闭后的 paired3 原始算术、全留存日志和历史退出记录已完成独立复核，Lead 也重新核实了实际命令收据、23 项输出清单及相关 SHA。结果保留于 `lead-fix1-review/paired3-closed-independent/`，`RESULTS.md` SHA `cb7f22b2d5d9a0c2e472d3a03cfc741fc1fa612a2269a7de0c982300045cfaba`、`review.json` SHA `71693d8c09398887761f4a5202cbbb985a37080e011cda6b6e933b91910a3757`。

- 原始指标 verifier 以 nice10 / isolated Python 实际 exit **2 / INCOMPLETE_INPUTS**，没有使用 reference；唯一 pending 为候选 `ping0-overview-block1.json` 缺失，errors/discrepancies 均空。保留 6 个 idle CPU 阶段/58 份 stat、5 个总览 CPU 阶段、5 个独立 gfx 块/65 次捕获和 22 个完整 PSS 端点。基线 A-idle-1 的 PID4935/startTicks33215 在第4→5快照消失，3.62645% 只为重叠身份部分算术，不是完整 comparator。缺块和完整成对 aggregate 为未计算/null，不当作 0，也不拼池得出整体收益。
- 日志/process/exit auditor 以 nice10 实际 exit **0 / ARITHMETIC_SCOPE_CONSISTENT_ONLY**，`runtime_acceptance=false`。180 个实际成功 PS/stat 原始命令全部纳入：基线46+46、候选44+44；扩大到安装/启动、失败、独立恢复和最终静态诊断的边界，保守已知 union 分别为18和8个PID，含 PS 未捕获的启动子进程。所属严重标记均0；候选窗口有1条无关 fatal，原始日志明确关联 `com.google.android.apps.scone` PID2342，而非本 app。
- 全留存日志145813物理行/145810 epoch行、3个buffer分隔、0条非空未解析行；39条 Start proc 分别为39个PID，未观察到重复启动/name/startTicks歧义，但**不是无重用或全子进程存活的证明**。PID 归属仍是保守 bare-PID union，不是逐行生命周期过滤；未承诺无日志丢失或覆盖所有buffer/瞬态子进程。
- 最终16条 exit-info 都是之前候选计时前快照已存在的历史记录：reason13×11、reason1×2、reason10×3，status全0/trace全null；三条reason10/sub21对应安装更新的force-stop，其它isolated-not-needed记录也不自动算崩溃。不是16次新候选退出，不是窗口增量或完整生命周期历史。晚期 lastanr 的无ANR文本属实，仍不解释12秒guard超时。
- 独立 final stable reread 覆盖969项来源、966个先前pin无漂移；只有3项明确列为新增只读最终pin。该核实没有重新启动设备、重测、安装或触碰APK/签名。基线 **FAILED_IMMUTABLE**、候选 **INCOMPLETE_NOT_ACCEPTED** 结论不变；缺失第三gfx块不能因日志审计exit0变为运行通过。

另根 `runtime/fix1-functional4/` 的 fresh 隔离、单候选方案保留三标签切换滚动/几何/IME、三种限定主题及成功后精确恢复、四个九标签 full/short race 后恢复三页。原有断言、12 秒身份检查及 APK stable-FD/guest SHA 门槛未放宽；不安装旧版、不跑 CPU/gfx、不伪造 baseline 或 measurement completion。初次独立审查的真实 exit1（98 PASS/2 fail）保留：一个发现是继承的 logcat 包装器记录 child rc 却返回 wrapper0（M1），另一个是审计期间获准新增准备文档造成的清单变化。后续补充核实与独立生命周期裁定没有把原失败改成 PASS，也没有声称修复 M1 源码；只在 Lead GO 绑定单独 owner gate 后允许有限执行：日志启动后、安装前和六个阶段前后，实际记录同一个 managed job 仍 running、退出文件不存在、同一子进程 PID/birth/完整 argv；任何缺失或提前退出即 host-only STOP，不继续阶段、不重启日志或补洞。边界观察不是每个瞬间存活或零丢日志证明；最终闭合原始日志、真实 child rc 和 wrapper job 终态仍需独立审计。

functional4 实际 Lead GO SHA `9d476a0b79827dcef936820e367e0094848df70af31de5aa2ded027d4ebbf1c9` 后，仅创建一个 emulator job `bash-3df48c4fc96f4437`。原始 console 最后一行明确为 userdata 分区空间不足：**Available 2076.27 MB / need 7372.80 MB**。真实 child 与 owner 收集的 wrapper 终态均 exit1，已自动首错停止；fixture、bootstrap、日志、APK 安装及全部功能断言均 **NOT_STARTED**。这是测试环境启动失败，不是产品行为失败，也不构成功能通过或连续日志覆盖。owner 的启动/终态记录保存时间晚于实际 child 事件，不能混作 API 创建事件时刻。`closed-evidence.json` SHA `f31fcecf2e515e6896b32f54ee875e738057a2266d7a181c3d82dd74d21ebb22` 绑定唯一 job、首错及 host-only 闭合观察；当时 wrapper5543/child5556 已 absent、三个端口 free，protected ADB 只证明与本轮新 pin 一致，历史 paired3 full-command 仍 NOT_PROVEN。没有剩余 cleanup targets，没有 signal、删除、清盘、缩配置或旧根重试；退出前未观察到的 qemu 完整 argv 仍诚实记为 NOT_OBSERVED。

functional4 的独立启动失败审阅结论为 **FUNCTIONALS_NOT_STARTED_NOT_ACCEPTED**，不是产品行为通过或失败。`functional4-launch-independent/RESULTS.md` SHA `e5cbd2d0bc655d484f27fbbaaaf49135e76a16112ab41ccaee8faec8b046b1a7`、`review.json` SHA `3fc778ece4bf3b13b6e430660e4fe49c0e317c1e595fdaf9039e0eecdc5963d6`；62项选择输入及16份F4/20份paired3源码的留存属性稳定。**该独立审阅启动时 closure 尚不存在，因此没有审计或认证后来生成的 closure。** 独立审阅自身最初的窄 exit-marker 解析误报也保留，补充解析才确认真实 combined marker；不是 owner 运行缺陷。后续 closure 的72次 stable-FD 引用核对仅为 Lead 对留存证据的相互印证，receipt SHA `4db8ecb66143097f05e85740823060d7a28a6abfddbb19fa1c65a8b8b9f9db07`；另67次读取固定了独立审阅的输出与输入边界，SHA `6a2102ab0ecb5a47204be48531a72a5fcd40fe721baa8b47aa7007c768bd2581`。这两份均不冒充新增独立 closure 认证或实时重新收集 job。

Lead 在 functional4 关闭后重新核对全部36项 source/test、原始16个 tracked dirty 路径、其余10个原改动和16项补验脚本，HEAD/index/DNS/`diff --check` 均符合冻结范围；receipt SHA `d8fbb693a4d792dc8b6254dfe85487e261a596346ed54cddf9f128dab5b9b073`，只是源码保全，不是 runtime 接受。只读 host 文件系统元数据表明既有 SDK 开发盘当时可用约29.78 GiB，与只有约2.02 GiB的工作区卷不同，因此仅准备**新根 functional5**，把其独立 avd/home/cache/tmp 放到一个新的外卷目录；保留原镜像、配置和所有功能断言，不删除旧证据或用户文件、不缩分区、不改日常 AVD。该新根后来完成独立准备审查并取得本轮专用 GO（见下一节）；执行授权不是功能结果。即便后续有限功能补验通过，也不能覆盖 paired3 INCOMPLETE、补齐成对性能证据或宣称整体提速。


### functional5 独立准备复核完成；短滑首错后已闭合并独审（不接受）

冻结准备时，`runtime/fix1-functional5/` 为16份源码、plan及manifest共18项，`lead-fix1-review/functional5-prepared/` 为15项；准备交付index列出32个其它冻结文件。外置重数据目录与repo证据根分离。plan SHA `990ce618cde526fc56e7f6d9bab05673d978a55fcd8e12b5425d91d19862241d`，manifest SHA `d145049191a5896696400cb1fa9b20b713e0020a9a1b46a95eac456262d45708`；false-GO proposal保持false不改写。Lead首次54次 stable-FD 读取、16份脚本内存编译与AST确认12份仅机械根名替换/相同，恰4份为storage/gate/hostpreflight/launcher适配，原AVD配置、启动argv、12秒guest guard、finite断言及M1源码不变；receipt SHA `009149f2d23912b39b3f5c69872dc773627238969030bee914094c803ed39675`。原owner validator实际exit0/151PASS/空stderr及3个负向子命令各exit1保留；没有为准入重跑一次性准备或validator。

独立准备审阅最终为196 PASS、0失败、`CONDITIONAL_PREPARATION_ADMISSION_ONLY`，review SHA `db73a4def651a69a47fac5df0682c0265ee6308f46c40f6efb83eb14f6919e64`，RESULTS SHA `522f3b8f2e8504a306627b549f01e782a2628b1fbf58ab84f6a80796b48d6456`。Lead重新核对7份最终输出、102行checksum及32项交付index，准入receipt SHA `5bd9b69cf61e685431cf61e75b938b8d3a5ad2baab3bab9768de09dff681c7bf`。这些都是准备一致性及条件准入，不是运行接受。

Lead随后独占创建本轮真正 `runtime-authorization.json`（8377B，SHA `d3ba26831992caf96dc354a7a32dfb243a69ef27092819457ff1d7eef16443cc`），只授权一次功能补验及受门禁的派生候选安装。owner全文核对GO、ACK、16项source和32项index后开始 task-51，并报告真实preflight epoch1794936537.788127复测31979102208B≥16GiB、dev16777251（repo16777229）及新目录独占创建通过；不借用旧容量代替本轮检查。运行随后短滑首错；失败闭合与独立审查已完成（见文末），不构成通过。GO不允许性能比较、放宽断言、重试、诊断追加，也不允许signals、cleanup或删除；后续资源关闭必须另做精确-owned目标和有限cleanup来源的独立审查与新GO。

M1（`collect_logs.py` wrapper不传播child rc）源码依然未修复，条件准入不能说成修复：同一个managed log job的真实API running、exit文件不存在及child PID/birth/完整argv，必须在日志启动后、安装前，以及六个阶段每个前后同时成立；最终post检查位于最终断言、exit-info和child scope之后。任一失败/缺失/terminal立即独占host-only首错STOP，不运行下一guest阶段、恢复、重启或日志重拼；只允许一个未过滤main/system/crash raw段及stderr，实际child rc和wrapper API终态另审。断言完成也仅能记为PENDING_REVIEW。

日志范围解析工具在独立新副本中只扩展一行保留文件名匹配，纳入原名`birth-identity.out`，原D不改；Lead已确认完整clone与唯一delta、559项regular和7项synthetic symlink的冻结handoff。Lead在自己另根中对完全相同源码实跑默认33/33原合成项（包含一个7 Reader子断言项）、新增14/14聚焦项，以及独立7/7 Reader重复验证；后者不是原runner的可选第34项，各层不混加。实际48个child CLI/probe调用全部符合预期rc，三个外层wrapper均exit0/空stderr，managed job `bash-b629cb6c5c3c48a0`已由Lead取得真实terminal exit0。旧runner子进程实际为nice20、`-B`而非`-I`；聚焦和独立probe为nice10、`-I -B`。这些仅为合成工具回归，没有读取实际F5运行证据或给出runtime接受。闭合映射工具目前只是明确pending的契约替代，不会产出可用spec；须待真正closed receipt与实际API/ledger字段出现后再明确映射，按原名保全所有成功和失败的PS/stat、exit输入，不允许重命名或漏列绕过不一致。


owner执行进度与首错历史通报（当时原始闭合证据尚未独立审完，最终独审见文末）：bootstrap实际terminal0；fresh install后guest APK SHA匹配`7a53ecf326a9a6e339d2c45e8ec3239ab0acff15edc06321a963ec552858a4d3`；setup、run_functional（三标签scroll1/2/0、geometry、IME及该阶段childscope）、capture_device、theme3/null-aware原值恢复各实际terminal0。`accept_fling`唯一job `bash-ca3cde6a34ff469f`实际terminal1，在第3个`supplemental-short-down-bottom-active`（200px、80ms向下）重开后的`active()`断言失败，报`Active card not visibly reachable: 0`，stack `accept_fling.py:53→32→14`。前两项/full down/up的通过不能抵消此首错；不将fix1滚动停止机制称为已修复该运行问题。立即停止后续guest阶段、complete、诊断、恢复、重试或重启；允许的下一步仅为host-only保存首错/真实terminal、精确owned身份及另审cleanup准备。未执行的后续断言、finalscope/exit不补造；单段log保持到独立审查后的有限cleanup。该阶段的`task-52`只审cleanup v1，未授signals/delete权限；较晚v2另审另授host-only GO的情况见下。此刻不提升、不展示候选APK，不主张性能收益。


#### functional5：cleanup v1退回、v2另审另授GO；以下保留独审前通报

v1独立审查为BLOCKED（review SHA `797a61d32756f5df7792483a3d4a128e7a9cb8d17b953fd9339a0ced0c1dd6ed`）：等待可能越deadline先return、signal target不是最后复核角色、API age缺非负下界。v1冻结不改。另根v2仅修这三项及机械path/SHA；112行源码、四文件完整diff及27项引用独审通过，仍为有条件静态准入、不是GO（review SHA `5e378bd74cbf7a4a8899f9b76278ebaf0ba0a4b403126fe788907eff3a08ed5d`）。仅审`python3 -I -B`无`-O`调用；ps→kill非原子，等待不是硬实时，exiting wait不比fullargv；没有GO发出60秒即失效的新增要求。

Lead随后72次stable-FD读取、42项静态核对后，另行独占创建真正host-only cleanup GO，SHA `3371704dba05ca7e76663d28c99edae8bd8299bbb545b4f71eabd88e2974e63e`，仅允许同三个真实job在GO后的新API running证据及入口age[0,60]成立时，执行冻结v2一次，SIGTERM wrapper24076→fixture23338→QEMU23207；不得signal launcher23192或全局ADB7869，不准guest/恢复/retry/KILL/delete。Lead一次空白缩进敏感静态checker假阴性rc1发生于任何落盘或GO前，改为AST语句邻接核对，未改owner源码或重试runtime；详见预审receipt。v1 reviewer三次被拒绝的permission参数调用仍保留于独审操作记录，未误记为owner/runtime重试。

以下保留闭合独审完成前的owner通报：cleanup managed job `bash-40c663bba6ba4a3c`真实terminal0，三个原job终态已收：logcat actual child=-15、Python/Bash wrapper0（M1未修），fixture0、QEMU child/launcher0；恰三个TERM、五owned PID absent、protectedADB身份保持和三限定listener为空。原closed-logcat-files的epoch正则不容忍前导空格，first/last为null，原件保留不改；仅允许在有限host-only closure另记真实raw边界。此段是当时owner执行通报，不代表当时Lead已独立审完原始closure/API/raw，也不证明drop-free；最终结果见下一节。cleanup完成不能抵消第一功能失败，后续guest阶段、恢复、complete、finalscope和exit-after继续NOT_RUN。

此前只读源码复核另提示诊断边界：immutable `accept_fling.py:31–34`将swipe、dismiss tap、counter tap以分号合成一次shell命令，没有中间hidden→visible证据；失败`active()`早于该场景截图和后续位置确认，这些文件并未产生。header是ScrollView上方的兄弟View，不能先认定其点击被滚动惯性吞掉；普通counter DOWN先于click/show，也不能直接认定它取消新reveal。一次性row-top reveal缺少badge可见性成功确认是源码鲁棒性限制，尚非该失败根因。源码子审未看实际F5 artifacts；root/inset、惯性、未重开、卡片越界/active模型或accessibility分类均须由已有闭合证据区分，无法区分处保持NOT_PROVEN，不改断言、不先补猜测代码。


### functional5 最终闭合独审完成：FAILED / NOT_ACCEPTED（2026-11-18）

**完成的是失败运行的关闭与审查，不是功能、视觉或性能接受。** canonical `runtime/fix1-functional5/closed-evidence.json` SHA `1c06c698127a4f8b6620fd81c1bcf68199e19760838b57bb5db272dbb527d1d0`，owner v2 `closure.json` SHA `e8e7e327ba7f7c1ab2151cba986c556eb1db5d1bf86bd86844032fe58d0e48b8`。task-54 已完成：独审 `functional5-closed-independent/REVIEW.md` SHA `f5554fede673b6a36940276253990bc1c8fba980413714c4405a0f449f7dee40`、`REVIEW.json` SHA `a98b9bfbe997cd55058bd73c354a2eda172b0a8d815ddd117405d35a41efa077`。所有 acceptance/completion 仍 false。

- 独审按真实原名核对1172个owner inventory pins，F5发现1097文件＝inventory1096＋较晚canonical closure；完整502条命令/1004个独立stdout+stderr全部保全，含14个PNG二进制，不当作文本。命令501×rc0，另一次rc1是安装前预期包不存在的前置检查；`accept_fling`断言本身的Python/wrapper1仍是实际失败，不能由ADB shell rc0覆盖。没有命令在首错STOP后开始。
- 10个真实creation/terminal pairs、9组实际API/边界、104/104 cleanup trace、27项引用、v1原index10pins及16份F5源码均独验。保存证据只支持三次SIGTERM：wrapper24076→fixture23338→QEMU23207；未signal launcher23192或protectedADB7869。API记录至cleanup入口age6.943864s；逐API查询事件的精确时间未暴露，不补造。等待观测为1/2/4批，PS→kill仍非原子、deadline仍非硬实时。全部10个job终态已收；**M1仍为logger child−15 / managed wrapper0，未修复**；QEMU0不修复功能首错。
- raw原字节5669433B，SHA `d7def9b4fe599e5a483920ffbb872f61fa308277ad9d212e67c4b846afde2e2b`，stderr0B；独算42865行/42863 epoch行/2分隔，首epoch1794936746.652（第2行），末1794940980.098（第42865行）。22处相邻epoch回退保留，不排序修补。原first/last null与`managedTerminalNotYetCollected=true`继续保留为历史metadata，后来实际API终态另存；不保证drop-free或连续每瞬间存活。
- 诚实全phase launch→STOP `[1794936537.956116,1794937604.206495]` 的冻结auditor实际 **rc2 / INCOMPLETE_PENDING**：raw起点晚于launch约208.696s，`candidate-exit-info-before.out`只有dumpsys头和未曾持久化的时间，没有可解析的历史退出条目（不是0字节或缺件）。不能缩到成功base子窗口制造通过；这些审算缺口本身也不是新增产品崩溃证据。两PS/两birth仅覆盖before/after base，254次PID1/boot观测不是childscope；17个bare-PID保守union不是生命周期证明。选中范围severe计数0/0/0、全留存字节所选marker为0，均不等于crash-free。两份exit-before输入合计仅一条reason13/OTHER KILLS BY SYSTEM、subreason17/ISOLATED NOT NEEDED、status0历史记录，不自动算crash或完整增量。
- 第4个race、post-fling gate、额外标签移除/原三页恢复、complete及前后gate、exit-after、final-restored scope、guest诊断/恢复/重试继续 **NOT_RUN/PENDING/NOT_EVALUATED**。未补采、重启log、拼接、改断言或补造失败截图。failure artifact结束1794937604.205617、STOP1794937604.206495、terminal API记录1794937897.7237198是不同事件时间。

#### 实际失败UIA的校正：没有观察到成功重开后的总览

Lead只对保存的XML、全部502行ledger及相关原始out/err作离线解析，没有追加guest探测。失败前overview UIA为449节点，可观察7个卡片节点/1个当前标记、返回按钮及ScrollView `[0,325][1080,2337]`；批次后的reopened UIA为382节点，**0卡片、0当前标记、无返回按钮、无ScrollView，仍是浏览器页面**。它与此前native及last-selected两份原始XML逐字节一致。该结果不是图像，也不证明期间从未短暂出现总览、模型丢失或所有像素相同。

最后批次原样为 `input swipe 540 1231 540 1431 80; input tap 74 169; input tap 880 169`，单次shell rc0/空out+err、实际耗时0.149623s；之后一次UIA耗时2.350198s，随即`active()`失败，未到本场景截图/位置确认/选择URL成功分支。分号命令整体rc0只说明最后shell状态，不是两个监听器已执行或hidden→visible成功见证。

几何补充确认返回点在保存的返回按钮内，counter点在native按钮 `[817,106][943,232]` 内；但before-overview同时有clickable覆盖祖先 `[0,95][1080,2337]` 包含counter点。**坐标正确不证明实际事件到达下层按钮**；若返回监听器尚未完成，覆盖层可能接收最后一次点击，这只是待区分的时序假设。不能将“0个可见当前卡片”直接改写成“卡片被惯性甩出屏幕”。

对应 `functional5-final-review/`：`saved-failing-uia-analysis.json` SHA `6245f925cd017a7a163172cca96bc1f67450824cf9a62cd54099dad8aed720c0`；`rapid-reopen-geometry-supplement.json` SHA `427324a957092e2855110bb0809d76cf7226ce6219d036fbce8f97c04aedb3db`。task-54只hash cross-pin前者，不冒充独立重解析或根因认证。

#### 源码裁定与下一步边界

完成的另一只读子审确认：Activity675–678 counter监听器直接show；1182–1196门禁允许后，Switcher212–227先同步VISIBLE再做200ms动画。返回监听器Activity1170–1173/1199–1203及Switcher305–315同步GONE，没有应用层延迟关闭或动画结束隐藏。实际框架ACTION_UP→performClick调度未观测，不能宣称已证明排队竞态。

仍需区分：(1)最后tap未到达/未成为click；(2)counter执行但被interactive/null/已显示门禁拒绝；(3)show后被选择/Back/lifecycle等真实路径再次关闭。单独“已显示”门禁不足以解释最终native，还需要后续hide；选择当前卡片也可能保留原URL。inner ScrollView的停止/锚点辅助不直接改变overlay可见性。host fake performClick/post是同步/立即模型，1231项及18编译成功mutant拒绝不能解答真实输入路由问题。

**本轮不据此追加猜测性滚动修复、全局输入取消、延迟或新构建。** 最小下一步仅为另审的单次有界诊断提案：保持同一批次不变，取得返回监听器entry/exit、counter entry与确切show gate、所有后续show/dismiss/lifecycle原因的单调序列，并区分命中目标与监听器执行；若可得则补最终窗口/焦点身份及截图。该提案没有GO、未执行，不能追溯续跑F5；不得插入sleep/UIA屏障、重试或额外tap后倒算原测试通过。只有实际见证show且总览仍在，才进入活动卡片/scroll offset分支。子审转录与裁定 `rapid-reopen-source-review-and-next-step.json` SHA `97e3f6ad5e91487cafab1d34094a45ff35bf4b5eb2fae7485aa7ffddbdf532de`；root cause、residual inertia继续NOT_PROVEN。

#### 最终保全、包体和审查操作边界

关闭后的Lead source receipt SHA `ef32bb62f12dd11db08057e7dbd33ee28685b598a354dc4cbbde213a24b79af4`：36项source/test和16份F5脚本稳定；相对最初冻结仍仅6项变更、另30项不变；原16项tracked dirty中的另10项、HEAD/index、DNS及`diff --check`保持。这个是保全，不是运行通过；本次失败审查未再改产品源码。

Lead最终重核独审25个manifest成员及1180项input pins（1179个workspace内、1个精确glob工具spill），保存属性/字节/SHA一致；signed fix1在关闭后仍为372372507B、SHA `7a53ecf326a9a6e339d2c45e8ec3239ab0acff15edc06321a963ec552858a4d3`。只是包体保全，未再签名/安装/验签/测设备，不交付或提升这个失败APK。receipt `lead-final-independent-audit-pin-review.json` SHA `7359a221bf6b801ddb79b9dde3b02e8a4a68c3cb81a00b43369f181ecec93d8c`；顺序stable reads不是全局原子快照。

task-54 proceduralCompliance=false：一次带permission字段的edit在参数校验处被拒绝（无FS/approval/widening）、两次离线分类失败（PNG当UTF8、stdout.log当JSON）、一次生成器SyntaxError（文件创建前）及一次越界read均独列于`REVIEW-OPERATIONS-FINAL.json`，保留原稿/失败脚本；不与task-52三次历史拒绝混计，auditor预期rc2也不混作这些失败。Lead最终pin verifier另有一次rc1：workspace-only防线拒绝了最后一项真实glob spill；在read确认其前7行后，仅对该精确路径和SHA加入allowlist，纠正后exit0，第一次未创建receipt或读取该外路径。没有sandbox升级、live probe、runtime helper执行/import、guest、signals、删除或恢复重试。

**最终分层结论：源码/主机回归/Java-only构建/签名包体验证已有通过证据；功能首错未通过，失败case视觉未观测，完整日志scope仍pending，性能收益未建立。** cleanup与证据闭合已完成，不抵消上述边界；没有可作为本轮优化成果交付的通过版APK。
