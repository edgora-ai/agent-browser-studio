# Android 开发状态与跨机器交接（2026-10-31）

## 先读结论

**可以转到其他机器继续开发和编译，但当前不是“产品全部开发完成，只欠编译”的状态。**

- Android 管理／System WebView 内部原型、原生时区验证壳补丁和原生产品适配源码已经保存。
- 尚无通过本轮完整构建、签名／内容核验、安装读回和运行验收的自有 Android 原生内核 APK。
- 原生产品适配仍需真正的 GN 图、Java／C++／JNI／资源构建及运行验收；验证壳不能冒充产品 App。
- 最近的 Java／构建服务器修复有真实组件证据；最新主续编入口只完成准备和定向合同检查，没有实际完整运行。
- 本机因内存压力警告未再启动需要 8 GiB 内存的构建 VM。有界资源观察已经结束，没有本会话仍在运行的 Native 编译或资源观察任务。
- 本文提交／推送只交付 Git 中的源码和文档。**本机专用构建控制脚本、Chromium 源树、工具链、增量输出和私有原始证据不随 Git clone 分发。**新机尚无已经验证的一键原生构建入口。

本文更新当前状态；[2026-10-27 服务器任务](android-native-kernel-server-task-2026-10-27.md)保留为历史任务和验收要求，不应单独作为最新执行状态。

## 1. 源码身份与本次交付范围

仓库：`https://github.com/edgora-ai/agent-browser-studio.git`

分支：`feat/android-resume-20261027`，不要求合并 `main`。

本文起草前核对的本地源码 HEAD：

```text
81eddd0b971d7d52fd8672ed66f6be2315e0c424
```

该 HEAD 包含以下三个归档提交：

| 提交 | 内容 |
| --- | --- |
| `1c7575a81ad19ab721b3e48857aacb69b4ede04f` | Android 原生内核开发检查点，含产品适配、0057／0058 和相关测试／文档 |
| `92848d84f4488c57b58a45fc74005d2d40bfb0d9` | 桌面同步进度与存储保护归档，不是 Android 原生验收结果 |
| `81eddd0b971d7d52fd8672ed66f6be2315e0c424` | 隔离可见指纹验收工具归档，不是 Android 实站通过结果 |

起草时，已跟踪源码没有未提交修改；只读查询远端分支实际仍为 `0906488e5f35d61b7b3c0972f65d4730bbe97783`，上述三个归档提交尚未在该远端分支。它们将与本文沿同一分支正常推送。**推送是否成功以及包含本文的最终提交 SHA，须以移交完成时的实际远端核对为准；`81eddd0…` 本身不包含本文。**

四个未跟踪的旧发行／部署目录原样保留，不属于此次源码交付；不删除、移动、打包或加入 Git。本次不发布 APK、不迁移缓存、不连接新构建机、不安装或更改设备。

### Git 中已经包含

- [Android 原型、共享 core、测试与受限构建工具](../../mobile/android/README.md)。
- [原生产品适配／GN 输入／单独 bootstrap overlay](../../mobile/android/native-kernel/README.md)。
- [原生只读 realm 验收 fixture](../../mobile/android/native-kernel-tests/README.md)。
- [0057 冻结原生时区协议](../../patches/chromium/ANDROID_TIMEZONE.md)及 [0057 补丁](../../patches/chromium/patches/0057-android-frozen-native-timezone.patch)。
- [0058 Canvas 有界像素访问修复](../../patches/chromium/patches/0058-canvas-bounded-pixel-access.patch)。
- [补丁摘要](../../patches/chromium/PATCHSET.sha256)、[最终受管源码摘要](../../patches/chromium/PATCHED_SOURCE.sha256)及[补丁历史](../../patches/chromium/PATCH_HISTORY.md)。

起草时实际核对：0057 中的 `base::NoDestructor<AgentBrowserAndroidTimezoneConfig>` 保持 **static**，不能改回自动局部对象；0058 已存在，下一编号应为 **0059**，不得覆盖 0057／0058。

