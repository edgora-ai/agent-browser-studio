# Ping0 检测机制与排错

范围：`https://ping0.cc/env`，依据 2026-10-16 保存的页面脚本与生产链记录。本文区分**源码已确认、实测、未知**；机制分析静态读取保存的脚本，实测则由 Studio 生产链打开真实页面，不改写站点请求、响应或评分。后续站点版本可能改变机制。

发布边界：各轮结果按其记录时点解读；公开预览候选不使历史实站失败或未知项转为通过。当前资产状态与未闭环项见文末公开交叉参考。

## 1. 源码已确认：DNS 到服务端判定

```text
保存 stamp = Date.now()
  ↓
5 轮：每轮生成 10 域，各触发四路；每轮后等 600ms（含最后一轮）
  ↓ 共 50 域；不等待 HTTP 资源成功或 ICE candidate
POST /envdetect/probe/dnsleak → 解析 JSON
  ├─ 相同正 count 累计两次（中间 0 不清零）→ 返回
  ├─ 轮询窗口约 9 秒已到 → 返回
  └─ 否 → 回包后等 1 秒 → 再 POST
  ↓ DNS 结果写入 rows / allResults（异常则折叠为 0 / 空列表）
等待所有 probe 与 captcha 决议 → nestify(allResults)
  ↓
POST /envdetect/submit → server.findings → 行 fail / 分数 / finished
```

### 域名与四条触发路径

域名为 `r-<生成该域时的 Date.now()>-<floor(Math.random()*Number.MAX_SAFE_INTEGER)>.d.ping0.cc`。**各域时间戳不等于统一 stamp**；随机值用于区分挑战域，不是解析器数量。

| 路径 | 页面实际动作 | 不能据此推断 |
| --- | --- | --- |
| DNS-prefetch | 插入 `link rel="dns-prefetch"`，目标 `//host` | 提示一定执行、成功或被后端计数 |
| 隐藏 CSS | 隐藏容器中的背景资源 `//host/probe` | CSS 资源成功才可计数 |
| Image | `new Image()` 请求 `//host/probe?` 加 `Math.random()`，`referrerPolicy="no-referrer"` | `onload` 是计数依据 |
| STUN | `RTCPeerConnection` 使用 `stun:host:3478`，创建 data channel、offer、`setLocalDescription` 启动 ICE，约 5 秒后关闭 | 此 DNS probe 会读取或累计 candidate |

四路均是触发尝试；该 probe 不以资源成功回调或 candidate 事件累计 count。不要把独立 WebRTC 检测与这里的 STUN 触发混为一谈。

### 回包、轮询与提交

DNS 请求采用同源凭据（`credentials: "same-origin"`），`Content-Type: application/json`，正文为 `JSON.stringify({ domains, stamp })`。同一轮询复用这组 50 域和 stamp。

| DNS 回包字段 | 前端输出 | 含义与限制 |
| --- | --- | --- |
| `resolver_count` | `dns.resolver_count`，缺失／假值回落 0 | **直接取服务器值，不是前端计算**；不由资源成功数、域数或 `items.length` 推导 |
| `items` | `dns.resolvers`，映射 `ip`、`cc`、`country`，初始 `foreign:false` | 缺失回落空列表；稍后主脚本按出口国家重算 foreign，初值不是“都在本国”的结论 |
| `resolver_countries` | `dns.resolver_countries`，缺失回落 `[]` | 服务端返回的解析器国家列表 |
| 无对应实测字段 | `dns.dnssec` 为 `""` | 空占位，不证明 DNSSEC 开启或关闭 |

- 轮询窗口在发完五轮并等待最后 600ms 后才开始，约 9 秒；每次回包处理后再等 1 秒，不是固定每秒并发请求。相同正数两次便提前结束；例如 `2 → 0 → 2` 可结束，因为 0 不重置上次正数及其稳定计数。
- fetch **无硬超时，也不检查 `r.ok`**，直接 `r.json()`。约 9 秒是回包后的停止检查，不是整个 probe 的硬截止；慢请求可超过窗口。请求、JSON 或后续处理异常会在外层折叠为计数 0 与空列表，因此 UI 的 0 不能单独区分“服务器真回 0”和客户端异常。
- 主脚本等待所有探针与 captcha 决议后，重算 foreign，再 `nestify` 成嵌套 evidence 并提交 `/envdetect/submit`。`xc.dns_blackhole`、`xc.ua_webgl` 的 `value` / `fail` 来自 **`server.findings`**；前端展示帮助语不是完整服务端谓词。

