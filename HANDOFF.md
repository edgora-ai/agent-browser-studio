# ABS Android rev16 r6 — 全屏安全区修复交接

更新时间：2026-11-22 10:45（Asia/Shanghai，+08:00）。

> **先读结论：手机上现在跑的是 r8（`85bd0034…`，已安装来源不再弹被动安装提示，数据身份连续）。已真机验收：三种全屏白条消失、方向归因闭合、PWA 正向全链路 PASS、用户两条 UI 反馈修复（standalone 顶栏只留应用名；安装条改单行细 chip）。r6 已按两版本规则退役留档。** 仍未验收：Muse/WebAudio 真实通话、离线使用、WebApp × 关闭流程、transient-bar 覆盖视觉。不要写成"全部修好"。
>
> PWA 来源：hroze.org 双子域（用户自有）经用户 Cloudflare 隧道 pwa-qa-r6 → box 夹具，边缘证书公共可信；验收后夹具/隧道已停，DNS CNAME 未删，桌面图标保留（交付物）。凭据：`phone-acceptance.json`（`e58c1afc…`）、`pwa-acceptance.json`（`3febdd4e…`）、`pwa-https-source-setup.json`，均在 `rev16-r6-phone-d2976fb5_/`。

## 1. 用户目标与授权边界

- 最初问题：Muse「网页已中断」、菜单/网页/视频全屏无效、PWA 不提示安装。
- 用户要求过「先修复完，然后再安装」「自己搞，别指挥我」「先打好包等晚上测试」「上班去了，你用模拟器跑通吧」。
- 最近用户说「真机就绪，跑一下看看」，在已告知更新会关闭后台 ABS 后，明确选择「现在更新并实测」。本轮据此原位安装了一次 r5，并只测试自建 Direct 环境。
- 最新请求只是「写一个 handoff 文件」，不是再次安装、操作个人环境、拨打电话或改变设备设置的授权。
- 保存个人配置、网站数据及私人标签页。不得清数据、卸载、root、绕过锁屏、重置 ADB、降级 TLS/改信任、改 IME/VPN/系统旋转设置，也不发起真实通话/消息或麦克风采集。
- 新一轮有设备输入前必须重新核对 USB 身份、boot、解锁/唤醒状态、前台焦点、当前测试环境和新鲜几何。遇到不认识的运行/启动/退出环境或切换确认就停。

## 2. 工作区与索引

- 工作目录：`/Users/ahoo/workspace/roxy-lite-cloak-oss`。
- HEAD：`a2564fb4878f`。工作树已有大量未提交产品修改，**不要 reset/checkout/clean，也不要把它们当成本次 handoff 的改动**。
- 本轮真机测试没有修改产品源码，只新增测试辅助/证据并更新了 review。handoff 请求仅新增本文件。
- 主报告：[android-r13z-rev16-fullscreen-pwa-2026-11-19.md](docs/review/android-r13z-rev16-fullscreen-pwa-2026-11-19.md)。优先读该文件的「r5 真机实测」一节，下面的 r4 均是历史记录。
- WebAudio/Muse 修复背景：[android-r13z-rev15-webaudio-2026-11-19.md](docs/review/android-r13z-rev15-webaudio-2026-11-19.md)。
- 保留规则：[AGENTS.md](AGENTS.md)。

后文路径缩写（只是路径声明，不是要执行安装或测试）：

```bash
ROOT=/Users/ahoo/workspace/roxy-lite-cloak-oss
W="$ROOT/.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W"
E="$W/rev16-r5-phone-1iampnp_"
```

## 2b. r6 本轮进展（2026-11-21 深夜）

