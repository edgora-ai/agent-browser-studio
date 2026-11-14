# Android r13t 终验：真机麦克风+摄像头全部打通（2026-11-14）

## 0. 先读结论

接手 r13s 验收时真机暴露的**渲染进程崩溃**（`user_media_processor.cc:1966` DCHECK `video_capture_settings().HasValue()`，页面白屏）：根因是 **0060 桥的完成路径回 `(granted_now, granted_now)`**——单一 AND 布尔丢了 per-type 语义，音频-only 请求在麦克风授权后收到 `video_granted=true`，0062 委托便把摄像头设备塞进音频应答（真机枚举有摄像头；模拟器视频缓存为空所以没崩）。渲染器为一个从未设置视频设置的请求创建视频源 → DCHECK。

**补丁 0063**：桥两条完成路径回 per-type 真值（`requested && isCaptureGranted(true,false)` / `(false,true)`，两次廉价 JNI 读）+ 委托按请求类型钳制（非捕获 lambda，标志作绑定参数——`BindOnce` 拒绝捕获 lambda）。

**r13t 真机终验全绿（`8ebf10b4…`，装机 sha 一致）**：
- **`gum.audio=GRANTED tracks=audio` + `gum.video=GRANTED tracks=video`** —— 真机麦克风+摄像头采集端到端全部打通 ✓
- 权限链：麦克风沿用已授权（per-type 跳过）、摄像头弹对话框→授权→轨道创建，FATAL 计数 0
- 首载 `gum.video=NotAllowedError` 为授权时序一次性伪影（OS 授权持久化后稳态双 GRANTED）——如实记录
- `/fp` 抽查：canvas=`ee365c40` 与 r13q 逐字一致（种子指纹跨构建稳定）；audio=`aa505b42 sum=0.006641`（确定性 AudioBuffer 路径，噪声在）

## 1. 本轮过程（如实）

1. r13s 真机验收 → 渲染进程崩溃（两次加载各一次）→ 白屏。
2. 溯源：MSM UI 代理 → 委托应答 → 0062 把桥的 (true,true) 变成音频应答里的视频设备。
3. 0063 v1（捕获 lambda）应用后编译失败 → v2-only-shell 与链纪律基线不符被放弃 → **终版 0063 = 全量双 hunk 链干净补丁**（policy a15e4014→15ae0402 + shell.cc 50b24836→12583db8），本地净前置态预演 exit 0 后远端应用 sha 验证。
4. 构建脚本同样踩了顺序坑（0063 先于 overlay 应用会撞 overlay 的 policy 成员）→ 调整为 overlay 先行、补丁随后。
5. r13t 装机 → 验收全绿（见第 0 节）。

## 2. 清零清单终态

| # | 项 | 终态 |
| --- | --- | --- |
| ① | gUM 麦克风+摄像头 | **真机端到端全部打通**（r13t）✓ |
| ② | 调试日志 | 已清（r13s 起）✓ |
| ③ | 小屏菜单裁剪 | 不复现（存证）✓ |
| ④ | audio 探针时变 | AudioBuffer 确定性路径（模拟器双环境 + 真机抽查）✓ |
| ⑤ | 噪声审阅 | [文档](android-noise-review-2026-11-14.md) ✓（种子随机化为独立硬化项） |
| ⑥ | EMU-FP-B | 幻影冲突消除 ✓ |
| ⑦ | 构建/提交 | r13s `de426afc`（b3409e1）+ r13t `8ebf10b4`（本轮）✓ |

不可自动化/非缺陷项保持如实记录：物理断电；release/可复现构建链（程序级）。

## 2b. r13t 评分补录（同日晚间）

QA 中继允许名单曾把用户打开的一切非测试网站拒掉（ERR_CONNECTION_CLOSED 白页——「来回切换卡片白板」的真凶）。relay2 v3 修复为通用代理：测试域（ping0/cloudflare/ipwho）走用户 mihomo 隧道（127.0.0.1:20080，稳定），其余全部直连。

**r13t 评分（QA-Ping0-NY，真机）：100 分 / 异常 0**（已检 109/总 143，检测仍在收尾时取照）；出口 204.0.23.126（NTT AS2914 洛杉矶、家庭宽带、原生 IP、风控 15%、IPv6 未检出）——与 r13q 逐项一致。截图 `run/phone-r13t-score.png`，回执 `run/closure-receipt-r13t.json`。

## 3. 证据

- `.tmp-apk/proxy-fix-work/v13t/`：`reviewed-build-inputs.json`（v1/v2 历史全录）、`build_r13t.py`、`remote-patch-receipt-t.json`、`candidate-build-receipt-t.json`、`host/` 三套件日志、`run/closure-receipt-r13t.json`、`run/*.png`。
- 补丁：`0063-android-product-capture-per-type.patch`（sha 76910d7b…）。
- 前序：[r13s 清零轮](android-r13s-zeroing-2026-11-14.md)、[r13q 收口轮](android-r13q-closure-2026-11-14.md)。

关联：[噪声审阅](android-noise-review-2026-11-14.md)、[r13n 修复验证](android-r13n-fixes-verification-2026-11-12.md)。