## 2. 开发与验证状态

| 部分 | 已完成的范围 | 仍未完成／不能推导的结论 |
| --- | --- | --- |
| Android 原型 | 环境管理、不可变配置版本、SQLite、专用浏览进程、启动 claim、生命周期控制；历史隔离模拟器已验证部分配置／进程／正常退出后存储读回 | 仍是 System WebView；不是已接入自有内核的产品；不是完整网络／存储／真实登录态通过 |
| 0057 原生时区验证壳 | 独立冻结配置、Android embedder 传播、源码与受限组件检查 | 真实 APK、Java/native 关联、Window／Worker／其他 realm 冬夏时区矩阵尚未验收 |
| 0058 Canvas 修复 | 补丁已存档；真实 Android 目标对象编译组件验证通过 | 单个对象成功不等于完整 Chromium 或 APK 成功 |
| 原生构建工具 | 当前 Java 适配、真实 installed Turbine／D8、构建服务器正例与异步失败反例已有组件证据 | 最新组合后的主续编没有完整运行；不能把历史工具组件当新 APK 证明 |
| 原生产品适配 | Application／Activity／Runtime、冻结启动序列化、私有目录、诊断、资源选择与单独 overlay 源码已有 | 真正 GN 图、Java／C++／JNI／资源编译、最终 Product APK 和运行仍未执行 |
| 新原生 APK 安装与 Ping0 | 有历史原型结果和验收设计 | 本轮自有内核安装、全字节 pull 核验、浏览器 PID 亲缘、Window／Worker 实测、Ping0 截图／新评分均未执行 |

详细产品缺口见[原生产品适配说明](../../mobile/android/native-kernel/README.md)。普通浏览入口仍受完整准入保护；代理认证不受支持，完整身份／网络隔离／web-storage 生命周期未获验证。不得以 WebView CookieManager 的回执代替 native Cookie 或全存储退出证明。

历史 Ping0 的 `52/100`、`166/166`、五项异常及 `partial68` 来自旧 System WebView build0014；不是当前原生实现的成绩，不能改写为本轮通过。模拟器 CPU／内存／SwiftShader／RAF 的观测也不是可用字符串覆盖掩盖的问题。

宿主 SQLite／static 回归另有一次未完整通过：旧 64 MiB 累计保留测试额度耗尽，43 项执行中有 4 个错误。历史绿灯保留，但不能代替新源码完整重跑；新机应在明确准入的新测试范围和预算内执行，不删除旧库或重置旧额度来补绿。

## 3. 最后一次完整 Native 构建与最新修复

### 3.1 完整构建仍为失败，不是正在运行

最后实际完整续编的本机记录名为 `590`，attempt 为 `native77-arm-vz-027`：

- 真实 Ninja 退出 `1`，不是达到 deadline；最后保留计数为 `1613/2000`，计数不是剩余时间估算。
- 失败动作为 `activity_state_java__validate_deps.bytecode.stamp`；直接执行的静态依赖校验缺少 `AUTONINJA_BUILD_ID`。
- 当前工具链配置使用 `android_static_analysis="build_server"`；旧自定义入口清空环境后直接运行 Ninja，没有建立合法服务器上下文。
- artifact 和 generic after 源码证明均为空，不能导出这次失败的候选 APK。
- 原构建盘正常 unmount／detach、VM 正常停止、只读配置恢复和锁释放已有记录；只读诊断 `604` 保留原失败，不把诊断成功写成构建成功。

失败 outcome 文件摘要：`eae4155a29bfcb8dba576bdd6385280f247c9cf852224c457af6ed55e0d668a4`。

请求规范化摘要：`95a660c3ff35709852fc733725ad2439155e2635e3ed94e7bce5eeb07041f32e`。

### 3.2 已有真实组件结果

