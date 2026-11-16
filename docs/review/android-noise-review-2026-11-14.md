# Android 指纹噪声机制审阅：振幅、覆盖与种子派生（2026-11-14）

## 0. 先读结论

接手「噪声振幅隐匿性 + 种子派生密码学强度」审阅项（r13q 收口轮遗留）。本轮通读引擎噪声实现（`image_data_buffer.cc` canvas 噪声体、`realtime_analyser.cc`、`audio_buffer.cc`）并给出如实评估：

1. **canvas 噪声振幅 = 每像素 1 LSB**（三色通道之一、跳过全透明像素）——感知不可见，PNG（无损）可保持；JPEG 会被量化丢弃（探针/产品默认 PNG ✓）。
2. **audio 噪声两路**：analyser 读数 ±0.1 dB（amplitude 0.0001×1000）——时域数据上轻微；AudioBuffer.getChannelData ±每样本 bounded 噪声、每通道只加一次（确定性 ✓）。
3. **种子派生 = FNV-1a(directorySuffix)**：稳定（跨重启/重进一致 ✓ 真机已证）但**可预测**——suffix 空间小且格式已知（如 `EMQA-emuqa-001-A`），攻击者可枚举候选 suffix 复算噪声模式，把观测 canvas 反推回 env 身份。**建议的硬化方向**：env 创建时生成随机种子并持久化到 env DB（稳定 + 不可预测），为独立工程项。
4. **跨种子关联**：canvas/audio 种子由同一根 seed 派生（`seed^0x9e3779b9…` / `seed+0x51ed270b`）——单一种子泄漏即推出另一路；随机化时应独立采样。

## 1. canvas 噪声（image_data_buffer.cc）

```
hash = canvas_seed ^ (y<<32|x); hash = Mix(hash);      // 每像素确定性
channel = hash % 3; bit = (hash>>8)&1;
pixel[channel] = (pixel[channel] & 0xfe) | bit;         // 只动 LSB
```

- 覆盖：每个非透明像素 1 通道 1 bit —— 任意 220×40 探针 canvas ≈ 8800 次翻转。
- 感知：LSB 不可见（人眼/SSIM 均无差）。
- 统计检测：原始渲染的 LSB 分布并非均匀（渐变/文字边缘），逐像素确定性翻转与像素位置强相关——**跨 profile 的 LSB 模式相关性可做 profile 联结**（需多张 canvas 统计，难度高于普通对抗，非零风险）。
- 持久性：PNG 无损保留；`toDataURL` 默认 PNG ✓。

## 2. audio 噪声

| 路径 | 幅度 | 确定性 |
| --- | --- | --- |
| realtime_analyser（getFloat/ByteFrequencyData） | ±0.1（0.0001×1000）/bin（float）；byte ±1 | 窗口时变 → 读数间哈希不同（探针特性） |
| audio_buffer（getChannelData） | 有界逐样本 | **每通道一次**（roxy_noised_channels_ 守卫）→ 确定性 ✓ |

r13s 探针已切换到 AudioBuffer 路径：零 buffer + 噪声 → `sum==0` 即噪声关闭、哈希按 profile 稳定。analyser 路径保留（真实流音量微扰）。

## 3. 种子派生（Java stableProfileSeed）

- 当前：`FNV-1a(directorySuffix)` → 根 seed → canvas/audio 子种子（异或/加常数）。
- 满足：同 profile 稳定 ✓（真机跨重启逐字一致）、跨 profile 唯一 ✓（3247… vs 5970… 实测）。
- 不满足：**不可预测性**。suffix 格式固定（`<批次>-<编号>-<字母>`），候选空间可枚举；噪声模式 = f(seed, 像素坐标)，观测一张 canvas + 枚举 suffix 即可精确重建该 profile 的全部未来 canvas 噪声 → 与 env 身份绑定。
- 硬化建议（独立工程项，不阻塞本轮）：
  1. env 创建时 CSPRNG 生成根种子，持久化到 env 配置（替代 suffix 派生）；suffix 仅作目录名。
  2. canvas/audio 种子独立采样（不共享根）。
  3. 审视 LSB 翻转的像素相关性（如按块置换或对高频区加噪声），降低统计联结面。

## 4. 边界

- 本审阅为**代码层分析**，非感知实验/对抗实测——「统计联结」与「suffix 枚举攻击」是推演结论，未做实际攻击验证。
- 指纹面远大于 canvas/audio（UA/字体/WebGL/屏幕等）：本机制只覆盖按 profile 差异化，不宣称对抗完成。

关联：[r13q 收口轮](android-r13q-closure-2026-11-14.md)、[按 profile 指纹种子轮](android-per-profile-fingerprint-2026-11-13.md)。
