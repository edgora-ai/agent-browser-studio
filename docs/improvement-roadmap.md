# CloakLite 改进路线图（场景化评测 → 开发推进）

> 来源：8-agent 场景化评测（跨境电商 / 社媒矩阵 / AI自动化 / 广告养号 / 团队协作 / 开发者 / 竞品对标 + 综合）。
> 本文档既是评测结论，也是开发推进的活文档——每个落地切片都会在文末「开发日志」记录。

## 1. 一句话结论

不是功能空壳，但还不是生产系统。Profile 隔离 / 指纹 / 代理 / Agent / Run Trace / SQLite / S3 sync / MCP 都是真实现，但停在「个人/互信小团队可试用的本地工具箱」。**最短板 = 最大卖点 AI Agent 的生产化执行**（无队列/重试/超时/状态/权限/审计）。

## 2. 场景记分卡

| 场景 | 相关 | 就绪 | 判断 |
|------|:---:|:---:|------|
| 跨境电商多账号 | 10 | 5 | 凭据/团队/代理质量/指纹验证/批量引擎缺一不可 |
| 社媒矩阵 | 9 | 4 | 半自动可行；缺批次调度、代理轮换、平台适配器 |
| AI 自动化采集 | 9 | 5 | **最易打样**，单次闭环已通；生产化缺 durable queue |
| 广告养号 | 9 | 5 | 骨架在；缺指纹漂移阻断、代理纯净度生命周期 |
| 团队协作同步 | 9 | 3 | **最大短板**——只是 S3 备份，不是团队系统 |
| 开发者集成 | 8 | 5 | API 暴露浅、browser_* 未开放、custom-js 不安全 |
| 竞品对标 | 10 | 4 | 差异化押注「自托管 + AI 多账号 Copilot」 |

## 3. 推荐定位

**自托管反检测浏览器 + AI 多账号运营 Copilot**。先吃技术型个人 + 愿自托管的小团队（跨境/广告/社媒），再补团队版与商业替代。不做「更便宜的 AdsPower」。

## 4. 五大跨场景共性（最高杠杆）

1. **可信反检测 = 可证明稳定**，不是字段多：缺 per-profile 指纹基线、跨启动漂移检测、自洽校验、patch 回归测试。
2. **批量运营核心是可靠执行系统**：`automation.ts` 是内存 timer，缺 durable queue / 并发锁 / 重试 / 幂等 / 失败分类。
3. **账号与团队治理是商业化门槛**：密码明文、sync 是共享对象存储，无凭据保险库 / RBAC / 锁 / 审计。
4. **代理要从配置项升级为风险资产**：缺住宅/机房分类、IP 漂移历史、绑定数、冷却、健康分（封号头号来源）。
5. **AI Agent 必须产品化为可复用工作流**：通用工具 + 25 轮适合演示，真实用户要模板/结构化输出/队列/断点恢复/审批。

## 5. 优先级路线图

### 🔴 P0（信任地基）
- 指纹可信闭环：基线采集、跨启动 diff、漂移阻断、patch 回归（5/4）
- **automation → durable job queue + supervisor**（5/4）← 本次推进
- 凭据保险库 + 统一审计（5/4）← 下一切片
- 代理资产 + 一致性阻断（5/3）
- Windows x64 商业基线（5/5）

### 🟡 P1（护城河 + 商业化）
- AI Agent → 多账号运营 Copilot 模板库（5/3）
- MCP/Local API/SDK 暴露 browser_* + REST + OpenAPI（5/4）
- 批量运营台：CSV 一体导入、标签/筛选、批量动作（4/3）
- sync → 轻量团队工作区（5/5）

### 🟢 P2（生态与稳健性）
- 平台适配器/技能包（selector 版本化）（4/5）
- 企业连接器 + 标准导出 schema（4/4）
- 受限脚本运行时替代 main 进程 custom-js eval（4/4）

## 6. 速赢清单（1-3 天）

1. **AutomationRule 加 runTimeoutMs / maxConcurrency=1 / 防重入锁 / 失败重试** ← 本次推进
2. 账号密码立即上 safeStorage 加密 + UI 补 profileIds/TOTP 占位
3. profile 卡片「启动前一致性检查」（代理国家↔tz↔locale↔WebRTC 冲突告警/阻断）
4. Check Risk 保存最近检测截图+时间戳
5. sync push/pull 前 diff 预览
6. bulk import 支持 CSV
7. Agent 内置 5 个任务模板
8. proxy-detector 结果持久化为历史
9. custom-js 默认高危 + 确认 + 超时 + 审计
10. MCP tools/list 文档 + README 连接示例

## 7. AI 护城河维持风险