本机只读组件记录 `626` 实际运行了官方 build server 和真实任务：

| 场景 | Ninja 初始退出 | 官方异步任务结果 | 验收结果 |
| --- | --- | --- | --- |
| 原静态依赖校验 | `0` | `FINISHED`，实际退出 `0` | 组件通过 |
| 输出警告但退出 0 | `0` | `FAILED`，实际退出 `0` | 正确拒绝，不能把 Ninja0 当成功 |
| 非零任务 | `0` | `FAILED`，实际退出 `3` | 正确拒绝 |

各场景服务器实际正常 wait 为 `0`，组件清理和观测失败列表为空；固定公共源码的 owned 副本执行前后读回，原构建盘没有被这次只读组件改写。

新机必须保留这个因果边界：

- 在清空环境之后建立正确的 autoninja／官方 build-server 上下文、真实注册输出和当前 build ID。
- 不给父构建设置 `INVOKED_BY_BUILD_SERVER` 以跳过异步校验，不用不存在的输出文件触发同步 fallback。
- 不替换官方 Task 的执行、communicate、wait 或完成状态判定。
- Ninja0、pending0、心跳或官方宽松 wait0，任何一个单独存在都不能证明全部任务成功。
- 验证当前 owned server／当前请求下每个任务的真实完成与退出状态；失败／终止／替换均拒绝，正常 stop／wait 后才进入 APK 验收。

本机 Java `build_utils.py` 当前公开适配源码摘要为 `97c7eb486b848adafd013f5d2efd3a5c10a38844e3513867bcf1ac429570ea6a`，大小 14,018 B。它只针对受控的 JVM 启动提示及空行布局，仍保留原始流并拒绝实际 warning／error／非零退出。不要全局过滤 stderr、取消 `-Xint` 或关闭 warnings-as-errors 来制造通过。该适配尚未作为新机可直接应用的构建补丁收入本仓库。

### 3.3 最新主入口只准备完成，没有执行

本机最新主入口标识为 `633b`，组合 `core619 / server620 / source-copier624 / history630c / Java-reuse631 / admission632`：

- 正确绑定新的七源请求和 descriptor，不冒名执行旧 508。
- 保留原 Canvas／GN／source／graph／artifact／存储／deadline／lease／正常清理检查。
- 原 Java 当前源码与旧备份做完整只读复用，不再进入源码替换 writer。
- 两个固定公共 server 输入从已观察的只读来源取得数据，创建新 owned 层、封只读，再做两个明确的只读执行叶绑定；不更改原源文件归属或放宽执行 UID 检查。
- 必须等待所有异步校验真实成功且服务器正常退出，再允许 artifact 检查。
- core 有 14 项定向 metadata 检查及有效完成检查删除反例；主调用方有 15 项检查及只读、源码替换、旧验证器三个有效反例。**这些是合同／组件检查，不是主构建或挂载布局已经实际运行的证据。**

`633b` 没有新完整构建请求、最终 outcome 或 APK。原来针对失败 590 的 success／export 入口不能借给未来的新请求；新成功／导出验证必须绑定新源码、实际请求和最终 outcome。

## 4. 本机专用材料边界：没有随 Git 推送

以下是便于移交者在本地定位的**文件名和内容摘要**，不是仓库内路径，也不是建议在新机直接执行的命令。本文不公开本机目录索引、绝对主目录、设备身份、进程号或原始日志正文。

