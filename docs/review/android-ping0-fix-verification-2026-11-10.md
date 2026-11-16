# Android 真机修复验证：DNS 单链化、Intl locale 与 RAF 归因（2026-11-10）

## 0. 先读结论

接手用户「继续，全部完成」指令后，本轮在[真机评分轮](android-ping0-real-device-score-2026-11-10.md)基础上完成了四件事，全部在 OnePlus PKG110（Android 16）真机闭环验证：

1. **RAF 归因定案**：引擎帧调度健康（本机受控基准 16.70ms ≈ 60Hz），站点 118-185ms 的读数是其自身 166 项探针风暴的争用伪影（记录级，不扣分）。
2. **DNS 单链化产品修复落地**：冻结 argv 增加 `--host-resolver-rules=MAP * ~NOTFOUND,...`，本地解析（含 DNS prefetch/预连接提示）全部短路——中国解析器从 DNS 面板彻底消失。
3. **Intl locale 产品修复落地**：新补丁 0059（rev2）在每进程 `PreSandboxStartup` 按转发的时区配置守卫应用 ICU 默认 locale——`Intl locale=en-US`、区域代码 US、日期样例 "November 9, 2026 at 1:25:25 PM"、货币样例 "$1,234.50"、每周首日 7，全部从 zh-CN/¥ 翻转。
4. **数据可靠性第一批 PASS**：Cookie/localStorage 写读闭环、正常进程切换存活、正常退出→重启进程后双持久、同代理同源跨环境隔离（新环境读到全空）。

**修复后真机评分：100 / 100 · 安全（green）· 166/166 · 1 项异常（仅 RAF 记录级）。** 从 52 分（WebView 轮）→ 90 分（原生首测）→ 100 分（修复后）的完整轨迹。

本轮未做（如实记录）：崩溃/LMK/重启/断电/长时矩阵属破坏性测试，需单独授权另轮执行。

## 1. RAF 归因（Phase A）

| 测量 | 值 | 条件 |
| --- | --- | --- |
| 本机夹具 300 帧基准 | median **16.70ms**（p10 16.6 / p90 16.7，hz≈59.9） | 同浏览器、同前台；系统面板 90Hz、浏览器表面 60Hz |
| 站点读数 ×4 | 184.55 → 164.55 → 164.39 → 118.61 | 均在站点自身检测负载下 |

隐藏标签 rAF 挂起（42s 空档）为标准行为。**结论：引擎无节流、无伪造合成器；站点把 rAF 采样与自己的探针风暴同页并发执行，读数随负载浮动。** 边界：站点内部测量代码不可见，定论基于引擎对照 + 四轮浮动证据。

## 2. DNS 单链化（Phase B 第一半）

**根因回顾**：Chromium 对代理请求仍并行做本地解析（DNS prefetch/预连接提示走系统解析器），中国移动互联网解析器因此被 ping0 权威记录（上一轮 8×221.179.155.x）。

**修复**（commit `3d319f6`）：

- `ProxySpec.hostResolverRules()` = `MAP * ~NOTFOUND,EXCLUDE <代理主机>,EXCLUDE 127.0.0.1,EXCLUDE localhost`（产品代理必填，故安全；IPv6 代理主机保持括号形式；代理端点与回环排除保证代理本身可达）。
- `NativeBrowserApplication.freezeCommandLine()` 冻结该开关，`verifyFrozenCommandLine()` 校验；RED-first 契约断言（新增 `frozenProxyOnlyResolverChain` 9 项）。

**验证**：r13l run1 真机首跑 DNS 面板 `dns_countries=US,BE`——**CN 消失**（BE 为 edge-link→Cloudflare anycast 波动，网关侧可变项，与桌面 81.6 定案同构）；r2 复测 **8 个解析器全部 United States，零 CN**，DNS 异常从评分中消失。

## 3. Intl locale（Phase B 第二半）

**缺口回顾**：环境语言只覆盖 navigator.language(s) 与 Accept-Language，ICU 默认 locale 仍随设备（zh-CN）。

**修复**：新补丁 `patches/chromium/patches/0059-android-product-locale-icu.patch`（rev2，commit `0deb982`）：`ShellMainDelegate::PreSandboxStartup` 在每进程最早期（先于任何 isolate/Blink 上下文）按**转发的时区配置**守卫（rev1 的 profile-switch 守卫不被 content 转发给渲染器——已 revert 重放，revert 链路 sha 全程核对：c22470ba → 6b8e1a1e → c22470ba → c0e433ec）应用 `--lang` 主标签到 `base::i18n::SetICUDefaultLocale`。