## 2. 历史实测：失败证据，不是新规则验收

以下是已保存记录，不是本次 UI／GPU 规则修改后的新运行。

- 固定出口对照 `cpu0055-fixed-p1-r1/result.json`：八次 DNS 回包均 HTTP 200，发生于 `stamp + 3420…12830ms`，全部 `resolver_count=0`、`items=[]`、`resolver_countries=[]`。检测完成、70 分，但 DNS／GPU 两项仍失败，严格站点门禁为 FAIL。
- 早期原生日志有 **25 条真实 SERVFAIL**；日志只覆盖部分窗口，另有观察器丢失限制，不能提升为整页完整路由或所有 50 域的结论。独立 Google NS 查询报告 `104.218.235.243` 不响应及 EDE 22，这是解析器当时报告的权威可达性问题，**不是全球故障或具体防火墙根因的证明**。
- 自然提交和服务端回显已收到 `architecture=arm`、`platform=MacIntel`、原生 `ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)` 等身份；GPU finding 仍失败。`MacIntel` 不等于物理 Intel CPU；无服务端源码，不能宣称“ANGLE 正则”是根因。
- 后期默认代理出现多出口 JP/HK，新增地域／语言／时区等失败；固定单 US 出口后恢复 70 分但仍有上述两失败。不要把出口变化与 DNS/GPU 规则变化混作单一因果。

## 3. 未知：前端源码不能回答的部分

未取得服务器如何记录、去重、关联 `domains/stamp`、过滤解析器、保留记录及具体 GPU 判定谓词的源码。**仅 query 到权威是否计数仍未知**；也不知道是否还要求成功答案、特定查询类型或其他关联条件。

DoH 加密客户端到递归解析器的链路，**不会让权威服务器看不到递归解析器的查询来源**。HTTP 资源成功也不是已确认的前端计数前提。两者都不能拿来解释或豁免所有零计数。

## 4. count=0 分层排错

| 层 | 先保留什么证据 | 如何收窄，避免误判 |
| --- | --- | --- |
| 页面／时间 | probe 是否自然启动、同组 50 域与 stamp、DNS 回包的实际正文／时间、页面异常 | 区分回包真 0、fetch/JSON 异常折叠 0、请求挂起；不能只看最终 UI |
| 启动／配置 | Studio 真实 IPC 启动、模式、所选内核、实际 argv／溯源、重启状态 | 配置已保存／日志 `configured` 不等于进程已应用；明确停止再启动，不从 UA 猜宿主能力 |
| 浏览器／代理 | 默认代理侧 DNS 或显式严格 DoH、四路是否被允许、关联原生解析与代理事务 | 预取被跳过不能解释全部四路；HTTP 200 可能仍包着 DNS SERVFAIL；普通网页成功不证明检测域正常 |
| 上游／权威 | 同批正控制域和实际挑战域的 DNS 状态、问题名、rcode／答案、可得的 EDE | 辅助查询放在自然检测完成之后，标为独立诊断；晚到查询不能反填原事务原因，也不证明服务器会计数 |
| 服务端记录／评分 | 原 DNS 回包、自然 submit 与响应 findings 的对应关系 | 权威收到查询不必然等于被登记；记录／过滤规则未知时保持未知，不猜 count 公式或修改 fail |

完整证据应包括时间、来源摘要、覆盖窗口和截断／丢失状态；缺失或超时写 INCONCLUSIVE，不当 PASS。不得为“过分”重放改值提交、注入 DNS 答案、关闭保护或豁免失败项；公开材料去除用户出口 IP、代理端口、凭据和报告查询标识。

## 5. GPU 改值与真实能力

[用户指南](USER_GUIDE.zh-CN.md) 中的新产品规则只允许 **macOS 原生 ARM64 主进程＋所选 ARM64 Chromium＋托管模式**采用现有四个 Apple WebGL 画像：厂商均为 `Google Inc. (Apple)`，渲染器为裸 `Apple M1` / `Apple M2` / `Apple M3` / `Apple M2 Pro`。