| 本机材料 | SHA-256 | 含义／限制 |
| --- | --- | --- |
| `run-arm-continuation-633b.py` | `ef1084724977e82706c38d725a5c21bbc0c93d37a13efe564c01307fd56dbed6` | 本机主控制器，绑定 Lima／APFS／旧盘／路径；不可原样移植 |
| `guest-arm-continuation-633b.py` | `634418a126d1260ed9ee121a5d05575086957d1d38fca08dba97999294604f1f` | 已准备的 guest 调用方；没有完整执行 |
| `owned-build-server-620.py` | `edb361bad1552c4a52753210451fd67d7f33dc33d3333db25149e369ee817c5b` | 官方 server 所有权、逐任务状态与真实退出观察；含原环境约束 |
| `owned-server-source-copies-624.py` | `9f4e1e53c630b8d026c2ea30f4bf66d7fbc106369584bb7d273e2f38444eea79` | 只允许两个固定公共文件的完整读回与 missing-only owned 副本 |
| `java-source-reuse-admission-631.py` | `4988c10cc7b56015dd24b7f3c0e19364d5a8d0fb5c8ac618b46928d770e9d422` | 当前 Java 源码／旧备份的只读完整复用合同 |
| `build-server-probe626-outcome.json` | `59aab31329b28eb071997825aa0a2ab2fff56e7f176f1c632aed43d58937d48d` | 真实只读组件结果；不是 APK／runtime permit |
| `main634-host-verification.json` | `ed84acd22bab5936138a4e0db4dcef2db0a6f93fd58be307b6eea1cb221b11c2` | 主入口合同／反例结果；不是完整 Native 构建 |

**本次 Git 交接不包含这些文件的内容，也没有一个隐藏的“补充包”已经上传。**若新机要复用本机最新构建适配，必须另外按明确 allowlist 导出公开差分／工具源、审查并重新绑定新机约束；只拿本文的摘要无法复原文件。

不要复制整个本机构建控制目录、整个 `.claude`、整机路径索引、VM 原盘或增量缓存来代替交接。旧脚本包含本机专用 UID／mount／raw identity／绝对路径假设；新机必须验证自己的实际身份，不能通过放宽检查让旧值“通过”。源码／工具链／依赖的完整输入仍须独立准备；旧对象和 Ninja 缓存的跨机器可复用性未获保证。

## 5. 新机器建议与源码／工具链锁定

优先建议 **Linux x86-64**，32 GiB 以上内存、64 GiB 更稳，使用有充分余量的专用 NVMe 工作目录。完整峰值包含源码、依赖、输出、链接临时文件、缓存和证据；目标机操作者应重新确认预算和保留空间。不要把上游 100 GB 最低参考或本机旧额度当成足够的已验证峰值。

**host=x86_64 与 target=Android arm64 不矛盾；APK 仍应为 ARM64。**这条路线避免原 Mac＋ARM VM＋Rosetta 的 host-tool 翻译，但不保证现有缓存可直接续用，也没有已测出包 ETA。

锁定并实际核对：

| 项目 | 当前声明／冻结参考 |
| --- | --- |
| Chromium | `152.0.7977.72`，声明上游 `026bb13a93d60e7adfefa2bbf58d6f57c2d335cc`；不能仅凭 stamp／synthetic commit 声称完整同源 |
| 受管补丁 | 顺序链至 0058，使用仓库 manifest 校验，不覆盖已有编号 |
| 0058 文件摘要 | `39ac1d00d6017247088381d0fc0fccceff230a700ddb525fcec41f65fd2904f7` |
| 受管最终源码 manifest 文件摘要 | `d0b56d0fed7913fd7ee746cf029d62a597a805013801df3dfc2cb5f44c40cee2` |
| 原生 Android 工具链 | 按该 Chromium DEPS 准备匹配 host JDK／NDK／SDK；当前 native 使用 SDK／build-tools 37 |
| Gradle WebView 原型 | Java 17 源级别、Gradle 8.9、AGP 8.7.3、SDK／build-tools 35；不是 native 工具链 |

不要使用桌面 `args.gn`／`chrome` target 或旧 WebView APK 冒充 Android native 构建。Android 源码还没有完整产品依赖闭包的最终验收证明；新机必须核对实际 checkout、依赖、补丁应用状态与最终受管文件字节。

### 验证壳与产品是两个目标

