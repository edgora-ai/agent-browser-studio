# 产品审查逐项修复台账（2026-09-30）

## 公开历史记录说明

- 本文件是**截至 2026-10-08**、基于下述历史基线的修复与交付记录，**不是当前工作树或当前版本的全产品验收结论**。文中“当前”“已验证”“待处理”“未提交/推送”等均指相应历史阶段；原有通过、失败、pending、mock 限制及未覆盖项保留，不因本次公开整理重新确认或盖章。
- 后续边界补记（2026-10-18）：后续修复源码已以 `044a3d4` 公开，2026-10-18 预览已发布，但发布不等于实站验收通过；Ping0 仍为 **39 分 / 6 FAIL**，**strict no-mock 不满足**，Worker/DST、逻辑 Cookie 和操作归属仍未闭环，详见 [Firefox 自动身份回归记录](firefox-auto-identity-regression-2026-10-17.md)。
- `$EVIDENCE_ROOT`、`$EVIDENCE_ROOT_02` 等分别代指不同的历史本地临时证据根，`$REPO_ROOT` 代指当时的仓库根；相对证据路径和文件名保留以便检索。这些占位符不表示历史日志已纳入仓库、已公开或本轮已重跑。

## 基线与规则

- 来源：[原审查报告](product-ux-function-review-2026-09-30.md)。原报告保留为修复前记录，不覆盖历史结论。
- 基线：`8f6b6d4`，应用 1.0.1；修复分支：`fix/product-review-20260930`。
- 范围：F01–F18，另记录测试夹具 T01 和测试隔离前置 I01。S01–S03 产品建议不自动扩大为业务重构。
- 流程：复现/红测 → 最小修复 → 针对性回归与数据读回 → 独立复核 → 更新记录 → 下一项。
- “已验证”仅指本节明确列出的验证范围；最终全量与真实 GUI 验收单独记录。环境阻塞、不通过和未测项不能写成通过。
- 不自动提交、推送或发布；不修改原有用户数据、凭据与运行实例。
- 保留用户未跟踪文件：根目录 `agent-chat-content.js`、`browser-manager.js`、`output/`。前两者基线 SHA-256 分别为 `f9e2a7106385f9ef1dd8c855fd80e523c78d323e48f4897d3826b40ba4643821`、`05ba25ba593844ccb22cf5af02d0a023b6d76f5fb5eb82db09db30ad65013eb7`。

## 总览

| ID | 级别 | 问题 | 状态 |
|---|---|---|---|
| T01 | 测试基线 | release-manifest 固定版本夹具失效 | 已验证（单元测试；真实发布流程未测） |
| I01 | 安全前置 | E2E 同时隔离 HOME、用户目录与提供商环境 | 已验证（隔离单元、macOS Electron 冒烟与合成 undefined fixture；非文件系统沙箱） |
| F01 | P1 | 同步本地优先仍覆盖浏览器状态 | 已验证（隔离单元/E2E；真实浏览器与外部 S3 未测） |
| F02 | P1 | 同步远端优先覆盖本机凭据 | 已验证（隔离 Electron / 本地 mock S3、单元与磁盘/服务读回；真实外部同步未测） |
| F03 | P1 | 活跃任务被运行期对账误判中断 | 已验证（隔离 macOS Electron/SQLite/单元；本项主验收已通过；F01–F18 最终综合验收待执行） |
| F04 | P1 | 远期 Once 定时器溢出提前执行 | 已验证（隔离 macOS Electron、单元/冒烟、配置/SQLite/IPC 读回及独立再复核；本项主验收已通过；F01–F18 最终综合验收待执行） |
| F05 | P1 | 活跃 Run 可被删除/清空/淘汰 | 已验证（隔离单元/Electron、存储及 IPC/REST 读回、独立复核；本项主验收已通过；F01–F18 最终综合验收待执行） |
| F06 | P1 | 达到配置上限后已有配置不能启动 | 已验证（隔离 macOS Electron、单元与磁盘/IPC 读回；综合验收待执行） |
| F07 | P1 | 拒绝条款没有退出整个应用 | 已验证（限定范围、独立复核及主验收通过） |
| F08 | P1 | Profile 备份行为配置不完整 | 已验证（限定范围、独立复核及主验收通过） |
| F09 | P2 | 回收站索引失败仍报告成功 | 已验证（2026-10-08 单项详情、Undo/互斥、合法 ID、窄屏布局补修；独立复核与限定主验收通过） |
| F10 | P2 | 许可构建能力与安装前说明失实 | 待处理 |
| F11 | P2 | 推荐任务与实际 Agent 能力冲突 | 待处理 |
| F12 | P2 | 子页切换/预检失败丢失聊天输入 | 待处理 |
| F13 | P2 | Runs 列表与详情显示过期状态 | 待处理 |
| F14 | P2 | 成功批次仍显示重试失败按钮 | 待处理 |
| F15 | P2 | 首个配置创建后向导无法自动续接 | 待处理 |
| F16 | P2 | 将回收站当作磁盘故障备份替代 | 待处理 |
| F17 | P3 | 侧栏硬编码旧版本 | 待处理 |
| F18 | P3 | 空状态和会话标题动态国际化不完整 | 待处理 |

## T01 — 版本更新测试基线

- 状态：已验证（单元测试范围）；仅测试夹具变更，`src/main/services/update-manager.ts` 的生产更新过滤规则未修改；真实发布流程未测。
- 复现：`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run tests/unit/release-manifest.test.ts --reporter=dot` → **1 failed / 5 passed**，`expected [] to include '1.0.1'`（`$EVIDENCE_ROOT/t01-red.log`）。
- 根因：旧夹具写死新版 1.0.1，却从应用实际 `package.json` 读取当前版本 1.0.1，同版本按预期不会更新。
- 变更：`tests/unit/release-manifest.test.ts` 为 Electron mock 的应用根目录创建明确版本 `package.json`，当前夹具为 current=0.9.7、next=0.9.8、equal=0.9.7、older=0.9.6；调用真实 `checkForUpdates()` 断言当前版本、仅推荐较新且兼容的 next，并验证 minSupported 门槛过滤。其余清单生成工具用例中的 1.0.1/1.0.2 是独立的发布清单样本，不代表该更新检查夹具。
- 验证：早期单文件绿测 **6/6**（`$EVIDENCE_ROOT/t01-green.log`，当时仍使用旧夹具）；对当前夹具的独立复核定向运行（与 I01 合并）为 **2 files / 13 tests passed**，且作用域内 TypeScript `--noEmit`、`git diff --check` 均 exit 0。未执行真实发布或已安装应用更新流程。

## I01 — 测试隔离前置

- 状态：已验证（共享启动辅助工具、隔离单元测试、macOS Electron 安全环境冒烟及合成 undefined fixture 回归）；仅改测试启动辅助工具与回归测试，未改业务代码。原先独立复核及旧验收不覆盖本轮 undefined 缺口；本轮红/绿、严格类型、构建、隔离 E2E 和全量单元/冒烟通过后，独立最终复核通过。范围不等于文件系统沙箱或所有平台已测。
- 根因：`tests/e2e/helpers/app.ts` 原来将整个 `process.env` 传给 GUI/headless Electron，`--user-data-dir` 并未隔离 HOME；`detectLocalLlmConfig()` 可读取宿主设置或继承宿主提供商密钥。
- 变更：`tests/e2e/helpers/launch-env.ts` 为共享 GUI/headless 启动构建最小透传环境；隔离 HOME/USERPROFILE、平台应用目录、XDG/临时目录、Chromium/Firefox/bundled 缓存，关闭遗留数据迁移，默认 REST/MCP 随机端口（headless 选可连接临时端口）。先将显式 fixture 环境键规范化为大写，再校验凭据、端点、隔离目录与重复键；仅允许受控本地 HTTP mock/provider 端点和浏览器 fixture，拒绝云端端点及 HOME 覆盖。`app.ts` 在生成 child env 前只查找既有浏览器二进制，不传宿主用户目录或凭据；新增 `keepInitialDialogs` 选项保留向导/条款，默认仍自动关闭。版本选择在未指定浏览器路径/缓存 fixture 时，自动把两个已知安装根目录中可识别且二进制完整的已安装 Chromium 版本链接到**隔离的测试缓存**，而非向子进程继承宿主缓存根目录；指定 fixture 时则不自动暂存。
- 回归：`tests/unit/e2e-launch-env.test.ts` 使用**虚构**宿主密钥、端点、模型、HOME、注入参数和端口，验证只透传安全基础变量、目录确实创建、默认端口/迁移开关、显式本地 fixture、大小写混用的凭据校验及模拟已安装浏览器版本的暂存与过滤。独立复核对当前代码运行 `PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run tests/unit/e2e-launch-env.test.ts tests/unit/release-manifest.test.ts --reporter=dot` → **2 files / 13 tests passed**；作用域内 TypeScript `--noEmit` 和 `git diff --check` 均 exit 0。旧 `prereq-focused.log` 是中间版本的 **2 files / 10 tests passed**，不是当前 13 项的日志。
- 阶段全量：之前的 `PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run tests/unit tests/smoke --reporter=dot` → **122 files / 1388 passed, exit 0**（`$EVIDENCE_ROOT/prereq-unit-smoke.log`；为后续补测前的中间版本）。之前的定向 `PATH=/usr/local/bin:$PATH node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module ES2022 --moduleResolution bundler --types node --skipLibCheck tests/e2e/helpers/app.ts tests/e2e/helpers/launch-env.ts tests/unit/e2e-launch-env.test.ts tests/unit/release-manifest.test.ts` → **exit 0**（`$EVIDENCE_ROOT/prereq-typecheck.log`）；主验收对最终代码重跑同一全量命令 → **122 files / 1392 tests passed，exit 0**（`$EVIDENCE_ROOT/prereq-final-unit-smoke.log`）；`PATH=/usr/local/bin:$PATH npm run build` → **exit 0**，输出 `no public key in env — trial-only build`（`prereq-main-build.log`）。`git diff --check` 通过，两个原有未跟踪 JS 文件 SHA-256 与基线一致。
- 真实进程验证：`PATH=/usr/local/bin:$PATH node $EVIDENCE_ROOT/runtime-isolation-smoke.cjs` → **exit 0**（`runtime-isolation-final.log`）。真实 Electron 读回 Node `os.homedir()`、HOME、userData 均位于本轮临时目录；继承提供商变量列表为空；IPC `llmConfig()` 与 `detectLlmConfig()` 的 `hasApiKey` 均为 false；未发送任何聊天请求。界面截图已查看，正常显示首启条款，无 pageerror；测试进程正常关闭。
- 验证边界：macOS 的 Electron 原生 `app.getPath('home')` 仍指向登录用户目录，而模型检测实际使用的 Node `os.homedir()` 已隔离；这不是文件系统安全沙箱。最初冒烟脚本使用不可用的 `require`、继而误把原生 home 当作 Node home，两个脚本断言失败已保留日志，修正探针后通过，非产品修复。Windows、headless 实际启动、完整用户旅程、已安装应用与真实提供商未测；历史 direct launcher 不在本轮隔离范围。后续带模型 mock 的测试仍须核对实际端点及脱敏 `hasApiKey`，不能把 `apiKey` 缺失视为未配置。

