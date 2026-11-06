# Android 原生时区验证链：源码与独立审查（2026-10-27）

## 结论

按用户“先开发完，review 没有问题再编译安装”的顺序，本轮完成了**最小自包含 content-shell 时区验证壳的源码与独立审查**。原生接入和只读验收工具分别由非作者独立审查，未发现已确认的阻塞问题；集成时发现的验收年份不一致已修正并再次独立复核。

**没有执行 C++/Java/Chromium/Gradle 编译，没有安装 APK、启动模拟器或浏览器，也没有新的 Ping0 分数。** 源码审查不保证编译、链接或运行必然通过；后续必须用匹配 Linux 工具链及精确输入实际验证。

这不是整个 Android 产品开发完成。现有产品 App 仍使用 System WebView；新内核是另一个内部验证 APK，不是假接入现有 UI，也没有放开普通浏览门禁。

## 1. 本轮实现

新增顺序补丁：

```text
0057-android-frozen-native-timezone.patch
SHA-256 725b79cd20457bfe0634e7029ffbe3d4a317ad00fbcb369290d4af15a0c59fdf
```

- 独立 Android 配置类，只接受 `timezone-only` 或显式 `native-control`。
- 严格规范化 base64url/JSON、schema、UUIDv4 profile/launch 身份、大小限制及 ICU system/IANA 时区校验；缺失 required payload、矛盾别名、混入桌面字段或无效输入拒绝启动。
- 只从 APK 自有只读 asset 安装配置，在父 Application 首次 LibraryLoader 操作之前冻结 argv；每新浏览进程生成新的 launch UUID。Activity 重建不重新配置，初始和迟到 Intent 均不能注入命令行。
- 基于固定合成 profile 的稳定私有目录后缀；这里只完成源码合同，不把它当已观察的原生存储隔离或持久性。
- Shell browser 明确向 renderer 转发必要参数，不复制到 GPU/utility/network 进程。
- Blink 初始化在早返回前应用原生 ICU/V8 时区；失败拒绝，使用 `kSkip`，宿主通知不能撤销冻结值，冻结模式拒绝可变 clear/change 路径。
- Java/native 分别输出有界输入 SHA-256 与精确 PID 回执。摘要只绑定本次输入，不代替 Date/Intl 采样或进程归属证明。
- 新增 10 项 C++ parser test 和 2 项原生 browser test 源码；后者调用实际 Shell 转发方法并读取 Window/重建 DedicatedWorker 原生 Date/Intl。**这些 C++ 测试未编译、未执行。**
- 新增只读实验 fixture，覆盖 main/same/cross frame 的 classic/module、nested/recreated DedicatedWorker、SharedWorker 重连和独占 scope 的 classic/module ServiceWorker。未支持、超时、丢失回执及缺失生命周期证据不计 PASS。

准确 GN target：

```text
//content/shell/android:agent_browser_timezone_apk
```

预计应用 ID 为 `com.ahoo.abs.android.native_timezone.preview`，并非原 WebView App 的包。协议、参数、限制及后续 Linux 构建说明见 [ANDROID_TIMEZONE.md](../../patches/chromium/ANDROID_TIMEZONE.md)。

## 2. 独立 review 与修正

### 原生接入

独立 reviewer 核对补丁、源码约束测试、两个 manifest 及选定 17 份最终源码的身份；未发现已确认的 blocking finding。未执行编译、链接、APK 启动或真实子进程验证。

### 验收 fixture

另一位非作者 reviewer 完整读取 11 个新文件，核对只读采样、frame 消息归属、module 证明、SW scope/晚到清理、失败汇总与有界 HTTP 路由；未发现已确认的 blocking finding。review 中实际执行的初版纯 host 测试为 13/13，但不把该旧结果借给后续日期修正。

### 集成年份修正

主代理对照原生测试和服务器矩阵，发现 fixture 使用 2024，而任务要求 2026。先固定 2026 断言，保留纯 Node 12/13、源码约束 21/22 的 RED，再统一 probe、model、测试与 README：

| 输入 | Unix epoch 毫秒 |
| --- | --- |
| 2026-01-15T12:00:00.000Z | 1768478400000 |
| 2026-07-15T12:00:00.000Z | 1784116800000 |

