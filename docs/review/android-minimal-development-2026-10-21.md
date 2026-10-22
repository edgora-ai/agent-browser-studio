# Android 极简环境浏览器：开发与分层验证记录

日期：2026-10-21  
分支：`feat/android-minimal-browser-20261021`  
调研：[`mobile-fingerprint-browser-research-2026-10-21.md`](mobile-fingerprint-browser-research-2026-10-21.md)  
工程：[`../../mobile/android/README.md`](../../mobile/android/README.md)

## 1. 当前结论

**已经生成并核验内部开发 APK，但完整 Android 产品尚未完成。普通网页浏览和 Ping0 入口仍被完整准入门禁阻止。**

当前工程使用 Android System WebView，不是重新编译的 Android Chrome/Chromium 指纹内核。编译、host 单测、打包内容核验不能证明 WebView 的原生时区/语言传播、真实代理路由、机型模拟、网站存储持久性或 Ping0 检测通过。不能仅将缺证状态改为成功来开放浏览。

本轮没有安装 APK、连接 adb、创建/运行模拟器、操作真实手机、访问 Ping0 或真实账户，也没有修改桌面应用、既有正式授权或真实浏览器数据。iOS 只有调研记录，没有本轮实现。

## 2. 已实现的源码范围

首版保持三个界面：环境列表、环境配置、浏览/验证页，不引入桌面端的 AI、团队、同步、批量或 REST/MCP 功能。

- 环境配置：代理协议/主机/端口、凭据变更、国家、时区、有序语言标签、原生或声明设备模式。
- 配置持久化：私有 SQLite/WAL、不可变 revision、显式 CAS、稳定目录 suffix、一次性冻结启动票据；凭据使用 AndroidKeyStore 非导出 AES-GCM 句柄方案，无明文降级。Android 库与 KeyStore 的实际执行仍未验证。
- 单活动环境：主进程禁用 WebView；专用 `:browser` 进程在 provider 初始化前 claim 启动票据并绑定独立目录，需要新的同 UID 控制器激活。
- 生命周期：session/incarnation/PID 绑定的 IPC、进程生命周期锁及退出核对。关闭 Activity、收到 drain 回执、Cookie flush 返回或超时均不等同进程已经退出。
- 本地原生身份采样：主页面、同源/跨源 iframe、Dedicated Worker、SharedWorker、Service Worker 六类 realm；严格检查来源、challenge、请求身份、类型与截止时间，不修改 Date/Intl/Navigator 原型。
- 地区建议：用户明确点击才通过配置的无认证 HTTP 代理请求 GeoIP，严格解析响应，拒绝迟到覆盖配置。建议结果不是 WebView 路由证明；真实 provider/代理兼容性未测。
- Android instrumentation 源码：只使用新 UUID 范围及新的合成数据库，包含直接 SQLite 查询、关闭/重开/检索和启动授权反例。测试 APK 已构建，**没有执行**。

## 3. 本轮修复的控制竞态

1. 停止时读取 `PUBLISHED` 后子进程抢先 claim：改成事务性 `requestStop()`，保存停止意图并返回最新绑定，不能按旧快照撤销失败后丢失停止请求。
2. rejected process 自退出前仍保持 `BIND_AUTO_CREATE`：先解除自动重建绑定，再发给精确 incarnation 的自退出请求。
3. 旧退出轮询或 ServiceConnection 回调影响新环境：按 session 和操作代次绑定轮询，为每次 bind 创建新的 owner-session 连接，拒绝迟到回调。

已添加实际 host SQLite 顺序反例、静态源码守卫并复核源码。它们不是 Android Binder/系统回收场景已经运行的证明。

另修复了 WebView 生命周期重入、Activity context 释放、代理/身份检查迟到回调、drain 期间流量准入、observer 归属及 SQLite Lint 错误。

## 4. 冻结输入与构建

构建工具：Java 17、Gradle 8.9、AGP 8.7.3、AndroidX WebKit 1.12.1、compile/target SDK 35、Build-tools 35.0.0。Manifest 声明 minSdk 29；不代表 Android 29–35 都已实测。

最终构建输入摘要：

```text
0203b40046edd854b5ead6bc66a4006833ca27fb63f2a031fe2fa40bc48af692
```

