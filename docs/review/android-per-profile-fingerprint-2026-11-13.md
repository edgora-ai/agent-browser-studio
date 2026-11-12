# Android 按 profile 指纹差异化：种子机制与实测（2026-11-13）

## 0. 先读结论

接手用户「不同 profile 的指纹是否有区别，不要搞成相同的」与「不要有roxy相关命名」指令。实测确认：**修复前所有 profile 的指纹完全相同**（两个环境 canvas=7d987d08、audio=131c8fec 逐字节一致）。本轮实现按 profile 指纹种子差异化并在模拟器上验证：

1. **种子机制落地**：每个 profile 从其目录后缀确定性派生 64 位种子（FNV-1a），冻结进 argv（`agent-browser-noise-seeds` 开关——无 roxy 命名），引擎按种子施加 canvas/audio 噪声。**不同 profile → 不同种子 → 不同指纹；同一 profile → 种子稳定 → 指纹跨重启一致**。
2. **logcat 实证**：同设备同构建下两个 profile 的 payload 种子完全不同（EMUQA-emuqa-001-A: seed 7523044449142388417 / canvas 8525385185646168788；EMU-FP-A: seed 5851425449287902989 / canvas 5693405112168749848）。
3. **开关名冲突修复**：首版指纹开关 `agent-browser-fingerprint-config` 与时区配置的历史开关名撞车（同 argv 双同名开关 → 时区 payload 校验失败 → 环境启动即退）。rev2 改为 `agent-browser-noise-seeds` 后启动成功。

**诚实边界**：跨 profile 的 canvas 哈希**实测对比**被模拟器网络故障阻塞（模拟器 eth0/wlan0 全部 no-carrier，EMQA 环境代理不可达，探针页无法加载）；种子差异化由 logcat 实证 + 引擎算法确定性推出。噪声振幅（0.0001）的隐匿性未做感知测试。

## 1. 修复前实测（基线）

同一模拟器、同构建：QA-Isolation 与 QA-Ping0-NY 两个环境的 fp 探针结果逐字段相同（canvas=7d987d08、audio=131c8fec、gl/hardware/lang/tz 全同）——产品此前无按 profile 指纹差异化。跨 profile 的 cookie/存储隔离 ✓（前轮已证），但指纹面共享。

## 2. 实现（三件）

### 2.1 种子派生与冻结（Java）

- `stableProfileSeed(directorySuffix)`：FNV-1a 64 位哈希，输入 = profile 目录后缀（每 profile 稳定且唯一）。
- `fingerprintConfigPayload(directorySuffix)`：payload JSON `{schemaVersion:1, seed, canvas:{enabled,seed}, audio:{enabled,seed,amplitude:0.0001}}`，Base64url 无填充。
- `freezeCommandLine`：`--agent-browser-noise-seeds=<payload>` 冻结进 argv；`verifyFrozenCommandLine` 校验。

### 2.2 引擎门（补丁 0061 rev2）

`roxy_fingerprint_config.h` 的 enabled 门：产品 profile（product-profile 开关 + noise-seeds 开关同时在场）时按 seed 启用；桌面行为不变。开关名选 `agent-browser-noise-seeds` 以避开时区配置的历史开关名。

### 2.3 引擎消费（树内已有，零改动）

canvas 噪声：`image_data_buffer.cc` 的 `ApplyRoxyFingerprintNoise`（按 seed 逐像素确定性翻转）；audio 噪声：`realtime_analyser.cc` 的 `ApplyRoxyFloatNoise/ByteNoise`（analyser 读数微幅噪声，振幅 0.0001×1000）。

## 3. 命名约束执行

新代码的开关、字段、日志一律 `agent-browser-*` 命名（`agent-browser-noise-seeds`、`agent-browser-fingerprint-config` 为树内既有名）。树内既有 `RoxyFingerprintConfig` 类名（桌面线遗产，跨文件引用广泛）保持不动——重命名会波及桌面补丁链，属独立清理项。

## 4. 验证（模拟器，r13o rev2）

| 验证项 | 结果 |
| --- | --- |
| 启动修复 | rev2 后 `tz_debug frozenMatch=true`，环境启动成功（此前撞名导致启动即退） |
| 种子差异 | logcat fp_debug：两 profile payload 完全不同（见上） |
| 噪声生效 | EMU-FP-A 探针 canvas=5a2f111c（噪声打开状态） |
| locale/tz | 双进程 `ABS_ANDROID_LOCALE_V1 applied=1 lang=en-US`（r13o 继承 r13n 修复） |
| host 套件 | 556 契约（含 7 项新指纹断言 RED→GREEN）+ 133260 tile + 213 启动合同全绿 |

## 5. 阻塞与遗留（如实）

1. **模拟器网络死亡**：eth0/wlan0 全部 no-carrier（netsimd 链路断 + 早前 QA 轮的 0 bits/s 速度限制残留），重启模拟器未恢复——EMQA 环境代理（10.0.2.2:17891）不可达，EMQA-A/B 的 fp 探针无法加载，跨 profile canvas 哈希的**实测**对比被阻塞。
2. **菜单弹窗裁剪（UI 缺陷）**：模拟器屏幕（1080x1920）上浏览器菜单弹窗高度裁掉第 8 项（退出当前环境不可达）——环境退出受阻，记录为 UI 缺陷。
3. **audio 探针缺陷**：夹具页的 audio 哈希基于未预热的 AnalyserNode（sum=Infinity），噪声对 audio 的验证无效——探针页缺陷，非产品。
4. **EMU-FP-B 状态不明**：创建时报「名称已存在」但列表未显示——DB 状态不明（模拟器磁盘回滚疑似），下一轮需核实。
5. **噪声振幅隐匿性**：0.0001×1000 的噪声幅度对 canvas/audio 的感知/统计检测抵抗未验证。

## 6. 下一步

1. **跨 profile 实测补全**：模拟器网络恢复（或真机会话）后，两环境各跑一次 fp 探针，确认 canvas 哈希不同。
2. **capture 服务栈接线**（上轮遗留的 gUM 缺口）——权限桥已就绪，等 capture 栈。
3. **噪声参数审阅**：振幅与种子派生的密码学强度审阅（当前 FNV-1a 非加密哈希——种子可预测性对反检测的影响评估）。
4. **菜单弹窗裁剪 UI 缺陷**修复（小屏适配）。

## 7. 证据位置

- `E6 = .tmp-apk/proxy-fix-work/v13o/emu/`：fp 探针 dump（env A canvas=5a2f111c 等）、manager dump 序列、verify-receipt-fp.json。
- `E7 = .tmp-apk/ping0-followup-20261110/`：fp-r13o/（fp dump）、fixture_server.py（/fp 探针页）、relay2/3/4 脚本与回执。
- 构建回执：`.tmp-apk/proxy-fix-work/v13o/candidate-build-receipt-o.json`（r13o rev2）。
- 补丁：`patches/chromium/patches/0061-android-product-fingerprint-gate.patch`（rev2）。
- logcat 种子实证：EMUQA-emuqa-001-A 与 EMU-FP-A 的 fp_debug 行（本报告第 0 节引用）。

关联：[r13n 修复验证](android-r13n-fixes-verification-2026-11-12.md)、[r13l 修复验证](android-ping0-fix-verification-2026-11-10.md)、[真机评分轮](android-ping0-real-device-score-2026-11-10.md)。本文不把种子差异宣称为「指纹对抗完成」——canvas/audio 噪声只是指纹面的一部分，跨 profile 实测对比与感知审阅仍未闭合。