`gpuVendor/gpuRenderer` 是平台画像组合的部分约束，受支持的旧 ANGLE／裸型号精确别名可兼容，不允许随意拼接。Intel、Rosetta、架构未知及其他 Chromium 平台保留原生身份，不支持的显式覆盖拒绝启动；关闭指纹身份仍原生；Firefox 使用独立的 Gecko 规则，见第 7 节。**WebGPU、GPU 能力和实际绘制始终原生**，字段改值不是更换物理显卡，也不保证 Ping0 判定通过。

### 新规则实测（2026-10-16）

`gpu-rule-managed-p1-r2` 与 `gpu-rule-managed-p1-r4` 均经 Studio → 真实 IPC → BrowserManager → 项目 Chromium 启动同一自有配置。旧规则 requestHash 与当前不含新 GPU 策略的请求哈希匹配，绑定相同 seed 和非 GPU 启动意图；旧完整 payload 未保存，不宣称逐字段回溯相等。

- 实际 argv 的受管 payload、页面自然 submit 与服务端回显均为 `Google Inc. (Apple)` / `Apple M1`。重启以及 r4 普通刷新后，`xc.ua_webgl` 均不再失败；不能据此反推全部服务端谓词。
- r2、r4 的 top-level／同源 iframe × Window／Worker／Window OffscreenCanvas × WebGL1/2 合同检查通过，其他 WebGL 能力与 WebGPU 仍匹配同构建原生 off 对照，CPU 六上下文检查通过。GPU 的跨源 iframe 未覆盖，不扩成物理 GPU 型号真实性证明。
- r4 初次加载和刷新均完成、无 pending、85 分，**唯一失败仍为 `xc.dns_blackhole`，resolver_count=0**；整个产品验收仍 FAIL，未生成最终交付包。
- r4 两次自然检测共 16 条 DNS 回包的 HTTP Date 时差区间均包含 0（计入 RTT 和秒级精度），没有明显前端／HTTP 响应时钟偏差证据；Date 可能由边缘节点生成，不能证明后台计数服务时钟正确。
- 紧邻实测后的同 p1 独立四请求对照（`paired-dns-route-8f004deef8.json`）：`example.com` 的代理 HTTPS 和 Google DoH A 查询均正常；一个未提交评分的新鲜挑战形态域经代理 HTTPS 超时，DoH 返回 `SERVFAIL / EDE 22`，明确报告权威 `104.218.235.243` 未响应。HTTPS 超时前代理已返回 CONNECT 200，说明 **CONNECT 200 不能代替成功 DNS／TLS 证据**。这支持当时挑战域上游异常，不等于已取得权威端日志，也不代替真实浏览器验收。

采集注意：GPU corpus 的 Blob Worker 不能放到只允许 `worker-src 'self'` 的 CPU fixture 中直接运行。组合采集显式允许自有 fixture 的 `worker-src 'self' blob:`；默认 CPU fixture 不变，浏览器 CSP／站点策略没有关闭。测帧时序时先使页面可见，截图放到探针完成之后；不修改 RAF 返回值或放宽门禁。

## 6. 复用 collector 与严格门禁

复用仓库的 `collectPing0OnPage`（`src/tools/verify-ping0.ts`）和 `assessPing0Findings`（`src/tools/ping0-acceptance.ts`），不要另写宽松的“高分即通过”判断。示意调用如下，仅供已获站点访问授权且拥有 Page 生命周期的生产 driver 使用。

```ts
const collection = await collectPing0OnPage(page, {
  siteAccessAuthorized: true, // 必须先获得授权；该参数本身不授权
  navigate: false,           // 此 Page 已自然导航到 https://ping0.cc/env
  waitTimeoutMs: 360000,
  settleMs: 15000,
  observeDns: true,
});
const assessment = assessPing0Findings(collection);
```

- collector 不负责启动、连接或关闭浏览器，也不替换代理。调用方须绑定真实 Studio IPC 生产启动、所选可执行文件和自有进程，保留原页面／响应，最终清理并读回进程退出。
- `outcome:"completed"` 只表示采集完成；`dnsTransactionsVerified` 仍为 false。`dnsObservations` 是有界启发式网络信号，不是完整四路日志、原始 NetLog 或 DNS 事务证明。
- 严格门禁核对 finished、采集时间、报告标识存在、完整 rows、pending、findings 一致性及正 resolver_count。明确失败项或计数 0 不能 PASS；缺字段、冲突、超时等不确定证据保持 INCONCLUSIVE。scope 仅为 `site-findings-only`，不认证报告、不验证 CPU/GPU 物理真实性或全程无泄漏。
- **单测 ≠ 实站 ≠ 打包**：离线 UI／策略单测只验证其合同；实站需自然检测及刷新／停止再启动复验；之后还需构建、签名、包内程序核验和实际运行。任何前层 PASS 均不替代后层；上述 GPU 单项实测通过不替代整站通过或交付包验收。

