# Android r13q 收口轮：按 profile 指纹真机闭环 + 双根因修复 + C2 破坏性验证（2026-11-14）

## 0. 先读结论

接手「真机就绪，完成所有问题收口和验证」与「不同 profile 的指纹不要搞成相同」指令。真机（OnePlus PKG110，Android 16，serial 69a2181d）一轮内完成：

1. **跨 profile 指纹差异化在真机闭环**：QA-Ping0-NY canvas=`ee365c40` vs QA-Isolation canvas=`adff2c18`，**逐字不同**；两环境 audio 哈希亦不同；同 profile 重载/跨退出重进/复现一致（种子确定性噪声）。用户核心指令达成。
2. **此前指纹差异化的实现从未生效**——真机实测当场暴露**双根因**并全部修复：
   - **RC1（解析缺失）**：`RoxyFingerprintConfig` 只解析 `agent-browser-fingerprint-config`（Android 上装的是**时区** payload，无 seed 字段）→ `seed_=0` → 噪声门关死。r13o 的 `agent-browser-noise-seeds` payload 只被 rev2 的 `HasSwitch` 门引用，**从未被解析**。此前模拟器轮的「EMU-FP-A canvas=5a2f111c」实为设备/密度不同的裸渲染差异，不是噪声。
   - **RC2（转发缺失）**：`ShellContentBrowserClient::AppendExtraCommandLineSwitches` 只向 Android 渲染进程转发 0057 的时区三开关；噪声消费端（canvas 读回 / WebAudio analyser / AudioBuffer）全在渲染进程，payload 根本到不了。r13p（rev3 修复解析后）audio 哈希变有限值（证明 payload 到达浏览器进程）而 canvas 仍为裸值 7d987d08，当场证实 RC2。
   - **修复 = 补丁 0061 rev4**（解析 + 专用门 + 渲染进程转发，pristine 基线链干净 diff，远端应用前后 5 文件 sha 全部验证）。
3. **ping0 真机 100 分 / 异常 0**（出口 204.0.23.126 NTT AS2914 与既往轮一致，IPv6 未检出）。
4. **媒体矩阵复核**：avc1/hevc/aac/mp3/opus/vorbis/wav 全 `probably`、wav 播放 PLAYING；gUM 仍 `NotSupportedError`（capture 服务栈缺口未变，独立工程轮）。
5. **C2-1 崩溃持久性通过**：全进程 SIGKILL（无清理路径）→ 冷启动 → cookie `qa=qa1`、localStorage `qa1` 全部存活。
6. **C2-2 整机重启通过**：reboot → 用户解锁 → 冷启动 → 种子 payload 逐字一致（确定性派生）、cookie `qa=qa1`、localStorage `qa1` 全部存活、canvas=`ee365c40` 与重启前一致（指纹跨重启稳定）、tz=America/New_York 生效。

## 1. 构建（r13p → r13q 两连发）

| 轮 | APK sha256 | 变更 | 结果 |
| --- | --- | --- | --- |
| r13p | `80cb5b6a…`（372,333,076 B） | 0061 rev3（RC1）+ Java payload 字符串 seed | audio 有限化 ✓，canvas 仍裸值 → 证实 RC2 |
| r13q | `9ffe1cde…`（372,333,076 B） | 0061 rev4（RC2 转发；无 Java 变更） | canvas/audio 噪声全部生效 ✓ |

- host 套件两轮均全绿：556 契约（含 7 项指纹断言）+ 133260 tile + 213 启动合同（日志 sha 入冻结回执）。
- 补丁链纪律：rev4 以 pristine 头文件为 diff 基线（本地用 git 里的 rev2 反推 pristine 并回环校验），远端序列 = rev3 回退 → rev4 应用，pre/post 5 文件 sha 逐一断言（remote-patch-receipt-q.json）。
- 契约测试用例无需改写：断言锚定变量名（canvasSeed/audioSeed），字符串 seed 保持同名。

### rev4 设计要点（为何不动 `enabled_`）

树内 35+ 个桌面消费点（UA/platform/fonts/plugins/webgl vendor 伪造等）由 `enabled()` 门控。Android 上若翻转 `enabled_`，空桌面字段会套到 Android 上（空 UA 灾难）。rev4 新增 `canvas_noise_active()/audio_noise_active()` 专用门，仅 canvas/audio 噪声消费点换用；桌面行为逐字节不变（`HashSeed` 不产生 0，桌面门等价旧式 `enabled() && canvas_noise_enabled()`；audio 追加 amplitude>0 仅把旧有的算术 no-op 显式化）。

### payload 格式修正

seed 全部改为**十进制字符串**：JSON 数值在 base::JSONReader 中 >2^53 丢精度（3247071200649857571 > 2^53），字符串走 `base::StringToUint64` 精确解析。

## 2. 真机验证（全部来自本轮 dump/截图/回执）