- **白条修复已实现并已进入 r6 签名候选**：`mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel/NativeBrowserActivity.java` 两处——`withoutPageSystemBars` R+ 分支把 `displayCutout` 与状态/导航栏一起在 `insets`、`insetsIgnoringVisibility` 置零；`applyPageFullscreenInsets` fit 掩码只剩 `ime()|captionBar()`。Q 分支不变（本就等效全出血）。三种全屏共用此路径，一处覆盖；非全屏路径未动。
- **方向问题结论**：进入=Chromium 对横屏视频锁 `SENSOR_LANDSCAPE`（预期）；退出=`ScreenOrientationProviderImpl.unlockOrientation()` 无 override 时落到 `SCREEN_ORIENTATION_USER`（Java `content/public/android/.../ScreenOrientationProviderImpl.java:216-247`，DEFAULT→USER 且跳过 manifest 回读）。ABS manifest 未声明 `screenOrientation`、内核无 `setRequestedOrientation`——应用侧无强制方向。`USER≡UNSPECIFIED`（旋转锁关闭时都跟随用户锁），横屏卡住由系统状态 `accelerometer_rotation=0 + user_rotation=ROTATION_90`（22:40 只读）决定；基线 22:18 竖屏说明窗口内系统旋转状态变过、测试前设置未记录，**归因开放**。下一轮先记录旋转设置再复测（第 8 节第 4 步），不用强制旋转掩盖。
- **主机回归全过**：`run-tests.sh` 全套（recovery 1023 含按新合同更新的全屏 inset 断言、system-bar 1976、UI source-contract 917、lifecycle 1666、focus 463+17、overview 1231、font 1011、palette 47、BrowserHistory 274、fingerprint 13、network 760、store 22/978）；存储合同 126、启动合同 256、PWA 夹具 13、staging 工具测试通过。输出：`.tmp-apk/proxy-fix-work/rev16-r6-{contracts,launch-contracts}-20261121/`。
- **r6 已安装并完成全屏验收（2026-11-22 00:05–00:15）**：用户明确授权「真机安装 并验证」。保数据原位安装（streamed、非增量、`-r --user 0`），读回哈希一致，数据身份连续。三种全屏白条全部消失（竖屏视口 792、横屏遮幅到 x=0），Back/文档连续性/PWA HTTP 拒绝回归正常，方向归因闭合（见先读结论）。复用了自有环境 ABSQA167K39 并已干净退出（空闲文案实证、配置保留）。**总凭据 `rev16-r6-phone-d2976fb5_/phone-acceptance.json`，SHA-256 `e58c1afce7608b4c8a77d62e3b58866cb30ad6e4bd57c64d7952fd6dcf00930c`，41 份证据哈希留档。** 未验收：PWA 正向、Muse/WebAudio、transient-bar 覆盖视觉。设备输入纪律：一次性意图留档，含一次确定性失败投递（无效 keyevent 语法、零送达）后才用正确语法重试；无盲目重放。夹具两次实例（720s 有界、仅回环），最终反向映射清空（1 字节空列表证据留档）。
- 诊断与修复的完整记录（含证据引用）：[android-r13z-rev16-fullscreen-pwa-2026-11-19.md](docs/review/android-r13z-rev16-fullscreen-pwa-2026-11-19.md) 顶部「rev16 r6 诊断与修复」一节。
- HTTPS PWA 夹具仍为 HOST ONLY：`fixture.py` 已支持 operator 供给的受信任 HTTPS A/B 来源（见夹具 README 前置条件：合法 TLS 链、无 interstitial、不装证书、不降级 TLS）；受信任来源仍缺，正向 PWA 测试保持 `NOT_RUN`。

## 3. 当前包与回滚包

当前手机最后一次核验的包是 **rev16 r5**（r6 尚未安装）；交付目录的活动候选已是 r6，r5 文件已退役（哈希见 `rev16-r6-build/rev16-r6-retire-and-sign-intent.json`）。

| 用途 | 路径（相对 `$W`） | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| 活动签名候选（r6） | `ABS-Browser-v1.0.0-r13z-rev16-r6-arm64.apk` | 372486412 | `b83b3f11ff512087f183b7f7dc7840f4ced30d78cc360ca818deda071805276c` |
| 已复验 rev15 回滚 | `ABS-Browser-v1.0.0-r13z-rev15-webaudio-arm64.apk` | 372372507 | `0b77b4ae8e29b638e45398faadf4ebde82add3ef203186e3b96e587b484e7662` |
| 手机在跑（r5，文件已退役） | — | 372486412 | `ccb2f8c52bb58c74d1ae2787a708ef3e58e1008aa4475a99d95dbde31f2ec51e` |

