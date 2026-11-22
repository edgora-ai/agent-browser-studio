# ABS Android：网页全屏与 PWA（rev16 r6 已签名并真机验收全屏项）

## rev16 r6 诊断与修复（2026-11-21 → 11-22，已修复并真机验收全屏项）

**白条根因已修复、r6 已构建签名，并已在用户真机完成保数据原位安装与全屏验收：三种全屏的白色安全区全部消失（竖屏视口 677→792、横屏 752→792、遮幅到达屏幕边缘），Back 退出行为与文档连续性不变，方向归因以实测闭合；PWA 正向仍缺受信任 HTTPS 来源（`NOT_RUN`），Muse/WebAudio 本轮未测。**

### r6 真机验收（2026-11-22 00:05–00:15，+08:00）

**结论：`FULLSCREEN_WHITE_BAR_FIXED_ORIENTATION_ATTRIBUTED_PWA_POSITIVE_NOT_RUN`。** 设备 serial `69a2181d`（USB transport 566，本轮从 exact serial 重验）。[总凭据][r6-phone-result] SHA-256 `e58c1afce7608b4c8a77d62e3b58866cb30ad6e4bd57c64d7952fd6dcf00930c`，41 份证据逐项哈希留档。

| 项目 | 实测结果 | 边界 |
| --- | --- | --- |
| 安装 | streamd 非增量 `-r --user 0`；读回 `base.apk` SHA-256 `b83b3f11…` 与候选一致；appId/CE/DE inode/首次安装时间/签名记录原样 | 数据身份连续性证明，非逐项数据审计 |
| 菜单全屏 | 进入视口 `360×677→360×792`，**白条消失**（截图内容从 y=0 开始）；Back 恢复 DEFAULT/677，同文档 `6dc06395` 无导航 | — |
| DOM 全屏 | 受信任 `fullscreenchange stage`，视口 `360×792` **白条消失**；Back `fs→null` 恢复，同文档 | — |
| 视频全屏（UA 控件） | 真实 UA 按钮（第一次 tap 被控件自动隐藏消耗、fs 保持 null 已验证后才重试：重新唤出后 0.9 秒内点中）；`fs=video`，视口 `792×360`（r5 为 752×360），**遮幅从 x=0 起（左缘像素纯黑，r5 是 120px 白条）**；两张截图烧录内容不同 + trace videoTime 前进 | — |
| 视频退出 | Back：`fs→null`、视口回 `360×677`、同文档、视频继续内联播放 | — |
| 方向归因 | 安装前（23:53）`user_rotation=1` 横屏锁；测试前（00:05）`user_rotation=0` 竖屏锁——**期间测试零输入，是用户个人使用（短信）期间改变**；视频退出后 `fs→null` 即回竖屏（跟随竖屏锁） | **归因闭合**：Chromium 退出设 USER 跟随系统锁，r5 卡横屏是当时锁横屏所致；产品无强制方向。`USER≡UNSPECIFIED` 结论维持 |
| HTTP PWA 拒绝 | 明确 toast「只能从已加载且连接安全的页面安装网页应用。」 | 回归通过；非正向安装 |
| PWA 正向 | **`NOT_RUN`** 无受信任 HTTPS 来源 | 提示/同意/桌面入口/作用域/离线均未验收 |
| Muse/WebAudio | **`NOT_RUN`** | — |
| 退出与清理 | 退出确认对话框核对（环境 ABSQA167K39）后单独确认；空闲文案「● 当前没有打开的环境 · 单环境运行」实证；配置保留；服务器 SIGTERM 后反向映射清空（attempt-2 清理凭据含 1 字节空列表证据；清理 JSON 因 mode-x 冲突由补写凭据说明） | — |

[r6-phone-result]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r6-phone-d2976fb5_/phone-acceptance.json

### 白色安全区：根因与修复

r5 证据（`$E` 的窗口转储与截图）显示：

- 窗口本身始终全屏：`frame=[0,0][1080,2376]`、`EDGE_TO_EDGE_ENFORCED`、`layoutInDisplayCutoutMode=always`，系统/窗口层没有保留区。
- 竖屏全屏视口 `360×752` = 792 − 40dp，即 WebView 顶部仍被加了 40dp（120px）padding；横屏全屏视口 `752×360`，同样的 120px 出现在摄像头开孔一侧（物理顶边）。
- 根因：`NativeBrowserActivity.applyPageFullscreenInsets` 在全屏时把 statusBars/navigationBars 的 inset 置零，但保留了 `displayCutout` 并作为 browserFrame 的 padding 应用；隐藏的栏不派发 inset，但 cutout 与栏可见性无关、始终上报，于是在全屏内容与窗口之间留下一条白色背景带（竖屏在顶、横屏在左）。

修复（Java 层，两处小改）：

- `withoutPageSystemBars`（R+ 分支）：把 `displayCutout` 与状态栏/导航栏一起在 `insets` 与 `insetsIgnoringVisibility` 中置零；窗口早已是 `cutout mode always`，全屏内容从此真正铺满整屏（打孔摄像头区域由内容覆盖，与 Chrome 全屏视频一致）。
- `applyPageFullscreenInsets`：fit 掩码去掉 `displayCutout`，只保留 `ime()` 与 `captionBar()`；键盘仍不遮挡，Q（API 29）回退分支不变（其 stable 清零做法本就等效全出血）。
- 三种全屏（菜单、DOM、视频）共用同一条 inset 路径，一处修复覆盖；非全屏路径（`super.onApplyWindowInsets`）未动，退出后栏位/几何恢复行为不变（r5 退出证据已证明）。

### 视频全屏退出后不回竖屏：责任边界结论

对 Chromium 152 源码与 ABS 内核的核对结论：

