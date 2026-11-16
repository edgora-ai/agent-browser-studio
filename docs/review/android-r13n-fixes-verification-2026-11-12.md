# Android r13n 修复验证：编解码器、图标铺满、媒体能力实测（2026-11-12）

## 0. 先读结论

接手用户「全部修复」指令，一轮构建周期（r13n）完成三项修复并在真机（OnePlus PKG110，Android 16）验证：

1. **H.264/AAC/HEVC 解码**：args.gn 开 `proprietary_codecs=true` + `ffmpeg_branding="Chrome"`。真机 canPlayType 矩阵从全 EMPTY 翻转为 **avc1/hevc/aac 全部 `probably`**（开放格式不受影响）。PASS。
2. **图标铺满**：adaptive icon 三件套（渐变背景 + 安全区地球前景 + anydpi-v26 引用）。应用详情页确认**渐变全出血圆角**生效。PASS。
3. **媒体权限桥**：manifest 声明 RECORD_AUDIO/CAMERA/MODIFY_AUDIO_SETTINGS + 补丁 0060（rev2）路由 capture 权限到 Android 运行时弹窗。桥已构建就绪——但真机实测暴露了**更深一层的引擎缺口**：`getUserMedia` 直接返回 `NotSupportedError`（content shell 的 capture 服务栈未接线，失败先于权限层），桥端到端未被触发。**麦克风/摄像头采集仍未打通，缺口已定位为 capture 服务栈接线，需要自己的评审轮次。**

附加真机确认：locale 修复在浏览器与渲染器双进程生效；安全上下文中 `navigator.mediaDevices` 存在并枚举 3 个真实设备；WAV 音频播放正常。

**ping0 评分波动（如实记录）**：r13n 两轮 85/100（RAF 伪影 + DNS 黑洞 resolver_count=0），对比 r13m 的 100/100。**传输签名逐字节一致**（53 个死 CONNECT、同出口 204.0.23.126 US），分数翻转是站点/服务端 DNS 探针状态变化，非产品回归——与既有「站点侧可变」文档一致。DNS 项在当前站点行为下不是稳定产品指标。

## 1. 构建（r13n）

| 项 | 值 |
| --- | --- |
| APK | `21f8a8a6…`，372,335,136 字节（比 r13m 大 2.5MB——编解码器进入），原证书签名 |
| 变更成员 | manifest（+3 权限）、NativeBrowserActivity（宿主注册）、policy .cc/.h（权限桥）、agent_browser_product.gni（jni_zero + jni-headers 依赖） |
| 新增成员 | MediaPermissionBridge.java + 3 个 adaptive icon 资源（成员集 74→78，逐成员枚举校验） |
| 基础树 | 补丁 0060 rev2（generate_jni 移入 content/shell/BUILD.gn + rules/jni_zero 双导入）+ args.gn 修订（前后 sha 入回执） |
| host | 549 契约 + 133260 tile + 213 启动合同全绿 |

构建过程如实记录：ssh 6 小时超时后远端 nohup 续跑；期间暴露并修复了 jni_zero 新注解包（org.jni_zero、注解标接口）、generate_jni 目标归属（content/shell/BUILD.gn）、include 路径（gen/jni_headers/...）、DEFINE_JNI 宏、以及最终改为**单向轮询权限设计**（去掉 Java→native 回调通道：native 同步 JNI 读 OS 权限态 + 弹窗触发 + 限时轮询，OS 权限库为唯一事实源）。

## 2. 真机验证（全部来自本轮 dump/截图）

| 验证项 | 结果 |
| --- | --- |
| 安装摘要 | `21f8a8a6…` 与签名候选一致 |
| 图标铺满 | 应用详情页：渐变全出血 + 白色地球（[app-info.png](../../.tmp-apk/proxy-fix-work/v13n/run/app-info.png)） |
| locale | logcat 双进程 `ABS_ANDROID_LOCALE_V1 applied=1 lang=en-US` |
| 编解码 | avc1/hevc/aac = probably；vp8/vp9/mp3/opus/vorbis/wav = probably |
| mediaDevices | 安全上下文（http://127.0.0.1 回环）存在；enumerateDevices = 3 真实设备 |
| 音频播放 | wav PLAYING |
| getUserMedia | **NotSupportedError**（capture 栈未接线——见下） |

## 3. 麦克风/摄像头：缺口定位（如实）

修复前的判断「权限层缺失」只对了前一半。r13n 实测：权限桥构建完成，但 `getUserMedia` 在权限层**之前**就返回 `NotSupportedError: Not supported`——content shell 构建里 **capture 服务栈**（video capture service / audio service 与 MediaStreamManager 的 Android 接线）没有连接，设备枚举虽显示 3 个设备但采集栈无法创建轨道。

**下一步（新工程项，需自己的评审轮）**：在 content shell Android 接线 capture 服务栈（native 工程，非配置），之后权限桥自动生效，再做真实麦克风/摄像头采集验收。

## 4. ping0 评分波动（不归因产品）

| 运行 | 分数 | 异常 | 传输 |
| --- | --- | --- | --- |
| r13m（11-10） | 100 | RAF(记录) | 53 死 CONNECT，出口 204.0.23.126 |
| r13n（11-12）×2 | 85 | RAF + DNS黑洞(0) | **逐字节相同**，同出口 |

站点/服务端 DNS 探针状态在两次运行间变化（权威侧不再记录/返回解析器）。传输一致而结果翻转 ⇒ 站点侧变量。DNS 项在当前站点行为下**不是稳定产品指标**；不过度解读任何单次分数。

## 5. 证据与回执

- `E4 = .tmp-apk/proxy-fix-work/v13n/`：`candidate-build-receipt.json`、`verify-receipt.json`、`reviewed-build-inputs.json`、`remote-patch-receipt.json`、`source-guard.json`、`run/`（app-info/抽屉截图、媒体探针 dump）。
- `E5 = .tmp-apk/ping0-followup-20261110/`：`run3/`（r13n 媒体探针 + ping0 两轮 dump）、`relay2-connections.jsonl`（2592 行全量连接回执）、`media-icon-receipt.json`、夹具与中继脚本。
- 提交：`be8b68a`（桥+编解码器+图标）、`e124b23`（r13m 图标）等；补丁 0060 rev2 已入库。

## 6. 下一步

1. **capture 服务栈接线**（新工程项）：content shell Android 的 video capture service / audio service 接线 + 权限桥端到端验收。
2. gUM 可用后：真实麦克风/摄像头采集验收（含经代理的 WebRTC 路径）。
3. ping0 DNS 项：继续以传输一致性判读，不为单次分数调产品。
4. Phase C2 破坏性矩阵仍待单独授权。

关联：[r13l 修复验证](android-ping0-fix-verification-2026-11-10.md)、[真机评分轮](android-ping0-real-device-score-2026-11-10.md)、[r13k 交接](android-native-ui-handoff-2026-11-09.md)。本文不把 85 分解读为产品回归，也不把「全部修复」宣称为采集能力已完成——采集缺口已定位且未闭合。