- 包名 `com.ahoo.abs.browser`，版本 `1.0.0` / `10000`，minSdk 29、targetSdk 36，ARM64，非调试包，16 KiB 对齐。
- 原发布证书 SHA-256：`0f186dd70f80892e04443b7105842eef2ac9e641e9ecefa15015158317f1402f`。
- r6 相对 r5 只有一个 DEX 载荷（`classes.dex`）变化，未换原生内核。原生库 SHA-256 `1089c8359789f747aaea98a1d7e25e6c0a42f43eee055b656c3488fe7bd6407e`，Build ID `72b77a9816ec37d906de8cd6cba7d97753371514`（r5/r6 相同）。
- 内核是 Chromium `152.0.7977.72` 的 content/shell/WebContents，不是 Chrome UI 或系统 WebView。
- `$W/rev16-r5-finished.json` 与 `$W/rev16-r6-build/rev16-r6-finished.json` 都是各自构建时的不可变凭据，状态 `FINISHED_SIGNED_RUNTIME_PENDING`；不要为了真机结果覆盖它们。新增运行结论写新文件。

### 安装与数据身份

`$E/install-{intent,return,verified}.json` 记录一次 streamed、非 incremental、`-r --user 0` 安装及读回哈希。`install-verified.json` 状态：`EXACT_R5_WITH_DATA_IDENTITY_PRESERVED`。

保留不变：`appId=10629`、CE inode `2984885`、DE inode `2984897`、首次安装时间 `2026-11-05 21:35:16`、签名记录 `["3","f093d616"]`、版本号。没有 clear/uninstall。**这是数据身份连续性证据，不是对每项用户数据内容的逐项审计。**

## 4. 本轮真机结果（不要扩大结论）

总凭据：[`phone-acceptance.json`](.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/rev16-r5-phone-1iampnp_/phone-acceptance.json)。

- 时间：`2026-11-21T22:49:10.108713+08:00`。
- 状态：`PARTIAL_ACCEPTANCE_PWA_POSITIVE_NOT_RUN`。
- SHA-256：`bcbcacd45f857dacc101acd868820876e78e0167a7babb80ae2dcb2a09e5fc9e`。
- 其中 50 份关联证据的存在、字节数和 SHA-256 已逐项复验；另有已完成的只读子代理审阅，支持下述 PASS/PARTIAL 边界。

| 项目 | 已证明 | 未证明 / 缺口 |
| --- | --- | --- |
| 菜单「全屏浏览」 | 真实菜单点击进入；工具栏及系统栏控件隐藏；DOM 全屏始终 null、没有 fullscreenchange；视口 `360×677 → 360×752 → 360×677`；一次 Back 恢复竖屏浏览器 UI。 | 不代表真正 edge-to-edge；仍有白条。 |
| 网页 DOM 全屏 | 受信任事件 `stage → null`；一次 Back 恢复竖屏 UI/基线视口，未导航。 | 同样有白色安全区。 |
| Chromium 视频全屏 | 点击真实 UA `enter full screen` 控件，而非网页脚本；受信任事件 `video → null`；一次 Back 先退出全屏，不退网页。 | 退出后没有恢复基线竖屏几何。 |
| 视频持续渲染 | 两张全屏截图烧录时间 `04.933 → 08.533`、帧号 `74 → 128`，图案也实际移动变化。 | 不能只用不同哈希或 playback clock 替代图像证据。 |
| 视频退出 UI | 工具栏、状态栏、导航控件及 DEFAULT 行为恢复，同一文档/URL。 | 即刻和约 171 秒后的稳定截图仍是 `2376×1080 / ROTATION_90`。不能称“瞬态”或“完全恢复”。 |
| 系统栏/安全区 | 所属窗口行为 `DEFAULT → SHOW_TRANSIENT_BARS_BY_SWIPE → DEFAULT`，可见栏控件确有隐藏/恢复。 | 竖屏顶部约 120px 白条、横屏左侧约 120px 白条；精确 requested-bar bits 和完整 InsetsState 合同未验完。 |
| HTTP PWA 安装 | 菜单实际点击后明确显示「只能从已加载且连接安全的页面安装网页应用。」 | **只是安全拒绝路径，不是正向安装成功，更不是自动提示验收。** |
| HTTPS PWA | 未执行。 | `NOT_RUN_NO_AUTHORIZED_TRUSTED_HTTPS_FIXTURE`；提示、ABS 同意/取消、桌面新入口、入口启动、作用域和离线都未验收。 |
| Muse / WebAudio | 本轮没有真实通话/消息。 | 不用此前源码修复或主机回归冒充本轮实测。 |

### 横屏问题的已知读数

`$E/audit-excerpts.json` 保存了原窗口/控件摘要及只读方向策略：