## 7. Firefox 默认生产路线（2026-10-17）

Firefox 使用生产启动注册的 **WebDriver BiDi** 连接，不是 Chromium CDP。一个端口不能另建 `session.new` 顶替持有 preload 的生产会话。以下测试均由 Studio → IPC → BrowserManager 启动，使用固定的两个自有配置；没有安装替换现有应用，也没有重置许可或试用。

### 已确认并修正的缺陷

- **开发态运行包崩溃**：原包没有 GRE `omni.ja`，plist 指向已不存在的 objdir；内容进程触发 `MOZ_CRASH(Failed to get path to build object dir)`。隔离候选用上游 mozpack 重封装已有的 7994 个文件，逐项核对资源和 251 个 manifest 注册；不是空 archive、假 objdir 或混入 stock Firefox。XUL 字节不变，launcher/helper 的本地 ad-hoc 签名变化单独核对，不能称为签名后整文件哈希不变或已 notarize。源包已有的资源缺项保留为限制。
- **运行包接纳门禁**：macOS 发现与安装路径共用静态检查，要求非空普通 GRE/browser omnijar，解析 XML/二进制 plist，拒绝主程序及存在的标准 helper 的开发路径键。它是布局校验，不代替 ZIP 内容、全量资源、签名或启动验证；不能靠删 plist 字段修好开发态包。
- **旧进程误复用**：Firefox 使用当前 Studio 进程内的 opaque HMAC、owned 子进程和同一个已注册 BiDi 对象校验，没有套用 Chromium stamp 开关。身份、代理、模式、内核、偏好字节或会话变化时要求明确停止再启动，不自动杀旧进程。异步检查后再次校验；偏好文件按原字节摘要，避免不同非法 UTF-8 字节都变成替换字符。
- **偏好残留与默认安全策略**：`off` 不再应用存留的 locale/TZ；受管偏好有归属和接管前 baseline，释放时恢复可证明的原值。手动代理期间中和互斥协议字段，Gecko 保存时省略默认值也不能遗失 baseline。合法的 opaque 字节和非 UTF-8 注释不被有损改写。历史 writer 已丢失的更早值仍不可恢复，冲突拒绝静默覆盖。沙箱开启不再写等级 0，也不允许继承关闭内容沙箱的环境变量；BiDi 默认不忽略 TLS 证书错误。
- **Firefox 验收假成功**：Firefox 与 Chromium 共享严格 findings 门禁和退出状态。高分、`finished` 或旧 boundary 分类均不能豁免失败；缺失字段保持 INCONCLUSIVE。

### GPU：不能把 Chromium 的名称套给 Gecko

修复前实测：页面／Window Offscreen 返回 `Google Inc. (Apple)`＋`ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)`，Worker 却返回 `Apple`＋`Apple M1, or similar`；WebGPU 也只改了页面的 adapter 字段。这是可观测的跨上下文矛盾。

默认 Firefox 路线现通过 Gecko 的 `webgl.override-unmasked-vendor/renderer` 偏好设置 WebGL，不再在页面重写 `getParameter/getExtension` 或伪造扩展对象。Apple 画像使用 Gecko 的 `Apple`／`Apple M1, or similar` 隐私分组；它不证明 M1 实体显卡，也不是 Chromium 的裸型号规则。保留引擎的清洗与错误语义。**fallback 的 WebGPU 全部保持原生**，显式 patched-native A/B 的配置另存，不把其能力推定为默认路线已实现。

`gecko-gpu-production-r4` 实测：
- 冷启、刷新均 finished、无 pending、85 分，`xc.ua_webgl.fail=false`。
- 顶层／同源 frame／跨源 frame 中，共 **18 个 WebGL 上下文与 6 个 WebGPU 上下文**通过合同；完整已采集 GPU 数据与同内核 off 对照一致。此结果不扩成字体、音频、媒体权限或完整 Firefox parity 证明。
- 同一配置 managed → off → managed 已验证：off 恢复实际主机时区，不应用存留的法语／巴黎时区；磁盘 `user.js/prefs.js` 的受管 UA／WebGL 覆盖已清除，再开启可重新生效。修改 seed 后旧实例复用被拒绝。
- **整站仍 FAIL**：冷启 DNS0；刷新 DNS0 且 `stealth.raf_timing` 再失败。不能因同为 85 分而省略刷新失败。

