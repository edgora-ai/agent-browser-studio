# Ping0 实站调查记录（2026-10-16，未验收）

## 历史观测边界（2026-10-16）

2026-10-16 12:18–12:23 UTC 新增三轮真实生产链对照：

| 证据目录 | owned配置选择 | 页面实际出口 | 实站结果 |
| --- | --- | --- | --- |
| `cpu0055-final-natural-r1` | default，普通代理侧DNS | 19个IP，JP/HK | 24分，6项失败 |
| `cpu0055-egress-google-a2` | default，显式Google严格DoH | 18个IP，JP/HK | 24分，同6项失败 |
| `cpu0055-fixed-p1-r1` | 已有p1，普通代理侧DNS | 1个IP，US | 70分，只剩DNS/GPU失败 |

这不是新代码修复。固定出口对照消除了新出现的机房/地域/语言/时区/多出口相关失败组合，
不能把原先变化直接归因于DNS开关；也不能保证代理未来不会改变。真实默认配置没有修改。
三个owned Studio/Chromium/native-off进程组的9个根PID均已OS读回退出，真实配置和四输入
文件/组合hash保持；完整身份均PASS，实站均严格exit1。截图已查看，自然submit原文hash
及服务端ident/hw回显已复核。原生InfoBar展示槽仍不可见/零bounds，未声称完整像素验收。

剩余两项的历史最小复现说明：
[ping0-upstream-minimal-reproduction-2026-10-16.md](ping0-upstream-minimal-reproduction-2026-10-16.md)。
截至原始记录时未向维护方发送，未取得服务端修复权限；没有用户出口IP、代理、账户、Cookie、许可或报告ID。
实站/刷新重启/交付包门禁仍未通过，不以该报告代替修复。

2026-10-16 12:04 UTC 新增真实生产链 `cpu0055-google-normal-r1`：显式 Google 严格
DoH，无额外DNS刺激，HTTP200/finished/no pending，仍70分、DNS0及GPU失败，exit1。
被动采集的自然submit请求/响应原文与SHA均已读回：服务端原样收到并返回全部ident/hw，
包括arm/64、MacIntel及实际Apple M1 Pro ANGLE Metal。没有客户端丢字段证据；该事实
仍不足以还原服务器完整GPU判定谓词。用户要求继续解决，不接受以外部错误为由提前收尾。

补充HTTPS委派查询 `dns-delegation-google-fef5435dc6.json`（不是浏览器验收）：父区NS正常；
Google对 `d.ping0.cc NS` 报EDE22和 `Name servers did not respond [104.218.235.243].`；
父区DS查询正常、无DS答案，CD=false。它把服务方报告的故障缩到具体权威地址，未证明全球
宕机、DNSSEC被关闭或具体防火墙根因。未修改用户默认DNS。新内核文件/组合hash及真实配置
保持，三个owned roots均读回退出。

**未修复 Ping0 验收，未生成新安装包。** 0055 CPU修正内核已完整构建并实际运行，
新四输入57693b2a…；最新普通受管生产链 `cpu0055-managed-normal-r1` 仍为
`70/red`、`resolver_count=0`，`xc.dns_blackhole` 与 `xc.ua_webgl` 失败。
CPU独立缺口已真实通过新门禁：managed六上下文arm、同批严格off-control arm，
331断言/292required全PASS，实际发送的CPU请求头匹配；原生worker遗漏不冒充已验证值。
这不等于GPU finding通过。R4旧内核记录及其persona符合性PASS保持原样，不扩大成CPU真实。
早前20秒严格DoH原始日志确认25真实SERVFAIL，因窗口不覆盖完整页面且observer overflow，
路由仍INCONCLUSIVE；默认bounded日志scratch失败也保留。最新post-site标准EDNS诊断
实际仅两次：example.com正常；本轮challenge收到SERVFAIL及EDE22（at delegation d.ping0.cc.）/
23，Cloudflare报告权威可达性/网络错误。原始包已独立解码核对；仅是该次较晚独立查询，
不反填旧原生事务的EDE、不推断精确委派/服务/网络故障原因、不混辅助结果作实站验收。
Native-off仍44/6fail且有相同GPU tuple，不据此豁免受管失败。HTTP200、采集完成、
完整构建、CPU门禁和正常退出，都不代表Ping0或完整原生横幅已验收。

调用链为当前 Studio → 真实 IPC → `BrowserManager.launchBrowser()` → 项目
Chromium → `https://ping0.cc/env`，Playwright 仅连接生产选择的 CDP 端口。
使用自有临时 userData/profile，不导入真实账户、Cookie、代理凭据或许可。
真实配置前后哈希一致；没有修改系统 DNS、hosts、TLS 校验或沙箱。

## 真实页面

`legacy-caret-guard-real-page/result.json` 记录：

- HTTP 200，`finished=true`，无 pending 行。
- 分数 70，两项失败；DNS 后端八次回复 HTTP 200、计数均为 0。
- 严格 findings gate 返回 1，不再把“采集完成”当成通过。
- 21,602 条 trace 事件，无报告的 overflow/data loss。
- browser.stop 成功，Studio 退出 0，真实用户配置未改变。

2026-10-16 06:15 +08 的再次无额外 DNS 刺激检查
`production-unassisted-recheck-0053-source-only/result.json` 仍为检测完成、70/red、
同样两项失败、resolver_count=0，严格 gate 返回 1。四项运行输入前后相同，
真实配置未改变，正常停止且 OS 回查自有浏览器进程已清空。此轮 trace 有
`overflow=true`，所以不能据其未保留事件推断没有 SYSTEM 或其他流量。
它仍运行旧内核，不能当作 `0051`–`0053` 的运行验证。

测试所用的旧内核为 Chromium `152.0.7977.72`，不是下述新补丁构建物。
后续对照的 launcher、Framework、resources.pak 和 V8 snapshot 四项输入均在
启动前及结束后核对，组合 SHA-256 为：

```text
1f614fd67df90298a09b1ec8c5feb81fe9ecc1a176c23ed4ed81d206037783b1
```

这绑定实际文件输入，不补足历史源码构建溯源，也不能反推旧运行都已有同等绑定。

## DNS：不是只有“浏览器没触发查询”

真实客户端脚本触发 DNS-prefetch、CSS background-image、Image 及 STUN 四条
路径，并向 `/envdetect/probe/dnsleak` 提交本轮 domains/stamp；不能只凭
DNS-prefetch 的实现解释所有零计数。客户端脚本无法证明服务器记录/过滤规则。

