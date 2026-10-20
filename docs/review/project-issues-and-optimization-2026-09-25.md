# Agent Browser Studio 项目问题清单与优化建议

- 日期：2026-09-25。
- 代码基线：`main` / `2bcd9fe`（Studio 2.0 Phase 5）。下文源码行号均对应此基线，后续可能漂移。
- 范围：对项目评估中提出的权限、执行终态、结果恢复、跨平台测试、UI 回归与文档问题进行复核，并提出后续实施建议。
- 性质：**复核快照与优化方案，不是已完成的修复报告，也不授权自动实施或发布。**
- 状态入口：[问题追踪表](issue-tracker.md#review-20260925) 是唯一权威状态表；本文保存证据、结论边界和验收标准，不另建一套实时状态。
- 相关资料：[产品优化方案](../product-optimization-plan-2026-09.md)、[M1 验证记录](../m1-execution-control-validation-2026-09.md)、[M2 验证记录](../m2-verifiable-results-validation-2026-09.md)。历史验收报告按当时日期与范围理解，不追溯改写。

## 1. 执行摘要

项目已具备实际可用的浏览器配置管理、Agent 工具执行、运行记录、成果存储与导出能力。本轮优先事项不是继续扩展功能面，而是统一入口权限、确保终态与验收结论真实，以及让跨平台发布验证可以真正执行。

复核后应保留的关键判断：

1. **数据库写入 IPC 与 REST 的角色限制不一致，已验证 viewer 能写入实际 SQLite。**
2. **REST/MCP 在空回复和达到工具调用轮数上限时，会报错但将 run 持久化为 `done`。**异常抛出的模型 HTTP 500 路径则正确记为 `error`。
3. **M2 在配额不足导致成果截断后，manifest 与 config 的验收结论可能不同；恢复时可回放过时的 `passed`。**这是已复现的边界缺陷，不是正常运行普遍失败的证据。
4. **Windows/Linux E2E 使用固定 macOS Electron 可执行路径。**源码与工作流存在明确不匹配，但本轮没有在这两个平台上实测。

需要收窄或更正的判断：

- viewer 能修改本机启动安全开关已复现，但这些开关不在团队同步快照中；是否属于越权，需先明确产品权限约定。
- Phase 5 并非没有测试覆盖；已有真实 renderer 和 sanitizer 测试。缺口是新增交互的定向断言，以及部分旧测试镜像与生产逻辑不同步。
- 产品方案首页的里程碑状态过时；不同日期的 M1/M2 历史验收报告并不相互矛盾。
- 超长模块属于维护债务，不能仅凭行数认定为功能缺陷。

## 2. 优先级与证据口径

### 2.1 建议优先级

- **P1：优先修复。**涉及已有权限承诺、错误的执行记录，或目标平台的发布验证阻断。
- **P2：后续可靠性与质量完善。**有特定条件的结果恢复缺陷、测试门禁缺口和文档状态整理。
- **P3：持续维护。**在行为不变的前提下，逐步降低模块耦合和维护成本。
- **决策项：先定约定再改实现。**不把尚未明确的产品策略当作已证实漏洞。

这里的优先级是建议的工作顺序，不是 CVSS 分数。本轮未确认新的远程未认证攻击链，也没有据此提出 P0 结论。

### 2.2 证据层级

| 标记 | 含义 | 不代表什么 |
|---|---|---|
| 动态确认 | 实际执行目标代码并核验可观察结果 | 不自动等于完整 GUI E2E 或跨平台验证 |
| 静态确认 | 路径、配置或控制流已有确定证据 | 不宣称已经在目标环境复现 |
| 条件性 | 行为已观察到，但策略或触发条件需要限定 | 不按无条件漏洞处理 |
| 质量/维护项 | 测试、文档、模块组织需要改善 | 不等同于产品功能已经出错 |

## 3. 问题总览

| 编号 | 问题 | 分类与结论 | 建议优先级 |
|---|---|---|---|
| [R0925-01](#r0925-01) | viewer 经数据库 IPC 可写，REST 设有角色门禁 | IPC 写入动态确认；REST 门禁静态确认 | P1 |
| [R0925-02](#r0925-02) | REST/MCP 空回复或轮数上限被记录为 `done` | 终态正确性；动态确认 | P1 |
| [R0925-03](#r0925-03) | 截断成果的旧验收结论在恢复时被回放 | 数据一致性；边界场景动态确认 | P2 |
| [R0925-04](#r0925-04) | 跨平台 E2E 固定使用 macOS Electron 路径 | 测试启动阻断；静态确认 | P1，Windows/Linux 发版前 |
| [R0925-05](#r0925-05) | viewer 可修改本机启动安全开关 | 写入已确认，是否越权待权限约定 | 决策项 |
| [R0925-06](#r0925-06) | Phase 5 新交互缺定向断言，旧 Markdown 镜像漂移 | 测试质量项，不是完全无覆盖 | P2 |
| [R0925-07](#r0925-07) | 视觉审计允许缺失 fixture，弹窗默认只检查首个主题 | 质量门禁缺口 | P2 |
| [R0925-08](#r0925-08) | 当前里程碑状态与验收证据入口不同步 | 文档/交付管理项 | P2 |
| [AR-2](#ar-2) | 核心模块过长、跨入口逻辑易漂移 | 既有维护项，沿用原编号 | P3 |

## 4. 问题详情与优化建议

<a id="r0925-01"></a>

### R0925-01：数据库 IPC 未执行与 REST 相同的角色门禁

**事实与影响**

启用团队、当前本机成员为 viewer 时，`requireSettingsMutation()` 返回拒绝，但 `agent-db:exec` 仍能执行写入 SQL。用户可通过本机应用的数据库写入入口改变数据，违背 REST 对同一操作施加的角色限制。

关键位置：

- [IPC handler](../../src/main/ipc/agent.ts#L462-L470)：直接调用 `agentDbExecScript`。
- [数据库执行服务](../../src/main/services/agent-db.ts#L129-L136)：使用可写连接，不补角色检查。
- [preload 映射](../../src/main/preload.cjs#L274-L279)：向 renderer 暴露 `exec`。
- [REST 对照](../../src/main/services/rest-api-server.ts#L1310-L1319)：先调用角色门禁再执行。
- [团队权限模型](../../src/main/services/team.ts#L1-L9)：明确为本地 best-effort，不是服务端 ACL。

**已取得的证据**

```text
team.enabled=true; role=viewer
requireSettingsMutation() -> {ok:false, error:"requires member role (current: viewer)"}
agentDb.exec -> {ok:true}
SQLite direct read -> [{v:"write_by_viewer"}]
service query -> count=1; tableFound=true
```

探针运行真实 preload 脚本、已注册 handler 与存储服务；Electron 的 `contextBridge`、`ipcRenderer` 和路径接口使用隔离替身。测试后另用独立 Node 进程直读 SQLite。REST 的角色门禁由源码控制流确认，本轮未发送 viewer 身份的 REST 写入请求。**不是完整真实窗口 IPC E2E，也不证明跨设备远程调用能力。**

**优化建议**

1. 在 IPC 写入前施加与 REST 相同的 `requireSettingsMutation()` 门禁，拒绝后不得触及数据库。
2. 将“面向用户入口的数据库写操作”集中到共享授权入口，避免 IPC/REST/MCP 各自复制策略。
3. 不宜直接在所有底层 SQL 原语上增加本机角色检查；模板验收、内部存储等调用需明确授权上下文，避免误伤内部业务流程。

**验收标准**

- 团队 viewer 经真实 UI/preload/IPC 写入被拒绝；REST 同样拒绝；数据库记录和 schema 均不变。
- member/admin/owner 及团队未启用模式的预期写入仍可成功；执行写入、直接查库、服务读回、重开检索的完整验证链。
- 拒绝写入不影响允许的只读查询；错误能被现有界面正确显示，不只隐藏写按钮。

<a id="r0925-02"></a>

### R0925-02：REST/MCP 错误结果与运行终态不一致

**事实与影响**

两个入口都先执行 `finishRun(run.id, "done")`，之后才检查 `result.error` 和最终回复是否为空。达到轮数上限或空回答时，调用方收到失败，运行历史却保存为 `done`，影响状态查询与后续自动化判断。

位置：[REST](../../src/main/services/rest-api-server.ts#L1229-L1253)、[MCP](../../src/main/services/mcp-server.ts#L413-L435)。

**已取得的证据**

使用当前源码的隔离编译产物，在真实 Electron 主进程启动 REST/MCP，模型请求仅访问本地动态端口 fixture。每个入口各验证四种情况：

| 场景 | REST | MCP | 实际落盘 run.status |
|---|---|---|---|
| 正常回答 | HTTP 200 | 正常结果 | `done`，正确 |
| 模型 HTTP 500 | HTTP 400 + error | `isError=true` | `error`，正确 |
| 空回答 | HTTP 400 + error | `isError=true` | **`done`，错误** |
| 25 轮工具调用后达到上限 | HTTP 400 + error | `isError=true` | **`done`，错误** |

错误的轮数上限记录实际带 25 个步骤，但没有 `endReason`。直接检查物理配置、服务 reload，再退出并启动新的 Electron 进程，按会话与 runId 检索，错误状态仍存在。业务验收保持 `unverified`，不能把这个问题描述为业务验收被改成 `passed`。

**优化建议**

1. 先归类返回值、最终回复和异常，再一次性提交正确终态；失败时不要先发出 `done` 事件。
2. 轮数上限记为 `error/round_limit`；空最终回复记为 `error/execution_error`；自然结束记为 `done/completed`；保留超时、取消等已有具体原因。
3. 抽取共享的结果归类逻辑，统一桌面、REST、MCP 的生命周期含义，但不要顺带改变各入口的浏览器授权范围。
4. 保持现有协议兼容：MCP 的工具失败通过 `isError` 表达，不要求它改成 HTTP 400。

**验收标准**

- 上表四种情况在 REST/MCP 均有真实服务回归；再补超时与终态写入失败场景。
- API 结果、运行事件、磁盘状态、结束原因相互一致；失败不先广播成功终态。
- 重启后按 conversationId/runId 仍读到相同状态；有效步骤不得因失败而被抹掉。
- 业务验收与执行终态继续分层，不把 `completed` 自动变成 `passed`。

<a id="r0925-03"></a>

### R0925-03：截断成果与 manifest 的验收结论不一致

**事实与影响**

自动化将截断前的 `outcome.verification` 提交给成果存储；只有提交返回后，才依据 `artifact.truncated` 将 config 中的结论降为 `manual_review`。因此 manifest 可保存 `passed`，而 config 保存 `manual_review`。恢复时若回放 manifest，就可能把不完整的成果重新标为通过。

关键位置：

- [自动化 finalize](../../src/main/services/automation.ts#L310-L347)。
- [全局剩余容量与截断预算](../../src/main/services/run-result-store.ts#L338-L349)。
- [manifest 提交](../../src/main/services/run-result-store.ts#L408-L438)。
- [终态重放与引用回补](../../src/main/services/agent-run-trace.ts#L459-L485)。

**已取得的证据与边界**

探针使用真实 verifier、SQLite、成果 store、config 和 recorder；LLM、浏览器、job store 及 Electron 外壳为替身。未修改默认 512 MiB 全局、8 MiB 单 run 配额；用稀疏文件模拟全局仅余 16,384 B：

```text
SQLite: 100 rows
persisted dataset: 34 rows, truncated=true
manifest.verification: passed
config.verification: manual_review
readManifest: accepted
```

通过 `reloadConfig()` 与 `reconcileRunResults()` 模拟重启恢复路径，观察到：

- 正常 `done/manual_review` 不被覆盖，这是有效对照。
- 已收尾为 `interrupted/manual_review` 的记录，被回放为 `passed`；该场景不需要模拟 crash。
- 模拟 manifest 已提交、`finishRun` 尚未提交的崩溃窗口，也恢复为 `passed`。

**这是单进程内的存储/恢复集成测试，不是实际重启 Electron，也没有强制杀进程。**物理文件与服务读回已核验；真实退出/重启仍应纳入修复验收。

默认容量下的自然触发路径尚有条件：另一个大结果探针在模板 `limit=100` 时实际写入 1000 条有效但超额、序列化体积很大的数据，保存下 829 行，含 manifest 约 8.38 MB。由此推算，多次过量输出可能在 200-run 保留上限前挤压全局余量。**本轮未实际累积填满 512 MiB，也没有证明遵守正常条数上限的常规运行会耗尽配额。**

**优化建议**

1. 在 manifest 提交前依据实际保存结果确定最终 verdict，向 config 返回同一 verdict，避免两处独立决定。
2. 读取旧 manifest 时，对“截断且仍声称通过”的证据保守降级，不用有效哈希代替语义一致性检查。
3. 收窄终态重放条件，不覆盖已经成功提交的 `interrupted/manual_review`；也不能因此阻断真正未完成 config 提交的恢复。
4. 用明确的提交身份/状态判定恢复，而不是仅依赖 `endReason === "interrupted"`；若需要 schema 变更，应单独设计兼容路径。

**验收标准**

- 无配额压力、单 run 截断、默认全局余量不足分别验证。
- manifest、config、预览与导出说明中的 verdict/completeness 一致；截断证据不恢复为 `passed`。
- 覆盖正常 done、正常 interrupted、manifest/config 提交间故障、缺失引用回补；多次对账应收敛，不反复重放已处理终态。
- 真实进程重开后直接查 SQLite、读取 manifest/dataset、服务读回与按 runId 检索；拒写不得损坏已有成果。

<a id="r0925-04"></a>

### R0925-04：跨平台 E2E 固定使用 macOS Electron 路径

**事实与影响**

[共享 E2E helper](../../tests/e2e/helpers/app.ts#L68-L78) 固定拼接 `Electron.app/Contents/MacOS/Electron`；普通和 headless launcher 都使用该路径。E2E 配置包含相应测试，Windows/Linux 的 [engine-verify 工作流](../../.github/workflows/engine-verify.yml) 也会运行它们。

标准 Windows/Linux 安装布局中该路径不存在，构成测试启动阻断。独立 launcher 也需要检查，例如 [journey](../../tests/e2e/journey.test.ts) 与 [J81](../../tests/e2e/j81-ui-storage-partition.test.ts)。

这是静态确认，**不是本轮实际运行 Windows/Linux CI 后得到的失败记录，也不等于桌面应用无法跨平台运行。**

**优化建议**

1. 统一解析 Electron 可执行路径，优先使用安装包提供的路径解析机制；所有测试 launcher 复用，避免各处拼接平台目录。
2. 在耗时引擎构建之前增加轻量 launcher smoke，尽早发现路径与进程启动错误。
3. 核查 Windows npm 脚本的 shell 行为：即使 workflow 的独立构建步骤用 bash，`test:e2e` 仍会再次调用 `npm run build`。
4. 区分“无引擎而跳过”和“实际通过”，发布证据记录真实执行数量；与既有 PM-1/PM-8 发布门槛关联。

**验收标准**

- macOS、Windows、Linux 分别验证实际二进制存在、成功启动 Electron、加载主窗口、完成一个 IPC 往返并退出。
- 相关应用 E2E 能在各目标 runner 执行，而非仅平台路径单测通过。
- 打包安装 smoke 单独验证；不得用开发模式启动代替安装包验收。

<a id="r0925-05"></a>

### R0925-05：本机启动安全开关的 viewer 权限约定不明确

**确认的行为**

viewer 可以调用 [settings:launch-gates:set](../../src/main/ipc/settings.ts#L36-L44) 修改四项启动安全开关；实际 config 落盘和 reload 读回均成功。

**不能直接判定越权的原因**

这些开关没有进入 [团队同步快照](../../src/main/services/sync-service.ts#L1311-L1325)。现有“共享配置须 member+”的描述，不足以独立证明本机安全开关也必须只读。

**建议的产品决策**

建议明确区分：界面偏好可由 viewer 调整；影响启动安全策略的开关要求 member+。这是建议，而非现有已批准约定。若产品决定允许 viewer 修改本机安全开关，应明确记为本机设置例外，避免 UI 或文档作出相反承诺。

本地角色门禁不能升级表述为不可绕过的企业安全策略；真正的组织强制策略需要独立的权威端与威胁模型设计，不在本轮默认实施范围。

**验收标准**

- 明确字段范围、角色矩阵和团队启用/停用时的行为。
- 若禁止修改：真实 IPC 拒绝，四项物理值保持不变；若允许：增加明确的允许用例与说明。
- 策略测试与语言、主题等无关本机偏好分开，避免笼统禁用所有设置。

<a id="r0925-06"></a>

### R0925-06：新增聊天交互缺定向回归，旧 Markdown 测试镜像漂移

**事实与反证**

HEAD 的九个改动文件中没有测试文件，但既有 [renderer M1 测试](../../tests/unit/renderer-agent-m1.test.ts) 会运行真实 `agent-chat.js`，[sanitizer 测试](../../tests/unit/markdown-sanitize.test.ts) 会提取实际源码。因此不能声称“Phase 5 完全没有测试覆盖”。相关三个测试文件定向运行 36 项通过。

实际缺口：

- 新的消息复制、composer 自动增高、代码块操作及 SQL 快捷键缺少相应的定向行为断言。
- [chat-markdown.test.ts](../../tests/unit/chat-markdown.test.ts#L1-L25) 镜像旧式 sanitizer，并设 `breaks:true`；[生产 core.js](../../src/renderer/js/app/core.js#L588-L703) 使用不同的清理逻辑、`breaks:false` 及代码块包装。

**优化建议与验收标准**

- 测试实际模块或抽取共享纯逻辑，减少在测试里复制生产实现。
- 消息重绘后仍复制正确消息；clipboard 失败显示失败而非成功状态。
- 输入、发送清空、草稿恢复均正确调整高度；长文本有高度上限。
- 代码块复制不包含按钮文案；恶意 HTML 仍被转义/清理。
- SQL 的 Ctrl/Cmd+Enter 与 Run（查询）按钮共用只读路径，不触发 Execute(write/DDL)；覆盖空库首次进入后的快捷键绑定及查询错误反馈。
- 使用故障注入或反向验证确认关键断言会在行为破坏时失败；补中英文与窄窗口真实交互检查。

<a id="r0925-07"></a>

### R0925-07：视觉审计的 fixture 与主题覆盖不足

**事实**

- `agent.activeRun()` 没有明确 fixture，mock 会以兜底值响应；[visual-shot](../../scripts/visual-shot.mjs#L1240-L1252) 打印 `unstubbed` 数量，但失败总数不包含该项。
- [visual-dialogs](../../scripts/visual-dialogs.mjs#L238-L240) 虽解析默认 `light,dark`，实际仅对 `THEMES[0]` 执行中英文检查。
- 本轮之前的页面/弹窗审计通过，不能据此称为所有主题、所有真实运行状态均已验证；纯截图采集也不等于带断言的视觉门禁。

**优化建议与验收标准**

1. 为 `agent.activeRun()` 补符合真实契约的无任务、运行中与取消中 fixture。
2. 新增未 stub 的实际 API 调用应让 CI 失败；必要例外显式列出原因和有效期，而非全部静默放行。
3. 弹窗审计遍历主题×语言组合，分别报告打开、跳过和发现数量。
4. 故意移除一个 fixture、注入一个 dark-only 缺陷，确认命令返回非零；无浏览器时显式报告跳过，发布门禁不得把跳过当作通过。
5. 保留 Electron 真实审批/运行流程验证，mock 视觉检查不替代后端行为验收。

<a id="r0925-08"></a>

### R0925-08：里程碑当前状态与验证证据入口不同步

**事实**

[产品优化方案首页](../product-optimization-plan-2026-09.md) 仍写“M2–M4 未实施”；当前已有 M2 验证报告及 M3 实现、单测与 [M3 E2E 文件](../../tests/e2e/m3-scheduling-notifications.test.ts)。本轮未找到独立 M3 验收结果文档，也未重跑其完整 E2E。

M1、M2 报告是不同日期和范围的历史记录，本身不矛盾。有 M3 代码和用例也不等于所有 M3 验收门槛已经通过。

**优化建议与验收标准**

- 产品方案首页维护带日期的当前状态，分别列出“已实现”“已验证平台/范围”“未验证”并链接证据。
- M3 补独立验收记录，逐项对照其状态、重排、通知去重、恢复与目标平台要求；不足项明确保留，不补写无证据的成功声明。
- 保留历史 M1/M2 报告原始范围，通过当前索引链接到后续记录。
- 本文与追踪表相互链接；后续修复状态只在追踪表维护，关闭条目必须附提交和验证证据。

<a id="ar-2"></a>

### AR-2：超长模块与跨入口重复逻辑（沿用既有条目）

文件大小检查通过，但有八个超过 1500 行的模块属于允许的历史基线，例如 `local-agent.ts`、`browser-manager.ts`、`config-manager.ts` 和 `rest-api-server.ts`。这说明结构性维护成本仍在，不证明这些文件各自存在缺陷。

**优化建议**

- 先围绕本轮真实问题抽取权限决策、聊天终态归类和成果提交契约；不要为了行数目标一次性大拆分。
- 每个切片保持导出接口和对外行为稳定，同时删除重复实现并增加契约测试。
- 不通过新增大小豁免来代替拆分，不在可靠性修复中顺带迁移 UI 框架或全量存储。

**验收标准**

现有回归持续通过，新抽取边界有直接测试，重复判断减少，相关文件不继续无约束膨胀。详细排期沿用追踪表 AR-2，不新建重复维护任务。

## 5. 建议实施顺序

| 批次 | 范围 | 交付边界 |
|---|---|---|
| A：权限与终态 | R0925-01、R0925-02 | 两个可独立评审的修复切片；先补能在当前实现上失败的回归，再改代码 |
| B：跨平台测试启动 | R0925-04 | 统一 launcher、平台 smoke、实际 runner 证据；可与 A 并行，Windows/Linux 发版前必须完成 |
| C：成果一致性 | R0925-03 | 统一最终 verdict、兼容旧 manifest、恢复幂等性；不顺带重构全部存储 |
| D：测试与文档 | R0925-06、R0925-07、R0925-08 | 新交互断言、严格视觉门禁、当前里程碑证据入口 |
| 独立决策 | R0925-05 | 明确本机安全设置的角色约定后，再决定实现与排期 |
| 持续维护 | AR-2 | 随上述问题按职责抽取，不以大规模重构阻塞具体修复 |

不在人员投入、目标 runner 与签名条件未知时承诺日历工期。本轮不默认包括组织级远程权限体系、新业务模板、通用断点续跑或全量架构迁移。

## 6. 修复完成与关闭问题的统一门槛

- **代码与构建：**受影响测试、完整 unit/smoke、类型检查、隔离完整构建和相关静态门禁通过；跨平台条目必须补目标平台验证。
- **权限与 API：**公开端点无认证可访问，保护端点无认证返回 401，合法授权按契约成功，角色不足被拒；真实前端/IPC 路径不能被服务单测替代。
- **数据：**执行写入 → 直接查询 SQLite/读取 JSON 与成果文件 → 关闭重开 → 服务读回 → 按 runId/会话/条件检索；拒绝和写失败场景确认原数据不变。
- **UI：**中英、浅深主题、窄窗口、键盘、空态和错误态按受影响范围检查；mock 和实际 Electron 流程分别记录。
- **失败与跳过：**显示实际命令、结果和跳过原因；测试通过不掩盖未测平台、mock 限制或日志异常。
- **追踪：**在问题追踪表附修复提交、永久回归测试路径与验证证据后才能标记已收口。

## 7. 本轮证据清单与复验说明

### 7.1 已执行结果

下列批次独立记录，不将历史测试数与本轮探针简单相加为新的“完整套件”成绩。

| 批次 | 实际结果 | 范围限制 |
|---|---|---|
| 初次评估的类型检查 | `tsc --noEmit` 通过 | 不等于完整打包 |
| 初次评估的 unit/smoke | 115 文件、1348 项通过 | 输出有连接失败、SQLite 及 locale 信息，未逐条归因；不声称日志零错误 |
| 初次评估的 i18n/size/diff | 通过；8 个超长模块在基线内 | 大小门禁通过不等于技术债已消除 |
| 初次评估的视觉检查 | 系统 Chrome；29 个弹窗打开、4 个跳过；标签页审计 PASS、1 个 unstubbed | mock 页面；不是完整 Electron 业务 E2E；弹窗默认仅首个主题 |
| 复核的隔离编译 | 当前 TypeScript 编译到临时目录成功 | 未运行资源 staging、原生构建或打包 |
| 聊天终态探针 | REST/MCP 各 4 场景，共 8 场景验证；另起 Electron 进程读回同 8 条记录 | 真实 Electron 主进程服务，无完整 GUI；模型为本地 fixture |
| 权限探针 | 1 文件、2 项通过，另用 Node 直读 SQLite/config | 真实 preload/handler/service，Electron 通道为替身 |
| M2 成果探针 | 1 文件、5 项通过 | 真实存储与验收器；容量故障注入；以 reload/reconcile 模拟恢复 |
| renderer/Markdown 定向回归 | 3 文件、36 项通过 | 不代表所有新增交互已有断言 |

**探针通过表示成功证实预期的现存行为，其中包括错误行为，不表示缺陷已修复。**聊天自制探针首次因入口顶层等待启动时序而超时，调整探针后完成上述验证；新进程读回还出现一条 macOS Keychain 非交互警告，未导致数据断言失败，不能据此声称完整桌面启动日志干净。

### 7.2 临时证据位置

以下是复核时的本机临时目录，不是仓库资产，也不是长期可用的 CI 依赖。清理后路径可能失效；探针内有本机源码绝对路径，不能保证在另一台机器直接运行。修复时应将相应测试意图转为仓库内的永久回归，而不是提交这些目录中的运行数据。

| 证据 | 位置 |
|---|---|
| 聊天服务探针 | `/tmp/studio-chat-review.E66gy0/probe.mjs` |
| 聊天结构化结果 | `/tmp/studio-chat-review.E66gy0/evidence.json` |
| 聊天新进程读回 | `/tmp/studio-chat-review.E66gy0/reopen.mjs` |
| 权限探针 | `/tmp/ipc-viewer-check.1Rr4P1cS/viewer-ipc.test.ts` |
| 权限物理数据 | `/tmp/ipc-viewer-check.1Rr4P1cS/userdata-fresh/` |
| M2 截断/恢复探针 | `/tmp/m2-verdict-review.Il7Zqm/verdict.test.ts` |

下面两条聊天命令是**历史执行记录，不应在原目录重复运行**。原探针复用固定 `userdata` 并覆盖 `evidence.json`，而重开脚本按标题查找会话，重复运行可能命中旧记录。重新验证时，应使用新的隔离目录、当前源码的隔离编译产物，并按本次明确的 conversationId/runId 读回；旧编译产物不能证明修改后行为正确。

```sh
# 历史执行命令，仅记录本次 macOS 验证；勿在原目录复跑。
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /tmp/studio-chat-review.E66gy0
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /tmp/studio-chat-review.E66gy0/reopen.mjs
```

在原复核机器、原临时脚本仍存在时，可从仓库根目录参考以下权限与 M2 复验命令。权限探针必须使用其隔离目录下的新 userData；M2 探针会清理 `M2_PROBE_ROOT` 指定目录，**不得指向个人数据**。

```sh
# 权限复验：创建新目录，避免与已有固定表名冲突。
PROBE_USERDATA=$(mktemp -d /tmp/ipc-viewer-check.1Rr4P1cS/userdata-rerun.XXXXXX)
TMPDIR=/tmp/ipc-viewer-check.1Rr4P1cS/tmp PROBE_USERDATA="$PROBE_USERDATA" \
  ./node_modules/.bin/vitest run \
  --config /tmp/ipc-viewer-check.1Rr4P1cS/vitest.config.mjs \
  --reporter=verbose --silent=false

# M2 复验：仅使用新建的临时数据根目录。
M2_PROBE_ROOT=$(mktemp -d /tmp/m2-verdict-review.Il7Zqm/userdata-rerun.XXXXXX)
TMPDIR=/tmp/m2-verdict-review.Il7Zqm/tmp M2_PROBE_ROOT="$M2_PROBE_ROOT" \
  ./node_modules/.bin/vitest run \
  --config /tmp/m2-verdict-review.Il7Zqm/vitest.config.mjs --reporter=verbose
```

### 7.3 尚未执行或不能外推的验证

- 本轮未重跑完整历史 Electron E2E、完整 M3 E2E，也未做全部功能的人工 GUI 走查。
- 未验证 Windows/Linux 实机、安装包、签名/公证、Docker 或远端 CI 当前结果。
- 未调用真实云模型，不能据本地 fixture 判断真实模型的业务成功率。
- 未用真实强制退出复现 M2 窗口，也未自然累计填满 512 MiB 成果存储。
- 权限测试未启动真实 renderer 窗口，不能替代修复后的完整 IPC E2E。
- 本轮只形成问题与优化建议；代码修复、发布以及外部操作均未执行。
