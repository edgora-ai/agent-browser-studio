# Android 原生内核：服务器接手任务

## 目标与当前状态

用户已选择**可控原生内核**，并要求把开发分支交给其他 Linux 服务器执行。目标是修复 Android 原生指纹的一致性，第一步只验证原生时区从冻结配置传播到 renderer 和 Worker；不是改检测站分数，也不是隐藏模拟器的真实硬件特征。

- 分支：`feat/android-resume-20261027`。
- 开发基线：桌面 `main` 提交 `2f3b0b3fba206d0a86c209789c191f4d5a4e1811`。
- 当前 `mobile/android` 是可运行的 **System WebView 内部原型**，还没有接入自编译 Chromium。
- 当前 Android 编译输入：92 文件，SHA-256 `0b9337db3adc3f340501d21b539f35fda79aa235bc04fa053a31f96c5a2df1cf`；范围由 `mobile/android/tools/build.py:source_inventory` 定义，不包含 Markdown。以服务器实际计算为准，不因文档中的旧摘要跳过核验。
- 原生 Chromium 目标：`152.0.7977.72`，声明上游 commit `026bb13a93d60e7adfefa2bbf58d6f57c2d335cc`。已有完整顺序补丁登记到 `0056`；新增编号从 `0057` 起，不覆盖旧补丁。
- **尚未实现本任务的原生修复，没有新的评分 PASS，也没有可分发的自有 Android 内核 APK/AAR。**

详细记录：

- [已完成的 App 生命周期/存储里程碑](android-resume-lifecycle-storage-2026-10-27.md)
- [原生内核能力与构建物料核对](android-native-kernel-readiness-2026-10-27.md)
- [Android 工程与受限构建说明](../../mobile/android/README.md)
- [Chromium 补丁与协议](../../patches/chromium/README.md)

## 1. 获取分支并先做只读准入

使用用户指定的仓库地址和已授权凭据，不把密码、私钥或 token 写进命令、日志或配置文件。此分支不要求合并 `main`，也不要求服务器自动推送、发布 APK 或修改桌面包。

```sh
git fetch <已配置的仓库远端> feat/android-resume-20261027
git switch --track <已配置的仓库远端>/feat/android-resume-20261027
git status --short --branch
git log -1 --format='%H %s'
```

若工作区已有同名分支或本地修改，先检查，不执行 reset、clean、覆盖 checkout 或自动删除。核对实际 HEAD 与交接时提供的提交一致。

在服务器确认明确的专用工作目录和存储规则后，再执行下面的只读检查：

```sh
uname -s
uname -m
getconf _NPROCESSORS_ONLN
free -h
df -h "$WORK_ROOT"
python3 --version
git --version
```

`WORK_ROOT` 必须由服务器操作者明确选择，不能为空或指向用户数据目录。Chromium Android 官方构建基线是 Linux x86-64、至少 8 GB RAM（推荐超过 16 GB）、至少 100 GB 可用空间；**100 GB 是上游最低参考，不是本项目完整峰值预算或本轮新授权额度**。还要计入源码、匹配依赖、输出、链接临时文件、缓存、APK 与证据，并按服务器本身规则保留空间。

没有准入通过前：不运行 `gclient sync/runhooks`、安装脚本、GN/Ninja/Siso、容器拉取或自动依赖下载；不扩大卷、不清理历史输出。先报告缺项和实际预算。

## 2. 构建物料：复用可以，版本混用不可以

优先复用服务器已有的匹配 Linux Chromium 源码和工具链，不从这个仓库复制本机路径、构建缓存、开发 keystore 或运行数据库。

检查：

- 实际 Chromium revision、`chrome/VERSION`、依赖锁定及已有补丁状态；不能把 synthetic seed commit、LASTCHANGE 或某个声明 stamp 当作全部源码同源证明。
- `patches/chromium/PATCHSET.sha256` 与实际 patch 文件；使用仓库已有顺序验证流程，保留所有失败记录。
- Chromium 所需 host tools、JDK、NDK、SDK/build-tools。当前 152 源码默认 platform/build-tools 37；轻量 App 的 SDK35/JDK17 与它不是同一套构建要求。
- 目标为 `arm64` 的 Android APK，host 架构和 target 架构分别核对。桌面 arm64 Chrome 不是 Android 产物。
- 先确认准确 GN target、依赖闭包与空间峰值，再执行构建。不得假定已有 desktop `out` 或某个 `.o` 可以直接安装运行。

禁止更改用户手机或模拟器的系统 WebView provider、root/hidden API 策略、安全设置、系统时区来替代 App 内核集成。

## 3. 第一阶段实现：原生时区验证壳

### 3.1 不先移植整套 desktop persona

已有 `0025-native-timezone-identity.patch` 在 Blink `TimeZoneController` 中采用 ICU/V8 的 native 时区 hook，可作为最小验证切口。

现有全量 fingerprint 配置和部分 UA-CH 是 desktop 语义。**不能只增加 Android 平台到 `enabled()`，就同时启用 Windows/macOS 的 UA、CPU、GPU 或 desktop form-factor 值。**第一阶段保持真实 Android UA、CPU、内存、GPU、屏幕路径，只增加显式的 Android 冻结时区验证模式及严格有效性条件。

### 3.2 冻结配置与 Android embedder

首选自包含的 Android content-shell 测试 APK，暂不替换系统 provider，也不先把现有产品 UI 改成假接入：

