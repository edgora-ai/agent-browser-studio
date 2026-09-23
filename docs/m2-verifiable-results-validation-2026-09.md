# M2：可验收结果与导出 — 实现与验证记录

- 日期：2026-09-19 / 2026-09-20。
- 范围：[产品优化方案 M2](product-optimization-plan-2026-09.md#5-m2可验收结果与导出)；不包含 M3 调度通知与 M4 首跑引导。
- 环境：macOS Apple Silicon，Node 26.8.2，Electron 42.4.0，Vitest 4.1.8。
- 状态：M2 已实现，并通过本报告限定的 macOS 主路径验收。
- 工作区：基于含 M1 未提交变更的当前源码；未提交或推送，未修改个人 userData、仓库原 `dist/` 或 `output/`，未安装或升级依赖。
- 构建与 Electron E2E 均在隔离源码副本 `/private/tmp/m2-e2e-build`（`node_modules` 为绝对符号链接）与隔离 userData 中运行；LLM 一律为本地 mock。

## 1. 交付行为

### 验收只信实际产物

- 仅 `news-collect` 模板注册机器验收器（`news-collect.dataset` v1，物理表 `news_run_results_v1`）。其余 21 个模板与自由聊天保持 `unverified`——没有验收器就不编造结论。
- 验收器只读自己预编译的 `WHERE run_id=?` 查询，不读模型的完成叙述。E2E 实测：模型回复“All done — collected everything successfully.”而一行未写时，结论为 `failed`（`accepted:0 / missing:20`），任务执行层仍是 `done`。
- 提示词中的执行合同是引导，不是边界；边界是验收器的参数化查询。合同里的 run_id 是主进程在 `startRun()` 之后注入的真实 id。

### 五态结论与计数不变量

- `unverified / passed / partial / failed / manual_review` 判别联合；无法完整读取、检查或持久化的情形一律 `manual_review`，绝不猜。
- 计数字段 `expected/observed/inspected/accepted/rejected/missing/extra` 满足 `inspected===observed`、`accepted+rejected===inspected`、`missing=max(expected-observed,0)`、`extra=max(observed-expected,0)`。
- 执行状态与业务验收两层并列，互不冒充。E2E 实测：18/20 有效行时，`run.status==="done"` 且 `endReason==="completed"`，同时 `verification.status==="partial"`——**业务判定不触发任务重试**。
- 表结构不兼容（`schema_incompatible`）时执行层如实报错（`status=error`、`endReason=execution_error`），验收层独立记 `manual_review`；两种口径都不隐瞒。

### 成果存储

- 布局 `<userData>/agent-results/<runId>/{artifacts/dataset.json, manifest.json}`。manifest 最后原子提交（O_EXCL/0600/fsync/rename/目录 fsync），提交后复读校验字节与 SHA-256。
- config.json 只存有界引用：E2E 逐字段确认产物引用带 basename（固定常量）但**不含绝对路径、目录、`path`/`payload`/`rows`/`body` 字段**。
- 幂等提交、单 run 8 MiB / 全局 512 MiB 配额、单 run 16 artifacts、1000 行 / 64 列 / 单元格 64 KiB 上限；截断只发生在完整行边界，截断后结论降级为 `manual_review/artifact_limit`，绝不拿残缺证据当通过。
- 启动对账：manifest 在而 config 引用丢失时回补引用并恢复终态。E2E 人为删除引用、把 run 改回 `running`、删掉 `finishedAt`，重启后自动恢复原 `verification`、终态与产物引用，且表内行数不变。
- 篡改 dataset.json 后，preview 与 export 均拒绝且不返回任何内容；还原字节后立即恢复可读。

### 运行隔离与再次运行

- 两次运行写完全相同的 URL，各自 preview/CSV 只含自己的行（`UNIQUE(run_id,url)` + run 级查询）。E2E 直接查表核对每个 run_id 的行数。
- 终态运行可再次运行：新 ID + `source.retryOf`，原 run/manifest/artifacts 字节级不变，名称不再硬编码中文“（重试）”（改为渲染端按 `retryOf` 显本地化徽标）。

### 导出

- 两阶段：`export-plan` 先返回格式/列/行数/大小/警告/建议文件名/当前 hash，确认后才 `export-write`（主进程原生保存对话框 + 路径守卫 + 同目录唯一 tmp + 0600 + fsync + rename + 目录 fsync）。E2E 实测确认框未决期间写入次数为 0。
- CSV：RFC 4180 + CRLF，固定列序，不含 id/run_id；首有效字符为 `= + - @` 或前导 TAB/CR（含前导空白后）的单元格先加 `'` 再 quoting。
- 摘要 JSON：仅元数据，不含变量值、step args/results、prompt、正文与绝对路径。E2E 实测导出文件不含任何抓取正文与结果目录路径。
- 扩展名白名单生效：显式指定 `.zip` 目的路径被拒绝且不落盘。
- 用户取消原生对话框返回 `reasonCode:"cancelled"`，按无操作处理，不报成功。

### 界面

- `dlg-agent-run` 三层：结论（执行状态 / 业务验收 / 验收器 / 验收时间 / 待人工原因 / counts / issues）、成果（产物元数据、分页预览、导出）、诊断（默认折叠的变量与步骤时间线）。
- 六类客户端筛选（任务名 / 时间范围 / 来源 / 环境 / endReason / verification），live 刷新后保留筛选条件；筛选无结果时明确说明是筛选为空而非历史为空。
- 渲染只用 `textContent`/`esc()`：恶意标题 `<img onerror>`、`<script>`、公式前缀单元格均只作为文本出现。E2E 实测运行详情弹窗内 `script`/`img` 节点数为 0。
- 分页有独立 sequence guard：旧请求的响应在新运行/新页之后返回时被丢弃，不会覆盖当前内容。

## 2. 验证结果

| 验证 | 实际结果 |
|---|---|
| 主项目 TypeScript `--noEmit` | 通过 |
| 完整 unit + smoke | 108 个文件，1176 项通过 |
| 语句 / 分支 / 函数 / 行覆盖率 | 53.37% / 46.82% / 59.46% / 56.38%，现有门槛通过 |
| M2 定向单测 | 9 个文件，140 项通过 |
| M2 Electron E2E | 1 个文件，15 项通过（隔离副本 + 隔离 userData） |
| M1 十四个目标文件回归 | 14 个文件，81 项通过，0 失败 |
| 隔离源码构建 | 通过（`tsc` + 资源 staging，未覆盖仓库原 `dist/`） |
| i18n / 文件大小 / 弹窗扫检 | 通过；未增加大小基线豁免；28 个弹窗打开无发现 |
| 根 `i18n.js` 与 renderer 副本 | 字节一致 |
| `git diff --check` | 通过 |

M2 相关模块行覆盖率（lcov，来自完整 unit+smoke 跑批）：`agent-db.ts` 97.3%、`run-verifiers.ts` 95.4%、`agent-run-trace.ts` 95.0%、`run-result-store.ts` 84.3%、`agent-run-export.ts` 83.3%、`automation.ts` 72.6%、`data-export.ts` 56.4%。

### M2 E2E 覆盖的场景

| # | 场景 | 断言要点 |
|---|---|---|
| 1 | 全成功 20/20 | `passed`；表内 20 行且全部属于本 run；dataset 哈希/字节与 manifest 一致；服务读回 20 行；按 runId 可检索 |
| 2 | 部分成功 18 有效 + 2 无效 | `partial` 且执行仍 `done`；表内保留 20 行；dataset 恰 18 行；issues 为 `invalid_url` + `invalid_timestamp` |
| 3 | 模型自称完成但不写行 | `failed`、`accepted:0`、`missing:20`；表内 0 行；仍记录空快照（`rowCount:0`） |
| 4 | 双 run 同 URL 隔离 | 两 run 各行 5 行、互不混入；dataset 文件物理独立 |
| 5 | 非模板 automation / desktop chat | 均恒为 `unverified`，无产物 |
| 6 | legacy 规则缺结构化输入 | `manual_review/input_unavailable`，不解析自然语言猜值 |
| 7 | 非法结构化输入 | 写入路径直接拒绝；规则未持久化；**模型一次都未被调用** |
| 8 | 再次运行 | 新 ID + `retryOf`；原行/dataset/manifest 字节级不变；名称无中文后缀 |
| 9 | 重启对账 | 人为删除引用后重启，verification/终态/产物引用全部恢复 |
| 10 | 完整性 | 篡改 payload 后 preview 与 export 均拒绝且无内容泄漏；还原后恢复 |
| 11 | 导出 CSV | 计划如实；公式前缀已加 `'`；含逗号值被引号包裹；CRLF；`.zip` 被拒 |
| 12 | 导出摘要 | 仅元数据，不含抓取正文与结果目录路径 |
| 13 | 表结构不兼容 | 执行层 `error/execution_error`，验收层 `manual_review/schema_incompatible`；原表未被 DROP/迁移/写入 |
| 14 | 恶意内容渲染 | 弹窗内 `script`/`img` 节点数为 0；恶意标题以文本出现 |
| 15 | 遗留 `news` 表 | 未被创建、未被迁移 |

### 写盘验证链（场景 1 的完整链路）

写入 → 直接以只读句柄查 `news_run_results_v1`（20 行，`run_id` 全匹配）→ 读 `agent-results/<runId>/artifacts/dataset.json`（20 行，`runId` 匹配）→ 校验 SHA-256 与字节数等于 manifest 引用 → 经 `agent-run:results-preview` 读回 → 关闭重开（场景 9）后仍可读回。每一步都比对物理内容，不依赖 API 返回值自证。

## 3. 复验命令

```sh
# 类型与单测
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run tests/unit tests/smoke

# 覆盖率（写入临时目录，不污染工作区）
TEMP_ROOT=$(mktemp -d -t studio-m2-coverage)
TMPDIR="$TEMP_ROOT/" ./node_modules/.bin/vitest run tests/unit tests/smoke \
  --coverage --coverage.reportsDirectory="$TEMP_ROOT/coverage"

# 隔离副本构建 + Electron E2E
/tmp/m2sync.sh /tmp/m2-e2e-build
cd /tmp/m2-e2e-build && rm -rf dist && ./node_modules/.bin/tsc && \
  mkdir -p dist/renderer dist/resources && \
  cp -r src/renderer/index.html src/renderer/storage-migrate.html src/renderer/css src/renderer/js dist/renderer/ && \
  cp src/main/preload.cjs dist/main/ && node scripts/license-inject.mjs

./node_modules/.bin/vitest run -c vitest.config.e2e.ts tests/e2e/m2-verifiable-results.test.ts

# M1 十四个文件回归
./node_modules/.bin/vitest run -c vitest.config.e2e.ts \
  tests/e2e/m1-agent-control.test.ts tests/e2e/m1-agent-ui.test.ts \
  tests/e2e/m1-cancel-latency.test.ts tests/e2e/j4-agent-stream.test.ts \
  tests/e2e/j17-agent-runs.test.ts tests/e2e/j18-agent-db.test.ts \
  tests/e2e/j21-parallel-tool-calls.test.ts tests/e2e/j22-history-repair.test.ts \
  tests/e2e/j23-error-display.test.ts tests/e2e/j24-approval-semantics.test.ts \
  tests/e2e/j25-full-conclusion.test.ts tests/e2e/j31-approval-buttons.test.ts \
  tests/e2e/j83-agent-rest.test.ts tests/e2e/reliability-regressions.test.ts

npm run check && cmp i18n.js src/renderer/js/i18n.js && git diff --check
```

M1 十四个目标文件的逐文件结果（`Test Files 14 passed (14) / Tests 81 passed (81)`，Duration 314.44s）：

| 文件 | 通过 |
|---|---|
| `m1-agent-control.test.ts` | 13 |
| `m1-agent-ui.test.ts` | 7 |
| `m1-cancel-latency.test.ts` | 2 |
| `j4-agent-stream.test.ts` | 8 |
| `j17-agent-runs.test.ts` | 6 |
| `j18-agent-db.test.ts` | 6 |
| `j21-parallel-tool-calls.test.ts` | 5 |
| `j22-history-repair.test.ts` | 5 |
| `j23-error-display.test.ts` | 4 |
| `j24-approval-semantics.test.ts` | 3 |
| `j25-full-conclusion.test.ts` | 4 |
| `j31-approval-buttons.test.ts` | 3 |
| `j83-agent-rest.test.ts` | 10 |
| `reliability-regressions.test.ts` | 5 |

本地日志（临时产物，清理后不可依赖）：`/private/tmp/m2-e2e-run{1..4}.log`、`/private/tmp/m2-m1-regression.log`。

## 4. 本轮发现并修复的问题

- **导出路径在 ESM 下用 `require()`**：`agent-run-export.ts` 的 `sha256Of()` 写成了 `require("node:crypto")`，而主进程编译产物是 ESM（`"type": "module"`）。单元测试用 vitest 的 CJS 互操作掩盖了它，只有真实 Electron E2E 才暴露 `ReferenceError: require is not defined`。已改为顶部 `import { createHash }`。
- **`dlg-agent-run` 与 agent 运行条 id 冲突**：M2 详情块的 `agent-run-verification` 与 M1 实时运行条的 `<span>` 同名。`getElementById` 返回树序第一个，导致 `runs.js` 把结论行写进实时运行条，`agent-chat.js` 又把运行条文本写回结论块。已把详情块改为 `agent-run-verification-block`，并新增 id 唯一性回归测试。
- **renderer 测试缺位**：M2-8 的界面代码此前只有门禁通过、没有测试。新增 `tests/unit/renderer-runs-m2.test.ts`（34 项）。
- **M2 单测共用固定临时目录，并发时互相污染**：`run-verifiers.test.ts` 会在 db 路径上**故意**种一张错列表来验证 `schema_incompatible`，而它用的 `os.tmpdir()/agent-browser-m2-verifier-test` 是固定路径。两个 vitest 进程同时跑时共享该目录，一个进程种下的 `wrong_column` 表被另一个进程的 `ensureNewsRunResultSchema()` 读到，于是无关用例整片转红（实测：并发下同一文件 14/20 与 12/20 失败，且失败点指向 `agent-db.ts` 的 schema 校验，极易被误读为产品缺陷）。已把 M2 的六个临时目录改为带 `process.pid` 后缀；改后同样并发跑，两个进程各 58/58 全绿。这是测试卫生问题，不是产品行为变化——产品在遇到同名不兼容表时**本就**应报 `schema_incompatible`，那正是用例要断言的。

### 用反向验证确认测试真的会失败

对新增的 renderer 测试逐个注入缺陷后确认对应用例转红，而非恒绿：

| 注入的缺陷 | 转红的用例 |
|---|---|
| 恢复 id 冲突 | `keeps every element id unique`、`does not read the live agent strip's element` |
| 移除 preview 的 `previewSeq` 守卫 | `drops a preview that resolves after the user moved to another run` |
| 预览单元格改为原样插值 | `keeps hostile artifact names, columns and cells out of the DOM tree` |
| 完整性失败时继续渲染表格 | `shows an integrity failure as an error and renders no rows at all` |
| `verificationStatus()` 原样返回状态 | 三个五态用例 |
| 去掉 `canRetryRun` 的终态检查 | `offers re-run for a terminal automation run and withholds it otherwise` |
| 名称筛选忽略关键词 | 三个筛选用例 |
| 把临时目录改回固定路径后并发跑同一文件 | 两个进程分别 14/20、12/20 失败（见 §4） |

### 测试口径修正（测试写错而非产品错）

E2E 首轮 7 项失败中，只有 1 项是产品缺陷，其余是断言写错，均已按物理事实改正，**未放宽任何产品行为**：

- `page.evaluate` 在渲染进程执行，Node 侧常量 `DATASET_ID` 不可见 → 内联字面量。
- 每轮只发一条 INSERT，撞上 25 轮工具调用上限 → 改为每轮批量 10 条（100 行场景此前误报 `round_limit`）。
- 断言 config 不含 `dataset.json` → 该字符串是产物 basename（固定常量），规则是不含**路径**；改为断言无绝对路径且无 `path`/`payload`/`rows` 字段。
- 断言失败 run 无产物 → 空快照是刻意保留的证据（“模型什么都没写”本身可导出）；改为断言 1 个 `rowCount:0` 的产物。
- 断言非法输入产生 `manual_review` run → 写入路径已直接拒绝，规则根本未创建；改为断言拒绝 + 规则未持久化 + 模型未被调用（运行时的前置失败路径由单测覆盖）。
- 断言前导空白的公式单元格 → 验收器在入库前会 `trim()` title/source，前导空白变体由单测覆盖；E2E 改用 `+1+1…` 这一真实可达形式。
- **超预算 `artifact_limit` 分支在 E2E 层面不可达**：单条可接受行最大约 2.8 KiB（title 500 + url 2048 + source 200 + published_at 64），行上限 1000，故 news 快照上限约 2.8 MiB，低于 8 MiB 单 run 预算。该分支由调低预算的单测覆盖（`tests/unit/automation-verification.test.ts`）；E2E 改用同属 `manual_review` 且真实可达的 `schema_incompatible` 路径。这是口径说明，不是放行。

## 5. 明确未验证与非目标

- **本报告的所有数字都来自互不并发的单次跑批。** 若同时开两个 vitest 进程（例如边跑覆盖率边跑 E2E 回归），仍可能出现假红：仓库里大量单测用固定名 `os.tmpdir()` 目录（本报告只给 M2 的六个加了 `process.pid`，其余按最小改动原则未动），并发时彼此共享同一 config/db 路径，会报出 `file is not a database` 或超时这类与产品无关的失败。实测过一次：并发下 `config-store.test.ts` 1 项失败，单独跑 7/7 通过，随后无并发重跑覆盖率 108 文件 1176 项全绿。
- 未运行完整历史 Electron journeys；本报告只覆盖 M2 新文件与 §3 列出的 M1 十四个目标文件。
- 未验证 Windows/Linux 安装包、签名发布包或真实 Firefox 桌面 E2E。
- 未运行 Docker；本轮未修改 `.env.example`、`docker-compose.yml` 或 `.dockerignore`，桌面验证不代表容器验证。
- LLM 为本地可控 mock，未测真实云模型的采集成功率或验收准确率；本报告证明的是“验收只依据实际落库行”，不是“真实站点能被正确采集”。
- 未实现 M3 调度通知（partial/failed 的通知与人工介入入口）、M4 首跑引导；未扩展 chat 模板选择器、单条目重试、chat 断点续跑、PDF、全文搜索、REST/MCP RBAC 改造；未迁移旧 `news` 表。