摘要覆盖构建 runner 记录的 84 个源码/构建/测试输入；Markdown 报告不在此编译输入集合内。`build-0006.result.json` 保存逐文件大小与 SHA-256。最终 host 复验前后再次计算输入清单，与该次构建完全一致。

实际任务：

```sh
python3 -B mobile/android/tools/build.py \
  --state-root "$ABS_ANDROID_STATE_ROOT" \
  --gradle "$ABS_GRADLE_BIN" \
  --sdk "$ANDROID_SDK_ROOT" \
  --java-home "$JAVA_HOME" \
  --read-only-cache "$ABS_GRADLE_RO_CACHE" \
  --host-volume "$ABS_HOST_VOLUME" \
  --storage-check "$ABS_STORAGE_CHECK" \
  :core:contractTest :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug
```

实际输出与回执字段：

```text
TOTAL 154 PASS 154 FAIL 0
BUILD SUCCESSFUL in 17s
exitCode: 0
sourceUnchanged: true
ownedProcessGroupRemaining: []
networkDependenciesAllowed: false
deviceActions: false
```

最终构建是 offline；没有下载完整 Chromium、自动安装 SDK 或调用设备任务。生产/release variant 禁用，移动商业授权和正式发行签名未接入，不能作为正式商业版本发布。

## 5. 分层验证结果

| 层级 | 实际结果 | 不证明的内容 |
| --- | --- | --- |
| Java 核心契约 | 154/154；最终 Gradle 同时执行 | 不执行 Android API/WebView |
| Node/VM 探针 | 75/75；最终复验 205.519125 ms | 合成 realm，不是真实浏览器 |
| host SQLite + 静态合同 | 50/50；最终复验 1.321 s | 不是 Android SQLiteOpenHelper/KeyStore 或网站数据 |
| 构建守卫 | 9/9；最终复验 0.054 s | 只含自有 host 子进程，不证明 Android 退出 |
| Android 编译与 Lint | app/test APK 均生成；0 errors、8 warnings | 不证明安装、运行、UI 或所有 API 版本兼容 |
| APK 静态核验 | 两个签名及 ZIP CRC 通过；16 项原始 asset 字节一致 | 不证明设备安装或网络/身份行为 |
| Android instrumentation | 仅构建 | **NOT_RUN** |
| WebView/Ping0 实站 | 未运行 | **NOT_RUN** |

host 复验命令：

```sh
NODE_DISABLE_COMPILE_CACHE=1 NODE_OPTIONS= \
  node --test mobile/android/probe-tests/*.test.cjs
ABS_STORAGE_TEST_ROOT="$ABS_ANDROID_STATE_ROOT/tests/storage" \
  python3 -B mobile/android/storage-tests/run_contract_tests.py
ABS_ANDROID_STATE_ROOT="$ABS_ANDROID_STATE_ROOT" \
  python3 -B mobile/android/tool-tests/test_build.py
```

SQLite suite 执行原始 schema，实际写入、直接查询 SQLite/WAL、关闭重开并按 ID/名称检索；不只检查返回值。原始失败断言和拒绝分支保留，未使用真实凭据或替换 Android 后端来使测试通过。

Lint 的 8 个 warning 原样保留：4 个 API 33 SQLite 常量内联提示、2 个 feature guard 识别提示、1 个动态 locale/app bundle 提示、1 个浏览器启用 JavaScript 提示。没有新增 baseline 或关闭检查，也不将 warning 描述成零。

## 6. APK 身份及编译 Manifest

| 工件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `app-debug.apk` | 3,417,419 | `7208c5a7b620d651283aa9d9abf4a03742a2eeff2f40b4b2e66000965d708d47` |
| `app-debug-androidTest.apk` | 16,606 | `c59009fa36b229c16375152c5f21d3d761dd14484af12a6a0eb366be02e87c82` |

应用 ID：`com.ahoo.abs.android.preview.debug`；版本 `0.1.0-dev-internal`。两个 APK 的 `apksigner verify` 均 exit 0、v2 签名通过，且使用相同的新隔离开发证书，不是桌面正式 issuer 或生产发布证书。私钥未读取、打印或放入 Git/应用资源。