- `accelerometer_rotation=0`，`user_rotation=1`。
- `mCurrentAppOrientation=SCREEN_ORIENTATION_USER`。
- `mUserRotationMode=USER_ROTATION_LOCKED mUserRotation=ROTATION_90`。
- **没有记录测试前这两个系统设置，因此不能断言是传感器、用户原设置或产品回归导致。整个测试没有写旋转设置。**
- `NativeBrowserActivity.java` 此轮搜索未见显式 `setRequestedOrientation` 等处理；应继续核对 Chromium 的视频全屏方向锁/解锁实现，不能仅凭 Java 层搜索认定根因。

## 5. 关键证据与夹具状态

以下均在 `$E`，除非另有说明：

| 文件 | 用途 |
| --- | --- |
| `baseline.{png,xml,json}` | 进入测试后的竖屏 UI/文档/窗口基线 |
| `menu-fullscreen-{entered,restored}.{png,xml,json}` | 菜单全屏与一次 Back 恢复 |
| `dom-fullscreen-{entered,restored}.{png,xml,json}` | 网页 DOM 全屏与恢复 |
| `ua-controls-before.xml` | UA 控件 `enter full screen`，当时 bounds `[711,925][855,1072]`；**坐标仅为历史证据，不可重用** |
| `video-inline-playing.{png,xml,json}` | 内联播放状态 |
| `ua-video-fullscreen-{1,2}.{png,xml,json}` | 横屏全屏运动画面，帧号 74/128 |
| `ua-video-restored{,-settled}.{png,xml,json}` | 已退出 DOM 全屏、UI 恢复但仍横屏 |
| `http-pwa-menu.xml`、`http-pwa-intent.json`、`http-pwa-response-{1,2}.png` | 安装动作及 HTTP 明确拒绝 |
| `trace.ndjson`、`audit-excerpts.json` | 服务端监听、独立文档与窗口摘要 |
| `route.json`、`route-cleanup.json` | 已到期 HTTP 路由及其准确清理凭据 |
| `owned-environment-exit-confirmed.json` | 具名退出后，MainActivity 的空闲状态核验 |
| `phone_ui.py`、`fixture_server.py`、`fixture.html`、`synthetic.webm` | 历史自有夹具/辅助，不可直接重跑旧会话 |

### 旧页面已经结束，不能复用

- 自建 Direct 环境：`ABSQA167K39`，保存/打开各一次。
- 旧路由：`http://127.0.0.1:60084/q122579d4e7`，检查页后缀 `/check`。
- check 文档 nonce：`d2df13a4-bb36-4dff-9fc4-b9b71e1533ec`。
- 三种全屏后都是此 nonce 和 URL；初次 pageshow 后监听中的 `shown/hidden/popped` 保持 `1/0/0`，说明 Back 没有退历史。
- 夹具是自有、有界、loopback-only HTTP，无外部资源、账号、持久存储、SW 或 manifest，视频无声。该 HTTP 测试**不能证明正向 PWA**。
- 服务端在 720 秒上限内已到期退出。之后的 settled 截图有旧 `traceLast`，不能当实时监听数据。
- `fixture.html` 是模板；`route.json` 中页面 SHA 与磁盘模板 SHA 可以不同，不要混为同一载荷。
- 另一个官方夹具目录 `mobile/android/native-kernel/tests/pwa-fullscreen-fixture/` 目前是 **HOST ONLY**；有 manifest 路由也不等于已经有设备信任的 HTTPS 来源。

## 6. 输入不可重放与已处理停点

