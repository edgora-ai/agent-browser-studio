# IPC、公开接口与健康诊断功能审查（2026-10-18）

## 结论状态与证据口径

本文件是批准计划八组功能的**逐动作审查检查点**，不是全应用验收通过声明。产品、IPC、接口、renderer 的专项证据分别记账；最终同源码 build、GUI、完整套件和 coverage 由主会话填入末节。

**本次追加状态：LocalStorage 仍未修复。** 正常页面关闭候选在 `c9a537…` 曾通过，但 `3f33e2…` 第2轮又出现有效的正常退出丢值，独立 native SQLite 条件查询新key/value均为0；候选已撤回，第3轮未运行。当前工作区仅保留独立的启动迟到清理owner修复及测试取证，源码 `c66be7b8e9cfc35485f5311296f6255eca8474c430f4add69b387c66369afeaf` 已构建、正式issuer保全，12文件808/808专项通过；新完整套件/coverage待同一源码复验。下文 `516378…` 的6079项、81.00%行覆盖率及健康/恢复结果仅是该源码的独立检查点，不自动继承为新源码结果。最新失败、撤回和未知边界见文末。
仓库：`/Users/ahoo/workspace/roxy-lite-cloak-oss`。表内源码路径相对此仓库；测试短文件名默认位于 `tests/unit/`，明确写出的 smoke/E2E 路径除外。

- **通过**：指定用例在保留回执中通过，只证明该行已执行的分支，不代表组内所有操作、引擎或平台均通过。
- **RED 已闭合**：原生产路径有有效业务断言 RED，最小修复后相应用例 GREEN；夹具初始化、transform 和测试自身错误不计产品 RED。
- **源码审查**：已追到实际调用链，但没有把它升格为本轮端到端验证。**未覆盖**：该动作的重要分支没有本轮已通过证据。
- **blocked**：所需真实引擎、外网或安全边界尚不具备；不能以 mock、成功返回值或其他动作的正例替代。
- **U**：真实生产 handler/service 与隔离存储；Electron、进程、CDP/BiDi wire 等边界受控。**T**：真实 HTTP socket/协议，部分下游 service 受控，须逐行看证明范围。
- **R**：原 renderer 模块、有限 DOM 和受控 API 回执；不是实际窗口或截图。**G**：所列 source/run 的独占 HOME/userData 实际 Electron/preload 与既有 native Chromium 窗口、磁盘和业务读回；截图已由主会话实际查看。G 不自动继承到后续源码，也不代表同一 run 未执行到的后段。未标 G 的动作不得借用另一动作的 GUI 正例；native picker 选择/等待仍是明确受控边界。
- IPC 新测试实际 import/register 原 registrar，重复 channel 报错；preload 实际加载 CJS，不复制 handler、不用 VM 源映射制造 IPC coverage。
- REST/MCP 共用 `rest-mcp-socket-helper.ts`：真实监听/HTTP/SSE，但 browser-manager、sync、ZIP、installer、部分自动化和探针被替换；账户/config/会话/SQLite/skills 等指定存储真实，不能统称“所有下游只 mock native”。
- 存储证明按“写入 → 直接文件/独立 SQLite → reload/重开 → ID/条件检索”记录；纯导航、返回值和内存任务注明不适用，不伪造数据库证据。

源码缩写：B=`src/main/ipc/browser.ts`；P=`src/main/ipc/profile.ts`；S=`src/main/ipc/settings.ts`；A=`src/main/ipc/agent.ts`；Y=`src/main/ipc/sync.ts`。
服务缩写：C=`src/main/services/config-manager.ts`；H=`src/main/services/profile-health.ts`；L=`src/main/services/local-agent.ts`；REST=`src/main/services/rest-api-server.ts`；MCP=`src/main/services/mcp-server.ts`。
显示路径：UI=`src/renderer/js/app/`；Profiles=`UI/profiles.js`，Accounts=`UI/accounts.js`，Proxies=`UI/proxies.js`，Extensions=`UI/extensions.js`；这些是路径简写，不是额外实现。
测试缩写：IB=`ipc-browser-security.test.ts`；IH=`ipc-browser-health.test.ts`；IS=`ipc-settings-security.test.ts`；IP=`ipc-profile-routes.test.ts`；IA=`ipc-agent-routes.test.ts`；IT=`ipc-thin-routes.test.ts`，均在 `tests/unit/`。

## 可复查证据索引

`<root>` = `/Volumes/DevProjectsSSD-74bf68f9/Temp/roxy-lite-cloak-oss/2026-10-18/sync-state-validation-jaolc2oj`。
每个运行目录保留 `summary.json`、`vitest.json`、`vitest.log`；计数以该次回执为准，重叠套件不相加。以下成功专项均无预算违规。
REST/MCP 已按下列 API 最终回执重新冻结并核对当前两份 server hash；较早 hash/coverage **不是最后新增变更后的结果**，不能因目录名含 final/freeze 就沿用。API 专项冻结不替代主会话同源码 build、GUI、完整套件与 coverage 总验收。

| ID | 目录 / 文件 | 实际事实及范围 |
|---|---|---|
| IPC | `ipc-runtime-engine-final-sgq2kq1c/` | 最新 IPC+preload+smoke+RBAC+page-eval，11 文件、192/192，exit 0；非全仓最终。 |
| IPC-旧 | `ipc-final-green-zfhy7s3d/`；`ipc-smoke-consistency-final-4c3_f4kc/` | 分别 97/97、178/178；是较早检查点，不冒充新增 runtime 修复后的最终总量。 |
| S-RED | `ipc-settings-red-sztje3bz/` | 修正原夹具后 12 项中 10 个有效失败：agent-fs 与九个扩展写入口的权限拒绝。 |
| B-RED | `ipc-baseline-red-sx962zwg/`；`ipc-webrtc-gates-red-_2s4sork/` | baseline 原 9 项中 8 失败；WebRTC 启动许可/角色新增两例 RED。 |
| 追加-RED | `ipc-consistency-history-red-_z_fy7a4/`；`ipc-baseline-runtime-red-q94hoc_s/` | 分别 7 个 canonical consistency 失败、3 个实际 runtime/meta 引擎路由失败；后者其余 31 项原实现已通过。 |
| 注册 | `ipc-smoke-wrapper-red-t6by2r_4/` → `ipc-smoke-runtime-green-jllue9ih/` | 原 smoke 71/73，漏报动态 settings 注册；改真实注册验证后 74/74，非补生产假 handler。 |
| API | `task48-truth-final-combined-green-jbvc1ldk/` | 最后既定组合 10 文件、251/251、exit 0：9 个真实 socket 文件 173 项，另 78 项旧 VM/in-memory transport；0 失败/跳过，无预算违规。 |
| API-旧 | `task48-final-green-2r6ttsna/` | 9 文件、147/147、exit 0 的较早专项；不与 API 最终组合叠加为总量。 |
| API-复审 | `task48-truth-boundaries-green-il6d7424/` | 四边界定向 29/29 的中间检查点；最后 `rest-route-safety.test.ts` 已为 31/31，包含在 API 最终 251 项内。 |
| API-RED | `task48-extension-commit-red-v_1_mdma/`；`task48-extension-facts-red-8ltm0atm/`；`task48-conversation-rename-revoke-red-ic_g9a0m/`；`task48-early-response-runtime-fixture-red-buczxhz9/` | 有效 repository commit 后降权/写失败、queued rename 降权及 early-Origin Unhandled 的原生产反例；初版 truth-boundaries 中无效 extension fixture 失败不记漏洞。 |
| AG | `task49-freeze-green-ek3zl0v3/` | 4 文件、95/95、exit 0；真实工具/模型本机夹具、CDP/BiDi wire、文件与 SQLite，不是真实模型或浏览器。 |
| AG-RED | `task49-denied-write-red-bai2vq39/`；`task49-contract-waits-red-hra8trho/`；`task49-cancellation-receipt-red-gl8gqa8z/` | 分别 1、3、1 个有效业务失败；初版 `task49-outcome-red-cd9rvk5h/` 是 ESM spy 夹具错误，不记为产品 RED。 |
| R | `health-renderer-frozen-contract-ja1amuru/` | 1 文件、55/55、exit 0 的 renderer 检查点；后续新增源码用例不因文件存在就计已通过。 |
| H | `health-backend-verification.md`；`health-engine-and-evidence-green-s4t4ybf7/` | 主会话后端台账与 6 文件、126/126、exit 0；DNS/font/ICE/legacy clear/runtime proxy 反例见第六组。 |
| STOP-RED | `stop-lifecycle-red-jo1ppjel/`；`stop-renderer-red-lgfay1il/` | 原 lifecycle 20 项 14 RED；原完整 renderer/两语言 21 项 12 RED，失败回执保留。 |
| STOP-FINAL | `stop-final-boundaries-p6dktx6m/` | 最终 native-close wire/lifecycle/原 launcher/renderer-health/stop/i18n/support 9 文件 651/651、exit 0；不是 native 持久化证明。 |
| NATIVE-SYNC | `health-stop-final-sync-mzaz8t31/`；`health-stop-final-sync-root-82hga67t/sync-state-9D1PLD/` | `8baa1c…` 真实恢复整链 1/1、exit 0、原 receipt=passed；四次不同值立即 stop/restart、SQLite/WAL/ZIP、两端业务读回、合法 member→viewer、原件历史保护。七张 PNG 主已看，另有 visual-review.json；实际 native picker 选择/等待受控。 |
| NATIVE-HEALTH | `health-stop-final-health-vqa3_fkg/`；`health-stop-final-health-root-sm8vxx8v/health-functional-oq6XMD/` | 同 `8baa1c…` 可运行真实健康断言 1/1、exit 0；七张 PNG 主已看，原 receipt 保持 partial-blocked，另有 visual-review.json。真实 Stop 按钮 notice 时 running=true，实际退出后才 Stopped；Firefox 与安全 RTC 正例两项 blocked。 |
| 前轮 | `docs/review/sync-backup-state-2026-10-18.md` | 上轮 5415 通过/1 Windows 跳过、55 深 E2E、1 真实恢复整链等仅作基线，不是本轮验收。 |

复跑入口保持 `python3 <root>/run-tests.py <unique-lowercase-label> --config vitest.config.ts --maxWorkers=1 --reporter=default <明确测试文件>`；本文件不授权自行 build、GUI 或外部网络。

### Task #48 接口最终冻结核对

- 当前 `src/main/services/rest-api-server.ts` SHA-256：`a9a63e52263d4899f67e007b9c3bf461d78895aaa303d2e778064cbd74a89a0e`；当前 `src/main/services/mcp-server.ts`：`6283ed9e437694f8229336426f5eec7b2814f526bcab512e06b1d15a58d2cb86`；均已直接计算并与 owner 回执匹配，不是全应用 build source 指纹。
- 直接核对 API `summary.json` 与 `vitest.json`：173 socket 项之外的 78 项来自 `ui-goal-account-transport.test.ts`，属于旧 VM/in-memory HTTP，只补真实 outcome classifier 白名单，不冒充 socket 或复制 classifier。
- `rest-route-safety.test.ts` 的 31 项包含 BigInt/circular 预 header 序列化、headersSent 后不二次发送（含 early Origin）、MCP 坏 URL=400、下个请求仍成功、排队 body 降权及 post-await commit 事实；owned 两个生产入口 noEmit 检查不等于全仓 typecheck。
- 已用 Python `mode=ro&immutable=1` 独立复查 `SELECT COUNT(*) FROM task48_queued_revoke`：RED `<root>/task48-truth-boundaries-baseline-red-5xh3c2bd/runtime/rest-mcp-task48-M1T3Ce/agent-store.sqlite` 为 1；最终 GREEN `<root>/task48-truth-final-combined-green-jbvc1ldk/runtime/rest-mcp-task48-rGxPWu/agent-store.sqlite` 为 0。不是只检查 HTTP 拒绝回执。
- 下载边界仍受控，但 extension 反例先在 scratch 写有效 repository 文件/config 再返回 receipt；降权为 profileEnable=not-applied，enable-save 失败为 unknown，无 receipt 也不得编造 commit/回滚。没有真实下载、外网代理连通或模型执行验收；最后变更后未重跑 coverage。

## 第一组：配置、启停与批量

