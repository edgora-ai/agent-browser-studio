# 极简移动端指纹浏览器方案调研

日期：2026-10-21。状态：**方案调研完成；Android/iOS 真机与 Ping0 验收未完成。**

本报告记录公开平台资料、公共 SDK 及本仓库源码研究结果，不把 API 存在、桌面模板、离线测试或安装包生成当成手机功能通过。部分官方网页全文抓取受网络/安全验证限制；相关结论采用官方公开索引，Apple 的若干 API 另以已安装公共 SDK 头文件交叉核实。未读取真实用户 Profile、Cookie、令牌、设备标识、授权文件或私钥。

## 1. 用户目标与范围

在普通、未 root/越狱的 Android/iPhone 上运行浏览器，管理多个独立持久化 Profile，每个 Profile 绑定自己的代理；依据实际出口建议国家/地区、时区和语言，并配置设备身份，最终以真实手机的 Ping0 环境检测作为验收之一。

用户明确不需要其他复杂功能。首版仅保留三个界面：

1. 环境列表：创建、编辑、打开、切换环境。
2. 环境设置：名称、代理、地区、时区、语言、设备预设。
3. 浏览页面：地址栏、返回/前进、刷新、返回环境列表、打开 Ping0。

不包含 AI、自动化、团队、云同步、账号平台、插件、批量、REST/MCP 或桌面管理功能。首版设计假设为**一次仅一个活动 Profile**；这不是同一进程中仅隐藏其他 WebView，旧 Worker、SW、连接和下载也属于切换边界。

### 必须区分的概念

- 独立 Cookie/网站数据不等于全部硬件指纹均不同，也不保证环境之间不可关联。
- 代理改变实际网络出口，不直接改变 GPS、系统地区、语言、时区或硬件。
- 国家可能包含多个时区和语言。GeoIP 只能提供有来源、有时间的建议；未知或失败不能静默回退到宿主值后显示成功。
- 代理 IP 无法推导设备型号。型号应是单独确认、固定保存的整组身份，而非每次打开随机改一个 UA 字符串。
- WebView 基于 Chromium 不等于 Google Chrome App；更改 UA 不会更换内核或物理设备。
- 内核升级后的版本字段应反映实际内核，不能长期固定一个与真实引擎不符的 Chrome 版本。

## 2. Android 调研结论

### 2.1 公开能力

| 能力 | 已核实边界 | 设计影响 |
| --- | --- | --- |
| 多 Profile | AndroidX WebKit 1.9.0 引入 `MULTI_PROFILE`、`ProfileStore`、`WebViewCompat.setProfile`；需运行时检查 provider feature | 依赖版本、Android 系统版本不能替代实际 WebView 能力；CookieManager/WebStorage/SW controller 必须取对应 Profile 的对象 |
| 独立目录 | `WebView.setDataDirectorySuffix` 自 API 28 提供，是当前进程初始化前的一次性选择 | 不能销毁 View 后在同一进程任意换目录；须避免其他组件提前初始化 WebView |
| 代理覆盖 | 可核实公开 `ProxyController.setProxyOverride(ProxyConfig, Executor, Runnable)` 仍声明作用于 all WebViews in the app，没有 Profile 参数 | 不按 per-Profile 代理 API 设计；串行应用当前配置，等待完成回调；跨进程行为另须验证 |
| UA/UA-CH | AndroidX WebKit 1.9.0 的 `setUserAgentMetadata`，需 `USER_AGENT_METADATA` feature | 可配置声明字段，仍须检查网络头、JS、frame、Worker/SW 一致性 |
| 默认时区/语言 | Java/ICU/Chromium 存在默认时区和 locale 传播的实现线索，但没有本次核实到的全上下文公开保证 | 不能从 `TimeZone.setDefault`、`Locale.setDefault` 或顶层 JS 值推导已成功 |
| 代理协议/认证 | ProxyConfig 没有凭据字段；Chromium 文档明确 SOCKSv5 不支持认证，目标 DNS 由代理解析 | HTTP 407、CONNECT、WebSocket、SW 和供应商认证组合需实际测试；不承诺 `user:pass@host` 自动可用 |

API 28 只是目录接口的可用下限，不是旧 Android 设备仍获得现代 WebView 安全更新的保证。生产支持应以受支持系统、实际 provider 版本和 feature 检查共同决定。

