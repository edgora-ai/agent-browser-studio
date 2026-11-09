# Android 真机 Ping0 评分与 DNS 双解析链根因（2026-11-10）

## 0. 先读结论

接手[宿主机解析链报告](android-ping0-dns-chain-evidence-2026-11-10.md)第 9 节的设备一半。经用户解锁授权、新建专用环境（不改任何既有配置），在 OnePlus PKG110（Android 16）上经自有中继 + edge-link US 出口完成了真实 `ping0.cc/env` 评分：

**90 / 100 · 安全（green）· 166/166 完成 · 2 项异常。** r13k 原签名候选包（安装 APK SHA256 与候选一致）的真机指纹评分首次完整产出。核心功能验证通过：**ip↔时区一致性 PASS**（`ip_country=US · tz=America/New_York`）——每 profile 时区在真机网页原生生效，这是 Android 线的核心需求首次实站确认。

两项异常与一个页面未扣分的潜伏缺口，全部如实记录：

| # | 项 | 级别 | 实测值 |
| --- | --- | --- | --- |
| 1 | DNS 解析器 ↔ IP 国家 | 高危 | `ip_country=US · dns_countries=CN,US · foreign_countries=CN` |
| 2 | RAF 帧间隔 | 记录 | `184.55 ms` |
| 3 | Intl 默认 locale（页面未扣分） | 产品缺口 | `Intl locale=zh-CN · 区域=CN · 货币样例 ¥`（navigator/Accept-Language 均已 en-US） |

**Android 线「DNS 国家混杂」根因定案（真机证据）**：Chromium 配置 HTTP 代理时**仍并行发起本地系统解析**——手机系统 DNS（中国移动 `221.179.155.x`，8 个递归 IP）与代理链解析（edge-link US 边缘，经 Cloudflare `162.158.185.227`）两条链同时被 ping0 权威记录并由服务端交叉校验回读。这与桌面线定案（Firefox socks5h 纯远端解析、浏览器侧零空间）**不同构：Android 侧存在真实的产品级修复空间**（secure-DNS/DoH 使解析单链化、或禁用并行本地解析），属后续决策，本轮不改产品。

**宿主机轮预测被真机证据部分推翻（如实记录）**：宿主机报告第 7 节预测「经 edge-link DNS 项必然 resolver_count=0」，实测 **`resolver_count=9` 且国家可读、DNS 黑洞检查 PASS**——服务端交叉校验从权威日志取数，不依赖浏览器侧 `/probe` 取回成功（51 个挑战 CONNECT 经代理全部 s2c=0 的死亡签名与 9 个解析器被记录并存）。宿主机报告对解析死亡机制的分析成立，对评分呈现方式的预测不成立。

## 1. 会话边界与身份

- 时间：2026-11-09T16:20Z–16:40Z（本地 11-10 凌晨）；HEAD `f62452a`（宿主机报告提交后）。
- 设备：PKG110 / Android 16 / API 36，历史 TLS alias 显式 transport，`ADB_MDNS_AUTO_CONNECT=0`；preflight 在锁屏处停止，经用户解锁后继续。
- 安装 APK 经 on-device `sha256sum` 核对与 r13k 候选一致（`7d3a43a3…`）；wm 覆盖 1080×2376/480dpi 与 font_scale 1.0 未变。
- 测试链：新建环境 `QA-Ping0-NY`（America/New_York，en-US，经产品时区/语言搜索选择器设置）→ 新建代理 `QA-EdgeNY`（HTTP `127.0.0.1:17890`）→ adb reverse → **自有 CONNECT→SOCKS5 中继**（白名单 `*.ping0.cc:443` + `ipwho.is:443`（产品内置出口测试的 GEO 查询专用））→ edge-link SOCKS5 → US 出口。用户既有 3 环境/2 代理未读改、UI-Demo 未打开。
- 中继白名单的实测佐证：产品内置「测试出口」试图连 `ipwho.is:443` 被白名单拒绝（GEO_LOOKUP_FAILED），且 **edge-link 自身也拒绝 ipwho.is/dns.google**（SOCKS reply 5）——两层目的地限制独立存在，均未越界内省或修改。
- 会话后清理：正常退出流程（确认框环境名全文核对）→ `:browser` 进程 `pidof` 为空；adb reverse 移除；中继停止；322 行连接回执保留。`QA-Ping0-NY`/`QA-EdgeNY` 按约定留待用户处置。

## 2. 评分结果（全部来自真机页面与截图）

出口（站点视角）：`204.0.23.126` 🇺🇸 洛杉矶 AS2914 NTT，**IP 类型=家庭宽带 IP**，风控值 15%，原生 IP，共享 1-10（极好）。

通过项（服务端交叉检验面板逐项核对）：

| 交叉检验 | 值 |
| --- | --- |
| IP 国家 ↔ 时区 | `{"ip_country":"US","tz":"America/New_York"}` ✓ |
| tz offset ↔ Intl 时区 | `{"tz":"America/New_York","offset_min":300}` ✓ |
| IP 国家 ↔ 浏览器语言 | `{"ip_country":"US","primary_lang":"en-US"}` ✓ |
| IP 国家 ↔ 中文字体 | `{"has_cn_fonts":false}` ✓ |
| DNS 黑洞 (VPN fake-ip) | `{"resolver_count":9}` ✓ |
| WebRTC IP ↔ HTTP IP | rtc 空，无泄漏 ✓；多出口一致 ✓；Forwarded/Via 空 ✓ |
| UA 平台 ↔ GPU | `Linux armv81` + **ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)**（真 GPU，非 SwiftShader）✓ |
| UA 版本 ↔ 启发式版本 | 152.0.0.0 一致 ✓（UA 冻结 Android 10） |
| IPv4 ↔ IPv6 国家 | ipv6 空，无矛盾 ✓ |
| Canvas/Audio | ×5 / ×3 采样全稳定 ✓ |