- I01 类型收尾：F01 的额外严格类型检查暴露 `NodeJS.ProcessEnv` 含 undefined，与 Playwright 的字符串环境约定不符。新增 undefined fixture 红测 **1 failed / 7 passed**（`i01-env-types-red.log`），随后过滤 undefined 并将辅助工具返回类型收窄为 `Record<string,string>`；未放宽隔离规则。`PATH=/usr/local/bin:$PATH node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module ES2022 --moduleResolution bundler --types node --skipLibCheck tests/e2e/helpers/app.ts tests/e2e/helpers/launch-env.ts tests/unit/e2e-launch-env.test.ts tests/e2e/f01-sync-pull-artifacts.test.ts tests/unit/sync-pull-runtime-selection.test.ts` → **exit 0**（`i01-env-types-green.log`），随后的全量测试 **1399/1399** 包含该新回归。
- undefined 默认值红测与修复：此前仅过滤最终输出，`{ HOME: undefined }` 仍可在合并时抹去隔离 HOME，未定义的端口/缓存别名也会误删默认键或造成重复键误报。先以合成 fixture 覆盖 HOME、USERPROFILE、各平台配置/临时目录、迁移开关、REST/MCP 端口及别名、浏览器缓存和混合大小写键；`i01-undefined-protected-red.log` **1 file / 2 failed、8 passed，exit 1**。`normalizeTestLaunchFixtureEnv()` 现于规范化、校验、别名处理及合并之前跳过 undefined；临时目录中的独立合成环境检查确认输出与隔离默认值完全一致，已定义的受保护覆盖、重复别名、非支持凭据仍被拒绝。这里验证的是构造出的环境对象，**没有用原先不安全的 undefined 环境启动 Electron**；此前安全环境的实际 Electron 冒烟见上条。
- 本轮绿测与最终复核：`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run tests/unit/e2e-launch-env.test.ts tests/unit/sync-service.test.ts tests/unit/sync-pull-runtime-selection.test.ts --reporter=dot` → `i01-undefined-protected-focused-unit.log` **3 files / 66 passed**；受影响辅助工具和 F01/F02 单元及 E2E 的严格 TypeScript 检查 → `i01-undefined-protected-strict-types.log` **exit 0**；`PATH=/usr/local/bin:$PATH npm run build` → `i01-undefined-protected-build.log` **exit 0**（无发布公钥，试用版构建）；`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run -c vitest.config.e2e.ts tests/e2e/f02-sync-credentials.test.ts tests/e2e/f01-sync-pull-artifacts.test.ts tests/e2e/j62-sync-merge-strategy.test.ts --reporter=dot` → `i01-undefined-protected-e2e.log` **3 files / 19 passed**；`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run tests/unit tests/smoke --reporter=dot` → `i01-undefined-protected-unit-smoke.log` **123 files / 1404 passed**。独立最终复核 verdict=pass、无待修问题；`git diff --check` 通过，用户原有两个未跟踪 JS 的 SHA-256 与基线相同。日志均在 `$EVIDENCE_ROOT/`；本轮未改 F02 业务代码。

## F01 — 同步数据选择

- 状态：已验证（F01 明示的隔离单元、真实 Electron + 本地 mock S3 E2E、构建和数据读回范围）；首次独立只读复核发现异步运行时 Cookie 导入期间丢失并发创建的 Profile，补红测和修复后再次独立复核通过，主验收据实核对。仅关闭 F01，不代表 F02–F18 或最终综合验证完成。
- 复现与根因：原 `syncService.pull()` 在计算 `mergeSectionById` / `resolutionFor` 之前，就为每个远端 Profile 建目录并导入运行时或排队 Cookie、LocalStorage、Preferences；因此选 local、新旧时间并列/本地较新及逐项选 local 时仍覆盖浏览器数据。新增真实 Electron 测试在生产代码修改前运行：`f01-red-e2e.log` **4 failed / 3 passed**，均为期望 local 却读到 remote；`f01-red-runtime.log` 的运行时 Cookie spy 捕获了选 local 后的实际导入调用（另有一项测试夹具的归一化断言噪声，随后修正）。
- 修复：`src/main/services/sync-service.ts` 在任何 Profile 目录/运行时 Cookie/排队 Cookie/文件操作前，从同一份本地配置快照按全局策略与逐项覆盖决定每个 Profile 的来源，再合并元数据；远端独有仍导入、本地独有保留；元数据相同也按用户策略选择文件来源，newest 严格 `remote.updatedAt > local.updatedAt` 才选远端，并与元数据合并共用判断。仅所选远端 Profile 创建目录并恢复工件；`markRemoteProfilesSynced()` 只处理所选远端且 Preferences 确已导入的 Profile，不给选 local 的条目写远端同步时间/哈希。原有 Profile ID 校验、解包/大小限制、原子文件写、还原锁及运行中跳过 LocalStorage/Preferences 的路径保留。
- 回归及数据读回：`tests/e2e/f01-sync-pull-artifacts.test.ts` 采用随机临时 userData、随机端口本地 mock S3 和真实 Electron IPC，检验 local/remote/newest（远端较新、本地较新、并列）、双向逐项覆盖、元数据相同但浏览器工件不同、远端独有/本地独有、运行锁跳过及无效 ID/无效 base64 的失败保留；每次直接读 `config.json`、`Preferences`、LevelDB `CURRENT`、排队 Cookie JSON，再以 `profile.get`/`profile.list` 按测试 ID 查询读回。`tests/unit/sync-pull-runtime-selection.test.ts` 在独占临时目录对真正的 `pull()` 运行时 Cookie 导入做 spy，并验证预先/抓取期间中止不会改本地元数据或导入 Cookie。J62 原集成测试仅补录 custody 同意并改用独占临时目录。绿测：`f01-final-unit.log` **2 files / 51 tests passed**；`f01-final-e2e.log` **2 files / 15 tests passed**；`f01-unit-smoke.log` **123 files / 1396 tests passed**；`f01-build.log` 构建 exit 0；`git diff --check` exit 0。日志均位于 `$EVIDENCE_ROOT/`。
- 独立复核后补修：审查者在独立临时目录用运行时 Cookie 导入的受控等待复现：原先于等待前取得 `latestConfig` 和 `mergedProfiles`，等待期间另建 Profile 已写入 `config.json`，Pull 返回成功却将它从磁盘和列表删除（反证 `$EVIDENCE_ROOT_02/tests/unit/f01-snapshot-race.test.ts`）。本轮仓库内补两个单测：并发新增无关 Profile，以及并发修改所选 Profile；修复前 `f01-race-red.log` **2 failed / 4 passed**。修复在同步提交时通过 `store.transact()` 从最新 draft 合并，仅替换原先选远端的 Profile；对这些 Profile 用独立快照与当前条目比较，运行时导入等待前后、恢复工件前及提交时发现修改/删除或远端独有 ID 被并发占用即失败，不以旧合并结果覆盖当前配置；去除失败后以旧快照 `saveConfig()` 覆写的后备路径。修复后 `f01-race-green-unit.log` **2 files / 53 passed**、`f01-race-e2e.log` **2 files / 15 passed**、最终复跑 `f01-race-final-unit-smoke.log` **123 files / 1398 passed**；`f01-race-build.log` 构建 exit 0、项目 `tsc --noEmit` exit 0、`git diff --check` exit 0。测试直接读取并发写入前后 `config.json`，再由 `getConfig()` 与 `getProfileMeta()` 按 ID 查询；修改选中条目则要求失败并直接读回用户版本。以上日志位于 `$EVIDENCE_ROOT/`。
- 验收命令与输出（仓库根目录，日志在 `$EVIDENCE_ROOT/`）：`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run tests/unit/sync-service.test.ts tests/unit/sync-pull-runtime-selection.test.ts --reporter=dot` → `f01-race-green-unit.log` **2 files / 53 passed**；并发修复前 `PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run tests/unit/sync-pull-runtime-selection.test.ts --reporter=dot` → `f01-race-red.log` **1 file / 2 failed / 4 passed**。`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run -c vitest.config.e2e.ts tests/e2e/f01-sync-pull-artifacts.test.ts tests/e2e/j62-sync-merge-strategy.test.ts --reporter=dot` → `f01-race-e2e.log` **2 files / 15 passed**；最初生产修复前 `PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run -c vitest.config.e2e.ts tests/e2e/f01-sync-pull-artifacts.test.ts --reporter=dot` → `f01-red-e2e.log` **1 file / 4 failed / 3 passed**。`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run tests/unit tests/smoke --reporter=dot` → `f01-race-final-unit-smoke.log` **123 files / 1398 passed**。`PATH=/usr/local/bin:$PATH npm run build` → `f01-race-build.log` **exit 0**；`PATH=/usr/local/bin:$PATH node node_modules/typescript/bin/tsc --noEmit --project tsconfig.json`、`git diff --check` → **exit 0**。独立复核另行重跑上述定向单元和隔离 E2E，分别 **53/53** 和 **15/15**，复核项目 TypeScript 与 diff 检查均通过；独立复核未另跑构建或全量单元/冒烟，其通过记录以上述主验收日志为依据。
- 文件写入与读回：运行时 Cookie importer 的受控等待期间 `saveConfig()` 新增无关 Profile，直接读临时 `config.json` 可见 `created-during-pull`；Pull 成功后再次直接读仍存在，`getConfig()`、`getProfileMeta(CONCURRENT_ID)` 都返回同名。等待期间把所选 Profile 改为 `edited-during-pull`，Pull 返回冲突失败，直接读 `config.json` 及 `getConfig()` 均保留用户修改。隔离 Electron 测试直接读 `config.json`、`Preferences`、LevelDB `CURRENT` 和排队 Cookie JSON，校验每项取 local/remote 时元数据及工件来源一致，再经 IPC `profile.get(id)`、`profile.list()` 按 ID 查询读回；失败路径保留原有文件和配置。根目录原有 `agent-chat-content.js`、`browser-manager.js` 的 SHA-256 与台账基线一致。
- 隔离与边界：E2E 启动后实测 Node `os.homedir()`、HOME、Electron userData 都落在临时路径，继承提供商变量为空，IPC `llmConfig`/`detectLlmConfig` 的 `hasApiKey` 都为 false；全程无聊天请求、不连真实 S3/代理/模型、不启动浏览器。没有把配置事务与多类文件写入宣称为跨资源原子 Pull；运行时 Cookie 导入在异步等待中已发起，若之后检测到冲突，已注入的 Cookie 不能回滚，返回失败且阻止后续工件/元数据提交；测试中运行时 Cookie 以 spy 模拟而非真实浏览器验证，运行中 LocalStorage/Preferences 用锁标记验证跳过。真实外部 S3、跨平台与真实浏览器并发交互尚未测试；本项不处理 F02 的凭据语义。额外对测试文件单独运行 `tsc --noEmit --strict` 时因既有 I01 共享辅助工具 `tests/e2e/helpers/app.ts` 两处 `ProcessEnv` 与 Playwright `env` 的类型不兼容而退出 2（`f01-test-typecheck.log`）；F01 文件未报新错，项目 `tsc --noEmit --project tsconfig.json` 与 `npm run build` 均为 exit 0。