| 验证项 | 结果 |
| --- | --- |
| r13q 装机 | 装机 sha256 == 签名候选 `9ffe1cde…` ✓ |
| 种子冻结 | logcat fp_debug：两环境 payload 冻结一致，字符串 seed（3247071200649857571 / 5970510160645002106） |
| 跨 profile canvas | `ee365c40` vs `adff2c18` 不同 ✓（裸值 7d987d08 → 噪声态） |
| 跨 profile audio | `ec6b9241` vs `d9dc8b5d` 不同 ✓ |
| 同 profile 稳定 | QA-Isolation 重载 `adff2c18`==`adff2c18`；QA-Ping0-NY 重进 `ee365c40` 复现 ✓ |
| audio 读数波动 | 同环境两次 audio 哈希不同（analyser FFT 窗口滑动 + 活振荡器，探针时变特性；噪声机制种子稳定）——如实记录，canvas 才是稳定指纹身份 |
| ping0 | 100 分 / 异常 0 / 已检 117；检测器 11/11 报错为站点侧探针主机不可达（与既往「站点侧可变」一致）；出口 204.0.23.126 NTT；IPv6 未检出 |
| canPlayType | 9 项全 `probably`（专有编解码器保持） |
| 播放 | wav PLAYING t=0.13 ✓ |
| gUM | NotSupportedError（capture 栈未接线，缺口与 r13n 相同，独立工程轮） |
| C2-1 | 全进程 SIGKILL → 冷启动 → cookie/localStorage 存活 ✓（详见第 4 节方法学） |
| C2-2 | 整机重启 → 用户解锁 → 冷启动：cookie/localStorage 存活、种子 payload 逐字一致、canvas=`ee365c40` 与重启前一致、tz 生效 ✓ |

## 3. 工具链修复（夹具侧，非产品）

- `/fp` 探针 audio 段预热：原实现读 analyser 早于振荡器渲染量子 → 全 `-Infinity` 频谱（sum=Infinity）且 `-Infinity+噪声=-Infinity`，噪声不可观测。预热 250ms 后 sum 有限（~180337），audio 哈希可分辨。**该缺陷掩盖了 r13o/r13p 的 audio 证据面**——但 canvas 独立于它。
- 夹具根页加枢纽链接（/fp /media /cookie-\* /ls-\* /ping ping0-env ipwho），绕开真机中文 IME 的 URL 输入困难（搜狗/百度输入法把 `input text` 尾字符吞进拼音组合，确定键提交不可靠——后续轮的自动化应统一走链接导航）。

## 4. C2-1 方法学（如实）

无 root（shell uid 不能 kill 其他 uid 的进程）：
1. `am crash`（主进程）→ 管理器进程死亡；`:browser`（环境浏览器，NativeBrowserActivity 宿主）作为绑定服务存活（`am kill` 跳过前台绑定服务）——**此步未构成存储属主死亡，不作持久性证据**。
2. `am force-stop` = 整个进程组 SIGKILL、无任何清理回调（0056 的关停刷盘路径被跳过）→ **存储语义与崩溃/LMK 死亡等价**；与原生崩溃信号的差异如实记录（非信号级崩溃测试）。
3. 死亡后冷启动 → 环境重启 → 读回全部存活。
- 断电（物理断电/拔电）无法由 adb 执行，未模拟——诚实边界。

## 5. 证据与回执

- `E = .tmp-apk/proxy-fix-work/v13q/`：`reviewed-build-inputs.json`（RC1/RC2 + 全部 sha 钉扎）、`build_r13q.py`、`remote-patch-receipt-q.json`（rev4 pre/post 5 文件 sha）、`candidate-build-receipt-q.json`、`host/`（三套件日志）、`run/closure-receipt-r13q.json`（本轮完整回执）、`run/*.png`（fp/ping0/media 截图）。
- `E = .tmp-apk/proxy-fix-work/v13p/`：r13p 回执 + `run/r13o-cross-profile-failure.json`（RC1 的真机复现证据：两环境同哈希 + 种子不同）、r13o 失败轮种子 logcat。
- 补丁：`patches/chromium/patches/0061-android-product-fingerprint-gate.patch`（rev4，sha 82042140…）。
- 夹具：`.tmp-apk/ping0-followup-20261110/fixture_server.py`（枢纽 + 预热）、`relay2.py`、`relay2-connections.jsonl`（连接回执）。

## 6. 遗留（如实）

1. ~~C2-2 锁屏续跑~~ **已完成**：解锁后全部读回通过（见第 2 节 C2-2 行）。物理断电项不可自动化，保持开放。
2. **capture 服务栈接线**（gUM NotSupportedError）：权限桥已就绪待接线，独立工程轮。
3. **噪声振幅隐匿性**（0.0001×1000）与种子派生的密码学强度（FNV-1a 非加密）：审阅项未变。
4. **audio 探针的时变性**：哈希随读数窗口变化，做跨 profile 判据时以 canvas 为准；audio 判据应比较「同一次加载内」或改用确定性输入。
5. **release/source 收口**：完整 Chromium/DEPS、可复现构建、NOTICE —— 未动。
6. 调试日志（fp_debug/tz_debug/clause_debug）仍在校验构建里，出厂前清理为独立项。

关联：[按 profile 指纹种子轮](android-per-profile-fingerprint-2026-11-13.md)、[r13n 修复验证](android-r13n-fixes-verification-2026-11-12.md)、[r13l 修复验证](android-ping0-fix-verification-2026-11-10.md)。本文不把 rev4 宣称为「指纹对抗完成」——按 profile 差异化已在真机闭环，canvas/audio 是指纹面的一部分；振幅审阅与感知检测抵抗仍开放。