### 原生同批正反对照（不是页面验收）

`native-provider-compare-19ickdxx/observation-summary.json`：

| 显式配置的提供者 | example.com | d.ping0.cc | 从真实页面取得的 challenge |
| --- | --- | --- | --- |
| AliDNS | rcode 0，有答案 | SERVFAIL / rcode 2 | SERVFAIL / rcode 2 |
| Cloudflare | rcode 0，有答案 | SERVFAIL / rcode 2 | SERVFAIL / rcode 2 |

通过浏览器原生 DNS UI，每家提交三次 Lookup。原生设置 getter 显示有效
`mode=secure` 及相应模板；两段 trace 均无 overflow/data loss。保留的窗口中
未观测到 SYSTEM_TASK，但没有把数字 source_dependency ID 强行当作 CDP id2，
也没有宣称完成全部 DNS→代理因果绑定。

启动时自动恢复了旧的自有站点标签；这些标签在 tracing 前立即关闭或转到原生
设置。其 tracing 前执行未知。因此“六次”指显式 Lookup 提交数，不代表整个
启动过程只有六次网络查询。

### 独立标准 wire 对照（仍不是页面验收）

`browser-provider-wire-efnp1dfz/observation-summary.json`：在新的空白页，通过
真实生产浏览器的普通 HTTPS fetch，发送独立构造的标准 DNS A 查询。请求头为
`Accept: application/dns-message`；正常代理、CORS 和 TLS 路径，无站点脚本或
响应修改。恰好两个请求，未重试。

| 查询 | HTTP / 类型 | DNS 结果 |
| --- | --- | --- |
| example.com/A | 200 / application/dns-message | ID/问题匹配，rcode 0，2 条答案 |
| 先前真实 challenge/A | 200 / application/dns-message | ID/问题匹配，rcode 2，无答案 |

原始二进制响应均为 61 字节，已另行读回复核 ID、问题、计数及 SHA-256。
正控制响应 SHA-256 为
`d370aa6f8e207659341354c06fa438462b41b836f631b42044d3b0c3822e9491`；
challenge 响应为
`df5baac35c744953752a877c6a56c14c5adc3ae896890253a7e8d4b0618d4eb9`。

这说明自定义原生 resolver 的封包/解析不是复现此 SERVFAIL 的必要条件。
请求未宣告 EDNS，响应没有 OPT/EDE；不能据此指定权威区、委派、DNSSEC、
探针策略或后端记录中的哪一项为具体原因，更不能宣称权威区全网宕机。

更早的 DNS-JSON 文档导航对照在首请求出现
`ERR_HTTP_RESPONSE_CODE_FAILURE` 后停止，没有取得数字 HTTP 状态、JSON body
或 EDE。该失败记录保留，不能用作明确的 DNS 上游错误说明。

## UA/GPU 观察

受测页面的失败值为：

```text
platform = MacIntel
webgl_renderer = ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)
```

同机项目 native-off 模式及未修改 Google Chrome `155.0.8059.40` 的对照也被
同一项判失败，且显示相同原生 tuple。后者不是产品验收；未取得站点服务端规则，
不能把解释失败当成失败项消失。曾试验让 UA OS token 跟随声明的 macOS 版本，
实站仍为 70，因此已撤回该无效试验，不保留任意 UA 版本改写。

没有伪造 Apple GPU 字符串/能力、换 Windows persona、禁用 GPU 以跳过检查，
也没有豁免此 finding。完整六上下文身份验收尚未运行通过。

进一步离线回查已保存的真实提交：CPU architecture 在 `/ident/ua_high_entropy`
这个 JSON 字符串里，managed 为 `x86`；未修改 Chrome 的对照为 `arm`，却仍收到
相同 `MacIntel` + Apple Metal renderer 的失败项。因此 `x86` 不是该失败现象的
必要条件；也不能根据 finding 的两字段 `value` 反推后端没有使用其他输入。
页面的 Direct3D11 不一致说明来自公共 i18n 通用帮助，不是后端针对这组 Metal
值给出的具体规则或解释。managed 架构硬编码是独立一致性缺口，但目前没有证据
把改架构、旧 platform 或 GPU 字符串当作清除这个 finding 的最小修复。

## 源码候选及真实编译

- TypeScript 旧规则的 `~NOTFOUND` 改为 Chromium 实际识别的 `^NOTFOUND`。
- `0051` 增加受限、独立于 fingerprint payload 的原生 local-DNS-deny 入口；
  启动器仅在选中内核明确声明能力时采用，旧核继续保留安全的通用规则。
- `0052` 为显式严格 DoH 增加 DNS-only 的代理预解析 opt-in；默认 deny、
  预加载开关、socket preconnect 和 `.local`/`.local.` 保护不放宽。
- 实际 Clang 已编译 DNS policy helper，但拒绝 preconnect 单元中的
  `GURL::host_piece()`。`0053` 追加修正为本树真实存在的 `host()`，将 default-deny
  virtual 方法移到现有 implementation，并显式导出 Delegate。

旧补丁没有重写。`0053` 已通过正常 apply/check 应用；56 项补丁输入和 110 项
最终源码承诺验证通过。修正后的六个指定翻译单元现已跨轮全部实际编译成功，
使用未改动的 GN compiler 命令；六个对象的大小和 SHA-256 又由主会话独立读回
核对。先前三项成功与本轮三项成功分别记录，没有将旧失败/未运行记录改写为绿。
422 项定向 Vitest 测试经 JSON 独立核对通过，TypeScript 编译通过。
这些均不能替代完整依赖构建、链接、原生测试、新内核运行或实站验收。

后续发现受限 DNS 开关替换通用规则后，原启动 payload hash 没有枚举
`--agent-browser-local-dns-policy` 和 `--agent-browser-proxy-bootstrap-host`。
先用 managed/off 两种模式实际复现 14 个负例未拒绝旧 stamp（另 4 个正控制通过），
再把这两个参数加入生产溯源绑定。移除、改写、重复及一起移除均被旧 stamp 拒绝。
当前选择的 401 项回归通过、无 failed/pending，TypeScript 编译退出 0；401 与
此前 422 是不同的重叠选择，不能相加。一次扩展运行还发现旧 exported-launch
fixture 缺少新 capability mock；补齐旧核不支持该能力的 mock 后重跑通过，
没有跳过断言或放宽测试门槛。该修正不改变正在编译的原生源码和 GN 参数。