1. 在 Chromium 启动、第一次读取配置单例前安装一次性冻结配置。沿用现有编码/大小/schema 检查，拒绝格式、版本、IANA 时区或身份无效的输入。
2. 现有 renderer 参数转发挂在 `ChromeContentBrowserClient`；为选定 Android embedder 增加等价的明确转发。仅传本次需要的冻结配置，不广播其他桌面开关。
3. 每个 renderer 和新 Worker 使用同一份冻结配置。A/B profile 各用全新浏览进程；不提供运行时换 profile 或任意 `setTimezone` setter。
4. native ICU/V8 覆写失败必须拒绝测试导航，不能静默退回宿主时区再报告成功。
5. 增加有界、无秘密的有效配置摘要及 native 应用结果回执；摘要相同只证明输入绑定，不能代替实际 Date/Intl 读值。
6. 不允许网页、任意外部 Intent 或未校验磁盘路径注入 profile。保持同会话、单次启动、精确进程归属和退出证据要求。

如果抽取已有公共 hunks 而不沿用全部顺序补丁，必须独立固定最终源文件、依赖和 patch 集，不能随意选几个 patch 后声称拥有原补丁链的覆盖。

## 4. 必须实际执行的 RED → GREEN

先保留未修复控制组，再跑修复组；采样脚本只读取原生值，不修改 `Date`、`Intl`、`Navigator` 等内建对象。

### 时区矩阵

| 配置 | 原生 Intl 默认时区 | 2026-01-15T12:00:00Z offset | 2026-07-15T12:00:00Z offset |
| --- | --- | --- | --- |
| America/New_York | America/New_York | 300 | 240 |
| Asia/Shanghai | Asia/Shanghai | -480 | -480 |
| 无配置对照 | 记录真实宿主值，不硬编码 | 记录真实值 | 记录真实值 |

对主页面、同源/跨源 iframe、Dedicated Worker、SharedWorker、Service Worker 分别采集。还要覆盖后台恢复、新建 Worker、Worker/进程正常重启；缺失或不支持的 realm 标为未覆盖，不计 PASS。

需要测试：非法/矛盾配置拒绝；旧会话、迟到配置、不同 profile 不污染当前进程；普通平台和无配置行为不回归。宿主时区通知场景必须另行确定受控测试方式，不能擅自改真实系统设置。

### 保留现有 App 回归

现有 App 上轮已经验证，但内核集成后必须重新跑，不沿用旧绿：

本次提交前复查的源码仍是上述 `0b9337db…`。Java core 使用项目规定的 UTF-8、`-Xlint:all -Werror` 编译并执行 203/203 通过；Node 89/89 和 buildguard 9/9 通过；宿主 SQLite/static 复跑在执行 43 项后因原 `tests/storage` 的 64 MiB 累计保留额度耗尽产生 4 个错误，**该次复跑没有通过**。没有删除旧库、重置额度、提高阈值或转到另一目录补绿。上轮同源码的 54/54 与真实 Android 验证仅作为已完成的历史记录保留；接手服务器应在自己的明确准入根和预算内完整重跑。

- Java core 203 项、Node/VM 89 项、SQLite/static 54 项、buildguard 9 项是上一源码的计数，不是服务器新运行的预期固定总数。
- Android lifecycle 12 场景和原生 SQLite/解析/启动票据 48 checks。
- 真正启动安装后的 App，完成配置写入 → 直接 SQLite 查询 → 重开读回 → 按名称检索。
- 独立 A/B profile 的 Cookie/LocalStorage/IndexedDB 正常退出后冷读；旧测试只覆盖正常浏览进程切换，不覆盖断电、强停、SessionStorage、CacheStorage、SW 或真实登录态。
- APK 版本、架构、签名、打包 assets 与源码绑定；安装后拉回实际 APK 比较大小/SHA-256。
- 仅正常停止本次拥有的浏览器、模拟器和私有 ADB，记录实际退出及残留；失败或 cleanup-unverified 不计成功。

## 5. 最后才重测 Ping0

已验证本地原生行为后，再使用用户明确选定的测试代理和隔离模拟器重测；不要复制其他机器的代理 PID、端口、配置或凭据。

历史 52 分中的时区不符是本任务第一修复点；两核/2GB、SwiftShader 和 RAF 是该次模拟器的真实观测，不能靠换字符串、改采样或调整检测阈值宣称硬件身份成立。DNS 零值要区分请求失败、脚本兜底和服务端零记录，保留具体请求链与正向结果证据，不预设 fake-ip、认证或某个节点为根因。

禁止：改站点/评分代码、JS 身份 shim、忽略 TLS、静默 DIRECT 回退、放开任意第三方、把 403/429 当指纹识别证明、使用真实账号或业务站点。若受限依赖仍存在，报告 partial，不把 166/166 的页面完成计数当全部网络探针成功。

## 6. 服务器需要回传的结果

1. 实际 Git HEAD、Chromium revision、补丁集摘要、GN args 和工具链版本。
2. RED 与 GREEN 的原始退出状态和明确失败断言；无执行结果的项标 NOT_RUN。
3. App/native APK 的 SHA-256、字节数、实际安装读回一致性。
4. 每个 realm 的时区 ID、冬夏 offset、覆盖限制与配置归属。
5. 原 App 回归、存储直接查询/重开/检索及真实 UI 结果。
6. 最新评分、逐项异常和依赖完整性；明确它是否来自此次 APK。
7. 构建/运行峰值、磁盘余量、正常退出和清理不确定项。

只回传脱敏技术结果与自有合成测试证据。不要回传私钥、token、激活码、真实 Cookie、账号数据或整机索引。未得到额外授权不合并、推送其他分支、发布安装包或清理历史物料。
