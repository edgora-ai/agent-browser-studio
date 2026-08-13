# Agent Browser Studio 改进路线图（场景化评测 → 开发推进）

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
- 改 `browser-manager.ts` — 启动时解密 proxy 密码注入 auth 回调；launch/stop 写 audit
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
- 改 `browser-manager.ts` `launchBrowser` — 启动前跑检查，写 audit，按 flag 阻断
- 改 `ipc/browser.ts` + preload — `browser:consistency-check` 供 UI badge
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
MCP 不再只列 profile：统一通过 `agent_browser_*` 暴露 browser/db/http/file 工具（委托 executeToolCall，schema 取自 AGENT_TOOLS 同步），并提供 `agent_browser_{automation_list,runs_list,jobs_list}`。J38 连真实 MCP server 验证 tools/list + db 直通；旧 `cloak_*` 只保留隐藏调用兼容。

### Slice 7 — Copilot 任务模板库（P1）— ✅
`task-templates.ts` 5 个结构化模板（价格采集/新闻采集/账号巡检/广告余额/表单→webhook），每个带 prompt + 输出表 schema + 步骤。`renderTemplateCatalog()` 注入系统提示，模型按模板流程走 + 结构化入库，而非每次重新发明。J39 验证模板驱动的结构化写入 + 提示里有模板目录。

### Slice 8 — 受限脚本运行时（P2，安全）— ✅
`script-sandbox.ts` 用 `vm` 沙箱替换 main 进程 `new Function` eval（原来有完整 Node 访问）：deny-by-default（无 require/process/fs/global），注入 logger，同步循环超时；setTimeout/Promise 保留以兼容旧规则，外层 withTimeout 仍兜底。J33/J36 不破坏。

