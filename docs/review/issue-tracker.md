# Agent Browser Studio 问题清单与验收标准（追踪表）

> 来源：2026-08-29 三视角全面评审（产品经理 / 用户 / 系统架构）。
> 本文档是**唯一权威追踪表**：每个问题带验收标准与当前状态；状态变化必须附证据指针（测试文件 / 命令 / e2e 编号）。
> 状态定义：✅ 已收口（验收全过）· 🟡 部分完成（剩余项已注明）· ⏳ 等外部条件 · 📋 未排期。

## 一、产品经理视角

| # | 问题 | 验收标准 | 状态 | 证据 |
|---|---|---|---|---|
| PM-1 | 分发断链：用户拿不到安装包 | Releases 页 4 个安装包（mac arm64 dmg / win x64 nsis / linux x64+arm64 AppImage）+ sha256；全新机器不碰终端完成建号→启动→检测 | ⏳ 等 engine-verify.yml 在真实 runner 执行 + 签名 secrets | `.github/workflows/engine-verify.yml` 已就绪；`docs/USER_GUIDE.*` 已覆盖安装章 |
| PM-2 | 更新通道未接通 | 发布 manifest 后旧版可 Check→Stage→Activate→回滚；坏 payload 被 sha256 拒绝 | 🟡 代码+工具就绪，等 PM-1 产出首个 manifest | `src/main/services/update-manager.ts`；`scripts/release-manifest.mjs` + `tests/unit/release-manifest.test.ts`（6 例）✓ |
| PM-3 | GitHub 仓库名拼写（browser-manger） | `gh repo rename`（public+private）→ 新名 `git ls-remote` 可达 → 4 处文档 URL 同步 | ⏳ 等用户拍板（对外操作） | remote 实查：远端即 typo 名，文档与远端一致 |
| PM-4 | 向导引擎缺失死胡同 | 失败态提供「选择本地构建 / 安装指南」出路 | ✅ | `wizard.js` wizardEngineMissing；j-wizard e2e ✓ |
| PM-5 | 合规边界未产品化 | 产品内场景引导/边界提示 | 📋 未排期 | ACCEPTABLE_USE.md 仅仓库文档 |
| PM-6 | cloak 双品牌残留 | 一个 deprecation 版本后移除别名（IPC cloak:*、x-cloak-token、legacy keys） | 📋 未排期（存量迁移依赖） | 39 处引用清单在架构评审 |
| PM-7 | 手册滞后于功能 | USER_GUIDE 双语覆盖全部功能面 + 故障排查对齐实际错误文案 | ✅ | `docs/USER_GUIDE.en.md` / `.zh-CN.md` 各 182 行重写 |
| PM-8 | 平台承诺与验证不对等 | engine-verify 三平台 runner 全绿后才可对外承诺 | ⏳ 随 PM-1 | roadmap 对齐矩阵 |

## 二、用户视角

| # | 问题 | 验收标准 | 状态 | 证据 |
|---|---|---|---|---|
| UX-1 | 15 处原生 confirm 割裂 + 高危无勾选 | renderer 中 `\bconfirm(` 归零；批量删/清审计/清运行记录需勾选；统一 dlg-confirm | ✅ | grep 归零 ✓；`core.js` confirmAsync；j28/j37/j53/j57 e2e ✓；**附带修复迟到 close 事件吞回调的竞态 bug** |
| UX-2 | i18n 碎片（英文界面冒中文） | used-key 双语覆盖 100%；EN 缺 key CI 失败 | ✅ | 运行时探针 727 key 补 10 缺失；`scripts/check-i18n.mjs` + j-i18n |
| UX-3 | 133 处裸 e.message 直接 toast | 错误为人话+可执行建议；无 "Error invoking"；高频错误可一键跳转 | ✅ | `errors.js` 20 类目录+action；toast/renderViewState 中心接入；smoke `friendly-errors.test.ts`（8 例）；j101 e2e ✓ |
| UX-4 | 删除无撤销 | 回收站 + Undo | ✅（WorkBuddy PL-09） | 7 天回收站 + toast 撤销 |
| UX-5 | 大列表卡顿 | 分页/增量渲染 | ✅（WorkBuddy） | 每页 50 + keyed 增量更新 |
| UX-6 | 可访问性薄弱 | 全局 :focus-visible；icon 按钮 aria；对话框焦点陷阱/Esc | 🟡 :focus-visible + 卡片 aria 已做；深键盘流未排期 | `style.css` focus-visible；`<dialog>` 原生陷阱/Esc |
| UX-7 | 术语裸露（RBAC/CDM/IDC） | 用户文案用业务语言，缩写进 tooltip | ✅（RBAC/CDM/代理门已软化；DB/开发者面保留） | index.html + i18n |
| UX-8 | 视觉一致性（inline style 泛滥） | — | 📋 未排期（低风险欠账） | — |