`gecko-gpu-production-r5` 重复上述 GPU／模式／复用合同均 PASS，相关回归 **1138/1138** 通过、无跳过，TypeScript 编译通过。但 managed 冷启／刷新均 85 分、finished、无 pending，DNS0 和 RAF（40.25／40.75ms）均失败；两张实站截图已查看。真实配置、候选内核和运行前后编译模块摘要不变，自有进程退出已核对。该轮 `about:support` 导航被 BiDi 安全策略拒绝，因此沙箱**有效等级尚未验证**；没有为采数开启系统访问权限。严格结果仍是 `OBSERVED_NOT_ACCEPTED`／exit 1。

同版本 Gecko 源码说明：`remote/webdriver-bidi/modules/root/browsingContext.sys.mjs` 对非安全导航 URL 拒绝访问；`script.sys.mjs` 还会拒绝无 system access 的父进程 context。因此启动时先打开 `about:support` 也不是可用的 DOM 读取捷径。内置 Troubleshoot 报告区分 pref 级别与 `mozISandboxSettings` 返回的有效级别；内容子进程的 `-sbLevel` 仅能作为实际传参证据，不能单独证明内核全部策略已施加。

### 非 GPU 表面：r6 补测发现的功能缺陷

`surfaces-production-r6` 仍使用同一 Studio 生产链和两个自有 profile。另开的自有页面只用于有限 API 合同对照，不代替 Ping0 验收。没有调用 `getUserMedia`、授予权限、启用假媒体或改写检测页。

| 实际反例 | 根因与最小修复 |
|---|---|
| managed Dedicated／Shared Worker 的 `fillText` 抛参数不足；off 正常 | 字体包装回调读取了自身的空 `arguments`，不是外层调用参数；Window 同类代码也有问题。改为捕获外层参数，保留 x/y/maxWidth 和原生返回／异常。 |
| iframe 的 Audio 输入数组被改变，Window／iframe 原始信号哈希不一致 | `instanceof Float32Array` 不识别另一 realm 的数组，随后直接向调用方数组加噪声。改用原生 TypedArray 品牌 getter，先复制合法输入，不改写不合法输入再抛错。 |
| Audio 调用顺序与原生输出范围反例 | 活跃声道按 buffer＋channel 记录；Analyser 每次原生重填后处理，仅处理原生有效样本，保留尾部。亚字节扰动不能被 Uint8 截断放大为整字节偏移。上述细分反例由回归测试验证，不能仅根据旧采集的两个不同输出数组推定复用数组正常。 |
| `microphone 'none'; camera 'none'; speaker-selection 'none'` 的 iframe 仍枚举三个有标签设备 | fallback 直接返回虚构列表，绕过原生权限过滤且 ID 无法选择真实设备。撤掉此覆盖，保留原生枚举／授权语义；fallback 配置不再声称合成媒体列表，显式 native 配置另存。没有因此打开媒体权限。 |
| 同源 Window quota 为 `125829120000`，Worker 为 `10737418240` | 只改 Window。同一个无闭包 helper 供 Window 与既有 Worker shim 使用，携带同一配置配额并保留原生 estimate 其他字段及错误。配额字段一致不等于相应磁盘容量真的可分配。 |

r6 的 OPFS 已执行 UUID 自有文件的 **4 字节写入 → 按名检索 → 重新打开、逐字节读回 → 删除自有文件**；Window／Worker 往返成功。字体仅有 6 个家族的布尔 check／宽度启发式观察，不能作完整字体隔离证明。内容子进程确实带 `-sbLevel 3`，managed/off 一致，但只证明传参，有效内核策略仍未取得。

最初 18 个定向反例全部失败后修复；补充原生 Analyser 写入范围后另出现 3 个失败并修复。当前综合 **1196/1196** 测试通过、无跳过，完整 Studio build 及正式发行公钥读回通过；后续真实复验结果单独记录，不以这些测试代替实站。

