# Android native timezone：只读实验验收 fixture

**状态：源码及独立静态审查已完成，未发现已确认的阻塞问题；不是 native PASS。2026 冬夏输入一致性修正后，主代理已实际执行纯 Node 回归 13/13、相关源码约束回归 27/27。HTTP delivery、浏览器采样、原生编译、APK 安装和 Android 运行验收仍为 NOT_RUN。**

目标运行时是另行制作的自包含 Chromium content-shell APK，不是现有 System WebView app。本目录不修改或解释任何 native patch，不安装 APK，不启动 Android 工具或浏览器，也不证明正在运行哪个补丁、APK 或配置。

## 边界

- 页面加载只显示 `NOT_RUN`。不采样 Date/Intl、不创建 iframe/worker、不注册 SW。只有填写配置、勾选授权并点击运行（或受控测试执行同一明确动作）才开始。
- 必须明确提供两个**不同的 HTTP loopback origin**，含 1024–65535 的端口。没有默认端口，没有公网目标，没有 URL 参数自动运行。主页面必须位于所填 primary origin。
- 输入只接受精确的 `127.0.0.1`、`localhost` 或 `[::1]`；拒绝用户名密码、路径、query、fragment、其他地址及数字 IP 别名。随附服务器只绑定 IPv4 `127.0.0.1`，并只接受该地址和对应端口的 Host；使用它时应填写它打印的两个 origin。
- 只读取真实的 `Date` / `Intl`。不替换 Date、Intl、Navigator 或其原型，不使用 timezone setter、shim、CDP emulation、页面注入或 host timezone 修改。带 `timeZone` 参数的 Intl 实例仅是明确命名的 tzdata 对照，不改变默认时区。
- 仅使用本 fixture 自有页面和合成时间戳。没有真实账号页面、Cookie/keychain 读取、登录信息、文件上传、外部脚本、遥测或报告上传。服务器不读取/记录 Cookie、Authorization 或请求正文；仅检查路由、方法、Host、Origin 及是否存在请求体。
- 不使用 localStorage、sessionStorage、IndexedDB、CacheStorage 或测试数据库。结果只在内存和页面 JSON 中；不持久化。唯一显式浏览器注册状态变更是一次授权测试内的本 fixture 独占 SW scope 注册与注销。浏览器自身的脚本加载/注册内部行为不能据此宣称没有任何内部磁盘写入。
- 每次页面加载最多运行一次。不要在有真实业务、账号或已有 SW 的 origin 上使用。被任何既有 SW 控制的 fixture 页面会拒绝开始该 realm 的采样。

## 文件

| 文件 | 用途 |
|---|---|
| `index.html` / `fixture.css` / `app.mjs` | 待运行页面、明确授权入口、origin 检查、iframe 编排与只读结果显示 |
| `frame.html` / `frame.mjs` | 自有 same/cross-origin frame；只接受精确 parent window / origin / protocol 的运行命令 |
| `realm-probe.js` | Window 按动作读取；worker 第一条执行语句读取真实 Date/Intl；actual worker 消息处理 |
| `runner.mjs` | 每个 Window realm 独立运行 worker 矩阵及独占 SW 注册/清理 |
| `model.mjs` | 固定输入、期待值、原始读数校验与 fail-closed 状态汇总 |
| `server.mjs` | 可选、未执行的双 loopback origin 有界服务器；不提供通用文件服务 |
| `fixture.test.mjs` | 纯 Node `node:test` 合成数据回归；不启动服务器、worker、浏览器或进程 |

## 将来获得运行许可后的使用方法（以下命令尚未执行）

需要 Node 20+；无 npm 安装和第三方依赖。两个端口必须来自用户明确批准，不要照搬其他项目的端口。`PRIMARY_PORT` / `CROSS_PORT` 在这里是待提供值，不是默认值。

```sh
node mobile/android/native-kernel-tests/server.mjs \
  --primary-port "$PRIMARY_PORT" \
  --cross-port "$CROSS_PORT" \
  --max-seconds 900 \
  --max-requests 512
```