异常项全文本已截图存档（`score-top.png` 等 8 张 + UI dump）。

## 3. DNS 双解析链：证据与机制

中继回执（322 行，`run/relay-connections-final.jsonl`）与页面 DNS 面板联合证明：

1. 51 个挑战主机（`r-<ts>-<n>.d.ping0.cc`）的 CONNECT 全部经代理且 **s2c=0**（与宿主机轮测得的黑洞死亡签名一致——`2.2.2.2` 全局权威答案、US→2.2.2.2:443 不可达）。
2. 页面 DNS 面板仍列出 **9 个解析器**：8×`221.179.155.x`（中国移动，🇨🇳）+ 1×`162.158.185.227`（Cloudflare，🇺🇸）。
3. 评分日志 `提交服务端做交叉检验和评分… → 完成：90/100`：解析器数据由服务端从权威 DNS 日志交叉校验回读，**不依赖浏览器侧 /probe 取回**。

⇒ 手机本地系统解析（中国移动）与代理链解析（edge-link→Cloudflare）**并行发生**。Chromium 对代理请求的并行本地解析（DNS prefetch/缓存预热类路径）是把 CN 解析器暴露给权威的直接原因。页面给出的修法提示与之一致：「改用代理自带的 DNS、或全局走 DoH/DoT」。

**与桌面线 81.6 定案的关系**：桌面 Firefox 走 socks5h（纯远端解析）时浏览器侧零压缩空间；Android Chromium 的并行本地解析使浏览器/产品侧**存在真实修复空间**（secure-DNS 强制 DoH 且 DoH 走代理、或等价的解析单链化配置）。是否实现属后续产品决策；禁止硬编码检测值。

## 4. RAF 184.55ms：如实记录，成因未定

真机前台测得 184.55ms，远离 60/90/120/144/240Hz 标准档；页面级别为「记录」不计高危。页面提示两种可能（anti-detect 合成器 / 标签后台节流）；本轮窗口确为前台，但 adb 采样、功耗策略、页面加载期测量窗口等因素未排除。**不在本轮断言为产品缺陷或环境伪影**；后续需本机受控 rAF 对照（原生 performance.now 基准 vs 站点测量同窗）再定。桌面线 rAF 证据（前台 16.6ms 正常、遮挡 ~100ms 节流、r9 实站 47/28ms 未决）保持原状。

## 5. Intl 默认 locale 缺口（页面未扣分，产品真实缺口）

区域/时区面板：`navigator.language(s)=en-US` ✓、`Accept-Language: en-US` ✓、时区 `America/New_York/UTC-05:00` ✓，但 **`Intl locale=zh-CN`、区域代码 `CN`、日期样例「2026年11月9日」、货币样例「¥1,234.50」** ——环境语言只覆盖了 Navigator/网络策略，未覆盖 ICU 默认 locale（与 10-21 文档「语言还需与 Navigator/Intl/网络策略一致」的要求不符）。站点当前未对此扣分，但这与时区缺口同类（配置未成为引擎级默认值），如实登记为产品缺口，修复方案与复测属后续轮次。

## 6. 下一步顺序

1. **DNS 单链化产品决策**：secure-DNS/DoH（走代理）或禁用并行本地解析的引擎配置；实现后以同链路复测，目标 `dns_countries=[US]`。修复不得使用硬编码检测值。
2. **RAF 对照实验**：真机本机受控 rAF 基准（多刷新率档位、省电开关、前台保持），与站点测量同窗对比，定引擎/测量/功耗归因。
3. **Intl locale 一致性**：环境语言应用到 ICU 默认 locale 的引擎级方案（与时区同一机制族），复测日期/货币样例。
4. 以上均不改变本轮结论的边界：单次真机评分观察 ≠ 发行验收；Cookie/登录持久性、崩溃/断电恢复、长时矩阵仍属交接第 5 节第 2/3 项，未开始。

## 7. 证据位置

`E2 = .tmp-apk/ping0-score-device-20261110/`（Git 忽略）：

- `E2/session-receipt.json`：会话总回执（身份/链路/评分/根因/清理/边界）。
- `E2/round-scope.json`：设备轮范围与禁项。
- `E2/run/score-top.png`…`score-bottom.png`：8 张评分页截图（分数/异常/DNS 解析器明细/交叉检验面板/硬件面板）。
- `E2/run/relay-connections-final.jsonl`：322 行中继连接回执（含 51 个挑战 CONNECT 全部 s2c=0 的死亡签名）。
- `E2/run/*.xml`：评分页/菜单/退出确认/管理器 dump；`E2/preflight/*`：身份核验与编辑器序列 dump。
- 中继实现：`E2/relay.py`（白名单与透传逻辑可复核）。

关联：[宿主机解析链报告](android-ping0-dns-chain-evidence-2026-11-10.md)、[r13k 交接](android-native-ui-handoff-2026-11-09.md)、[加载恢复 52 分历史](android-ping0-load-recovery-2026-10-21.md)。本文不修改 r13k 交接与其余历史结论；90 分是本轮环境/出口组合下的单次观察，不与 52 分 WebView 历史或任何「通过/达标」结论混同。
