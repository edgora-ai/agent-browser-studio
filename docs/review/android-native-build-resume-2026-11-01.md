# Android 原生构建续编状态（2026-11-01，新机 192.168.4.12）

本文记录 2026-10-31 交接文档之后的实际续编进展。先读结论：

**源码与构建流水线已在新机就位并自动推进；尚未产出 APK，没有任何验收结论。**
最后一次完整状态核对时刻，gclient sync（浅克隆模式、新代理节点）仍在收尾依赖，
phase 3（补丁链 + GN + 编译）由 supervisor 自动接力，未经人工确认前不得视为已开始。

## 1. 新机准入（2026-10-31 §6A 执行结果）

| 项目 | 实测值 |
| --- | --- |
| 机器 | 192.168.4.12，Ubuntu 22.04.5 LTS，内核 5.15.0-203 |
| 架构／CPU | x86_64，4 核（i5-6600K，与交接文档最低建议一致） |
| 内存 | 31 GiB（可用 ~25 GiB），swap 2 GiB |
| 磁盘 | `/` 287G，开工时可用 ~141G（按文档要求重估预算，非"100G 够用"） |
| KVM | `/dev/kvm` 存在，`kvm-ok` 通过 |
| 工具 | Python 3.10.12，git 2.50.1，ninja 系统包存在，Java 由 Chromium DEPS 提供 |
| WORK_ROOT | `/home/ahoo/abs-native-work`（新建专用目录，未触碰既有目录） |

## 2. 仓库交接（§6B 执行结果）

- 交接分支 `feat/android-resume-20261027` 已推送：`a36e6cc` → `4479062`。
- 新机 GitHub 直连不稳定（GnuTLS -110／超时交替），按文档回退方案走 **Git bundle 局域网传输**，
  clone 后核对 `HEAD = 4479062`，`81eddd0` 祖先检查通过，补丁链文件至 `0058` 齐全。
- 增量提交（`4479062`）随后以 bundle FETCH_HEAD + ff-only 方式同步。

## 3. 本轮新增入库：Java 启动提示构建适配（`4479062`）

交接文档 §3.2 的缺口（"该适配尚未作为新机可直接应用的构建补丁收入本仓库"）已关闭：

- 位置：`mobile/android/native-kernel/java-build-adaptation/`
- 内容：针对 `build/android/gyp/util/build_utils.py` 的 `_FailureFilter` 单点适配——
  冻结的 `JAVA_TOOL_OPTIONS=-Xint` 使每个 JVM 在 stderr 打印不可关闭的
  `Picked up JAVA_TOOL_OPTIONS` 提示，stock `CheckOutput` 会把任何非空 stderr 判为失败。
  适配仅丢弃该提示行；当提示出现过且剩余内容全为空白时视为空；其余一切行为
  （真实 warning／error／非零退出）逐字节保持上游。
- 身份锁定：上游 blob sha256 `bcd561c0…`（13,209 B）→ 适配结果 sha256 `0500be2f…`（13,954 B），
  应用脚本按 pinned 双向哈希逐字节验证、幂等、拒绝一切非 pinned 字节。
- 证据边界：15 项合同测试（含真实 `CheckOutput` 行为对比）本机全绿；这是**组件级证据**，
  不是 APK、完整构建或运行验收。它与机器本地的旧适配（`97c7eb48…`，14,018 B）实现同一契约，
  **不是**逐字节等价文件；后者从未进入 Git。
- 托管链影响：`0002`–`0058` 管理链不触碰该文件，`PATCHED_SOURCE.sha256` 不受影响。

## 4. Chromium 源码获取（§6C 执行结果）

网络实测决定路线（两台机器均为：googlesource/appspot 直连被封，仅 v2rayN 可达）：

| 目标 | 实测 | 采用路线 |
| --- | --- | --- |
| codeload.github.com | 新机直连 **9.2 MB/s** | src 主仓库 tar.gz 直连 |
| chromium.googlesource.com | 两机直连均阻断；v2rayN 单流 150→774 KB/s（11-01 换节点后） | git 走 `http://192.168.4.100:7890` |
| storage.googleapis.com | 直连为"IP 抽签"（7.2 MB/s 或 SYN-SENT 挂死） | 一律走代理（稳定优先） |
| ssh -D 隧道到 Mac | 出口仍走 Mac 直连，googlesource 同样阻断 | **废弃** |

- src：codeload `tar.gz/refs/tags/152.0.7977.72`（1.45 GB，
  sha256 `478c17ee1c0021b22b9ff184ee416b19b35a9e141b2da1b8206074947414a45f`，已记录于
  `fetch-evidence/archive.sha256`）。tag 身份用 `git ls-remote` 独立通道核对：
  `152.0.7977.72 → 026bb13a93d60e7adfefa2bbf58d6f57c2d335cc`，与声明上游一致。