- 进入：横屏视频经 `MediaControlsOrientationLockDelegate` → `lock(LANDSCAPE)` → `ScreenOrientationProviderImpl.lockOrientation` → `setRequestedOrientation(SENSOR_LANDSCAPE)`，预期行为。
- 退出：`unlockOrientation()` 在没有 override 时把默认 Web 方向（DEFAULT）映射为 **`SCREEN_ORIENTATION_USER`**；由于不是 UNSPECIFIED，跳过 manifest 回读，直接 `setRequestedOrientation(USER)`——与 r5 退出后 `mCurrentAppOrientation=SCREEN_ORIENTATION_USER` 的读数一致。
- 但在自动旋转关闭时 `USER` 与 UNSPECIFIED 行为等价（都跟随用户旋转锁）：ABS manifest 未声明 `screenOrientation`，内核 Java/C++ 均无 `setRequestedOrientation`，应用侧没有强制方向，也谈不上把浏览器"锁"回竖屏。
- 退出后持续横屏的直接依据是当时系统状态 `accelerometer_rotation=0` + `user_rotation=ROTATION_90`（22:40 只读）；而 22:18 基线为竖屏，说明测试窗口内系统旋转状态发生过变化。测试未写任何设置（`settingsModifiedByTest=false`），测试前设置未记录（`baselineSettingNotRecorded=true`），**归因保持开放，不做断言**。
- 处置：不改方向逻辑、不用强制旋转掩盖；下一轮真机复测先记录 `accelerometer_rotation`/`user_rotation` 基线，再测进入/退出并对比（与交接文档第 8 节第 4 步一致）。

### 主机回归与构建状态

- `run-tests.sh` 全套通过：BrowserHistory 274、UI source-contract 917、fingerprint 13、lifecycle 1666、focus 463+17、palette 47、overview 1231（18 个行为变异对照全部拒绝）、system-bar 1976、font 1011、recovery **1023（31 个变异对照拒绝，含按新合同更新的全屏 inset 断言：全屏仅 fit IME/captionBar，cutout 随栏清零、不再保留白条区；Q 派发几何不变）**、network 760。
- 启动/存储合同：`FreshSessionLaunchContractTest` 256 checks、`StorageCleanupContractTest` 126 checks 通过（输出在 `.tmp-apk/proxy-fix-work/rev16-r6-{contracts,launch-contracts}-20261121/`）；PWA 夹具 13 项、staging 工具测试通过。

### r6 PWA 正向验收（2026-11-22 00:20–00:45，+08:00，已完成）

**结论：`PWA_POSITIVE_INSTALL_PIN_LAUNCH_SCOPE_PASS`。** 受信任 HTTPS 来源按夹具 README 前置条件就位：用户自有域名 hroze.org 两个子域（pwa-a/pwa-b）经用户自己的 Cloudflare 隧道（pwa-qa-r6）转发到 box 本机夹具；边缘证书 Google Trust Services 公共可信、无 interstitial；未导入信任、未降级 TLS。[来源搭建凭据][r6-pwa-setup]；[验收凭据][r6-pwa-result] SHA-256 `3febdd4ed73731dd248a93926226f690c1c2c588e798fa6ab5d8e77d8cf406e6`。

- HTTPS 安装页加载后菜单「安装网页应用」为启用态（与 HTTP 页的明确拒绝形成同一合同的两侧）；轻量安装入口条亦出现。
- 同意对话框名称/来源正确（`PWA fixture r6-e9ae3588 / https://pwa-a.hroze.org`）。**取消路径先行**：对话框关闭、无 pin 请求、无快捷方式产生，入口条恢复。
- 再同意后系统弹真实 pin 流程：ColorOS「创建桌面快捷方式」权限原为不允许（权限引导弹窗）——按最小权限设为**每次使用时询问**（应用级、可撤销，经系统设置 UI，全程留档）；随后启动器权限确认（使用时允许）→ 放置预览（1×1）→ 添加。ABS toast「已向桌面发送请求，需在系统提示中确认」未冒充成功。
- ShortcutService 记录：`shortLabel=PWA fixture r6-e9ae3588`、`longLabel=… · https://pwa-a.hroze.org`、`disabledReason=[Not disabled]`。
- **从桌面图标启动成功**：WebApp standalone UI（标题/来源/关闭钮）加载 manifest `start_url`（/start）。
- 越界（/app-x/out）：恢复普通浏览器 chrome（地址栏、新标签），WebAppBar 消失；返回作用域（/app/start）：chrome 保持、**不重新隐藏**——作用域合同与 rev16 设计一致。
- 收尾：环境退出（确认对话框一度由 PinnedWebApp Activity 承载——行为观察，非缺陷；空闲文案实证、配置保留）；夹具与隧道已停止；桌面图标保留为交付物（指向 QA 来源，长按可移除）。
- 未覆盖：离线使用（夹具按设计未缓存媒体，SW 合同仅主机测试）、Muse/WebAudio、WebApp × 关闭流程。

[r6-pwa-setup]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r6-phone-d2976fb5_/pwa-https-source-setup.json
[r6-pwa-result]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r6-phone-d2976fb5_/pwa-acceptance.json

### r6 正式构建与签名（2026-11-21 深夜，已完成）

**r6 已在原发布树正式构建并签名核验，状态 `FINISHED_SIGNED_RUNTIME_PENDING`——这是构建与签名结论，不是 Android 运行验收，也未做任何安装。** 用户指正构建主机后按同一 Java-only 流程完成：