| 动作 / 状态 | 入口 | service | 参数 / 权限 | 副作用 / 存储 | reload / search | 显示 | 测试 / 证据 | 未验证边界 |
|---|---|---|---|---|---|---|---|---|
| 列表 / 通过 U、T | `browser:list`、`profile:list`；GET `/api/profiles`；MCP `agent_browser_list_profiles` | `browser-manager.listBrowserProfiles`、`profile-manager.getProfileInfo` | 当前 runtime snapshot；摘要脱敏 | 只读，runtime 信息不等于写盘 | IPC 创建后 reload/list 按 dirId 查 | Profiles 卡片；接口 summary | `ipc-profile-routes.test.ts` 的 `creates, reads, renames and deletes…`；`mcp-business-socket.test.ts`；IPC/API | T 的 native 列表由 fixture 控制；列表逐项失败的所有呈现未覆盖。 |
| 新建 / 通过 U、T | `browser:create`、`profile:create`；POST `/api/profiles` | `browser-manager.createBrowserProfile` | name/seed/platform 校验；IPC 创建许可 | profile 目录与 config metadata | 直接目录/config → reload/get/list | 创建表单/机器错误码 | `ipc-profile-routes.test.ts`；REST `sanitizes profile create options…`；IPC/API | REST/MCP 创建 service 被替换，不能借此证明实际创建/许可全链。 |
| 读取状态 / 通过 T、源码审查 | `browser:status`；GET `…/:id/status`；MCP status | `browser-manager.statusBrowser` | dirId；现有实例状态 | 无持久化 | N/A，查询 runtime | 运行/停止状态 | REST `distinguishes status/stop/delete…`；API | mock 状态不证明真实进程发现及异常退出恢复。 |
| 重命名 / 通过 U | `profile:rename`；PATCH `/api/profiles/:id` | C `setProfileMeta` | dirId、checkout-lock | 局部 metadata，不用旧整份配置覆盖 | 直接 config → reload → `profile:list` | 卡片名称 | `ipc-profile-routes.test.ts` 的 CRUD 与 `existing service checkout…`；IPC | viewer rename 的独立行为矩阵未在这两例中穷尽，不由 delete 的门推断。 |
| 元数据编辑 / 源码审查、部分通过 | `browser:set-meta`；REST profile PATCH | C `setProfileMeta` | lock、字段 sanitizer；未全测角色组合 | 局部字段保存、保留无关字段 | seed/部分字段有 reload；全部字段未覆盖 | Profiles 编辑表单 | `ipc-browser-security.test.ts`；IPC | GPU/屏幕/DRM/appUrl 等字段的逐项 UI 往返不等于 seed 已通过。 |
| seed / RED 已闭合 U | `browser:set-seed`、`cloak:set-seed` | C `setProfileMeta` | 数值校验、已有 checkout-lock | 仅改 fingerprintSeed；拒绝不污染 live config | 文件 → reload → 实际查询 | 原成功/失败回执 | `seed writes use partial validated metadata…`、双 alias lock 用例；IPC | 未开展所有 engine 的实际指纹正确性测试。 |
| checkout 加锁/解锁 / 源码审查 | `browser:set-lock` | B → C `saveConfig`、`recordAudit` | dirId、当前 deviceId；非健康 baseline lock | `meta.lock` 与审计 | 本轮未补独立写/读/越权矩阵 | 卡片 governance badge | B `set-lock`；P 的“外部锁拒绝写”反证不等于此入口验收 | 强制解锁、foreign owner 覆盖及失败回滚未覆盖，不能称权限全面闭合。 |
| 预设/CSV 预览 / 源码审查 | `browser:presets`、`browser:parse-bulk-csv` | `business-presets`、`bulk-import.parseBulkCsv` | 预设及文本格式 | 预览不创建环境 | N/A，只返回 specs | Profiles 新建/导入表单 | 原模块与 smoke 注册；既有 parser 测试不自动算本轮执行 | 所有预设与非法 CSV 的可见表单往返未覆盖。 |
| 批量创建 / 通过 T，边界待主 | `agent:accounts:bulk-create`；POST `/api/accounts/bulk` | A / REST → L、profile 创建 | 角色、每行输入、部分失败 | 逐行账户/环境事实，不把已提交项说回滚 | 账户存储真实；native profile 创建受控 | 行报告、partial | `rest-route-safety.test.ts` 的 `bulk profile creation preserves…`；最新接口闭合待主填 | 不把批量导入一个正例概括全部创建异常。 |
| 单个启动 / RED 已闭合 U | `browser:launch`、`cloak:launch` | B `gatedLaunch` → `launchBrowser` | team → license → 原启动门 | 进程/runtime；失败不得启动 | N/A；测试断言 native 零调用 | paywall/失败码；GUI 待填 | `viewer launch is denied…`、`expired trial blocks single and batch…`；IPC | 启动正例的实际 native 生命周期由主会话验证。 |
| API/MCP 启动 / 通过 T、源码审查 | POST `/api/profiles/:id/launch`；MCP launch | REST/MCP → `launchBrowser` | 各入口现有策略；不自动等同 IPC `gatedLaunch` | 受控 launch receipt | 无真实进程 readback | 保留启动错误/native code | `rest-business-socket.test.ts`、`mcp-business-socket.test.ts`；API | service stub 不能证明许可证/角色/启动门与 IPC 全面对齐。 |
| 打开 Web App / 源码审查 | `browser:open-app` | B `gatedLaunch`、安全 URL、CDP 导航 | 未运行时复用启动门；URL guard | 导航，非健康验收 | N/A | Profiles app 入口 | B `open-app`、注册 alias 实测；IPC | Firefox 导航与实际 app-window 体验未覆盖。 |
| 单个停止 / 受理及状态RED已闭合 U、T、R、G；间歇持久化未闭合 | `browser:stop`；REST stop；MCP stop；原卡片Stop | `browser/lifecycle` → bounded `graceful-close` | entry/child/PID/port归属；boolean仅受理 | 已确认Chromium先尝试Browser.close，必要时才TERM/KILL；活实例不删owner | 516及3f33实验均捕获新值丢失且child exit0/signalnull；最新保留native库独立WHERE联查key/value均0、integrity ok，原business行仍1 | 已受理≠Stopped≠已保存；原warm Stop自动Stopped已实测，不因此保证持久化 | STOP-RED/STOP-FINAL；文末808专项、原失败与正常页面候选的有效失败/撤回；REST/MCP stop false | 现已取得有效失败退出证据；先关闭页面并等targetDestroyed仍不足，候选已撤回。根进程exit/控制回包/页面销毁均不作为SQLite提交证明，具体native提交阶段仍未知。 |
| 批量启动 / RED 已闭合 U | `browser:batch-launch` / cloak alias | B `runBrowserBatch`、`batch-queue` | dirIds/jobId 校验、并发上限、逐项 gatedLaunch | 共享 job reservation；真实逐项 tally | N/A，内存 owner 生命周期 | `batch:progress`、结果计数 | `ipc-browser-security.test.ts` 的重复 jobId、许可、progress 错误；IPC | native 启动受控，不声称多个真实浏览器已启动。 |
| 批量停止 / RED 已闭合 U、R | `browser:batch-stop` / cloak alias | 同一 batch runner → `stopBrowser` | 与启动共享 jobId 空间 | setup throw/finally 只释放自身 | 请求任务完成后同 id 可复用 | summary 明确“停止请求已提交/受理，等待退出”；不是已退出数 | 原 IPC owner/finally + `renderer-browser-stop-state.test.ts` 两语言批量对话框；STOP-FINAL | native 实测仅单个正常停止/重复周期，不把共享 helper 或 R 批量正例说成多个真实浏览器并发退出验收。 |
| 批量取消 / RED 已闭合 U | `browser:batch-cancel` | B active job map | 精确 sender 对象；非猜测 jobId | cooperative cancel；已执行项不回滚 | 后续请求验证 reservation 释放 | 不向已销毁窗口发送 progress | `foreign sender cannot cancel…`、`destroyed owner cancels queued work…`；IPC | 取消请求不是 native 工作已停止的保证。 |
| 软删除 / 通过 U、底层门反证 | `profile:trash` | `trashBrowserProfile` | 已有 team/checkout-lock | 原目录转 trash、metadata 移除 | 原 bytes → reload → trash-list | 回收站；GUI 待填 | `soft delete, restore, permanent purge…`、`existing service checkout…`；IPC | 没有重复添加已有底层 gate。 |
| 恢复 / 通过 U | `profile:trash-restore` | `restoreTrashedProfile` | 已有 team gate；缺项明确失败 | 恢复目录及 metadata | 文件完整性 → reload → profile:get | 回收站恢复结果 | 同上；IPC | 冲突和恢复途中所有失败不由此正例穷尽。 |
| 永久删除 / 通过 U | `profile:trash-purge`、`profile:delete` | purge/delete services | 已有 team/lock；UI 确认独立待验 | 删除指定目录/metadata | 磁盘缺失 → reload/list；缺项失败 | 不显示可撤销恢复承诺 | `ipc-profile-routes.test.ts`；IPC | native typed-confirm 对话框未由单测验证。 |
| Cookie 读写 / 部分通过 U | `profile:cookies/set-cookie/delete-cookie` | `profile-manager` → cookie services | dirId/domain/name；停止时写拒绝 | 本轮主要证据是零 native 写与原数据保留 | 读空/错误返回，不冒充写成功 | Cookie 面板错误 | `invalid IDs/cookie parameters and stopped-profile mutation…`；IPC | 真实 Chromium/Firefox Cookie 写入与恢复留主验收。 |

## 第二组：代理

| 动作 / 状态 | 入口 | service | 参数 / 权限 | 副作用 / 存储 | reload / search | 显示 | 测试 / 证据 | 未验证边界 |
|---|---|---|---|---|---|---|---|---|
| 列出/读取 / 通过 U、T | `proxy:list/get`；GET `/api/proxies`；MCP list_proxies | C `getProxyList/getProxy` | 摘要隐藏密码 | 只读 | 创建后 reload/list；默认无 plaintext | Proxies 列表/hasAuth | `ipc-thin-routes.test.ts` 的 `proxy routes use real CRUD…`；API proxy 测试；IPC/API | 脱敏不等于所有调用者可揭密。 |
| 新增 / 通过 U、T | `proxy:add`；POST `/api/proxies` | C `addProxy` | name/type/host/port 校验；未新加统一角色策略 | config、检测缓存失效 | 磁盘 → reload → 脱敏查询 | 新增成功/输入错误 | IT proxy CRUD、`rest-business-socket.test.ts`；IPC/API | 一般 proxy CRUD 的全角色矩阵未覆盖。 |
| 更新 / 通过 U、T | `proxy:update`；PATCH `/api/proxies/:name` | C `updateProxy` | 缺项/坏 config 拒绝 | 更新配置、必要时清旧检测 | 直接 port 值/HTTP 查询 | 旧记录不能冒充本次检测 | IT、REST `rejects malformed proxy patch…` | rename/I/O 失败的全部内存回滚分支未覆盖。 |
| 重命名 / 通过 U | `proxy:rename` | C `renameProxy` | 重名/default 限制 | 同事务更新 profile/default/fallback 引用 | config 引用 → reload/get-profile | 代理名称/绑定 | IT proxy CRUD；IPC | 所有引用组合和 GUI 搜索保持未穷尽。 |
| 删除 / 通过 U、T | `proxy:delete`；DELETE `/api/proxies/:name` | C `deleteProxy` | default/仍绑定的代理拒删 | 解绑后删除及缓存清理 | 磁盘缺项 → reload/get=null | 不把“仍被引用”显示成功 | IT proxy CRUD；IPC/API | 删除全部原生故障未覆盖。 |
| 默认/环境绑定 / 通过 U | `proxy:set-default/set-profile/get-profile` | C `setDefaultProxyName/setProfileProxy` | named/default/none；缺代理/非法 dirId | config 与 profile 局部字段 | reload → resolveProfileProxy | 卡片选择器；运行中配置不等于已生效 | IT proxy CRUD；IPC | 实际运行路由须读 launch snapshot，不从当前选择器推断。 |
| 文本导入 / 通过 U、T | `proxy:import-text`；POST `/api/proxies/import` | `proxy-import.parseProxyText/importProxies` | 格式/duplicate/replace/每行错误 | 合法行保存、保留失败行 | 磁盘 → reload/list | IPC report；REST partial/skipped/failed | IT `invalid proxy mutations…`；REST `proxy import exposes partial…` | IPC `success:true` 不能单独被解释为所有行成功；显示必须读 report。 |
| CSV 导出 / 通过 U、T | `proxy:export-csv`；GET `/api/proxies/export` | `exportProxiesCsv` | includePasswords 显式请求及 member+ | 返回 CSV；不写目标文件 | 读回文本验证无合成密码 | 脱敏/迁移提示 | IT、REST `retains proxy import failure rows…`；IPC/API | 实际 Save/剪贴板及外部迁移未覆盖。 |
| QR 导出 / 通过 U | `proxy:qrcode` | C secret getter → `qrcode` | 复用 requireAccountSecret；viewer 拒绝 | 返回 data URL/含秘密 URI | PNG data URL；无长期写盘 | 凭据敏感操作 | IT proxy CRUD；IPC | 实际扫码、分享和 native clipboard 未覆盖。 |
| 出口检测 / 源码审查、R 边界 | `detect:proxy/by-name` | `proxy-detect`、`proxy-health` | 缺代理拒绝；真实网络另批 | 检测/健康记录 | R 要求完成后权威重读，失败保留原记录 | 不能把重读失败涂成新 Good | `renderer-health-flows.test.ts` 的 `failed re-read after detect…`；R | 本轮此表无真实外部出口、连通性或 DNS 事务证明。 |
| 健康清除 / 通过 U，R 追加待主 | `proxy:health-get/health-clear` | `proxy-health` | 指定 name 或全体 | 清相应健康历史 | IPC 查询；R 新清除/迟到用例存在 | 重读失败不报清空成功 | IT；R 中 `proxy clear followed by failed re-read…` | 后新增 R case 的最终执行回执由主补，不能沿用旧 55 的计数。 |
| 轮换 / 部分通过 U | `proxy:rotation-info/rotate`；REST rotation/rotate | C rotation info、`recordProxyRotation` | 找不到明确失败 | 有 fallback 时记事件；不声称重启进程 | 返回选择与历史；运行路由见 H | 活跃/原因 badge | IT `proxy routes use real CRUD…`；IPC | 无 fallback 的 success 是已计算状态，不是出口已切换；真实切换未验。 |

## 第三组：账户

| 动作 / 状态 | 入口 | service | 参数 / 权限 | 副作用 / 存储 | reload / search | 显示 | 测试 / 证据 | 未验证边界 |
|---|---|---|---|---|---|---|---|---|
| 列表/检索 / 通过 U、T | `agent:accounts:list/get`；GET `/api/accounts`；MCP list_accounts | L account snapshot、`config/store` | ref/index/revision；ETag；摘要无密码 | 只读 detached snapshot | reload/list、按 username/profile 检索 | Accounts 选择引用 | IA `account CRUD…`；`rest-account-socket.test.ts` 的 `lists an exact opaque ETag…`；IPC/API | 不把 REST opaque ETag 当业务 ID。 |
| 新增 / 通过 U、T | `agent:accounts:add`；POST `/api/accounts`；工具 add | L account writer → C transaction | member+、字段规范化 | 加密 v2 config、revision 轮换 | 密文检查 → reload → HTTP/IPC 查询 | 无 plaintext 摘要 | IA；REST `creates and patches through disk…`；AG local tools | 仅隔离 file vault，不调用真实 Keychain。 |
| 更新 / 通过 U、T | `agent:accounts:update`；PATCH `/api/accounts/:index` | L writer、`transactAccounts` | 精确 ref；REST 强 If-Match；坏字段拒绝 | 只修改选中的当前集合项 | 直接字段/密文 → reload → 新 ref 读 | 冲突需重选，不能自动重试 | IA；REST malformed patch/queued-body demotion；IPC/API | UI 冲突实际可见交互待主；测试不能靠重取 ref 掩盖过期。 |
| 删除 / 通过 U、T | `agent:accounts:delete`；DELETE `/api/accounts/:index` | 同上 | 缺 ref=428、非法=400、stale=412、缺项=404 | 不得删到移位后的另一账户 | 磁盘集合 → reload/list | stale 明确拒绝 | `rest-account-socket.test.ts` 的 `returns 412 for a stale reference…`；IPC/API | 不将全局 409 套用到账户 412 契约。 |
| 绑定环境 / 通过 U | `agent:accounts:bind/profile`；工具 update_account | L → current account transaction | current ref、profileIds 校验 | profileIds 存储 | 直接 config → reload → profile 查询 | Accounts/Profiles 关联 | IA `account CRUD, binding and clipboard…`；AG local | 所有 deleted-profile 清理/跨窗口表单状态未覆盖。 |
| 复制用户名 / 通过 U | `agent:accounts:copy-username` | L ref read → Electron clipboard | current ref | 仅 clipboard 边界 | 校验实际传给 native 的文本 | 复制反馈 | IA account CRUD；IPC | 未读写真实系统剪贴板。 |
| 复制/揭示密码 / 通过 U、T | `agent:accounts:copy-password`；GET `…/:index/password` | L secret getter | member+、current ref、no-store | 解密仅用于响应/clipboard | fixture 合成密码精确读回 | 敏感读取，不进摘要 | IA viewer deny；REST missing password/ref/role；IPC/API | 真实用户凭据与 Keychain 均不在范围。 |
| 批量导入 / 通过 U、T | `agent:accounts:bulk-add/bulk-create`；POST `/api/accounts/bulk` | parser → 实际账户 store | 空文本/坏行/角色/逐行报告 | 保存成功项，不吞失败项 | 磁盘 → reload/list；有效行可检索 | partial 与 failed 保留 report | IA `bulk account parse failures…`；REST import completion tests | 真实 native 环境创建不由账户持久化正例证明。 |
| 并发/拒绝 / 通过 T | REST PATCH/DELETE/password | `config/store` reference gate、team | 排队 body 后再次查角色 | 403/412 不改变现有 bytes | 比较原始文件及 reload/list | 不把“选中 index”当授权 | `rechecks the actual team gate after a queued body…`；API | 全进程多 writer CAS 不在单进程 config store 保证内。 |

## 第四组：扩展与技能