- 主验收复跑：重新构建当前源文件 → **exit 0**（`f01-main-build.log`），全量 unit/smoke → **123 files / 1399 passed**（`f01-main-unit-smoke.log`，比此前新增 I01 undefined 环境值回归）；使用显式 `-c vitest.config.e2e.ts` 重跑 → **2 files / 15 passed**（`f01-main-e2e-configured.log`），`git diff --check` 通过。首次按台账遗漏配置参数的命令执行时得到 **No test files found，exit 1**（`f01-main-e2e.log`），已修正文档命令并实际重跑，未将零测试当作通过。上条提及的 I01 严格类型错误已按 I01 收尾修复，严格检查现为 exit 0。

## F02 — 同步凭据保留

- 状态：已验证（隔离 macOS Electron + 本地 mock S3、单元/冒烟、磁盘与服务读回范围）；独立最终复核通过，I01 undefined fixture 阻塞已单独修复并验收。F02 业务代码在 I01 补修期间未改；不代表真实外部同步、其他平台或综合验收通过。
- 复现：`tests/e2e/f02-sync-credentials.test.ts` 在生产代码改动前运行 `PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run -c vitest.config.e2e.ts tests/e2e/f02-sync-credentials.test.ts --reporter=dot` → **1 file / 3 failed、1 passed**（`$EVIDENCE_ROOT/f02-red-e2e.log`）。相同代理端点的远端元数据获胜后，磁盘密码由加密值变为缺失；空字符串代理密码同样被抹去。原 `serializeSyncSafeConfig()` 故意不上传代理 username/password 和账号 platformPassword，但通用 `mergeSectionById()` 在远端获胜时替换整个本地条目，误把“未同步秘密”当成删除。
- 变更：`src/main/services/sync-service.ts` 在提交时的最新 `transact` draft 上，代理合并只在同名且 **type/host/port 全部相同** 的远端获胜条目中拷回本地 `username`/`password`；账户只对 username + URL 的同一键拷回本地 `platformPassword`。远端仍决定其余元数据（包括 bypassList、tags 等），不扩散本地整条记录；仅秘密字段不同不触发无意义的远端采用。端点/协议/端口改变时远端目标不带旧认证，账户新身份为无密码的独立条目，旧账户仍可按旧键读回；远端凭据先经原有 `sanitizeRemoteConfig()` 丢弃，出站序列化仍不含秘密。F01 的 Profile 工件选择、并发变更检查及 commit-time live draft 未改动。
- 真实读写证明：新 E2E 从 IPC 添加**纯合成**代理和账户，实际 pull 后直接解析临时 `userData/config.json`，断言同目标下 `v2:`/`os1:` 密文逐字节保留、不含明文；通过主进程已加载模块的 `getProxySecret()` / `getAccountPassword()` 确认解密结果，再按名称/身份查询 IPC `proxy.get`、`proxy.list`、`agent.accounts.list` 确认元数据正确且公开响应无密码。覆盖 remote/newest、并列本地、全局本地、双向逐项覆盖、重复 pull、远端恶意凭据、远端独有、host/type/port 与账户用户名/URL 变化；代理空密码 `""` 和账号现有“加密空串、服务读取为 null”语义在 pull 后保持原密文，不重复加密。先 push、远端元数据 pull 后再 push，解压检查本地 mock S3 的配置对象均不包含代理认证、账户密码、合成明文或密文。
- 验证与复核（日志均在 `$EVIDENCE_ROOT/`）：`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run tests/unit/e2e-launch-env.test.ts tests/unit/sync-service.test.ts tests/unit/sync-pull-runtime-selection.test.ts --reporter=dot` → `i01-undefined-protected-focused-unit.log` **3 files / 66 passed**；`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run -c vitest.config.e2e.ts tests/e2e/f02-sync-credentials.test.ts tests/e2e/f01-sync-pull-artifacts.test.ts tests/e2e/j62-sync-merge-strategy.test.ts --reporter=dot` → `i01-undefined-protected-e2e.log` **3 files / 19 passed**；`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run tests/unit tests/smoke --reporter=dot` → `i01-undefined-protected-unit-smoke.log` **123 files / 1404 passed**。严格受影响 TypeScript 与 `npm run build` 均 exit 0，`git diff --check` 通过；独立最终复核 verdict=pass，F02 同目标保留、跨目标不复用及出站脱敏未见可证实缺陷。保留历史：初次绿测 **56 单测 / 19 E2E / 1402 全量**；中途测试误用空串 `not.toContain` 导致 **1 failed / 18 passed**，修正断言后重跑 **19/19**；先前复核 **64 单测 / 19 E2E**，曾指出 I01 undefined 缺口（见上节），本轮已修复并复核通过。
- 主验收核对了最终合并代码及 I01 undefined 归一化顺序，并复跑全量 unit/smoke → **123 files / 1404 passed**（`f02-main-unit-smoke.log`）、带显式 E2E 配置的 F02/F01/J62 → **3 files / 19 passed**（`f02-main-e2e.log`），两者总命令 exit 0，`git diff --check` 通过。
- 隔离/边界：真实 Electron 的 Node home、HOME、userData 均在测试独有临时目录，未继承提供商密钥，IPC 模型配置 `hasApiKey` 为 false；仅连接随机端口本地 mock S3，不连真实 S3、代理、浏览器或模型，未发聊天请求。macOS 开发构建使用隔离文件密钥；其他平台、正式签名的 OS 密钥后端与真实外部同步未测。F03–F18 和最终综合验收仍未完成。

## F03 — 运行期对账