- 构建主机 `ahoo@192.168.4.12 (box)`，发布树 `/home/ahoo/abs-native-work/chromium-build-152/src/out/abs-timezone-newyork`。构建前逐文件比对：43 个内核/管理源 + 14 个 core 源与工作树 SHA 全一致，唯一差异即本轮修改的 `NativeBrowserActivity.java`（r5 staged `25edc6ed…` → r6 `86f36532…`）；6 个 host-only 为 stage 工具排除的 WebView 旁路文件，另 2 个 host-only（`EngineBrowserActivity`/`EngineLaunchConfig`）为 r5 树既有产物，未触碰。
- 编译：depot_tools `autoninja`（`android_static_analysis="build_server"` 要求 autoninja 注入 `AUTONINJA_BUILD_ID`；直接 `ninja` 会失败），同步 Error Prone + validate_deps 通过；复跑 `no work to do` 确认后台分析收尾。javac.jar SHA-256 `39f14bcf…`，重编后的 `NativeBrowserActivity.class` 哈希与 r5 不同（正向证明来自新源码）。
- 打包：`agent_browser_product_apk` 三步（dex → final_dex → create），复跑 `no work to do`。
- 载荷核验（对比 r5 候选）：**仅 `classes.dex` 变化**（同长度、内容不同；`classes2.dex` 与 r5 逐字节一致），原生库 `libagent_browser_product.so` SHA-256 `1089c835…`、Build ID `72b77a98…` 与 r5 完全一致，`.so` 载荷偏移 `40353792` 仍 16 KiB 对齐；与未签名输入逐条目比对，签名后载荷零变化。
- 签名：`v6-signing/release_signing.py` 正式签名，APK Signature Scheme **v3** 验证通过，`CN=ABS Browser Release`，证书 SHA-256 `0f186dd7…` 与原发布一致，`debuggable=false`。
- **候选**：`ABS-Browser-v1.0.0-r13z-rev16-r6-arm64.apk`，372,486,412 字节，SHA-256 `b83b3f11ff512087f183b7f7dc7840f4ced30d78cc360ca818deda071805276c`。[完结凭据][r6-finished] 及主机编译/构建凭据副本在 `rev16-r6-build/`；主机端 `rev16-r6-java-synchronous-86f36532/` 保留 intent/compiled/built/ninja 日志。
- **保留**：按两版本规则在签名时退役 r5（哈希已记入退役凭据，手机侧 r5 安装/验收证据原样保留），移除 r6 未签名中间件；交付目录只留签名 r6 与已复验 rev15 回滚包。
- **未做**：未安装到任何设备、无真机/模拟器运行结果；r6 的白条修复与整体行为需真机复测验收（含旋转设置基线记录）。

[r6-finished]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r6-build/rev16-r6-finished.json

## rev16 r5（已按两版本规则退役；文件已移除，本节及下文为历史证据）

**r5 已正式构建、签名，并在用户确认后原位更新到 ARM64 真机；读回的 `base.apk` 与签名包完全一致，安装前后的应用数据身份保持不变。真机已证明菜单、网页及 Chromium 视频控件全屏的进入和一次 Back 退出，但整体验收仍未通过：视频退出后仍横屏、全屏保留白色安全区，PWA 正向安装/启动尚未实测。** `ABS-Browser-v1.0.0-r13z-rev16-r5-arm64.apk`，372,486,412 字节，SHA-256 `ccb2f8c52bb58c74d1ae2787a708ef3e58e1008aa4475a99d95dbde31f2ec51e`。仍用原发布证书，保留 rev15 WebAudio 修复。下文 r4 运行记录是历史证据，不计为 r5 结果。

- **全屏**：修复溢出菜单切换焦点使操作失效的问题。「全屏浏览」负责收起浏览器和系统栏，不冒充网页的 DOM 全屏；视频播放器自己的全屏按钮仍走 Chromium 原生路径。系统 Back 先退出全屏，避免误退页面。
- **安装网页应用**：满足要求的 HTTPS 页面会提供轻量安装入口，也可以从菜单发起。收起菜单后在原页继续，ABS 确认后仍由 Android 桌面处理固定快捷方式；请求已受理不等于桌面已安装。不替网站绕过安全、作用域或清单检查。
- **正式构建**：原发布树重编 Java（含 Error Prone 和依赖验证），再生成 DEX 并打包。与 r4 相比只有 `classes.dex`、`classes2.dex` 载荷不同；同一 ARM64 原生库、Build ID 和 16 KiB 对齐均已核验。[编译凭据][r5-compiled] SHA-256 `a8e30f0f7fb37169207e23e7c73f79a67a8f348f8a7d97b48225fc7c523297f6`；[构建凭据][r5-built] SHA-256 `62a495dd5f68d462d70f88b4bf1c98550544386a0b5dec124b81ba308c785525`；[签名完结凭据][r5-finished] SHA-256 `c1d77f0b15d6893be6df9df0cb8422d36e5abe00ba566a95c62788d506615e19`，状态 `FINISHED_SIGNED_RUNTIME_PENDING`。
- **主机回归**：通过焦点/生命周期测试、PWA 桥及独立页面合同测试和 13 项网页夹具测试；增加了不用网页脚本点全屏、只操作 Chromium 视频控件的用例。以上不替代 Android 真窗口与桌面态验证。
- **保留**：当前交付目录只留签名 r5 和经复验的 rev15 回滚包。旧 r4 的 [退役凭据][r5-r4-retired] 记录移除 372,465,664 个已分配字节，保留原哈希与运行取证；本地 r5 未签名中间件也已移除。没有重新保留 r4 APK 或复制模拟器磁盘。只留一套已停止的本任务 AVD，供后续不重装的验收使用。另核查了较早的工作副本：同名 v11 与发布包哈希不同，v13x/y 是不同的失败样本，现有相同字节的副本仍有关联取证或固定路径，不按文件名或体积删除。
- **r5 首次隔离启动（2026 年 11 月 21 日 03:38，+08:00）**：[原始记录及哈希][r5-first-boot]。禁止网络出口的沙箱内，模拟器报告 `Boot completed in 23500 ms`，但串口未观察到 Android shell 提示符；没有发送 guest 命令、没有安装 r5。原进程退出码为 0；功能验收仍为 `NOT_RUN`。
- **r5 串口诊断（2026 年 11 月 21 日 14:02，+08:00）**：[取证摘要及原始记录哈希][r5-uart]。新增 `-show-kernel -verbose` 后证实 QEMU 绑定 `-serial stdio`、内核启用 `ttyAMA0` 并正常输出日志。Android init 尝试启动 console 时，被处于强制模式的 SELinux 拒绝打开 `/dev/ttyAMA0`；不是提示符解析或启动等待不足。未改动 Android 安全策略、未写入串口、未安装 r5；原进程已正常回收。不能把系统已启动当作候选通过。
- **r5 实际安装（2026 年 11 月 21 日 17:00，+08:00）**：[安装及首次停点][r5-isolated-install]。`pm` 返回成功，读回安装后的 `base.apk` 哈希与签名 r5 一致，安装暂存文件已移除。提交本地夹具地址后，最后一次界面读取只剩 0.241 秒并超时；未证明该页面是否加载，未进入全屏或音频用例。ADB 和模拟器原进程已回收。
- **r5 冷启动读回（同日 18:45，+08:00）**：[读回及停点][r5-isolated-readback]。另一次冷启动核对原安装，没有重装，也没有重放夹具 URL。现有 Direct 环境卡片的打开输入已返回；观察前台浏览器时下一轮四段读取不足 8.8 秒，被测试工具拒绝。没有持久化该次窗口和界面读数，不能据此判定浏览器未打开或判定产品缺陷。未启动夹具；原进程已回收。
- **冷启动停点的离线回归**：[结果及源码哈希][r5-profile-offline]。合成的 7.90 秒读数复现了测试工具的嵌套限时问题：35 秒总窗口尚有余量时，16 秒内层窗口已放不下下一轮 8.8 秒观测。离线模型在同一总窗口内最多执行三轮只读观测，并保留首轮读数与预算拒绝记录，不重放点击。83 项离线 QA 测试通过（其中 14 项为新增），另有 13 项 PWA 夹具主机测试通过。未改动封存执行器或签名包；合成分支不能还原当时的 Android 界面，也不能替代实测。
- **提交地址后的离线回归**：[结果及源码哈希][r5-navigation-offline]，SHA-256 `7bb48e180a65609cf2ab48a5dbfd45e4416f700c0e350fc5d3ded0601ca038c7`。模拟两次编辑器切换分别到第 3、2 轮才就绪、页面到第 5 轮才被读到；按完整观测计算，导航需要 62 次 guest 调用，连夹具启动共 68 次。旧的 58 次导航规划会跳过第 5 轮；即使次数足够，慢读取仍可能受独立限时约束。用例验证只提交一次、读数不足保留原始片段与独立截图，且同一监听端的复核通过才承认页面加载。累计 94 项离线 QA、13 项 PWA 主机夹具测试通过。没有启动模拟器、重装或修改封存执行器；不能据此补记实际功能通过。
- **隔离模拟器待运行验收**：菜单、网页和视频全屏、各自的 Back 行为及同页 WebAudio 仍为 `NOT_RUN`。PWA 取消、确认、桌面实际启动及作用域/离线也为 `NOT_RUN`：尚未确认供该隔离模拟器使用、已受信任且获授权的 HTTPS A/B 测试来源。此前的隔离模拟器回合未使用真机；该状态不覆盖下方新增的真机结果，也未用真机结果补记模拟器通过。