| 动作 / 状态 | 入口 | service | 参数 / 权限 | 副作用 / 存储 | reload / search | 显示 | 测试 / 证据 | 未验证边界 |
|---|---|---|---|---|---|---|---|---|
| 仓库/启用列表 / 通过 U、T | `settings:extension-repository/extensions/profile-extensions`；REST repository/profile extensions；MCP list | `extension-repository`、C enabled map | profile/ID 校验，缺项非空目录假成功 | 只读 | 本地安装后 search/reload | Extensions 列表、环境选择 | IS `real local install, metadata edits…`；REST missing profile test；IPC/API | T 仓库 service 常被 fixture 替换，不等于实际解析所有 CRX。 |
| 商店添加 / RED 已闭合 U；通过 T | `settings:add-repository-extension`；POST `/api/extension-repository` | `addOrUpdateChromeStoreExtension` | settings member+ 在下载/I/O 前 | 拒绝零副作用；允许路径下载边界受控 | 拒绝对比 bytes | 不把拒绝当安装完成 | IS 九入口参数化；REST viewer repository tests；S-RED/IPC/API | 未进行真实商店下载/签名更新验收。 |
| 仓库更新 / RED 已闭合 U；通过 T | `settings:update-repository-extension`；POST `…/:id/update` | `updateRepositoryExtension` | 同上；ID/实体 | update receipt 与错误 | 拒绝未写；真实下载成功未测 | update 错误回执 | IS、REST repository branches；S-RED/IPC/API | 网络/CDN/版本回退均未由 stub 成功证明。 |
| 仓库删除 / RED 已闭合 U | `settings:delete-repository-extension`；REST DELETE repository | `deleteRepositoryExtension` | settings member+ | 指定 entry/相关存储删除 | 真实 local entry 删除 → reload/search 缺项 | 列表删除 | IS local install case；IPC | 运行浏览器已加载扩展卸载不是此动作承诺。 |
| 元数据 / RED 已闭合 U | `settings:set-repository-extension-meta`；REST PATCH repository | `setRepositoryExtensionMeta` | settings member+、shared/tags | config 仓库字段 | 直接 config → reload/search | tags/shared | IS local install case；IPC/API | 所有标签边界和远端同步由其他专项负责。 |
| 本地安装 / RED 已闭合 U | `settings:install-local-extension`；REST local | `installLocalExtension` | gate 在读路径/暂存前 | 真实合成 unpacked extension 导入 | metadata/文件 → reload → filter search | 安装成功/失败 | IS `real local install…`；IPC | 原生文件选择器、所有 CRX/ZIP 依赖分支未覆盖。 |
| 文件/目录选择 / 通过 U | `settings:pick-extension-file/dir` | Electron dialog | 取消明确 null | 不导入、不写仓库 | N/A | 取消不显示安装成功 | IS `extension picker cancellation…`；IPC | 实际 native dialog 未打开。 |
| 为环境安装 / RED 已闭合 U、T | `settings:install-extension`；REST profile install；MCP install | repository commit → C enable | 预下载门；REST/MCP await 后再查角色 | 受控下载先真实写 scratch repository/config；与 enable 非同事务，保留 partial/unknown | 实际 bytes/config → reload；denied 不 enable、save 失败状态 unknown | 不声称仓库已提交项被回滚 | IS；`rest-route-safety.test.ts` post-await demotion/enable-save/no-receipt 用例；API-RED → API 251 | 仅受控 scratch 提交/回执；不证明真实下载或浏览器扩展加载。 |
| 开关/环境移除 / RED 已闭合 U | `settings:toggle-extension/delete-extension/set-profile-extensions`；MCP delete | C normalized map | settings member+、entry/dirId 校验 | 仅环境 enabled map；非删除仓库原件 | 直接 enabled → reload/profile query | 开关状态 | IS 九入口及 local case；MCP allowed/delete；IPC/API | 热加载/重启后浏览器实际呈现不在 unit 范围。 |
| shared 导入/导出 / 通过 U、源码审查 | settings shared export；`agent:skills:export-shared/import-shared` | extension/skill repository | shared 选择与格式；沿用原策略 | 导出引用，合法技能可写入 | 技能有 reload/filter；扩展发布见前轮 | shared 标记 | IA `skill repository operations persist…`；IPC | 所有跨设备依赖缺失情形未覆盖。 |
| 技能新增/编辑/删除 / 通过 U、T | `agent:skills:add/set-meta/remove`；REST skills CRUD | `skill-repository` | 已有 settings-role gate、ID/内容验证 | skill repository/config | 磁盘 → reload/filter → 删除缺项 | Skills Hub | IA skill case；REST `persists local skill CRUD/install…`；IPC/API | 不代表模板中的外部业务步骤已经执行。 |
| 技能安装/启用 / 通过 U、T | `agent:skills:install`；REST skills install；MCP skill_install | `installSkill` | viewer 不得 enable；缺项明确 | 真实本地技能 enabled | reload/query | 成功是本地启用 | IA；MCP `viewer skill_install cannot enable…`；IPC/API | 无真实 marketplace 下载，也不保证技能依赖已具备。 |
| 平台适配器 / 通过 U、T | `platform:adapters:list/adapter:get/adapter:detect`；REST/MCP catalog | `platform-adapters` | URL/catalog 匹配，缺项 null/404 | 无浏览器执行 | N/A，真实 catalog 返回 | 模板/适配器选择 | IA `platform catalog routes…`；API | “匹配到”不是目标站登录/业务执行通过。 |

## 第五组：同步与 ZIP

此组保留前轮 frozen snapshot、owner/token、原件/新 ID 历史隔离成果，不将本轮 transport 覆盖写成重新完成真实 S3/恢复整链。

| 动作 / 状态 | 入口 | service | 参数 / 权限 | 副作用 / 存储 | reload / search | 显示 | 测试 / 证据 | 未验证边界 |
|---|---|---|---|---|---|---|---|---|
| 状态/预览 / 通过 U、T | `sync:status/preview/preview-diff`；GET `/api/sync/...` | Y → `syncService` | comparison token 原样保留 | 只读快照/候选比较 | 权威状态及 profile sync facts | Sync 与卡片 governance，不称独立备份完备 | IT sync read；`rest-sync-archive-socket.test.ts`；前轮/API | T sync service 被控制，不证明真实远端内容。 |
| 配置 / 通过 U | `sync:configure` | C `setSyncConfig` | settings member+、endpoint/consent | 合成 config；viewer 零写 | bytes → reload/config query | 设置错误码 | IT `sync read/rejected configuration…`；IPC | 不写真实 S3、不读取用户 cloud secret。 |
| push / 通过 T、保留前轮 | `sync:push`；POST `/api/sync/push` | `syncService.push` | force 必须显式 true、opaque token | frozen publication、partial/unknown receipt | 本轮仅 transport；真实存储见前轮 | scope/reasons/warnings/operation 不降级 | REST `invalid JSON never starts a sync…`、receipt 参数化；API/前轮 | 坏 JSON 不可触发默认 push；真实远端验收待主。 |
| pull/冲突决策 / 通过 T、保留前轮 | `sync:pull`；POST `/api/sync/pull` | `syncService.pull` | strategy/resolutions/token；拒绝陈旧决策 | 保留逐项 committed/recovery 事实 | snapshot/SQLite 证据属前轮 | 不把 partial 变 completed | REST `pull passes opaque comparison token…`；API/前轮 | 外部锁/远端并发所有组合不能由控制 receipt 证明。 |
| 状态事件 / RED 已闭合 U、源码审查 | `sync:state-changed` → preload on/removeListener | event-bus、Y、preload WeakMap | channel+callback；allowlist；sender 去能力 | 不产生同步写 | 独立退订/重复幂等 | UI 同步代际失效；健康迟到隔离另测 | `preload-subscriptions.test.ts`；IPC | 实际多窗口事件/GUI 刷新待主，不关闭用户实例。 |
| 单 ZIP 导出 / 通过 U、T | `profile:export-archive`；POST `/api/profiles/:id/export` | `exportProfileArchive`、archive-path-guard | path、overwrite 显式同意；角色由底层 | 真实合成 ZIP；不默认覆盖原件 | PK/目标 bytes、二次拒绝原件不变 | completed/cancelled/error | IP `archive IPC preserves explicit overwrite…`；API/前轮 | REST ZIP 是 transport stub；native Save 待主。 |
| 单 ZIP 导入 / 通过 U、T | `profile:import-archive`；POST `/api/profiles/import` | `importProfileArchive` | 合法 ZIP 路径、角色；坏 body 不走默认 | 新 dirId/profile bytes；历史保护属前轮 | 文件 → config → reload/profile:list | warning 与 outcome 保留 | IP 同例；REST `preserves archive path/recovery failures…`；IPC/API/前轮 | 不用新 ID 带入旧健康/同步凭据；全安全故障见前轮专项。 |
| 批 ZIP 导出 / 通过 U、T | `profile:export-archives`；POST `/api/profiles/export` | `exportProfileArchives`、conflict discovery | 非空数组、逐个合法项、具体 overwrite paths | 逐项 report；不得过滤坏项后假全成功 | 实际合成文件/原件；T 只核回执 | 部分完成与取消不同 | IP `batch archive routers preserve…`；API | 未把 bulk 一个完成正例概括所有恢复/CRC 场景。 |
| 批 ZIP 导入 / 通过 U、T | `profile:import-archives`；POST `/api/profiles/import-batch` | `importProfileArchives`、batch classifier | 拒绝混合/空 batch | 成功项保持；失败/取消有明细 | config/profile:list 与 report 一致 | partial/unknown/recovery 原样 | IP batch case；REST `retains partial batch import reports…`；IPC/API | 实际损坏包、路径/CRC/history 安全链见前轮，不由 stub 证明。 |
| Cookie/扩展/SQLite 快照 / 源码审查、保留前轮 | 同步/ZIP 生产 capture | portability、cookie、sqlite-local-storage、zip-writer | snapshot ownership、停机/活机规则 | 原件不改；一致快照再发布 | 独立 DB/WAL/bytes 证据属前轮 | 不承诺备份所有机器状态 | 前轮文档及 `cookie-export-snapshot.test.ts`、`extension-sync-snapshot.test.ts` | 本轮当前源码下复跑九组深 E2E/真实恢复整链待主填。 |

## 第六组：七个健康菜单及共同生命周期

可见菜单以 Profiles `health-select` 原代码为准：`drift / lock / consistency / env / webrtc / risk / history`。下列审查状态不是 UI 的业务 outcome。

| 动作 / 状态 | 入口 | service | 参数 / 权限 | 副作用 / 存储 | reload / search | 显示 | 测试 / 证据 | 未验证边界 |
|---|---|---|---|---|---|---|---|---|
| 1 漂移检测 / RED 已闭合 U、R | `browser:check-drift` / cloak；REST drift | `checkFingerprintDrift`、H lease/record | dirId、sender owner、实际 runtime engine | **不改 baseline**；canonical kind=drift | summary 文件 → reload/history | 无基线 unavailable；probe error 不判 missing-baseline；仅完整无漂移可 pass | IH `drift without a prior baseline…`、`a live drift probe error…`；R；IPC | REST bare drift 与 IPC summary 编排不同；consumer 最终组合由主补。 |
| 2 锁定基线 / RED 已闭合 U、R | `browser:capture-baseline` / cloak；preload captureBaseline | `captureFingerprint`、C partial write、H | member+、checkout-lock、sender；单次 5 分钟 token 绑定旧/新/配置/PID/port | 风险先 review，不写；确认才存；history 另事务 | actual config → reload → health-history | baseline-established 非 PASS；接受风险仍 risk；已提交后 history 失败显示 warning | IH 风险/锁/并发/过期/空快照、`native audit EACCES…`、3 runtime/meta case；R；B-RED/追加-RED/IPC | native wire 不是真实指纹测量 oracle；audit 候选反证见第九节。 |
| 3 四字段对齐 / RED 已闭合 U、R | `browser:consistency-check/consistency-preview` | `consistency-check`、cached proxy、H | 原 string dirId；viewer 诊断读权限保留 | canonical kind=consistency；不测实时出口 | 磁盘 → reload/query；metadata 不改 | 无冲突 inconclusive/source=cached；stored warning/blocker=warn/risk | IH `cached consistency IPC canonical history` 七例；R `cached four-field alignment…`；追加-RED/IPC | preview 不保存；cached alignment 不可升格实时 pass。 |
| 4 环境检测 / RED 已闭合 U、T、R | `browser:env-risk` / cloak；GET `/api/profiles/:id/env-risk` | H → `environment-risk`、page-eval | requestId/owner/signal；runtime engine；真实 runtime entry PID/port+fresh-launch receipt 故意与 current config 不同 | env detail+canonical 同事务；停止时 host-only；missing/adopted 不假 pass | 直接文件 → reload → requestId/历史查询 | runtime/host 来源明确；未测不假绿；卡片刷新不丢搜索/选择/草稿 | `health-environment-orchestration.test.ts`；`rest-health-socket.test.ts` 6 项；R；H/API | 单项环境/CDP 测量受控；真实 DNS/字体/rAF native 验收另验，配置证据非路由证明。 |
| 5 WebRTC / RED 已闭合 U、R；真实正例 blocked | `webrtc:diag`、history/clear | `webrtc-diagnostics` → page-eval/CDP/BiDi | 停止时显式 allowLaunch；IPC gatedLaunch 后 service 固定 false | 严格 ICE、detail+canonical 同事务 | 原始 candidate/summary → reload → 两种历史 | error/N/A/inconclusive/cancelled 不由空 hostIps 判 PASS；null RTT=未测 | IH、IB 启动门、`health-diagnostics.test.ts`、R；IPC/H | 默认 probe 带外部 STUN；未有获准安全边界的真实正例单独 blocked，不伪造 RTC/延迟通过。 |
| 6 外部检测 / 通过 R、源码审查 | `browser:open-risk-check` / cloak | safe URL → gatedLaunch → CDP navigate | 第三方访问同意；停止时再确认启动 | **只导航**，不写评分/健康 pass | N/A，无评分持久化 | “已打开”不是 Ping0 已通过 | R `Ping0 consent only navigates…`；B `open-risk-check`；R/IPC 注册 | 未访问真实 Ping0；当前路由仍 CDP，Firefox 外站导航不据此认定已验证。 |
| 7 历史 / RED 已闭合 U、R | `browser:health-history` / cloak；raw env/RTC history | H `listProfileHealthHistory`、C getters | dirId；读不改变 evidence | canonical 最多 20；legacy 不升格 pass | 直接文件 → reload → kind/requestId 检索 | 权威结果优先；legacy/unknown；读失败保留旧缓存并显示未验证 | IH history、R `main history overrides…`、`a failed history read…`；IPC/R/H | renderer localStorage 只是缓存，不能作为 main 已提交的证明。 |
| 请求取消 / RED 已闭合 U、R | `browser:health-cancel`；REST disconnect | H cancel + lease | dirId+kind+requestId+sender；不能自报 owner | 只 abort；底层未 settle 不释放 slot、不写迟到成功 | 旧 bytes 不变；settle 后可新请求 | accepted≠已停止；超时显示未确认 | IH `health cancellation binds…`、`cancelled native work keeps…`；REST disconnect；R；IPC/H/API | 不终止用户浏览器；无法立即取消的 native 操作须等 settle。 |
| 清除 env/RTC / RED 已闭合 U、R | env-risk-clear、webrtc:diag-clear；旧 clear exports | H → C atomic clear | 先失效匹配 kind/owner，再移除 detail+summary | 不清其他 kind；迟到不得复活 | 文件 → reload → history；失败旧 bytes 保留 | 成功重查后刷新；失败不画空记录 | IH、H `the retained config clear export…`、R clear fencing；IPC/H/R | 旧 API clear 也不能绕开 lease；后续新增 R 情形待主统一回执。 |
| 导出诊断报告 / 通过 R、边界待主 | Profiles env/RTC export | 读取保留 raw evidence → download intent | 不重新运行 host/RTC probe | 原记录保持；下载意图不是磁盘落盘完成 | R 检查 raw 原文，实际目标文件待 GUI | 读失败非“成功空报告” | R `report export does not rerun…`、`exports the exact retained raw evidence…` | 新增 case 的最终回执及真实下载文件由主补。 |
| 双引擎 dispatch / RED 已闭合 U | baseline capture、page-eval、env/RTC | `getProfileEngineByDirId` 优先 getEntry | runtime Chromium/Firefox/legacy 与保存 intent 不同时仍用实际 engine | 不回写 engine intent；保存对应诊断 | capture baseline→reload/history；native URL/method 断言 | 不以改设置等同进程重启 | IH 三例 RED 31/34 → IPC 192/192；`health-page-eval.test.ts` 8 例 | Firefox wire fixture 不等于已用真实 Firefox 证明全部菜单。 |

### 后端复审逐项反例（主会话台账，非 GUI 结果）

