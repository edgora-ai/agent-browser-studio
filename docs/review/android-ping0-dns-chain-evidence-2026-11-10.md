# Android Ping0 DNS 解析链宿主机取证（2026-11-10）

## 0. 先读结论

接手 [r13k 交接](android-native-ui-handoff-2026-11-09.md) 第 5 节第 1 项「评分与网络证据先行」的宿主机一半。本轮**纯宿主机测量**：不接手机、不启动模拟器、不装 APK、不改产品源码、不改任何代理配置或系统 DNS。

**核心发现：`d.ping0.cc` DNS 挑战区今天对三类独立视角一致返回 `2.2.2.2`（黑洞记录）——这是区域的真实权威答案，不是 CN 侧污染。** 浏览器把挑战主机解析成 `2.2.2.2` 后，`https://r-<nonce>.d.ping0.cc/probe` 的取回链路必死，页面折叠为 `{resolver_count:0, items:[]}`，即评分中的「DNS 黑洞」异常。这一机制完整解释 WebView 轮 build0014 的 `resolver_count=0` 与 relay 日志「CONNECT 112 次全部 0 字节」。

**对经 edge-link 的评分运行的直接推论：DNS 项将必然呈现黑洞（resolver_count=0），DNS 国家读不出来。** 其余项（`ip_country=US` ↔ `America/New_York` 一致性、UA/GPU、真机 RAF）仍可完成——WebView 轮 build0014（52 分、DNS 单项异常）即为先例。这缩小了「评分与网络证据」设备会话的预期，但不取消它：真机 RAF 与全量分数仍只能来自设备。

**未闭合（如实记录）**：2026-08 桌面线经 KR 出口拿到过 `dns_countries=[KR]`、10 月 r8 拿到过 `/probe` HTTP 200（空 items）。今天的权威答案与这些历史成功不同构——站点侧行为可能随时间或解析器身份变化，本轮无法从宿主机判断权威区何时、按什么条件返回真实答案。**不能宣称「根因全部解决」，只能宣称「当前可用出口下探针不可达及其机制」。**

## 1. 范围与方法

- 接手入口：`docs/review/android-native-ui-handoff-2026-11-09.md` 第 5 节第 1 项；HEAD `102b4de`，工作区仅原有两个无关未跟踪项，未动。
- 证据根 `E`：`.tmp-apk/ping0-dns-evidence-20261109/`（Git 忽略，clone 不随仓库分发）。范围回执 `E/round-scope.json`。
- 允许的公开目的：`ping0.cc`、`cdn.ping0.cc`、`*.d.ping0.cc`、`ipv4/ipv6.ping0.cc`（产品观察策略已登记的域），辅助出口鉴定仅 `ipinfo.io/json`；公共 DoH 对照用 `dns.alidns.com` 与 `cloudflare-dns.com`。正常 TLS 校验（证书判别对照除外，显式 `-k` 并标注）、有界超时、响应体仅保留公开站点静态文件与 DNS JSON，不留 Cookie/凭据/私有数据。
- 工具：`dig`（系统解析器、权威 NS）、`curl`（DIRECT / socks5h 经 edge-link）、DoH JSON API。edge-link 是用户在本机已运行的代理（pid 7394，监听 127.0.0.1:1080/8080/10077-10080），本轮只经其端口发起 CONNECT，**未读取、修改或重启其任何配置**。

## 2. 网络基线（对照 10-21 / 11-04 记录）

| 目标 | DIRECT（中国移动上海） | 经 edge-link（socks5h） |
| --- | --- | --- |
| `ping0.cc/env` | 200，`104.218.235.243` | 200，TLS 0.796s |
| `cdn.ping0.cc/js/vue.min.js` | **TLS 握手被 reset**（rc=35，`104.21.81.48`） | 200，TLS 0.712–0.715s |
| `ipv4.ping0.cc/envdetect/ipinfo-cors?token=` | 未测 | 200，TLS 0.788s |
| 公共 DoH（1.1.1.1 / dns.google） | 超时（10s） | IP 字面量/主机名 CONNECT 被秒拒（SOCKS error 5） |
| 出口归属 | CN · Shanghai · 中国移动 | **US · Los Angeles · AS2914 NTT** |

- DIRECT 的 CDN reset 与 [2026-10-21 宿主机对照](android-ping0-cdn-transport-cause-2026-10-21.md)逐字吻合：同类 IP、同类 reset 签名，当天结论不变。
- **11-04 的阻塞点「需用户提供可用代理节点」实质上已被 edge-link 解除**：US 出口与冻结时区 `America/New_York` 国家一致，主站/CDN/ipv4 三条必需链路全部 200。这是本轮最重要的可行动变化。