## r5 真机实测（2026-11-21，+08:00）

**结论：`PARTIAL_ACCEPTANCE_PWA_POSITIVE_NOT_RUN`，不是全项通过。** 用户选择「现在更新并实测」后，在 OnePlus PKG110 / Android 16 ARM64 上做了一次保数据原位安装。[安装身份凭据][r5-phone-install] 记录 APK SHA-256 与上方 r5 一致，`appId`、CE/DE 数据目录 inode、首次安装时间及签名记录保持不变；这不是对每份用户数据内容的逐项审计。

只新建并运行本次 Direct 环境 `ABSQA167K39`，使用不含外部资源、账号、存储或服务工作线程的自有 HTTP 页面和无声合成视频。不进入日常环境或私人标签页，不发起真实 Muse 通话、消息或麦克风采集。完整 [真机验收清单及 50 份证据哈希][r5-phone-result] SHA-256：`bcbcacd45f857dacc101acd868820876e78e0167a7babb80ae2dcb2a09e5fc9e`。

| 项目 | 实测结果 | 边界 |
| --- | --- | --- |
| 菜单「全屏浏览」 | **进入/退出通过**。原生工具栏及系统栏控件隐藏；DOM `fullscreenElement` 始终为 `null`，未产生 `fullscreenchange`；视口 `360×677 → 360×752 → 360×677`。 | 恰好一次 Back 恢复竖屏浏览器 UI，没有退走页面；仍有下述白色安全区。 |
| 网页 DOM 全屏 | **进入/退出通过**。受信任的 `stage → null` 事件、截图及同一文档互相印证。 | 一次 Back 后恢复竖屏 UI 和基线视口，没有导航。 |
| Chromium 视频控件全屏 | **控件进入及 Back 退出通过**。点击的是真实 UA `enter full screen` 按钮，而非网页脚本；受信任的 `video → null` 事件。 | 全屏截图中烧录帧号 `74 → 128`、画面和时间 `04.933 → 08.533` 实际变化，证明不是静止画面。 |
| 视频退出恢复 | **部分通过**。一次 Back 恢复工具栏、状态栏及导航控件，保持原 URL/文档。 | 稳定观察仍为横屏 `2376×1080 / ROTATION_90`，约 171 秒后亦然，不能称作瞬态或完全恢复竖屏。只读到当前系统为锁定横屏，未记录测试前该设置，不能据此认定原因；没有修改旋转设置。 |
| 系统栏与安全区 | **控件隐藏/恢复有视觉及所属窗口行为证据**，`DEFAULT → SHOW_TRANSIENT_BARS_BY_SWIPE → DEFAULT`。 | 竖屏全屏顶部仍有约 120px 白条，横屏时在左侧；不记作真正铺满屏幕，亦未补记精确系统栏请求位和完整 InsetsState 合同通过。 |
| HTTP 页安装网页应用 | **拒绝路径通过**。从菜单实际点击后，截图显示「只能从已加载且连接安全的页面安装网页应用。」 | 只能证明该 HTTP 页被明确拒绝；不是可安装 HTTPS 页的自动提示或安装成功。 |
| PWA 正向安装/启动 | **`NOT_RUN_NO_AUTHORIZED_TRUSTED_HTTPS_FIXTURE`**。 | 缺少已授权且证书受信任的 HTTPS 夹具；ABS 同意/取消、桌面新固定入口、该入口启动、作用域和离线均未通过运行验收。没有降低 TLS 要求。 |
| 本轮 Muse / WebAudio | **`NOT_RUN`**。 | 不用之前修复或主机回归代替本轮真实通话验收。 |

