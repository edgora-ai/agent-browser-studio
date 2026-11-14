# Android r13s 清零轮：gUM 打通 + 调试日志清理 + 探针确定性化 + 审阅（2026-11-14）

## 0. 先读结论

接手「全部问题清零」指令，六项按序处理：

1. **gUM（麦克风/摄像头）端到端打通** —— 找到真正的根因：gUM 请求经 `MediaStreamUIProxy` 落到 `WebContentsDelegate::RequestMediaAccessPermission`，而 Shell **从未重写**它（基类实现无条件回 `NOT_SUPPORTED`，在捕获栈运行之前就失败）。0060 权限桥只被 permissions API 路径走到——这解释了「permissions.query 返回 prompt 而 gUM 报 NotSupportedError」的矛盾。补丁 0062：Shell 委托重写（产品 profile + 设备捕获 → 走 0060 桥 → 从 `content::MediaCaptureDevices` 缓存取首个枚举设备应答）。**模拟器端到端验收**：Android 权限对话框弹出 → 授权 → `gum.audio=GRANTED tracks=audio` + 状态栏麦克风指示条。视频在该 AVD 上为 NotFoundError（枚举无摄像头设备，NO_HARDWARE 正确路径）；真机枚举含 videoinp，装机后验收待设备重连。
2. **调试日志清理**：`fp_debug/tz_debug/clause_debug` 移除（校验逻辑与产品日志保留），契约套件绿。
3. **小屏菜单裁剪**：当前构建**不复现**（模拟器 1080×1920@420 全 8 项可见含退出当前环境，截图存证）——早期记录早于现行尺寸逻辑，不改代码。
4. **audio 探针确定性化**：`/fp` 的 audio 段改为 `AudioBuffer.getChannelData` 路径（引擎每通道只加一次噪声）——模拟器双环境验收：B `audio=8691061b sum=0.005682` vs C `79f2f048 sum=0.006170`，跨 profile 不同、profile 内稳定 ✓（并吃到了 audio_buffer.cc 噪声消费点）。
5. **噪声审阅**（[android-noise-review-2026-11-14.md](android-noise-review-2026-11-14.md)）：canvas=每像素 1 LSB（不可感知、PNG 保持）；audio 有界；**种子派生 FNV-1a(suffix) 稳定但可预测**——硬化建议（env 创建时 CSPRNG 种子持久化 + canvas/audio 独立采样）记为独立工程项。
6. **EMU-FP-B 幻影冲突**：当前 DB 创建同名环境成功（环境 6→7）——磁盘回滚伪影，已消除。

构建 **r13s**（`de426afc…`，372,334,304 B，原证书）：0062（v1 应用后编译失败——回调签名是 `const StreamDevicesSet&`，v2b 只带 Run() 结构体修正）+ Java 日志清理。装机：模拟器已验（sha 一致）；**真机安装与验收待重连**（设备在验收时离线）。

## 1. 0062 的根因链（如实）

- `MediaStreamManager::PostRequestToUI` → `MediaStreamUIProxy::Core::RequestAccess` → `render_delegate->RequestMediaAccessPermission`（media_stream_ui_proxy.cc:169）→ WebContentsImpl → **WebContentsDelegate**（Shell）→ 基类默认 NOT_SUPPORTED。
- 委托回调签名 `OnceCallback<void(const StreamDevicesSet&, result, ui)>`：v1 误传 mojom Ptr 编译失败；v2b 空应答传默认构造结构体、OK 应答按值构造并 emplace 设备 Ptr。
- 设备来源：`content::MediaCaptureDevices`（public 层，shell 可用）——MSM 枚举完成后经 `NotifyDevicesChanged` 刷新缓存，委托调用时必已填充 ✓。
- 分层合规：改动全在 content/shell + public API + 既有产品策略头，未跨 DEPS。

## 2. 验收（模拟器，r13s de426afc）

| 项 | 结果 |
| --- | --- |
| 装机 sha | 模拟器一致 ✓（真机待重连） |
| gUM 音频 | 对话框→授权→`GRANTED tracks=audio`+系统麦克风指示 ✓ |
| gUM 视频 | NotFoundError = 枚举无设备（NO_HARDWARE 正确路径）；真机待验 |
| canPlayType | 9 项全 probably（保持） |
| 跨 profile（模拟器） | EMU-FP-B vs EMU-FP-C：canvas `cbd572b2` vs `a19b92ed`、audio `8691061b` vs `79f2f048` ✓ |
| audio 确定性 | 两环境 sum 非零且量级稳定、哈希按 profile 稳定 ✓ |
| 菜单 | 全 8 项可见，不复现 ✓ |
| 契约套件 | 556 + 133260 + 213 全绿（日志 sha 入冻结回执） |

## 3. 待办（唯一开口：真机）

- 手机重连（USB 或重开无线调试）后：装 r13s → sha 校验 → `/media` 验收 gum.audio + gum.video（真机枚举含 videoinp，预期双双可用）→ `/fp` 抽查 QA-Ping0-NY canvas 仍 `ee365c40`（Java 改动不动种子）。
- 与本轮无关的既有独立项保持：噪声种子随机化硬化、release/可复现构建链。

## 4. 证据

- `E = .tmp-apk/proxy-fix-work/v13s/`：`reviewed-build-inputs.json`（v1→v2b 历史 + 全 sha 钉扎）、`build_r13s.py`、`remote-patch-receipt-s.json`、`candidate-build-receipt-s.json`、`host/` 三套件日志、`run/closure-receipt-r13s.json`、`run/*.png`（gUM 对话框/授权后/双环境 fp/菜单）。
- 补丁：`0062-android-product-capture-delegate.patch`（v2b，sha f6ff2a92…）。
- 夹具：`fixture_server.py` /fp AudioBuffer 路径。
- 审阅：[android-noise-review-2026-11-14.md](android-noise-review-2026-11-14.md)。

关联：[r13q 收口轮](android-r13q-closure-2026-11-14.md)、[r13n 修复验证](android-r13n-fixes-verification-2026-11-12.md)。