| 项目 | 时区验证壳 | 原生产品适配 |
| --- | --- | --- |
| GN target | `//content/shell/android:agent_browser_timezone_apk` | `//content/shell/android:agent_browser_product_apk` |
| APK | `AgentBrowserNativeTimezone.apk` | `AgentBrowserProduct.apk` |
| package | `com.ahoo.abs.android.native_timezone.preview` | `com.ahoo.abs.android.native_product.preview` |
| native library | `lib/arm64-v8a/libcontent_shell_content_view.so` | `libagent_browser_product.so`，仍须实际构建与核验 |
| 状态 | 尚未完成整包／安装／realm 验收 | 源码／overlay 有，真实图与 native 构建尚未执行 |

验证壳预期 launcher 为 `org.chromium.content_shell_apk.AgentBrowserTimezoneActivity`。纽约 fixture 资产需按 0057 核对精确字节，不能额外补换行。壳的固定输入、包名与输出不构成 Product 已集成的证明。

以下只记录本机已审查验证壳的 GN 配置，**不是经过新机器验证的完整 recipe**：

```gn
target_os = "android"
target_cpu = "arm64"
is_debug = false
is_official_build = false
is_component_build = false
symbol_level = 0
v8_enable_i18n_support = true
agent_browser_timezone_fixture = "new-york"
use_siso = false
use_remoteexec = false
concurrent_links = 1
android_static_analysis = "build_server"
```

原构建还固定 `JAVA_TOOL_OPTIONS=-Xint`、Ninja `-j3`，保留 CFI／ThinLTO／warnings-as-errors 和完整源／图／签名／存储检查。若新环境需要改变工具链或配置，先形成新的明确输入和审查／验证；不要为加速或“过编译”静默取消这些检查。本机原 4 CPU／8 GiB VM、180 GiB aggregate／其中 16 GiB ARM、3 小时停止上限不是新机器的自动授权或 ETA。

## 6. 新机接手顺序

### A. 先做只读环境与目录准入

由目标机操作者明确选择专用 `WORK_ROOT` 和存储／资源预算，再检查操作系统、架构、CPU、内存、空间和工具版本。不先下载依赖、拉容器、运行 hooks 或编译，也不清理已有工作目录。

```sh
set -eu
: "${WORK_ROOT:?Set an explicitly approved existing work directory}"
test -d "$WORK_ROOT"
uname -s
uname -m
getconf _NPROCESSORS_ONLN
free -h
df -h "$WORK_ROOT"
python3 --version
git --version
```

### B. 取得完整交接提交

不要只拷贝 `mobile/android/`，否则会遗漏 Chromium 补丁、共享协议和文档。使用已配置的授权凭据，禁止把 token／密码写进 URL 或命令历史。

在已有目录／预算准入通过后，下面的 clone 例子仅适用于 `source` 尚不存在的情况；已有 checkout 应先检查，不执行 reset／clean／覆盖 checkout。

```sh
set -eu
: "${WORK_ROOT:?Set the approved work directory first}"
test -d "$WORK_ROOT"
test ! -e "$WORK_ROOT/source"
test ! -L "$WORK_ROOT/source"
git clone --single-branch --branch feat/android-resume-20261027 \
  https://github.com/edgora-ai/agent-browser-studio.git "$WORK_ROOT/source"
git -C "$WORK_ROOT/source" status --short --branch
git -C "$WORK_ROOT/source" rev-parse HEAD
git -C "$WORK_ROOT/source" merge-base --is-ancestor \
  81eddd0b971d7d52fd8672ed66f6be2315e0c424 HEAD
```

最后一条只证明包含已知源码祖先。**仍须将实际 HEAD 与移交完成回执给出的、包含本文的最终提交逐字比较**，不能把祖先检查或分支名称当成精确源码身份。远端不可用时可另行准备并校验 Git bundle；本次没有预先生成 bundle。

### C. 恢复可移植的构建输入，再编译

