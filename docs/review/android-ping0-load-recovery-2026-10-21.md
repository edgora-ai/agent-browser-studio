# Android Ping0 加载恢复与原生能力实测（2026-10-21）

## 结论

**已经解决本次测试链路上必需 CDN 不可达造成的 `{{…}}` 页面未初始化：真实 Android App 现在能执行原站检测并显示数字结果。尚未解决完整指纹需求，不能称为 Android 产品完成或 Ping0 通过。**

最新 build0014 / session0008 在真实模拟器内显示：

```text
检测完成
52 / 100 · 高风险
已检 166 / 总 166 · 异常 5
```

这不是旧 build0013 的截图，也不是 curl 或 DOM fixture 结果。原生许可仍标记 **partial 68 次拦截回调**，尚有范围外的第三方依赖；166/166 是网页自己的完成计数，不证明所有外部探针成功。

更重要的实测结论：**profile 中正确保存了 `America/New_York`，但网页仍读到 `Asia/Shanghai`。当前 System WebView 不能仅靠 Java 默认时区设置实现所需的原生、多执行上下文、每 profile 时区。这个候选不满足用户的核心时区需求，不能以补界面或修改采样期望掩盖。**

历史[十分钟等待记录](android-ping0-extended-wait-2026-10-21.md)和[直接网络失败记录](android-ping0-cdn-transport-cause-2026-10-21.md)保持不变；本报告记录后续恢复与新结果，不将旧失败改写成成功。

## 1. 实际修复

### 1.1 恢复原 CDN 的真实运输

先前宿主直接访问 `cdn.ping0.cc` 的两个 IPv4 在 TCP 建连后出现 TLS reset，IPv6 未建 TCP。没有关闭证书校验、替换域名/SNI、替换 Vue/评分脚本或采用证书不匹配的地址。

本轮核实了已经运行的本机代理出口。旧 Xray 实例退出时，测试转发器正确拒绝启动；另一个 Xray 实例查询超时，均保留失败。最终使用已经存在且正常工作的 Edge SOCKS5 出口，通过本轮自有、限定目的地的 CONNECT 转发器接入专用模拟器。只使用无认证 SOCKS 协商和按域名 CONNECT；没有读取、修改、重启或停止现有代理的配置、认证材料或服务。

正常 TLS 下，原 Vue 资源实际 HTTP 200 / 94151 B，SHA-256：

```text
9174c425c445377df4562ad9165ea08fdf9433a808296d7de5f619791df10e17
```

主站 HTML、原 `main.js` 也经同一测试链路取得 HTTP 200。继而 build0013 在真实 App 中第一次显示 52 分；不是以 host 请求成功代替浏览器实测。该次截图是 `B/screens/upstream-app-ping0-01/screen.png`，仍 partial 171，不能代替下面 build0014 的结果。

这是**固定测试链路的恢复**，不是证明用户原直接网络的 reset 根因已查清，也不是已交付手机上可独立使用的代理服务。没有 DIRECT 回退。

### 1.2 修复自身对白名单内必需探针的阻断

从原站公开 HTML/JS 静态核对精确资源模式后，build0014 最小调整 `Ping0ObservationPolicy`：

- CDN：原静态 JS/模块树，加两个确切图片路径 `/images/light.png`、`/images/yanhua.png`；不放开任意 CDN 路径。
- IPv4/IPv6：仅非顶层 GET `https://ipv4.ping0.cc/envdetect/ipinfo-cors?token=` 和对应 IPv6 URL。非空 token、其他参数或路径仍拒绝。
- DNS：仅 `r-<13位时间戳>-<0至9007199254740990的规范整数>.d.ping0.cc` 的非顶层 GET `/probe`；query 仅允许缺省或经核对的 `[0,1)` 数字格式。不允许基础 `d.ping0.cc`、任意子域、任意参数或其他端口。
- 挑战主机在诊断记录中脱敏为 `<dns-challenge>.d.ping0.cc`，不保存挑战标签。
- 原生确认框如实说明新范围和仍未覆盖的依赖。

新增五组正反回归，覆盖图片、IP 查询、DNS nonce/query、过期/撤销/顶层/POST/非法 authority/溢出等拒绝条件，以及脱敏与去重。

session/config/incarnation 绑定、600 秒撤销、两分钟 launch 票据、WEB/SW 共同检查、普通浏览门禁不变。没有放开任意第三方、验证码、STUN/UDP、外部 intent 或新窗口。App 的 URL/method 规则不等于 MIME/响应体校验或完整网络防火墙。

## 2. build0014 的真实结果

仍是本轮无账号专用 Android 15 / API35、Pixel Tablet、arm64 模拟器，WebView `124.0.6367.219`、SwiftShader、800×1280 / DPR1；复用同一自有 AVD，不 wipe/reset，不代表真实手机或最新 Chrome。