新内核运行准备改为显式选择新 preparation，绑定成功 full-build receipt 与
四项新输入 manifest 的 SHA-256，使用新批次自有 userData，不再指向已不可用的
旧 ABS 路径。完整构建尚未成功时，输入采集器已实际以退出 2 拒绝创建新准备记录。
这些只是防错准备；实际新内核、原始 NetLog 的正面事务证据、真实窗口横幅及
六上下文身份验收仍待执行。CDP Tracing 不是原始 NetLog，不能直接交给需要
`constants/events` 的解析器冒充已验证事务。

## 诊断日志、身份与清理的防错准备（仍未运行新内核）

- 显式 NetLog 入口默认关闭，只接受本次应用 userData 下新建的私有日志文件；
  固定使用 `Default`、JSON、近似滚动 64 MiB 和 180 秒时限。没有增加 IPC/REST/MCP
  参数或改动 API 认证。日志目录不跟随链接、不覆盖已有文件，并检查 POSIX owner、
  writable/sticky 祖先；这不是任意 ACL 或 Windows ACL 的完整认证。
- 在新建的 0700 userData 之外，0777 非 sticky 祖先仍可被替换。该条件性路径问题
  先用实际文件系统用例复现为 1 红 / 26 绿，再补逐级祖先检查；01777 且 entry owner
  受保护的正控制保留。测试链接目标都在自有小型 fixture 内，没有读取外部链接目标。
- 最终选择的 14 文件 / 554 项回归均通过，failed=0、pending=0，JSON 独立核对；
  TypeScript 编译退出 0。554 包含日志路径、真实 launcher 接线、DNS 溯源与既有
  解析/策略回归，与前述 422、401、429 等集合重叠，不能相加。
- 原生 `bad_flags_prompt.cc` 明确把 `--log-net-log` 与 `--net-log-capture-mode`
  列为危险开关。故正常实站/横幅检查不启用这些参数；单独的日志诊断保留 Chromium
  自己的告警，不加 `disable-infobars`、`test-type`，也不修改原生告警列表。
- 原始日志诊断通过真实生产启动器创建进程，并可使用已有无凭据 HTTP 上游的本地
  CONNECT pass-through observer；不改 TLS、响应或站点数据。CLI 日志必须实际读回
  完整 JSON、稳定字节及 SHA-256，不能把定时到期或 browser.stop 成功当作 flush
  成功。滚动保留及单 target verifier 只证明其保留范围，不能提升为全页面无泄漏证明。
- `chrome://accessibility/` 的 native UI tree 采集仅作为有损 AX 观察；当前操作系统
  没有屏幕/AX 外部采集许可，空容器、缺失子树或未发现告警字符串不自动判横幅通过。
- 生产 driver 已接入同一个两端口 loopback fixture 的六上下文采集。managed 的 off
  控制仍通过同一 Studio IPC 另建自有 profile 启动，独立核验实际 PID、argv/stamp、
  执行文件/Framework 映射和 CDP listener；不拿 caller 填入的 binding 当成 OS 证明。
  fixture 在真实站点结果、截图和 native UI 观察保留后才运行，不替代实站验收。
- 清理必须在真实停止后用 OS `ps` 回查自有 Studio/浏览器 root PID；仍存活、查询
  拒绝或清理报错不能返回成功。4 项本地退出核查控制（含真实已退出/仍存活进程）
  及 3 项错误 preparation 门禁通过，错误门禁均未新建运行目录。只读复核另外发现
  trace end 失败后仍可进入 fixture，以及 trace command/response body 无期限等待的
  问题；现已补成功 finalization 前置门禁、整段 command+completion 截止时间及
  单响应/整体采集截止时间，失败不重试不确定的 trace end，仍继续清理自有运行。
  更新后的 driver 语法检查、12 项本地进程/trace/前置门禁控制及 3 项 preparation
  拒绝门禁通过，记录为 `runtime-driver-controls-fbd5c32840.json`。含协议 double 的
  本地控制不代表浏览器 E2E；真实六上下文、日志 footer、原生 UI、相关 DNS/GPU 项
  仍未验收。

## 未完成的交付条件

1. 完成修正后的原生编译、所需原生用例及完整内核构建。
2. 通过真实生产启动验证新能力、默认代理/显式 DoH 的保护和真实窗口横幅。
3. 无额外查询刺激地完成 Ping0 页面检测，DNS/GPU 相关失败消失，并完成刷新及
   停止/重启重复；缺字段、站点故障解释或原生对照失败均不豁免。
4. 之后才构建、正常签名、核验新 DMG/ZIP，并复测包内实际程序。保留正式许可
   公钥；不自动覆盖本机安装版，不提交、推送或发布。

### 完整内核续编已启动（2026-10-16 08:24 +08）

此前把脚本的首次构建 90 GiB 保守预估当成不能继续的硬条件，处理过于保守。
实际脚本区分首次构建与 20 GiB 续编条件；已有输出包含真实 `build.ninja`、
`.ninja_log` 和编译产物。因此改为在已验证的 DevProjects APFS 上直接续编同一
输出的完整 `chrome` 目标，4 路并行，不复制源码或浏览器，不修改正式构建参数。
启动时输出卷约 63.92 GiB、宿主 SSD 约 465.33 GiB、源码/系统盘约 67.78 GiB
可用；运行期间分别监测实际余量，低于 12 GiB 或挂载身份变化才停止自有构建。
不向 owners 关闭的 ABS 卷写入，不提权或扩容。

阶段记录位于已登记证据目录的 `full-kernel-hjiegg6h/`，Ninja 启动 PID 为
`50755`；`native-full-build-current.json` 指向该阶段。原先 8 GiB 是已完成的
翻译单元检查阶段预算，本阶段已明确登记为完整内核续编，保留历史失败记录。
2026-10-16 10:34 +08 的实际进度为本轮剩余动作的 `26,271 / 54,745`，
仍在编译 Blink；输出卷约 60.5 GiB、宿主 SSD 约 461.8 GiB、源码/系统盘约
67.6 GiB 可用。完整链接、产物核验、新内核横幅和实站验收仍未通过，未生成安装包。

### 首轮全构建的真实失败与最小修正（2026-10-16 13:50 +08）

