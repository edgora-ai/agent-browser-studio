# Android 模拟器与 Ping0 实站观察（2026-10-21）

## 结论

**已运行真实 Android App、完成原生数据/进程验证，并在 App 自己的 WebView 中打开 `https://ping0.cc/env`；未取得有效评分，不能宣称 Ping0 通过。**

本次不是 DOM mock、外部 Chrome 或 host curl 代替 App。最终截图仍有 `{{ animatedScore }}`、`{{ phaseTitle }}` 等未执行模板，网页上的“检测中…未发现明显异常”也是静态模板，不是检测结果。同一受限测试代理上的对比请求显示：主页面可取得 HTTP 200，必需 CDN 脚本的 TLS 连接失败。该故障不证明指纹异常、代理认证失败或网站识别了模拟器。

[初始 0006 开发里程碑](android-minimal-development-2026-10-21.md)是历史记录；本文补充后续真实运行，不将早期 NOT_RUN/失败记录改写为成功。完整 Android 产品仍在开发，iOS 本轮未实现。没有提交、推送或发布 Android 安装包。

## 1. 实际环境与产物

| 项目 | 实测/身份 |
| --- | --- |
| 模拟器 | 本轮新建、无账号的专用 AVD；随后复用同一合成设备冷启动，未 wipe/reset 用户数据 |
| 系统 | Android 15 / API 35；安全补丁 2024-09-05 |
| 设备 | Google Pixel Tablet，arm64-v8a；不是物理手机 |
| WebView | `com.google.android.webview 124.0.6367.219`；旧 provider，不是最新 Chrome 覆盖 |
| Emulator | 36.3.10.0，software SwiftShader；800×1280，DPR 1 |
| App | `com.ahoo.abs.android.preview.debug` / `0.1.0-dev-internal`，独立开发签名 |
| 最终构建 | build0011；离线 Gradle 编译、Java contracts 188/188；Lint 0 errors / 9 warnings |
| 编译输入摘要 | `58806876957a61d1192718e0d6e16b1e7641fa6f8c937ec90f550b3852cd5eae` |
| App APK | 3,429,467 B；SHA-256 `b4f4db52d8a498a116d2d7f7709cdf41ea938c6f5423f16cda39479c398bdf8e` |
| Instrumentation APK | 37,590 B；SHA-256 `cc63dd98cd135435a4a6dbb5404a3059ebfff938004a2831e406bb392dfd6b3c` |

APK v2 签名、ZIP CRC、16 个打包 assets 与源文件匹配已核验。最终从模拟器重新 pull 已安装的 `base.apk`，大小和 SHA-256 与 build0011 一致，不以早期 0006 的读回代替此次检查。

同一 build0011 的 85 个冻结输入另作前后核对，最终 host 复验 **Node/VM 75/75、SQL/static 54/54、buildguard 9/9**，各执行一次、exit 0、sourceUnchanged。回执 `A/host-final-0011.json` 的 SHA-256 为 `c2ee4bbe8c792e61d28ffaf71a06d31eeb6e19849d913cf367669ab1ab977309`，其中 `A` 是初始报告登记的 `android-minimal-4kjc5sn9` 构建证据根。收集器在任何 suite 开始/输出创建前曾因控制路径 symlink 被拒绝；改用已核实的 canonical checker 后运行，原拒绝保存在回执中，没有重跑 suite 到绿。host 回执中的运行时 NOT_RUN 只限定该次 host 测试，不替代或否定本文独立设备记录。

REA 已安装包读回 Evidence：`ev_25fe33ce78246966368912309a3e711f448321ebc549c2255332b9a49fc529eb`。它证明 APK 字节身份，不独自证明站点行为。

## 2. 隔离与测试代理

用户另行批准了独立 32-GiB 虚拟上限 APFS 映像及 12-GiB 测试保留预算；没有扩容原开发卷。只读复用现有 SDK/系统镜像，没有接触旧 AVD 或真实手机。

私有 ADB 在启动前设置 `ADB_USB=0`、`ADB_EMU=0`、`ADB_MDNS=0`，分别禁用自动 USB、默认模拟器端口和 mDNS 发现。所有操作绑定本次私有 server 及明确 serial `127.0.0.1:61472`；REA CLI 逐命令指定私有 wrapper，没有修改全局 MCP/ADB/HOME/TMPDIR。

本轮 guest 无默认网络；最初 `10.0.2.2:61470` 代理路径实际返回 `net::ERR_PROXY_CONNECTION_FAILED`，guest 连通性检查为 `Network is unreachable`。没有归因于认证，也没有改成 DIRECT 回退。后续使用明确的实验通道：

```text
App HTTP proxy 127.0.0.1:61470（guest）
  → 本次 ADB reverse
  → host 自有 opaque CONNECT 测试代理
  → ping0.cc:443 / cdn.ping0.cc:443
```

最终代理代次 0002 的 host 端口为 52255，仅绑定 IPv4 loopback。它不解密 TLS、不保留请求头/Cookie/凭据/正文，只记录 origin、字节数和有限错误类型。浏览器继续执行原生 TLS 校验；没有关闭验证、添加 CA、改 trust store 或启用 WebView debugging。