2026-10-21T14:48:37Z 通过真实原生“开始本次观察”确认。网页日志显示 `48:58.65 [SCORE] 完成：52 / 100 等级：red`。随后截屏并实际查看，AX 读出完整 166/166 和五项异常：

| 异常 | 页面实测 | 结论边界 |
| --- | --- | --- |
| IP 国家 ↔ 时区 | `ip_country=US · tz=Asia/Shanghai` | 配置时区未成为网页原生时区；是真实功能缺口 |
| VPS 信号 | `cores=2 · memory=2` | 本模拟器资源特征，不伪造数值 |
| RAF 帧间隔 | `146.99 ms` | 本次运行观测；不等同于真实手机结果 |
| UA 平台 ↔ GPU | Linux aarch64 / Android Emulator OpenGL ES Translator / SwiftShader | 模拟器 GPU 被识别；不伪造 GPU 来补绿 |
| DNS 黑洞 | `resolver_count=0` | 放行挑战并未产生有效解析器结果，不能宣布 DNS 已修复 |

原生 banner：partial 68；最多八个脱敏 origin 包括 ipify、BigDataCloud、ip.sb、ipinfo、GeoJS、ipapi 及验证码资源。没有据此自动扩大范围。171 与 68 属于不同轮次的回调计数，不按差值推算唯一请求或证明全部必需依赖已成功。

### DNS / IPv6 的进一步事实

自有 relay3 整代日志含明确的 host 正反检查和一次 App 观察，不能将所有记录逐条归属到某个网页请求：

- DNS challenge CONNECT 112 次，已关闭 112 次，发送 64966 B，**接收 0 B**。
- IPv6 CONNECT 3 次，接收 **0 B**；独立正常 TLS 查询也失败。
- IPv4 CONNECT 2 次，接收 11991 B；独立 exact-query 查询 HTTP 200。
- 总 128 connections，120 connected/closed，8 次范围外拒绝。

`connected` 仅表示 SOCKS CONNECT 被接受，不证明 TLS、HTTP 或权威 DNS 查询成功。没有当前代理解析器/权威日志，不能直接认定 fake-ip、哪个 hop 丢包，或借用旧桌面/旧版本的错误码作结论。实验外层的 UDP/直连限制同样不能冒充产品级无泄漏证明。

## 3. 原生时区断点：不是配置丢失

先正常退出，真实编辑合成 profile 为 US / `America/New_York` / en-US；未使用 GeoIP 失败结果冒充自动建议。直接对 Android 私有 SQLite 执行只读查询，退出后再次验证：

```text
emu-native-default|US|America/New_York|en-US|0|1
EXIT_CONFIRMED|7
0
ok
```

依次是 profile 配置/无凭据/固定 suffix 校验、退出记录、未确认 launch 数及 integrity_check。列表也实际检索到已保存值。fresh browser 本地采样显示 `TIME_ZONE_MISMATCH`、`DATE_OFFSET_MISMATCH`，Ping0 独立显示上海时区。

源码链路中 `BrowserApplication.java:39–52` 在创建 WebView 前设置 Java `TimeZone`、Locale/LocaleList 和 Context 资源 Configuration。时区经 profile 序列化、数据库读回及 launch 冻结后传入，没有遗漏字段。**Java 默认时区并不是 Chromium 原生 Date/Intl、renderer、frame、worker 的 per-profile 设置接口。** `setDataDirectorySuffix()` 只隔离数据目录，也不提供此能力。重复启动或把调用再提前不能补齐公开接口缺口。

本地采样使用各 realm 的原生 Date/Intl，比较当前及冬夏 offset；不通过 JS 原型包装改值。合并错误码仅证明至少一个已采样 realm 不匹配，不因此断言每个 realm 都是上海。语言与 HTTP 请求头仍按实际覆盖分别验证，不能从两个时区错误码推定全部语言失败。

要交付用户要求，后续必须有引擎/provider 层正式支持：在首段网页脚本前应用 profile 绑定的 IANA 时区、原生 Date/Intl 与 DST 规则、所有 frame/worker/renderer 重建的继承与隔离；语言还需与 Navigator/Intl/网络策略一致。**当前仅公开 System WebView API 的路线不满足这些要求。** 本轮没有擅自下载/构建完整 Chromium，也没有更改系统时区、使用 CDP/debug、私有 API 或 shim 来掩盖缺口。