`full-kernel-hjiegg6h/result.json` 最终记录 `CHROME_TARGET_FAILED`、退出 1，
进度 `54,154 / 54,745`。失败命令是将源树的 `app.icns` 复制进 Chromium 自身
Helper bundle，原 macOS 构建规则强制 `/bin/cp -Rc`，实际报
`clonefile failed: Cross-device link`。SOURCE 在内置盘，OUT 在已验证 APFS 的另一卷，
所以这不是 C++ 编译失败、权限不足或磁盘容量停止；此处也不是生成交付 DMG/ZIP。
Ninja 已退出，原对象和完整失败记录保留，110 项源码与 release args 前后核验相同。

在同一个实际源图标和实际目标卷上另做小型对照：`-Rc` 真实退出 1，普通 `-R`
退出 0；85,977 字节逐字节/哈希读回一致，源文件未变，目标具有独立文件身份。
证据为 `cross-volume-bundle-copy-669ou96n/result.json`。据此准备追加 `0054`，
仅移除 Apple `copy_bundle_data` 规则对强制 clonefile 的要求，保留独立资源复制、
Linux 分支及其余 release/ThinLTO/codec 参数；可应用检查已通过。正常应用、更新源码
承诺并续编仍需完成，不以这项图标对照提升为完整内核、横幅或实站验收。

随后 `0054` 已经正常 provenance/apply/check 通过，并实际核验全部 111 项最终
源码。新增项仅为 Apple toolchain，去掉该行后仍精确得到原 110 项 manifest 的
`794ab297...` 摘要；旧 patch/payload 没有被重算接受改写。新 manifest SHA-256 为
`df73d9ad6be9521b6471a2fe14df2a64fbc3d1d050ef95cbf931d66c1c59eca4`，
补丁输入为 57 项。GN gen 退出 0，原 release args SHA-256 未变，实际 dry-run
剩余 643 动作，不重新复制/编译整棵源码。

2026-10-16 14:04 +08 同一 OUT 的真实续编已启动，阶段 `full-kernel-o5qp53em`、
Ninja PID `46090`、四路，后续实际图按 restat 收敛为 593 动作；14:09 记录
`275 / 593`。原失败的 Helper 图标已由真实 Ninja 复制成功，再独立读回其
85,977 字节与源 SHA 相符，并在实际 `.ninja_log` 查到该目标的成功记录。
`native-0054-real-copy-readback.json` 保留这一范围的证据；没有手工改写 Ninja log。

扩展到 15 文件的回归实际为 564 / 564，通过、无 failed/pending，TypeScript
退出 0；更新后的 driver 12 项本地控制及 3 项拒绝门禁也通过。首次调用使用了
当前 Vitest 不支持的 `--minWorkers`，没有跑到测试；该失败保留为
`native-0054-test-cli-rejected.json`，没有因外层 shell 的退出 0 宣称通过。
修正为已查明支持的 CLI 参数并启用 shell fail-fast 后，独立 JSON 报告
`production-dns-build-regressions-81c8e42b7b.json` 才是本轮通过证据。
这些集合与此前 554 等重叠，不能相加。完整链接、新内核运行、横幅和实站验收
仍未完成，未生成交付安装包。

### 完整内核和新输入身份已核验（2026-10-16 14:29 +08）

`full-kernel-o5qp53em/result.json` 随后真实完成 `593 / 593`，退出 0，终态为
`CHROME_TARGET_SUCCEEDED_ARTIFACT_CHECK_PENDING`；111 项源码及 release args 前后
身份一致。输入采集器在这次成功物上实际运行通过，新的 preparation 为
`native-built-inputs-9e4f0c2k/runtime-preparation.json`，不是旧路径/旧核的 fallback。

- 实际 CLI 版本 `Chromium 152.0.7977.72`，退出 0，stderr 为空。
- 实际 capability 查询返回完整五项，含 `agent-browser-local-dns-policy-v1`。
- launcher 与 Framework 均由 lipo 确认恰为 arm64；四文件前后 hash 读回相同。
- 新四输入组合 SHA-256：
  `442e0910cb947c18541adfada89b42aedd3a4cd685c1e9c0c2a815a7a454ce78`，
  与历史旧核 `1f614fd6...` 不同。
- Framework 为 271,896,784 字节，其 SHA-256 为
  `9c56f7bf8721199e9e7c7ef8c30fd007c8ea45322109025a55cd687e43735967`。

首次新核正常 driver 在打开应用前因 Node 直接导入依赖 Electron 的溯源模块
失败；不是原生内核构建失败，也没有页面验收。失败保留于
`new-kernel-managed-normal-0054/preflight-failure.json`。接线已改为在真实 Studio
Electron main 中调用未改动的生产溯源函数，Node 继续独立读取 OS argv、映射和
listener；不 mock Electron、不改 launch policy、不跳过 stamp。其他 collector
的真实 Node 导入检查通过，不等于启动了应用。重试使用新 label 保留旧失败。

此时仅完成完整内核及输入身份验证；随后真实运行结果见下节。构建成功不等于
native UI 横幅、六上下文、DNS/GPU、刷新/重启或交付包验收。

### 新内核已实际运行，普通实站仍失败（14:43 +08）

`new-kernel-managed-normal-0054-r3/result.json` 的真实 Studio PID 为 66334，
生产 Chromium PID 为 66466、CDP 61058，四项输入前后均为 `442e0910...`。
真实 Electron main 的 Node 24.16.0 使用 `process.getBuiltinModule('module')`
的 `createRequire` 调用未改动的生产 request hash/reuse verifier；此前第二轮
`app.evaluate` 的 dynamic import callback 错误保留于 r2，没有 mock 或跳过溯源。

- 页面 HTTP 200、finished=true、无 pending，reportId 为
  `REPORT_ID_REDACTED`；得分 70，三项 finding 失败：
  `stealth.raf_timing`、`xc.dns_blackhole`、`xc.ua_webgl`。
- resolver_count=0；真实页面自然提交 50 个 challenge domains，八次记录到的
  DNS 后端 HTTP 200 回复仍全部为 0。没有手工 DNS lookup。
- 实际 argv 使用新原生 local-DNS policy 两项开关，无通用 resolver rules、
  `disable-infobars`、`test-type` 或 CLI 日志开关。此轮仍启用了 CDP netlog
  Tracing，保留事件 overflow=true；不能做全局缺席/无泄漏推断，也不能排除
  观察开销对 44.83ms rAF 结果的影响。后续普通轮已不再启用该 tracing。