## 3. 挑战区的真实权威答案是 2.2.2.2

对全新 nonce（`r-<13位时间戳>-<n>.d.ping0.cc`，格式与 `Ping0ObservationPolicy.DNS_CHALLENGE_HOST` 一致）的三视角对照：

| 解析视角 | `d.ping0.cc` | 全新挑战子域 | 备注 |
| --- | --- | --- | --- |
| 系统解析器（中国移动） | `2.2.2.2` | `2.2.2.2`（两个不同 nonce） | 曾疑似 ISP 污染 |
| AliDNS DoH（`dns.alidns.com`） | `2.2.2.2`（TTL 600，Status 0） | `2.2.2.2`（TTL 600） | 排除单 ISP 因素 |
| Cloudflare DoH 经 edge-link（US 视角） | `2.2.2.2`（TTL 600） | `2.2.2.2`（TTL 600，4 个不同 nonce） | 全球视角一致 |

- `ping0.cc` NS 为 `major/jill.ns.cloudflare.com`；从本机直连权威（UDP 与 TCP 53）均被网络丢弃，无法直接读取区域配置，三视角递归一致已足以判定答案来自权威本身。
- ECS 假设被排除：Cloudflare 1.1.1.1 默认剥离 ECS，附加 `edns_client_subnet=152.70.241.0/24`（KR 等效）与 US-LA 子网的查询同样返回 `2.2.2.2`。
- 证据：`E/dns-capture-system.txt`、`E/dns-capture-alidns.txt`、`E/cf-doh-challenge.json`、`E/cf-doh-challenge2.json`。

**机制**：探针 JS（`cdn.ping0.cc/js/envdetect/probes/index.js`，混淆体已存证）输出结构为 `dns.resolver_count / dns.resolvers / dns.resolver_countries / dns.dnssec`，fetch 失败时显式折叠为 `{resolver_count:0, items:[]}`。页面流程 = 浏览器解析唯一子域（触发递归查询、权威记录解析器）→ 浏览器对同一主机 GET `/probe` 取回结果。解析到 `2.2.2.2` 时第二步必死 → 永远 `resolver_count=0`。

## 4. edge-link 的解析位置：US 侧、干净

| 对照 | 结果 | 判定 |
| --- | --- | --- |
| `www.youtube.com` 经隧道取证书 | 真 `*.google.com`（Google Trust Services WE2），200 | 若 CN 侧解析会拿到 GFW 假答案池 IP（实测系统解析器把 youtube 污染成 `157.240.7.20` Facebook IP、instagram 污染成 Twitter IP），将返回 Facebook/Twitter 证书。返回 Google 证书 ⇒ **解析发生在干净的 US 侧** |
| `twitter.com` 经隧道 | 301，TLS 0.709s | 同上 |
| `example.com` / `ipinfo.io` 经隧道 | 200 | 非紧白名单 |
| IP 字面量 CONNECT（2.2.2.2、1.1.1.1） | 秒拒（error 5） | 客户端只接受主机名 CONNECT |

## 5. 探针取回链路经 edge-link 死亡

| 经 edge-link 的目标 | 签名 | 语义 |
| --- | --- | --- |
| 3 个不同 nonce 的 `r-*.d.ping0.cc/probe` | TLS 中途 `SSL_ERROR_SYSCALL`，total **5.21 / 5.21 / 5.20s** | CONNECT 被接受（非客户端策略拒绝）→ 边缘上游连接失败 |
| `totally-random-xyz99.d.ping0.cc/probe` | 同上 5.203s | 通配挑战区同判 |
| `this-does-not-exist-xyz99.ping0.cc` | 同上 5.194s | NXDOMAIN 类同样表现为 ~5.2s 懒死亡 —— **两种子因（边缘解析到 2.2.2.2 后不可达 / 边缘解析失败）在客户端不可区分** |
| `test-abc-xyz-99.translate.goog` | 秒拒（error 5，0.068s） | 客户端主机名策略拒绝的独立签名，与挑战域不同 |

- 结合第 3 节：`2.2.2.2` 是挑战区真实答案、US→`2.2.2.2:443` 不可达（DIRECT 下 CN 侧为 TCP 超时，US 边缘侧表现为 ~5.2s 死亡），最简自洽解释是**边缘解析到 2.2.2.2 后连接失败**；但边缘内部解析结果不可内省，子因不强行唯一化。
- `2.2.2.2:443` 在部分网络是否可达无法从本机两视角证明（edge-link 拒绝 IP 字面量 CONNECT），不越界断言。
- 证据：`E/tunnel-probe-receipt.txt`（全部尝试与对照的完整签名表）。

## 6. 与历史成功的差异（未闭合，不改写）