### 文档、输入和清理核对

- 三种全屏退出后均为自有 `/check` 页，文档 nonce `d2df13a4-bb36-4dff-9fc4-b9b71e1533ec` 不变。初次 `pageshow` 之后，监听记录中的 `pageshow/pagehide/popstate` 计数保持 `1/0/0`；原生菜单没有冒充 DOM 全屏。夹具到期后不再有新监听数据，后续稳定截图仅用原生 URL、焦点及文档文本核对，未把旧 `traceLast` 当作实时读数。
- 菜单是 ABS 自有焦点弹窗。通用浏览器焦点守卫曾在弹窗处正确停止；确认弹窗属于同一浏览器 Activity / UID 后才点击其确切条目，没有放宽全局守卫或重放输入。横屏下退出条目起初位于菜单滚动区域外，一次自有弹窗滚动后才点击；进入管理页后的具名退出确认单独核对并确认，没有重复退出菜单点击。
- [退出与空闲凭据][r5-phone-exit] 已独立观察到「当前没有打开的环境 · 单环境运行」。仅退出本次自建环境，没有删除配置、清数据、卸载、强停个人环境或改系统信任/网络设置。
- 720 秒有界夹具进程退出码为 0，输出已收集；[反向映射清理凭据][r5-phone-route-cleanup] 为 `removed-and-verified`，只移除自有 `tcp:60084` 映射，最终只读列表为空。保留一份活动签名 r5 和一份已验证 rev15 回滚包，没有增加 APK 或模拟器磁盘副本。

[r5-phone-install]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-phone-1iampnp_/install-verified.json
[r5-phone-result]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-phone-1iampnp_/phone-acceptance.json
[r5-phone-exit]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-phone-1iampnp_/owned-environment-exit-confirmed.json
[r5-phone-route-cleanup]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-phone-1iampnp_/route-cleanup.json

[r5-navigation-offline]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-navigation-budget-offline.json
[r5-profile-offline]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-profile-handoff-offline.json
[r5-isolated-install]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-isolated-install.json
[r5-isolated-readback]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-isolated-readback.json
[r5-uart]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-uart-diagnosis.json
[r5-first-boot]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-isolated-boot-first/archive.json
[r5-compiled]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-production-compiled.json
[r5-built]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-production-built.json
[r5-finished]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-finished.json
[r5-r4-retired]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-r4-retired.json

## 历史：rev16 r4

**rev16 r4 已按要求在原发布树完成正式构建，并使用原发布证书签名、核验。** 2026 年 11 月 20 日 20:45:03（+08:00）的[完结凭据][r4-finished]状态为 `FINISHED_SIGNED`。这是构建和签名结论，不是 Android 运行验收。本轮运行测试只在隔离模拟器进行，不使用真机、不发起真实通话。

## 正式构建、签名和回滚包

| 用途 | APK 文件名 | 字节数 | APK SHA-256 |
| --- | --- | ---: | --- |
| rev16 r4 签名候选 | `ABS-Browser-v1.0.0-r13z-rev16-r4-arm64.apk` | 372,462,896 | `59d9e52c085788930ac0fbb539af03e24d6a0c3efafa5ac547a762b35c0dbdd1` |
| rev15 回滚包（[已复验][r4-rollback-reverified]） | `ABS-Browser-v1.0.0-r13z-rev15-webaudio-arm64.apk` | 372,372,507 | `0b77b4ae8e29b638e45398faadf4ebde82add3ef203186e3b96e587b484e7662` |

- [构建复核][r4-built-verified]：原发布目录 `out/abs-timezone-newyork` 完成正式编译、链接及打包；复核了源码与 JNI 注册，`ninjaNoWork` 和 `releaseNoWork` 均为 `true`。
- [签名包复核][r4-signed-verified]：包名 `com.ahoo.abs.browser`，非调试包；核验了 Manifest 私有快捷方式入口、三份 DEX、ARM64 原生库及 16 KiB ZIP 对齐。r4 与复验的 rev15 各通过单一签名者的 APK v3 签名验证，原发布证书 `CN=ABS Browser Release` 的 SHA-256 为 `0f186dd70f80892e04443b7105842eef2ac9e641e9ecefa15015158317f1402f`。
- 完结凭据确认签名包的有效载荷与已核验的未签名产物一致。r4 包内 `libagent_browser_product.so` 的 ELF Build ID 为 `72b77a9816ec37d906de8cd6cba7d97753371514`，SHA-256 为 `1089c8359789f747aaea98a1d7e25e6c0a42f43eee055b656c3488fe7bd6407e`。未签名中间产物的 APK SHA-256 为 `50076a10b5a95e045e4b71d42360e9dc525284b9c5a38eff4b0ebfd30e2df275`，不是签名候选。

## 功能范围（设计行为）

- **网页和视频全屏**：处理 Chromium 当前标签的原生全屏通知，全屏时收起浏览器和系统栏；返回先退出全屏，再处理页面历史。切换标签、显示覆盖层、文档替换或渲染进程退出时，撤销旧页面对全屏的控制。不强制旋转，也不把普通页面伪装成 DOM 全屏。
- **安装网页应用**：在合格 HTTPS 页的菜单中选择「安装网页应用」，核对名称和来源，经系统桌面确认后添加入口。从桌面打开时，在原 ABS 环境中新建专用标签，先绑定作用域，再加载清单的 `start_url`；共享该环境的站点存储及 Service Worker。离开可信作用域后恢复普通浏览器控件，返回作用域也不会重新隐藏；关闭专用标签不靠重放 POST 恢复原页。**这是系统桌面固定快捷方式，不是 WebAPK，也不另装 APK**；不保证任意网站可离线使用。

