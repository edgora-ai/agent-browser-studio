# 三平台安装包验证报告（v1.0.0-sale.2 系列）

日期：2026-09-06
目标：Mac + Windows + Linux 安装包可验证通过（参照 /goal「三端能力对齐，产生安装包并可验证通过」的第一阶段：兼容版三端包）。

## 1. Release 产物清单（private 仓库，均为 Pre-release）

| 平台 | Tag | 产物 | 大小 | SHA256SUMS | BUILD.txt |
|---|---|---|---|---|---|
| macOS arm64 | v1.0.0-sale.2 | dmg 476,272,579 B；zip 484,367,493 B | ✅ 同 release 附带 | ✅ 同附带 | engine=chromium-152.0.7977.72 firefox=154.0 commit=9b918f2 |
| Windows x64 | v1.0.0-sale.2-win | NSIS exe 107,707,311 B | ✅ 同附带 | ✅ 同附带 | engine=stock-chromium |
| Linux x64 | v1.0.0-sale.2-linux | AppImage 107,887,784 B | ✅ 同附带 | ✅ 同附带 | engine=stock-chromium |

校验命令（任一平台）：

```bash
gh release download <tag> --repo edgora-ai/agent-browser-studio-private -D /tmp/verify-<plat>
cd /tmp/verify-<plat> && sha256sum -c SHA256SUMS.txt
```

## 2. 各平台验证证据

### macOS（独立引擎，完整版）
- 本地构建：`npm ci → sync-native-browsers(mac) → build → dist`，dmg+zip 产出。
- ad-hoc 深签名验证通过：`codesign --verify --deep --strict` 无输出（valid）。
- dmg 挂载 → app 拷出 → 隔离 userData 启动，主进程/renderer/GPU 全起。
- 试用双标记落盘：license.json + config.json（含 deviceId）。
- J200 真机冒烟 5/5：启动、试用横幅、license API live trial、配额内建号、激活弹窗+退款门。
- J201 真机冒烟 2/2：App 徽标渲染、四对齐菜单项存在（#107 B1/B3 修复可见）。

### Windows（stock 引擎，兼容版）
- CI（public 免费 runner，studio-package.yml）：choco 装官方 Chromium+Firefox → stage 进 `native-browsers/win/{chromium/chrome.exe,firefox/firefox.exe}`（stage 日志确认两 exe 拷入）→ electron-builder NSIS 打包 success → upload-artifact。
- 本地下载验证：exe 103MB（107,707,311 B），SHA256SUMS 匹配，BUILD.txt 标 stock。
- 已知限制：无 Windows 真机，启动冒烟未跑；独立引擎未编入（#114 跟踪）。

### Linux（stock 引擎，兼容版）
- CI（public 免费 runner）：apt 装官方 chromium-browser+firefox → stage → AppImage 打包 success。
- 本地解包验证（squashfs offset 188392）：`resources/native-browsers/{chromium,firefox}` 在包内；manifest：chromium 152.0.7977.64 / firefox 155.0.1；app.asar 在包内。
- 已知限制：无 Linux 真机，启动冒烟未跑；独立引擎未编入（#114 跟踪）。

## 3. 能力差异口径（已写入 PRICING.md / PRICING.en.md）

- macOS：独立引擎，原生 49 补丁，ping0 92 分（实测）。
- Windows/Linux 首版：官方 stock 引擎 + Studio 应用层注入（BiDi 标准协议，stock 生效：UA/平台/语言/时区/WebRTC IP/地理位置），无原生补丁；演示用 Mac 录制并标注；独立引擎升级后免费更新。

## 4. 未完成项（#114 跟踪，需强机算力）

- Windows/Linux 独立 Chromium 编译：免费 runner 6 小时上限内无法完成全量编译（实测 38%/5h）。
- CI 修法已全部落地并保留（PR #113：gclient 布局、longpaths、toolchain、gn 自举/树内 gn）。
- 强机一次编入库后，Studio 打包复用 `--chromium/--firefox` 指定二进制即可出对齐包。