r7 生产复验中，Canvas 调用／读回、媒体权限过滤、Window／Worker 配额及 OPFS 往返，在 managed、off、同 profile 关／开指纹四个阶段均 PASS。Audio 源数组与声道顺序恢复正常；新增频谱重复检查却在 managed 和 off 均失败，不能直接归为产品回归：该自有测试遗漏了原生 `smoothingTimeConstant`（默认 0.8），而同版本 `dom/media/webaudio/AnalyserNode.cpp:323–344` 在每次频谱读出时继续做平滑。保留 r7 原始失败，仅在后续自有测试节点显式设为 0 并读回；没有修改产品 Analyser 默认值、Ping0 探针或评分。r7 实站冷启／刷新仍 85 分、DNS0 与 RAF 失败。

r8 使用与 r7 **完全相同的编译模块**复验，只有自有频谱测试显式使用并核对 `smoothingTimeConstant=0`。Canvas、Audio 调用方数组／声道／重复读取、媒体未授权／iframe 拒绝、存储 Window／Worker／OPFS 四类有限合同，在四个 profile／模式阶段共 **16 项全部 PASS**；GPU、模式往返和旧实例拒绝复用也通过。真实用户配置、候选内核与编译模块未改变；自有根进程和最终 profile 进程表清理核验通过。字体完整隔离、获准后的媒体捕获以及沙箱有效内核策略不在这些 PASS 结论内。

**r8 实站仍 FAIL，不能打包**：managed 冷启／刷新都是 85 分、finished、无 pending，但 DNS0 和 RAF（40.63／40.38ms）均失败；两张截图已查看。managed/off 的冷启／刷新四轮各有 8 条自然 DNS HTTP 200 正文，全部 `resolver_count=0`、`items=[]`。这些不是前端异常折叠出来的默认 0，仍不能单凭它们确定权威 DNS、出口与服务端登记中的唯一根因。真实前台仍不是 Firefox，完整窗口／横幅验收仍 INCONCLUSIVE。

### 自然 HTTP 证据与 DNS 限制

在既有 BiDi 会话上先 `session.subscribe`，再用 `network.addDataCollector`（`collectorType:"blob"`，request/response）收集；完成事件后按 `params.request.request` 调用 `network.getData`，最后移除 collector、取消订阅。不 intercept、不重放、不改页面提交。保留的是浏览器暴露的 HTTP 正文，不是 TLS 或 DNS 线字节；缺 body、超限和采集结束前未完成的请求必须逐项标明。

`resource-repack-production-r1` 的两次自然检测各有 8 条 DNS HTTP 200 回包，实际正文均 `resolver_count=0`、`items=[]`；自然 submit 也提交了 0，不是只从 Vue 看到默认值。r4 补充挑战资源元数据，但刷新窗口的旧请求完成／中止事件造成采集上限丢失，已保留 `PARTIAL`，不能将其描述成所有四路 DNS 事务完整可见。后续观察器按“启动事件在本窗口内可见”限定请求，单列 orphan 完成事件；未完成的 HTTP 请求不等于成功解析。r5 冷启各捕获 8 条自然 DNS HTTP 200 零计数回包；刷新仍丢弃 30 条元数据并排除 70 个 orphan 事件，保留 `PARTIAL`。仅过滤孤立完成事件并不能保证旧页面不会在刷新前继续发起请求，也不能证明完整导航归属。

r8 的关联复核：managed 冷启／刷新每轮 8 次自然 DNS 请求使用相同的本轮 stamp 和 50 个唯一域名，50/50 均在本轮挑战资源元数据中出现；两轮域名集合互不相交。POST 约在 stamp 后 3～13 秒，域名内时间与 stamp 相差 0～2442ms，没有观察到毫秒／秒或时区量级错位。HTTP Date 的可能时差区间均包含 0，但边缘 Date 不证明后台登记时钟。刷新还包含旧域的同 ID 元数据且 navigation 为空，不能认定实际重新发送。实际回包计数／items／countries 均为 0，submit 的 DNS 对象也为 0；这排除了明显的前端默认值与 stamp/domain 组装错误，不证明出口到权威的 DNS 成功。