**该通道的出口沿本机网络，不是不同国家代理实测。外层 emulator egress fence 是本次实验隔离，不是产品已实现 DNS/IPv6/WebRTC/UDP 无泄漏的证据。**

## 3. App 内真实操作与 Ping0 结果

实际操作链：环境列表 → `打开能力验证环境` → 本地身份采样 → `Ping0 诊断` → 原生确认框 `开始本次观察` → 固定 Ping0 页面 → 返回环境列表 → `请求退出当前环境`。

固定观察不是放开普通浏览：

- 一次许可绑定 session、启动摘要和 browser incarnation，最长 120 秒；离开、超时、自检或 drain 撤销。
- 顶层只允许固定 `https://ping0.cc/env`；不从网页或 Intent 接受任意诊断目标。
- 在核对真实公开 HTML 后，仅增加 CDN 的三个固定 JS 路径及 `/js/envdetect/` 静态 JS 模块树；CDN 不可成为顶层页面，且不允许任意路径、query、其他端口或其他域。
- WEB/SW 都执行范围检查；新窗口、外部 Intent 和未知依赖仍拒绝。网站显示任何结果均不提升普通 AdmissionGate。

观察经历：

1. 首次实际访问失败：`net::ERR_PROXY_CONNECTION_FAILED`，尚未取得站点结果。
2. 改用本次 ADB reverse 后，真实远站 HTML 加载；初始严格策略阻止 CDN，出现 9 次 dependency/navigation 回调计数，没有有效分数。
3. build0011 允许已核对的静态脚本后再次实测：远站页面真实显示，但仍有未展开的 Vue 模板；native banner 为 **partial，2 次阻止回调，脱敏 origin 为 `https://cdn.ping0.cc`**。没有记录这两个请求的完整路径，因此不猜测其类型或必要性。
4. 双域代理实际收到 CDN CONNECT，但这些隧道未取得上游响应字节。自有 `:browser` PID 的有界原生日志投影得到 SSL error 1 / `net_error=-100`；只记录错误码，**日志无法逐项绑定 URL**，不冒充精确请求归因。

随后使用同一自有 CONNECT 代理和正常 TLS 校验作独立运输对比，不执行下载的 JS，也不保留响应正文/headers/Cookie：

```text
$ /usr/bin/curl [同一测试代理，正常 TLS，20 秒上限] https://ping0.cc/env
exit=0   HTTP=200   received=53886 B

$ /usr/bin/curl [同一测试代理，正常 TLS，20 秒上限] https://cdn.ping0.cc/js/vue.min.js
exit=35  HTTP=000   received=0 B
curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to cdn.ping0.cc:443
```

这是 host 运输对比，不是 WebView 的 HTTP status 采集或指纹验收。它支持“必需 CDN 脚本的连接在此测试路径上失败”；具体网络 hop、服务端/中间网络原因及证书根因仍未知。不通过切换未批准站点、忽略 TLS 或替换页面/评分脚本来补绿。

**最终：score 未知，完成项数未知，异常项未知；Ping0 状态为 BLOCKED / INCONCLUSIVE，不是 PASS，也不是已测出的低分/指纹 FAIL。** 即使后续 CDN 可达，仍需核对未知第三方 GeoIP/DNS 等依赖；当前范围不能保证完整评分。

### 截图证据

本地证据根简称 `B`：

```text
/Volumes/ABSAndroidSSD-a08cc0639bed/Temp/roxy-lite-cloak-oss/2026-10-21/ping0-emulator-7dab2608
```

- 实际远站模板与 partial banner：`B/screens/0011-ping0-cdn-01/screen.png`，800×1280；已人工查看，不是首次导航时仍显示本地 probe 的旧帧。
- 截图 SHA-256：`670339b857fc7335f53a3bad58cd96944843c0db21ac5d1399e73a9572d4f643`。
- REA Evidence：`ev_915bbd31122c5bf4c17a60baf93f3c8c96945edc8c3260b043003794d649283e`。单帧不证明检测完成，也不独自绑定 App APK；安装包读回、实际界面动作和原生运行回执分开保存。
- 正常退出界面：`B/screens/0011-normal-exit/screen.png`，已查看。

## 4. 真实 Android 发现并修复的两项阻塞

### SQLite PRAGMA 调用错误

`secure_delete=ON` 和 `busy_timeout=5000` 即使是赋值 PRAGMA，也返回行；Android `execSQL` 实际抛 `SQLiteException`。最初默认库 user_version 为 0、schema 为空，App 明确显示存储不可用，没有生成默认环境掩盖错误。

改为通过 `rawQuery` 消费单行整数结果，并分别再读回 `secure_delete=1`、`busy_timeout=5000`。保留 foreign keys、WAL、FULL、备份限制、schema/owner 检查和 existing-only 打开方式。原始失败库和污染的早期导出都保留，未截断或回填后冒充有效库。

### profile 摘要与启动封套摘要混用

SQL 中 `launch_records.config_hash` 冻结 profile fingerprint；原 publish 错存了含 session/nonce/时间的强 LaunchSpec envelope hash，触发真实 `launch_snapshot_mismatch`。