| 反例 / 状态 | 具体源码 / 测试 case | 原始 RED → 保留 GREEN | 未升级的边界 |
|---|---|---|---|
| raw host IP 被空投影隐藏 / RED 已闭合 | `webrtc-diagnostics.candidateEvidence`；`health-diagnostics.test.ts` / `does not trust an empty hostIps projection…` | `health-review-red-2f9e8csf/` 七例之一 → H 126 | raw candidate 有地址必须 risk，不依赖已派生数组。 |
| 截断 ICE candidate / RED 已闭合 | 同文件 / `does not count a truncated candidate as usable ICE evidence` | 同上 → H 126 | grammar 错误不作完整 clean evidence。 |
| 旧 clear 复活历史 / RED 已闭合 | C clear exports/H hook；同测试 / `the retained config clear export…` | 同上 → H 126 | 所有旧公开清理入口须失效匹配在途请求。 |
| macOS 字体误报已隔离 / RED 已闭合 | `environment-risk.ts`；`health-environment-orchestration.test.ts` / `does not label observed macOS font exposure…` | 同上 → H 126 | 观察到跨平台字体不是隔离保证；探测失败不是“无字体”。 |
| DNS 三个未知/本地地址假确证 / RED 已闭合 | 同文件 / `does not infer an upstream resolver identity from %s`：127.0.0.53、192.168.1.1、9.8.7.6 | 同上三个参数例 → H 126 | prefix/table hint 不确认实际 upstream，启动代理设置也不是 DNS transaction。 |
| 已运行 direct 被当前 proxy intent 替换 / RED 已闭合 | H；同测试 / `does not substitute an edited proxy configuration…` | `health-running-route-red-08sjfpjv/` 三例之一 → H 126 | 仅 fresh launch mode/type/source 可归因，不保存路由身份/凭据。 |
| adopted 进程补造 launch evidence / RED 已闭合 | 同测试 / `leaves the launch proxy unverified for an adopted process…` | 同上 → H 126 | 缺快照维持 unknown，不拿当前配置倒填。 |
| 相同 PID/port 换 runtime entry / RED 已闭合 | 同测试 / `invalidates a late result when the runtime entry changes…` | 同上 → H 126 | object/BiDi owner 变化仍失效，不能只比较数字。 |
| srflx related address 漏检 / RED 已闭合 | `health-diagnostics.test.ts` / `retains a local related address exposed…` | `health-related-address-red-tkvf8ko6/` 一例 → H 126 | raddr/rport/tcptype 校验，不把关联本地地址漏成 pass。 |
| engine intent 与 runtime 不符、placeholder IP / RED 已闭合 | `health-page-eval.test.ts` 三例；health diagnostics 的 `keeps a placeholder address…` 两例 | `health-dispatch-placeholder-red-bpw62g95/` 五例 → H 126 | 0.0.0.0/:: 不是 clean 或暴露的有效证据；初轮 mock 缺项不算新漏洞。 |

七例复审 = host/截断/旧 clear/font + 三个 DNS 参数；另三例 runtime proxy/entry，加一例 related address。它们在后续 GREEN 中有重叠，不将次数相加为独立测试总量；更完整原始命令见 `<root>/health-backend-verification.md`。

## 第七组：自动化与 Agent

| 动作 / 状态 | 入口 | service | 参数 / 权限 | 副作用 / 存储 | reload / search | 显示 | 测试 / 证据 | 未验证边界 |
|---|---|---|---|---|---|---|---|---|
| 规则新建 / 通过 U、T | `automation:create`；POST `/api/automation/rules` | automation-rules → config | trigger/action/cron；既有角色 | disabled/once 合成规则保存 | config → reload/list 按 id | 规则列表 | IT `automation rules persist…`；REST rules case；IPC/API | 规则存在不等于真实时钟/浏览器任务已触发。 |
| 规则更新 / 通过 U、T | `automation:update`；REST PATCH | 同上 | id、schema、viewer deny | 更新指定规则 | 文件 → reload/list 新名称 | 编辑反馈 | 同上；IPC/API | 所有 reschedule 与运行并发未穷尽。 |
| 规则删除 / 通过 U、T | `automation:delete`；REST DELETE | 同上 | 缺项/角色 | 删除项；缺项 false | 文件 → reload/list 缺项 | 删除结果 | 同上；IPC/API | 不用“删除”推断正在运行的任务已取消。 |
| cron/重排/调度状态 / 部分通过 U | validate-cron、reschedule-once、schedule-state/reconcile | `automation`、scheduler | 非法 cron/过期时间失败 | 本轮以拒绝和状态读取为主 | config 不误改；state/log 查询 | schedule 状态 | IT automation case；IPC | 真实 timer/系统休眠恢复最终回归待主。 |
| 试跑 / 通过 T 拒绝、源码审查 | `automation:test-run`；REST `…/:id/test-run` | `automation.testRunRule` | viewer 在调度前拒绝 | 拒绝无 scheduler/store 副作用 | bytes 对比 | 错误非试跑成功 | REST `viewer automation mutations and test-run…`；API | 成功试跑 native browser 未由 T stub 证明。 |
| 重试 / 通过 U | retryAgentRun；REST `/api/runs/:id/retry` | `automation` → 实际 agent run | 原 run 可重试；新 run lineage | 新 runId/retryOf；不借旧变量；真实本地 artifact | config → reload/list run → read_file needle | 终态 verification 保持 unverified | `agent-tool-outcomes.test.ts` / `creates new run lineage…`；AG | 模型为本机合成响应，不是业务成果正确性证明。 |
| job 取消/查询 / 通过 U、T | automation jobs/job-cancel；REST jobs/cancel | `job-store`、running cancellation | 缺项/角色；真实队列状态 | jobs.sqlite status=cancelled | 独立 DatabaseSync → reopen → job-get/list | cancelled 不是 completed | IT `automation job cancellation…`；REST durable queue；IPC/API | 正在执行的 native job 是否停止另需真实生命周期证据。 |
| 通知已读 / 通过 U | automation notifications/read/unread-count | `job-store` notification table | dedupKey 与 read 状态 | 真实队列/通知记录 | 查询 unread 1→0 | badge 与历史 | 同 IT case；IPC | OS banner/sound 未调用，不能声称系统通知已发。 |
| 会话 CRUD / 通过 U、T | agent conversations；REST/MCP conversations | `agent/conversation-store` | id/title、写角色 | agent-conversations.json | 直接 JSON → fresh load/list/get → delete 缺项 | literal/default title，run metadata 权威 | IA conversation case；REST/MCP stores；IPC/API | 接口 chat 使用 model stub 的 case 只证明 transport/终态。 |
| 模型配置 / 通过 U、T | agent llm config/save；REST PUT config | L config、secrets file backend | 字段/角色；查询脱敏 | 合成 secret 加密 | 密文检查 → reload → redacted query | 有配置不宣称模型可用 | IA `saved configuration is encrypted…`；API config tests | 不扫描或调用真实用户模型/凭据。 |
| 审批拒绝事实 / RED 已闭合 U | desktop/local `agentChat`；MCP tools/call | L → `agent/tool-outcome.classifyAgentToolOutcome`、recorder | 合法 tool contract、真实 pending approval | deny/skipped/cancelled 步骤 ok=false | config steps → reload/getRun；事件一致 | 模型 endReason=completed 不覆盖失败步骤 | AG `records an approval-denied HTTP write…`、`records cancellation during approval…`；AG-RED | 不递归把 SQL rows/body/value 中业务 error 字段误判为执行失败。 |
| 浏览器工具 / 通过 U | executeToolCall browser_*；MCP passthrough | L → CDP/BiDi | browser scope、元素/输入参数、managed session | 原生产协议派发；不启动真实浏览器 | method/参数/owned session cleanup 断言 | wait found=false、loaded=false、errorText 必须失败 | `agent-tool-browser.test.ts`；`agent-tool-outcomes.test.ts`；AG | native wire fixture 不是网页可用性/实际视觉验证。 |
| 文件工具 / 通过 U | read_file/write_file | L file sandbox/allowlist | size/path、阻 sibling-prefix/越界 | 合成文件实际 bytes | 直接磁盘 → reload → read/search | error/skipped 不记成功 | `agent-tool-local.test.ts` / `writes real bytes…`、`uses only declared synthetic allowlist…`；AG | 不跟测试 symlink 访问外部文件、不测试用户目录。 |
| SQLite / 通过 U、T | agent-db IPC；REST db/query/exec；MCP db tools | `agent-db`、approval | member+；只读/危险 SQL 审批 | 真实隔离 SQLite | 独立只读 reader → close/reopen → SQL 条件检索 | 表查询业务 error 列不算工具失败 | IA `agent DB write is independently verified…`；AG local；API | 任意数据库引擎或扩展不在 SQLite 验收内。 |
| HTTP 工具 / 通过 U | http_request | L HTTP/SSRF guard、approval | pinned DNS/Host、size、redirect、写审批、abort | 受控已登记 transport，不外网 | 响应与拒绝零 dispatch | 失败/取消明确，cookie 脱敏 | AG local `preserves pinned destination…`、`cancels in-flight requests…` | 本机模型 fixture 是真 socket；HTTP 目标 wire 不等于外部服务访问。 |
| run 变量 / 通过 U；MCP 缩窄 | set_var/get_var；MCP tools/list/call | per-run variables、MCP advertised catalog | 必须合法 runId；独立 MCP 不公布 run-local 工具 | 仅 run 内 raw 值；终态清理；持久化脱敏 | 并发隔离/terminal/reload 检查 | 无上下文明确不可用 | AG local `isolates concurrent run variables…`；`mcp-tool-outcomes.test.ts`；AG/API | 不虚构全局 runId，不把 standalone 禁用误称 run 内功能删除。 |
| 成果/导出/删除 / 通过 U | agent-run list/get/results-preview/export/delete/clear | run-recorder、run-result-store | runId/kind、viewer 拒绝、dialog cancel | 真实 summary/artifact 文件及 traces | bytes → reload/get → independent preview | 无成果不显示成功空导出；verification 独立 | IA `run traces/list/summary export…`；AG artifact case；IPC/AG | native Save、完整 GUI 下载和真实业务成果待主。 |

## 第八组：设置与权限 / 跨入口协议