- 原生 GPU tuple 仍是 MacIntel / Apple M1 Pro Metal，没有更改或豁免。
- 页面截图实际查看。随后同 fixture 的 off 控制已通过真实 Studio IPC 启动，
  但版本采集器错误地只读 `#version` 的直接 Text 节点，实际 152 的版本在
  `#version > span#copy-content > span:first-child`，故完整身份为 CAPTURE_FAILED，
  不是已经证明内核版本不一致。原始 DOM 证据保留。
- browser.stop 成功；OS ps 读回 Studio 66334、managed 66466、off 71515 均不存在。
  真实配置未变，四输入前后一致。site FAIL 不因后续采集器错误而被抹去。

### 显式严格 DoH 原始日志诊断结束，但 journal 为空（14:56 +08）

`new-kernel-doh-raw-netlog-0054/result.json`：真实生产链选择 Cloudflare 严格
DoH，仅在自有配置添加一个真实 CONNECT 转发 observer，61976 转送原有
127.0.0.1:7890 上游。没有额外 DNS 刺激、CDP Tracing、TLS/站点修改或系统 DNS
变更。本轮是诊断，不是正常横幅/站点验收。

- Studio 84885、Chromium 85094、CDP 61984；原生设置 getter 实际读回 secure
  及精确模板。页面仍完成 70、resolver_count=0，DNS/GPU 两项失败。
- 同进程 `chrome://accessibility` 使用原生前端相同的相对 URL XHR 读取
  targets-data.json；合法 `showOrRefreshTree` 请求成功取得可见窗口 AX 树。
  真实 `InfoBarContainerView` 下有可见 `ConfirmInfoBarWithNormalLabel`，明确
  显示 `--log-net-log` 不受支持告警。这是保留警告的正控制，不是横幅 PASS。
  AX projection 并非完整像素/Views 覆盖；正常横幅仍 NOT_ESTABLISHED。
- 实际 argv 含约定五项日志参数，但 180 秒定时及额外有界等待结束后原始
  journal 仍为 0 字节，返回 INCONCLUSIVE，没有调用事务解析器伪造计数。
  退出后再次独立 lstat/SHA-256 读回仍是 regular、0600、空内容；不能证明 DNS
  成功、SERVFAIL 或无泄漏。writer 原因继续按源码追查，失败文件与报告保留。
- OS ps 读回两个自有 root PID 均不存在，真实配置与四项输入前后相同，
  cleanup 无错误；诊断按设计退出 2，productAcceptance=NOT_ACCEPTED。

### 严格版本元素采集修复已编译和回归（15:12 +08）

修复仅接受唯一 `#version` 下的直接 Text 或精确唯一、非嵌套的上述版本 span，
保留原始、有界 DOM 证据；两来源冲突、多个匹配、非 leaf、截断、缺失均拒绝。
四段规范版本解析与 Browser.getVersion product 比较没有放宽，没有扫描 body 或
从 product 反填 DOM 值。真实 152 DOM 重放先红后绿。

`production-dns-identity-regressions-5347cf7eb5.json` 实际覆盖 18 个文件，
777/777 通过、failed=0、pending=0，Vitest/TypeScript 均退出 0；JSON 与回执已
fsync、读回和 hash 核对，git diff --check 通过。此前报告回执使用不支持的
Path.open(opener=...) 导致外层退出 1，原报告保留，修正后重新完整运行，不把
首次外层失败说成绿。此回归不是原生 gtest、六上下文或实站通过。

### 普通 r4 实站仍失败，真实六上下文已通过（15:13 +08）

`new-kernel-managed-normal-0054-r4-no-trace/result.json`：没有 CLI 日志、CDP
Tracing、额外 DNS 查询或 CONNECT observer，生产默认代理未改，explicit DoH
配置已从自有配置删除并实际重载验证。Studio 93632、Chromium 93888/CDP63698。

- 真实页面 HTTP200、finished=true、无 pending，reportId
  `REPORT_ID_REDACTED`，仍 70/red；DNS0、GPU 两项失败。
  rAF 本轮为 7.35ms、fail=false；这不把此前失败改绿，也不证明长期时序性能。
- `ping0-final.png` 已实际查看，明确显示检测完成、70 分、两项异常和原生 Metal
  tuple。strict gate 退出 1，productAcceptance=NOT_ACCEPTED。
- 真实版本 collector 在 native-off 和 managed 两者都取得唯一叶子 span 的
  `152.0.7977.72`，与 CDP product/输入版本相同；原始 DOM、候选数和未截断状态
  保留，未从 product 凑值。
- 同 fixture 六上下文的 navigator、请求头/协商证据完整；native-off 控制和
  managed validator 都 PASS。managed 310 个断言中 277 个必需项全部 PASS，
  没有豁免任何 Ping0 finding。这只是合同范围内身份一致性，不是全部物理硬件
  字段或站点评分已经通过。
- 正常 native AX 树关联 Ping0 页，文档前后 visibility 读数均为 visible；这不
  等于 macOS 窗口实际最前或未被遮挡。InfoBarContainerView 显示 INVISIBLE、
  (0,0)-(0,0)，仅保留 ContentShadow 装饰子项，没有 InfoBar 子项，并非完全无
  child。同核日志正控的容器高度为56、有真实告警及关闭按钮；主内容容器的
  绝对顶边143/87、高度657/713恰好相差56个布局单位。这支持有限结论：捕获
  时当前标签的标准 InfoBar 展示槽没有横幅结构及占高；不是像素或所有manager
  活动/待显示对象的证明，bannerAcceptance仍NOT_ESTABLISHED。
- 源码回查 `accessibility_ui.cc` 的 native dump 遍历 AXPlatformNode 的真实
  child枚举，不因INVISIBLE剪枝；不是Aura wrapper只枚举可见View的另一条路径。
  但leaf/virtual/ignored/modal/native-Cocoa转换均可能限制全树覆盖；InfoBar
  manager还有pending队列。现有infobar-internals只提供testing目录/触发接口，
  不是live manager只读计数，不为加强结论去触发或隐藏信息栏。
- 自有 Studio/managed/off PID 经 OS ps 实际读回不存在，cleanup/errors均为空，
  真实配置及 `442e0910...` 四输入前后相同。

### 原始日志空文件的直接失败阶段已查实

自有浏览器日志 `owned-runtime/userData/logs/browser-ab_mvalipjz_ytiiyf.log:237`
实际有 NetworkService PID85119 的错误：
`services/network/network_service.cc:1180: Unable to create scratch directory for net-log.`
本树 StartNetLogBounded 在创建 observer 之前先异步创建 scratch，空路径就返回；
定时 StopNetLog 对空 observer 不作操作。因此不能延长等待或删除预留文件冒充
修复。实际选中的 temp 路径及 errno 未取得，不能把具体 sandbox/文件系统原因
当作已观察事实。没有放宽 sandbox 或 user-directory feature。