### 2.2 推荐最小路线

优先构建 Kotlin 原生小壳及 System WebView 能力原型，不先下载完整 Chromium：

- 主进程管理配置和列表，不提前初始化 WebView。
- 专用浏览进程在 WebView 初始化前选择固定 Profile 目录、时区及语言。
- 单活动 Profile 状态机管理启动、运行、停止、退出未确认和失败；只有明确退出证据才能复用进程槽。
- 启动前应用代理，收到配置完成回调后才允许加载页面。
- 切换时不能将 Cookie flush 等同于所有 LocalStorage/IDB 已提交，必须验证实际持久化及进程生命周期。
- 先用自有测试页面采集真实 Date/Intl、Navigator、frame、Worker/SW 和请求头，不用 JS 改写检测值或伪造通过。
- 不支持的协议、认证或身份能力必须明确报错/标未验证，不能回退直连、默认时区或假成功。

如果 WebView 无法满足时区传播、网络隔离或真实持久化边界，再进入自有 Chromium/Cromite 分支。Cromite 有代理、UA、时区相关能力，但不能因此视作本需求已完成。

Custom Tabs 不适合应用自己管理的多个独立持久 Profile 与任意代理/身份控制；CEF/Electron 也不是现成 Android 移植路径。普通手机应安装自包含 APK，不依赖 root 或任意替换系统 WebView provider。

### 2.3 网络安全边界

固定 HTTP/HTTPS 代理配置不证明 DNS、IPv6、WebRTC/STUN/UDP、应用自身请求全部走代理。媒体权限拒绝也不能视为禁用 WebRTC 数据通道。验证至少覆盖：

- 代理不可达、认证错误、连接中断、Wi-Fi/蜂窝切换；
- DIRECT/bypass、DNS、IPv6、WebSocket、Worker/SW、WebRTC；
- 旧 Profile 在切换后是否仍有后台连接；
- 应用用于出口检测的请求是否也使用同一代理，而非误用应用自己的直连 IP。

如确需 VPN 守门，应作为新的技术决策验证用户同意、其他 VPN 冲突和撤销/崩溃行为；不能自动修改系统 VPN、权限或其他 App 网络。未验证的通道标为未知，不声称“绝无泄漏”。

## 3. iOS 调研结论

### 3.1 已确认公开 API

- **iOS 17.0+**：`WKWebsiteDataStore(forIdentifier: UUID)` 支持独立持久 store；保存并复用 UUID，而非只使用默认/无痕 store。
- **iOS 17.0+**：`store.proxyConfigurations` 作用于使用该 store 的 WKWebView，应在加载前设置；不自动覆盖 App 其他网络客户端。
- Apple Swift 类型为 **`Network.ProxyConfiguration`**，ObjC/C 为 `nw_proxy_config_t`。不要将其他语言绑定里的 `NWProxyConfig` 照抄成 Swift 类型。
- 支持 SOCKSv5、HTTP CONNECT 等，提供 `applyCredential(username:password:)`；具体供应商认证组合须验证。默认不允许失败后退回非代理连接，不等于已证明所有通道无泄漏。
- `WKWebView.customUserAgent` 自 iOS 9 提供，但只改变 UA 声明。

### 3.2 普通 WebKit 的完整目标缺口

本次查阅公开资料及 iPhoneOS 26.5 公共 SDK，未找到逐 Profile 原生统一控制以下内容的公开接口：

- JS 默认时区；
- `navigator.languages` 与所有请求的 `Accept-Language`；
- 指定设备型号及配套硬件特征；
- 上述值覆盖页面、iframe、Worker 和 Service Worker。

`WKUserScript(forMainFrameOnly: false)` 能覆盖 frame 文档，但不是独立 Worker/SW realm 的通用接口。设置 Foundation 格式器、首次请求头或顶层 JS 不能代替这些能力。单活动 Profile 也不能补齐 API。

因此普通 iOS 17+ 产品可以做“独立 Profile + 代理”，但不能不加区分地承诺与 Android 同等的完整 Chrome/Blink 身份能力。

### 3.3 分发和引擎路线