参考：[Java TimeZone](https://developer.android.com/reference/java/util/TimeZone)、[WebSettings](https://developer.android.com/reference/android/webkit/WebSettings.html)、[WebView](https://developer.android.com/reference/android/webkit/WebView)、[AndroidX Profile](https://developer.android.com/reference/androidx/webkit/Profile)。这些 API 的能力边界不是当前 provider 内部 ICU 调用栈的取证结论。

## 4. 实际构建与验证

| 项目 | build0014 实际结果 |
| --- | --- |
| 冻结编译输入 | 85 个；SHA `b695e5fac2c7a98700159239e34c057e3ac7736c982924b7749ad68778f265d2` |
| 完整离线 Gradle | Core / App APK / instrumentation APK / lint，exit 0；源码不变、owned group 空 |
| Core | `TOTAL 194 PASS 194 FAIL 0` |
| Lint | 0 errors / 9 warnings；不将 warnings 说成零 |
| Node/VM probe | 75/75，exit 0 |
| Python SQL/static | 54/54，exit 0 |
| Python buildguard | 9/9，exit 0 |
| Android native suite | 新 ownedScope，48 checks / PASSED / COMPLETE；不包含网页检测 |
| App APK | 3429471 B；SHA `8fca2f3bede9216ea0e39e6095e461caf78442899dd1273e6cac96fbce9b71b2` |
| 已安装 APK | REA 从本模拟器 pull 后大小/hash 匹配，不以 host APK 代替安装证明 |
| APK 静态验证 | v2 签名、ZIP CRC、16 个原始 assets 匹配；仅开发签名 |

三套宿主回归各执行一次，前后 source inventory 与本轮 producer 相同；完整 argv/stdout/stderr、哈希和读回保留。上述测试通过不把网络/网站存储/KeyStore/真实手机或完整产品能力提升为 VERIFIED。

## 5. 正常退出与保留

600 秒后实际观察到许可到期撤销。随后通过真实 App UI 返回列表、请求退出，显示精确 PID ESRCH 且生命周期锁可获取；没有以 Activity finish 或 Cookie flush 当退出。

已显式移除唯一 guest61470 → 本轮 host52426 reverse，并读回无绑定。两个早期收尾片段因 ADB 输出尾部空行被误计为第二条绑定而在变更前停止；原始只读输出和校正说明保留，没有对未知映射操作。

自有 relay3 期限结束；session0008 按请求停止：emulator exit0、private ADB exit−15，均 forced=false / remainingPids=[]。2026-10-21T15:15:35Z 新鲜复核两组均空，61469/61470/61471/61472/52426 均无 listener。没有停止既有 Edge/v2rayN 或其他浏览器。

该时点 B retained1184411643 B / image allocated1422917632 B，新卷 free32880058368 B，host free347321925632 B。A 宿主复验后 retained319585277 B、原开发卷 free7336144896 B。原 12-GiB 运行累计预算、32-GiB 虚拟映像、1-GiB 构建预算及 10/10、6/10-GiB 余量均不变；没有清理、扩容、迁移或预算重置。

## 6. 证据定位

构建根 `A`：

```text
/Volumes/DevProjectsSSD-74bf68f9/Temp/roxy-lite-cloak-oss/2026-10-21/android-minimal-4kjc5sn9
```

运行根 `B`：

```text
/Volumes/ABSAndroidSSD-a08cc0639bed/Temp/roxy-lite-cloak-oss/2026-10-21/ping0-emulator-7dab2608
```

主要回执：

- `A/logs/build-0014.result.json`、`A/apk-verification-0014-v2.json`、`A/host-final-0014.json`。
- `B/screens/probes-app-ping0-01/screen.png`：本次已查看截图，SHA `82f64ec040219e3530840fba1377afe4182df8eab13417778ebf808e78e8c906`。
- 对应 REA Evidence `ev_abd04895593f2efd8c8de464153479fd3a229602b01feeb33124a2902c526be6`；单帧不是录像，REA 本身不绑定 APK 身份，安装读回在独立回执关联。
- `B/artifacts/probes-app-ping0-ui-01.json`、`B/artifacts/probe-relay-0003-summary.json`。
- `B/artifacts/native-instrumentation-0014.{json,txt}`、`B/artifacts/installed-apk-readback-0014.json`。
- `B/artifacts/native-us-profile-readback-0001.json`、`B/artifacts/native-final-sql-0014.json`、`B/artifacts/native-stop-ui-0014-01.json`。
- `B/artifacts/adb-reverse-removed-0008.json`、`B/artifacts/final-owned-runtime-closed-0014.json`。
- `B/observation-0014.json` 保存本阶段引用与摘要，`A/milestone-0014.json` 关联本阶段构建与观察。

**已完成的是加载恢复、必需 first-party 范围修正及真实结果取证；未完成的是用户要求的完整 Android 指纹浏览器。** 原生时区、DNS/IPv6/WebRTC 约束、安全代理认证、设备型号模拟、网站存储持久性、真实手机仍须实现/验证。iOS 仍只有调研。没有本轮 Android 提交、推送或公开发布。