后续另加显式短时 direct-FD 诊断选路及外部大小监护，保留默认64MiB/180s路线
及其失败记录。原生 direct-FD writer 无原生大小 cap，不能把监护的轮询预算说成
硬cap；它仍需90秒停止、完整稳定JSON和实际事务证据，任何超限/不完整均不能PASS。
当时此诊断尚未真实运行，更不是普通站点、横幅或交付通过。后续实际运行及
预算失败如下，旧失败不改写。

### Direct-FD 本地门禁、审查反例与实际超预算停止（16:24 +08）

固定 `direct-fd-90s` 仅用于显式诊断，保留默认64MiB/180s五参数路线；它使用
四个固定参数、Default/json，省略native max-size。8MiB/50ms外部监护可能
overshoot，不是原生硬cap。主会话实际emit后18文件834/834通过，不能代替实跑。

首次独立AST审查在旧driver SHA `ee15de66...` 确认三个缺口：报告EIO可跳过
即时stop/close、终态迟到launch丢PID责任、DISARMED后response仍可落盘。17个
实际反例先红，修正后driver SHA `3e3fb7a5...` 保留迟到PID失败审计、关闭采集
阶段的前后门禁，报告写入与stop/close解耦。主会话重新emit、834/834、80本地
controls+3拒绝门禁通过；独立定点26检查失败0。均明确为本地doubles，不是
真实原生取消/退出/flush。没有放宽沙箱或失败finding。

首次label `new-kernel-doh-direct-fd-netlog-0054` 的自有代理名拼成65字符，生产
上限64，启动浏览器前被拒绝；Studio22588实际退出、guard无timer、原配置/
四输入未变，失败保留。只缩短诊断标签，没有改生产名称校验。

`fd90-0054-r2/result.json` 随后真正启动Studio23735、Chromium24009/CDP50541，
observer50534转送既有上游，真实Ping0 HTTP200。没有CDPTracing或手工DNS。
约39秒时外部监护观察到8,389,395字节，触发8MiB预算停止；停止后文件实际为
8,524,404字节、regular0600，说明轮询和停止确有overshoot。没有把这个超预算
文件交给严格8MiB解析器，没有补造footer。原始事务结论INCONCLUSIVE，页面
采集被中断，不取代此前普通r4的70分失败结果。OS读取两个自有root已不存在，
自有profile清单无剩余main PID，cleanup无错、timer清除、原配置及四输入未变。
stop成功仍不被当作flush证据。

### 仅增加固定20秒早期DNS窗口，不扩大预算（16:32 +08）

由于90秒日志过大，另增显式 `direct-fd-20s` 和对应driver参数；默认180秒及
已有90秒路线保留。不接受任意duration，8MiB文件/解析预算、私有新文件、
90秒版已验证的退出/迟到清理门禁、完整稳定JSON双读均不放宽。20秒只覆盖
初始DNS活动，整页完成可能在窗口外；既有coverageIssue及INCONCLUSIVE不得
提升为通过。原生源码/111文件承诺与四输入没有变化。

先实际复现新20秒模式拒绝（1红，旧两模式正控制2绿；另108测试因filter未跑）
以及未知CLI参数拒绝，再实现固定选择。`fd20-production-regressions-3784ea9cb9.json`
最终18文件872/872、0failed/pending，tsc退出0，85本地controls+3门禁通过；
这些与此前834/777/564高度重叠，不累加。该时点已发起 `fd20-0054-r1` 真实生产链
早期窗口诊断；实际终态见下节，未预填站点或路由通过。

### 20秒原始日志完成，真实 DNS SERVFAIL 链已复核

`fd20-0054-r1/result.json` 绑定同一新核442e…，Studio27723/Chromium28000，
HTTP200、finished、70/red、DNS0，DNS/GPU两项失败。原始日志5,890,294字节、
25,885 events、regular0600，SHA-256：
`9fd0f8f55320a152b42ee095bdd4cc3edffb3df3cc65b6e1ddd06660c102ccf0`。
原生20秒定时结束后完整JSON双读稳定，guard未超限、已DISARMED/无timer。
日志覆盖08:32:55.421–08:33:15.155 UTC，页面采集在08:33:38.587 UTC返回；
route仍为 `INCONCLUSIVE / page-completed-outside-conservative-timed-log-window`，
CONNECT observer overflow=true。采集成功、无SYSTEM事件或CONNECT ok都不能升格
为全程完整/无泄漏证明。诊断退出2；自有roots已OS读回不存在，原配置/四输入未变。

离线分析使用本文件constants及原生source `type:id`，不是CDP ID；ordinal为
`events` 零基索引。7次POST是相同有序50域、`stamp=<REDACTED_CHALLENGE_STAMP>`。17个本轮域出现
resolver job，共34个DNS parent：25条真正带解析字段的响应为rcode2/answer_count0，
涉及16域，parent END=-817；另5个HTTPS parent被中止（-3），4个parent无END。
5个hostname=`(probe)`的非challenge DoH已排除。HTTP200并不等于DNS成功。
其余33域在这份短窗口内没有匹配local DNS parent，不是整轮“从未查询”的证明。

主会话独立核对计数及三条样例链并保存有界摘要
`native-dns-servfail-chain-9965918d14.json`（9,226字节，fsync/精确读回/检索）：

- C1 HTTPS：job14:186 → DNS44:187 → DoH/URL43:188，显式双向边3402/3403；
  HTTP200@12051，parsed response@12069确为2/0，DNS END@12070=-817。
- C3：A44:211 → DoH43:212，response@12093=2/0、END@12094=-817；并行HTTPS44:209
  END@12096=-3。@7910仅dependency，没有rcode，不能给它补造SERVFAIL。
- C37：job14:1930 → DNS44:1931 → DoH/URL43:1932，BEGIN分别23009/23015/23017，
  URL BEGIN23031；缺END/parsed response/status，保留未完成而非成功或确定失败。

摘要首次两次序列化尝试分别因错误常量名、误用normal模式assessment字段而在写入前
失败；随后按真实constants及 `diagnosticSiteAssessment` 修正。原始证据没有改写。
现有证据不能唯一定位上游权威、委派、DNSSEC或后端策略原因，也不能豁免DNS finding。