- 播种：使用仓库自带 `seed-source-archive.sh`（codeload archive 是该脚本的支持场景），
  synthetic HEAD `3f1de50f…`，`.chromium-source-base-commit` = `026bb13a…`，
  `chrome/VERSION` 核对 MAJOR=152。后续字节级 provenance 由 `check.sh`／`apply.sh`
  的 archive 模式（补丁 marker + `PATCHED_SOURCE.sha256` 滚动清单）承担。
- 依赖：`gclient sync -D --jobs=8 --no-history`（浅克隆：构建不需要依赖仓库历史，
  大仓库传输窗口缩短以对冲代理长连接不稳）。

## 5. 流水线结构与自动恢复

```
supervisor.sh（flock 单实例；@reboot crontab 开机自恢复）
 └─ fetch-chromium2.sh   gclient sync 重试环 → install-build-deps → runhooks
     └─ phase3-build.sh  apply 0002–0058 → check.sh 逐字节验证 → Java 适配应用
                         → 冻结 GN 配置（见 §6）→ gn gen → pty 下 autoninja
```

- phase 3 的编译入口固定为 `script -qec "autoninja -C out/abs-timezone-newyork -j 3 …"`：
  Chromium 152 中 `android_static_analysis="build_server"` 经
  `build/android/gyp/util/server_utils.py` 要求 `AUTONINJA_BUILD_ID` 与
  `AUTONINJA_STDOUT_NAME`（由 autoninja + 真实 tty 提供）。裸 ninja 或无 tty 脚本
  环境都无法建立官方 build-server 上下文——这正是旧机 590 失败
  （`activity_state_java__validate_deps.bytecode.stamp` 缺 `AUTONINJA_BUILD_ID`）的根因。
  非 tty 时 `MaybeRunCommand` 静默回退内联校验，但按交接文档要求仍须走官方服务器路径。
- 证据落盘：`fetch-evidence/`（下载/播种/日志）、`build-evidence/`（构建日志）、`supervisor.log`。

## 6. 冻结 GN 配置（phase 3 将写入 `out/abs-timezone-newyork/args.gn`）

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

构建环境按原冻结配置保留 `JAVA_TOOL_OPTIONS=-Xint`（由 §3 适配使其可行）；
不得为加速取消 CFI／ThinLTO／warnings-as-errors 或改用其他 fixture 输出目录。

## 7. 过程事故与处置记录

| 事故 | 根因 | 处置 |
| --- | --- | --- |
| 11-01 03:45 整机重启 | unattended-upgrades 装内核后有序重启 | 装入 `@reboot` supervisor 自恢复；此后 10h+ 无再重启 |
| GCS 直连间歇挂死 | DNS 轮询到被封锁的 Google IP（SYN-SENT 悬挂） | 取消"GCS 直连"特例，全部 Google 域走代理 |
| gclient 连环 rc=1 | 多次中断叠加：conflicting-directory 隔离搬移被再次打断、angle/dawn 脏树、entries 缓存失效 | kill→**确认死透**→清理 `_gclient_*`/`bad_clones`/entries→`git reset --hard + clean` 脏仓库→浅克隆重启 |
| pkill 自匹配 | 模式串出现在自身命令行 | 一律"变量拼接模式"或按 PID 清单，kill 与重启分两条会话执行 |

## 8. 当前状态与下一步（2026-11-02 更新）

- **phase 2 实际进展**：`gclient sync` 已完成，`install-build-deps` rc=0；
  `runhooks` rc=2 失败，supervisor 判定未完成后退出，phase 3 未开始。
- **runhooks 失败根因（11-02 定位）**：vpython 构建 venv 时 pip 从 Google Artifact
  Registry（`us-python.pkg.dev`）下载 `aioquic` wheel（3.7 MB），实际字节 sha256 与索引
  声明不符（期望 `841ffbbf…`，实得 `50f3832c…`）——与 git 侧 `GnuTLS recv error`／
  `early EOF` 同源：代理节点对较长传输存在损坏／截断。
- **代理中断事故（11-02）**：v2rayN 进程整体消失（疑似被多日并发大流量压垮），
  自建 Mihomo 网关的内核亦已停止（仅剩控制面）。`open -a v2rayN` 重启后 7890 恢复，
  但回到慢节点档（~85 KB/s）；流水线 supervisor 已手动重启继续。
- **未开始**：APK 签名／包名／ABI／资产核验、模拟器安装读回、realm 时区矩阵、
  存储 SQLite 读回、ping0.cc/env。验收清单仍以
  [2026-10-31 交接文档 §6D](android-native-development-handoff-2026-10-31.md) 为准，
  本文不修改任何验收门槛。
- 已知风险：代理节点稳定性是当前唯一的外部瓶颈（数据损坏会让 pip 哈希校验、
  git pack 校验主动拒绝，重试是正确应对，不存在静默坏数据入库）；
  x86_64 host 跑 arm64 模拟器只能 TCG 软件模拟（无真机方案时较慢）；
  runhooks 需要在代理稳定的窗口内一次通过。

**本文只声明组件与流程状态。APK、运行验收、Ping0 均为 NOT_RUN。**