## rev16 r4 模拟器验收（仅模拟器）

- **原位安装已验证。** 2026 年 11 月 20 日 22:11（+08:00），Android 15 ARM64 隔离模拟器由预装版本更新至签名 r4，Package Manager 返回 `Success`，核对设备内 `base.apk` 的 SHA-256 与交付包一致，安装暂存文件已删除。见[安装凭据][r4-emulator-install]。
- **首轮运行测试未覆盖功能。** [首轮记录][r4-emulator-first-ui]显示环境管理器及「新建环境」表单已打开；表单切换期间窗口焦点发生变化，验收脚本在接受层级或进一步触摸前停止。没有将该脚本停止记为产品崩溃。模拟器已由测试进程正常停止。
- **第二轮确认未重装。** [复测记录][r4-emulator-profile-timeout]显示从同一任务模拟器冷启动后再次核对了 r4 哈希。环境管理器处于前台时，读取界面层级超时，最后一组读取未获得 XML。该记录不能证明环境是否已保存，因此后续先查找同名测试环境，不重放保存。两轮停止均无 WebAudio、全屏或 PWA 功能结论。
- **第三轮通过 WebAudio 与测试页切换。** [运行记录][r4-emulator-audio-run]确认同一模拟器中的 r4 哈希未变，打开了按名称唯一匹配的测试环境，没有重装或重新保存环境。[音频数据][r4-emulator-audio]记录两份不同文档：依次改变声道 `2→1→4→4→8→2→2`，以及从构造参数起步的 `6→1→6→6→2→2`。旧 rev14 在 `2→1` 时可复现 [Muse 日志中的 Chromium 线程断言](android-r13z-rev15-webaudio-2026-11-19.md)；r4 两组均以 48 kHz 运行，每阶段至少 3,840 帧，非法声道数正确拒绝，测试时段的崩溃缓冲区无记录。这是合成音频回归，不是真实 Muse 通话。
- **第三轮的全屏与 PWA 未运行。** [全屏首个停止凭据][r4-emulator-fs-baseline]显示测试服务接受的页面请求为 0，无文档事件、截图或全屏输入。该轮停在测试页基线，不能据此判断产品的全屏行为；未进入 PWA 阶段。
- **第 8 次启动停在测试地址输入。** [运行记录][r4-emulator-fs-loopback]显示输入长地址时 ADB 超时，未读回地址、未提交 Enter，测试服务未收到页面请求。未重发输入，模拟器已停止并清理该次反向转发。没有产品功能结论。
- **第 9 次启动验证了文档全屏、返回及 DOM 元素进入全屏。** 同一签名包和测试环境，未重装、重建环境或重跑音频。[导航凭据][r4-emulator-fs-compact-nav]记录完整读回短地址、一次 Enter、隐藏键盘和唯一页面请求；随后[全屏凭据][r4-emulator-fs-compact]记录同一文档、窗口 `f403142`、Activity `54807e1`、任务 `41` 和浏览器 PID `3118`。四张原始截图均人工复核：基线和文档返回后可见工具栏、状态栏及底部导航栏；文档和 DOM 元素进入全屏时三者均隐藏。两张全屏图顶部仍有 **95 px 的 `captionBar` 区域**：窗口转储中的范围和截图一致，产品保留此类安全区；不是状态栏，也不是无留白的边到边全屏。
- **第 9 次启动未发送 DOM 返回。** 测试在发送 DOM 用例的系统 Back 前因焦点不符停止。`Back-attempt` 是验收脚本意图，不是按键已发送。随后全屏取证的 ACT 仍显示原窗口和已隐藏的两条系统栏；真正拒绝 Back 的独立焦点读数未保存，不能用别的时刻推断具体变化，或把第 10 次捕获的系统窗口归因到本次。没有视频和 PWA 记录。四张截图及对应窗口转储已按原哈希[归档][r4-emulator-fs-compact-archive]。该次转发已移除，模拟器已正常停止。
- **第 10 次启动确认文档 Back 有效；停止点因 Android 提示而非 Back 失效。** 2026 年 11 月 21 日 00:05（+08:00），同一签名包及现有测试环境，未重装、重新保存环境或重跑音频。测试服务恰好处理了一个页面 GET；[原始验收凭据][r4-emulator-fs-backdiag]记录同一文档，窗口 `dd2b632`、任务 `43`、浏览器 PID `3218`。在可信点击进入 DOC 全屏后，seq 7 记录 `fullscreenElement=html`，原窗口和 PID 下的[基线][r4-emulator-fs-backdiag-baseline]、[全屏][r4-emulator-fs-backdiag-full]两张 1080×1920 原图人工核对：工具栏、状态栏和导航栏从可见变为隐藏，IME 未出现，顶部独立 95 px 窗口标题区域保留。发送一次原生 `KEYCODE_BACK`，记录 `OWNER_CALLBACK_RETURNED`；同一文档和同一次全屏请求在 seq 8 上报 `fullscreenchange`、`fullscreenElement=null`、浏览器模式，未再次导航或重放 Back。
- **第 10 次启动的第一个失败发生在 Back 之后的截图前置检查。** `doc-back` 阶段第一次原生读取报 `not-exactly-one-focused-browser-window`。[窗口原始转储][r4-emulator-fs-backdiag-act]中 ABS 仍是恢复、可见的 Activity 和焦点应用（`cf199b8`），但实际显示 0 的焦点窗口是系统 `ImmersiveModeConfirmation`（`ad9525d`）。同次原始数据可见状态栏与导航栏恢复、IME 隐藏；没有取到浏览器重新获得窗口焦点后的截图或稳定视口读数。`last-screencap.bin` 与 Back 前的 `doc-full.png` 同一哈希，不是返回后或提示截图。不能据此判定提示何时触发、已确认，或浏览器工具栏和视口已稳定恢复；该次未进入 DOM、视频或 PWA 阶段。
- **隔离通道停止。** [本次转发清理记录][r4-emulator-fs-backdiag-reverse]是 `premature ADB EOF`，没有确认反向转发已经移除；[运行结果][r4-emulator-fs-backdiag-result]中 `continuation.priorReceiptHashes` 指向第 9 次启动的清理凭据，不能用于本次。任务进程正常退出（`STOPPED_OWNED_EMULATOR`、退出码 0、未保存快照）。[仅主机核验][r4-emulator-post-backdiag-host]显示原隔离 ADB 进程身份检查返回 `da_process:ESRCH`，指定回环端口可绑定。不能据此推断 ADB 退出原因；未重启或替换原服务，未使用默认 ADB 或接触真机。
- **磁盘清理。** 已删与最终签名包的 527 个非签名载荷逐项相符的本地未签名中间件（按分配块 372,412,416 字节）。另删一份旧 candidate5 临时 APK，逐字节一致的历史交付件与签名凭据保留；[清理记录][r4-history-prune]实测仓库所在卷可用空间增加 369,999,872 字节。rev12 未签名输入与 r12b 的确切路径仍有历史构建或回滚引用，不删；只保留 r2 作为后续测试用 AVD，不删除含不同首轮启动状态的旧 r1 诊断盘。未改动两份 AVD、原始 AVD、SDK 或共享的外置镜像。
- **当前交付目录**只有活跃签名候选与经复验的 rev15 回滚包。取证归档只有窗口转储、截图与校验清单；没有复制 APK、扩建测试盘或保存快照。