Agent 停在聊天框 + 通用工具，竞品接个 LLM 就能复制表层。真护城河必须是 **profile-aware + proxy-aware + credential-aware + risk-aware 的多账号执行系统**——不是更会聊天，而是更敢自动、更敢无人值守、更敢给团队用。

---

## 8. 开发日志

每个落地切片在此记录：范围、文件、验证、状态。

### Slice 1 — Automation 执行硬化（速赢 #1）— ✅ 完成

**范围**：把 `automation.ts` 从「内存 timer + 单规则动作」升级为带超时/防重入/失败计数/冷却/重试退避的可靠执行器。所有规则默认获得硬化，无需 UI 改动；高级用户可按规则覆盖（`runTimeoutMs` / `maxRetries`）。

**默认值**（`DEFAULT_JOB_GUARD_CONFIG`）：单次运行超时 5 分钟；失败不自动重试（副作用动作安全默认）；连续 3 次失败 → 冷却 10 分钟；重试指数退避 30s 起封顶 10 分钟。

**文件**：
- 新增 `src/main/services/job-guard.ts` — 纯状态机（无 Electron 依赖，可单测）：`shouldRun` / `begin` / `end` / `hydrate` / `configFor` + `withTimeout`
- 改 `src/main/services/automation.ts` — `runRule` 接入 JobGuard（防重入→超时→记录→重试/冷却）；`reloadSchedule` 重启后从持久化状态 hydrate；`testRunRule` 走超时但不重试
- 改 `src/main/services/config-manager.ts` — `normalizeAutomationRules` 保留 `runTimeoutMs`/`maxRetries`/`failureCount`/`lastError`/`cooldownUntil`（之前每次保存被白名单丢弃）
- 改 `src/main/ipc/automation.ts` — `automation:create` 持久化 `runTimeoutMs`/`maxRetries`
- 改 `src/main/types.ts` — AutomationRule 增加上述可选字段
- 新增 `tests/unit/job-guard.test.ts` — 15 例（锁/冷却/重试退避/封顶/hydrate/隔离/withTimeout）
- 新增 `tests/e2e/j33-automation-hardening.test.ts` — 5 例（失败计数+lastError、冷却阈值、超时杀进程、成功重置、真链路）

**验证**：
```
$ npx vitest run tests/unit tests/smoke          → 15 files, 274 passed
$ npx vitest run -c vitest.config.e2e.ts j6 j27 j28 j33 → 4 files, 23 passed
```
关键证明：custom-js 抛错 → `failureCount++` + `lastError` 持久化；连失 3 次 → `cooldownUntil` 落盘并在 `automation:list` 可见；慢动作(30s) + `runTimeoutMs:200` → ~200ms 被杀；成功后 `failureCount` 归零。

**修复的连带 bug**：`normalizeAutomationRules` 用显式字段白名单重建规则，导致任何新字段（含运行态）每次 `saveConfig` 被丢弃——这正是 `failureCount` 一开始不持久化的根因，已修。

**下一步候选**：
- Slice 2 — 凭据保险库（safeStorage 加密 platformPassword/proxy password/llm key/sync key）+ 统一 audit_log（P0，速赢 #2）
- Slice 3 — 启动前一致性检查（代理国家↔tz↔locale↔WebRTC，冲突告警/阻断）（速赢 #3）
- Slice 4 — durable job queue（P0）：jobs/job_runs SQLite 表 + 全局并发上限 + 断点续跑（JobGuard 是它的执行态前置）

### Slice 2 — 凭据保险库 + 审计日志（P0 / 速赢 #2）— ✅ 完成

**范围**：敏感凭据（LLM apiKey / proxy 密码 / 账号密码 / sync secretKey）落盘加密（OS keychain via Electron safeStorage），使用时透明解密；新增统一审计日志回答「谁对哪个资产做了什么」。明文 config.json 不再含任何密钥。

**威胁模型**：保护 config.json 被从磁盘读出（list/get IPC 本就脱敏，加密针对的是 at-rest 文件）。

**文件**：
- 新增 `src/main/services/secrets.ts` — safeStorage 加解密 + `"v1:"` 标记 + Node/headless 透传降级 + `decryptSecretOr`（消费点容错）
- 新增 `src/main/services/audit-log.ts` — 追加式 JSONL 环形缓冲（cap 2000），`recordAudit/listAudit/clearAudit`，按 category/target 过滤，永不抛错
- 新增 `src/main/ipc/audit.ts` + preload `audit:{list,clear}` namespace
- 改 `config-manager.ts` — `normalizeProxyConfig`/`normalizeAccounts`/`setSyncConfig` 写入时加密；`resolveProfileProxyInternal` 消费时解密；`migrateSecrets()` 启动一次性迁移
- 改 `local-agent.ts` — 4 个 fetch header 站点解密 apiKey
- 改 `cloak-manager.ts` — 启动时解密 proxy 密码注入 auth 回调；launch/stop 写 audit
- 改 `ipc/agent.ts` — `saveLlmConfig` 加密 apiKey + audit
- 改 `sync-service.ts` — 3 个签名站点解密 secretKey
- 改 `index.ts` — 启动调 `migrateSecrets()` + 注册 audit handlers
- 新增 `tests/unit/secrets.test.ts`（8 例）+ `tests/unit/audit-log.test.ts`（8 例）+ `tests/e2e/j34-credential-vault.test.ts`（4 例）