**验证**：logcat 中浏览器与渲染器两进程均 `ABS_ANDROID_LOCALE_V1 applied=1 lang=en-US`；页面 区域/时区 面板 Intl locale=en-US、区域代码=US、日期样例 "November 9, 2026 at 1:25:25 PM"、每周首日 7、货币样例 $1,234.50。

## 4. 构建与重新准入

| 轮 | APK SHA256 | 流程 |
| --- | --- | --- |
| r13l run1 | `871809cc…` | 冻结回执 + 完整构造器（远端补丁应用回执、增量 overlay 74 文件校验、QUEUED==FINISHED 静态分析门禁、原证书签名） |
| r13l run2 | `7092ab31…` | 0059 rev2 后 cc-only 增量（ninja 4 步，RC=0）；helper 静态分析门禁对零 java 任务增量误报（queued==empty）——**回执如实记录解释，未静默重跑或绕过** |

两次安装读回摘要均与签名候选一致；同证书升级安装保数据（环境/历史保留）。host 验证：549 项源码契约（含 9 项新断言 RED→GREEN）、133260 项 tile 断言、213 项启动合同，输出根 `.tmp-apk/proxy-fix-work/v13l-host-tests/run1`。

## 5. 数据可靠性第一批（Phase C）

夹具：`rafqa.test` 经自有中继的本机 HTTP 夹具（Cookie+localStorage 同源）。

| 测试 | 结果 |
| --- | --- |
| Cookie 写→读闭环（nonce `qa-1794248974`） | PASS |
| localStorage 写→读闭环（`ls-1794248974`） | PASS |
| 正常进程切换（HOME → HOT resume） | PASS：同 pid 12661 存活，页面状态完好 |
| 正常退出 → 重启进程（pid 12661→19158） | PASS：Cookie 与 localStorage 均持久（DomStorage 关闭前 flush 路径生效） |
| 跨环境隔离（新建 QA-Isolation，同 QA-EdgeNY 代理同源） | PASS：`cookies:` 与 `ls:` 均空 |

旁证：UI-Demo（QA-Local 代理）访问同夹具得 503——代理按环境隔离。用户原有 3 环境/2 代理全程未读改；本轮 QA 专用条目（QA-Ping0-NY、QA-Isolation、QA-EdgeNY）留待用户处置。

## 6. 下一步

1. **Phase C2（破坏性，需单独授权）**：崩溃/LMK/重启/断电后的全存储持久性矩阵、长时间稳定性——涉及手机整机状态（重启/断电需用户在场配合）。
2. 发行/源码闭环（交接第 5 节第 4 项）未动：完整 Chromium/DEPS、可重复构建、NOTICE/credits。
3. DNS 解析链的剩余国家可变性属网关侧（用户出口资产）；如需绝对一致可考虑出口侧固定 US 解析器——部署决策，非产品代码。

## 7. 证据位置

`E3 = .tmp-apk/ping0-followup-20261110/`（Git 忽略）：

- `E3/session-receipt.json`：本轮总回执（三阶段全部测量与边界）。
- `E3/run2/*.png`：100 分顶部、异常项、DNS 全美解析器面板、区域/时区 Intl 面板截图。
- `E3/run2/relay2-final.jsonl`（2092 行）、`E3/fixture-requests.jsonl`：夹具与中继全量连接回执。
- `E3/run/*.png`（Phase A RAF 基准与对照）、`E3/round-scope.json`。
- 构建回执：`.tmp-apk/proxy-fix-work/v13l-ui/{reviewed-build-inputs.json,candidate-build-receipt.json,candidate-build-receipt-r2.json,remote-patch-receipt.json,source-guard.json}`。

关联：[真机评分轮](android-ping0-real-device-score-2026-11-10.md)、[宿主机解析链](android-ping0-dns-chain-evidence-2026-11-10.md)、[r13k 交接](android-native-ui-handoff-2026-11-09.md)。本文只记录本轮测量与修复验证；100 分是本轮链路的单次观察，不构成发行验收，也不改写历史轮次结论。