1. **普通 WebKit 产品**：可按普通开发/签名方式实现，不预设必须 App Store；若上架，2.5.6 要求 WebKit，除非取得替代引擎授权。
2. **自用签名实验 Blink**：Chromium 有 `ios/blink`、`use_blink = true`、content_shell/chrome 及真机调试资料，官方仍标为实验/分析用途。存在 iOS JITless 分支，但没有核实到普通自签、无特殊授权、脱离调试器的稳定手机产品交付证明。不能断言绝对不可能，也不能当现成方案。
3. **地区授权替代引擎**：EU 为 iOS 17.4+/iPadOS 18+；Japan 正式资料为 iOS 26.2+、iPhone/iOS。需相应 entitlement 和持续安全义务；独立浏览器还涉及 Default Browser Entitlement。代理 IP 不是地区资格或授权的替代品。

BrowserEngineKit 是系统集成框架，不是可直接嵌入的 Chromium 成品。不建议越狱、绕地区资格或依赖反复调试器/JIT 重授权作为稳定产品。

## 4. 现有仓库复用范围

可以复用设计、纯规则和测试向量：

- Profile/代理校验、稳定 seed、身份整组约束；
- 有来源/时间的出口观察、显式设置优先；
- UA/UA-CH、语言、DST、屏幕/DPR/GPU 一致性合同；
- Ping0 严格 findings 判定及失败/未完成区分。

不能直接搬到手机：Electron/Node、桌面 PID/目录/进程发现、桌面 UI、CDP/BiDi runner、桌面原生补丁二进制。

源码定位：

- `src/main/types.ts`：现有 Android 类型是移动模拟，未定义完整 iOS 平台。
- `src/main/services/browser/launch-guards.ts`：managed Chromium 生产启动限制匹配 macOS/Windows 宿主。
- `src/main/services/browser-fingerprint-config.ts`：Android 元组和 UA/GPU 策略，不是真机校准证明。
- `src/tools/verify-ping0.ts`、`src/tools/ping0-acceptance.ts`：桌面采集与严格 findings 门禁。
- `docs/PING0_DETECTION.md`：历史检测项和桌面结果，不代表当前手机完整算法。

本次限定范围内未找到 Android/iOS 真机验收证据。

## 5. 最小验收矩阵

每平台先选一台自有真机、一个已校准设备身份，建立两个全新合成 Profile A/B，分别绑定不同固定出口。不得用真实账户/Cookie/令牌作测试材料。

| 项目 | 必须取得的证据 |
| --- | --- |
| 配置持久化 | 写入合成配置 → 直接查询实际数据库 → 关闭重开 → 按 ID/名称检索，核对完整性；失败事务不出现部分更新 |
| 网站数据 | 自有站点写入 Cookie/LS/IDB/Cache/SW → A/B 互不可见 → A 再打开读回 → 冷启动及系统回收后复验；能直接检查的测试存储须检查实际内容 |
| 切换 | 旧页面、Worker/SW、长连接和进程状态有明确结束或受限证据；未知不显示 Stopped |
| 网络 | HTTP/HTTPS 出口、认证、DNS、IPv6、WebRTC、网络切换及失败关闭；页面打开或 CONNECT200 不替代其他通道证明 |
| 时区/语言 | Date/Intl、DST、Navigator、真实请求头；顶层、同/跨源 frame、可用 Worker/SW、前后台和新建上下文一致 |
| 型号 | 对照同设备同内核原生基线，检查 UA/UA-CH、model/mobile、屏幕/DPR/触摸/方向、GPU 能力与实际绘制；不能只看字符串 |
| Ping0 | 在真实手机自然完成、刷新/重启复验，保留有效 rows/findings/pending 和覆盖缺口；403/429/网络失败是可达性未知，不是指纹失败或通过 |

目标 URL：`https://ping0.cc/env`。本轮完整页面抓取受限；未核实当前手机评分公式、未承诺必过。缺失/失败/未采集证据不应相互抵消形成 PASS。

## 6. 工作量与资源粗估

按熟悉 Android/Chromium 的工程人员估算，不是交付承诺：

- Android WebView 能力原型：1–2 人周。
- 原型通过后的极简可用版：约 4–8 人周。
- 自有 Android 内核：约 8–16 人周起，另有持续安全更新/重建/回归。
- iOS 仅隔离代理 WebKit 版：约 2–4 人周，不含完整指纹能力。
- 自签 Blink：先限额验证可交付性；完整版本不宜提前承诺工期。

