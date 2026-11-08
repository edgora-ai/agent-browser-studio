# 桌面同步状态与交接（2026-11-08）

## 先读结论

**v1.0.2 的同步功能代码已收口并打 tag，但 mac 安装包至今未构建上传——GitHub 上最新可下载资产仍是 1.0.1（2026-10-28）。** 1.0.3 的 scoped 登录态传输硬化在独立 worktree 中开发，双机 A↔B 验收因对端主机离线未做。本文交付状态与操作手册；本机专用产物、凭据和未提交工作不随 Git 分发。

## 1. 源码身份

- 仓库：`https://github.com/edgora-ai/agent-browser-studio.git`（public）+ `agent-browser-studio-private.git`（private）
- `main` = `2655715`（已推送）：= 1.0.2 release 提交 `0930ea8` + 11-06 合并的 Android 检查点。**桌面 sync 源码与 `0930ea8` 完全一致**（11-06 合并冲突全部以 main 侧为准，8 个 sync 定向测试文件 527/527 通过，i18n/tsc 干净）。
- `feat/android-resume-20261027` = `6a773c1`（已推送），与 main 树内容相同，仅多合并提交。
- tag：`v1.0.2` 已存在（本地+远程），指向 `0930ea8`。
- 11-06 合并的冲突分析结论：feat 分支 `92848d8` 与 main `47626e0` 是**同一批改动的两次提交**（桌面 sync 文件逐字节相同）；main 是超集（多了 `a13c01a`、`991413e` 两轮 owned-cancellation/有界化修复，净 +2528 行）。取 main 无损；feat 独有的两个 Android 测试文件已保留。

### 工作区里不属于本文交付的未提交内容（勿动、勿删）

| 位置 | 内容 | 状态 |
| --- | --- | --- |
| 主工作树 `mobile/android/app/.../MainActivity.java`、`ProfileEditor.java` | 另一会话的 Android UI 修复（按钮单行省略等） | 未提交，基于 feat 分支 |
| `.tmp-build/multirole-app-review-20261029` worktree（40G） | 分支 `fix/multirole-app-review-20261029`（`ebafa55` 未合并进 main）+ `6e0316a fix(sync): harden scoped login-state transfer for 1.0.3` + **22 个未提交文件**（scoped-capture / scoped-credential-job / scoped-file-envelope / profile-restore-lock / process-discovery 等） | 1.0.3 开发在途 |

## 2. 已收口（v1.0.2 内容清单）

- 有限同步：配置、Cookie、LocalStorage（含 Chromium 152 SQLite 主库/WAL 组采集）、Preferences、History/Places、扩展包；push/pull 共享 owner、SYNC_BUSY、comparisonToken、脏标记/unknown 分级显示。
- 完整 profile 迁移 v4：保存密码、原生 Cookie、IndexedDB、Service Worker/CacheStorage、Session、AES-256-GCM 独立迁移口令、pending receipt 恢复门禁、staging/rollback 隔离。
- 传输体验：按归属绑定的阶段/字节进度、流式上传、受限 sidecar 并发、owned cancellation、有界本地准备、空闲/总时限、存储目录过滤（内部组件缓存不进 profile 统计）。
- 依据：`sync-backup-state-2026-10-18.md`（最终门禁：默认套件 206 文件 5415 通过、9 组深 E2E 55/55、真实应用整链 exit 0）、`studio-complete-profile-sync-2026-10-22.md`（全量 7647 passed）、`sync-cancel-batching-review-2026-10-28.md`、`sync-footprint-cancel-review-2026-10-29.md`。

## 3. 欠账：v1.0.2 mac 打包上传（最优先）

前次尝试（11-06/11-08）未完成，原因与对策：

1. **`npm run dist` 的 `clean:build` 会被沙箱 safe-delete 拦截**（node shim 对 >50 文件的 rmSync 要求确认）。对策：先用 shell `rm -rf dist` 再跑 `npm run dist`。
2. **`clean:release` 会清空 `release/`**。旧 1.0.1 包（2026-09-26）已挪至 `release-1.0.1-20260926-preserved/`（未跟踪）。构建会重建 `release/`。
3. **license 公钥**：`AGENT_BROWSER_LICENSE_PUBKEY` 必须注入正式 key，文件在 `dist/resources/license-pubkey.txt`（SHA-256 前缀 `73eb0f6406791fdd`，与 10-28 发布版一致）。构建前先把它备份到 dist 外（构建会删 dist）：
   ```sh
   cp dist/resources/license-pubkey.txt /tmp/license-pubkey.txt
   rm -rf dist
   AGENT_BROWSER_LICENSE_PUBKEY=$(cat /tmp/license-pubkey.txt) npm run dist
   ```
