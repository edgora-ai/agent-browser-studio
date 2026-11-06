# Android 完整 Chrome UI 基线：构建与验证交接（2026-11-04）

## 结论

在 4 核 x86_64 Linux 构建机（192.168.4.12）的 Chromium 152 补丁树上，首次成功构建了**完整 Chrome Android UI**（`//chrome/android:chrome_public_apk`），并接入 0057 的 Android 时区冻结配置入口；在原生 arm64 Android 模拟器（colima + redroid，ashmem 后端）上完成了 UI、命令注入、renderer 回执、JS Window/Worker 与 fixture 矩阵验证。**用户 Android 16 真机的安装/启动验收仍 PENDING（无线 adb 掉线未恢复）**。

## 产物

| 产物 | 说明 | SHA256 / 大小 |
| --- | --- | --- |
| `ChromePublic.apk`（基线） | chrome_public_apk，Chromium 152.0.7977.72，包名 `org.chromium.chrome`，arm64-v8a，v2 debug 签名，无指纹注入 | `8b49061c…` / 518,470,195 B |
| `ChromePublic.apk`（注入版） | 增加 `assets/agent_browser_fingerprint_config.b64` + `SplitCompatApplication` 注入 `--agent-browser-fingerprint-config` / `--agent-browser-timezone-required` | `f2f556c8…` / 518,469,333 B |
| shanghai 变体 | 仅替换 asset 并用 Chromium debug 证书重签 | `c75486ba…`（本地） |
| native-control 变体 | 同上 | `0568df36…`（本地） |
| x86_64 Chrome | 备用双架构验证，构建中（`out/abs-chrome-x64`） | — |

## 构建方法（可复现）

1. 源：`/home/ahoo/abs-native-work/chromium-build-152/src`（RoxyLite 57 补丁已应用并校验）
2. product overlay：`stage_product.py` 同集（52 文件 / 248,197 B）落盘 `content/shell/android/agent_browser_product`；应用 `product-bootstrap.patch`
3. 完成产品 APK 真机验证后，为完整 Chrome 增加：
   - `chrome/android/agent_browser/agent_browser_fingerprint_config.b64`（base64url canonical JSON）
   - `chrome/android/BUILD.gn`：`android_assets("agent_browser_fingerprint_assets")` 并加入 `chrome_public_non_pak_assets` deps
   - `SplitCompatApplication`：在 CommandLine 初始化后读 asset、追加 switches 并打印 `ABS_ANDROID_TIMEZONE_V1 injected=1 source=asset`
4. 构建：`gn gen out/abs-timezone-newyork`（arm64，冻结 12 参数不变）→ `autoninja -j4 chrome_public_apk`（`JAVA_TOOL_OPTIONS` 必须不设，否则 D8 `--warnings-as-errors` 会被 “Picked up JAVA_TOOL_OPTIONS” stderr 打断）
5. 签名：Chromium debug keystore（`build/android/chromium-debug.keystore`，`chromium` 密码，cert SHA256 `32a2fc74…`）

## 验证证据（arm64 模拟器）

- 模拟器：colima（macOS Virtualization.Framework，Ubuntu 6.8 aarch64）+ redroid 13 arm64（`--device /dev/ashmem`，`androidboot.use_memfd=false`，端口 5556）；`use_memfd=true` 的容器会因 Chromium shared-memory 失败而 abort
- UI：First Run “Welcome to Chrome” → NTP 标签页 UI；`chrome://version` 显示注入的 Command Line
- Renderer 回执：`ABS_ANDROID_TIMEZONE_V1 applied=1 input_sha256=<config sha> canonical_timezone=<tz>`；容器设备时区为 GMT
- JS 实测（本地测试页经 `adb reverse` 暴露）：Window 与 Blob Worker 同值
  - new-york：`America/New_York offset=300`
  - shanghai：`Asia/Shanghai offset=-480`
  - native-control：`applied=0 mode=native-control`，页面 `+00:00 offset=0`
- UA/语言 sanity：`Mozilla/5.0 (Linux; Android 10; K) … Chrome/152.0.0.0 Mobile Safari/537.36`、`en-US`（正常 Android UA reduction，无桌面 persona）
- 桌面 persona parser 不会被 Android timezone JSON 启用（`enabled_` 要求 seed>0、Win32/MacIntel、UA/languages 等，源码确认）
- 证据目录：`mobile/android/native-kernel/build-recovery/evidence/device-verify-chrome/`

## 已知差距 / 下一步

1. **真机（Android 16）验收 PENDING**：手机无线 adb 在构建后掉线，需重连后安装注入版 APK、启动截图
2. **指纹能力范围**：当前 Android 契约只覆盖时区冻结（`timezone-only` / `native-control`）；UA、屏幕/DPR、Canvas/WebGL/WebAudio、WebRTC 等 patch 特性由桌面 persona 配置驱动，不适合 Android 身份，需要设计 Android 专用 schema 与产品启动配置
3. **UI/产品化**：完整 Chrome 已可渲染，但 profile 管理、启动参数、网络/代理策略、Ping0 页面、普通浏览门禁等产品层尚未接入
4. **分发**：仅 debug 签名；release 签名、商店分发、合规审查未做
5. **x86_64 变体**：构建中，用于模拟器侧双架构验证