- [桌面 8 月基线](../verification/ping0-verification.md)：经 `127.0.0.1:7890`（KR/Oracle 出口）**探针成功**，`dns_countries=[KR]` 单一国家与出口一致，92 分/green。
- 桌面 10 月 r8 记录（PING0_DETECTION.md）：`/probe` 返回 **HTTP 200 但 `resolver_count=0、items=[]`** —— 取回可达、解析链未遍历到权威（如缓存/覆盖解析）。
- 今天：权威答案本身是黑洞 `2.2.2.2`，取回链路不可达。
- 三种状态互不同构，说明**该探针链路的成败由「出口背后的解析链」与站点侧策略共同决定，且随时间变化**。桌面线 81.6 的定案（解析链是网关侧可变项、浏览器侧零压缩空间）在 Android 线同样成立，且更严：当前可用出口连取回可达性都不具备。本轮无法从宿主机判定权威区按什么条件发放真实答案——这属于站点侧未知，不猜测。

## 7. 对 Android 评分运行的含义

1. **经 edge-link 可以跑完整评分**，但 DNS 项预期为黑洞异常（`resolver_count=0`）。总分与其余异常项（真机 RAF、UA/GPU、VPS 特征等）仍是本轮之后设备会话的真实产出目标。
2. **DNS 国家混杂在 Android 上当前不可观测**——探针死了就没有 `resolver_countries`。要观测它，需要一个「解析链合格」的出口：其解析器从权威拿到真实答案且探针端点可达。这是**代理/部署侧决策**（与桌面定案一致），不是浏览器代码修改。
3. 浏览器侧唯一相关的真实可选项是 Chromium secure-DNS（DoH）：可消除 CN 污染解析特征，但拿到 `2.2.2.2` 后探针仍死，**不能修复 DNS 项**；是否引入属产品决策，本轮不实现。
4. 手机测试链（ADB reverse → Mac relay → edge-link）中，无论 relay 本地解析（CN 侧 → 2.2.2.2）还是把主机名透传给 edge-link（US 侧 → 2.2.2.2），挑战域同样死亡——与 WebView 轮观察吻合。

## 8. RAF 证据边界与设备会话需求（本轮只定义，不采集）

- 已有值均不可外推到真机：模拟器 build0014 为 146.99ms（SwiftShader）；桌面线前台 16.6ms（60Hz 标准）、后台/遮挡节流 ~100ms 造成假阳性、r9 实站 47.38/28ms 未决。
- 真机会话必须记录：前台可见与解锁状态（等效桌面 bringToFront 的真机条件）、屏幕刷新率当前档位（PKG110 支持高刷，需读回实际档位）、省电/性能模式、`ping0` RAF 值 + 本地受控 rAF 采样对照（native Date/performance.now 基准）。
- RAF 属引擎边界项（桌面线口径），不与身份失败混计。

## 9. 下一步顺序

1. **设备评分会话（第 1 项的设备一半）**：经 edge-link 链路对真机 PKG110 跑一次完整 `ping0.cc/env` 评分，产出全量分数 + 全部异常项真机值（RAF、UA/GPU、ip_country↔时区）。需按 r13k 交接「再次接设备前」清单重新确认授权/解锁/前台；评分轮属新观察，不复用旧截图。
2. **出口决策（用户）**：若要观测 DNS 国家一致性，需提供解析链合格的出口（如历史 KR 类节点）或在部署侧改解析路径；edge-link 保留作运输出口仍有效。
3. DNS 项修复决策在 1+2 证据齐备后再议；禁止硬编码检测值或为补绿修改探针策略。

## 10. 证据位置

均相对仓库根，`E = .tmp-apk/ping0-dns-evidence-20261109/`（Git 忽略）：

- `E/round-scope.json`：本轮范围与禁项回执。
- `E/dns-capture-system.txt`、`E/dns-capture-alidns.txt`、`E/cf-doh-challenge.json`、`E/cf-doh-challenge2.json`：三视角 DNS 答案（UTC 时间戳在文件头）。
- `E/tunnel-probe-receipt.txt`：edge-link 隧道全部尝试、对照签名、DIRECT 基线、出口归属。
- `E/env-page.html`、`E/probes-index.js`、`E/main-detect.js`：公开站点静态文件存证（探针输出结构依据）。

关联历史：[2026-10-21 CDN 运输宿主对照](android-ping0-cdn-transport-cause-2026-10-21.md)、[延长等待](android-ping0-extended-wait-2026-10-21.md)、[加载恢复与 52 分](android-ping0-load-recovery-2026-10-21.md)、[r13k 交接](android-native-ui-handoff-2026-11-09.md)。本文只记录宿主机网络证据，不更新 r13k 交接的其余结论。