1. 在**另行授权、另行启动**的目标 content-shell 中打开服务器打印的 primary `.../native-timezone-fixture/index.html`。本目录不负责启动、配置、ADB 转发、安装或证明 native runtime。
2. 手工填写打印的 primary origin 与 cross origin，选择**已经在 fixture 外部配置**的预期 native 默认时区。表单选择绝不更改浏览器时区。
3. 勾选此次合成运行授权并点击运行。主窗口、same-origin frame、cross-origin frame 会依次运行各自完整矩阵。
4. 查看各项状态及 JSON，保留原始读数、失败与 `NOT_RUN`。本页面不自动保存报告。JSON 显示长度超过 2,097,152 个 UTF-16 code units 会显式 FAIL，不能静默截断后当作通过。
5. 对纽约和上海分别在外部配置目标 native profile 后运行一次，分别留证。单次运行只证明一个默认 profile 的观测；两个 named Intl 对照不能代替另一个 native profile 的实际运行。

不要用 `file://` 或普通静态服务器代替随附服务器：本 fixture 的 module entry 和隔离 SW entry 使用下面描述的固定虚拟路由。其他受控服务器只有实现完全相同的白名单、scope 和 module-body 合约时才能代替。

## 实际采样与期待值

固定 UTC 输入是 `2026-01-15T12:00:00.000Z` 和 `2026-07-15T12:00:00.000Z`。offset 采用 `Date.getTimezoneOffset()` 的 **UTC − local、分钟**约定。

| 默认 native profile | 一月 offset | 七月 offset | 一月/七月当地小时 |
|---|---:|---:|---|
| `America/New_York` | +300 | +240 | 07 / 08 |
| `Asia/Shanghai` | −480 | −480 | 20 / 20 |

每个快照读取无参数 Intl 默认 zone、无显式 `timeZone` 的 Intl formatter、Date offset、本地字段、Date 字符串数值 GMT offset、ISO round-trip、`toLocaleString()`、`format()` 和 `formatToParts()`。Intl offset 从真实的本地 parts 与固定 UTC 输入独立计算。还读取纽约/上海的冬夏 named-zone 对照。

默认 zone 必须精确匹配所选 IANA 名称，不把别名、不完整结果或 named-zone 对照当作默认时区成功。字段、offset、文本数值 offset、首段读取、消息读取或对照缺失/不一致均 FAIL。

### 每个 realm 的矩阵（main / same / cross，各 19 项）

- Window：仅明确动作之后采样。
- classic 与 module DedicatedWorker：首段 script + 消息读取；实际调用 `terminate()` 后新建，再验证不同合成实例 ID 及新 worker 首段读数。只声称调用了 terminate API 和观察到不同 JS realm，不声称 Android 进程重启。
- nested DedicatedWorker：classic→classic、classic→module、module→classic、module→module；真正由父 worker 创建子 worker，读取父/子的首段与消息读数，最后 terminate 子 worker 与父 worker。
- classic 与 module SharedWorker：连接读取；关闭客户端 port 后用相同 URL/name/type 重连。报告实例 ID 相同/不同，但**两者都不是受控冷启动证明**。没有调用 `self.close()` 或真正停止 SharedWorker。
- classic 与 module ServiceWorker：不同独占 scope，注册、等待真实 activated、通过直接传给 `registration.active` 的 MessageChannel 读取 SW、再发送一次消息、注销和精确 scope 读回。**SW 样本来自 ServiceWorkerGlobalScope 的真实 message 回调，不是 iframe/window callback。**frame 消息只运输该 realm 的完整结果，frame transport PASS 不是 SW PASS。

### Worker 第一段读取与 module 证明

worker 实际响应体以 `realm-probe.js` 的第一条执行语句开始：在任何事件处理、消息、异步动作或 import 之前读取固定 Date 与 Intl。Window 加载同一源码不会采样。

服务器为 `/realm-module.mjs` 和 module SW entry 返回**相同 probe 源码，末尾仅追加 fixture-owned module 执行标记与 `export {};`**。不在前面插入 wrapper/import。这样忽略 `{ type: 'module' }` 而按 classic 解析的实现会语法失败，不能凭 classic-compatible 文件冒充 module PASS。worker 回包还必须带正确 execution mode、kind、实际 script path、请求/运行/实例 ID。