**验收边界。** 文档进入全屏、原生 Back 退出和 DOM 元素进入全屏已有证据；DOM 返回及视频进入/返回未验证，完整七图矩阵未通过。PWA 没有桌面确认、桌面启动或独立模式的运行凭据；源码和主机测试不等于这些动作已验证。原隔离通道缺失时不重放旧动作；新的隔离补测应把 Android 系统提示验证与浏览器全屏矩阵分开，不放宽焦点判断。PWA 的作用域退出及返回、POST 不重放和 Service Worker 等场景还需已信任的两个专用第一方 HTTPS 来源，未为测试更改设备信任。

## 历史：前期源码与主机验证

| 层级 | 当时结果 | 边界 |
| --- | --- | --- |
| 产品源码冻结 | 85 个输入，922,433 字节；`sourceSha256` 为 `bd2fbcbbd1ea4c4f7cdc730d9bbee56c31818443196b4350ed456d0aaca212bd`。staging 测试 18/18 通过。 | 这是早期源码标识，不是 r4 源码指纹或 APK 哈希。相对 rev15 新增 6 项、修改 7 项，无删除。 |
| Java | Android SDK 36 / JDK 17，57/57 个产品 Java 文件编译通过；首轮发现的 3 处类型注解位置已修正。 | 含 34 份仅用于类型检查的依赖声明；该轮不等于生产 GN、DEX 或 JNI 注册通过。 |
| 主机回归 | 原生浏览界面、生命周期等 12 组共 10,105 项检查通过；另有 45 个行为变异被测试检出。启动交接契约 256 项通过。 | 不是 Android 的真实窗口、桌面或手势测试。 |
| PWA 注册库 | 实际产品 Java 通过两条主机 SQLite 连接执行；9 组 77 项断言通过。两方同时消费同一票据时只有一方成功；无外键违规。 | Android API 使用适配层；不证明 OEM 桌面能固定或启动该入口。 |
| 原生与测试网页 | 新 C++ 桥通过 Android ARM64 API 29 语法检查；两个 Mojo 接口生成成功，实际 Chromium GURL 上的 31 个作用域用例通过。[测试网页](../../mobile/android/native-kernel/tests/pwa-fullscreen-fixture/README.md)的 12 个主机测试通过，零跳过。 | 该阶段未链接 Android 原生库。网页测试使用内存请求和脚本桩，不是两个受信任 HTTPS 来源上的运行验证。 |
| 发布构建基线 | 2026 年 11 月 19 日 23:23（+08:00）挂回原 128 GiB 发布盘；内核完成常规日志回放。23:30 复核 109 个已知指纹（含原 APK、原生库、WebAudio 对象）全部一致，原目录的 Ninja 报告无需重建。 | 在真实前像上重整补丁并登记 Blink 头文件；28 个路径经严格正向、反向和再次正向应用，逐个比对还原。该阶段补丁 SHA-256 为 `223f04619730a4156fdd62dd6a4eacaab1f0fed4121c2f6197c9c174892991b6`，不属于上表早期源码冻结。此项不是 Android 运行验收。 |

## 原发布树上的进展（2026 年 11 月 20 日，+08:00）

| 修订 | 实际运行结果 | 首个失败或验证边界 |
| --- | --- | --- |
| r1 | 真实 GN 构建的 57 个产品 Java 源文件和 JNI 桥编译通过（30 个构建步骤）；补上了 JNI 源码包依赖。 | ARM64 编译器拒绝 Chromium 公共头里带默认实现的内联虚方法。r2 把实现移到 `.cc`，没有降低编译检查。 |
| r2 | 00:24，13 个目标对象（含 Java→C++ 注册、PWA 桥和 Blink 文档/显示模式）编译通过。 | **不是链接失败。** 随后的检查只认普通 JNI 名称，未识别发行构建把多个方法合并到一个入口的分派方式，主动停止在链接之前。 |
| r3 | 修复两个 PWA 边界：合法的本地文档替换只从原文档继承已授予的角色，替换后再核对实际来源；只有独立启动的专用标签禁用预渲染，普通标签不受影响。相对 r2 只改两个 C++ 文件；真实前像上的完整及增量补丁均通过正向、反向、再次正向检查。主机[源码提取测试](../../mobile/android/native-kernel/tests/standalone-replacements/README.md) 102 项通过，旧版两个失败用例均可复现，15 项故意破坏保护条件的测试均检出；使用的是替身对象。 | 08:08:50，原发布树的[首个原生编译失败][r3-first-native-failure]：`document_loader.cc:773`，`no matching conversion for static_cast from 'WebURL' to 'GURL'`。r3 未进入完整链接，也未产出 APK。 |
| r4 | 在同一发布链上只修改 `document_loader.cc`，以显式 `GURL(KURL(params->url))` 取代直接的 `static_cast<GURL>(params->url)`。原发布树完整构建通过，原发布证书签名及包内容复核通过。 | 候选已在隔离模拟器上安装并核对装后哈希；功能覆盖见上文。 |