- 状态：**已验证**（限本节隔离 macOS Electron、单元/冒烟、构建及配置/SQLite/IPC 读回范围）。回拨补修的独立只读复核 **verdict=pass，issues=[]**，复核重跑日志为 `f03-recheck-*`；主验收已复核当前源码、重新构建并运行合并的 F03/F04 定向测试 **134/134** 与隔离 Electron **28/28**（`f03-f04-main-build.log`、`f03-f04-main-focused.log`、`f03-f04-main-e2e.log`，总命令 exit 0）。不代表 F05–F18 或最终综合验收完成；中断代理遗留的 F05 红测仍在接续，不将当前整树称为全量通过。
- 复现/红测：原 resume/手动 `automation:reconcile` 把仅适合启动前的 SQLite 恢复与 `reloadSchedule()` 用于活进程，误终结 running/queued/retry-waiting 并清队列/重试；初次新 API 红测 `f03-red-unit.log` **23 failed / 40 passed** 仅证明新接口不存在，不充作旧行为反证。独立复核另在持久化 `missedAt`、SQLite 无行后回拨**主进程**时钟：旧实现 `timersRefreshed=1`，最终写入 `done`（`f03-review-clock-restored.log`）；补修前回拨单测 `f03-clock-red-unit.log` **2 failed / 45 skipped**。
- 修复：启动恢复仅由 `index.ts` 于启动边界调用；运行期 focus/resume/unlock/手动 IPC 改用 `refreshScheduleTimers()`，只刷新未来 once/cron 定时器，不改活跃任务 ownership、generation、队列与重试。回调核对 timer identity，cron 重新计算未来时间而不追赶执行，手动 IPC 刷新失败不伪报成功。错过的 once 仅在无活跃所有权时写 `missedAt`；同一计划一旦标记，刷新/重载不再武装，已武装回调执行前也核对当前计划及标记；显式重排生成新 `planId` 并清标记后仍可武装。`timersRefreshed` 只统计刷新定时器，运行期不做启动恢复或执行重放。
- 必需前置（单独列证）：真实 Electron 揭示旧 `runRule()` 先 `markFailed` 再调用只接受 running 的 `markRetryWaiting`，导致 SQLite 从无真正 retry-waiting；`f03-retry-red-e2e.log` **1 failed / 22 skipped**（磁盘读到 failed），`f03-retry-red-unit.log` **1 failed / 30 passed**。仅对继续重试的执行保持 running 后原子写入 retry-waiting/retryAt/首次错误，终态失败及重试成功仍分别 `markFailed`/`markDone`；`tests/unit/job-store.test.ts` 直接读行、服务按 ID 读回，真实 Electron 直接查询重试行并经 IPC `jobGet` 按 ID 读回；未改变 backoff 或自动重放规则。
- 存储/API 读回：单元用内存 SQLite 直接查询整行，再用 `getJob`/`listJobs` 按 ID 读回；真实隔离 Electron 的活跃 once 手动对账前后直接查 `jobs.sqlite` 仍 running、后续 done/result，`config.json` 的 once 禁用，再经 IPC `jobGet`/`jobs`/`automation.list` 查回；合成 queued/retry-waiting 孤儿仅于真正重启恢复，运行期不改其行。回拨用例先直接查旧 plan 的 `missedAt` 与 SQLite 无 once 行，临时回拨**主进程** `Date.now`、对账并恢复，等超过旧定时器延迟后再查仍无行；IPC `automation.list`/`jobs({ruleId})`/`scheduleState` 按 ID 保持 missed-once；显式重排后直接查新 `planId`/清标记，IPC 读回已武装的未来时间。独立复核对隔离 `config.json`/`jobs.sqlite` 再作只读核对：旧计划无执行行、真实 once 为 done、`PRAGMA integrity_check=ok`。
- 命令/结果（日志前缀 `$EVIDENCE_ROOT/`）：`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run tests/unit/automation-scheduler.test.ts tests/unit/automation-reconcile.test.ts tests/unit/job-store.test.ts --reporter=dot` → `f03-recheck-focused-unit.log` **3 files / 97 passed**；`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run -c vitest.config.e2e.ts tests/e2e/m3-scheduling-notifications.test.ts --reporter=dot` → `f03-recheck-electron.log` **1 file / 24 passed**；`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run tests/unit tests/smoke --reporter=dot` → `f03-recheck-unit-smoke.log` **123 files / 1413 passed**；`PATH=/usr/local/bin:$PATH npm run build` → `f03-recheck-build.log` **exit 0**（无公钥试用构建）；项目型检及 F03 测试/共享启动工具严格型检 `f03-recheck-project-types.log`、`f03-recheck-scoped-types.log` 均 exit 0，`git diff --check` exit 0。补修实施阶段相应 `f03-clock-*` 绿测同为 **97 / 24 / 1413**；首次新增 E2E 的 NaN 夹具参数错误非业务红测，修正后通过。旧 `job-store.test.ts` 整文件严格型检存在 **17 个既有可空断言错误**（`f03-retry-final-strict-types.log`），未宣称全测试严格型检通过。
- 边界：仅在 macOS 隔离 Electron 手动 IPC/注入入口核验，未改系统时钟、模拟物理睡眠或真实时区切换，也未验其他平台/真实 GUI 旅程；孤儿 queued/retry-waiting 是合成 SQLite 行，运行中的 once 才是真实执行。每次 E2E 核验隔离 Node HOME、进程 HOME、userData、无提供商环境键及脱敏配置 `hasApiKey=false`；无真实模型、浏览器、代理或 S3 请求，未读用户数据/密钥/设置，根目录两个用户未跟踪 JS 的 SHA-256 与基线相同。REST/鉴权未改、未作 REST 端点验收；F04 远期定时器溢出及 F05–F18 待处理。

## F04 — 远期单次调度

- 状态/复核：**已验证**，限隔离 macOS Electron、定向及全量单元/冒烟、构建与配置/SQLite/IPC 读回。首次独立复核 **verdict=changes_required**，指出冷却跳过后回拨可重复执行；补修后的独立只读再复核 **verdict=pass，issues=[]**，未发现本次补修可证实的回归（复核日志 `f04-independent-recheck-*`）。主验收已复核调度源码、重新构建并重跑定向单元 **134/134**、隔离 Electron **28/28**（`f03-f04-main-build.log`、`f03-f04-main-focused.log`、`f03-f04-main-e2e.log`，exit 0）；F05 代理中断后留下待修红测，整树全量将在接续后重跑，不代表 F05–F18 或完整 GUI 已通过。
- 复现/红测：原 `scheduleRule()` 把 `once.at - now` 直接传给 `setTimeout()`；超过 Node `2^31-1` 毫秒会被压为 1 毫秒。模拟 Node 溢出钳制的假时钟回归（不是 Vitest 自身溢出）使 25/30/365 天计划提前执行：`f04-red-unit.log` **3 failed / 47 skipped**。首次修复虽有 **105 单元 / 27 Electron / 1421 全量**绿测，独立复核仍用隔离 SQLite/config/IPC 复现到期冷却写 `skipped`、时钟回拨后同一 `planId` 再写 `done`（`f04-review-skip-rollback-repro.log`）；新增调度红测 `f04-review-fix-red-unit.log` **1 failed / 55 skipped**，状态分类回拨红测 `f04-review-fix-red-state.log` **1 failed / 27 skipped**。上述日志均位于 `$EVIDENCE_ROOT/`。
- 修复：`src/main/services/automation.ts` 的 Once 与 cron 共用 24 小时计时上限，每段按墙上时钟重算距固定 `at` 的剩余时间，回调核对计时器身份、代次、持久 `planId`/`trigger.at`/`missedAt` 及启用状态；`armedAt` 始终是 Once 真正截止时间，非中间分段。到期时对**终结性 cooldown 拒绝**写入 `skipped` 后立即在无待处理工作时持久化同计划的 `missedAt`；`running` 拒绝不提前标记，保留 F03 队列/重试所有权。`src/main/services/automation-state.ts` 先识别 `missedAt` 再判断冷却，回拨后仍为 `missed-once`；只有显式重排生成新 `planId` 才重新武装。
- 命令/结果（均以 `PATH=/usr/local/bin:$PATH` 执行，日志目录 `$EVIDENCE_ROOT/`）：`npm run build` → `f04-independent-recheck-build.log` **exit 0**（无公钥试用构建）；`node node_modules/vitest/vitest.mjs run tests/unit/automation-scheduler.test.ts tests/unit/automation-state.test.ts tests/unit/automation-reconcile.test.ts tests/unit/job-store.test.ts --reporter=dot` → `f04-independent-recheck-focused-unit.log` **4 files / 134 passed**；`node node_modules/vitest/vitest.mjs run -c vitest.config.e2e.ts tests/e2e/m3-scheduling-notifications.test.ts --reporter=dot` → `f04-independent-recheck-electron.log` **1 file / 28 passed**；`node node_modules/vitest/vitest.mjs run tests/unit tests/smoke --reporter=dot` → `f04-independent-recheck-unit-smoke.log` **123 files / 1423 passed**。项目/受影响测试严格型检及 `git diff --check` **exit 0**（同前缀 `project-types`、`scoped-types`、`diff-check` 日志）；实施阶段 `f04-review-fix-final-*` 亦为 **134 / 28 / 1423**，构建与型检通过。单元覆盖超界延迟、时钟跳变、旧代次/停机重启、冷却跳过及回拨分类；首次绿测 `f04-first-green-unit.log` 的 **3/3** 不代替补修复核。
- 存储/IPC 读回：隔离 Electron 的 25/30/365 天计划直接读测试目录 `config.json` 中原 `planId`/截止时间，等待超过 Node 原始溢出 1 毫秒并对账，直接查 `jobs.sqlite` 无提前执行行，再用 IPC `automation.list`/`jobs({ruleId})`/`scheduleState` 按 ID 查询；显式重排后直接读新 `planId`、唯一 `done` 行及禁用状态，并以 `jobGet(id)`/列表读回。新增冷却用例在到期 `skipped` 后立即直查原计划 `missedAt` 与 SQLite 唯一 `skipped` 行，经相同 IPC 按 ID 读回；仅回拨隔离主进程 `Date.now`、对账、恢复并解除冷却后，旧计划仍只有该行。显式重排新 `planId` 才有新 `done` 行。独立再复核只读核查测试独有 `config.json`/`jobs.sqlite`（`f04-independent-recheck-disk.log`），包括旧 `skipped`、新 `done`、25/30/365 天计划各一条 `done`，`PRAGMA integrity_check=ok`；不宣称 JSON/SQLite 跨资源原子性。
- 覆盖边界：隔离 E2E 验证 Node `os.homedir()`、HOME、userData、无提供商环境键及脱敏 `hasApiKey=false`，只运行本地 `custom-js` 常量，未读真实用户配置/密钥、未请求真实模型/代理/S3；根目录两个用户未跟踪 JS 的 SHA-256 与台账基线一致，`output/` 未修改。跳变由假时钟及隔离主进程 `Date.now` 模拟；未更改宿主时钟、实际等待 25/30/365 天、验证物理休眠/跨平台/完整 GUI、持久化失败及崩溃交错。REST/鉴权未改且未验收相关端点；无额外共享前置修复，未开始 F05、提交/推送或创建 worktree。

## F05 — 活跃运行保护