### Native-off 实站对照及独立身份控制缺口修复（16:57 +08）

`off-site-control-0054/result.json` 真正运行同核native-off后也出现相同
MacIntel/Apple M1 Pro Metal renderer GPU失败。页面44分/6失败，另外时区/语言/字体
交叉项使用宿主中国环境与美国代理，因此不是受管模式新增回归。该轮后续身份门禁
70项required非PASS的直接原因是driver只在managed创建nativeControl，却在off仍选
`native-control-omission`合同。旧FAIL保留；没有放宽validator或复制当前actual作对照。

仅修driver条件，使两个支持模式都通过真实Studio IPC创建第二个独立native-off控制。
`runtime-driver-controls-00e228fa2c.json` 的88本地控制+3拒绝门禁通过，包含实际AST两
mode分支条件及旧managed-only条件反例；这些不是浏览器证据，也不把先前872单测
称为本次重新执行。新driver SHA-256：
`66af61fc160c4a90acbaef7106c9721c92508ae6ceb1eb978d5fde3ac6846786`。

真实 `off-site-control-0054-r2/result.json`：08:56:31–08:57:22 UTC，Studio40682、
Chromium41000/CDP53499、独立nativeControl41575。页面HTTP200、finished、44分，
reportId=REPORT_ID_REDACTED，6失败仍是rAF/DNS/中国字体/语言/
时区/GPU，resolverCount0，严格退出1、NOT_ACCEPTED。截图已实际查看。站点采集后，
同fixture真实off+独立off-control六上下文身份门禁双方PASS，301断言/268required
全PASS。全部自有root PID经driver及主会话再次OS ps确认不存在，Studio退出0、
cleanup/errors0、原配置未变、四输入442e…未变。它只修复身份采集控制覆盖，
不表示GPU或DNS实站已修复；未打包、未安装、未提交/推送/上传。

### 单独修正已证实的 macOS CPU 身份偏离（0055，原生重编中）

既有r4记录同批同机同核的managed六上下文/实际请求CPU为x86，严格绑定off控制为arm。
原生公共 `GetUserAgentMetadata()` 确有固定x86；旧完整身份门禁只证明配置persona符合性，
不证明物理CPU。不能把它的PASS扩大为CPU真实，也不能据native arm仍有GPU失败就豁免站点。

前向 `0055-native-macos-cpu-metadata.patch` 仅在IS_MAC且platform=MacIntel时调用
`base::mac::GetCPUType()`：Intel→x86，ARM/translatedIntel→arm；不改bitness64、
legacy UA/MacIntel、其他persona或GPU回落。既有公共//base依赖及BASE_EXPORT满足调用，
没有新增embedder反向依赖。normal provenance/apply/check均退出0，111最终source逐项读回；
只有目标头文件变化，旧53patch/payload、其他110source、HEAD/archive sidecar未变。

- patch SHA：`1843601b7848bbce5f8eb3b98336669026ba1174428e92ef718aa99f70b1349b`。
- source manifest：`e83ed04672ca2d9ca98939fbf00406dede5fdca27c21dc66587dcc4c975e8a1a`。
- PATCHSET文件 SHA：`64402a6bd8e5d1022b49d5f90bcc198a9eda27e44031ec127a6390bdf612c439`，
  58inputs/111sources。曾发出的另一PATCHSET摘要已被独立实际读回否定，不使用。
- 原生源码任务证据：`native-cpu-0055-dgs2m0jk/result.json`；source约束5有效红→5绿，
  最终过滤选择7通过/8未跑，不是native compile/gtest/Intel或Rosetta runtime证明。
  首次0048重建夹具失败和一次回执分类错误均保留，不算有效红或整个命令成功。

新增显式 `managedCpuPolicy: native-control`，与legacy persona符合性分开：必须给出CPU
期望，严格同batch/host/executable/window-mode的off控制先PASS，且为不同PID和profile，
才能作为CPU依据。六navigator以及实际协商发送的CPU请求头都要与该依据一致；native
worker完整遗漏仍明确NOTRUN/非必需，不把不存在的HTTP值说成已验证。生产driver在真实
独立off采集后给出其CPU期望，不从managed当前值反填；现已保存driver与compiled validator摘要。

- 新CPU身份测试先20红/77因名称filter未跑；随后完整97/97、0pending，通过严格noEmit及
  正常TypeScript emit。原有Windows/persona及遗漏形态回归保留。
- `real-native-cpu-gate-red-273f623b66.json` 对原始r4不可变实测数据离线重验：旧personaPASS，
  新CPU门禁FAIL，off-control自身PASS；六navigator及三个实际HTTP architecture字段被拒绝。
  原始报告未改写，这不是新runtime或站点验收。
- `native-cpu-production-regressions-cd5aa0c21b.receipt.json`：19文件897/897、0failed/pending，
  tsc/vitest/diff-check退出0；私有driver91控制+3负向preparation gates通过。与此前选择重叠，
  不累加，不冒充实站或native gtest。后续仅补充driver/validator元数据摘要，再跑91+3通过。

真实全目标增量在2026-10-16T09:18:07Z开始，唯一OUT仍为原 `native-compile-only-xnwt0nsn`，
phase=`full-kernel-wwxwegm1`、Ninja52251、4jobs，原发布参数未改。09:28实际62/70，
剩余链接/打束/最终目标和新四输入尚待完成；没有复制完整源码或浏览器，没有90GiB新建阻塞。
`cpu0055-running-build-negative-5d7a70e091.json` 证明RUNNING时capture helper实际退出2且
没有造新preparation。旧1f614…与442e…输入都不能改名充作0055内核。

Default原始日志确实不包含DNS wire/EDE字节：`net/dns/dns_attempt.cc:65–81` 仅在kEverything
才记录response_buffer，当前保留响应只有rcode/count/dependency。没有扩大捕获敏感模式，
不能从additional_answer_count=1推断具体EDE、DNSSEC或权威原因。普通新核实站、CPU真实性、
完整横幅及刷新/重启验收仍待真实执行；DNS/GPU未过之前仍不打交付包。

### 0055 完整构建与正常实站CPU验收已实际完成，页面仍失败