修正 publish/decode/current-profile 比较的摘要语义；Core 强启动摘要、nonce/session/时间校验、不可变 trigger 和发布读回均保留，没有迁移/清库/弱化 guard。原生错误 hash INSERT 反例实际被 trigger 拒绝，exit 19，事务没有留下 launch row。

同进程第二次 claim 实际先被 `ProcessBinding.requireUnbound()` 拒绝为 `RUNTIME_IDENTITY_MISMATCH`；仅修正测试期待，没有放松生产 guard。另一个未绑定进程的原生 `LAUNCH_REPLAY` 分支仍未覆盖。

## 5. 原生数据流、身份及退出验证

最终 build0011 上重新执行 fresh `ownedScope` 的 instrumentation，真实输出：

```text
checksPassed=48
pragmaSecureDeleteSet=1
pragmaSecureDeleteReadback=1
pragmaBusyTimeoutSet=5000
pragmaBusyTimeoutReadback=5000
storedLaunchHashKind=PROFILE_FINGERPRINT
coreLaunchHashKind=SESSION_NONCE_TIME_ENVELOPE
launchEnvelopeReadback=VERIFIED
expectedStorageCode=EXIT_EVIDENCE_REQUIRED
observedStorageCode=EXIT_EVIDENCE_REQUIRED
stage=COMPLETE
status=PASSED
failureCode=NONE
INSTRUMENTATION_CODE: -1
```

此套件的 `webViewAndPing0=NOT_RUN` 明确指它自身只验原生 SQLite/解析/启动票据，不否定另外保存的真实 UI 站点观察。`INSTRUMENTATION_CODE: -1` 是 Android 的该次成功结果码，不是 shell 失败退出码。

配置数据流另有真实 UI 与原生 SQL：保存合成 profile → 直接 `/system/bin/sqlite3 -readonly` 查询默认库 → 同一 AVD 冷启动仍可读回 → UI 按名称检索到原环境。无凭据 profile，**没有据此宣称 AndroidKeyStore 加解密已实测通过**。

最后正常退出后，默认配置库直接查询输出：

```text
# name | has_credentials | length(config_hash) | stable_suffix_matches_id
emu-native-default|0|64|1
# state | phase | count
EXIT_CONFIRMED|100|3
# unconfirmed_launch_count / credential_envelope_count / integrity_check
0
0
ok
```

实际 UI 显示“确切 PID 为 ESRCH 且生命周期锁可获取”；本次自有 `:browser` 的 `pidof` 返回 1、stdout 为空。没有把 Activity finish、TTL、Cookie flush 或进程 stop reply 当成退出证明。

本地 identity sampler 在当前默认配置下显示一致的 **Asia/Shanghai / en-US 子集**。原生 UA 仍如实暴露 Android 15 / Pixel Tablet / WebView Chrome 124，software SwiftShader 等真实模拟器特征未改写。部分 realm 可 unsupported；这不是任意时区/语言传播、全设备模拟或六个 realm 全通过的结论。

## 6. 退出、保留与未完成范围

正常退出 App 子进程后，仅移除本次 `tcp:61470 → tcp:52255` reverse；再请求停止自有测试代理、模拟器和私有 ADB。实际结束结果：

```text
proxy generation0002: requested-stop, 22 connections, 118749 B
emulator: exit 0, forced=false, remainingPids=[]
private adb: exit -15 (SIGTERM), forced=false, remainingPids=[]
```

2026-10-21T09:44:50Z 再查本次 PGID 均为空，先前自有 61469/61470/61471/61472/52255 端口均无 listener。范围仅限 OS 可见的本轮已记录资源，不声称全机/所有隐藏进程均关闭。没有清理旧输出、卸载未知卷或操作其他设备。

该时点实际容量：

- B retained：1,112,480,869 B；独立 sparsebundle allocated：1,328,545,792 B，均在原 12-GiB 累计预算内。
- 新 APFS free：32,939,167,744 B；host free：348,124,086,272 B；各自保留 10 GiB。
- 原开发卷 free：7,352,082,432 B；仍保留 6 GiB。构建根仍是原单一 1-GiB cap，没有重置/删除旧尝试来腾预算。

待完成：可实际取得全部必需资源的代理路径与完整 Ping0 重测；不同国家代理、与系统不同的时区/语言及跨 realm 传播；真实手机与较新 provider；安全 WebView 代理认证；DNS/IPv6/WebRTC/UDP enforcement；完整网站存储生命周期与 profile 切换；完整设备模型；正式授权/签名/发行。普通浏览门禁继续阻止，以上原生通过项不提升未验证能力。

原始失败、各版 APK、所有本次合成数据库及运行记录留在登记证据根，不进 Git/app resources。核心回执见 `B/artifacts/native-instrumentation-0011.{json,txt}`、`installed-0011-readback.json`、`host-public-tls-comparison-0011.json`、`owned-browser-tls-codes-0011.json`、`native-final-profile-exit-0011.json`、`final-owned-runtime-closed-0011.json`、`B/session-ended-0005.json`。