完结凭据中的 `parentCutSha256`（r3）为 `0dcc735f11c780a230c5612a9c72e0c586dd54b8004eed0e79900daac019205e`，`cutSha256`（r4）为 `f0c24a01e44cb6836951ba42078b955ec8e6045956a8ab05e2e9ed9d06b6ac1c`。两者都是源码指纹，不是 APK 哈希。[r3 历史补丁凭据][r3-cut]中的补丁 SHA-256 为 `f18adcfd2d56c1c30231e9a0f12d3a8198de703bd9529f6c01b59844b5b5a0ba`；[r4 源码凭据][r4-cut]对应的[产品补丁](../../mobile/android/native-kernel/chromium/product-pwa.patch) SHA-256 为 `0bff6bf5dea44aa9faed305cbb793946427af2d25ef86a04affa58b166cb76e2`。

## 历史：发布门禁和原机记录

- **JNI 与归档门禁（主机检查）**：用实际 JNI Zero 生成物和 ARM64 对象核对了四条 Java→C++ 分派、回调签名、强定义及逐类生成源码。生成物语义检查 39/39；逐类源码包、`.72` 归档出处和驱动拼装的本机检查 18/18（`rev16-r3-host-release-gates.json`）。发布树为以空 Git tree 播种的归档检出；门禁改为核对播种提交、标记及两份上游文件的 Git blob 和 SHA-256。这些主机测试未在发布机执行。
- **早期连接与恢复方案（已成为历史）**：2026 年 11 月 20 日 01:41（+08:00）的本机预检记录为 SSH 超时且未解析到原发布机的链路层邻居；当时未取得远端 r3 启动确认，早于上表的实际编译。原恢复方案要求持原锁复核 r2 的 144 项闭包并仅对确认的前像应用增量；本机 `content/shell/BUILD.gn`、`content/shell/browser/shell.cc` 与发布前像不同，不能用 staging 整树替代原发布树。此方案不是 r4 的待办项。
- **隔离测试准备（主机检查）**：自建 macOS 进程、文件和套接字的所有权检查 23/23（`rev16-r3-isolated-adapter-kernel-check.json`）；该轮没有连接真实 Android，不是设备验收。
- **原机 rev15 / Muse（仅历史）**：2026 年 11 月 20 日 00:43（+08:00），核对当时已安装的 [rev15 通话崩溃修复版](android-r13z-rev15-webaudio-2026-11-19.md) APK 与装后应用数据标识一致；当时屏幕锁定，记为 `NOT_RUN_ENVIRONMENT_KEYGUARD_SHOWING`。该轮未启动 ABS 或 Muse、未操作其他应用、未发起通话。WebAudio 断言的旧包复现、新包未复现来自同一模拟器用例，不是 Muse 真机入口或通话通过的证据；不据此推断原机当前状态。

历史凭据：原机安装、前台和发布机连接记录位于 `.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/`（`phone-install-verified.json`、`phone-rev15-foreground-*.json`、`rev16-builder-preflight-*.json`）。`rev16-r3-resume-scripts.tar.gz` 仅封存脚本和已哈希的源码增量（210,898 字节），不含 APK、设备数据或磁盘镜像。主机临时目录中的 `abs-product-javac36-XGlvLhBx/RESULT.md`、`abs-native-history-sync.RNQTih/integration-final.yH0WZH/run.log` 和 `webapp-registry-smoke.sSlpHsMr/RECEIPT.md` 分别记录编译、界面回归和数据库测试。

[r4-finished]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r4-finished.json
[r4-built-verified]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r4-built-verified.json
[r4-signed-verified]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r4-signed-verified.json
[r4-rollback-reverified]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r4-rollback-reverified.json
[r4-emulator-install]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r4-emulator-install-observed.json
[r4-emulator-first-ui]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-631e16c53983/result.json
[r4-emulator-profile-timeout]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-158e853c12e2/result.json
[r4-emulator-audio-run]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-c6e175ff074e/result.json
[r4-emulator-audio]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-c6e175ff074e/audio.json
[r4-emulator-fs-baseline]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-c6e175ff074e/fullscreen-first-failure.json
[r4-emulator-fs-loopback]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-d866b0a6eed1/result.json
[r4-emulator-fs-compact-nav]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-43d45f6097bb/fullscreen-navigation.json
[r4-emulator-fs-compact]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-43d45f6097bb/fullscreen-first-failure.json
[r4-emulator-fs-compact-archive]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-43d45f6097bb/native-evidence/archive.json
[r4-emulator-fs-backdiag]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-7ece6e708e64/fullscreen-first-failure.json
[r4-emulator-fs-backdiag-act]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-7ece6e708e64/native-evidence/last-activities.txt
[r4-emulator-fs-backdiag-baseline]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-7ece6e708e64/native-evidence/baseline.png
[r4-emulator-fs-backdiag-full]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-7ece6e708e64/native-evidence/doc-full.png
[r4-emulator-fs-backdiag-result]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-7ece6e708e64/result.json
[r4-emulator-fs-backdiag-reverse]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/runtime-r16-7ece6e708e64/fullscreen-reverse-cleanup-failure.json
[r4-emulator-post-backdiag-host]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r4-post-attempt10-host-state.json
[r4-history-prune]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r4-history-prune-result.json
[r3-first-native-failure]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r3-first-native-failure.json
[r3-cut]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-release-cut-r3.json
[r4-cut]: ../../.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-release-cut-r4.json