1. 准备并核对匹配的 Chromium／DEPS／host tools，依规则验证和应用完整补丁链；不借用另一台机器的 device／mount／缓存身份。
2. 先解决当前公开构建适配的移交／移植缺口：Java 启动提示处理和真实异步 build-server 完成门禁必须有明确源码；不能只复用本机收据摘要。
3. 在新目录内重新建立 source／graph／GN args／artifact／资源合同及实际编译入口；本次还没有交付这样的新机入口。
4. 按已审查配置运行 GN／完整 Ninja，保留实际退出、失败动作和源码前后摘要；源码变动或缺失证明即拒绝，不拿旧组件记录补成功。
5. 若继续原生产品开发，单独 stage／review Product overlay、完整选源和图，再编译它；不得把 Product 偷塞入冻结验证壳的活动 source／out。

主机 Java／Node／SQLite／构建工具回归按 [Android README](../../mobile/android/README.md) 的实际入口与新机已准入测试根运行。不要为了本文提交运行仓库通用 `npm test`／`pretest`／clean／license 注入／native rebuild；不要在另一台机器复用旧测试目录的配额声明。

### D. APK 与运行验收独立进行

- [ ] 完整 GN／Ninja 成功，所有异步任务真实成功，owned server 实际正常退出，源码／图／工具输入前后相符。
- [ ] 生成新成功／导出记录，绑定实际新源码、请求、最终 outcome 与 APK 全字节 SHA-256；不得使用旧 590 的固定成功门禁。
- [ ] 用匹配 SDK37 核验签名／证书、package、launcher、唯一目标 ARM64 ELF、JNI／资源及精确 fixture 资产。
- [ ] 构建环境正常退出后，另行准入隔离运行环境；不与 Native／其他 VM 并跑 SDK／ADB／AVD 验收。
- [ ] 只安装到本次拥有且 serial／私有 ADB 归属明确的隔离模拟器；安装后拉回实际 base APK，fsync／重开／完整 hash 比对。
- [ ] 验证 Java claim／native freeze／实际浏览进程亲缘，实测 Window、顺序 Dedicated Workers 及计划内其他 realm；未支持项明确列出。
- [ ] 配置存储执行写入 → 直接查 SQLite → 关闭重开读回 → 检索；网站存储分清正常退出、崩溃／强停／断电、不同存储类型的真实覆盖。
- [ ] 本地原生行为正确后，才使用明确授权的测试网络验证 `ping0.cc/env`，保留此次 APK 的页面／网络限制和真实截图，不沿用旧 52 分或改评分脚本。

## 7. 安全、保留与回传要求

只交付源码、公开构建输入和脱敏技术结果。不读、提交、上传或复制真实私钥、token、激活码、代理凭据、Cookie、vault、用户数据库、设备标识或正式签名材料；开发 keystore 也不进 Git。桌面正式发行公钥／商业授权保持原状，不生成替代 issuer、不重置 trial。

不修改 TLS／sandbox／TCC／ACL／Gatekeeper／系统时区或共享代理来让测试通过，不访问真实业务账号，不停止未知浏览器／ADB／设备或他人作业。403／429 不等于指纹识别证据，代理连接失败也不能直接归因认证。

保留原失败和 partial／cleanup-unverified。旧 559 final-clean 失败原因仍 unknown；后来的正常清理不倒推其成功。不能 repair／fsck／replay／RW remount／格式化旧盘来清除失败，也不按年龄删除旧产物。

新机最终回传：精确 Git HEAD、Chromium／补丁／工具链／GN 输入身份、实际运行命令与退出、峰值／预算、APK hash／签名／ABI／资产、安装 pull 一致性、native／realm／存储结果、此次 Ping0 结果及所有未覆盖项。源码检查、metadata 模型、真实组件、完整 APK、实际 App 运行必须分层报告。

**当前可交接的是已保存的开发源码与明确的未完工作，不是一个已通过生产验收的 Android 版本。**