独立 reviewer 再次定点复核这四个文件，并用纯 host UTC round-trip 核实两个 epoch；未发现新增阻塞。随后主代理对修正后的同一源码完整重跑下面的 host/source 测试。

这些 RED/GREEN 均为**源码/oracle 约束**，不是未修复/已修复 Android 浏览器的真实运行对照。

## 3. 实际执行的验证

```sh
node node_modules/vitest/vitest.mjs run \
  tests/unit/chromium-android-timezone-source.test.ts \
  tests/unit/chromium-native-cpu-metadata-source.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

实际输出：

```text
Test Files  2 passed (2)
Tests       27 passed (27)
```

```sh
node --test mobile/android/native-kernel-tests/fixture.test.mjs
```

实际输出：

```text
tests 13
pass 13
fail 0
skipped 0
```

另已执行：

- 7 个 JS/MJS 文件的 `node --check`，全部 exit 0；只做语法检查，没有执行页面或启动服务器。
- 0057 在仅选定文件的小型 scratch 中真实 `git apply --check`、应用及 17 份最终字节核对通过；原完整 Chromium 源树未写入。
- `PATCHSET.sha256` 精确 60 项输入清单与实际 bytes 全部匹配，无缺项或重复项；已发布 `0002`–`0056` 和两个原始 payload 保持不变。
- `PATCHED_SOURCE.sha256` 摘要为 `e6651100b2803c2d21b1ada6a22f5b98819be8b7ef3650d70199ff0593019fa4`。
- `git diff --check` 通过；新增内容均为普通 UTF-8 文本，未发现所检查的私钥/GitHub/AWS 标记。此扫描不是“所有秘密绝对不存在”的证明。
- 原产品 `app/`、`core/`、`tools/` 的 71 个已跟踪文件与 HEAD 字节一致。新增 fixture 后 `source_inventory` 为 96 文件、`38d579faf530bdf38a934793ecdecdba18470bddeb34dbe1dcab6bf0bbe71c33`；这不是新构建物，也不是完整 Chromium 输入身份。
- 原未跟踪桌面 WIP 测试与历史 SHA-256 一致；旧发行目录仍存在且仅本机忽略，没有混入本轮改动或删除。

本机登记证据保留初版、日期 RED、最终 GREEN 及输入摘要；没有重置旧存储测试额度、覆盖失败、扩容、复制完整内核或更改全局临时目录。

## 4. 明确未执行与未完成

| 项目 | 状态 |
| --- | --- |
| Linux GN 目标解析、依赖闭包、C++/Java 编译链接 | NOT_RUN |
| 新 APK 签名/安装及安装后全字节回读 | NOT_RUN |
| 真正 renderer argv、Window/frame/Worker 首段 Date/Intl | NOT_RUN |
| HTTP fixture 实际 delivery、module 支持、SW 注册/注销 | NOT_RUN |
| SW/SharedWorker 受控冷启动、浏览器重启、后台恢复、宿主通知 | NOT_RUN |
| 新内核原生存储直接查询、读回、检索与持久性 | NOT_RUN |
| Ping0/CreepJS、新评分与全部网络/硬件一致性 | NOT_RUN |
| 原宿主 SQLite 全套因 64 MiB 保留额度耗尽的复跑 | 仍未通过，未重跑或改绿 |

content-shell 原生测试壳 UA/UA-CH 不等于生产 Android Chrome 身份。CPU/内存/SwiftShader、RAF、DNS、代理认证与 UDP/WebRTC enforcement 不因本轮源码而解决。不使用改字符串、JS shim、改系统时区或改评分来消除真实模拟器信号。

## 5. Git 与后续顺序

本轮结束时仍在 `feat/android-resume-20261027`，HEAD 为此前已交接的 `0906488e5f35d61b7b3c0972f65d4730bbe97783`。**本轮新补丁、fixture 与报告尚未提交或推送**；没有合并 main、发布 APK 或修改桌面发行包。服务器不能拿旧检查点当作包含 0057 的修复版。

后续须先形成精确的新源码交接身份，在匹配、明确准入的 Linux 构建环境验证上述目标，再安装到明确拥有的隔离 Android 环境并实际读取原生值；失败保留，不能把本报告的 source/host 绿色结果代替 native GREEN。服务器任务见 [交接说明](android-native-kernel-server-task-2026-10-27.md)。