**验证**：
```
$ npx vitest run tests/unit tests/smoke          → 17 files, 289 passed
$ npx vitest run -c vitest.config.e2e.ts j1 j4 j17 j29 j32 j33 j34 → 7 files, 39 passed
```
J34 关键证明（Electron 真环境，safeStorage 可用）：保存的 LLM key 在 config.json 里是 `v1:…`（**明文 `test-llm-key-j34-sentinel-not-real` 不落盘**）；chat 请求的 `Authorization: Bearer` 头里是**解密后的明文**（证明使用链路通）；保存动作进了 audit log。

**下一步候选**：
- Slice 3 — 启动前一致性检查（代理国家↔tz↔locale↔WebRTC，冲突告警/阻断）（速赢 #3）
- Slice 4 — durable job queue（P0）
- Slice 5 — audit UI tab（把 audit:list 渲染成「最近操作」时间线，团队治理可见性）

### Slice 3 — 启动前一致性检查（速赢 #3）— ✅ 完成

**范围**：profile 启动前校验 timezone/locale/WebRTC 与代理的自洽性，冲突告警（默认）或阻断（`blockOnConsistencyConflict`）。纯逻辑模块，无网络依赖 → 可单测。

**文件**：
- 新增 `src/main/services/consistency-check.ts` — `tzToCountry` / `localeToRegion` / `checkProfileConsistency`（blocker: WebRTC+无代理泄漏；warning: tz↔locale、proxy↔tz、proxy↔locale、proxy-tz-mismatch）
- 改 `cloak-manager.ts` `launchCloak` — 启动前跑检查，写 audit，按 flag 阻断
- 改 `ipc/cloak.ts` + preload — `cloak:consistency-check` 供 UI badge
- 改 `types.ts` — `blockOnConsistencyConflict?: boolean`
- 新增 `tests/unit/consistency-check.test.ts`（10 例）+ `tests/e2e/j35-consistency-check.test.ts`（4 例）

**验证**：unit 10 + e2e 4。J35 证明 WebRTC+无代理 → blocker；`blockOnConsistencyConflict=true` 时启动被拒（启动前抛错，无需浏览器二进制）；blocker 进审计。

### Slice 4 — Durable job Queue（P0）— ✅ 完成

**范围**：自动化执行从「内存 timer」升级为 SQLite 持久化 job queue + 全局并发上限 + 启动恢复。JobGuard 仍是每规则的执行态（锁/超时/重试/冷却），job 表补充持久化记录 + 全局并发 + 可观测/可重试。

**文件**：
- 新增 `src/main/services/job-store.ts` — `jobs.sqlite` 单例；enqueue/markRunning/markDone/markFailed/markSkipped/markCancelled/list/recoverInterruptedJobs（`:memory:` 可测）
- 改 `automation.ts` — `runRule` 每次产生一条持久 job（含 source: cron/once/event/test/skipped）；全局并发信号量（`maxConcurrentJobs` 默认 3）；`testRunRule` 也记 job；`startScheduler` 启动恢复 interrupted→failed
- 改 `ipc/automation.ts` + preload — `automation:jobs` / `job-cancel`
- 改 `index.ts` — quit 时 `closeJobDb()`
- 新增 `tests/unit/job-store.test.ts`（9 例）+ `tests/e2e/j36-job-queue.test.ts`（4 例）

**修的真 bug**：`setTimeout(delay)` 当 delay > 2^31-1 ms（~24.8 天）会溢出并立即触发 → 任何「下次触发 > 24.8 天」的 cron（月度/年度）会死循环狂触发。改成按天分段 arm + 重新求值。J36 的回归断言「far-future cron 在测试期间 0 触发」钉死此修复。

**验证**：unit 9 + e2e 4。J36 证明 testRun 产生 done/failed job 并经 `automation:jobs` 可见；job 跨 reloadConfig 持久。

### Slice 5 — 活动审计 UI Tab — ✅ 完成

**范围**：把审计日志渲染成「谁在何时对哪个资产做了什么」的时间线，团队治理可见性。