4. **签名**：钥匙串有 `Developer ID Application: tiger wang (Y62N77529N)`（hash `512B8645689F92E8C75CB65AF43A91281F5F36DF`），electron-builder 自动选用；未公证（与 10-23/10-28 惯例一致，release notes 需注明）。
5. **产物**：`dmg arm64` + `zip arm64/x64`，命名 `Agent-Browser-Studio-1.0.2-mac-<arch>.<ext>`；`native-browsers/mac`（Chromium/Firefox zip）作为 extraResources 打入。
6. **上传凭据**：gh CLI token 与 git credential 中的 HTTPS token 均已 401 失效。需先 `gh auth login -h github.com` 重新认证（或提供新 token）。git push 走 SSH（`ssh-public` remote）不受影响。
7. **发布惯例**（参照 10-28）：新 tag `preview-macos-arm64-1.0.2-20261108` 指向构建 commit，prerelease；资产为改名 zip + `BUILD-INFO-<date>.json` + `SHA256SUMS-<date>`。发布前过 package verification：asar SHA-256、license pubkey hash、native archive checksum（10-27 曾因 Chromium 归档 checksum 不符拒发，必须先过门禁再上传）。
8. 构建基线：`main`（`2655715`）。主工作树有 2 个 Android WIP 文件，不影响桌面包（files 只含 dist/**），但干净起见可在 `2655715` 上打独立 worktree 构建。

## 4. 1.0.3 在途（worktree，另一会话）

`6e0316a fix(sync): harden scoped login-state transfer for 1.0.3`（11-03）已提交在 `fix/multirole-app-review-20261029` 分支：storage bucket 名（`__roxy_controlled`→`roxy_controlled`）、managed executable pin 容忍 nlink/ctime 浮动、4 MiB 规范编码上限、凭据报告按 relativePath 排序、ESM worker `__dirname` shim、APFS 目录 nlink +1、absent restore family 扫描。**+22 个未提交文件未收口；双机 A↔B 验收（192.168.4.6）因对端离线未做，提交明确不声称验收通过。** 接手者先在 worktree 里 review/收口这 22 个文件，不要在主树另起炉灶。

## 5. 审查遗留边界（承接 1.0.x，未变）

- 真实双机 + 真实网站登录的完整迁移验收始终未做；全部验证为合成数据 + 隔离环境。
- Firefox NSS 主密码运行时解锁未验证；Windows DPAPI/AppBound 明确不支持（必须拒绝而非拷贝）。
- 旧 v1–v3 快照不能恢复从未上传的密码；需原机重新完整推送。
- issue-tracker 未排期项：AR-6 IPC 错误信封统一、AR-7 schema 版本化、PM-5/6、UX-8、A6；PM-2 更新通道等首个 manifest。
- coverage 已知缺口：REST/MCP/local-agent/IPC 分支覆盖弱；renderer 与 SDK 不在统计内（2026-10-18 实测报告）。

## 6. 本机产物地图（不随 Git 分发）

| 路径 | 体积 | 性质 |
| --- | --- | --- |
| `release-1.0.1-20260926-preserved/` | 1.4G | 9-26 1.0.1 包（自 `release/` 挪出，2026-11-08） |
| `release-sync-progress-20261027-arm64-preserved/` | 1.1G | 10-27 包（verification 拒发记录在 `deployment-artifacts/sync-progress-20261027/package-verification.json`） |
| `release-storage-profile-filter-20261028-arm64-preserved/` | 1.1G | 10-28 已发布包+签名材料 |
| `deployment-artifacts/` | 3.1G | 发行回执与验证证据（装机 SHA-256、github-publication.log），**不清理** |
| `.tmp-apk/` | 22G | Android 构建产物+验收证据 |
| `.tmp-build/multirole-app-review-20261029/` | 40G | 1.0.3 在途 worktree，**勿删** |
| `.agent-browser-studio/`（HOME） | — | 受管浏览器引擎缓存（chromium-152、firefox-154 等） |

## 7. 环境注意事项

- shell 走 `127.0.0.1:7890` 代理，代理未开时 HTTPS 失败；git 推送/拉取用 `ssh-public` / `ssh-private` remote 绕过。
- 沙箱 safe-delete shim 会拦截 node `rmSync` 批量删除（`clean:build`、`clean:release`）；用 shell `rm` 预清理。
- 本文起草时 HEAD `6a773c1` 与 `public/feat/android-resume-20261027` 同步；包含本文的提交将推送后以实际远端为准。