- 状态/接续：**已验证**，仅限隔离单元、macOS Electron、存储与 IPC/REST 读回及独立复核；本项主验收已通过；F01–F18 最终综合验收待执行。最初实施代理因 API 流断开中止，**不是代码裁决**：仅留下 `tests/unit/agent-run-trace.test.ts` 的约 65 行红测，接续时保留并完成测试和实现，未回退早前 F01–F04 变更；该接续阶段未开始 F06。现主会话已复核 F05 核心差异并重新构建，运行全量单元/冒烟 **123 files / 1434 passed** 及 F05/F06 隔离 Electron **2 files / 3 passed**，总命令 exit 0；日志为 `f05-f06-parent-{build,unit-smoke,e2e}.log`（同前缀目录）。
- 红测/反证：原实现按末尾 200 条截断活跃 Run，单删/清空也可删活跃项；`f05-red-unit.log` **3 failed / 22 passed**。首次全量发现旧 `run-reconcile` 夹具期待删未终态项（`f05-full-unit-smoke.log` **2 failed / 1427 passed**），已调整为终态夹具。首轮独立复核 `changes_required`：普通设置保存淘汰终态记录却遗留成果与 SQLite 行（`f05-review-orphan-probe-live.log`）；活跃 `reloadConfig()` 被误判 error 并出现删除按钮。补修前 `f05-review-fix-red-unit.log` **2 failed / 27 skipped**。曾尝试在通用配置模块静态导入清理器而使一个隔离 mock 套件失败，撤回依赖、改由 recorder 注册，最终全量重跑通过。
- 修复/范围：共享保留策略只淘汰最旧终态；进程拥有或原始 `running` 的记录受保护，超过 200 条活跃可暂留。`agent-run-trace.ts` 的单删拒绝活跃、全清返回实际 `deleted/skipped`，提交成功后才清理绑定、成果与受控 SQLite；IPC/REST 共享防线及写权限，Runs UI 隐藏活跃删除并显示保留计数，双语/类型/OpenAPI 同步。`config/store.ts`/`config-manager.ts` 提交后仅对实际被普通保存归一化淘汰的终态 ID 调用已注册 recorder 清理；失败写入不先删成果。同一进程 `reloadConfig()` 保持自有 Run 为 `running`，只有失去所有权的持久 running 项按崩溃恢复。改动含 `src/main/services/agent-run-retention.ts`、`config/store.ts`、`config-manager.ts`、`agent-run-trace.ts`、`ipc/agent.ts`、`rest-api-server.ts`、`src/renderer/js/app/runs.js` 及对应类型、翻译与测试；MCP 无删除/清空入口。
- 绿测命令（均在仓库根目录，日志前缀 `$EVIDENCE_ROOT/`）：`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run tests/unit/agent-run-trace.test.ts tests/unit/run-reconcile.test.ts tests/unit/renderer-runs-m2.test.ts --reporter=dot` → `f05-review-fix-focused-unit.log` **3 files / 74 passed**；`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run tests/unit tests/smoke --reporter=dot` → `f05-review-fix-unit-smoke.log` **123 files / 1431 passed**；`PATH=/usr/local/bin:$PATH node node_modules/vitest/vitest.mjs run -c vitest.config.e2e.ts tests/e2e/f05-active-run-protection.test.ts --reporter=dot` → `f05-review-fix-final-e2e.log` **1 file / 2 passed**；`PATH=/usr/local/bin:$PATH npm run build` → `f05-review-fix-final-build.log` **exit 0**。`check:i18n`、`check:marketing`、作用域严格类型、项目类型、翻译镜像与 `git diff --check` 亦通过。独立只读再复核 `verdict=pass，issues=[]`，重新运行同样定向 **74/74**、全量 **1431/1431**、Electron **2/2**、构建 exit 0（`f05-independent-recheck-{focused-unit,unit-smoke,e2e,build}.log`）；此后主会话已按上条另行重跑通过。
- 存储/API 证明：单元注入配置写入 `EIO`，直读 `config.json`、result manifest、SQLite 行均保留；成功保存无关设置后，终态 ID 才从配置、manifest/预览和 `news_run_results_v1 WHERE run_id=?` 消失，再通过 recorder/result preview 查询。隔离 Electron 创建 **202 个合成 Run**，结束最旧项并用普通 `transact` 淘汰它：直读配置、成果文件与 SQLite，再由 IPC/REST 按 ID 查询淘汰项缺失、活跃兄弟仍运行。存活进程重载后，磁盘、IPC、REST 与 Runs 卡片仍为 `running`，无删除按钮；原有活跃拒删、混合清空及终态删除读回继续通过。REST 实测公开 `/health` 无认证 **200**、受保护列表无认证 **401**、有认证 **200**、viewer 写入 **403**、活跃删除 **409**、缺失 **404**、终态删除 **200**；IPC 同样拒删活跃并返回真实清空计数。
- 边界/隔离：E2E 验证测试独有 HOME、Node homedir、userData、无继承提供商变量且 `hasApiKey=false`；仅合成数据与随机本地端口，不访问真实用户设置/密钥，不连真实 LLM、代理或 S3。重载测试覆盖 Sync Pull 所调用的同一 `reloadConfig()`，**不等同额外并发 mock-S3 Pull**；真实浏览器、其他平台、Electron 配置提交故障注入及异常 SQLite 清理重试未测。recorder 尚未注册的 config-only 上下文会警告而非保证同步清理；超过配置字节预算时仍可能拒绝新写入。原有两个用户未跟踪 JS 的 SHA-256 与台账基线相同，`output/` 未改；无提交/推送/worktree，主批次综合验收与 F06–F18 另行处理。

## F06 — 配额与启动分离

- 状态/协作：**已验证**（限隔离 macOS Electron、单元及磁盘/IPC 读回；最终综合验收待执行），独立再复核 `pass/issues=[]` 且本轮主验收重跑通过，F07 未开始。此前并行执行上下文均已停止，恢复单写者；期间报告 `license.test.ts` 出现非当前执行上下文预期的夹具变化，经核查保留更严格的 JSON 签名篡改测试，不回退；不对修改来源作未证实归因。记录代理也运行了一轮命名为 `main-acceptance` 的验证，但那仍属代理验证。主会话随后亲自复核生产/测试差异，重新执行 `PATH=/usr/local/bin:$PATH npm run build`、全量 `node node_modules/vitest/vitest.mjs run tests/unit tests/smoke --reporter=dot` 及 `F06_SCREENSHOT_PATH=$EVIDENCE_ROOT/f05-f06-parent-window.png node node_modules/vitest/vitest.mjs run -c vitest.config.e2e.ts tests/e2e/f05-active-run-protection.test.ts tests/e2e/f06-profile-license-gates.test.ts --reporter=dot`：**构建 exit 0、1434/1434、3/3**，日志 `f05-f06-parent-{build,unit-smoke,e2e}.log`；已查看本轮 `f05-f06-parent-window.png`，本地页面标题正常显示，非空白。`git diff --check` 通过。主会话仅补台账，未修改 F06 源码/测试。
- 复现与修复：原创建/启动共用数量门禁，10 个试用 Profile 后真实 Electron `browser.launch(id)` 错报 `PROFILE_LIMIT`；`f06-red-unit.log` **2 failed/11 passed**、`f06-red-e2e.log` **1 failed**（磁盘及 IPC 已核实 10 条）。`src/main/services/license.ts` 改为 `evaluateGate(now, enforceProfileLimit)`：新建检查配额、启动仅检查许可有效性/期限；`src/main/ipc/browser.ts` 仅修正四个 IPC 启动路径注释，保留 `gatedLaunch`。单元覆盖试用 9/10/11、签名付费配额、过期/回拨、签名篡改与设备不符；读 `config.json`/`license.json`、重载后按门禁查询。
- 失败与稳定化：旧 `f06-final-e2e.log` 中 browser-level CDP WebSocket 已连接但握手 **30 秒超时**，未确认根因；改用现有 page CDP 后，`f06-serialized-e2e-repeat.log` 仍捕获 `/json` 先公告 `data:` URL、页面执行上下文尚为 `about:blank`。现等待真实文档标题/正文/URL 均一致再截图，稳定/最终多次各 **1/1**（`f06-serialized-e2e-{stable1,stable2,final1,final2}.log`）。首轮独立复核 `changes_required` 发现显式二进制夹具未传入发现函数（`f06-serialized-independent-explicit-fixture-red.log`）；仅修补 E2E 夹具后显式二进制两次、现有缓存一次均 **1/1**（`f06-serialized-fixture-fix-{explicit-e2e1,explicit-e2e2,cache-e2e}.log`）；生产许可逻辑未再改。
- 验证命令（均 `PATH=/usr/local/bin:$PATH`，日志目录 `$EVIDENCE_ROOT/`）：`npm run build` → `f06-serialized-main-acceptance-build.log` **exit 0**（无公钥，试用构建）；`node node_modules/vitest/vitest.mjs run tests/unit/agent-run-trace.test.ts tests/unit/run-reconcile.test.ts tests/unit/renderer-runs-m2.test.ts tests/unit/license.test.ts --reporter=dot` → `f06-serialized-main-acceptance-focused-unit.log` **87/87**；同命令运行 `tests/unit tests/smoke` → `f06-serialized-main-acceptance-unit-smoke.log` **1434/1434**；分别执行 `node node_modules/vitest/vitest.mjs run -c vitest.config.e2e.ts tests/e2e/f05-active-run-protection.test.ts --reporter=dot`、同命令换 `tests/e2e/f06-profile-license-gates.test.ts` → `f06-serialized-main-acceptance-{f05,f06}-e2e.log` **2/2、1/1**；F06 使用隔离父 HOME 和显式现有只读 Chromium 二进制。受影响测试/辅助工具 `tsc --noEmit --strict` → `f06-serialized-main-acceptance-types.log` **exit 0**；独立再复核构建、同组单元、全量、F05 E2E、显式二进制两次/缓存一次 E2E 亦通过（`f06-serialized-independent-recheck-*.log`），`git diff --check` 通过。
- 数据/浏览器读回：E2E 用独有临时 userData/HOME/缓存创建 10 个 Profile，每步直读 `config.json` 与目录，再经 IPC 列表/ID 查询核对；第 11 个拒绝时配置字节不变。第 10 个真实浏览器 PID、CDP 页面标题/正文/URL、运行状态及截图核实，单条和批量 IPC 启停后 CDP 端口均关闭；最终直读磁盘仍 10 条、IPC 按 ID 查询已停止且仍拒第 11 个（`f06-serialized-main-acceptance-f06-e2e.log` 输出 `profiles=10, finalRunning=false, rejected=PROFILE_LIMIT`）。已目视核对 `f06-serialized-main-acceptance-window.png` 显示本地页面；独立复核截图 `f06-serialized-independent-recheck-explicit-window1.png` 同样非空白。
- 失败路径/边界：显式空缓存按预期报无引擎（`f06-serialized-independent-recheck-no-engine.log`），故意将截图目标设为目录得到预期 `EISDIR`，teardown 无残留进程/目录（`f06-serialized-independent-recheck-teardown-failure.log`）；不下载引擎、不访问真实配置/密钥/模型/代理/S3，用户未跟踪两个 JS 的 SHA-256 与台账基线一致，`output/` 未触碰。`rest-api-server.ts`、`mcp-server.ts`、`automation.ts`、`local-agent.ts`、`webrtc-diagnostics.ts` 的直接 `launchBrowser` 为 **HEAD 已有**、不经 IPC 门禁（`f06-serialized-acceptance-entrypoints.log`），本项不声称全入口受控；其他平台、真实付费激活/公钥发布构建及外部服务未测。