已从最终 APK 的编译 Manifest 输出核对：

- `BrowserApplication` 为实际 Application；内部包 `debuggable=true`。
- 仅 `MainActivity` 导出，只有 MAIN/LAUNCHER intent filter。
- `BrowserActivity`、`BrowserControlService` 均 `exported=false`、`process=:browser`，没有额外 Provider。
- `allowBackup=false`、`fullBackupContent=false`、`usesCleartextTraffic=false`。
- 只有 `INTERNET` 与 `ACCESS_NETWORK_STATE` 两项 uses-permission。

15 个身份探针 asset 加原始 schema SQL 共 16 项，已从 APK 实际读回并逐字节与冻结源码比对。没有为了核验复制第二份大 APK。

## 7. 失败账本

失败证据保留，不通过清理、覆盖旧记录或重置预算掩盖：

- 首次 Gradle `help` 本身成功，但 runner 遍历被原子 rename 的 transform 目录时失败；不能算完整构建通过。已细分 ENOENT 与真实 I/O 错误，并增加进程身份回执及守卫测试。
- Locale 反例发现 Java API 接受重复 variant/extension singleton；已补显式校验，故意失败模式实际返回非零。
- `build-0005` 因 4 个 SQLite Lint 错误失败；原报告 `lint-0005-failed.txt` 保留，修正后 `build-0006` 为 0 errors/8 warnings。
- 首次验包脚本期待 `sdkVersion`，而实际 aapt2 字段是 `minSdkVersion`，导致脚本拒绝。原脚本/日志保留；v2 使用实际字段并增加 minSdk 反例，重新执行全部验包通过。不是 APK 自身失败。

## 8. 产品未完成项与后续门槛

以下不只是“再安装一次”：

1. WebView 代理用户名/密码的安全挑战绑定尚未实现；不能用网站 HTTP-auth 回调冒充可信代理认证。
2. DNS、IPv6、WebRTC、UDP 及失败闭合的完整出网约束尚未实现/验证。
3. 任意 Android 机型/硬件元组模拟尚未实现；声明其他机型被明确阻止，不能静默替换为本机模式。
4. 原生默认时区/语言在所有必需 realm 的真实传播、网络头及实际出口尚未验证。
5. A→B→A、冷启动、系统回收及 Cookie/LocalStorage/IndexedDB/Cache/SW 持久性尚未验证；Cookie flush 不作为全存储提交屏障。
6. 实际代理兼容、凭据错误、断开/切网、GeoIP 服务生产条款、Android UI 和 Ping0 尚未验收。
7. 移动端正式授权、发行签名和发布渠道未整合。

现有单一任务根 cap 为 1 GiB，开发卷留 6 GiB、宿主留 10 GiB。最终 host 复验记录 root 占用 291,603,129 B，开发卷可用 7,365,021,696 B，扣除保留空间仅约 0.86 GiB。公共 API 35 镜像需要初始化 userdata seed/overlay，未核实出符合现有限额和隔离条件的可控写入上界。因此没有擅自创建模拟器、扩大预算/卷、回退内部盘或连接现有设备。

下一阶段必须先有明确获批的独立运行空间或指定的自有专用测试设备，再执行真实 Android 能力探针与数据流验收。若公开 WebView 能力实测不满足要求，应进入自有 Chromium/native 方案评估，而不是降低验证标准或加入 JS 伪装。

## 9. 证据与交付状态

本地登记任务根保留以下相对路径证据；本报告不包含签名材料、本机私有索引或真实账户信息：

- `logs/build-0006.result.json`、`logs/build-0006.log`。
- `host-final-0006.json`、`logs/host-final-0006-{probe,storage,tools}.log`。
- `apk-verification-0006-v2.json`、`logs/apk-0006-v2-*-{signature,badging,manifest}.txt`。
- `build/app/intermediates/lint_intermediate_text_report/debug/lintReportDebug/lint-results-debug.txt`。
- 原始失败日志与 runner invocation receipts。

本轮源码和报告尚未提交/推送，APK 未安装、上传或发布。完整开发与 Android/Ping0 验收任务保持未完成；本记录只固化已核验的内部开发里程碑。