**文件**：
- 新增 `src/renderer/js/app/activity.js` — `loadActivity`（按 category 过滤）、`activityClear`，时间线渲染（图标/动作/actor/target/时间/详情）
- 改 `index.html` — nav 新增「📜 活动审计」+ `#tab-activity` section（filter 下拉 + 刷新 + 清空）
- 改 `tabs.js` — `activity` 分发
- 新增 `tests/e2e/j37-activity-tab.test.ts`（4 例）

**修的真 bug**：filter `<select>` 用了 `data-role="cmd"`（只响应 click），下拉 change 不触发。改成 `data-role="change" data-change-cmd`（响应 change 委托）。

**验证**：e2e 4。J37 证明保存 LLM 配置后切到活动 tab 能看到该记录、filter 收窄、清空生效。

---

## 当前总验证状态

```
$ npx vitest run tests/unit tests/smoke          → 19 files, 308 passed
$ npx vitest run -c vitest.config.e2e.ts (全部)  → J1-J37 全绿（含 journey 10/10 tab 切换）
```

5 个切片（1 自动化硬化 / 2 凭据保险库+审计 / 3 一致性检查 / 4 durable queue / 5 审计 UI）全部落地并验证。

### Slice 6 — MCP 暴露 browser/db/http + automation/runs/jobs（P1）— ✅
MCP 不再只列 profile：passthrough `cloak_browser_*` / `cloak_db_*` / `cloak_http_*` / `cloak_{read,write}_file`（委托 executeToolCall，schema 取自 AGENT_TOOLS 同步）+ `cloak_{automation_list,runs_list,jobs_list}`。J38 连真实 MCP server 验证 tools/list + db 直通。

### Slice 7 — Copilot 任务模板库（P1）— ✅
`task-templates.ts` 5 个结构化模板（价格采集/新闻采集/账号巡检/广告余额/表单→webhook），每个带 prompt + 输出表 schema + 步骤。`renderTemplateCatalog()` 注入系统提示，模型按模板流程走 + 结构化入库，而非每次重新发明。J39 验证模板驱动的结构化写入 + 提示里有模板目录。

### Slice 8 — 受限脚本运行时（P2，安全）— ✅
`script-sandbox.ts` 用 `vm` 沙箱替换 main 进程 `new Function` eval（原来有完整 Node 访问）：deny-by-default（无 require/process/fs/global），注入 logger，同步循环超时；setTimeout/Promise 保留以兼容旧规则，外层 withTimeout 仍兜底。J33/J36 不破坏。

### Slice 9 — 导出 + HTTP 连接器（P2）— ✅
http_request 支持 GET/POST/PUT/**PATCH/DELETE/HEAD**。`data:export` 返回 profiles/proxies/accounts/runs/jobs/db 的稳定 JSON，**密钥永不导出**。

### Slice 10 — 指纹基线 + 漂移检测（P0，信任地基）— ✅
`fingerprint-baseline.ts`：经 CDP 采集每 profile 的活跃指纹签名（UA/platform/语言/硬件/屏幕/tz/WebGL/canvas），存为基线，后续采集 diff 出漂移并审计，高风险字段（UA/tz/WebGL/硬件/屏幕）标记。`cloak:capture-baseline` IPC。J41 真浏览器验证采集 + 稳定 + 篡改基线→检出 risky 漂移。

### Slice 11 — 批量 CSV 导入（P1）— ✅
`bulk-import.ts` header CSV 解析器（name/platform/locale/timezone/seed/proxy/webrtc/tags，带别名）+ 兼容旧位置格式；doBulkImport 走 IPC 单一解析器 + 每行代理绑定。J42 验证 header CSV 导入 + 按行绑定代理。

### Slice 12 — 平台适配器（P2）— ✅
`platform-adapters.ts` 版本化 selector 适配器（Amazon Seller / Shopee / TikTok Shop / Facebook + 通用兜底），每个带 loginCheck 表达式；`detectAdapter(url)` 按域名匹配；目录注入系统提示。J— 单测覆盖。

### Slice 13 — 同步预检预览（P1，lean）— ✅
`sync:preview` 离线报告一次 push 涉及的 profile/proxy/account/extension 数 + **运行中 profile（pull 时跳过 localStorage/preferences）**清单。J43 验证计数 + 运行中跳过标记。

### Slice 14 — Windows x64 基线（P0）— 🟡 配置就绪，待 Windows 验证
electron-builder.yml 加 `win/nsis x64` target；新增 `.github/workflows/ci.yml`（ubuntu+windows 跑 tsc/build/unit-smoke，macOS 跑 e2e）；cloak-manager 的 win32 跨平台分支（binary 路径、process.kill/-F）已就位。**完整 Windows e2e 需 Windows runner + 自建 Chromium 正式发行包**——CI 里标注为后续。