Chromium 官方 Android 构建流程要求 x86-64 Linux、至少 8GB RAM（强烈建议超过 16GB）、至少 100GB 空闲空间。实际可按 32–64GB RAM、300–500GB SSD 规划源码、缓存和输出；macOS/Apple Silicon 不是该官方流程的原生 host。不可不经资源验证就下载/构建完整内核。

## 7. 2026-10-21 实施决策

用户要求先记录本报告，再开发 Android 版本。第一阶段实现独立 Android 工程和可运行的极简 WebView 候选，并以真实能力验证决定是否必须转自有内核；不同时开发 iOS。

- 保持桌面代码、原商业授权、匹配公共发行公钥与真实用户数据不变。
- 先构建内部开发候选，不冒充正式签名/公开发布或手机验收通过。
- 不用硬编码成功、吞错、仅 JS 注入或替换检测算法来满足目标。
- 不因能力缺口擅自降低完整需求；将未完成能力和下一步明确登记。
- 不提交/推送/发布，除非用户另有要求。

## 8. 官方来源与证据层次

### Android

1. [AndroidX WebKit 发布说明](https://developer.android.com/jetpack/androidx/releases/webkit)：多 Profile、UA metadata 与启动配置版本。
2. [Android WebView](https://developer.android.com/reference/android/webkit/WebView)：数据目录后缀及进程初始化边界。
3. [ProxyController](https://developer.android.com/reference/androidx/webkit/ProxyController)：公开代理签名、范围、feature 与完成回调。
4. [WebSettingsCompat](https://developer.android.com/reference/androidx/webkit/WebSettingsCompat)：UA metadata 和支持条件。
5. [Chromium 代理文档](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)：SOCKSv5 认证及 DNS 边界。
6. [Chromium TimeZoneController](https://chromium.googlesource.com/chromium/src/+/lkgr/third_party/blink/renderer/core/timezone/timezone_controller.cc)：ICU/V8/Worker 传播线索，不是 Java 设置全覆盖合同。
7. [Cromite 功能清单](https://github.com/uazo/cromite/blob/master/docs/FEATURES.md)。
8. [Chromium Android 构建说明](https://chromium.googlesource.com/chromium/src/+/main/docs/android_build_instructions.md)。

Android 部分官方全文/HEAD 回读受网络验证阻挡，使用已取得的官方公开索引和源码片段；没有宣称排除所有未索引实验接口。

### Apple / WebKit / Chromium iOS

1. [WebKit WKWebsiteDataStore.h](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebsiteDataStore.h)。
2. [Apple Network.ProxyConfiguration](https://developer.apple.com/documentation/network/proxyconfiguration)。
3. [Apple customUserAgent](https://developer.apple.com/documentation/webkit/wkwebview/customuseragent)。
4. [App Review Guidelines 2.5.6](https://developer.apple.com/app-store/review/guidelines/#software-requirements)。
5. [EU 替代引擎](https://developer.apple.com/support/alternative-browser-engines/)。
6. [Japan 替代引擎](https://developer.apple.com/support/alternative-browser-engines-jp/)。
7. [Chromium iOS 构建说明](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/ios/build_instructions.md)。
8. [Chromium content_shell 客户端](https://chromium.googlesource.com/chromium/src/+/lkgr/content/shell/browser/shell_content_browser_client.cc)。

Apple availability、Swift 类型和代理作用域由已取得的官方材料及公共 SDK 头文件交叉验证；未发现接口是本次限定公开 API 检查结果，不是所有私有实现的不存在证明。Chromium iOS 实验构建/JITless 结论主要依据官方搜索索引，未完整直接抓取或复现。

### 出口定位与外部检测

- MaxMind：[IP 地理数据](https://support.maxmind.com/knowledge-base/articles/maxmind-ip-geolocation-data)、[精度](https://support.maxmind.com/knowledge-base/articles/maxmind-geolocation-accuracy)、[网络数据](https://support.maxmind.com/knowledge-base/articles/maxmind-ip-network-data)、[代理识别](https://support.maxmind.com/knowledge-base/articles/anonymizer-and-proxy-data-maxmind)。定位只能作有不确定性的建议，不能由此推导设备型号或 GPS。
- [Ping0 环境检测](https://ping0.cc/env)：外部验收目标，不是本报告已完成的手机实测。