## F07 — 拒绝并退出

- 状态：**已验证（限定范围、独立复核及主验收通过）**。独立复核 `verdict=pass，issues=[]`；主会话已复核退出链及界面差异，重新构建 **exit 0**、全量单元/冒烟 **124 files / 1446 passed**、合并 F07/F08/J65 与 F01/F02/J62 同步回归 **6 files / 30 passed**（`f07-f08-parent-{build,unit-smoke,e2e}.log`，同日志目录）。本轮自然退出、端口关闭、重启未同意、普通关窗和 headless 行为再次通过；主会话已查看 `f07-f08-parent-{terms,error}.png`，条款和框内错误清晰可见。F01–F18 最终综合验收待执行。
- 复现/红测：原 `termsDecline` 调用 `window.close()`，被主窗口关闭事件拦截并隐藏至托盘。`f07-red-unit.log` **4 failed / 4**（无退出 IPC）；隔离 Electron 真正点击拒绝按钮后 15 秒仍未退出，`exitCode=null`，`f07-red-e2e.log` **1 failed / 2 passed**。初版退出失败提示藏在顶层 modal 后；移除 IPC handler 的反证 `f07-inline-red-e2e.log` **1 failed / 3 skipped**，4 秒未见框内错误。日志均在 `$EVIDENCE_ROOT/`。
- 变更文件：`src/main/ipc/app.ts` 的受控 `app:quit` 调用 `app.quit()`，沿用 `src/main/index.ts` 的 `before-quit` 清理；`src/main/preload.cjs`、`src/renderer/api.d.ts` 暴露类型接口；`src/renderer/js/app/wizard.js` 拒绝时不写同意、不再 `window.close()`，失败可重试；`src/renderer/index.html` 在 modal 内以 `role="alert"` 显示双语错误，`src/renderer/js/i18n.js` 与根目录已跟踪 `i18n.js` 镜像同步。回执 `{success:true}` 只表示退出请求受理，不充当进程退出证明。
- 实施验证（`PATH=/usr/local/bin:$PATH`，日志在 `$EVIDENCE_ROOT/`）：`f07-inline-green-unit.log` **6/6**；`f07-final-e2e.log` **4/4**；`f07-final-build.log` **exit 0**（无公钥试用构建）。E2E 真实点击拒绝按钮后观察到**自然退出码 0**，原 REST/MCP 随机端口均拒连；同一 userData 重启条款再现，直接查询 `localStorage` 同意键为 null。故意移除 IPC handler 时 modal 内显示错误、按钮可重试且服务仍存活；原生关窗仍隐藏至托盘，headless 仍无窗口/托盘且健康接口存活。`f07-final-terms.png`、`f07-final-error.png` 已目视核对非空白和框内错误。
- 独立复核：`verdict=pass，issues=[]`，只读检查退出链、不写条款同意及失败可见性；重新构建 **exit 0**，F07 单元 **6/6**，全量单元/冒烟 **124 files / 1440/1440**，严格测试型检 **exit 0**，隔离真实 Electron **4/4**（`f07-independent-{build,unit,unit-smoke,types,e2e}.log`）。复核 E2E 再次确认自然退出码 0、REST/MCP 拒连、同一 userData 重启后同意键为空；`f07-independent-terms.png`、`f07-independent-error.png` 已目视核验。i18n、marketing、翻译镜像及 `git diff --check` 通过。
- 边界：仅隔离 macOS 开发构建与随机环回服务；活跃任务退出清理、其他平台、已安装包未测。测试 HOME/userData 隔离、提供商环境键为空且脱敏 `hasApiKey=false`；未接入真实模型、浏览器、代理或 S3。未修改 REST 鉴权、headless 同意策略或数据库业务写入；原有根目录未跟踪 `agent-chat-content.js`、`browser-manager.js` 的 SHA-256 与基线一致，`output/` 未触碰。独立复核未编辑生产代码/测试/台账；主会话后续验收结果见本节状态条目。

## F08 — 备份完整性

- 状态：**已验证（限定范围、独立复核及主验收通过）**。F08 独立只读复核 `verdict=pass，issues=[]`；主会话已复核归档白名单、持久化及权限差异，并以 `PATH=/usr/local/bin:$PATH` 重跑 `npm run build`、`node node_modules/vitest/vitest.mjs run tests/unit tests/smoke --reporter=dot`、`node node_modules/vitest/vitest.mjs run -c vitest.config.e2e.ts tests/e2e/f07-terms-quit.test.ts tests/e2e/f08-profile-archive-metadata.test.ts tests/e2e/j65-profile-archive.test.ts tests/e2e/f01-sync-pull-artifacts.test.ts tests/e2e/f02-sync-credentials.test.ts tests/e2e/j62-sync-merge-strategy.test.ts --reporter=dot`：**构建 exit 0、1446/1446、30/30**，总命令 exit 0；日志 `f07-f08-parent-{build,unit-smoke,e2e}.log`，`git diff --check` 通过。F01–F18 最终综合验收待执行。
- 红测：在生产代码修改前，新 `tests/unit/profile-archive.test.ts` 使用真实 ZIP 读取 `meta.json`，期望 DRM、Web App URL、strict 渲染比例、窗口前缀、指纹基线、预设及扩展引用随包恢复；`f08-red-unit.log` **1 failed / 7 passed**，归档 `profile` 缺少行为字段。初次隔离 Electron 验证暴露 REST viewer 对导入返回 200 而非 403（`f08-second-e2e.log`），修补后验证 403；测试夹具中的 macOS `/var` 软链接比较及 Electron dialog 动态导入先后失败，分别改为真实路径比较与主进程模块加载后复跑，未将中途失败记作绿测。
- 实现/依赖：`src/main/services/config-manager.ts`、`profile-archive.ts` 以显式白名单和导入校验往返 DRM、Web App URL、渲染比例、窗口前缀、指纹基线、预设及扩展启用引用；`fingerprint-baseline.ts` 仅接受采集器实际字段，拒绝嵌套/超限数据；事务保存，旧格式 1 归档仍可导入，失败仅清理本次新建目录。锁、同步字段、旧编辑时间、凭据、代理定义/扩展仓库包和本机字体绝对路径不迁移，导入生成本机新时间。`extension-repository.ts` 按真实路径/manifest 判断扩展包是否可用；单条/批量 IPC、REST 返回 `warnings`，Profiles UI 以中英文提示目标机需重配代理/凭据、安装缺失扩展、配置字体目录。服务层及 REST 导入均校验写权限；未修改许可或代理凭据策略。
- 数据流核验：`tests/unit/profile-archive.test.ts` 从真实 ZIP `meta.json` 解出行为字段并检查白名单及无字体绝对路径；导入后直读 `config.json`，重载配置后按 ID 调用 `getProfileMeta()`，枚举 ID 检索；格式 1 旧包、Firefox 版本、基线真实采集字段、坏 URL/版本/扩展/嵌套基线/地理与硬件输入的拒绝及写入前后字节不变均有回归。`tests/e2e/f08-profile-archive-metadata.test.ts` 在独有临时 HOME/userData 上用真实 macOS Electron 与合成浏览器文件执行 IPC 导出、解 ZIP、IPC/REST 导入、直读配置和 Preferences、进程内 reload、IPC 列表、REST ID 查询；验证三类警告、源路径遗漏及本机时间新值，真实 Profiles 导入 toast 给出依赖操作提示。REST `/health` 无认证 200、受保护列表/导入无认证 401、有认证读/导入 200、viewer 单条/批量导入 403、IPC viewer 拒绝，并核对拒绝前后配置字节/ID 数量。
- 实施/独立验证（`PATH=/usr/local/bin:$PATH`；日志均在 `$EVIDENCE_ROOT/`）：实施版 `f08-verified-build.log` **exit 0**（无公钥试用构建）、`f08-installed-extension-unit.log` **3 files / 40 passed**、`f08-verified-e2e.log` **2 files / 7 passed**、`f08-verified-unit-smoke.log` **124 files / 1446 passed**；独立只读复核重新构建 **exit 0**，定向 **3/40**、隔离真实 Electron F08+J65 **2/7**、全量单元/冒烟 **124/1446** 均通过（`f08-independent-{build,unit,e2e,unit-smoke}.log`）。实施阶段项目/作用域严格型检、i18n、marketing、翻译镜像及 `git diff --check` 通过；独立复核再次检查 i18n、marketing、`git diff --check`，未修改源码、测试或台账。
- 边界：E2E 实测隔离 Node home/HOME/userData，继承提供商变量为空且脱敏 `hasApiKey=false`；只用临时随机本地 API、合成配置/文件，未启动浏览器、连接外部代理/S3/LLM、发送聊天或访问真实用户设置。未验证 DRM/CDM、Web App、扩展及字体在真实浏览器启动后的行为，也未验证其他平台/损坏磁盘/2 GiB 边界；原归档路径/ZIP 限制保留。根目录用户未跟踪两个 JS 的 SHA-256 与台账基线一致，`output/` 未触碰；不提交、推送或开始 F09。

