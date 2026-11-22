# ABS Android rev15：通话入口 WebAudio 崩溃

**本地回归通过；原手机已原位升级并通过装后核验。** 未手动启动 ABS 或打开 muse.ai，未使用账户、麦克风，也未发起通话。

## 定位与修复

2026-11-19 00:07:14、00:07:30（+08:00），原机 rev14 Fix1 的两个 Chromium 渲染进程都在 `Realtime AudioW` 上因 `base/threading/thread_checker.cc:22` 的线程断言而 `SIGABRT`。原生库 Build ID `240896118f26eec1da81a77bf396d2f7dd90829c`；共同堆栈为 `MediaStreamAudioDestinationHandler::Process` → `AudioConsumer::SetFormat` → `WebAudioMediaStreamSource::SetFormat` → 线程检查。「页面已中断」是渲染进程退出后的提示。日志未记录具体网站操作；更早的 `ScriptPromiseResolverBase` 断言不是同一故障。

移植 [Chromium CL 8468847](https://chromium-review.googlesource.com/c/chromium/src/+/8468847)（`6363d8b6d36db4ac13c8185567c37c407c016402`，bug `40711696`）并将[补丁](../../mobile/android/native-kernel/chromium/product-webaudio-destination.patch)列入产品 staging。主线程在 `process_lock_` → `consumer_lock_` 下更新混音总线和流格式；实时线程不再调用 `SetFormat`，锁竞争时跳过当前音频块。构造时直接使用请求的 1–8 声道。保留原有线程断言和对象生命周期保护。

## 旧包 / 新包对照

ARM64 Android 模拟器逐次核对已安装 APK 哈希。在本地回环页面由可信点击启动合成 `AudioWorklet`，经 `MediaStreamAudioDestinationNode` 输出，再由 `MediaStreamTrackProcessor` 直接读取 `AudioData`。

| 测试 | 结果 |
| --- | --- |
| rev14 Fix1 动态声道 | 双声道数据正常；2→1 时复现真机同一断言、Build ID 和四个关键栈地址。 |
| rev15 动态声道，两次独立运行 | `2→1→4→4→8→2→2` 两次通过。 |
| rev15 构造声道 | 初始化 6 声道，`6→1→6→6→2→2` 通过。 |
| rev15 边界与导航 | 构造和 setter 的 0/9 声道均抛出 `NotSupportedError`；独立本地页面导航通过。 |

每步核对 8 包 × 480 帧（48 kHz）、逐声道 RMS、递增时间戳、轨道设置及原文档存活。三次 rev15 运行均未崩溃。staging 测试 18/18 通过；上游原生回归测试对象编译通过，未链接或运行完整 Blink 单测。结果不等于 muse.ai 实机通话验收。

## 构建、设备与留档

- Chromium `3f1de50fc81dd33dae9e115c57f6a8b5565d6a21` 原生增量构建，补丁经零 fuzz 应用与反向检查。staging manifest `sourceSha256` 为 `5c49e9539a142925c71c622d8498c737fddb75e72fbabc52081b0e1c7633c66f`。
- 活动包 `ABS-Browser-v1.0.0-r13z-rev15-webaudio-arm64.apk`，372,372,507 字节，SHA-256 `0b77b4ae8e29b638e45398faadf4ebde82add3ef203186e3b96e587b484e7662`；`com.ahoo.abs.browser`，`1.0.0` / `10000`，minSdk 29 / targetSdk 36，非 debuggable。原单一 Release v3 证书 SHA-256 `0f186dd70f80892e04443b7105842eef2ac9e641e9ecefa15015158317f1402f`。
- 最终签名包直接对照 rev14 Fix1：527 个非签名 ZIP 成员，仅主库 `libagent_browser_product.so` 发生变化，Build ID `d99b53fdce93f6051ed0233b1eb6560cc39b9e41`。三个 ARM64 ELF 的 ZIP 偏移与加载段满足 16 KiB 对齐。对照结果见 `payload-signed-to-signed.json`。
- 2026-11-19 20:20（+08:00），核对原机 USB 授权连接、设备及用户身份、原 rev14 Fix1 APK 和数据标识后，执行一次 `install -r`。设备 `base.apk` 哈希与 rev15 一致；签名、UID、CE/DE 数据目录标识和首次安装时间未变。`20:19:50.642`–`20:20:05.192` 的 crash buffer 无 ABS 崩溃记录。见 `phone-install-verified.json`。没有卸载、清数据或启动网站；安装核验不等于通话验证。
- 本次交付保留一份活动候选和一份[此前通过模拟器浏览验证的 rev13 回滚包](android-r13z-rev13-emulator-performance-2026-11-17.md)（`cf6f7955903b340ba9b284b6706639f931dcdcf07c88fb17933c29624bb2d61a`，未做本次真机回滚）。另保留故障基线 rev14 Fix1（`7a53ecf326a9a6e339d2c45e8ec3239ab0acff15edc06321a963ec552858a4d3`）、已有首故障证据、固定输入和发布包，不视为回滚版本。
- 清理本轮独立 AVD、确认冗余的无签名中间件和 6 个已审核的历史签名临时 APK（两份完全相同的正式包副本、四个已淘汰的本地候选）。保留发布原件及验收凭据。删除文件按分配块计约 8.57 GB；最近一批实测增加可用空间约 2.26 GB。未删密钥、共享 AVD 或用户数据。

证据目录：`.tmp-apk/proxy-fix-work/v13z-rev15-webaudio-20261119-z3p7Nc6W/`，含 `rev15-native-ssh.log`、`paired-track-replay.json`、`track-baseline-dynamic.crash.log`、`track-fixed-*.json`、`signing-reverify.json`、`payload-*.json`、`prune-*-result.json`。原机首故障日志摘要位于同级 `v13z-rev14-performance-20261117-7hdlm6mc/runtime/muse-call-crash-20261119-0007.md`。