- 地址 Enter、保存、环境卡片、全屏、播放、返回及 PWA 点击均有一次性意图/结果或独立界面结果。**不要看到 consumed/unknown 就再点一次。**
- `navigation-enter-intent.json` 仍保留 `ENTER_ATTEMPT_CONSUMED`。本轮已用 URL、独立 UI/PNG 和监听证明导航成功，不是需要补发 Enter。
- 若继续维护导航执行器：只有新文本已返回、尚未 Enter 的状态才允许一次提交（预消费 TTL 0.8 秒）；异常/非空输出进入 `ENTER_ATTEMPTED_OUTCOME_UNKNOWN` 不可重放；空返回仍须独立文档证明。
- 菜单是 focusable `PopupWindow`，通用 browser-only guard 在此处停止是正确行为。必须独立证明准确弹窗 owner UID/package、focusedApp 仍为浏览器，才可以对该特定弹窗输入；不要放宽全局守卫。
- 清理时横屏菜单的退出条目起初在折叠区域外：首次只打开菜单，没有点击退出；随后只滚动自有菜单一次，才点击退出条目。
- 退出条目的一次点击后，立即焦点校验在切换期间停止。后续只读证明出现的是 `ABSQA167K39` 的退出确认，之后做的是**一次独立的确认动作**，没有重复点击退出菜单条目。
- `owned-environment-exit-return.json` 是较早、未确认空闲的中间凭据，应保留；最终以 `owned-environment-exit-confirmed.json` 为准。
- 更早的 ProfileEditor Save 曾受 IME 遮挡，不能复述成“成功只关闭键盘”；后来以新鲜折叠/Save 几何独立完成保存。不要重放旧坐标。

## 7. 最后一次设备与清理状态

这些是**最后一次观测**，不是下一轮可跳过预检的实时事实：

- 物理机：OnePlus PKG110，Android 16 / SDK 36，ARM64，user 0，serial `69a2181d`，非模拟器。
- 使用已有 ADB server：`/opt/homebrew/bin/adb`，`127.0.0.1:5037`，当时 PID `7869`。不得 start/reset/kill 该共享 server。
- 本轮仅 USB transport `566`；wireless `567` 是同一手机，没有使用。**transport ID 会变化，下一轮必须从 exact serial 重验，不能盲用 566 或改走无线。**
- 当时设备命令前缀：`ADB_MDNS_AUTO_CONNECT=0 /opt/homebrew/bin/adb -H 127.0.0.1 -P 5037 -t 566 ...`。这是历史前缀，不是要求现在执行。
- 浏览器组件：`com.ahoo.abs.browser/com.ahoo.abs.android.nativekernel.NativeBrowserActivity`。
- 管理页组件：`com.ahoo.abs.browser/com.ahoo.abs.android.MainActivity`。
- 最终确认只退出具名自建环境，观察到准确空闲文案 `●  当前没有打开的环境 · 单环境运行`。未删除自建配置或个人配置。最终树里 owned card count 为 0，不构成配置删除证据，也不要据此重建同名环境。
- 有界夹具 job `bash-516000e74775481d` 已收集：exit 0；输出 `Reverse cleanup: removed-and-verified`。准确自有 `tcp:60084` 映射已移除，最终 reverse 列表为空。
- 安装 job 已收集；只读证据审阅子代理已完成。没有本轮必须继续等待的夹具或安装工作。
- 不要复用 `/private/tmp/abs-r5-sockproof.xuIXoEJ5/guest_fixture.py`：那是历史模拟器适配器，禁止改接手机。

## 8. 下一轮建议顺序

1. ~~静态诊断白色安全区和视频方向恢复~~ **已完成**（见 2b 节）：白条根因已修复并过回归；方向责任边界已查明，归因留待复测。
2. **补齐合法的 HTTPS PWA 测试来源。** 先确认来源授权、证书受设备信任以及 manifest/start/scope/图标合同；不忽略证书、不导入信任、不把 HTTP localhost 安装拒绝算成正向成功。（夹具与 CLI 已就绪，缺受信任来源与授权）
3. 如需源码修改，先读相关代码和现有合同测试，保留 r5 首次证据；正式构建、签名并核验新候选后再按当前授权决定更新。不要手工改 DEX 或无理由重复安装相同 r5。
4. 真机复测先记录旋转/Insets 基线，再分别测菜单、DOM、真实 UA 视频控件；一次 Back 后核对文档/URL/历史、栏控件、方向、焦点和几何。系统沉浸提示若抢焦点须单独核对，不盲按返回。
5. PWA 正向以**新的、启用的桌面 opaque pin 及该精确入口成功启动**为接受条件；`requestPinShortcut` 返回 true 或弹出安装确认不等于安装成功。取消前后注册表的状态也要按阶段区分。
6. 完成后只退出本次所属测试环境并清理准确映射；更新新增运行结果，不覆盖旧失败/中间凭据。

### 代码入口

