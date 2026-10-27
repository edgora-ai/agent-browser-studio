# Android 可控原生内核：时区缺口与构建准入（2026-10-27）

## 用户决定与当前状态

用户要求修复安卓版指纹评分，并明确选择可控原生内核，而不是继续依赖 System WebView 的公开接口；随后选择复用现有 Linux 构建机。

**本报告核对阶段尚未取得构建机标识/已有专用 CI 目标及工作目录，因此没有连接未知机器、安装依赖或启动原生构建。**用户随后要求提交开发分支，由其他服务器按交接任务继续；源码检查点不代表已经部署到构建机。本阶段没有产品代码修复或新的模拟器评分结果，原来的 52 分不能改写为通过。

## 1. 已确认的范围

最后真实 Ping0 结果来自历史 build0014：52/100、高风险、166/166、5 项异常，同时存在 68 次受限依赖回调，因此覆盖仍为 partial。五项分别是：

1. 页面 IP 国家 US，但原生时区为 Asia/Shanghai；配置保存的是 America/New_York。
2. 两核心、2 GB 的模拟器资源被页面标为 VPS 信号；名称不证明实际运行在 VPS。
3. RAF 约 146.99 ms；具体性能原因没有建立。
4. Linux aarch64 / Android Emulator / SwiftShader；不是物理设备 GPU 结果。
5. DNS resolver_count=0；不能仅由该值定位客户端、上游或权威 DNS 故障。

本轮确认原选定 loopback SOCKS5 测试端点仍有相同进程归属；经该路径只读获取公开 Ping0 HTML/两个直接引用脚本，正常 TLS 且没有认证/Cookie。未执行获取的 JavaScript。宿主运输成功不是浏览器或评分验收。

公开脚本核对显示：challenge 的 HTTPS GET 和同源 DNS 结果 POST、评分提交 POST 均与当前策略相容，不能以旧 partial 计数直接推定这些请求被误拒。条件验证码路径需要额外第三方依赖，但本轮没有证明它被触发，不放宽第三方白名单。DNS 异常处理也能生成零值，所以最终 evidence 中 resolver_count=0 不保证是原始接口返回零记录。

## 2. 为什么不继续尝试 Java 默认时区参数

当前 `BrowserApplication.attachBaseContext` 已在实际 WebView 构造前设置 Java TimeZone/Locale 默认值。匹配 Chromium 124.0.6367.219 上游源码的机制为：

- 同一进程初始化 native ICU 时通过 JNI 读取 Java 默认时区；不能笼统说 Java 默认值永远无效。
- renderer 先读取其自身进程的 ICU 默认时区，然后订阅监视器。
- `TimeZoneMonitor::AddClient` 只注册客户端，没有补发 App 进程当前默认时区。
- 匹配 ICU 的 Android `uprv_tzname` 分支使用系统时区缓存；`getenv("TZ")` 属于非 Android 分支。

因此，独立目录/`:browser` 进程并不提供 per-profile renderer 时区传播。所查 AndroidX WebKit 1.12 API 未提供受支持的任意原生时区 setter。没有通过系统时区修改、隐藏 API 解禁、生产 CDP 调试、页面 Date/Intl shim 或改检测脚本代替实现。

参考：

- https://chromium.googlesource.com/chromium/src/+/124.0.6367.219/base/i18n/icu_util.cc#307
- https://chromium.googlesource.com/chromium/src/+/124.0.6367.219/services/device/time_zone_monitor/time_zone_monitor.cc#69
- https://chromium.googlesource.com/chromium/src/+/124.0.6367.219/third_party/blink/renderer/core/timezone/timezone_controller.cc#55
- https://chromium.googlesource.com/chromium/deps/icu/+/bad7ddbf921358177e56fd723c2f59f8041a370f/source/common/putil.cpp#1143

这些是上游源码事实；本轮没有用它们冒充实际 provider 二进制的完整同源性或新的运行证明。

## 3. 现有 native 能力的复用切口

现有 Chromium 基线为 152.0.7977.72，声明的上游目标为 `026bb13a93d60e7adfefa2bbf58d6f57c2d335cc`。补丁 manifest 已到 0056；新增顺序补丁不能覆盖已有编号。

已有 `0025-native-timezone-identity.patch` 在 Blink `TimeZoneController` 初始化中采用 ICU/V8 原生时区覆写，是本轮最小验证切口。现有 Navigator/Worker hooks 与冻结配置机制也有公共 Blink 消费路径，但 Android 接入并未完成：

- 配置的 persona 启用条件仅接受 Win32/MacIntel；UA-CH 部分固定为 desktop，不能用桌面 persona 冒充 Android。
- 配置转发接在 `ChromeContentBrowserClient`，不能假定自动覆盖 Android content shell 或 WebView embedder。
- 进程级冻结配置必须在首次读取前安装，每个 renderer/worker 使用同一份配置；不能通过运行时换 Java profile 对象切换 native 单例。
- 暂无经本轮核验的自有 Android Chromium APK/AAR/native 包。约 3.4 MB 的现有开发 APK 使用系统 WebView，不是可控内核成品。

建议首个目标为**自包含 Android content-shell 验证 APK**，只验证独立进程的冻结原生时区，不先重做产品 UI、替换系统 provider 或承诺全部 GPU/网络能力。CPU、内存与 GPU 先保持设备真实基线，不以改字符串隐藏模拟器。

首个接受矩阵：无配置原生对照；纽约与另一 IANA 时区分别独立进程启动；主页面、同/跨源 frame、Dedicated/Shared/Service Worker 读取实际 Date/Intl 冬夏 offset；新建 Worker、正常重启后保持同一冻结配置。不支持的 realm 明确未覆盖，且此矩阵通过仍不等于完整 Ping0、DNS 或真实业务验收。

## 4. 本机实际构建条件

本轮定点只读检查现有 Chromium 152 源树，发现：

- `build/config/BUILDCONFIG.gn:262` 明确 Android 构建仅支持 Linux host；本机是 macOS。
- `docs/android_build_instructions.md:16–24` 要求 Linux x86-64，至少 8 GB RAM，推荐超过 16 GB，至少 100 GB 可用磁盘。这是上游最低参考，不是本项目已批准峰值预算。
- Chromium 指定的 `third_party/android_toolchain/ndk` 和 `third_party/android_sdk/public` 当前缺失。
- 该源码 GN 默认 Android platform/build-tools 37；现有轻量 App 的 SDK35/NDK27.3（仅 darwin host）不能直接等同为该 native 目标的匹配工具链。
- 定点检查未见现有 Android native 输出；本机 Colima/Lima 元数据未列出可复用 Linux 实例，没有启动 VM。

原 Android App 构建 1 GiB cap 和模拟器 12 GiB cap 不扩展为 Chromium 构建预算，不自动扩容、清理历史输出或复制大源码。本机其他卷有余量也不构成新构建目标获批或可以直接复用的证据。

## 下一步的必要输入

需要用户指定现有 Linux 构建机的已配置 SSH Host 别名（或专用 CI 链接）及可用工作目录；不发送密码、私钥或 token。先只读核 CPU/RAM、工具版本、已有源码/依赖、输出与磁盘准入，再定最小 patch 和构建任务；不连接猜测主机或擅自上传源码。