## 三、系统架构视角

| # | 问题 | 验收标准 | 状态 | 证据 |
|---|---|---|---|---|
| AR-1 | 配置双缓存 + 静默降级 | store 成为唯一写路径且无第二缓存；直连 transact 的写入对 getConfig() 立即可见；fallback 删除 | ✅ | `store.ts` 无状态化（baseProvider/normalizer/afterTransact 注入，零缓存）；saveConfig 单路径；陈旧读回归测试（config-manager tests 37 例）；全量 790 例 ✓ |
| AR-2 | 巨型模块（local-agent 3333 行等 4 个） | 各 ≤800 行且测试不变红 | 📋 持续摊还 | `scripts/check-file-size.mjs` 门禁在位 |
| AR-3/4 | REST/MCP 三面重复 + body 无界 | 恒时比较；流式上限；坏 JSON 400 | ✅ | `http/auth.ts` safeEqual；`http/body.ts` 接入；`tests/unit/http-auth.test.ts` + http-body-limit + j54 ✓ |
| AR-5 | 无崩溃兜底/日志 | 主进程 unhandledRejection 被记录且应用存活；日志进观测 | ✅ | `index.ts` 处理器 + `tests/e2e/j103-crash-net.test.ts` ✓ |
| AR-6 | IPC 契约三种错误形态并存 | 统一 {ok,data\|error} 信封 + wrapHandler | 📋 未排期（UX-3 已在渲染层兜底体验） | — |
| AR-7 | schema 版本化实为钳制 | 版本化升级注册表 | 📋 未排期 | `Math.max(4,...)` 现状 |
| AR-8 | Docker 半成品 | 双端口暴露；非 root 运行；--no-sandbox 诚实标注；数据卷路径一致 | ✅ | `Dockerfile` USER node + EXPOSE 双端口；compose 卷改 /home/node；`tests/smoke/docker-hardening.test.ts` 4 例 ✓（容器运行时验证随 PM-1 runner） |
| AR-9 | 并发小雷（tray isQuitting / interval unref） | 死代码移除；tray 刷新 interval 不阻塞退出 | ✅ | `tray-manager.ts` 死写入移除；`index.ts` tray interval `.unref()` |
| AR-10 | coverage 未忽略 / flaky | gitignore + flaky 测试显式超时 | ✅ | `.gitignore`；`agent-run-trace.test.ts` 20s 超时 |

## 四、产品专项（后续评审新增）

| # | 问题 | 验收标准 | 状态 | 证据 |
|---|---|---|---|---|
| A1 | 默认代理硬编码 7890 | 全新安装直连可跑通；default 模式未配置→直连；命名代理缺失仍 fail-closed；存量零影响 | ✅ | config-manager/browser-manager 改动 + unit 4 例 + j80/j1/j59 ✓ |
| A2 | 更新清单无生产工具 | `release:manifest` 产物被真实 parseUpdateManifest 接受并 checkForUpdates 可见 | ✅ | `scripts/release-manifest.mjs` + 6 例往返测试 + CLI 冒烟 |
| A3 | 无 CHANGELOG | Keep-a-Changelog；版本号与 package.json 同步被 CI 校验 | ✅ | `CHANGELOG.md` + `tests/smoke/changelog.test.ts` 3 例 |
| A4 | 竞品数据导入为零 | 至少一家竞品 profile 导入（cookie/代理绑定）e2e：导入→启动→cookie 有效 | 📋 产品决策项 | — |
| A5 | 数据安全叙事缺失 | 有 profile 后出现一次性备份提醒（可关闭持久化）；手册有备份章 | ✅ | profiles.js + j102 e2e ✓；USER_GUIDE §11 |
| A6 | API token 走 env（ps 可见） | 默认改 keychain 读取，env 仅覆盖 | 📋 未排期（P3） | — |
| Q1 | j53 批量控制台 3 例失败 | j53 6/6 全绿 | ✅ | 根因=测试对机器语言隐含依赖，语言钉住修复 |

## 五、发布前置清单（PM-1 执行时逐项打勾）

- [ ] engine-verify.yml 在真实 runner 跑绿（linux-x64 / windows-x64 / macos-arm64）
- [ ] 4 个安装包 + sha256 + BUILD.txt 上传 GitHub Releases
- [ ] `npm run release:manifest` 生成首个 update-manifest.json 并发布
- [ ] PM-3 仓库改名 + 文档 URL 同步
- [ ] 全量 e2e（含 j1–j103）在打包产物上回归
