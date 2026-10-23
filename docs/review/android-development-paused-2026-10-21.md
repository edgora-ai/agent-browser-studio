# Android 开发暂停检查点（2026-10-21）

## 当前决定

**状态：已暂停，项目未完成，未通过完整 Ping0 验收。**

用户明确要求：“先记录进度和状态，暂停android 版本的开发”。本记录用于保存断点；只有收到用户明确恢复 Android 开发的指令后才继续。不能因为旧计划、待办、后台通知或新会话自动续跑。

本次仅更新状态文档、待办和本机索引；不修改 Android 功能源码，不重新测试、构建、下载、启动设备、安装或发布。没有提交、推送、清理、迁移、扩容或重置既有产物/预算。iOS 仍只有调研，不转而自动开发 iOS。

## 暂停时进度

| 项目 | 已有结果；本次未重跑 |
| --- | --- |
| 工程 | 独立 Java17 Android 工程；内部 System WebView 能力验证候选，不是完整自有 Chromium 内核 |
| 已实现基础 | 环境列表/编辑、SQLite 配置与 revision/CAS、稳定独立数据目录、一次性启动与独立浏览进程、生命周期锁与真实退出确认、多 realm 原生身份采样、受限代理/GeoIP 建议流程 |
| 已修复 | 原生 SQLite PRAGMA 初始化、launch 摘要语义；固定测试链路的 CDN 加载；经核对的 Ping0 first-party 探针规则 |
| 最新候选 | build0014，85 个编译输入；SHA `b695e5fac2c7a98700159239e34c057e3ac7736c982924b7749ad68778f265d2` |
| APK | 开发版 3429471 B；SHA `8fca2f3bede9216ea0e39e6095e461caf78442899dd1273e6cac96fbce9b71b2`；已在专用模拟器安装、pull 读回匹配，v2/CRC/16 assets 核对通过 |
| 最近验证 | Core 194/194；宿主 Node 75/75、SQL/static 54/54、buildguard 9/9；Android native 48/48；Lint 0 errors / 9 warnings |
| 最新真实 Ping0 | 同一专用 Android15 / Pixel Tablet / WebView124 模拟器中，166/166、52/100 高风险、5 项异常；native partial68，不是通过 |
| 普通浏览 | 完整准入门禁仍阻止；固定观察不提升为产品能力验证通过 |
| 代码状态 | 分支 `feat/android-minimal-browser-20261021`；`mobile/` 和移动报告仍留在工作区，未进行本轮提交/推送/发布 |

上述构建/测试结果只描述对应候选与覆盖范围，不代表真实手机、完整网络约束、网站存储持久化或完整产品验收。

## 未解决问题

1. **核心时区能力缺口**：合成 profile 正确保存 US / `America/New_York` / en-US，新浏览进程本地采样仍报 `TIME_ZONE_MISMATCH`、`DATE_OFFSET_MISMATCH`，Ping0 仍读到 `Asia/Shanghai`。创建 WebView 前设置 Java 默认时区不足以实现原生 Date/Intl/frame/worker 的每 profile 时区；当前公开 System WebView API 路线不满足该核心需求。需要引擎/provider 层支持，不能用 JS shim、修改采样期望或系统时区补绿。
2. **DNS / IPv6**：页面 `resolver_count=0`；放行规范挑战后，整代 relay 的 112 次 DNS CONNECT 仍接收 0 B，IPv6 也失败。没有权威 DNS/具体失败 hop 证据，不推定 fake-ip 或认证根因。
3. **模拟器硬件特征**：2 核/2 GB、SwiftShader/Emulator GPU、RAF 146.99 ms 被检出；不伪造这些值，也不把模拟器结果当真实手机结果。
4. **其余产品能力**：安全代理认证、DNS/IPv6/WebRTC/UDP 完整约束、任意设备型号模拟、完整网站存储退出/切换持久性、真实手机与跨地区代理验收、正式授权/签名/发行仍未完成或未验证。
5. **检测覆盖不完整**：尚有范围外依赖拦截，网页的 166/166 不等于全部网络探针成功。

## 运行资源与保留状态

上一轮已正常退出自有浏览环境，native SQL 未确认 launch 为 0、integrity_check 为 ok；移除唯一 ADB reverse。自有 relay3 和 session0008 的模拟器/私有 ADB 已结束，无强杀。2026-10-21T15:15:35Z 已验证记录内进程组与监听端口为空；本次暂停记录没有重新启动任何资源，也没有进行新的设备检查。既有 Edge/v2rayN 等用户服务未被修改或停止。

原代码、APK、AVD、日志、失败证据和回执原位保留，不因暂停自动清理。原构建 cap1GiB、运行 cap12GiB/虚拟32GiB 及余量要求不变；本次不写入外置运行/构建卷，不创建新目标或增加构建范围。

## 恢复定位

- Android 入口：[mobile/android/README.md](../../mobile/android/README.md)。
- 最新详细实测：[android-ping0-load-recovery-2026-10-21.md](android-ping0-load-recovery-2026-10-21.md)。该历史报告及其已封存哈希不修改。
- 调研：[mobile-fingerprint-browser-research-2026-10-21.md](mobile-fingerprint-browser-research-2026-10-21.md)。
- 构建根：`/Volumes/DevProjectsSSD-74bf68f9/Temp/roxy-lite-cloak-oss/2026-10-21/android-minimal-4kjc5sn9`。
- 运行根：`/Volumes/ABSAndroidSSD-a08cc0639bed/Temp/roxy-lite-cloak-oss/2026-10-21/ping0-emulator-7dab2608`；target `a08cc0639bed`。
- 关键回执：构建根 `host-final-0014.json`、`milestone-0014.json`；运行根 `observation-0014.json`、`artifacts/final-owned-runtime-closed-0014.json`。
- `observation-0014.json` SHA：`63ed41e99c507239149049e04f50f3c36b99cfb94a28ababbaf032469465c940`。

恢复时先核对用户的新范围、共享存储索引/挂载身份、既有源码与产物、剩余预算和最新运行状态。不要复用旧 readiness/PID/STOP 标记重启脚本，也不要把本检查点当作完整 Chromium 下载/构建或额外资源使用的批准。
