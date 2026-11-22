# iPad 版 ABS Browser（iOS / iPadOS）

Android 原生指纹浏览器的 iPad 自用版本。**仅限本机自用，不做任何分发**；无 App Store、TestFlight 或企业签名适配。

引擎为系统 WKWebView（WebKit），**不是** Android 版的补丁 Chromium。两者能力不对等，边界在下表中如实声明；引擎级指纹控制的后续路径见
[`docs/review/ios-webkit-fork-spike-plan-2026-11-19.md`](../../docs/review/ios-webkit-fork-spike-plan-2026-11-19.md)。

## 当前状态 — 2026-11-19，MVP r1

- 单 SwiftUI app（`ABSBrowser.xcodeproj`），iOS 17.0+ 部署目标，iPad-only（`TARGETED_DEVICE_FAMILY=2`），Bundle ID `com.ahoo.abs.browser.ipad`。
- 40/40 XCTest 全绿（iPad Pro 11-inch M5 / iOS 26.5 模拟器），含在真实 WKWebView 上断言 persona 注入效果的覆盖矩阵。
- 模拟器冒烟通过：空态/环境列表渲染、profile 存储加载、指纹摘要、代理展示。
- 未完成（诚实声明）：真机验证未做（需要用户的 Apple ID 签名）；完整浏览路径的 UI 冒烟以 XCUITest 补充；代理连通性未在真实代理后端上验证。

## 能力矩阵（对照 Android 版，诚实边界）

| 能力 | iPad 版 | 说明 |
|---|---|---|
| Profile 隔离（Cookie/localStorage/IDB/缓存） | ✅ 引擎级 | 每 Profile `WKWebsiteDataStore(forIdentifier:)`，持久、冷启动保留（Android v4 的 cookie 冷启动失败项在这里天然不存在） |
| 每 Profile 代理（HTTP/HTTPS/SOCKS5 + 凭证） | ✅ 引擎级 | iOS 17 `WKWebsiteDataStore.proxyConfigurations`；凭证存 Keychain（device-only），不进 profile 文件、不参与指纹摘要 |
| 时区 | ⚠️ 页面级 | `WKUserScript` documentStart 覆盖 `Date` 全部 wall-clock getter、`toString/toDateString/toTimeString`、`getTimezoneOffset`、`Intl.DateTimeFormat` 默认 timeZone、无偏移 ISO 解析与多参本地构造。**Worker 域不覆盖（泄漏）** |
| 语言 | ⚠️ 页面级 | 覆盖 `navigator.language(s)` 与常见 `Intl` formatter 默认 locale；**Accept-Language 请求头不覆盖（泄漏）** |
| UA | ⚠️ | `customUserAgent` 只改 `navigator.userAgent`；Sec-CH-UA 等请求头不变 |
| 外观（prefers-color-scheme） | ✅ 引擎级 | 按 Profile `overrideUserInterfaceStyle` |
| 地理位置 | ✅ | real / off（恒拒绝）/ custom（注入固定坐标，Position 形状与真实 API 一致） |
| Canvas/WebGL/字体/屏幕/ClientRects | ❌ 不伪装 | 真实设备值；诊断页如实展示并标注 |
| 历史记录 | ✅ | 语义镜像 Android：origin 规范化、200 站 LRU、3 秒合并窗口、按天分组、per-Profile 隔离文件 + 隔离键校验；持久化为原子 JSON（非 Android 的 ABSHISTv1 TSV，格式差异已注明） |
| 指纹种子 | ✅ | 每 Profile 8 字节大端 uint64，`SecRandom` 铸造、temp+rename 原子写、读取 fail-closed（镜像 `FingerprintSeedStore.java` 语义） |
| 标签页 | ✅ | 最多 10 个保留 tab、关闭最后一张先物化替代卡、切换器 2 列网格、字母占位不伪造页面缩略图 |
| 桌面同步 / agent / 自动化 / 扩展 | ❌ MVP 外 | 桌面 ABS 功能未接入 |

应用内「身份检查」页（菜单 → 身份检查）在当前 Profile 的真实 webview 里运行探针，显示实际观察值与覆盖状态，**不会伪造覆盖声明**。

## 构建与运行