| 动作 / 状态 | 入口 | service | 参数 / 权限 | 副作用 / 存储 | reload / search | 显示 | 测试 / 证据 | 未验证边界 |
|---|---|---|---|---|---|---|---|---|
| 文件访问模式 / RED 已闭合 U | `settings:agent-fs-get/set` | S → C normalizeAgentFs | member+ 在解参/I/O 前；malformed viewer 也拒绝 | sandbox/allowlist 合成 config | 直接 bytes → reload → get | 安全设置/拒绝 | IS `viewer cannot expand agent file access…`、`member writes agent file access…`；S-RED/IPC | 不新增任意用户路径授权。 |
| 启动安全门 / 通过 U，既有 gate | settings launch-gates get/set | S → C | requireSettingsMutation；仅布尔字段 | config 四门、保留无关字段 | disk → reload/get | 开关不是检测通过证明 | IS；`settings-launch-gates-rbac.test.ts`；IPC | 各门与真实 native 启动组合由主验收，不因写开关通过而推断。 |
| 通知偏好 / 通过 U、源码审查 | automation-notify get/set | S → C | 布尔规范化；此路由未新增统一 RBAC | automationNotify | disk/reload/query | system/sound 偏好 | IS `launch gates and notification settings…`；IPC | 不将 launch-gates 的 role 正例套用于通知偏好；角色负例未覆盖。 |
| 书签 / 通过 U | settings bookmarks/add/write | `launch-args.read/writeBookmarks` | profile file path；角色矩阵本轮未测 | 真实合成 Default/Bookmarks | JSON bytes → reload/read → URL 检索 | 书签设置 | IS `bookmarks and preference routes…`；IPC | helper 直接文件写；不宣称有与扩展相同 member/checkout gate。 |
| Preferences / 通过 U | settings preferences/update/apply-profile | `launch-args` read/write/apply | profile 路径；homepage/download 等字段 | 真实合成 Preferences | bytes → reload/read 指定字段 | 设置表单；native 生效另验 | 同 IS case；IPC | 整体 schema/写失败/运行浏览器缓存冲突及权限未覆盖。 |
| 团队 roster / 通过 U、T | team status/init/member/role/rename/enabled | `team` → config | 现有 owner/admin/member/viewer 策略；非法 role | 真实 roster | config → reload/status；viewer 拒绝 bytes 不变 | 设置角色 | IT `team mutations persist…`；REST team case；IPC/API | 不等于对每一个薄 IPC 写入口已枚举所有角色。 |
| 人工审批 / 通过 U、T | approval list/resolve；REST/MCP resolve | `approval-gate` | IPC trusted sender+confirmed+exact decision；远程不能自批 allow | 真实 pending promise resolve/deny | pending list 清空；无目标 I/O | 明确拒绝/取消 | IA `approvals need confirmation…`；API approval tests；IPC/API | 原生 UI 可信发起流程待主。 |
| REST 生命周期 / 通过 U、T | api status/restart/reveal-token；start/stop REST | 原 REST server | loopback/动态端口、ready；token reveal 原策略 | T 真 socket；U lifecycle native server 替代 | restart/status/后续有效请求 | 服务 running 不是业务健康 | IT api lifecycle；REST trust/lifecycle；IPC/API | U 不是真绑定；真实端口冲突/长期运行由主确认。 |
| MCP 生命周期/SSE / 通过 U、T | mcp status/restart；`/sse`、`/mcp` | 原 MCP server | token、Origin、session 关联 | 真 SSE 连接/响应/teardown | malformed 后下个合法请求、SSE id 关联 | MCP connected 非诊断 pass | `mcp-transport-validation.test.ts`、`uses an actual SSE connection…`；API | `/` 保留 initialize-only；不擅扩为第二个 tools endpoint。 |
| HTTP 鉴权 / 通过 T | REST GET `/health`、`/openapi.json`；MCP `/health`；其余保护入口 | server trust/auth boundary | public 无 token 200；无/错 token 401；foreign Origin 403；query token 非授权 | 错请求不落业务写 | 真 socket 请求与下一请求 | 错误码，不造空成功 | REST `serves only declared GET public endpoints…`；MCP `keeps health public…`；API | OPTIONS 是协议预检；REST `/version` 并非公共豁免。 |
| JSON/异常边界 / RED 已闭合 T | REST body/routes；MCP JSON-RPC | readBody/readJson、invalidMcpRequest、outer catch | null/数组/标量、method/name/params、超限/断流；readBody await 后复查原角色 | 非对象不授权默认写；BigInt/circular 在 header 前失败；headersSent 后不重发 | 后续合法请求成功、无 Unhandled；queued SQLite 拒绝写 1→0 | 400/413/JSON-RPC error 非成功；坏 URL=400 | MCP transport；REST sync/archive body；`rest-route-safety.test.ts` 31/31；API-RED → API 251 | 包含 early-Origin 响应失败；只证明该组合，owned noEmit 不代替全仓类型/GUI。 |
| preload 事件 / RED 已闭合 U | on/removeListener allowlisted channels | `src/main/preload.cjs` | callback+channel；非法 channel 拒绝；去 Electron event | WeakMap 多 channel wrapper，无 orphan | 分别退订/幂等注册 | sync/approval/progress 等订阅互不串扰 | `preload-subscriptions.test.ts` 六例；IPC | GC/长期 renderer 生命周期不以有限 unit 视为穷尽。 |
| IPC 注册/alias / RED 已闭合 U | `src/main/index.ts` → 20 registrar → preload invoke | 原 ipc/*.ts、AST startup/preload check | 重复注册 fail-closed；browser/cloak 同 callback | 注册不启动 GUI/网络 | 实际 handler map 查找；无存储 | 原 API 名和兼容 alias | `tests/smoke/integration.test.ts`；注册/IPC | smoke 证明接线，不证明每个 handler 的业务分支。 |
| 审计/观测导出 / 通过 U | audit list/clear；obs metrics/events/export；data export | audit-log、observability、data-export | clear trusted/confirmed；按当前策略 | 真 JSONL/events；脱敏；未知 scope 拒绝 | append/filter/query/导出；clear 后空 | 诊断事实，不冒充用户遥测上传 | IT audit、observability、data cases；IPC | audit best-effort 吞写错，不提供 durable commit receipt；见反证。 |
| 缓存清理 / 通过 U | storage info/clear-cache | `storage-monitor` | 合法 dirId；仅 cache | 删除合成 Cache，保留其他 bytes | 直接文件存在性/数值返回 | freed 非整个 profile 大小 | IT `storage cache deletion changes real files…`；IPC | 真实磁盘压力和各 OS 原生占用未覆盖。 |
| DRM/更新/激活 / 部分通过 U、T；外部路径 blocked | drm、updates、license IPC/REST | 各原服务；外部 installer 受控 | 路径/版本/激活格式；离线合成 trial | DRM path 可保存不等于存在；非法操作不触 native | config/reload；status/error 读取 | configured≠available；无模型/内核下载承诺 | IT DRM/update/offline license cases；API controlled status | 不调用真实 Keychain、不更换正式公钥、不下载/安装/激活发行物。 |

## 源码候选、有效 RED 与反证分账

| 候选 / 结果 | 可复查事实 | 不得扩大表述 |
|---|---|---|
| baseline 风险静默覆盖 / RED 已闭合 | B-RED → IH + IPC；token 绑定旧/新、sender、配置、runtime；空结果与迟到锁拒绝 | 用户确认风险不变 PASS；baseline commit 与 history 非同事务。 |
| baseline 保存后 history 失败 / RED 已闭合 | IH `baseline commit stays truthful when the later history write fails`；真实 config 第 2 次 rename EACCES，baseline 仍落盘/readback | 返回 ok:true、baselineCommitted:true、HEALTH_HISTORY_WRITE_FAILED 和 warning，不能谎报回滚。 |
| baseline 保存后 recordAudit throw / **反证不成立** | 真实 `audit-log.ts:recordAudit` 整体 try/catch，契约 never-throws；IH 原生 appendFileSync EACCES 单独及叠加 history 失败均原实现通过 | 未 mock service throw 制造 RED，未加无依据生产防御；不承诺 audit 已持久化或失败一定有 warning。 |
| baseline 提交前原子失败 / 通过 U 对照 | IH `a pre-commit atomic write failure preserves the old baseline…`；第 1 次 rename 失败，原 memory/disk/reload/history 不变 | 失败不能返回 baselineCommitted:true，也不能因后续审计降级规则偷报成功。 |
| profile rename/delete/trash 缺底层门 / 部分反证 | IP `existing service checkout and team gates…` 验证锁与已覆盖 team 拒绝，无重复门修改 | 各动作角色覆盖按测试实际循环区分，不把未测 viewer rename 顺带判通过。 |
| smoke 缺 settings handler / **反证不成立** | 原 regex 漏 `handleSettingsMutation`；原 handler 实际注册；修 smoke 后 74/74 | 修的是验证方法，不是新增本来不存在的生产业务。 |
| batch finally/订阅/seed/启动门 / RED 已闭合 | IB、preload 回归；原始失败与最新 IPC 192/192 | setup 异常释放、sender 归属、别名均有原入口证据，非复制实现测试。 |
| REST/MCP 及 Agent 新复审 / 专项已冻结、整体待主 | API 最后组合 251/251（173 socket+78 旧 transport）、route-safety 31/31；AG 95/95；有效 RED 与独立 SQLite readback 已保留 | 不与中间 147/29 等检查点相加；夹具错误不计漏洞；全仓 build/GUI/coverage 按主会话门禁单列。 |

## 真实 GUI 追加定位：基线采集被未使用的权限请求阻塞

- 原 `0e9c…` 构建的真实 Electron/Chromium 验收两次失败于 `native baseline established`，原始失败回执保留：`health-real-configured-f06escwc`、`health-native-timeout-red-1figex0l`。不能把已经运行的前段动作计作整条用例通过。
- 第二次只收集原生字体采集已有日志及同一 target 的只读状态，没有替换 API/结果。日志止于 `DOM metrics complete`；30 秒后页面仍 `visible`、focused、secure、readyState=complete，CDP 状态读正常，前置到 foreground 后仍没有 `Local Font Access complete`。故本次实际停在 `queryLocalFonts()`，不是凭遮挡截图推测媒体枚举或目标失联。
- 基线只消费字体 window/Worker 可用性、度量、光栅，并不消费 `localAccess`。新增显式 `includeLocalAccess:false` 仅避免这条未使用的权限请求；不删除或改写已采集字体字段。默认完整 corpus 与两处独立验证工具仍显式保留 Local Font Access 采集；未修改任何 native 指纹返回值或权限授权。
- 字体原函数和其实际序列化 Worker/source 两入口：6 项原实现 **4 过/2 RED**；同时发现 Chromium evaluator 丢弃 caller timeout，两项真实模块/运输边界 RED。修复只转发显式 command deadline，普通 15 秒预算不变，拒绝命令不表示页面 JS 已停止。最新后端/原 handler/字体/CDP 组合 **10 文件 194/194、exit 0**：`health-capture-final-boundaries-doa4s78x`；此数字与其他专项重叠，不累计为全仓计数。
- 最初新增参数造成两处 Playwright `PageFunction<void,…>` 类型编译失败，已在真实调用点显式保留完整 corpus 选项。该失败 clean 了 dist，尚未注入公钥，不是更换 issuer；仅从已经存在、摘要完全匹配的公开公钥恢复本任务构建输入，未读私钥或激活材料。当前构建 `health-native-capture-build-drzi_znu` **exit 0、source unchanged、正式 issuer preserved**，源码 SHA-256：`aa1fdfd6117a1d7a45d7eecb772d8a294afc4662ed5e81c2ad139e5a5021084f`。
- 该构建已真实跑过 Chromium 七菜单、权限等待修复、原字体/Worker 材料、风险拒绝/过期确认/显式风险保存、只读漂移、cached consistency、权威历史、外站确认取消。字体权限在捕获前后仍为 `prompt`，未申请/放行权限。`health-native-fixed-real-i9wdxkq0` 随后因既有 Firefox 包缺少 `Contents/Resources/omni.ja` 在原 `engineStatus` 完整性检查处失败；**原整条用例仍记 failed，不改写为 passed**，没有取得真实 Firefox/BiDi 证据。
- 最终验收保留这项命名 blocked，其他未知错误仍必须失败；不下载或修补内核、不绕过 runtime 完整性检查、不拿模拟 BiDi 冒充。最终 Chromium 回执/截图、全仓和 coverage 仍见下面主会话门禁，不预填成功。英文模式仍有部分旧环境 finding 的中文正文，不能扩称全量服务文案翻译审计通过。

### 全仓门禁中的独立夹具失败（不归为产品修复）

`health-final-full-coverage-aoi141pv` 在同一 `aa1fdf…` 源码实际执行 233 文件/5972 项：5957 通过、14 个 core journey 失败、1 个 Windows 专用项跳过，exit 1。其余 232 文件均通过，但**这不是最终全仓 GREEN，且未生成可用最终 coverage-summary**。已实际查看该 run 的 `runtime/abs-journey-f6MeaY/screenshots/01-boot.png`：原生强制条款对话框尚未接受；第一处交互日志同样记录 `open dialogs at start: ["dlg-terms"]`。journey 的 setup 在固定 500 ms 后只检查一次 `isVisible()`，晚到的条款被漏过，后续点击被遮挡并各自触发 5 秒限时。不能据此加长全局超时、排除 journey、强关条款、沿用旧覆盖率或宣称所有功能失效；必须通过原 UI 等待/接受及持久化读回，再以不变门槛完整重跑。

## 真实恢复回归追加：停止受理不等于退出或持久化

- `aa1fdf…` 完整默认套件实际 **233 文件、5971 通过、1 个 Windows 专用项跳过、exit 0**（`health-final-full-coverage-terms-cl0hjxxj`），九组深 E2E **55/55、exit 0**（`health-final-related-e2e-2m9u_fjq`）。随后真实恢复整链 `health-final-sync-real-wrg4juj6` 仍 **failed**：新 LocalStorage marker 在页面写入/读回后，原 Studio stop 已确认 PID ESRCH/CDP 断开，同 profile 重启却读到 `null`。因此不能把全仓绿或前轮一次成功当成 native durability 证明。
- 该问题为间歇性：新增只在 stop/PID 退出后复制 main/WAL、对副本 readonly integrity/精确查询的观测运行，曾真实保留 marker；三次不同值周期也曾保留。原失败不改写，不能据静态缺少 `Browser.close` 宣称已经唯一归因；尤其磁盘采样会增加 stop 到 restart 间的时间，不可用它替代原始立即重启反例。最终测试因此保留前三轮无磁盘采样的立即重启，以及第四轮独立的重启前数据库观测。
- 原共享停止实现直接 TERM→3 秒 KILL；无 browser-level close，旧 timer 仅按 PID 判断且强杀后删除 runtime。新增真实 lifecycle 反例 **20 项中 14 RED / 6 通过**：`stop-lifecycle-red-jo1ppjel`。修复保持 `stopBrowser():boolean` 的受理合同：已确认 Chromium 实例先走有整体 2500ms deadline 的本机 browser-target `Browser.close`，仍由实际 PID 消失决定回收；必要时才 TERM→3000ms KILL，仍活则保留 owned/stopping 和 unfinished。默认应用退出等待 6000ms 只覆盖这两个有界阶段，不增加普通测试/诊断限时。
- HTTP/WS 只许该实例的 `127.0.0.1:<port>/json/version` 与 `/devtools/browser/<id>`，无 redirect/page-target fallback，响应上限 16KiB；异步接点重验 entry 对象/PID/port。旧 child exit 不清替换实例/timer/bridge，也不向新实例发旧退出事件。ACK/调试连接断开都不是已退出或已保存证明；Firefox 保持原路径，不借此重开内核改造。
- 36 项真实 loopback HTTP/WS 合同测试不是真浏览器；首次 held-upgrade 的 server raw socket 未消费 EOF 导致一项夹具失败，已改为仅收到 peer EOF 才应答关闭，未放宽 deadline 或用强制 fixture cleanup 凑绿。与真实 lifecycle/存储反例分账。相关 wire/lifecycle/原 launcher 组合检查点 **223/223**：`stop-transport-and-launch-green-1ax6xc6i`；最终源码/完整门禁仍以下表为准。
- 恢复夹具还暴露角色时序冲突：本轮 launch member 门会正确拒绝旧夹具的 viewer B；不应放宽产品权限。改为 owner 原 API 先授 B member 验证真实恢复，然后 owner `team.setRole` 发布 viewer roster，B 仍为 member 时合法 Pull 采纳降权，再验证原 launch/REST/JS/Python SDK 拒绝且无副作用，保留 owner 与首次 Cookie 队列消费历史。
- 单次/批量 UI 同样存在真实假完成：boolean 受理后直接 toast“已停止”并给卡片装 5 秒 `running:false` overlay。完整生产 renderer/DOM 两语言反例 **21 项中 12 RED / 9 通过**：`stop-renderer-red-lgfay1il`。修复仅将 `success===true` 视为已受理，清旧 optimistic overlay 后刷新实际列表；单次和批量均明确“停止请求已受理/已提交，等待退出”，不改 API 权限或把信号预算当退出。选择、搜索、未保存表单及失败状态均留原回归。

### 较早 `8baa1c…` native 检查点：数据与可见状态

`NATIVE-SYNC` **1/1、exit 0**，原 receipt 为 passed：四轮 marker 依次为原值、`-2`、`-3`、`-4`，native 重启均读回该轮新值；前三轮 stop→restart 无磁盘采样，第四轮重启前已在副本 SQLite 查询到新值。四轮重启后的独立查询均命中，`integrity_check=ok`，源文件组只读分析前后摘要不变。SQL 业务库 main-only 对照不含 WAL-only 的 id=2 行，1936495-byte ZIP 恢复后确实查到该行及完整两行，ZIP/原件字节和救援历史保护均通过；取消没有多发归档。恢复端原生页面实际显示合成 Cookie 与 LocalStorage 业务值。owner 原 API 发布降权后，viewer launch 拒绝且无新 PID/日志/Cookie 队列改动，REST/JS/Python 写 403、受保护读取 200，local/remote bytes 均不变。

`NATIVE-HEALTH` 可运行断言 **1/1、exit 0**，原 receipt 保持 `partial-blocked-awaiting-visual-review`，未改写。七张原始 PNG 主会话已逐张 Read，另存 visual-review.json；环境显示 Not verified（原 rAF 90 samples、median 16.7ms），RTC 构造失败显示 Error、不可用显示 Unavailable、RTT 未测；风险确认保留旧基线、canonical 历史区分 Pass/Risk/Not verified。实际点击 Stop 后 notice 为 “Stop request accepted. Waiting for browser exit.”，此时原 status 仍 `running:true`；之后 PID 已确认退出才出现 Stopped。两项命名 blocked 与部分旧环境 finding 英文模式仍有中文正文均保留，不扩称全引擎、全外站或全部文案通过。

### 完整套件追加的协议期限竞态

`health-stop-final-full-coverage-4zl6e7tb` 在 `8baa1c…` 上实际执行 236 文件、6047 项：**6045 通过、1 失败、1 Windows 跳过、exit 1**。仅 `browser-close-transport.test.ts` 的 held-handshake case 将 timeout 收到为 failed；不是全仓 GREEN，后续九深阶段未执行。真实 wire 的总 timer 与 WS `handshakeTimeout:remaining` 存在约 1ms 的 competing-deadline 分类竞态。最小修复去掉重复握手 timer，由既有单一总 deadline 负责中止 HTTP/握手/命令；不放宽 300ms/650ms 断言、普通测试限时或覆盖阈值。`8baa1c…` 的两次 native RUN 仍是实际成功检查点，但最终同源码全仓/native 需在新构建重跑，不能挪用该失败批次的 coverage 冒充最终通过。

### 复用实例退出通知：最后一次状态链反例

`7e6f9a…` 检查点已真实通过默认完整套件 **236 文件、6046 通过、0 失败、1 Windows 跳过、exit 0**，九组深 E2E **55/55**，真实同步恢复及健康窗口各 **1/1、exit 0**。同口径 V8 为行 **80.90%**、分支 **70.60%**、语句 **76.73%**、函数 **82.37%**，四模块目标均达标。这些是该检查点的实际结果，不因后续发现问题而改写；也不自动成为后续源码的最终结果。

- 全 renderer 只读复审确认：`core.js` 的列表刷新只是一次 120ms debounce；`init.js` 依赖退出事件；launch 后另有一次 5 秒刷新，但不存在持续 profile/runtime-status 轮询。聊天的启动专用循环和两条 1 秒 UI 计时器不刷新运行卡片。
- `browser-manager.ts` 的 verified warm reuse 会创建新 entry、保留同一个 ChildProcess；旧的严格 entry 对象相等门误把该合法复用当成替换，跳过真实退出广播。若唯一列表刷新先读到仍运行，卡片可滞留 Running。并非每次必现：退出较早、poll 已删表或残留 launch 刷新可能掩盖。
- `warm-exit-red-joxs125g/` 在原实现执行 7 个明确新增用例：**4 通过、3 RED**。一次/两次原 launcher warm reuse 后真实注册的 exit callback 未清当前 entry；另一个反例是原 entry 内换 child 后旧回调误清新 child。其余不同 PID/port/child 对照保留。
- 最小修复仅将 exit owner 判据改成**同一个 ChildProcess 对象 + 捕获 PID + 捕获 port**，不以数字相等代替身份，不把 health lease 的 entry fence 改成数字比较，也不新增常驻轮询。旧 child 始终只关闭自己的 logFd；不匹配时不碰替换 timer/bridge、不发旧退出消息。
- `warm-exit-boundaries-green-2znjkl29/` 为 **9 文件、658/658、exit 0**，其中新增 7 例直接执行原 exported launcher、真实 provenance/process-line parser 与原注册 callback，不复制被测实现；native/process/storage 边界仍受控。另一只读复审未发现新的高置信问题，但不替代 native GUI。
- `health-warm-exit-build-tr2l1j_a/` 构建成功，源码 SHA-256 `a3b9b7e3753305546cfacf7f6c74200cc72a8f43fcb6fa642a0c27a99a9bed5a`，正式 issuer 保全。真实健康用例已去掉 Stop 后手动 `stop()/refresh()` 的掩盖：原 named-proxy profile 经原 preload 同 PID/port warm reuse，等原 launch 一次性刷新过期，再点可见 Stop；先只读观察 PID 退出及卡片自动 Stopped，之后才读 status。该等待只排除刷新干扰，**不是立即写/停止持久化路径的等待**。最终实际运行及图片复核见下方门禁。

### `a3b9…` 接收端 Cookie 的独立真实失败（原回执保留，后续验证见下）

`health-warm-exit-deep-t85ovvba/` 九组深 E2E **55/55、exit 0**；随后 `health-warm-exit-sync-ori_mkne/` 的真实整链 **0/1、exit 1**，source/test 未变、正式 issuer 保全。原失败 receipt 位于 `health-warm-exit-sync-root-ch0raofs/sync-state-LUIEVJ/receipt.json`，不覆盖旧成功或把它改成 passed。

- 源端页面的合成 Cookie/LocalStorage 业务读回成功；四次不同值的立即 stop/restart 均读回当轮新值、四次副本 SQLite 精确查询均命中，第四轮重启前亦命中。它们不代表整条恢复通过。
- 接收端原 UI Pull 将 Cookie 明确标为 queued 而非 applied；队列文件内合成 name/value/domain/path 在 launch 前实际正确。原 launch 已返回成功、取得 PID/port、CDP 连接及业务页面导航完成，随后 `browserBusinessValues` 的 `document.cookie` 却为 `""`；不能将其说成角色拒绝或用补写页面 Cookie 掩盖。
- 失败发生在原测试 `tests/e2e/sync-state-acceptance.test.ts:1214`；紧接的 queue-consumed 断言尚未执行，后续 member→viewer 发布/拒绝和原件历史后段也未执行，不能借用旧 run 的后段成功。
- 原 cleanup 已确认退出并清理 owned bulky userData；小回执及失败截图保留，失败截图已实际查看。该 run 没有保留 queue-after、launch cookie import 明细或 CDP 请求/响应，因此不能唯一认定 Cookie 被删除、未写入或特定 ready 竞态。
- 后续已为 HTTP200 但无 page、发现阶段期限、fresh port/owner、partial/strict queue 和 launch/UI 假绿建立有效原实现 RED 并做最小修复，见下节。它们不倒推本次原失败的唯一原因；当前 native receiver 恢复仍未闭合，不能用受控边界 GREEN 代替实际站点 Cookie 读回。

### Cookie 导入回执、队列与期限：有效 RED → `516378…` 专项 GREEN

- `cookie-import-all-red-_3wy5i6o/` 实际执行原 service 全文件90项：87通过、3失败，分别是首个 page target 晚于 HTTP200、发现 headers 挂起、headers已耗时后body挂起。第一次过滤运行未选到 late-page 新例，不拿它当完整反例。原预算没有上调：import总30秒、single set 5秒、delete 10秒；现在同一个期限覆盖发现、模块、WS与命令，只在尚未写入时对空 page 列表重查，不重放已开始的 batch。
- `cookie-launch-results-red-p8ju99xv/` 实际208项201通过、7失败：5种原 launcher回执/异常和EN/ZH各1个假绿。fresh launch传自己的精确port，不重新依赖旧process-table缓存；current门绑定同一child/PID/port、非stopping及child存活字段。Cookie 失败不杀已正常启动的浏览器，但返回真实 `checked/applied/pending/error`，UI为warning而不是无条件绿色；空队列/完整/旧无receipt的成功展示保持兼容。
- `cookie-child-liveness-red-ydvrdn82/` 4个实际新例全部RED；`cookie-strict-mixed-row-red-5deduaf0/` 精确执行1个混合坏队列替换反例并失败。前一过滤误命中旧例的3通过/93跳过不算新例GREEN。guarded路径两次内部读均strict，坏JSON/shape/行/路径保留证据并静态失败；legacy一参兼容不改。partial保留整个queue，仅同owner、完整应用且归一化queued数据相同才清，不夸成文件版本/inode级CAS。
- `cookie-owner-final-green-3j17mb1r/` 在当前产品源码 **12文件、806/806、0失败/跳过、exit0**；Cookie service96、原exported launcher183、原renderer stop/新Cookie warning29、renderer health57，其余为close transport/lifecycle/discovery/proxy/i18n/support。真实queued文件及原handler/service参与，但native/network边界受控；该GREEN不是站点Cookie或退出durability验收。

### 当前立即停止数据失败与被动关闭证据（未解决）

- `65426f…` 构建及九深55/55之后，`health-cookie-final-sync-k6nlo8ok/` **0/1、exit1**；原receipt `health-cookie-final-sync-root-n3br8_j1/sync-state-gZDHiZ/receipt.json` 第1轮保留新值，第2轮expected `synthetic-immediate-stop-business-value-2`、actual上一轮值。重启后独立SQLite精确查询false、integrity ok；前三轮没有stop→restart磁盘采样。679–944ms退出/PID消失不证明没有TERM或正常落盘，该run尚未采close-result/exit code/signal，后段receiver未执行。
- 当前 `516378988623b12651cda03dd0949f1ade45447e2ca7f5ff93b977bd5fedc0f5` 构建成功、issuer保全。仅新增安全allowlist的stop请求/native-close结果/实际signal dispatch日志；测试被动日志与退出观测在marker写入前注册，未向写→stop→立即restart窗口插入IPC/I/O、settle等待、flush或flags修改。
- `native-stop-observation-sync-ex0foj4g/` **0/1、exit1**，source不变；当时测试SHA `36f0a6dab069720e7fb5a18aaf94098d568e0007c0cad29e6e3341a6a59a6e61` 不变。原receipt `native-stop-observation-sync-root-_u5c0fct/sync-state-jSPUQ1/receipt.json` 第1轮新值即在重启后变null，独立SQLite副本无精确row、integrity ok、源分析前后不变。
- 被动stdout实际保留3次 `Browser.close` **acknowledged**、dropped=0；未记录signal-sent，但child exit/code/signal observer注册及重启后采集失败，failure快照not-armed。因此不能据缺日志推定正常exit/code0，也不能将ACK当保存证明。原失败receipt保持failed，4张PNG已实际查看并核验摘要，独立visual-review.json记录边界；receiver Cookie、runtime LS和member→viewer后段仍未执行到。
- 只读启动链复核未找到每次launch自动恢复旧LocalStorage的路径：fresh patch的是Preferences及Cookie队列；能替换native SQLite的是另一次有策略/锁/停止门的sync pull或新ID archive import，不是这条普通restart调用。这个反证不确定native根因；没有通过页面补写、额外sleep、提前flush、改storage flags或改内核凑绿。

### 当前 `516378…` 真实健康窗口检查点

`cookie-owner-native-health-lqe5305t/` 可运行断言 **1/1、exit0**，source/test不变、issuer保全。原 `cookie-owner-health-root-c7m2xwij/health-functional-45r63L/receipt.json` 保持partial-blocked-awaiting-visual-review；7张PNG主会话全部实际Read并核验SHA，另存visual-review.json。原REST/MCP鉴权均401/401/200、unhandled=[]；环境canonical/runtime保持inconclusive，rAF原91 samples/median16.7ms；RTC故障Error、不可用Unavailable、RTT未测；基线不静默覆盖、stale确认拒绝、取消/清除/换profile迟到隔离均通过。

原named-proxy B经原preload warm复用仍PID38545/port62843，5504ms只排除既有launch一次性刷新，随后可见Stop、实际PID退出、卡片自动Stopped，断言前无manual refresh/额外stop，A仍Running。该等待不在立即LocalStorage持久化路径内，不证明数据已保存。Firefox缺omni.ja、自动launch后RTC无获准UDP/STUN边界两项仍blocked；部分既有英文finding中文正文仍保留。

### 原生退出观测器有效与接收端恢复成功检查点（不关闭间歇性LS问题）

`app.evaluate` 回调内的动态 `import()` 可被Vite重写成runner专属helper，不能靠语法解析证明能在Electron运行。测试仅将这一加载点改为Electron内置 `createRequire` 加载同一个无TLA的dist ESM，保留真实getEntry/child/PID/port/owned userData检查；加静态阶段及白名单故障分类，不记录raw message/stack/path，不建假runtime map、不改产品源码。首次collect异常不能由此唯一归因；它与loader问题分别保留未知。

- `native-exit-loader-sync-cq0mgrwq/` **1/1、exit0**，产品仍是同一 `516378…`，test SHA `a125f2bc64749b4ffbb669122a7e6c44c24a6dd7ff60e863504516e2479e9b28`，source/test均不变、issuer保全、无预算违规。原 `native-exit-loader-sync-root-vy03lmua/sync-state-xFojMj/receipt.json` 保持passed；7张PNG已全部实际Read并核SHA，另存visual-review.json。没有添加sleep/retry/flush/feature flags，原写→stop→立即restart窗口不变。
- 4次pre-write注册均armed，4次原读回/磁盘观测之后collect均available，观察到相应真实child **exitCode=0、signal=null**。本run四个不同marker均重启读回正确，四次独立SQLite精确查询与integrity均正确，第4轮重启前亦命中。**只证明本run的退出和持久化结果；不能把相同产品源码上一run的null失败改成已修复。**
- 接收端原UI Pull后Cookie队列实际1项；原launch返回 `checked:true/applied:1/pending:0`，queue-after实际不存在；原业务读回先固定，再做只读属性观测：合成Cookie匹配、named CookieStore可见、`/business`真实请求也携带合成Cookie。实际native页面同时显示正确Cookie与LocalStorage业务值；无页面补写或私有queue入口绕过。Cookie应用问题本轮native正例已验证，不承诺所有引擎、所有Cookie或退出durability。
- ZIP **1,915,596 bytes**，独立恢复业务SQLite含WAL-only的id=2以及完整两行、integrity ok，并按payload精确检索；取消没有额外归档。owner原API授member→真实恢复→发布viewer降权→member合法Pull采纳后，原launch拒绝且0新PID、log/queue/config/remote均不变，REST/JS/Python写403、受保护读200。新ID导入、原件与救援历史字节不变、后续可同步也已执行。
- 随后 `cookie-owner-related-deep-r6cwswn6/` 在同一source复验九组深E2E：**9文件、55/55、exit0**，source/test files不变、issuer保全。不能把九深或最后整链一次成功当作间歇LS缺陷的根因修复。`#52`仍保持未解决，用户指南已补中英文数据风险说明。

八组矩阵复核为 **20+12+9+13+10+11+17+16=108条目**，复合行/共享入口按一条计，不宣称108个独立RPC/按钮或全部GUI已通过。

## `516378…` Coverage检查点：基线、专项与完整套件分开（当前c66复验见文末）

统计仍是 `vitest.config.ts` 的 `src/main/services/**` + `src/main/ipc/**`，原 exclude/threshold 不改；renderer/SDK/独立 Electron/浏览器没有被该百分比覆盖。
基线来自前轮当前源码报告，不是陈旧 `coverage/` 目录：总体行 70.35%、分支 61.80%、语句 66.98%、函数 70.76%。

| 范围 | 原行 / 分支 | 本轮目标行 / 分支 | 当前 `516378…` 全默认套件同次V8（命中/总数） | 目标 |
|---|---|---|---|---|
| IPC整体（20文件） | 16.79% / 8.04% | ≥60% / ≥40% | 行960/1289=74.47%；分支472/903=52.27% | 达成；仍有329行、431分支未命中。 |
| REST | 38.79% / 31.54% | ≥60% / ≥45% | 行846/1044=81.03%；分支831/1211=68.62% | 达成；不是全部route/真实下游覆盖。 |
| MCP | 20.63% / 17.84% | ≥60% / ≥45% | 行289/394=73.35%；分支256/382=67.01% | 达成；真实native/外部服务另记。 |
| local-agent | 47.09% / 38.68% | ≥55% / ≥45% | 行880/1290=68.21%；分支730/1157=63.09% | 达成；不证明真实模型或全部工具分支。 |
| 全services+IPC（139文件） | 70.35% / 61.80% | 保持原include/exclude/threshold | 行15407/19020=81.00%；分支14007/19791=70.77%；语句18012/23444=76.82%；函数2770/3360=82.44% | 原全局门槛通过，命令exit0；不含renderer/SDK/独立进程。 |

当前命令：`DIST_READY=1 python3 <root>/run-tests.py cookie-owner-full-coverage --config vitest.config.ts --maxWorkers=1 --reporter=default --coverage --coverage.reporter=json-summary --coverage.reporter=lcov --coverage.reportsDirectory=<root>/cookie-owner-full-coverage-report-fz2aqlsy`。实际run `cookie-owner-full-coverage-r0y4hb_5/`：**236文件全部通过、6079通过、0失败、1跳过、6080总项、exit0**，source及默认套件输入摘要前后相同、issuer保全、无预算违规。唯一skip为 `bundled-native-browsers-async.test.ts` 的native Windows默认发现项，不是健康/存储失败被跳过。

报告原件：`cookie-owner-full-coverage-report-fz2aqlsy/{coverage-summary.json,lcov.info}`；与原默认口径一致，不能将更早局部LCOV较高百分比拼进来。IPC聚合百分比按相同两位截断显示，原始分数保留。主要缺口：browser IPC行204/384=53.12%、分支131/306=42.81%；detect行16/26=61.53%、分支13/51=25.49%；drm行19/29=65.51%、分支9/24=37.50%；sync行16/24=66.66%、分支6/17=35.29%。LCOV仍有browser IPC 841–859、REST 1066–1071、MCP 801–808、local-agent 2977–3017等未执行行段（并非这些区间每行都是可执行行）；其余逐行/分支缺口以原LCOV为准，不把达到目标说成全覆盖。

专项 coverage 命令退出状态须诚实：`ipc-final-coverage-2ig2a49h/` 97/97、`task48-freeze-coverage-final-ik7eh1iy/` 147/147、`task49-freeze-coverage-w7gvxvla/` 95/95 均有测试通过但命令 exit 1；它们不是最终全局 coverage 通过回执。
原全局门槛仍为 lines/functions/statements 40%、branches 35%；局部目标达成不免除全仓冻结后同次报告。未采集 renderer/真实子进程不描述为“0%”或“全应用覆盖”。

## `516378…` 已完成检查点汇总（不继承到后续源码）

| ID | 门禁 / 责任范围 | 当前状态 | 主会话应填写的证据 |
|---|---|---|---|
| MAIN-FINAL-SOURCE | 同一冻结源码与正式 issuer | 当前build/full/health及最后恢复整链通过；同源码间歇LS失败仍未解决 | `release/preview-macos-arm64-20261017` / HEAD `62e568920c5b3cef7177c94eb0194b92eb16bd79`；当前 source SHA-256 `516378988623b12651cda03dd0949f1ade45447e2ca7f5ff93b977bd5fedc0f5`。更早各source均保留独立检查点，不拿旧native/旧完整GREEN或failed全仓冒充当前验收。正式公钥SPKI SHA-256 `c1aafecf9cd3a42eb05caf104a29906bfda3b442320b26928c98f37598b6b55d` 保全，未重置或替换真实授权。 |
| MAIN-FINAL-BUILD | 当前build、TypeScript、JS/Python语法 | 当前build/type/i18n通过；最终语法/清理另核 | `health-cookie-owner-build-zjpbfpr1/{summary.json,build.log}`：buildExit=0、source unchanged=true、issuer preserved=true，源码 `516378…`。当前再次实际执行 `tsc --noEmit --incremental false --pretty false`、`node scripts/check-i18n.mjs`、`git diff --check` 均exit0；renderer1799/1799、main64/64。更早JS/Python语法结果不冒充此后新测试observer的运行有效性。 |
| MAIN-FINAL-BACKEND | 后端、drift consumer、API追加边界 | 当前默认完整套件通过，native边界另记 | 当前6079通过覆盖原生产模块及新增DNS/font/ICE/oldclear/runtimeproxy、drift/capture engine、queued auth/serialization/partial回归；806专项和当前健康窗口另有独立回执。REST/MCP source hash再次与Task48冻结核对相同，不将controlled native/wire声称为真实外部服务。 |
| MAIN-FINAL-RENDERER | 新增renderer/i18n边界 | 当前专项与默认完整套件通过 | 当前806组合包含原renderer health57/57、stop+Cookie warning29/29、i18n103、main-i18n84、support163；同批无失败/跳过，并在当前完整套件复验。原模块/DOM与下面实际GUI分账，不称全部UI/翻译已穷尽。 |
| MAIN-FINAL-GUI-CHROMIUM | 实际Electron/preload/可见七菜单和warm Stop自动刷新 | 当前 `516378…` 可运行范围通过；两项命名blocked | `cookie-owner-native-health-lqe5305t`：1/1、exit0、source/test不变、issuer保全；原 `cookie-owner-health-root-c7m2xwij/health-functional-45r63L/receipt.json` 保持partial-blocked，七张PNG已实际Read/核SHA，另有visual-review.json。原bridge、native环境/字体、RTC故障、取消/切换/clear、风险/stale确认、权威历史/磁盘/reload/search/card与REST/MCP401/401/200均执行；warm B同PID/port，退出后无手动刷新自动Stopped，A仍Running。详见当前健康检查点，不推断Cookie恢复或LS durability通过。 |
| MAIN-FINAL-GUI-FIREFOX | 实际 Firefox/BiDi | **blocked** | 唯一已选既有包 `/Users/ahoo/.agent-browser-studio/firefox-154.0/Firefox.app` 缺少 `Contents/Resources/omni.ja`，原 runtime 完整性检查拒绝，独立只读 stat 也确认缺失。未启动该 Firefox、未取得 native BiDi、未下载/修补运行包或使用模拟程序；不把 Chromium 的结果扩称 Firefox 通过。 |
| MAIN-FINAL-RTC | stopped launch consent 与真实 RTC 正例 | blocked（安全边界待确认） | 先证明获准的外部 STUN/继承隔离边界；不可 launch 后直接跑外部探针并把 constructor negative 冒充 native 成功。 |
| MAIN-FINAL-FULL | 默认完整套件（含core GUI） | 当前 `516378…` 通过 | `cookie-owner-full-coverage-r0y4hb_5`：236文件、6079通过、0失败、1 Windows专用跳过、6080总项、exit0、无预算违规；source及suite输入摘要不变、issuer保全。未执行到的独立sync后段不在此GREEN内。 |
| MAIN-FINAL-DEEP | 九组同步归档深E2E、真实恢复整链 | 九深55/55、最后native整链1/1；间歇LS风险不关闭 | 当前 `cookie-owner-related-deep-r6cwswn6`：9文件55/55、exit0；`native-exit-loader-sync-cq0mgrwq`：1/1、exit0，7PNG已实际查看/核SHA，receiver Cookie队列1→0、真实页面/请求值匹配、SQLite/WAL/ZIP/owner→member→viewer/救援历史保护均执行。此前同516源码立即LS failed原件保留；最后pass不是产品数据缺陷已修复证明。 |
| MAIN-FINAL-COVERAGE | 冻结源码全仓V8 | 当前同次完整报告已读，四目标达成 | `cookie-owner-full-coverage-report-fz2aqlsy/{coverage-summary.json,lcov.info}`：81.00L/70.77B/76.82S/82.44F，139 source/20 IPC文件。原include/exclude/threshold不变，细分分子/分母与未覆盖范围见Coverage节；不包含renderer/SDK/独立Electron/Chromium。 |
| MAIN-FINAL-CLEANUP | diff、本轮残留与预算 | 最后检查通过 | source仍516378…、正式issuer保全，tsc/i18n/diff再验均exit0；本轮owned Electron/Chromium PID列表=[]。挂载核验通过，已分配442,093,568 bytes＜2GiB、可用9,852,514,304 bytes＞6GiB reserve；仅原测试cleanup移除其owned bulky数据，失败/成功小回执和截图均保留。12份JS语法及Python AST已过；src loopback复核30文件/104行，仅本机控制/原声明用途，.env不存在，Docker文件未改、容器验证不适用。不退出用户/其他会话实例，不清未知备份。 |
| MAIN-FINAL-SCOPE | Docker/外部站/发行操作 | Docker 未改则不适用；其余未授权 | 不虚构容器启动、Ping0 分数、真实模型业务验证；不 commit/push、安装、签名、公证或发布。 |

本报告只引用所需源码、测试与已登记合成证据；未读取用户凭据、私有索引正文或真实应用数据。已执行的构建、真实窗口与完整套件按各检查点分别记账；原始失败回执不可改写为成功，专项重叠不相加。工作区改动不等于已安装版更新，也不授权 commit/push、安装或发行。

## 2026-10-18 追加：正常页面收尾与立即停止验证

### 有效的正常退出丢值反例

`immediate-loss-repro-one-o1tf8x_6` 在同 `516378…` 产品源码、`a125f2…` 测试上 **0/1、exit1**，无预算违规；原 receipt SHA-256 `5536f30883587a30b1f986032a6527092ac54ec55f08359b5918084ca6cb0361` 保持 failed。第2轮在页面确认读到新值后，Browser.close 得到ACK，捕获的真实 child PID93605 **exitCode=0、signal=null**，重启实际读到上一轮旧值。两轮主库28,672 bytes与WAL32 bytes摘要均相同；原副本扫描未命中新值、integrity ok、源分析前后不变。失败截图已实际查看；两个profile均Stopped，不据此声称已保存。原analysis字节被当时cleanup删除，不能声称有可供事后查询的原数据库；独立 `diagnostic-review.json` 明确这一限制。

随后 `immediate-loss-retained-sqlite-ck4wuc08` 的 **1/1、exit0** 仍是相同产品源码，不算修复。它增加的failure-only小副本保留分支未命中，原failed回执不变。

### 原生机制的依据与未知

只读文档所指既有Chromium152源码显示：BrowserHandler::Close先回Success，CloseBrowserSoon再排入ExitIgnoreUnloadHandlers；renderer SetItem先更新缓存再异步Put，GetItem不是SQLite提交证明。StorageArea析构明确记录pending-load读写丢失指标，另一方面Shutdown已有ScheduleImmediateCommit，DB sequence也使用BLOCK_SHUTDOWN。因此不能仅凭“异步”“5秒批次”或源码TODO唯一归因。pending-load析构丢弃、commit失败后batch未恢复、storage进程族退场都仍需本次现场证据，未修改/编译/安装native树，亦未证明该源码与已选binary逐字同构。

目标关闭路径可核实为page host Close→ClosePage；发现observer同步回放现有hosts。候选先在原browser websocket发现page，再请求关闭并等待销毁/响应，最后Browser.close。**Target.closeTarget ACK与targetDestroyed只是控制流依据，不是commit barrier；ACK也不冻结以后新建的page。** 若有满足该时序的真实丢值，足以否定它能闭合#52。

### 原实现反例与产品窄修复

- `native-page-teardown-red-nke6at8l`：旧36项全部通过，新增9条顺序反例全部失败；原source仍516，原helper及source-context保留。`native-page-teardown-bounds-48be0maj` 随后74/74通过，含target/event/noise上限、owner与响应/销毁先后。
- 独立复审发现“先收到目标销毁，再收到该close的TargetNotFound”合法竞态，以及owner拒绝发送但requested计数已加。`native-target-gone-race-red-k2inhtkn` 实际执行4项：2通过、2 RED，其他54未选中；已窄修为只有**确切原生not-found错误且已观察销毁**才能退该pending，其他错误/缺销毁/混合result均拒绝；发送被owner/deadline拒绝不记派发。`native-close-final-boundaries-5ysizcwi` 当前5文件 **287/287、0失败/跳过、exit0**，其中原launcher185、wire59、其余43。
- `late-startup-owner-red-xpchre3s` 另证实：旧A迟到readiness/drift失败会删掉B owner、关闭B bridge，B自己的exit亦无法清timer。drift用例多余的不存在error-code断言已纠正，不改产品错误合同；两条真正owner RED保留。四处startup失败清理现在以captured child/PID/port取走本实例entry，并只保留A自己的bridge引用；warm复用同child仍清，B自身exit正臂通过。**这个并发缺口不被当成本次串行LocalStorage丢值的原因。**
- 未改变停止受理boolean、PID实际退出门、2500ms总关闭预算及原TERM→KILL预算；仍不跟redirect或连接page websocket，不评估页面脚本、不flush、不补值、不改storage flags。超限/失败/强制清退仍不承诺持久化。

### 可复查的原链与副本保留

首版 `c9a537…` 构建成功、issuer保全，`native-page-close-first-2bzirl1x` 真实整链 **1/1、exit0**；source/test不变。4个不同marker在原立即restart路径均读回正确，4次独立副本检查命中且integrity ok，第4轮restart之前亦命中。4次pre-write observer均armed，最终累计ledger包含4个exitCode0/signalnull；其中cycle2当次collect曾unavailable/unclassified，**不改成4次collect均可用**。被动page summaries均为已发现1/请求1/ACK1/销毁1之后Browser.close，dropped0。7张PNG全部实际查看/核摘要，原passed receipt与另存visual-review.json保留；receiver Cookie/LS、ZIP/WAL-only业务行、原件保护与合法降权后拒绝均执行。这个单次pass仍不关闭间歇问题。

该候选源码 `3f33e2f5fed84be58a23523370be51aa0650bacc63ba55d27459939818c71764` 曾在 `native-close-race-final-build-4vuixi4r` 构建成功、source unchanged/issuer preserved均true，类型、JS/Python语法、i18n镜像/1799+64键及diff检查通过。预先限定最多3轮、每轮4个原周期；**第2轮出现有效失败后即停止，第3轮未启动**，不重试到绿。此候选不是当前保留源码，不将其单测或首轮native成功列为最终验收。

测试的2333-byte写→stop→restart窗口仍为SHA-256 `0d1099d564189e4961c955dd7d8123730a4c4b0cb4c0d315fa82afe60c63d79a`；被动main日志只保留绑定owned profile/requested PID/port的有限计数。失败后最多保留2组已停止的synthetic main/WAL；成功时只在**整条链和进程清理之后**保留最后1组，供独立离线WHERE/COUNT/integrity/原字节验证，不保留userData、Cookie DB、凭据、缓存或归档。actual原helper的合成self-check已验证2组retained/readback/精确COUNT=1与摘要不变，坏摘要/越预算被拒绝；不冒充真实native丢值现场。

**查询口径校正：** 较早文中“副本精确查询/row false”对 `inspectOwnedSqliteStorage` 是每返回行严格比较key/value，但其原扫描每表最多64行，origin只记录、不强制join，不是穷尽WHERE证明；不能以false断言全库不存在。该限制不能解释已固定的native页面getItem旧值/null。最终保留副本的独立条件检索与完整性证据如下，不用修改原业务断言消除失败。

### 正常页面候选被实测否定并撤回

- `native-close-repeat-1-habd5atl`：3f33/07eca5固定输入整链 **1/1、exit0**、4个marker及最终4个child退出正确；原cycle2 collect不可用，但最终累计包含该child的有效exit0/null。不把它描述为4次独立collect均available。只保留最后1组native main/WAL，接收端原业务页也已实际查看；其余6图留存但本次未逐张复看。
- `native-close-repeat-2-hgstuz9t`：同产品与测试输入 **0/1、exit1**、无预算违规、issuer保全。第1周期页面已读到新值，549ms后stop返回；原立即restart **actual=null**。捕获child **PID34141 exitCode0/signalnull**，arm/collect均有效。被动记录明确 discovery/request/close ACK/targetDestroyed均1，之后才Browser.close ACK；dropped0、无signal-sent。原failed receipt SHA `35ae2924ac1b61a25960f897e1b36b2618aaea4fc66fec25060cf390feac4120` 不改写。失败窗口截图已实际查看，两卡Stopped不代表已保存；另外3图仅保留，未新增“全图已看”声明。
- 真正命中failure-only保留分支：`native-close-repeat-2-root-4mrudru0/sync-state-d2omQm/failure-native-storage/cycle-1/` 保留main28,672 bytes、WAL32 bytes，目录/文件受限，非userData/Cookie DB。独立Python复制后以 `mode=ro` 打开，先检查实际schema，再在 `map_entries e JOIN maps m ON m.row_id=e.map_id` 按**确切BLOB storage_key、01前缀key/value、compression=0**作WHERE/COUNT，无LIMIT。失败库marker **keyCount=0、exactValueCount=0**；原business row仍1，integrity ok。成功库同法查到第4轮marker **1/1**。两者保留原件与查询副本main/WAL均保持原hash；各自 `independent-exact-query-*/exact-query-result.json` 可复查。
- 这证明该候选不充分，**第3轮未运行**。其新增生产关闭时序和设计专属wire测试已从工作区撤回，原111行helper（SHA `e433c2…`）与原36条wire边界恢复；失败候选源码/实验测试快照与 `candidate-reversion.json` 另存，不能称该算法“已修复”。实际native业务失败断言、独立保留/查询及原失败回执仍保留，不是通过删业务反例改绿。
- 额外只读源码反证：Target关闭本来已有renderer ClosePage的回调/超时路径，targetDestroyed无法区分正常回调、timeout或跳过；Page.close新增的BeforeUnload也可纯browser侧完成，不保证新增renderer往返。没有运行或保留新的BeforeUnload盲试，不把更多回包堆成commit证明。底层究竟未处理Put、读写加载未完成、提交失败还是进程族收尾仍未由这份证据唯一确定；未擅改/重建native内核。

### 当前保留源码与未完成项

当前 source SHA-256 **`c66be7b8e9cfc35485f5311296f6255eca8474c430f4add69b387c66369afeaf`**，仅保留独立的startup owner fence等既定修复，不含被否定的page-close算法。`owner-fence-current-build-8euqaog2` buildExit0、source unchanged、official issuer preserved均true；原公钥未替换、未安装应用。

`owner-fence-retained-regressions-9zxmiznw` **7文件389/389**；`owner-fence-current-boundaries-65ul5pu7` **12文件808/808、0失败/跳过、exit0**，后者包含前者相关边界，不能相加。原launcher185（含新增2个owner反例正臂）、wire36、Cookie96、renderer stop29及健康/i18n边界均执行。类型/diff通过。当前完整默认套件/V8已在同一c66源码完成，见下方新检查点；九深与真实健康尚未在该源码复验。套件结束后已核本验证根下Electron/Chromium/helper进程为空，并明确释放Mac前台给其他会话；后续GUI仍需串行协调，不能拿516旧native报告或实验3f33的一次pass冒充新结果。

**#52仍开放，#51不能全应用结案。** 新的实证比之前更强，但不是LocalStorage修复完成；需要后续针对实际native存储完成阶段的授权内定位/修正与同原链反例验证，不能靠sleep、提前flush、页面补值、storage开关、一次通过或提高超时凑过。

后续窄源码反证继续保留而不升格为根因：同一后端area若已回非空GetAll，初始加载已完成，不能直接归为首次load未完成；但完整map可在特定cache/无pending/无inflight/已提交门下降为keys-only。已直接核对header：`IsMapLoaded`包含keys-only，`IsMapUpgradeNeeded`只在keys-only且cache要求keys+values时成立，不能把ReadOnly任务参数等同数据库只读升级。实际数据库类型为 `AsyncDomStorageDatabase`：其 `InitiateCommit`（221–253）会在调用内遍历committer同步CollectCommit，再将已移出的updates排到DB sequence；不是只留一个以后访问area的弱引用任务。所以“已有commit in-flight，析构第二batch必丢”也不是成立解释。仍缺本次运行的具体Put/load/DbStatus/进程族证据。

当前c66增量也已对照既有普通restart不恢复旧LS的数据流反证：manager1747–1768只捕获/取走本child tuple与bridge，失败及exit路径没有新增profile/LS/WAL写入；测试617–659只将既有analysisDirectory的合成副本复制到独立证据目录，调用点1661–1665/1714–1719均在业务失败后或整链清理后。1387–1423原关键窗口不变；1333–1339归档导入是不同新ID，1428–1443的receiver Pull晚于该窗口。实际SQLite替换仍由sync-service303–310→861–867→1005–1021的Pull分支负责，没有被此增量接入普通launcher。这个增量可达性核对不是全仓不存在写入的证明，也没有排除既有Preferences行为对native初始化的影响。

StorageService进程位置亦只作源码解释：文档所指152树的dom_storage_context_wrapper369–376→storage_partition_impl3387–3389/232–272，在非Android、embedder目录非空、无single-process且无testing强制时Launch独立StorageService；否则在Browser IO线程构造。Chrome embedder在profile_manager就绪后返回user_data_dir（chrome_content_browser_client7689–7695），通用embedder默认却是空目录；Remote首次绑定后不因目录就绪而迁移。所读选择链无FeatureList/macOS专属gate，不套用其他版本feature默认值。**未看到storage utility不能证明无pending commit**；已选binary、构建和实际首绑定分支仍未知，不以源码默认值冒充运行证据。

独立于原E2E的被动OS进程族观察（#54）现已完成GUI-less验证、受限精确argv补强与独立审查，并在共享Mac明确释放后取得一次真实native成功样本，见下节。只针对新独占root及既有selected Chromium，原test和产品启停路径不改；对存活child才查询命名文件描述符。成功样本、存活或持有文件都不等于失败根因或实际提交证明。

### 当前c66完整默认套件与同次V8复验

`python3 <root>/run-current-owner-full.py` 已实际exit0；内部仍为原 `vitest.config.ts` 默认include/exclude/thresholds、单worker与V8 json-summary/lcov，只改变输出路径。实际run `owner-fence-current-full-coverage-p_0fgmcx`：**236文件全部通过，6081通过、0失败、1跳过、6082总项**，无预算违规。原 `tests/e2e/journey.test.ts` 的真实Electron core GUI **17/17** 包含在默认范围中；唯一skip仍为native Windows默认发现项，不是LocalStorage或健康反例被跳过。

产品source仍为 **c66be7…**；覆盖前后399个package/config/test/SDK源输入SHA均为 `a81f93d932084178b666ecf7dc3d62812e7256d6d05adbb6fed59985754bc9dc`，source与输入均未变、正式issuer保全。原件 `owner-fence-current-coverage-report-2iqjdwsa/{coverage-summary.json,lcov.info,validation-context.json}`；139个source、20个IPC文件。百分比沿用报告/两位截断，原分子分母如下：

| 范围 | 行 | 分支 | 语句 | 函数 |
|---|---|---|---|---|
| services+IPC总体 | 15438/19023=81.15% | 14023/19806=70.80% | 18049/23447=76.97% | 2775/3361=82.56% |
| IPC整体 | 960/1289=74.47% | 472/903=52.27% | 1052/1436=73.25% | 254/299=84.94% |
| REST | 846/1044=81.03% | 831/1211=68.62% | 946/1174=80.57% | 59/74=79.72% |
| MCP | 289/394=73.35% | 256/382=67.01% | 312/446=69.95% | 38/54=70.37% |
| local-agent | 880/1290=68.21% | 730/1157=63.09% | 1008/1538=65.53% | 181/230=78.69% |

四个计划模块目标仍全部达成；新增owner fence自然使总分母增加，没有缩分母。profile-health行110/111、分支150/167，RTC87/92与127/149，environment-risk148/157与187/218；lifecycle131/156与71/105，恢复后的原graceful-close61/64与54/62，Cookie service257/297与244/305。renderer/SDK与独立Electron/native进程不由该V8统计衡量，不能扩称全应用81.15%或全部功能均通过。

这不是显式opt-in的native LocalStorage整链，**默认套件全绿不关闭既有真实丢值失败或#52**。当前c66的九组深E2E、真实健康复验仍未执行；516和3f33对应证据保持各自身份。此默认suite结束时，只查询本验证根候选PID及进程元数据，Electron/Chromium/helper列表为空，并明确释放Mac前台；后续取得再次明确交接后，才启动下面单次独立原生诊断，未操作对方实例或以idle通知代替清理证明。

## 2026-10-19 追加：独立OS进程族观察实跑（成功样本，不关闭丢值）

### 观察器先验证，未改变业务路径

原观察器的ps平铺参数无法可靠还原带空格UA，不能据没有准入root断言无存储子进程。补充模式仅限**新协调器后代、显式非秘密环境白名单、canonical非空executable argv0、无bare环境赋值参数**的合成树；用固定32KiB KERN_PROCARGS2缓存读取精确argv边界，缓存可能含合成环境，但不解码/保留环境并随后清零。不是任意用户进程的通用观测器，不读取用户工作浏览器。仍有UID/PID/start/selected-exe/profile/非symlink、命令/输出/进程数/时限边界；实际root无准入或未知状态不报不存在。

独立只读审查发现的empty argv0错位、driver环境继承/无界等待/收尾丢回执/unknown误判、合法JSON错误shape均保留有效RED后修正。原base `d56acf42…6f71d6`不变；11项纯parser/状态、17项真实无GUI进程树/kqueue/精确lsof、9项fake外部进程的driver故障/正例通过，并由审查方读回收口。回执 `native-family-forensics-0bo88l20/observer-review-final-tos1332e/`、`exact-argv-selftest-8yys_pxi/receipt.json`。这些不是生产coverage或native持久化通过项，不与6081相加。外层570秒只覆盖原360秒test、两90秒hook及30秒runner余量，未提高原E2E或产品stop预算；observer最多178秒，超时/截断/未知保留部分覆盖，不信号浏览器。

### 原链和离线数据证据

在真实共享桌面交接后，`run-native-family-diagnostic.py --gui-slot-released` **只运行一次**：`native-family-observed-c66-e2l_kswh` **1/1、exit0、无预算违规**；driver/observer也exit0，无强制cleanup。产品仍c66、测试仍07eca、原2333B写→stop→立即restart窗口和正式issuer前后不变。原passed receipt位于 `native-family-forensics-0bo88l20/native-family-diagnostic-m0u_gt22/acceptance/sync-state-tfsKhR/receipt.json`，SHA **`8fe2781386e3f9856395b84427a0e9e166de07b7729b565fec38376f059d9683`**；未改写早先failed回执。

4个原marker均在重启后读回新值，前三轮仍无stop→restart磁盘采样。最后一组native main28,672 bytes/WAL49,472 bytes在整链清理后留存；另建独立只读副本，按真实 `maps/map_entries` schema、BLOB origin/key/value与compression0作完整JOIN WHERE/COUNT，无LIMIT：末轮marker **key1/value1**、原业务row1、integrity ok，原件/查询副本main/WAL摘要前后相同。`independent-exact-query-4pbmczqu/exact-query-result.json`保存依据；不把末轮独立查询扩称所有轮都做了该方法。

全部7张PNG已实际Read并核SHA，另存visual-review.json。接收端Cookie队列 **1→0**、原launch `checked/applied1/pending0`、实际native页面和`/business` HTTP请求Cookie均匹配；ZIP **1,914,741 bytes**完整保留id1及WAL-only id2，integrity ok；取消无额外archive。原owner→member→viewer流程执行，viewer launch拒绝、0新native进程、写403/保护读200，原件、remote和救援历史仍保护。图中Queued/Preserved/Skipped、有限比较、Still processing等没有被改成“全部已完成/已落盘”。fresh HOME的Trial图不代表修改真实永久授权；未安装应用或替换issuer。

### 进程族的有限结论

`family.json`真实准入 **10 roots、79 children、89 records**，最终这些身份均gone。四次prewrite ledger PID **32904/33118/33344/33555**精确映射 **r2/r4/r6/r8**，不是按root顺序猜cycle。对应root退出首次观测均为kqueue note，原child ledger均exitCode0/signalnull。四组root-exit样本中，先前准入的 **29个children全部gone**；其中argv声明StorageService为 **32927/33134/33359/33571**。扩展至十组，79个既往child在对应root-exit样本亦gone、survivors=0。

**本次没有任何surviving-child lsof条目；没有进行命名文件FD查询，不能写成“lsof证实无打开文件”。** 服务类型来自argv声明，不能据标签认定处理了marker、持有数据库或完成commit。1254次扫描、目标75ms而最大实测gap **460.529ms**；存在raced edges/parent身份变化/label不可得，child首次退出观测66 kernel-first、13 poll-first，后到kernel note只是处理时刻，不是精确退出或flush时间。没有cap-hit/progress drop/输出省略也不表示完整家族。

该成功样本只支持：在这些root退出取样点，没有看到**已准入**child留存到root之后。**不能据此排除原失败的进程族分支、无pending commit或#52已修复**；截至该成功样本，失败侧尚无同类family轨迹，后续取得的失败对照见下节。该轮原生整链结束后再次独立核本验证根下Electron/Chromium/helper候选为空，才明确释放Mac给peer；未在对方窗口内另开GUI。#52仍开放，#51仍被阻塞。

## 2026-10-19 追加：当前c66失败侧对照，首轮失败即停

### 预声明边界与实际失败

先在 `native-family-forensics-0bo88l20/bounded-failure-capture-kxo9u6d5/declaration.json` 封存**最多2次追加、串行、任一test/observer/identity/budget/cleanup错误即停**，共享Mac明确交还后才开始。仍用原driver `5f6aa1…`、base观察器 `d56acf42…`、精确argv补充 `fb95944…`；产品c66、测试07eca、原2333B窗口、正式issuer均不变，没有新增等待/flush/补值/flags或提高预算。

**第1次追加实际失败，第二次未启动**：`native-family-observed-c66-2m7ixgxb` 为 **0/1、exit1**，无预算违规；observer exit0、无forced cleanup/cleanup failure，原test runner已退出。原收据 `native-family-forensics-0bo88l20/native-family-diagnostic-jlmsixus/acceptance/sync-state-GLg6aU/receipt.json` SHA **`1ce5727c3dabfd331b1655d7aac18e8e4f30285b8064f6207058228a10e75df1`**，保持failed不改写。cycle1保留新值；**cycle2 expected=`synthetic-immediate-stop-business-value-2`，actual仍为上一轮 `synthetic-immediate-stop-business-value`，不是null或键不存在**。cycle3/4及后续接收端恢复/角色阶段未到达，不计为通过。

### 独立SQL与视觉核对

原failure-only保留目录留下cycle1/2各自main/WAL。两个main均28,672 bytes、SHA `1520f6ad…`；WAL分别12,392/16,536 bytes，SHA `2b54500f…`/`63414e2e…`。在全新独占查询目录 `independent-exact-query-j3obmtc2` 中，验证大小/摘要/非symlink/owner后复制，以 `mode=ro` 检查实际ordinary-table schema，再按实际唯一map的BLOB storage_key、01前缀key/value、compression0执行JOIN WHERE/COUNT，无LIMIT：

| 周期 | keyCount | 本轮新值 | 上轮旧值 | 原business row | integrity |
|---|---:|---:|---:|---:|---|
| 1（通过） | 1 | 1 | 不适用 | 1 | ok |
| 2（失败） | 1 | **0** | **1** | 1 | ok |

原生页面读回与独立数据库旧值一致；保留原件、查询副本main/WAL及原failed receipt前后hash均不变。storage_key来自实际唯一map并限定动态loopback origin；原receipt没有保留plain-text business URL，因此不虚构“又与receipt URL交叉核对”的证明。该结果确认更新未保留，不唯一证明它在Put/load/commit哪一层丢失。

4张原PNG均已实际Read、核SHA并写独立 `visual-review.json`：有限同步/比较范围、备份仍处理警告以及失败时两卡Stopped均如实可见；失败图源卡Local Changes、归档新卡Never、健康Not checked yet。截图没有marker值，不能替代SQL或当作保存成功。fresh HOME的Trial仍不代表修改真实授权。

### 成功与失败的进程族差分

失败cycle2由prewrite注册 **PID62140 → family r4 / processes[30]** 定位，不能错配到后续relaunch r5/PID62279。原native ChildProcess ledger在 **failure阶段** 补读到exitObserved=true、**exitCode0/signalnull**；两次after-relaunch collection当时均unavailable，不能把补读结果前移。其Browser.close为acknowledged，stop实际887ms、PID退出/CDP断开均确认。

对应7个先前准入child `processes[31:38]` 在root-exit取样时全部gone；argv声明StorageService **PID62158 / processes[33]** 首次退出观测早于root观测209.881ms，root-exit时亦gone。这个差值是观察时刻差，不是精确内核退出或提交耗时；helper本身的exit码/signal没有采集，不能套用root结果。整次 **5 roots/42 children/47 records、694 scans、max gap352.375ms**，有raced edges、poll先见退出及未知labels，始终partial。

失败侧同样 **survivors=0、没有surviving-child命名lsof查询**；成功侧关键4轮也如此。`failure-family-comparison.json`保留6个关键cycle的对应位置与限制。**正常root退出、close ACK和已准入child已gone可以与新值丢失同时出现**；“等待这些已退出child”不能区分该反例，不能用它宣称修复。未观察成员、pending Put/load/commit及其他native收尾分支仍未知。

### 不采用另一个猜修复，保留阻塞

额外只读核验7个native源码片段：CDP `ExitIgnoreUnloadHandlers → AttemptExitInternal(true) → platform_part()->AttemptExit → chrome_browser_application_mac::Terminate → [NSApp terminate:nil] → AppController::tryToTerminateApplication` 已进入原生Quit同一入口；不是另一套LocalStorage shutdown。CDP的kSilentExit/clean标记和原生可取消门确有差异，但已读链未发现native-Quit独享的存储完成ACK；没有实施Quit API替换，未展开的下游kSilentExit影响仍未知。源码与已选binary的逐字同构仍未认证。

只读REA Mach-O元数据另锁定既有launcher SHA `f83b0a79…`、269,874,464-byte Framework SHA `af50fde6…`。Framework工具仅返回3个外部入口，未取得typed StorageAreaImpl/commit地址；exports非穷尽，不能据此断言函数不存在。Ghidra未配置、Hopper不可用，未安装/改配置或猜地址挂钩，也没有修改/构建native引擎。元数据不是执行/落盘证据。

原test结束后，observer最终已准入身份均不再live，另按本ROOT候选PID/libproc路径核Electron/Chromium/helpers为空、无metadata未知，随后明确交还Mac；后续仅离线SQL/看图。**#52仍未修复，#51仍阻塞；当前源码的完整默认6081通过/覆盖率不被改写，也不能覆盖此次真实native失败。**

### 下一阶段现成观测量的真实性边界（仅离线审查，未新增运行）

4个storage实现的窄查识别了DB操作返回后的 `Storage.LocalStorage.ReadMapKeyValues/UpdateMaps` 及duration基名、SQLite `Database.Error`、析构前pending ReadWrite load的 `ShutdownDroppedChanges`、调度延迟 `LevelDBWrapper.CommitDelay` 和access metadata结果。没有取得per-Put/per-marker或commit-start证明；UpdateMaps可空批/跨area，成功聚合样本不能覆盖此marker旧值反例；上层weak callback可消失，错误/零样本也不等价全提交或无错误。完整status/duration后缀及桶编码未在本次范围内读取，不猜造。

只读选定Framework字节确实含 `Storage.%s.ShutdownDroppedChanges` 模板及若干其他指标字面串；完整LocalStorage/Duration名称由源码运行时拼接，不能因找不到连续完整字符串就推断代码不存在或binary不匹配。该普通本地byte查找不是REA Evidence，file offset不是可调用地址，更不是实际记录过指标。

另限2个源码文件核对CDP `Browser.getHistogram(s)`：会先导入当前Global persistent allocator可见数据，并非只能看调用前已注册Root样本；但没有走child provider fetch/merge barrier，不含child PID或marker归属。Storage utility allocator共享/退出后保留及枚举默认过滤仍未知。因此root API成功/空数组/找不到/delta0不能当storage62158真实零样本；未据此启动第三次原链或编写“指标已证实完成”的伪门。后续仍需有归属、覆盖明确的native Put/load/DB-return/teardown证据。源码注释指向的上游issue503422295尝试只读访问时被网络安全检查阻止，未取得详情、未绕过；不从TODO推断公开状态、修复提交或本例根因。
