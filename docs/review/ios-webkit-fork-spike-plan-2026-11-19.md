# iOS 自建引擎（WebKit fork）可行性 spike 计划 — 2026-11-19

状态：**计划文档，尚未执行任何 spike 步骤**。本文档不建立任何构建、运行或指纹证据；所有
`nativeExecution` / `runtimeVerification` 类结论均为 `NOT_RUN` / `NOT_ESTABLISHED`，与
Android 交付文档的证据纪律一致。

## 背景与目标

iPad 版 ABS Browser（`mobile/ios/`）当前基于系统 WKWebView，指纹能力边界见其 README 的
能力矩阵：Profile 隔离与代理为引擎级，时区/语言为页面级注入（Worker 域与 Accept-Language
头泄漏），Canvas/WebGL/字体/屏幕为真实设备值。Android 版的引擎级能力来自 ~60 个 Blink
补丁（`patches/chromium/patches/`），WebKit 上没有等价入口。

目标：评估「fork 开源 WebKit + 自建 iPad app」能否把 Android 版的指纹控制水平搬到
iPad。约束：**仅自用、不分发**（无 App Store/DMA 分发约束，但 iOS 27.2 无 TrollStore，
签名只能走 Xcode 个人/付费开发者账号）。

## 为什么可能可行

- 开源 WebKit 上游由 Apple 维护 iOS port（`build-webkit --ios --device`），Safari 本身
  即由此构建；不必从零移植引擎。
- 自用不分发 → 不需要 BrowserEngineKit entitlement 申请流程；风险点收敛为「真机上
  JIT 是否可用」与「WKWebView 之外的 WebKit 嵌入工作量」。
- 团队已有给引擎打指纹补丁的完整工程经验（Blink 60 补丁 + 校验语料 + 证据文档体系），
  WebCore 层补丁移植是熟悉领域。

## Phase A — 模拟器验证（免签名，先行）

1. 构建：`Tools/Scripts/build-webkit --ios-simulator --release`（WebKitToJSC/JSC 在
   模拟器上默认允许 JIT，无 entitlement 问题）。
2. 嵌入：以 MiniBrowser/CocoaTouch 模板为基础建一个最小 app，链接自建 WebKit framework
   （非系统 WKWebView），加载固定页面并截图验证渲染/输入。
3. 补丁试点：移植 1 个最小补丁作为路径验证——建议 `0025-native-timezone-identity` 的
   WebCore 等价物（`Date`/ICU 时区注入点在 WebCore 的 `DateMath`/`TimeZoneController`
   一侧），在模拟器内用 BotD 类页面断言生效。
4. 性能基线：JetStream/Speedometer 跑分对比系统 WKWebView，确认自建构建没有病态回退。

**产出**：`docs/review/ios-webkit-spike-phase-a-<date>.md`，含构建日志摘要、嵌入截图、
补丁 diff、跑分数字。证据纪律：只记录实际执行的命令与观察值。

## Phase B — 真机验证（需 $99 开发者账号）

1. `build-webkit --ios --device` + 个人/付费签名安装到 iPad（iOS 27.2）。
2. **JIT 探测（go/no-go 关键）**：JSC 在无 JIT entitlement 的真机上应退化为
   解释执行（llint）。测量：Speedometer 模拟器值 vs 真机解释执行值；差值倍数即
   「慢 N 倍」的实际数字。若不可接受，评估 BrowserEngineKit JIT entitlement 在
   非分发场景下能否通过个人账号申请（预期不可，如实记录 Apple 的答复）。
3. 存储与进程模型验证：每 Profile 独立 data store / 数据目录在自建引擎里的等价物
   （WebKit 的 WebsiteDataStore C++ 层 + 自管数据目录）。
4. 网络栈验证：自建引擎的代理路径（WebKit 网络进程 + 自建 proxy 配置）对比
   WKWebView `proxyConfigurations`。

## 补丁移植清单（初评，量级为工程判断，非实测）

| Blink 补丁 | WebKit/WebCore 对应面 | 预估量级 |
|---|---|---|
| 0025 timezone（ICU/V8 进程级） | WebCore `DateMath`/`TimeZoneController` + JSC ICU | 中 |
| 0003 screen/DPR | `Screen.cpp`/`DOMWindow` | 小 |
| 0004/0016/0024 canvas 噪声 | `CanvasRenderingContext2D`/`ImageData` 读回路径 | 中 |
| 0005 WebGL 身份 | `WebGLRenderingContext` getParameter/capability | 中 |
| 0006/0008 audio 噪声 | `AudioBuffer`/`AnalyserNode`（WebAudio） | 中 |
| 0013/0017 字体白名单/目录 | `FontCache`/`FontDescription` | 大 |
| 0011/0012 WebRTC | WebKit WebRTC 支持不完备，iOS 上基本无 WebRTC 面 | 转化为「禁用即可」 |
| 0020/0031 WebGPU | `WebGPUAdapter`（iOS WebGPU 尚在 gate 后） | 低优先 |
| 0026 accept-language | 网络进程 header 生成点 | 小 |
| 0007/0027/0039 storage quota | `StorageManager`/`StorageQuota` | 中 |
| 0033 theme | `LayoutTheme`（iOS 有原生等价） | 小 |
| 0010 ClientRects | `Element` geometry export | 中 |
| 0029/0032-0037 CDP 一致性/输入 | 桌面自动化域，iPad 自用不需要 | 移植范围外 |

总计：核心可移植面约 12 项；保守估计首轮移植 + 语料校验为**数周到数月**量级，其后是
跟随上游 WebKit 的持续 rebase 负担（WebKit 上游没有 ABI 稳定承诺，rebase 频率高于
Chromium 补丁系）。

## Go/No-Go 标准

- **Go**：Phase B 真机 JIT 可用（或解释执行性能差 ≤2 倍且可接受）；时区/Canvas/字体
  三类试点补丁在真机通过 BotD/CreepJS 对比；每 Profile 数据隔离等价。
- **No-Go（当前预期倾向）**：JIT 被锁且解释执行慢 >3 倍；或自建引擎嵌入工作量超出
  试点外推；或 WebGL/字体面在 WebKit 的注入点不稳定。
- No-Go 时的落点：维持 WKWebView MVP（已交付），把引擎级需求留在桌面/Android 引擎侧。

## 明确不做 / 非声明

- 不把自建引擎用于任何分发渠道；不申请/冒用欧盟 DMA entitlement。
- 本文档不声明 Chromium/Blink-on-iOS 路线（上游无第三方可复用路径，Google 未交付）。
- 本文档不建立任何「指纹可通过检测」的结论；所有覆盖结论以 Phase A/B 的实际探针
  输出为准。