`full-kernel-wwxwegm1/result.json` 在2026-10-16T09:35:04.975905Z实际完成完整chrome目标，
restat后的68/68、exit0；111source承诺及发布args29b10bb…前后相同。实际新四输入：
`57693b2a7ecd22eeb429bf81043c4ab5181d193f3343824d23e859cf96ed7cb1`。
其中Framework新SHA52ead0e61da36c1892c15a1a11cd6bce702777cb59088b62d057432891dadd3e；
launcher/resources/V8snapshot保持先前各自输入hash。真实lipo均arm64、CLI152.0.7977.72和
五capabilities均通过；`native-built-inputs-qu36v979`保存新manifest/preparation，未复制浏览器。

普通 `cpu0055-managed-normal-r1/result.json` 真正运行Studio70583/native70714/CDP56061/
独立off71083，09:39:44–09:40:31 UTC。没有辅助DNS、CLI日志/CDPTracing/CONNECT observer。
页面HTTP200、finished、no pending、70red、DNS0/GPU失败、严格退出1；reportId：
REPORT_ID_REDACTED。截图已实际查看。新CPU门禁PASS331断言/292required：
managed和native-off均arm，六navigator及实际存在的CPU请求头匹配；native worker完整遗漏
仍NOTRUN/非必需，不冒充已验证值。CPU真实缺口已修复，但GPU finding并未消失。
所有三个自有root PID经driver与主会话两次OS ps确认不存在，cleanup/errors0，真实用户
配置和新四输入前后未变。Intel/Rosetta runtime及native gtest未跑，不作跨平台成功声明。

### 仅两次真实标准EDNS查询取得 provider-declared 权威错误

私有 `dns-ede-wire.mjs` 是有界8KiB A/IN EDNS0 wire codec，不安装依赖；33纯synthetic
wire controls通过。`dns-ede-driver-controls-11a9570d1a.json` 的23实际AST/浏览器及FS doubles
通过，包含失败正控制停止、先完整页面、未知provider拒绝、普通原DNS策略保留、响应上限、
超时/迟到page关闭/cleanup错不吞等；既有91+3 controls仍通过。首轮helper控制因FSdouble
缺constants失败，仅修double后重跑，不拿它作native/上游红例或成功证据。

首次 `cpu0055-ede-r1` 的真实请求 `https://cdn.ping0.cc/js/vue.min.js` 在30秒超时，随后两次
Vue is not defined；页面保留未渲染模板，collector在wait-timeout结束为INCONCLUSIVE。
实际补充查询0。没有注入Vue、伪造完成状态或评分；截图和失败原样保留。全部自有root
退出、CPU身份PASS、config/57693…输入未变。此项不能仅凭同时选择了nativeCF就唯一归因
于DoH：同host其他脚本已加载，具体网络超时原因尚未知。

后续明确分开“native生产DNS”和“补充诊断endpoint”，不是静默fallback：
`cpu0055-ede-r2` 按已工作的普通proxy-side DNS模式启动，owned config中未设native DoH
模板，真实读回/重载/列表和launch证明均保留，原生deny+bootstrap两参数仍在。Cloudflare
只用于显式post-site诊断，不被装成用户或原生DNS默认；未关闭DNSSEC/TLS或更改系统设置。
不混日志/手工native DNS，也不再做provider/QTYPE fuzz。

这轮Studio99085/native99375/CDP59648/off99927，2026-10-16T10:30:11–10:31:08Z。
先保留真实页面HTTP200/finished/70/DNS0/GPUfail、reportId：
REPORT_ID_REDACTED；页面 `ident.ua_high_entropy` 实际已是arm/64且该行
fail=false，`xc.ua_webgl` 的MacIntel/Apple M1 Pro Metal renderer仍fail=true。截图已查看。
之后才在另一owned blank页发送以下两次POST `application/dns-message`：

| 问题 | 真实响应 | EDE |
|---|---|---|
| example.com A/IN | HTTP200，DNS rcode0，2A答案；40字节query/72字节response | 无 |
| 本轮`r-<timestamp>-<nonce>.d.ping0.cc`（已脱敏） A/IN | HTTP200，DNS rcode2，0答案；72字节query/115字节response | 0空；22文本`at delegation d.ping0.cc.`；23空 |

原始query flags均0x0100（RD1/CD0），EDNS0/1232且DO0；没有请求关闭解析器DNSSEC验证。
CD和DO含义不同，DO0不是要求关闭验证。Chromium `opt_record_rdata.cc:212–215` 明确将
22映射NoReachableAuthority、23映射NetworkError。这是Cloudflare所报告的该次委派可达性/
网络失败，不证明具体哪台权威服务器、DNSSEC、委派配置、服务或防火墙原因。

四个新的0600原始包共299字节。除Node codec外，主会话用独立Python struct遍历并精确
复核ID/问题名/A/IN/flags/counts/OPT/EDE、文件长度/hash，fsync/读回/检索均通过。
`real-edns-extended-error-readback-8cf7821a95.json`（3,653字节）SHA：
`e2239b3f34375beba88fe485fcc81fc404b6e56983e5f58e2382998c2071e5eb`。
补充challenge在stamp后37,441ms发送；其后端生命周期未知，所以不把这份EDE反填为
08:32日志25个native SERVFAIL的精确原因，更不代表整轮DNS路由/无泄漏或站点通过。
原始page collection前后摘要相同，严格诊断退出2/NOT_ACCEPTED；CPU门禁仍PASS331/292。
自有三root由driver与独立OS ps两次确认不存在，errors/cleanup0、realConfig及新四输入未变。

### 当时实际阻塞与交付门禁（2026-10-16）

可在本项目内修正并真测的CPU偏离已修；DNS已经取得真实upstream SERVFAIL及provider所
报告的d.ping0.cc权威可达性错误。但旧晚37秒的独立EDE观测不是“客户端绝无可修之处”
的证明；先前把外部服务作为排查终点的判断过强，用户没有接受停止。继续通过明确的因果
对照缩小问题，不重复无新假设的查询。GPU规则尚未取得，原生对照仍有同样原生tuple失败，
不能据此豁免finding，也不
伪造平台/GPU字符串来刷过。未请求或绕过TCC，因此完整窗口像素/所有manager状态的横幅
验收也仍未成立；有限AX展示槽检查不扩大成完整产品证明。

整体实站修复仍未验收，未通过后的刷新/重启验收不冒充已完成，交付DMG/ZIP保持未生成。
截至该记录时未安装、签名发布、上传或 commit/push，真实配置/凭据/许可/系统DNS/hosts/TLS/沙箱未改。后续候选资产及公开预览版状态见[Firefox Auto 回归记录](firefox-auto-identity-regression-2026-10-17.md)的上传前追加；本历史调查不认证当前任何安装包，也不构成实站通过声明。