- `mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel/NativeBrowserActivity.java`：菜单约 823–917；全屏约 1196–1397；PWA 条件约 1851、同意约 1960–2168；系统栏约 2875；Back 约 3052；具名环境退出约 2830。行号仅为此时导航提示。
- 同目录 `NativePwaBridge.java`。
- `mobile/android/native-kernel/chromium/agent_browser_android_pwa_bridge.cc`、`product-pwa.patch`、`product-webaudio-destination.patch`。
- `mobile/android/app/src/main/java/com/ahoo/abs/android/webapp/{WebApp,WebAppRegistry,WebAppShortcuts}.java`。
- `mobile/android/app/src/main/java/com/ahoo/abs/android/MainActivity.java`、`process/LaunchCoordinator.java`、`ProfileEditor.java`。
- PWA 保持现有安全合同：已提交且认证的 HTTPS、同源且在 scope 的 id/start/entry、可用清单和 display、原生 10 秒期限、用户同意后 refetch；撤销必须保持 sticky；独立启动先绑定 scope，越界恢复浏览器 chrome，不重放 POST。
- Muse 已保留 rev15 WebAudio destination bus/channel 并发修复：上游 CL `8468847`、commit `6363d8b6d36db4ac13c8185567c37c407c016402`，crbug `40711696`。本轮未复测真实 Muse。

## 9. 模拟器旧目标与测试结果不要串账

`get_goal` 的旧目标仍为 **仅隔离模拟器**，ID `goal-4407d116-85dd-4e75-ae11-03103228d061`，revision `11`，round `8/20`，phase active 但 activation **disarmed**。

- 目标文本明确不连接用户手机；后来的真人直接请求另行授权了本轮真机测试，并不把旧目标改成已完成。
- 不凭本轮手机结果 complete 旧目标，不因本次 handoff 请求自动 resume。只有后续适用的真人继续请求才按目标规则处理。
- r5 模拟器正式安装/读回已证明包身份，但导航观测预算停点使全屏/PWA 功能验收未完成；不要补记通过。
- `$W/rev16-r5-navigation-budget-offline.json`：94 项离线 QA + 13 项主机夹具测试通过，状态 `OFFLINE_REGRESSION_PASS_RUNTIME_UNPROVED`。**不是 Android 运行验收。**
- 导航预算复核为 `22 + 4*(A+B+N)`，A=3/B=2/N=5 时连夹具共 68 次调用，不是 64；慢读取仍可能超过封存执行器的时间窗。不要复制旧的错误预算结论。

## 10. 磁盘、产物与接续工具

- 用户已明确抱怨历史包占满磁盘。2026-11-21 本次 handoff 的 `df`：工作区所在卷约 **23 GiB 可用，95% 已用**。
- `$W` 根目录最后核验只留活动签名 r5 与已验证 rev15 回滚两个 APK。不要复制整包作“每轮备份”，也不要恢复 r4/未签名中间件。
- 最多一套任务自有 scratch AVD，不保留逐版本整盘/快照。已知 AVD 路径 `/Volumes/ABS_QA_DIAG7_APFS/avd-r2/ABS_Release_QA.avd`，最后已停止；任何后续清理前都重新确认挂载卷、真实路径、归属和 live references，不能碰同级用户 AVD 或共享 SDK/cache/sparseimage。
- 保留源码、密钥、已发布/显式保留的 releases、许可证、固定输入、个人数据、小型哈希/安装凭据及第一失败证据。旧样本不能只按名字或体积删除。
- 读文件用 read，搜路径用 glob，搜内容用 grep；先读后改。每个 bash 看 exit code；追踪并收集本轮相关 background job。当前文件权限为 danger-full-access，审批提示关闭，**不要设置 sandbox_permissions 或请求 escalation**。
- 若修改 Android 原生 UI/交互，先加载 `android-quiet-ui`。不要调用已移除的 `product-quality-gate`。
- DSH checkout `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/` 与 ABS 工作区不是一个项目。本任务不要误改 Harness 或启动替代 GUI 服务器。

---

**给下一轮的最短摘要：r6 已在手机上（数据身份连续），全屏白条、方向归因、PWA 正向（安装→pin→启动→作用域）全部真机验收通过；未验收的只剩 Muse/WebAudio 真实通话、离线使用、WebApp × 关闭流程；PWA 来源基建（hroze.org 双子域 + 隧道 pwa-qa-r6）验收后已停，DNS CNAME 未删、桌面图标保留；rev15 回滚包保留、r5 已退役留档；别把验收写成"全部修好"、别把手机结果算成模拟器目标完成。**