2026-10-17 04:25 UTC 的独立四请求对照（不是 Firefox 自然挑战，也未提交评分）：同一 p1 的 `example.com` HTTPS HEAD 和 Google DoH A 均成功；全新独立挑战形态域的 HTTPS HEAD 在 CONNECT 200 后约 5 秒 TLS 连接超时，Google DoH 返回 HTTP 200、DNS `Status=2`（SERVFAIL）、`EDE 22`、无答案，正文明确为 `Name servers did not respond`，位置在 `d.ping0.cc` 委派。TLS 校验保持开启，`CD=false`，无重试；总超时上限 15 秒但连接上限仍是 5 秒，不能说挑战连接等满 15 秒。两个 DoH 原始正文逐字节读回／SHA-256 校验，Question 与本次目标匹配。**支持该时点的挑战域上游解析异常，不单独证明全球故障或 Firefox 自然链路的唯一根因**；生产 resolver_count 仍不得豁免为通过。

### RAF 与真实前台的边界

所保存探针调用 `_0x2ff85a(8)`：等待 9 次 rAF，舍弃第一次，以回调中的 `performance.now()` 计算 8 个间隔的均值，再保留两位小数。它不是稳定刷新率测试；服务端阈值仍未知。

r1 在高负载机器上报告 42／44.13ms；r4 负载已下降，managed 实站为 31.88ms（未失败）／38.63ms（失败），off 为 18.13／31.75ms（未失败）。自有空白页面上 managed/off 的 48 帧均值均约 16.4ms。不能仅据此认定单一根因，更不能伪造 rAF 时间戳。

r1～r8 所处桌面阶段的 macOS 前台曾为 `loginwindow`；BiDi activate、页面可见或 `hasFocus` 不证明真实桌面前台。Gecko 的 `focusmanager.testmode` 可模拟焦点；此前原生 foreground 实验没有建立根因，因此没有作为产品修复保留。没有尝试解锁或关闭保护。以下正常桌面复验已替代“当前仍锁屏”的判断，但不抹掉历史轮次的前台限制。

**r9 正常桌面复验**：保持 r8 相同内核与产品编译模块，managed 冷启 399 次、刷新 358 次原生前台采样均指向本次 Firefox；采样约每 100ms，最大间隔分别 126/147ms，不是连续 key-window 证明。两轮仍 finished、无 pending、85 分，RAF 为 **47.38/28ms，均被实站判失败**，DNS 仍为 0。自有空白页面 managed/off 的均值约 8.21/8.33ms，与独立读取的 120Hz、在线且未休眠显示器一致。因此锁屏不能解释全部问题；不能把空白页正常当作实站通过。r9 的 off 对照期间出现前台切换，不能声称四轮都在前台。

**r10 原生采样诊断**：仍走同一生产链，在 managed 普通刷新附近对两个经过归属校验的内容子进程进行只读 OS `sample`（各 10s、2ms 间隔、报告各限 8MiB）。两份均 exit 0 且非空，完整结果保留；按瞬时 CPU 选进程并不建立 page→PID 映射，十秒总采样也不是那八个 RAF 间隔的时间线。采样可能扰动时序，刷新还发生了前台切换，所以本轮不是无采样验收。managed 冷启／刷新仍 85 分，RAF **37.25/31.25ms** 与 DNS0 均失败；两张页面截图已查看。真实配置、内核、编译模块和观察器前后摘要不变，自有根进程退出核验通过。按主线程调用树计算，71188 的等待叶为 2700/3830，另有刷新／绘制和 Timer／微任务 JS 活动；71134 的等待叶为 4381/4382。重叠的栈路径计数不是 CPU 利用率，未符号化 JIT 不能归到具体站点或 preload 函数，十秒聚合也不能说明这些工作恰好落入 RAF 八间隔。本次样本不足以证明某个产品性能缺陷。

**r11 采集时序对照**：不改产品、preload、页面探针、网络响应或评分，只把验收器首次页面读取推迟到导航返回后 20 秒。四轮的原生前台采样均为 owned Firefox。managed 冷启 RAF35ms 未失败，但普通刷新36.88ms仍失败；off冷启／刷新36.88/36.38ms也失败，DNS始终0。因此一次冷启不失败不是稳定修复，不能将推迟读取当作验收豁免。相关源码核对还表明：默认主 realm preload 本身经 `executeInRealmWithBindings` 开启 async stack／unlimited stack capturing，轮询首次求值不是唯一开启点；同 realm 后续开启为幂等。命名 sandbox 使用 Xray，不能假设还能读取页面的 `__vue__`。没有为试图过关修改这些原生调试行为。r11 的真实配置／内核／产品模块／观察器摘要不变，退出核验通过，两张 managed 页面截图已查看。