## 未完成项与暂停说明（2026-11-04 17:20）

- x86_64 完整 Chrome 备份构建在 `[29136/60078]`（约 48%）处**主动暂停**：V8 重编译已过，blink core 预计还要 6–10 小时；它不是本目标（arm64 完整 Chrome + 真机验收）的必需项，为释放 4 核构建机 CPU 而停止。`out/abs-chrome-x64` 目录与对象保留（6.6 GB），续跑命令：
  `autoninja -C src/out/abs-chrome-x64 -j4 chrome_public_apk`（不要设置 `JAVA_TOOL_OPTIONS`）
- **唯一阻塞项**：用户 Android 16 手机的无线 adb 自 2026-11-04 约 11:00 起掉线（Mac 与 192.168.4.12 两侧 `adb devices` 均不可见、mDNS 无 `_adb-tls-connect._tcp` 广播），因此“安装到用户 Android 16 手机并启动验证 UI”无法执行；需要用户点亮解锁手机并重开无线调试（或 USB 连接）后继续。
- 其余工作（构建、注入、arm64 模拟器端到端验证、fixture 矩阵、UA sanity、证据归档、文档）均已完成。


## 路线 A 里程碑 M1：产品引擎可浏览（2026-11-04 傍晚）

- 产品适配壳 APK（`com.ahoo.abs.android.native_product.preview`，2026-11-04 构建 `c3a2dd67…`）已从"仅验证页"改为**可用浏览**：去掉强制 `--agent-browser-product-preflight`（打开导航），恢复并启用 content shell 自带工具栏（地址栏/前进/后退/刷新）。
- arm64 模拟器实测（profile `env-ny`：HTTP 代理 192.168.4.100:7890、时区 America/New_York、语言 en-US）：地址栏输入 `http://127.0.0.1:8765/` 成功加载；页面 JS 显示 Window/Worker `America/New_York offset=300`、`lang: en-US`；renderer 回执 `applied=1 canonical_timezone=America/New_York`。
- 限制：**单实例**（一个浏览器进程/一套命令行/全局时区）；**同时多开**需要"一个 profile 一个独立 Android 进程/实例包"的架构（同 APK 内多开会撞 Chromium sandbox 子进程服务名与全局命令行为，不可行）。UA 仍是 content shell 的 `Chrome/999.0.0.0` 占位，产品身份/指纹项待接入。
- 证据：`evidence/device-verify-product/route-a-browse/`


## 路线 A 已验证：单实例多 profile 指纹浏览器（2026-11-04 傍晚，用户确认单开即可）

- 产品壳 APK（`c3a2dd67…`）现已支持：创建/列出/选择 profile、启动与停止、切换另一个 profile；每个 profile 独立存储目录、独立代理/时区/语言冻结。
- 实测（arm64 模拟器）：
  - `env-ny`（America/New_York, en-US）浏览本地测试页：JS Window/Worker `America/New_York offset=300`，写入 localStorage 标记 `m-1793789201653`；renderer `applied=1 canonical_timezone=America/New_York`
  - 停止后状态"没有活动环境。"且浏览进程退出；切换到 `env-sh`（Asia/Shanghai, en-US）：JS Window/Worker `Asia/Shanghai offset=-480`、**marker (empty)**；renderer `applied=1 canonical_timezone=Asia/Shanghai`
  - `no_backup` 下两个独立 profile 目录（`native_p_b71ef30b…` 与 `native_p_cae1807d…`）→ 存储隔离成立
- 未完成（如实记录）：Ping0 实测（模拟器无法出代理，需真机/可用网络）、Android UA/ClientHints 及其他指纹面接入、真机 Android 16 验收、release 签名；多实例同时多开架构按要求搁置。
- 证据：`evidence/device-verify-product/route-a-multi-profile/`


## 产品浏览器 UI 重做（多标签，2026-11-04 晚，真机 PKG110）

- 用户反馈"只能单 tab、设计简陋、半屏"：已重做产品壳浏览器界面。
- 改动：去掉验证按钮/标题占位，改为全屏浏览器；自绘顶栏 = 标签条（标签标题 + 关闭 × + 新建 +，最多 10 个）+ 圆角地址栏（‹ › 前进后退、刷新、⋮ 菜单）；隐藏 content shell 自带工具栏；处理状态栏 inset。
- 引擎侧：patch `content/shell/android/java/src/org/chromium/content_shell/ShellManager.java` 支持多 Shell（launchShellInNewTab/selectShell/closeShell/getShells），保留非活动 Shell 及其 WebContents。
- 修复：content shell 启动自带一个初始 Shell，先前又主动 launch 导致重复标签；改为复用初始 Shell。
- 真机验证：单标签启动 → + 新建标签 → 新标签地址栏导航 ipinfo.io/json 成功 → 标签标题更新、活动标签高亮、后退按钮可用；系统返回键按"页面回退/关标签/回环境列表"顺序处理。
- 仍未完成：Ping0 JS 资源（cdn.ping0.cc）在当前网络被阻断，且临时直连代理出口是家庭宽带 China Mobile IP（与冻结时区 America/New_York 不一致）；需用户提供可用代理节点后再跑 Ping0 评分。
- 证据：`evidence/device-verify-product/route-a-tabbed-ui/`（sha256 见 `tabbed-ui-milestone.json`）