## F09 — 回收站失败一致性

- 当前状态（2026-10-08）：**已验证（限定范围）**。单项详情、互斥/Undo、合法继承名 ID、正常/窄屏布局已补修，独立复核与主会话真实 Electron 验收通过，详见文末追加记录。F10–F18 仍待处理。
- 以下保留 2026-09-30 阶段的历史记录，不代表当前补修状态。
- 历史状态：**待验收（独立复核未通过；主验收未做）**。后端补修曾获一位复核者 `pass/issues=[]`，但当时批量/Undo 补修后两位独立只读复核均要求修复单项错误详情；F10 及后续项未启动。
- 红测：原代码 `f09-red-unit.log` **11 failed / 1 passed**；数字 `name`、部分删除标记、预删除索引提交及过期补偿冲突的 `f09-followup-red-unit.log` **4 failed / 18 passed**；部分扫描失败应答的隔离 Electron `f09-followup-red-e2e5.log` **1 failed / 4 skipped**；批量/Undo 隐藏详情的真实 Electron `f09-batch-real-red-e2e.log` **2 failed / 5 skipped**。前两轮独立反证还发现非法元数据污染索引、重启扫描删除补偿失败后的唯一回收站副本；对应补修已纳入回归。
- 回收/恢复故障矩阵：`browser-manager.ts` 仅将索引 ENOENT 视为空，拒绝损坏/重复/不安全条目，使用同目录独占临时文件写入再 rename；校验元数据及 live/trash 双重占用，拒绝覆盖同 ID 旧副本。目录移动→单 Profile 配置事务→索引提交的移动、配置、索引失败均报错并尽力补偿，只回滚该 Profile 键而保留并发无关配置；补偿失败明确返回原错误、剩余路径及磁盘配置状态，不伪报成功。
- 永久删除/过期故障矩阵：删除前先持久写 `deletionAttempted:true`，索引预提交失败不触碰目录；递归删除部分失败、删除后索引提交失败保留不完整条目，禁止当完整配置恢复，过期扫描不自动重试。live 配置/目录与回收站同 ID 冲突时手动/自动 purge 均拒绝，保护唯一副本；批量过期清理只计实际提交成功项，保留失败项并报告部分失败，人工核查后才可手动重试。
- 界面补修：`profiles.js` 对损坏索引及过期扫描部分失败显示错误与仍可列出的条目，对冲突/不完整副本限制操作；批量 trash 和 Undo 按 ID 将 IPC 错误/拒绝异常原文放入可滚动的 `toast.detail`（`textContent`），只取消成功移动项的选中。单项 trash/restore/purge **尚未**采用该详情路径，不能以批量绿测代替单项验收。
- 已有绿测（本次仅记录日志，未重跑；均在 `$EVIDENCE_ROOT/`）：`f09-batch-final-unit.log` **22/22**，`f09-batch-final-e2e3.log` 显式 `-c vitest.config.e2e.ts` 的隔离 Electron **7/7**，`f09-batch-final-unit-smoke.log` **125 files / 1468 passed**，`f09-batch-build.log` 构建 **exit 0**；`f09-batch-final-{project-types,scoped-types,i18n,marketing}.log` 对应型检/双语/营销 **exit 0**。当轮 `git diff --check`、已跟踪 i18n 镜像比对通过；这些通过数字不覆盖下述新发现。
- 存储/UI 证明：`tests/unit/f09-profile-trash.test.ts` 在独有临时磁盘做定向 fs 故障注入，逐次直读 live/trash 哨兵、`config.json`/`index.json`，经 reload、ID 元数据和列表检索；`tests/e2e/f09-profile-trash-consistency.test.ts` 的真实 Electron/IPC 核对往返、坏索引、过期冲突重启、部分删除警示、锁与 viewer、同 ID 旧副本碰撞加一条成功移动，直接读文件并按 ID 查询。批量错误及 Undo 详情截图 `f09-batch-error-detail.png`、`f09-undo-recovery-detail{,-bottom}.png` 已目视核验；Undo 的两种 `Recovery required` 错误**仅在渲染进程模拟 IPC 失败应答/异常**，随后撤销注入并真实恢复读回，非实际磁盘补偿失败。E2E 核查临时 HOME/Node homedir/userData/cache、随机本地端口、无继承提供商键且 `hasApiKey=false`。
- 最新两位独立复核均 `changes_required`：`f09-independent-readonly-toast-probe.log` 与 `f09-refute-single-error-toast.log` 的合成输入证明，单项回收/恢复/永久删除仅将原始错误传为 toast 摘要，`core.js`→`errors.js` 会把磁盘 `EACCES: permission denied` 误译为团队 viewer 限制，或将长错误截到 220 字，丢失 `Recovery required` 路径及磁盘配置状态；两人分别重跑 F09 单元 **22/22** 与隔离 Electron **7/7**，仍未覆盖单项 GUI。待单项三入口保留完整原文、补 GUI 回归并重新独立复核与主验收；无 REST 回收站改动，也未验证物理磁盘故障、断电跨资源原子性、其他平台或真实浏览器/代理/S3/LLM；未提交、推送或触碰用户根目录未跟踪文件。

## F10 — 构建许可披露

- 状态：待处理。
- 验收：无公钥、可激活、已激活模式状态与 UI 准确；安装前中英文说明充分；不取消或绕过许可策略。

## F11 — 可执行的推荐任务

- 状态：待处理。
- 验收：未选环境、停止环境、运行环境的建议与当前工具能力一致；保持后端白名单，提供正确的准备入口。

## F12 — 草稿与失败输入

- 状态：待处理。
- 验收：配置往返、换会话不丢草稿；预检失败恢复输入，已提交消息不自动重放，成功发送不重复。

## F13 — 运行状态新鲜度

- 状态：待处理。
- 验收：乱序列表和详情请求不倒写；已打开详情在终态和验收变化时更新，关闭/换项后的旧应答不影响新项。

## F14 — 批量重试语义

- 状态：待处理。
- 验收：全成功不显示失败重试；混合批次只针对失败；筛选子集不冒充全批次计数，单条再次运行不受损。

## F15 — 引导续接

- 状态：待处理。
- 验收：首个配置创建后重启回到后续步骤；配置被删除可恢复引导；明确跳过/完成/不再显示仍有效。

## F16 — 备份教育

- 状态：待处理。
- 验收：中英文指南与界面明确区分同盘回收站和跨介质备份，不再暗示回收站能保护磁盘损坏。

## F17 — 应用版本

- 状态：待处理。
- 验收：侧栏版本与运行时应用版本一致，失败回退诚实；不将 API 协议版本替换成应用版本。

## F18 — 动态国际化

- 状态：待处理。
- 验收：无引擎与系统生成会话标题双向切换正确；不翻译用户自定义标题；维护已跟踪的 i18n 镜像一致。

## F01–F18 全范围最终综合验证（仍未完成）

以下为全部 F01–F18 完成后的总验收计划；不与文末 2026-10-08 已执行的限定修复/安装包验收混淆。

- 构建：待执行。
- 单元/冒烟：待执行。
- 针对性隔离 E2E 与真实 GUI：待执行。
- i18n / marketing / 视觉：待执行。
- 数据文件/数据库/归档读回：逐项记录，待汇总。
- 用户原文件与数据保护检查：待执行。
- 未覆盖、失败或阻塞：尚在实施，不能报告总体通过。

## 2026-10-08 — 当前回归补修与 macOS arm64 本地验证包

### 范围与实现

用户批准先处理当前确认的回归、F09 单项错误界面和相关测试，再非破坏性生成 arm64 DMG/ZIP；没有提交、推送、合并、清理旧文件或覆盖 `/Applications`。本轮构建/测试都在 `$EVIDENCE_ROOT_03/` 的独立快照内执行，未在原目录运行会删除 `dist`/`release` 的构建链。

- **CI fixture**：runner 的四个 Chromium binary/cache 键仅参与二进制发现；显式调用方浏览器选择整组优先，保留逐 profile 版本选择；不把 runner 缓存/提供商凭据传入 child。红测 13 failed；55 项聚焦绿测及独立复核通过，J1 默认调用真实启动通过。
- **归档 note**：新增专用多行 sanitizer，允许 TAB/LF/CR，拒绝其他 C0/DEL；先检查控制字符，再保持 2000 字符截断/trim/空值 null 语义，不放宽单行字段。51 项归档单测及真实 ZIP → metadata → import → config 磁盘 → reload → ID/列表/REST 查询通过。控制字符即使在截断范围之外也明确拒绝。
- **排队重试终态**：`runRule()` 两处未启动早退路径对原重试行调用既有 `markRetryAbandoned()`；初次 queued 仍走 `markCancelled()`。原行进入 failed、清除 retryAt、记录 finishedAt，保留实际 attempt/首次 startedAt。真实 scheduler + SQLite 的 12 项回归、原始 SQL/getJob/listJobs/无幽灵执行验证通过，未扩大取消 SQL 的状态范围。
- **F09 单项/Undo**：短摘要与完整原始错误分离；modal 内前景详情用 textContent，保留长恢复路径、可滚动末尾与键盘访问；确认/pending/modal restore/单条与批量 Undo 共用 per-ID 互斥；failed purge 不假称回滚、不恢复完整性未确认的数据，重试仍需新确认；失败不自动刷新触发过期清理。guard 使用无原型字典，支持合法 `toString` 等 ID。
- **F09 布局**：截图实证原失败状态的名称列宽为 0px、555px 内容挤入 512px 行并覆盖 Restore。改为局部 grid 分隔名称/按钮/整行警告；独立 RED 为 9 passed/2 failed，GREEN 完整 F09 为 11/11，26 项 renderer guard 单测不变。800px 实际窗口、150% 缩放下警告完整，名称/按钮不重叠；使用 native `capturePage` 避免缩放截图裁切失真。
- **测试稳定性**：F06 停止同时等待 CDP 关闭、PID ESRCH、running=false；M3 同时等待 SQLite skipped 与磁盘 missedAt；F09 截图写本轮 evidence。HiDPI 滚动差允许不超过 1 CSS px，仍验证最后字符真正位于前景。许可配额不变，仅在成功验收后通过真实 trash/purge 清理用例自建数据。
- **安装包资源发现**：发现无覆盖变量时 `effectiveResourcesPath()` 把 undefined 变成 null，屏蔽了 Electron 默认资源目录。仅为参数补默认 `process.resourcesPath`；显式 null/空值禁用及 env 优先级保留。新增 41 例，聚焦 46/46；独立文件系统反证 pre-fix 44 failed/112 passed，修复后 156/156，无宿主目录逃逸或子进程调用。