**r12 同一实站页面的检测后对照**：恢复原先首次读取时序，不启用 CPU 采样。先完整保存自然检测结果，再在同一个尚未离开的 Ping0 页面上独立测 48 个原生 rAF 间隔，同时保留 `performance.now()` 与浏览器回调 timestamp 的差值；没有重跑站点检测、替换时间 API、改 DOM 或提交评分。观察器先通过完成／有界超时／检测状态变化三个自有反例控制，测量限时 5 秒；结果不回填站点 rows。

| r12 阶段 | 站点原始 RAF（均 FAIL） | 同页检测结束后独立均值 | 后测 P95 |
|---|---:|---:|---:|
| managed 冷启 | 36.63ms | 8.33ms | 9ms |
| managed 普通刷新 | 27.88ms | 8.33ms | 9ms |
| off 冷启 | 38.50ms | 8.31ms | 10ms |
| off 普通刷新 | 37.25ms | 8.33ms | 10ms |

四次独立采样均完整取得48个间隔，原生回调 timestamp 均值同样约8.32～8.34ms，前后站点 finished／score／RAF值／失败标志完全不变；四轮原生前台采样均为owned PID。**不支持 Firefox 在该实站页面持续被限到约30ms一帧，但仍未定位初始检测期间具体哪个任务或探针自身开销造成差异**。这是独立后测，不是原站点探针重跑，更不能代替原站点 FAIL。managed 两轮仍85分、finished、无pending，DNS0；16项有限表面合同继续通过，配置／内核／产品模块／观察器摘要不变，退出核验通过，两张managed页面截图已查看。

完整原生窗口／横幅及有效沙箱策略仍 **INCONCLUSIVE**：当前屏幕录制和辅助功能权限未授予，REA 原生窗口工具另报告该进程的稳定启动身份不可用。未请求或更改权限，也没有开启 BiDi system access。页面 viewport 截图不能补成浏览器 chrome 截图；`-sbLevel 3` 仍只是实际传参证据。整站和原生窗口门禁未通过，不生成最终交付包。

### RAF 调度：不要把静态并发当成已测瓶颈

对下表所列两份已保存站点脚本作 AST／字面量静态分析，没有执行混淆脚本。`_0x2ff85a(8)` 属于 **`P.stealth`**，不是 `P.hw` 的 `Promise.all` 成员。UI 的 `probeJobs` 对 HW/STEALTH 分别用 idx 4/5 的 `idx * 60ms` 定时器错峰启动，不等待前一 job 完成；这些是延迟参数，不是实测起止时间。

HW 先启动媒体枚举，再同步查询 WebGL、五次 Canvas 绘制／编码、启动三个异步 Audio render，并同步扫描五组字体，最后等待 `Promise.all([media, webgpu, audio])`。字体共 337 个候选条目（非去重），按循环最多 1026 次 `measureText`。这些同步前缀会推迟 STEALTH 开始，不能仅凭它们很重就说它们阻塞了已经开始的 RAF。先前异步续体、后续 PRIVACY/API/ENGINE/DNS job 和结果/UI 更新则没有等 RAF 结束的屏障。最终整体 submit 在包含 STEALTH 的总等待之后，不能当成本轮 RAF 完成前的负载。

精确锚点（`loaded-script-7e1740ca0914.js`，UTF-8 零起点半开字节范围）：`P.hw` `[85727,100236)`、`P.stealth` `[100237,105611)`、RAF 调用 `[104869,104918)`、RAF helper `[275340,280232)`。UI 调度在 `loaded-script-779574c485fa.js:398–460`。这说明实站与空白 fixture 的负载不同，**不证明 r9/r10 哪个任务造成了具体延迟**；还需要与采样窗口对齐的运行证据，不能改时间戳或站点评分来消除失败。

## 公开记录范围

原始 capture 不随本文发布。本文保留检测原理、历史失败、观测覆盖和未知边界；公开最小复现不包含可关联某次实站报告的查询标识或挑战事务标识。

历史 DNS／GPU 调查见[调查记录](review/ping0-live-dns-gpu-investigation-2026-10-16.md)及[最小复现说明](review/ping0-upstream-minimal-reproduction-2026-10-16.md)。当前公开预览候选的资产状态见[Firefox Auto 回归记录](review/firefox-auto-identity-regression-2026-10-17.md)的上传前追加。历史单项通过、公开预览候选存在或安装成功，均不代表整站通过，也不认证当前安装包。