## SW 所有权、读回与清理

每次点击生成新的 128-bit 合成 run ID；scope 严格为：

```text
/native-timezone-fixture/sw/<run-id>/<main|same|cross>/<classic|module>/
```

entry 固定为该目录内的 `entry.js`。服务器不发放扩大 scope 的 `Service-Worker-Allowed`。scope 不包含主页面或 frame，因此新 SW 不控制它们；没有 `clients.claim()`、fetch handler 或缓存写入。

- 只调用 `getRegistration(exactCandidateScope)` 做预检；如果任何已有 registration 覆盖候选 scope，拒绝替换/删除它。不枚举 registrations。
- 只注销本次 register 返回的引用；先核对精确 scope 及所有现存 worker 的 script URL。
- 注销后只读回该精确候选地址，验证自己的精确 registration 已不存在。不清空 origin，不清除其他注册或存储。
- install/activate 快照仅保存在 worker 内存。若 SW 在采样前被系统回收，导致这些实际事件快照缺失，安装/激活验收项 FAIL，不补造事件记录。
- 注册 API 没有 abort。注册超时永久 FAIL；若之后才返回，代码仅尝试对该返回的独占引用做清理，记录 late cleanup，不将原超时升级为 PASS。注销/读回超时也不是清理成功。
- frame 超时会保留该自有 frame，以便尚未完成的独占清理有机会执行；超时不是运行完成证明。
- 若强制关闭浏览器/页面、服务器到期或中断运行，仍可能留下本 fixture 注册。报告里的精确 scope 可供**另一次明确授权**的针对性清理；本 fixture 不在下次加载时扫描或自动删注册。不要用“删除所有站点数据”代替这份所有权边界。

## 必须保持 NOT_RUN 的场景

本实现不会自行执行以下动作；输出中固定列为 `NOT_RUN`，不是“可选成功”：

1. 真正停止 SharedWorker 并进行受控冷启动。
2. 真正停止 ServiceWorker 并进行受控冷启动。
3. 浏览器/content-shell 重启与跨重启持久性。
4. Android background / resume。
5. host timezone notification 与其更新传播。
6. 未单独实际运行的另一个 native 默认 timezone profile。
7. native patch、APK、构建/安装/启动配置的来源证明。

新建 SharedWorker 连接、不同实例 ID、新的 SW message、unregister 返回 true 都不能移除这些限制。`nativeAcceptance` 始终为 `NOT_RUN`。自动观测可能局部 PASS；完整覆盖包含未运行项，不能汇总成 PASS。API 不存在为 `UNSUPPORTED`，脚本/API/CSP 错误或超时为 FAIL；跳过依赖为 NOT_RUN，均不是 PASS。

## 有界服务器说明

- 只绑定所给两个端口上的 `127.0.0.1`，不绑定 `0.0.0.0`，不扫描或连接端口，不读取环境配置。端口占用直接失败。
- 固定 8 个自有源文件白名单，另有固定格式的 module 和 SW 虚拟路由；不服务 README、测试、服务器源文件、任意路径、目录列表、上传或请求体。
- 拒绝编码/traversal/absolute target、未知 query、非当前监听器的 Host 和第三方 Origin；没有 wildcard CORS、Set-Cookie 或请求头/正文日志。
- 启动时对全部 ancestor 做非 symlink 目录与身份检查；文件要求普通、单 hardlink、`O_NOFOLLOW | O_NONBLOCK` 打开并核对 FD/路径身份、大小和时间戳。每文件最多 128 KiB，总源文件最多 512 KiB，之后只从内存响应。缺少 no-follow 能力会失败而不是退回普通 open。源码/父目录在 preload 期间必须稳定；这不是对有权限并发替换父目录的恶意本机进程的通用沙箱保证。
- 默认且最多 900 秒；默认 512、最多 2048 个请求；两个 origin 共用预算，最多 16 个连接，8 KiB header 限制及 socket/request timeout。到期或预算耗尽停止，不隐含浏览器注册清理成功。
- CSP 只容许自有 script/style/worker 及两个明确 loopback frame origin，禁止 connect、form 提交、图片、字体、object 等外发通道。
- import `server.mjs` 不绑定监听器、不预读 assets；只有明确 CLI 调用或明确调用导出启动函数才会执行。