### 主会话最终验证（不是仅引用代理结果）

源码快照 `release-final` 与当前 src/tests/scripts/resources 等输入逐文件核对；清单为 `evidence/release-input-source-sha256.json`。打包使用内容相同的 `release-physical`，仅依赖改为完整实体副本。

| 验证 | 实际结果 | 日志（本轮根目录下 `logs/`） |
|---|---|---|
| `npm run build`（隔离快照） | exit 0，trial-only，TS/renderer/resources/Go native 实际构建 | `build-release-final.log` |
| 安全范围 unit + smoke，串行 | 124 files / **1614 passed，0 failed，0 skipped** | `unit-smoke-package-final-v1.log/.json` |
| F01/F02/F05/F06/F07/F08/F09/J1/J62/M3，显式 E2E 配置 | 10 files / **75 passed，0 failed，0 skipped** | `e2e-package-final-v1.log/.json` |
| F06/F09/M3 时序重复 | 3 files / **40 passed，0 failed，0 skipped** | `e2e-package-timing-repeat-v1.log/.json` |
| i18n / marketing / renderer syntax | exit 0，两个 i18n 镜像一致 | `static-package-final-v1.log` |
| 安装包完整性/架构/签名一致性 | exit 0（Gatekeeper 信任拒绝单独记录，不能算信任通过） | `package-integrity-final-v1.log` |
| 从 ZIP 解压后的 app 实际运行 | 全部 8 个检查点通过，app exit 0 | `packaged-runtime-final-v2.log` |

单元命令为 `node node_modules/vitest/vitest.mjs run tests/unit tests/smoke --exclude tests/unit/mcp-rbac.test.ts --exclude tests/unit/local-agent-approval.test.ts --exclude tests/unit/firefox-agent-tools.test.ts --no-file-parallelism --maxWorkers=1 --reporter=default --reporter=json --outputFile=…`。上述三个旧固定外部临时路径文件明确未执行，不计入通过。Electron 使用 `node node_modules/vitest/vitest.mjs run -c vitest.config.e2e.ts`，完整参数、cwd、退出码和耗时保存在同名 `.result.json`。

数据证据包括真实 SQLite 原始 SQL/服务查询、config/index/sentinel 直接读回、ZIP 元数据、reload/按 ID/列表检索；不是只看 IPC 返回 success。包级 smoke 从 ZIP 解压目录运行，避免仓库祖先 `node_modules` 掩盖漏依赖；实际 HOME/userData/cache 隔离，无提供商变量、无强制 Chromium 路径、无内置资源覆盖变量。真实接受条款、创建配置、多行 note 导出/导入/读回、回收与 UI 恢复通过；REST `/health` 无 auth=200、`/api/profiles` 无 auth=401、有 auth=200。启动的是本包解压到测试缓存的 Chromium，通过 CDP 渲染本地页面，停止后等待 PID 消失和 running=false；最终 app exit 0。截图已实际打开检查。

### 安装包交付与限制

交付目录：`$REPO_ROOT/release-preview-fixes-20261008-arm64-02/`。

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `Agent-Browser-Studio-1.0.1-fixed-20261008-mac-arm64.dmg` | 477,037,200 bytes | `ee24219773d511a7a733714cf8db0309d71b9ed2238f672ed1183d45d10107a8` |
| `Agent-Browser-Studio-1.0.1-fixed-20261008-mac-arm64.zip` | 485,074,841 bytes | `014de3dfd2450422ae5b12a427a805002335ed4747d22936a039f7564d531e11` |

- 内部版本 **1.0.1**、主程序及 MASQUE **arm64**；Chromium **152.0.7977.72 arm64**，Firefox **154.0 universal x86_64/arm64**。两浏览器 ZIP CRC/解包后严格签名通过，Firefox 未执行启动流程。
- ASAR 的 **290** 个编译/renderer/resource/corpus 文件与打包输入哈希相同；完整必需依赖闭包 **39 个 package 节点（含应用）**在仓库外解析通过，五个直接生产依赖在实际 Electron ASAR 内加载通过。
- ZIP CRC、DMG verify、只读挂载通过；ZIP/DMG/构建 app 的 **287** 个文件/链接内容一致，严格签名一致性通过。仅项目原有 **ad-hoc** 签名，没有 Developer ID、公证或发布。`spctl --assess --type execute` 实际返回 **exit 3 / rejected**，不能把签名一致性写成 Apple 信任通过，没有关闭 Gatekeeper。
- 没有可沿用的发布许可公钥；这是 **trial-only 本地验证包，不是支持正式激活的发行包**。不生成测试公钥、不取消许可限制。运行时版本 1.0.1；侧栏旧版本文案仍属待处理的 F17。
- 新包目录附 `README.zh-CN.md`、`SHA256SUMS.txt` 与 `verification/`（命令/结果/哈希/截图），不只依赖易清理的临时日志。
- 原 `dist` **319**、`release` **579**、`native-browsers` **3** 项的字节哈希及 symlink 目标完全未变；两个根目录 JS 与 `output/pelican-ride.*` 也与原基线一致。分支/HEAD 未变，未提交/推送/合并/安装/清理旧产物。

### 失败记录与未覆盖项

- 首轮 F09 两个 HiDPI 断言失败：`220.5` 对整数 `221`，补合理像素误差但保留末字符前景验证。后续 F09 新增成功夹具累积触及 10/10 配额，补仅针对已验证自建数据的真实清理，不提高额度。
- F09 初次独立复核实证 Undo 绕过互斥/failed-purge 保护及继承名 ID 误判；补修后独立复核无确认问题。布局初次功能测试虽绿，真实截图仍暴露重叠，另补几何 RED/GREEN，而非忽略截图。
- 一次广单测快照缺生成的 tray/native 文件，构建后重跑；一次运行名与已有目录冲突，runner 拒绝覆盖，改用新记录名。保留旧失败记录，不冒充测试通过。
- 第一份候选 `release-preview-fixes-20261008-arm64-01` 虽然 builder exit 0，仓库外 ASAR 加载实际缺少 `dijkstrajs`/`smart-buffer`/`debug` 等传递依赖。已标记 `NOT-FOR-USE.txt`，不交付；换完整实体依赖副本重新打包到 `02`，再验证依赖闭包和真实运行。未覆盖任何旧目录。
- 包级 `v1` 业务流程通过，但测试脚本在 Playwright close 后再调用 `app.process()` 导致句柄失效；close 前保存原 process 句柄后，以全新隔离 userData 完整重跑 `v2`，exit 0。没有改生产代码来掩盖该探针问题。
- **新增待办 P01：冷启动列表超时提示。** `packaged-runtime-final-v2` 的 `electron.stderr.log` 捕获一条 `browser.list timed out after 5s`；后续数据加载和全部包级流程通过。这条非致命首启提示尚未修复，不能宣称启动日志无错误，后续需单独分析冷缓存启动时序。
- **F10–F18 仍待处理**。没有运行全部历史 journey、真实外部 S3/LLM/代理、Windows/Linux CI、Docker 重建/容器、正式许可激活/公证、物理磁盘故障或断电验证。本轮未修改 `.env`/Docker 配置；实际 `.env` 不存在，现有 loopback 引用扫描已保存。本记录是限定修复与本地安装包验证，不是全产品/全平台验收完成。

### 后续用户授权 — GitHub 公开预发布上传

- 用户明确要求上传，同时包含两种 macOS 浏览器内核。上传前重新核对实际 DMG/ZIP SHA256、ZIP/manifest/Info.plist：两种格式均内置 Chromium 152.0.7977.72 与 Firefox 154.0；Chromium 不是 Google Chrome 品牌版。
- 已发布：[GitHub 预发布页面](https://github.com/edgora-ai/agent-browser-studio/releases/tag/preview-macos-arm64-1.0.1-fixed-20261008)。`gh release create` exit 0，draft=false/prerelease=true，上传 DMG、ZIP、SHA256SUMS.txt、README.preview.md 四个附件；正式 Latest 仍为 v0.1.0，未覆盖旧 Release。
- 公开说明披露 trial-only/ad-hoc/未公证、Gatekeeper rejected、仅 Apple Silicon、Firefox 启动未测、冷启动超时及 F10–F18 待办。标签指向基线 8f6b6d4，二进制包含尚未提交的本地修复，GitHub 自动 Source code ZIP/TAR 不包含这些修复；此次未提交/推送工作树源码或合并 main。
- GitHub 返回的四个附件 `digest` 均与本地 SHA256 匹配。ZIP、README、校验文件已从 GitHub 完整下载，实际 SHA256 通过；**DMG 的完整下载回验未完成**：首次回下载进程被停止，保留 272,727,327 / 477,037,200 字节；续传遇到 curl 16（HTTP/2 framing）及 curl 28（无法连接 github.com:443）。没有把元数据匹配宣称为完整 DMG 下载通过，停止自动重试；这不改变上传已完成的结果。
- 证据保存到 `release-preview-fixes-20261008-arm64-02/verification/github-upload/`，链接保存到同目录 `GITHUB-DOWNLOADS.md`。