要求：Apple Silicon macOS + Xcode（本项目在 Xcode 26.5 / iOS 26.5 SDK 上验证）。

```sh
# 模拟器（无需任何账号）
xcodebuild -project mobile/ios/ABSBrowser/ABSBrowser.xcodeproj -scheme ABSBrowser \
  -destination 'platform=iOS Simulator,name=iPad Pro 11-inch (M5),OS=26.5' \
  -derivedDataPath mobile/ios/ABSBrowser/.build build CODE_SIGNING_ALLOWED=NO

# 全量单测（40 个）
xcodebuild -project mobile/ios/ABSBrowser/ABSBrowser.xcodeproj -scheme ABSBrowser \
  -destination 'platform=iOS Simulator,name=iPad Pro 11-inch (M5),OS=26.5' \
  -derivedDataPath mobile/ios/ABSBrowser/.build test CODE_SIGNING_ALLOWED=NO
```

也可以直接用 Xcode 打开 `ABSBrowser.xcodeproj`，选 iPad 模拟器 Run。

### 装到 iPad（iOS 27.2，自用签名）

1. Xcode → Settings → Accounts 登录 Apple ID（免费账号即可）。
2. 选中 ABSBrowser target → Signing & Capabilities → 勾选 Automatically manage signing，选择你的 Personal Team。
3. iPad 连接 Mac，首次在 iPad 上信任开发者证书（设置 → 通用 → VPN 与设备管理）。
4. Run 到真机。

免费账号签名 7 天过期需重连 Xcode 重签；$99 开发者账号签名 1 年有效。自用无需申请任何 Apple entitlement。

## 数据位置（App 沙箱内）

| 内容 | 路径（相对 App Data 容器） |
|---|---|
| Profile 目录 | `Library/Application Support/ABSBrowser/profiles.json`（原子写，0600） |
| 指纹种子 | `Library/Application Support/ABSBrowser/fingerprint-seeds/<uuid>.seed`（裸 8 字节，排除备份） |
| 历史快照 | `Library/Application Support/ABSBrowser/native-history/native_history_<uuid>.v1.json`（写后回读校验 + .bak） |
| 代理凭证 | Keychain（`com.ahoo.abs.browser.ipad.proxy`，device-only） |
| 网站数据 | WebKit 每数据仓目录（由 `WKWebsiteDataStore(forIdentifier:)` 管理，删 Profile 时同步删除） |

## 代码结构

```
mobile/ios/ABSBrowser/
├── ABSBrowser.xcodeproj/          # 手写工程（app + tests + UI tests target）
├── ABSBrowser/
│   ├── App/                       # 入口 + AppModel（会话/导航协调）
│   ├── Model/                     # ProfileSpec/ProxySpec/ProfileStore/CredentialStore/
│   │                              # FingerprintSeedStore/BrowserHistory/HistoryStore
│   ├── Runtime/                   # PersonaScripts（JS 注入）/ProfileRuntime/TabManager
│   └── UI/                        # 环境列表/编辑器/浏览器/TabSwitcher/NTP/History/诊断
└── ABSBrowserTests/               # 模型 + 历史 + 种子 + persona 覆盖矩阵（真实 WKWebView）
```

数据模型与交互语义逐项对齐 `mobile/android/core`（`ProfileSpec`/`ProxySpec` 校验规则、
`NativeTimezoneLaunchConfig` 的身份字段、`BrowserHistory` 的 LRU/合并窗口/origin 规范化、
`NativeBrowserActivity` 的 chrome/菜单、`TabSwitcherView`/`NewTabPage`/`HistoryPanel` 的交互）。

## 已知边界与后续

- 时区/语言的 Worker 泄漏、Accept-Language 头、Canvas/WebGL/字体真实值——全部为**已文档化的泄漏面**，不做任何遮掩；要消除它们只能走自建引擎路线（轨 2 调研文档）。
- 代理连通性尚未在真实代理后端验证；`proxyConfigurations` 的认证代理在部分 iOS 版本上有已知怪癖（社区报告），首次连真实代理时建议先开「身份检查」页确认出口。
- 桌面 ABS 的 profile 同步（S3）未接入；iPad 版目前是独立数据域。