## Node 回归（已执行，不是 native 验收）

主代理在日期一致性修正后实际执行以下命令，结果为 13 tests / 13 pass / 0 fail / 0 skipped；独立 reviewer 复核了 2026 ISO/epoch 的对应关系：

```sh
node --test mobile/android/native-kernel-tests/fixture.test.mjs
```

回归只用合成数据检查 origin 边界、纽约/上海冬夏期待值、缺失/失败不能 PASS、首段读取的必要性、SW kind/scope/事件校验、全部 realm 计划、module trailer、服务器参数与固定路由策略。测试代码不绑定监听器、不启动浏览器/模拟器、不调用 child_process，不创建临时目录/数据库，不读取测试 symlink 或真实账号数据。Node test runner 自身的进程隔离不等同于外部运行时验收。

这些 Node oracle/策略回归不证明 HTTP delivery、module API 支持、Date/Intl native 行为、SW 注册实际落盘/注销、生命周期、APK 来源或真实 Android 场景通过。源码及日期修正经过独立 review；JS 语法检查与纯 host 回归已执行，原生构建、安装及浏览器 E2E 尚未执行。需在匹配 Linux 构建与隔离 Android 准入后分别验证，不能借本节的绿色结果补齐运行覆盖。

## 运行入口的生命周期组件（不是运行许可）

`session_lifecycle.py` 为未来的独占验收入口管理**已经获准、本次新建**的资源，不启动任何 Android 工具、网络监听器或浏览器，也不自行发放存储/运行许可。入口仍须先验证实际 APK、源/制品绑定、目标卷、累计额度、AVD 及外层 backing 的预期写入上界，再把真实的同步、非阻塞许可检查交给 `OwnedSession`。一个 `True`、HTTP 200 或日志 token 不是许可。

- 从 `run()` 开始计时，最多 3000 秒；prepare、on_ready、clients、relay 共用同一截止时间，初始化或进度不会续期。
- 所有新建资源须通过 scope 的工厂/登记接口立即归属；不得传入借用的 listener、writer、进程或日志。工厂/检查必须非阻塞，并只创建本次资源；它们不是任意插件接口。
- listener、任务、writer、子进程和日志有明确数量上限。许可失效、原生工具提前退出、时钟回退、任务失败、取消和正常停止分别处理；失败不能被并发的停止请求改成正常结果。
- 结束时先关闭接入，再取消并等待准备/ready/client/relay、关闭并等待 writer，随后按逆序请求本次子进程正常退出及**实际 wait**，最后关闭日志。子进程 stop 回调必须重新核对归属；不得强杀未知进程、用 TERM/EOF/poll 代替 wait，或把残留进程组标成已清理。
- 清理有独立且最多 45 秒的总宽限，不延长原 session。取消不响应、未确认关闭、缺失 wait、日志错误、清理期限耗尽或迟到资源都保留 `UNCONFIRMED`；不得因此释放运行归属或开始下一环境。
- 本组件不验证 Android 的安装、进程亲缘、Window/Worker 数据或 Ping0，也没有完整 runtime controller/容量许可的 CLI。它不改变上面的 fixture 页面和未运行矩阵。

宿主回归：

```sh
python3 -I -B mobile/android/native-kernel-tests/test_session_lifecycle.py
```

测试使用内存 listener/writer 模型，**不绑定 TCP/UDP listener**；asyncio 自身可能创建 wakeup socketpair。一项测试另外启动一个新建的微型 Python 子进程，只向该 Popen 句柄发送 TERM，并实际等待退出。它不是 Android、模拟器、Chromium 或网站 E2E。首轮真实失败回归暴露了停止/失败竞争、同步清理异常、flush 失败漏关句柄、清理过期后启动新 stop，以及停止后丢失 writer 等问题；修复不删除相应断言。生命周期源码由主代理审查，不冒充独立 peer review。