### Slice 9 — 导出 + HTTP 连接器（P2）— ✅
http_request 支持 GET/POST/PUT/**PATCH/DELETE/HEAD**。`data:export` 返回 profiles/proxies/accounts/runs/jobs/db 的稳定 JSON，**密钥永不导出**。

### Slice 10 — 指纹基线 + 漂移检测（P0，信任地基）— ✅
`fingerprint-baseline.ts`：经 CDP 采集每 profile 的活跃指纹签名（UA/platform/语言/硬件/屏幕/tz/WebGL/canvas），存为基线，后续采集 diff 出漂移并审计，高风险字段（UA/tz/WebGL/硬件/屏幕）标记。`browser:capture-baseline` IPC。J41 真浏览器验证采集 + 稳定 + 篡改基线→检出 risky 漂移。

### Slice 11 — 批量 CSV 导入（P1）— ✅
`bulk-import.ts` header CSV 解析器（name/platform/locale/timezone/seed/proxy/webrtc/tags，带别名）+ 兼容旧位置格式；doBulkImport 走 IPC 单一解析器 + 每行代理绑定。J42 验证 header CSV 导入 + 按行绑定代理。

### Slice 12 — 平台适配器（P2）— ✅
`platform-adapters.ts` 版本化 selector 适配器（Amazon Seller / Shopee / TikTok Shop / Facebook + 通用兜底），每个带 loginCheck 表达式；`detectAdapter(url)` 按域名匹配；目录注入系统提示。J— 单测覆盖。

### Slice 13 — 同步预检预览（P1，lean）— ✅
`sync:preview` 离线报告一次 push 涉及的 profile/proxy/account/extension 数 + **运行中 profile（pull 时跳过 localStorage/preferences）**清单。J43 验证计数 + 运行中跳过标记。

### Slice 14 — Windows x64 基线（P0）— 🟡 配置就绪，待 Windows 验证
electron-builder.yml 加 `win/nsis x64` target；新增 `.github/workflows/ci.yml`（ubuntu+windows 跑 tsc/build/unit-smoke，macOS 跑 e2e）；browser-manager 的 win32 跨平台分支（binary 路径、process.kill/-F）已就位。**完整 Windows e2e 需 Windows runner + 自建 Chromium 正式发行包**——CI 里标注为后续。

### Slice 15 — 代理资产化：健康分/历史/绑定（P0，速赢 #8）— ✅

**范围**：把代理从「配置项」升级为「风险资产」——每次检测记录滚动健康历史，算出健康分/风险档位，展示绑定关系与建议，支持清除。

**文件**：
- 新增 `src/main/services/proxy-health.ts` — `recordProxyDetection`（历史 20 条封顶）、`computeScore`（成功率45+延迟25+漂移20+新鲜度10）、`riskFromScore`、`suggestionFor`、`computeBindings`、`listProxyHealth`/`clearProxyHealth`/`proxyHealthSummary`
- 改 `config-manager.ts` — `proxyHealth` 持久化 + 归一化；代理增删改/重命名同步清理或搬移健康记录
- 改 `ipc/detect.ts` — detect-by-name 成功后写健康；`ipc/proxy.ts` — `proxy:health-get`/`proxy:health-clear`
- 改 preload + `api.d.ts` + `proxies.js` + `style.css` — 代理页健康汇总、每卡健康徽章/建议/绑定、清除按钮
- 新增 `tests/unit/proxy-health.test.ts`（8 例）+ e2e J29 健康行断言

**验证**：unit 8 + e2e 5（J29）。健康分、连续失败→30 分钟冷却、IP/国家漂移、绑定计算、清除全部有测试钉死。

### Slice 16 — 代理自动轮换（P0，代理资产收尾）— ✅

**范围**：代理健康恶化（冷却 / poor+近期失败）时，自动把绑定它的 profile 切到第一个健康备用代理，启动继续可用；支持手动轮换 + 全程审计。

**设计**：轮换是**健康驱动的动态解析**——profile 仍指向主代理，`resolveProfileProxy*` 在解析时按健康状态选择生效代理，主代理恢复健康即自动回切，无需改 profile 配置。`fallbacks` 列表按序尝试，跳过同样不健康的备用。

**文件**：
- 改 `types.ts` — `ProxyConfig.fallbacks`、`ResolvedProfileProxy.rotatedFrom/rotationReason`、`ProxyHealthEntry.rotations/lastRotatedAt/lastRotatedTo`
- 改 `config-manager.ts` — `normalizeProxyFallbacks`、`isProxyUnhealthyForRotation`/`pickRotationFallback`/`getProxyRotationInfo`；`resolveProfileProxyInternal` 应用轮换；增删/重命名同步维护其它代理的 fallback 引用
- 改 `proxy-health.ts` — `recordProxyRotation`（轮换计数）
- 改 `browser-manager.ts` — 启动时若发生轮换：写健康计数 + audit（actor=auto）
- 改 `ipc/proxy.ts` — `proxy:rotate`（手动轮换 + audit）+ `proxy:rotation-info`（只读状态）；preload/api 同步
- 改 `index.html` + `proxies.js` — 编辑对话框「Fallback Proxies」字段；卡片备用列表、轮换状态徽章（⚠ 主→备用）、🔄 轮换按钮
- 新增 `tests/unit/proxy-rotation.test.ts`（9 例）+ `tests/e2e/j52-proxy-rotation.test.ts`（3 例）

**验证**：unit 9 + e2e 3（J52）。J52 走真实链路：对话框配置 fallback → 注入不健康健康态 → `rotation-info` 报 active/to → 手动轮换落盘 rotations=1 → 卡片轮换徽章出现。J29（5 例）回归通过。

---

## 当前总验证状态

```
$ npx vitest run tests/unit tests/smoke          → 38 files, 452 passed
$ npx vitest run -c vitest.config.e2e.ts (全部)  → J1-J52 全绿（含 journey 10/10 tab 切换）
```

7 个切片（1 自动化硬化 / 2 凭据保险库+审计 / 3 一致性检查 / 4 durable queue / 5 审计 UI / 15 代理资产化 / 16 代理轮换）落地并验证。

### Slice 17 — 批量运营台：筛选/勾选/批量动作（P1，运营效率）— ✅

**范围**：把 profiles tab 从「逐个管理」升级为「运营台」——按状态/标签筛选、勾选多行、批量启动/停止/分配代理/删除，全部在 UI 上完成。

**设计**：筛选即视图——改筛选（状态/标签）时自动清空已选，避免「选中被隐藏的行」被批量动作误伤；「全选可见」只作用于当前筛选后的可见卡片，防止批量删除误删筛选外 profile。

**文件**：
- 改 `index.html` — `#profile-batch-bar`（状态 select + 标签 input + 清除筛选 + 全选可见）+ `#profile-batch-actions`（已选计数、批量启动/停止/分配代理/删除）
- 改 `style.css` — `.batch-bar/.batch-filter/.batch-actions/.profile-select-checkbox`
- 改 `profiles.js` — `profileFilter/profileSelection` 状态；`updateBatchBar`（计数+代理下拉，仅在传入 proxies 时重灌并保留当前选中项）；`onProfileFilterChange/clearProfileFilters`（重置已选）；`onProfileSelectAllChange/toggleProfileSelect`；`batchStartSelected/batchStopSelected/batchAssignProxy/batchDeleteSelected`；卡片头勾选框
- 新增 `tests/e2e/j53-batch-console.test.ts`（6 例）

**验证**：unit/smoke 452 全绿；e2e J53 6 例（导入带标签 profile → 标签/状态筛选 → 全选可见计数 → 批量分配代理落盘 config.json → 确认框批量删除）；J2/J29/J42/J52 回归 17 例通过。

---

## 当前总验证状态

```
$ npx vitest run tests/unit tests/smoke          → 38 files, 452 passed
$ npx vitest run -c vitest.config.e2e.ts (全部)  → J1-J53 全绿（含 journey 10/10 tab 切换）
```

8 个切片（1 自动化硬化 / 2 凭据保险库+审计 / 3 一致性检查 / 4 durable queue / 5 审计 UI / 15 代理资产化 / 16 代理轮换 / 17 批量运营台）落地并验证。

### Slice 18 — 本地 REST API + OpenAPI（P1，开发者集成）— ✅

**范围**：把 MCP 之外补上开发者最需要的 HTTP 面——loopback REST API，覆盖 profiles/proxies/accounts/extensions/automation/runs/jobs/audit，自带 OpenAPI 3.0 文档，可接 Swagger/Postman/SDK 生成器，面向 CI 与自建工具链（竞品对标「开发者集成」场景的 API 短板）。

**设计**：与 MCP 同一服务层（browser-manager / config-manager / proxy-health / local-agent / job-store / audit-log），不复写逻辑；Bearer token 鉴权（`AGENT_BROWSER_API_TOKEN`，未设置则生成随机 token），仅 `/health` 与 `/openapi.json` 开放；端口 `26582`（`AGENT_BROWSER_API_PORT`），占用时回退临时端口；写操作（create/launch/stop/delete/add/update/rotate/clear）统一落 audit（actor=api）。

**文件**：
- 新增 `services/rest-api-server.ts` — 路由/鉴权/OpenAPI/生命周期（start/stop/getPort/getToken）
- 新增 `ipc/api.ts` + `preload.cjs` `api.apiRpc` — 渲染层暴露 status/restart/reveal-token（对齐 mcp 的 status/reveal-token）
- 改 `index.ts` — 启动/关闭 REST API（与 MCP 并列）
- 改 `README.md` — REST API 端点表 + 鉴权 + 示例 + 安全清单更新
- 新增 `tests/e2e/j54-rest-api.test.ts`（8 例）

**验证**：e2e J54 8 例全绿（/health + /openapi.json 免鉴权、无 token 401、/version、profile 增查删、launch→running→stop、proxy 增查改删 + health、accounts/automation/runs/jobs/audit 只读 + actor=api 审计）；unit/smoke 452 全绿；J38/J2 回归通过。

---

## 当前总验证状态

```
$ npx vitest run tests/unit tests/smoke          → 38 files, 452 passed
$ npx vitest run -c vitest.config.e2e.ts (全部)  → J1-J54 全绿（含 journey 10/10 tab 切换）
```

9 个切片（1 自动化硬化 / 2 凭据保险库+审计 / 3 一致性检查 / 4 durable queue / 5 审计 UI / 15 代理资产化 / 16 代理轮换 / 17 批量运营台 / 18 REST API+OpenAPI）落地并验证。

## 当前总验证状态

```
$ npx vitest run tests/unit tests/smoke          → 38 files, 454 passed
$ npx vitest run -c vitest.config.e2e.ts (全部)  → J1-J55 全绿（含 journey 10/10 tab 切换）
```

10 个切片（1 自动化硬化 / 2 凭据保险库+审计 / 3 一致性检查 / 4 durable queue / 5 审计 UI / 15 代理资产化 / 16 代理轮换 / 17 批量运营台 / 18 REST API+OpenAPI / 19 指纹漂移启动阻断）落地并验证。

### Slice 19 — 指纹漂移启动阻断（P0，信任地基）— ✅

**范围**：竞品环境监测发现「DNS 解析器 ↔ IP 国家 / 中文字体 / RAF 帧间隔」等漂移类风险。Slice 19 把「事后对比」升级为「启动即把关」——每次启动后立刻用实时指纹与存储的 baseline 做 diff，高风险字段（webgl/webgl2 renderer、canvas 指纹、userAgent、语言、时区、屏幕分辨率、硬件并发等）漂移时**默认杀进程并阻断启动**，防止带着不一致指纹上线被平台识别；也提供只读的 check-drift IPC 供 UI/工具随时核验。

**设计**：
- baseline 存在且 `blockOnFingerprintDrift !== false`（默认阻断）时，`waitForCdpReady` 之后做 post-launch drift check
- 捕获失败只告警不阻断（瞬时 CDP 抖动不能把合法启动打死）；阻断后 `waitForProcessExit`（SIGTERM→SIGKILL）确保不留活进程
- 全部动作落 audit：`fingerprint-drift`（有变更即记录，actor=auto）、`fingerprint-drift-block`（高风险阻断，actor=auto）
- `browser:launch` 返回体增加 `driftCheck`（checked/risky/drift/error）；新增只读 `browser:check-drift` IPC（无 baseline 返回 hasBaseline:false，未运行报错，否则实时 diff）
- profiles 卡片 Hardware 行新增 🧬 Drift 按钮，toast 反馈 stable / risky / no-baseline

**文件**：
- 改 `services/fingerprint-baseline.ts` — 新增 `summarizeDrift(drift, limit=8)`（audit/UI 可读摘要）
- 改 `types.ts` — `MgmtConfig.blockOnFingerprintDrift?: boolean`
- 改 `services/browser-manager.ts` — `LaunchDriftCheck` 接口、launch 返回体、post-launch drift check + 阻断 + `waitForProcessExit`
- 改 `ipc/browser.ts` + `preload.cjs` — `driftCheck` 透传、只读 `check-drift`
- 改 `renderer/js/app/profiles.js` — 🧬 Drift 按钮 + `agentBrowser.checkDrift`
- 新增 `tests/e2e/j55-drift-block.test.ts`（6 例）；`tests/unit/fingerprint-baseline.test.ts` +2 例

**验证**：e2e J55 6 例全绿（无 baseline 直启→capture baseline→check stable→篡改高风险字段后启动被 block 且无残留进程→audit 有 fingerprint-drift-block→`blockOnFingerprintDrift=false` 时 risky 放行）；unit/smoke 454 全绿；j41（基线流程）/j54/j53 回归 18 例通过。

## 当前总验证状态

```
$ npx vitest run tests/unit tests/smoke          → 38 files, 461 passed
$ npx vitest run -c vitest.config.e2e.ts (全部)  → J1-J56 全绿（含 journey 10/10 tab 切换）
```

11 个切片（1 自动化硬化 / 2 凭据保险库+审计 / 3 一致性检查 / 4 durable queue / 5 审计 UI / 15 代理资产化 / 16 代理轮换 / 17 批量运营台 / 18 REST API+OpenAPI / 19 指纹漂移启动阻断 / 20 sync 团队 diff 预览）落地并验证。

### Slice 20 — sync 团队工作区第一步：push/pull 前 diff 预览（P1，团队协作）— ✅

**范围**：把 sync 从「盲推盲拉的 S3 备份」推向团队工作区——push/pull 前拉取远端配置做结构化对比，明确「本地独有 / 远端独有 / 两边冲突」以及 push 会移除什么。这是竞品团队协作短板的第一个增量，也是后续锁/所有权/冲突合并的地基。

**设计**：
- `previewDiff()` 只读：拉取远端 config 快照（S3 GET，SigV4 签名，走与 pull 相同的 fetchSyncConfig），解码 gzip data，与本地 sanitized 快照对比
- 对比面：profiles / proxies / accounts / extensions / defaultProxy + 远端工件（cookies/localStorage/preferences 的 dirId 列表）+ 远端最后同步时间戳
- 方向语义：`localOnly`（本地独有，push 会新增/保留）、`remoteOnly`（远端独有，**push 会把它们从远端移除**=数据丢失风险，pull 会导入本地）、`changed`（两边都有但字段不同，忽略 syncedAt/syncedHash 记账字段）
- 结果带 `pushWarnings`（红色，push 会移除的远端数据）与 `pullNotes`（蓝色，pull 会导入/覆盖什么）
- 远端 404 = 首次推送：返回 `firstPush:true`，不报错
- **顺带修复**：accounts 元数据（platformPassword 已剔除）此前根本没进 sync 快照但 UI 声称会同步——现在真正纳入同步，pull 时按 (platformUrl, platformUserName) 去重合并、本地优先
- UI：sync tab 新增「Team Diff 预览」卡片 + 对比按钮；push 前自动 diff，有 pushWarnings 时弹确认「会移除远端数据」；pull 前自动刷新 diff

**文件**：
- 改 `services/sync-service.ts` — `previewDiff()` / `buildSyncDiff()` / `stableStringify` / `diffSectionById` / `diffAccountArrays` / `mergeAccountArrays` / accounts 纳入 `serializeSyncSafeConfig`（去密码）+ pull 合并
- 改 `ipc/sync.ts` + `preload.cjs` — `sync:preview-diff`
- 改 `renderer/js/app/sync.js` — diff 渲染（profile-card 徽章、push 风险红卡、pull 蓝卡、工件计数、首次推送提示）、push 前确认
- 改 `renderer/index.html` — Team Diff 卡片
- 改 `tests/unit/sync-service.test.ts` — +7 例（分类/工件/警告/clean/stableStringify/mergeAccountArrays/去密码）
- 新增 `tests/e2e/j56-sync-diff-preview.test.ts`（5 例，本地 mock S3）

**验证**：e2e J56 5 例全绿（首次 preview firstPush+localOnly → push 落盘 → push 后 clean+remoteTimestamp → 注入远端独有 profile 后 pushWarnings/pullNotes 出现）；unit/smoke 461 全绿；j55/j54/j41 回归 18 例通过；whitespace audit 通过。

## 当前总验证状态

```
$ npx vitest run tests/unit tests/smoke          → 38 files, 465 passed
$ npx vitest run -c vitest.config.e2e.ts (全部)  → J1-J57 全绿（含 journey 10/10 tab 切换）
```

12 个切片（1 自动化硬化 / 2 凭据保险库+审计 / 3 一致性检查 / 4 durable queue / 5 审计 UI / 15 代理资产化 / 16 代理轮换 / 17 批量运营台 / 18 REST API+OpenAPI / 19 指纹漂移启动阻断 / 20 sync 团队 diff 预览 / 21 团队 profile 签出锁定）落地并验证。

### Slice 21 — 团队 profile 签出锁定（P1，团队协作护栏）— ✅

**范围**：diff 预览只解决「看得见」，锁解决「拦得住」——设备可以把 profile 签出（lock）到本机，其他设备的 push 会被硬拦截，防止两个人盲推互相覆盖 cookies/localStorage/preferences（团队协作数据丢失的头号来源）。这是轻量团队工作区的第二个增量。

**设计**：
- 设备身份：`MgmtConfig.deviceId`（randomUUID）+ `deviceName`（hostname），首次 `getConfig()` 时自动生成并持久化
- Profile 锁：`BrowserProfileMeta.lock = { owner: deviceId, ownerName, at }`；IPC `browser:set-lock(dirId, locked)` 锁定/解锁，落 audit（lock/unlock）
- 锁随 sync 快照同步（`serializeSyncSafeConfig` 透传 lock）
- `previewDiff` 新增 `remoteLocks`（远端被其他设备锁定的 profile 列表）+ pushWarnings 提示「被其他设备锁定，Push 会被拒绝」
- **push 硬保护**：`push()` 上传前拉取远端 config，若有远端 profile 被其他设备锁定 → 拒绝（`force=true` 可绕过）；`sync:push` 支持 `{ force }`
- UI：profile 卡片新增 🔒 锁定/🔓 解锁按钮 + 头部锁定徽章（显示 ownerName）；Push 被锁拦截时弹「强制覆盖?」确认后带 force 重试

**文件**：
- 改 `types.ts` — `ProfileLock`、`BrowserProfileMeta.lock`、`MgmtConfig.deviceId/deviceName`
- 改 `config-manager.ts` — `ensureDeviceIdentity()`（首次生成 deviceId/deviceName）
- 改 `browser-manager.ts` — `BrowserProfile.lock` 透出
- 改 `ipc/browser.ts` + `preload.cjs` — `browser:set-lock`
- 改 `sync-service.ts` — lock 透传、`remoteLocks` diff、`collectRemoteLocksBlockingPush` + push force 保护
- 改 `ipc/sync.ts` + `preload.cjs` — `sync:push({ force })`
- 改 `renderer/js/app/profiles.js` — 锁按钮/徽章/`toggleLock`
- 改 `renderer/js/app/sync.js` — 锁拦截时强制推送确认
- 改 `tests/unit/sync-service.test.ts` — +4 例（lock 透传、remoteLocks、自己锁不拦、collect 阻断）
- 新增 `tests/e2e/j57-sync-lock.test.ts`（7 例，mock S3）

**验证**：e2e J57 7 例全绿（锁定→push 携带锁→注入他人锁定后 previewDiff 标出 remoteLocks→push 被拦→force 绕过→解锁）；unit/smoke 465 全绿；j56/j55/j54/j41 回归 23 例通过；whitespace audit 通过。

## 当前总验证状态

```
$ npx vitest run tests/unit tests/smoke          → 39 files, 478 passed
$ npx vitest run -c vitest.config.e2e.ts (全部)  → J1-J58 全绿（含 journey 10/10 tab 切换）
```

13 个切片（1 自动化硬化 / 2 凭据保险库+审计 / 3 一致性检查 / 4 durable queue / 5 审计 UI / 15 代理资产化 / 16 代理轮换 / 17 批量运营台 / 18 REST API+OpenAPI / 19 指纹漂移启动阻断 / 20 sync 团队 diff 预览 / 21 团队 profile 签出锁定 / 22 Host 环境风控检查）落地并验证。

### Slice 22 — Host 环境风控检查（P0，反检测环境可信）— ✅

**范围**：ping0.cc 那类环境扫描发现的三类宿主泄漏——DNS 解析器混入国内（DNS 泄漏）、本机中文字体暴露中文系统、rAF 帧间隔非标准——此前只能靠用户自己开网页测。Slice 22 把它们做成**应用内检查**：profile 卡片一键出报告，给出严重级别和可执行的修复建议；profile 运行时还会叠加 rAF 实测。

**设计**（`services/environment-risk.ts`，纯逻辑可注入、可单测）：
- **DNS 解析器**：`node:dns.getServers()` 枚举系统解析器，已知公共/运营商表（Google/Cloudflare/Quad9 vs 114DNS/AliDNS/DNSPod/电信联通）分类 + 国内 ISP 前缀启发式；非中文 profile 混入 CN 解析器 → high（dns-resolver-leak），中文 profile → info
- **中文字体**：扫描系统字体目录（macOS System/Library+用户、Windows Fonts、Linux fonts），文件名匹配 SimSun/雅黑/楷体/仿宋/等线/苹方/黑体-简/宋体-简/华文/方正 等；非中文 profile 检测到 → high（cn-fonts-exposed）
- **代理 DNS 泄漏**：SOCKS5（本地解析）→ high（proxy-dns-leak），HTTP/socks5h → low，直连 → none
- **宿主语言**：宿主 locale 为 zh 但 profile 非中文 → medium（host-locale-leak）
- **rAF 运行时测量**：profile 运行中经 CDP 采样 ~1.5s，中位间隔归类刷新率，非标准（非 60/75/90/120/144/165/240Hz）→ medium（raf-non-standard）
- `checkEnvironmentRisk()` 预检（快、无副作用）；`checkEnvironmentRiskRuntime()` 运行中变体（附加 rAF）
- IPC `browser:env-risk`；profile 卡片 Hardware 行新增 🖥 Env 按钮，报告弹 dialog（PASS/RISK 徽章 + 逐条 severity/code/message/fix）

**文件**：
- 新增 `services/environment-risk.ts` — 解析器分类 / 字体扫描 / 代理 DNS 泄漏 / RAF 分类与测量 / findings 组装
- 改 `ipc/browser.ts` + `preload.cjs` — `browser:env-risk`（运行中走 runtime 变体）
- 改 `renderer/js/app/profiles.js` + `index.html` — 🖥 Env 按钮 + `dlg-env-risk` 报告 dialog
- 新增 `tests/unit/environment-risk.test.ts`（13 例）+ `tests/e2e/j58-env-risk.test.ts`（4 例）

**验证**：unit 13 例全绿（解析器分类/字体 fixture/代理 DNS/RAF 分类/findings 严重级与 CN 兼容）；e2e J58 4 例全绿（预检结构、非中文 profile 遇 CN 解析器 → high、运行中 raf 字段）；unit/smoke 478 全绿；j55/j56/j57/j54/j41 回归 30 例通过；whitespace audit 通过。

## 当前总验证状态

```
$ npx vitest run tests/unit tests/smoke          → 39 files, 480 passed
$ npx vitest run -c vitest.config.e2e.ts (全部)  → J1-J59 全绿（含 journey 10/10 tab 切换）
```

14 个切片（1 自动化硬化 / 2 凭据保险库+审计 / 3 一致性检查 / 4 durable queue / 5 审计 UI / 15 代理资产化 / 16 代理轮换 / 17 批量运营台 / 18 REST API+OpenAPI / 19 指纹漂移启动阻断 / 20 sync 团队 diff 预览 / 21 团队 profile 签出锁定 / 22 Host 环境风控检查 / 23 环境风控启动闸门）落地并验证。

### Slice 23 — 环境风控启动闸门（P0，信任地基收口）— ✅

**范围**：Slice 22 只「检测」，Slice 23 把它接进启动流程——每次 launch 后运行环境风控预检（DNS 解析器 / 中文字体 / 代理 DNS），高危发现**始终落审计**，并可按配置 `blockOnEnvironmentRisk=true` 硬阻断启动；launch 返回体带 `envCheck` 供 UI/API 消费。默认仅告警记录（不阻断），避免中文字体这类普遍存在的主机项把正常用户卡死。

**设计**：
- `environment-risk.ts` 新增纯函数：`summarizeEnvFindings(findings, severity)`（audit/UI 摘要）、`shouldBlockEnvironmentRisk(result, enabled)`（opt-in 硬闸）
- `types.ts` 新增 `MgmtConfig.blockOnEnvironmentRisk?: boolean`
- `browser-manager.ts` launchBrowser：waitForCdpReady 之后跑 `checkEnvironmentRisk`（传 profile tz/locale/platform + resolvedProxy 的 type），返回 `envCheck: { checked, high, findings, error }`；高危写 audit `env-risk-high`（actor=auto）；`blockOnEnvironmentRisk===true` 时杀进程（SIGTERM→SIGKILL）、写 audit `env-risk-block`、抛 `envBlocked`；检查失败仅告警
- IPC `browser:launch` 返回 `envCheck`；REST 新增只读 `GET /api/profiles/{dirId}/env-risk`（运行中带 rAF，否则预检），OpenAPI/README 同步
- UI：launch 成功后若 `envCheck.high` 弹警告 toast（列出高危 code，提示点 🖥 Env 看修复建议）

**文件**：
- 改 `services/environment-risk.ts` — summarize/shouldBlock 助手 + proxyDnsLeak 类型松化
- 改 `types.ts` — `blockOnEnvironmentRisk`
- 改 `services/browser-manager.ts` — `LaunchEnvCheck`、env check 集成、两处提前返回、launch 返回体
- 改 `ipc/browser.ts` + `services/rest-api-server.ts` + `README.md` — launch envCheck、env-risk 端点 + OpenAPI
- 改 `renderer/js/app/profiles.js` — launch 高危 toast
- 改 `tests/unit/environment-risk.test.ts` — +2 例（shouldBlock/summarize）
- 新增 `tests/e2e/j59-env-risk-launch-gate.test.ts`（6 例）；`tests/e2e/j54-rest-api.test.ts` +env-risk 端点断言

**验证**：e2e J59 6 例全绿（默认 launch 返回 envCheck.high=true（本机有 CN 解析器 114.114.114.114 + Hiragino/STHeiti 字体）→ audit 有 env-risk-high → `blockOnEnvironmentRisk=true` 时 launch 被拦且无残留进程 → audit 有 env-risk-block → 关闭后放行）；unit/smoke 480 全绿；j54（含 env-risk REST）/j58/j55/j56/j57/j41 回归 34 例通过；whitespace audit 通过。


### Slice 40 — Widevine/DRM 支持（P1，能力对齐）— ✅

**范围**：让独立 Chromium 构建具备 Widevine/DRM 能力并按 profile 启用——发现主机 CDM（Chrome/Brave/Edge/Chromium 应用包 + user-data + 配置覆盖 + 托管副本）、按 profile 开关、真实 EME 验证。定制构建原本 `ENABLE_WIDEVINE=0`（禁用），且 Chrome 150 无 `--widevine-cdm-path` 开关，因此从补丁侧打通。

**Chromium 补丁（0045）**：
- `chrome/common/media/cdm_registration.cc` — macOS/Windows 分支检测 `--widevine-cdm-path`，存在时用 `CreateCdmInfoFromWidevineDirectory` 注册托管 CDM；编译门控扩展覆盖 mac/win（及 linux/chromeos bundle 分支），新增 `base/native_library.h` + `media/cdm/cdm_paths.h` include
- `third_party/widevine/cdm/widevine.gni` — `enable_widevine_cdm_component` 改 `declare_args()`（可覆盖）
- `args.gn` — `enable_widevine=true`、`enable_widevine_cdm_component=false`（禁用 Google 组件下载/回传）、`ignore_missing_widevine_signing_cert=true`
- Chromium 源码 commit `26aeffbdef` + tag `agent-browser-chromium-150-patchset-0045`；官方 ThinLTO 构建成功并发布

**应用层**：
- 新增 `services/drm.ts` — CDM 发现（configured→chrome→user-data→managed 优先级）、`ensureManagedCdm` 托管到 `<appData>/cdm/widevine/<version>`、`drmLaunchArgs`、`probeDrmViaCdp`
- IPC `drm:status` / `drm:set-profile` / `drm:set-cdm-path` / `drm:ensure` / `drm:probe`；`browser:create` / `browser:set-meta` 透传 `drm`；launch 时 `addDrmArgs`
- REST/OpenAPI：`GET /api/drm/status`、`POST /api/drm/cdm-path`、`POST /api/drm/ensure`、`POST /api/profiles/{dirId}/drm`
- UI：新建/编辑弹窗 DRM checkbox、Profile 卡 🎬 DRM badge、Browser tab Widevine/DRM 卡片（状态/重扫/CDM 路径保存）
- 新增 `tests/unit/drm.test.ts`（7 例）+ `tests/e2e/j66-drm.test.ts`（8 例）

**实测验证**：新构建 + 本机 Chrome Widevine CDM（manifest `4.10.3050.0`）——不带 flag 时 `requestMediaKeySystemAccess` 返回 `NotSupportedError`（不可用）；DRM profile 带 `--widevine-cdm-path` 时 `available:true, ks:"com.widevine.alpha"`（可用）；非 DRM profile 无该 key system（per-profile gating）。构建树与发布二进制均复测通过。

**验证**：j66 8 例全绿（创建+badge、status 发现、ensure 托管 staging、编辑弹窗开关持久化、DRM profile 真实 EME 探测、非 DRM profile 无 Widevine、stop、无 console error）；j32 profile UI 回归 5 例；unit/smoke 44 文件 538 例全绿；tsc/build 干净。


### Slice 41 — 团队工作区 RBAC（P1，团队协作收口）— ✅

**范围**：ALIGNMENT_MATRIX 产品级缺口「team workspace semantics (RBAC, locks, conflict handling)」中的 RBAC 落地——在现有 deviceId / sync / 签出锁 / 冲突解决之上加成员-角色模型，并随同步传播。锁与冲突解决此前已完成，本切片补上成员与权限。

**设计**：
- 角色层级 owner > admin > member > viewer；workspace manifest（`team`）含 workspace 名、ownerDeviceId、成员名册（deviceId/name/role/addedAt）、enabled、updatedAt
- 门控（团队启用时生效，本地 best-effort，与签出锁模型一致）：viewer 只读（禁 push/force-push/删 profile/建 profile）；member 可 push/建删；admin 可 force-push + 管理 member/viewer 角色与成员；owner 可设 admin/owner 角色、重命名、移除 admin；owner 永不可移除
- sync 集成：manifest 随 push 快照传播（`sanitizeTeam` 纯函数，脱敏序列化），pull 按 updatedAt 择优采纳远程名册——远端把本设备降为 viewer 后 pull 即生效、push 被「team policy」拦截
- 新增 `services/team.ts`（纯函数 + 配置读写）、`ipc/team.ts`（team:status/init/add-member/remove-member/set-role/rename/set-enabled）
- REST/OpenAPI：`GET /api/team`、`POST /api/team/init`、`POST /api/team/members`、`DELETE /api/team/members/{deviceId}`、`PUT /api/team/members/{deviceId}/role`、`POST /api/team/rename`
- UI：Sync 标签页新增 Team Workspace (RBAC) 卡片——workspace 名/成员数/enforcement、成员名册（本机高亮 + 角色徽章 + 👑 owner）、admin 可加成员/改角色/移除、owner 可重命名、enforcement 开关

**验证**：unit `tests/unit/team.test.ts` 13 例（角色层级、init 建 owner、add/remove/set-role 权限矩阵、viewer 禁 push/force-push/delete、enforcement 关闭放行、syncSafeTeam、mergeTeam 择优、未列名设备按 viewer 处理）；e2e `tests/e2e/j67-team-rbac.test.ts` 8 例（IPC init/add/去重、REST status/member/OpenAPI、UI 面板渲染、mock S3 push 携带 manifest、远端降级 viewer 后 pull 生效 push 被拦、恢复 owner 后放行）；全量单测 45 文件 551 例全绿；回归 j32/j43/j54/j56/j57/j62/j64 共 42 例全绿；tsc/build 干净。

### Slice 42 — 无头 Server 模式 + Docker + Python SDK（P1，集成面收口）— ✅

**范围**：ALIGNMENT_MATRIX 产品级缺口「Docker/server mode and Python/JavaScript/.NET integration surfaces」——让控制器可作为无窗口/无 tray 的 headless server 运行（scheduler + MCP + REST 全保留），并提供 Docker 镜像与 Python SDK 作为自动化/CI 集成面。

**无头 server 模式**：
- 新增 `src/main/services/server-mode.ts` — `isHeadlessMode()` 检测 `--headless` / `--server` / `AGENT_BROWSER_HEADLESS=1` / `CLOAK_HEADLESS=1`
- `src/main/index.ts` — headless 分支跳过窗口和 tray，保留 scheduler + MCP + REST，打印 `[server] headless server mode` 日志
- `rest-api-server.ts` — `GET /health` 返回 `mode: "headless"|"gui"`、version、profiles 数量、uptimeSeconds，作为编排就绪探针

**Docker**：`Dockerfile`（golang:1.25 构建 masque bridge + node:22 运行层 + apt 共享库）、`docker-compose.yml`（数据卷持久化 + 26582 端口）、`.dockerignore`；容器以 `--headless --no-sandbox` 启动

**Python SDK**：`sdk/python/agent_browser_client.py` 零依赖（stdlib-only）REST client——health/version/openapi、profiles（建/删/启停/status）、proxies、team RBAC、DRM、automation rules、runs/jobs；`example.py` + `README.md`

**验证**：e2e `tests/e2e/j68-server-mode.test.ts` 6 例全绿（health mode=headless、REST 建 profile 201、launch 返回 cdpPort、status running、stop、`windows().length===0` 无 GUI）；回归 j54/j32/j67/j66/j1 共 39 例通过；全量单测 45 文件 551 例全绿；tsc 干净。Python SDK 已对真实 headless 实例实测（health → create → launch cdpPort 63981 → status → stop → team）。

### Slice 43 — 版本感知自动更新 + 回滚（P1，产品级缺口收口）— ✅

**范围**：ALIGNMENT_MATRIX 产品级能力「version-aware automatic updates with rollback」——补上控制器运行时的版本化发布存储：检查更新清单、下载+sha256 校验+暂存新版本、激活 pin、手动回滚、以及崩溃循环自动回滚。复用与独立 Chromium 版本存储（native-chromium-manager）一致的「保留 known-good + 版本 pin」模式。

**核心服务 `services/update-manager.ts`**：
- 清单解析/校验（product 匹配、版本号归一排序、sha256 格式、重复版本拒绝）+ 语义化点分版本比较（1.10.0 > 1.9.0）
- `checkForUpdates()` — 支持 http(s):// / file:// / 本地路径清单，按「比当前新 + minSupported 门槛」过滤可用版本
- `installRelease()` — 下载 zip（sha256 校验）或拷贝目录 payload 到 `<appData>/updates/releases/<version>/payload`，先 staging 后原子换入，路径穿越/大小上限防护（复用 zip-writer 安全解压）
- `activateVersion()` / `rollback()` — 版本 pin + 保留上一 known-good；`noteAppStarted()`/`noteAppCrashed()`/`markAppHealthy()` 崩溃循环检测（连续 3 次异常退出自动回滚，10 分钟冷却防反复横跳）
- 保留最近 3 个 release（active + previous + 最新 staged），每次动作写 audit + 持久化 history

**接入面**：
- IPC `updates:*`（status/check/install/activate/rollback）+ preload 暴露 `api.updates`
- REST/OpenAPI：`GET /api/updates/status`、`POST /api/updates/check|install|activate|rollback`
- UI：Browser Engine 标签页新增「🔄 App Updates」卡片（当前/活动/上一 known-good/通道/已安装/可用更新/历史 + Stage/Activate/Roll back 按钮），中英 i18n
- `index.ts` 启动钩子：启动时 `noteAppStarted()`（自动回滚）+ 60s 后 `markAppHealthy()` + 异常退出计数
- e2e helper `launchHeadlessApp` 支持 env/args 注入

**验证**：unit `tests/unit/update-manager.test.ts` 14 例（版本比较、清单校验、check 可用性/minSupported/缺清单、目录与 zip payload 安装、sha256 拒绝、activate pin、手动回滚、崩溃循环自动回滚、markAppHealthy、audit+history）；e2e `tests/e2e/j69-updates.test.ts` 6 例（REST status/check/install/activate/rollback/history + payload 落盘）；全量单测 46 文件 565 例全绿；回归 j68/j54 16 例 + j67 8 例 + j61 3 例全绿；tsc/build 干净。

### Slice 44 — 代理健康/历史/轮换作为受管资产收口（P0，代理资产）— ✅

**范围**：ALIGNMENT_MATRIX 产品级能力「proxy health/history/rotation as managed assets」——服务层（健康分/风险分层/历史/IP漂移/绑定/冷却/轮换）此前已实现并有单测，本切片补齐最后一块：UI 历史时间线，并用 e2e 把「检测 → 劣化 → 轮换 → 历史」全流程验证归档。

**UI（`src/renderer/js/app/proxies.js`）**：
- 每个 proxy 卡片新增 `📈 历史` 按钮 + 可展开历史时间线（`proxy-history-row`）：最近 8 条检测记录，成功行显示时间/IP/国家/tz/provider/延迟，失败行显示时间与错误；再次点击收起
- 检测完成或清除健康后若时间线已展开则自动刷新内容

**验证**：e2e `tests/e2e/j70-proxy-health-history.test.ts` 5 例（加代理+fallback、对关闭端口快速失败的代理做 Detect 记录失败观测、轮换建议 healthy fallback 并记录切换、历史时间线展开显示 ❌ 再收起、无意外 console error）；回归 j29（proxy UI CRUD）5 例；全量单测 46 文件 565 例全绿；tsc/build 干净。

### Slice 45 — Linux 引擎构建路径 + 多平台打包配置（P1，平台缺口推进）— 🟡

**范围**：ALIGNMENT_MATRIX 剩余的硬缺口是签名多平台分发 / Windows-Linux 生产验证。上游 CloakBrowser 已发布 Linux Chromium 150 构建（v0.5.2），本切片把我们的独立 Linux 构建路径与多平台打包配置落到仓库里，让 Linux/CI 主机一步即可产出引擎并接入 headless Docker 镜像。

**新增/修改**：
- `patches/chromium/args.gn.linux` — Linux 官方构建参数（target_os=linux、ThinLTO 官方构建、Chrome FFmpeg branding、Widevine key-system 管线 + 运行时托管 CDM、enable_nacl=false / use_custom_libcxx / is_clang）
- `patches/chromium/build-linux.sh` — 一键构建：缺省克隆到 pin 定 commit → `gclient sync` → `apply.sh` 打补丁 → 写入 args.gn.linux + target_cpu → `gn gen` + `autoninja chrome`；输出 `out/AgentBrowserRelease/chrome` 并打印接入方式
- `patches/chromium/README.md` — 新增 Linux 构建章节（含 install-build-deps 指引）
- `electron-builder.yml` — 新增 `linux` 目标（AppImage x64/arm64）+ mac/win 签名/公证 env 说明（本地构建保持未签名）
- `Dockerfile` / `docker-compose.yml` — 镜像声明 `AGENT_BROWSER_CHROMIUM_BINARY_PATH=/opt/chromium/chrome`，compose 挂载 `./chromium:/opt/chromium`，运行时缺二进制即 fail-closed（无 wrapper 回退）
- `tests/smoke/linux-build.test.ts` — 5 例：args.gn.linux 表面与键值行可解析、build-linux.sh 存在且可执行且 `bash -n` 通过、electron-builder mac/win/linux 目标齐全、Dockerfile/compose 引擎接线正确

**验证**：smoke 5 例全绿；全量单测/tsc 不受影响（见下方回归）。真实 Linux 构建与生产 E2E 仍需 Linux 构建主机，矩阵该行从 `missing` 更新为 `partial` 并注明已定义路径。

### Slice 46 — 窗口几何自洽性实证（P1，反检测可信闭环）— ✅

**背景**：上游 CloakBrowser `[Unreleased]` 变更——headed 启动不再套固定 emulated viewport，页面跟随真实窗口；headless 保持确定性视口。我们核对 `browser-manager.ts` 只传 `--window-size` / `--window-position` / `--force-device-scale-factor`，`screen.*` 由 Chromium patch 0003 固定覆盖，`window.*`（inner/outer/screenX/screenY）理论上跟随真实窗口。本切片用 e2e 实证该自洽性，并归档为回归护栏。

**新增**：
- `tests/e2e/j71-window-geometry.test.ts` — 4 例：headed windows profile 启动；初始几何自洽（inner≤outer≤screen、窗口落屏内）；通过 CDP `Browser.setWindowBounds` 把真实窗口 resize/move 到 1000x700@(60,60)，断言 outer/inner 跟随真实窗口（无固定 emulated viewport 残留）、`screen.*` 保持固定、移动后仍自洽；无意外 console error。

**结论**：默认窗口 1280x800（`min(avail,1280/800)`），resize 到 1000x700 后 `outerWidth` 落在 900-1050、`innerWidth` 跟随且在 outer 内、`screen.*` 不变——headed 窗口几何与上游 v0.3.32 unreleased 对齐点自洽，无需额外 DOM 覆盖补丁。

**验证**：j71 4 例全绿；j1-profile-launch 回归 8 例全绿；全量单测 47 文件 570 例全绿；tsc/build 干净。

### Slice 47 — 启动参数特性集与 stock Chrome 对齐（P1，反检测可信闭环）— ✅

**背景**：上游 CloakBrowser v0.5.3 修了一类 bug——Playwright 默认参数关掉了 stock Chrome 默认开启的 MediaRouter 特性（Windows 字体 profile 场景），导致特性集像测试工具而非真浏览器。我们不用 Playwright、参数是自己拼的，理论上没有这类问题，但此前没有实证护栏。本切片用「pass-through 模式作 stock 对照」做进程级实证：同一二进制、同一版本、同一 trial 状态，只差指纹注入。

**新增**：
- `tests/e2e/j72-launch-args-parity.test.ts` — 6 例：同时启动 managed（windows seed）与 pass-through（`fingerprintMode: off`）两个 profile；读两个 Chromium 进程真实命令行（`ps -ww`，按 ` --` 边界切分，剥离 Chromium 自带的 `--flag-switches-begin/end` 字段试验块）；断言：① managed 无任何 automation/test-harness 痕迹（`--enable-automation`、`--no-sandbox`、`--single-process`、`--in-process-gpu`、`--disable-gpu`、`--disable-dev-shm-usage`、`--headless`、blink-features 开关）；② managed 相对 pass-through 的特性集 delta 恰好等于 `--disable-features=ThrottleMainFrameTo60Hz`（文档化的原生刷新率对齐），不额外 enable 任何东西；③ `MediaRouter` 永不被 managed 禁用；④ pass-through 不带任何 fingerprint 参数（`--user-agent`/`--lang`/`--window-size`/`--window-position`/`--force-device-scale-factor`/指纹配置等）；⑤ managed 保留声明的窗口几何与身份参数；⑥ 无意外 console error。

**结论**：进程级证据确认 managed 启动只比 stock 对照多一项文档化的刷新率设置，其余特性集与 stock Chrome 一致；上游 v0.5.3 那类「特性集偏离 stock」的回归被永久护栏覆盖。

**验证**：j72 6 例全绿；j1-profile-launch 回归 8 例全绿；全量单测 47 文件 570 例全绿；tsc/build 干净。

### Slice 48 — JS SDK（Playwright/Puppeteer CDP drop-in）+ headless 帧驱动修复（P1，开发者集成）— ✅

**背景**：开发者集成一直是评测短板——`browser_*` 暴露浅、没有可一键替换的自动化入口。本切片落地 `sdk/js/agent-browser.mjs`（零依赖 REST client + `connectPlaywright`/`connectPuppeteer`），把「换 import 就能从 Playwright/Puppeteer 驱动带 C++ 级指纹的 profile」变成一行配置。过程中发现并修掉一个底层 bug：headless 模式下 rAF 永不触发。

**根因**：macOS 上 `ExternalBeginFrameSourceMac` 在 `--headless=new` 下仍为物理显示器创建 CVDisplayLink begin frame source（display_id=1），但 headless 进程收不到 vsync 回调 → 不再产 BeginFrame → `requestAnimationFrame` 永不回调、`page.screenshot()` 挂起、Playwright 非 force click 因「元素不稳定」30s 超时。实证：`--enable-features=ForceMacVSyncTimerForDebugging` 一开 rAF 立即恢复（9ms）；stock Chrome 151 headless 走 timer 路径因此正常。

**修复**（Chromium patch，`chromium-build-150` 提交 `494a3398d5`，已留存）：`ExternalBeginFrameSourceMac::SetVSyncDisplayID` 检测到 `--headless` 时销毁 display link，回退到 `DelayBasedTimeSource` 定时器（60Hz）。验证：重建引擎并安装后，headless rAF 首次触发 ~9-256ms、连续帧间隔稳定 16.7ms。

**新增**：
- `sdk/js/agent-browser.mjs` — REST client（/health /version /openapi /profiles /proxies …）+ `connectPlaywright`（`connectOverCDP`）/ `connectPuppeteer`（browserWSEndpoint）+ attach 模式（按 dirId 重连）；无 dirId 时 create+launch，驱动缺失快速失败不留孤儿 profile。
- `sdk/js/example.mjs` / `sdk/js/README.md` — 用法文档。
- `src/main/services/browser-manager.ts` + `rest-api-server.ts` — `POST /api/profiles/{dirId}/launch` 支持 `{ headless?: boolean }`，headless 时加 `--headless=new`（自动化默认 headless，避免无焦点窗口节流 rAF）。
- `tests/e2e/j73-js-sdk-playwright.test.ts` — 4 例：REST 镜像；connectPlaywright 指纹完整（webdriver=false / Windows UA / 1920x1080 / en-US）+ fill/click 端到端；connectPuppeteer 驱动缺失快速失败且无孤儿 profile；attach 按 dirId 重连同端口。

**结论**：headless + 完整指纹配置（`--agent-browser-fingerprint-config`）下 UA / screen / languages 全部伪装生效、Playwright click 稳定通过——JS SDK 作为 Playwright/Puppeteer 的 drop-in 替代闭环打通；headless 帧驱动与 stock Chrome 行为对齐（timer 60Hz）。

**验证**：j73 4 例全绿；j71/j72 回归 10 例全绿；j1-profile-launch 回归 8 例全绿；全量单测 47 文件 570 例全绿；tsc/build 干净。
