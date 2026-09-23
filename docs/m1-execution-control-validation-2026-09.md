# M1：可控执行与运行追踪 — 实现与验证记录

- 日期：2026-09-19。
- 范围：[产品优化方案 M1](product-optimization-plan-2026-09.md#4-m1先让-agent-可控可追踪)；不包含 M2–M4。
- 环境：macOS Apple Silicon，Node 26.8.2，Electron 42.4.0，Vitest 4.1.8。
- 状态：M1 已实现，并通过本报告限定的 macOS 主路径验收；完整单测、目标桌面回归、额外稳定性复跑及弹窗扫检均已通过。
- 工作区：基于包含上一轮未提交可靠性修复的当前源码；未提交或推送，未修改个人 userData、原有 `dist/` 或 `output/`，未安装或升级依赖。

## 1. 交付行为

### 环境边界

- 桌面流式和非流式工具聊天共用执行服务；一次运行固定一个真实托管实例，校验运行表对象、PID、端口及存活状态。
- 选择 A 不能操作 B；伪造非托管端口、停止或被替换的实例不会触发隐式选择或重新绑定。
- 未选择环境时禁止浏览器操作；HTTP、文件和 SQL 能力仍遵守原来的审批、路径和访问边界。
- 环境启动由用户点击独立入口；受限聊天不开放模型启动浏览器、任意页面脚本或创建/删除全局调度规则。
- 工具可见性过滤之外，在实际 CDP/BiDi 发送前再次检查范围和取消状态。

### 取消与生命周期

- 主进程确认取消后不派发新动作；可取消的模型连接、协议准备、浏览器等待和待审批请求实际取消。
- 取消不关闭共享浏览器或共享协议连接。已发出的操作允许返回、落盘，并保留真实结果；不宣称回滚。
- 同会话禁止重叠运行；同请求重用结果，不重复执行；取消和快照核验发起窗口。
- 结束原因区分 `completed / user_cancelled / timeout / round_limit / interrupted / execution_error`。
- `completed` 仅表示执行循环自然结束。业务验收默认 `unverified`，失败或被拒绝的步骤不会自动变成成功。
- 隐藏窗口不取消任务；renderer 销毁/崩溃、真正退出会中断对应任务。连续退出请求不能跳过异步清理。
- 退出等待真实托管浏览器 PID 消失，保留已有 3 秒强制停止升级；默认共享等待上限 5 秒，helper 硬上限 15 秒，超时明确报告未退出 PID。

### 追踪与界面

- 首次模型/工具动作前，用户消息已保存 `runId / requestId`；最终 assistant 关联同一运行。
- run 是结束原因的落盘权威；读取消息时按确切 runId 投影结束原因，不伪装跨文件事务。
- 会话切换、草稿、刷新恢复及晚到事件按请求隔离；恢复不会重新发送任务。
- 聊天显示环境、动作、耗时、停止/正在停止、结束原因与未验收；消息可直达本次运行。
- 审批 FIFO 排队；弹窗区分“拒绝本操作”和“停止本次任务”；停止 A 不清掉 B。
- 运行记录被清理与读取失败分别提示；清理 trace 不删除会话或已写入的 SQLite 结果。

## 2. 验证结果

| 验证 | 实际结果 |
|---|---|
| 主项目 TypeScript `--noEmit` | 通过 |
| 三个 M1 E2E 文件独立类型检查 | 通过 |
| 完整 unit + smoke + coverage | 100 个文件，1042 项通过 |
| 语句 / 分支 / 函数 / 行覆盖率 | 51.31% / 44.76% / 57.84% / 54.25%，现有门槛通过 |
| 隔离源码构建 | 通过，包含本轮生产源码，未覆盖仓库原 `dist/` |
| 目标 Electron E2E | 14 个文件，81 项通过 |
| 生命周期 / 审批队列额外复跑 | 2 轮，每轮 20/20 通过；不计为新增独立用例 |
| 中英弹窗扫检 | 28 个打开，无发现；4 个无程序化 opener 的弹窗跳过 |
| 原生 Go 测试 | 通过（cached，`GOPROXY=off`） |
| i18n / 文件大小 | 通过；未增加大小基线豁免 |
| 根 `i18n.js` 与 renderer 副本 | 一致 |
| `git diff --check` | 通过 |

14 个 E2E 文件为 M1 control、M1 UI、M1 latency，以及 J4/J17/J18/J21/J22/J23/J24/J25/J31/J83 和 reliability-regressions。以上 81 项包含 22 项 M1 测试，不应再相加成新的独立测试总数。

目标 API 回归包含公开端点、无认证保护端点返回 401、有认证合法访问，以及 REST 不能自行批准危险操作。测试使用本地动态端口与 mock LLM，不发送真实业务数据。

### 取消性能

每组 20 个样本；在 renderer 收到真实工具派发事件的同一轮事件处理中点击 Stop。通过真实取消 IPC 测确认时间，通过下一帧读取测界面反馈；同时记录 tool、step、ack 的完整事件时间线并核对磁盘步骤。

| 配置 | 界面反馈 P95 | 主进程取消确认 P95 | 门槛 |
|---|---:|---:|---|
| 小配置，902 → 20,575 字节 | 4.60 ms | 10.90 ms | ≤200 ms / ≤1000 ms |
| 50 MiB 历史，52,428,800 → 52,448,471 字节 | 4.20 ms | 243.30 ms | ≤200 ms / ≤1000 ms |

大配置为真实保留历史形状：150 个运行 × 100 个步骤，每个 result 3219–3220 字符；经真实配置事务写入，预测与物理文件均为 **52,428,800 字节，差值 0**，每条结果低于 16 KiB 上限。

步骤提交事件 P95 分别为 11.20 ms / 243.60 ms。这是包含同步存储与 IPC 的观测时间，不是独立的事件循环 lag 直方图，也不是跨平台或生产负载 SLA。

### 磁盘、重启和退出证据

E2E 不只检查 API 返回值：直接读取 `config.json`、`agent-conversations.json` 和只读打开的 `agent-store.sqlite`，关闭重开后再通过服务读回并按会话/runId 检索。包含强制退出恢复及运行清理后保留消息/SQLite 结果。

本次整批输出摘录：

```text
[m1] direct disk/reopen/search verified: conv_1789814397870_6j7qw,
      interrupted=run_9nrhxh4ra44c, SQLite=m1-searchable
[m1] graceful repeated app.quit: exit=0;
      run_9q5uc6ura9ng interrupted before restart;
      managed PIDs exited=89838; hide did not cancel
Test Files  14 passed (14)
Tests       81 passed (81)
```

真实退出断言在重启前检查终态落盘及原 managed PID 返回 `ESRCH`；重启后再检查环境没有仍在运行，不能靠启动修复或测试 teardown 杀进程冒充优雅退出。

### 视觉与稳定性收尾

已实际查看本轮英文浅色、中文深色 700px 窄窗及真实审批 Stop 截图；单个关闭按钮、整任务停止入口、环境下拉、中文输入提示及溢出断言通过。模型回答、用户内容及原有工具描述保留其原文，不代表翻译了任意动态数据。

额外两轮 control/UI 复跑均为 20/20 通过，分别验证 managed PID 91750、92735 已退出。连同整批结果，当前退出与审批断言共连续通过三轮；这是本机有限样本的稳定性证据，不是所有负载下绝无故障的保证。

最新弹窗扫检打开 28 个弹窗，无发现；`dlg-license / dlg-terms / dlg-confirm / dlg-profile` 因无程序化 opener 跳过。已查看更新后的中英审批截图，关闭按钮不再重叠。真实聊天审批内 Stop 由 M1 UI E2E 另行验证，不能用无 active run 的静态弹窗 fixture 冒充。

## 3. 复验命令与本地证据位置

本轮隔离副本：

```sh
VERIFY=/var/folders/8_/k0tkcx0177b_dqqytbm7r7h00000gn/T/studio-m1-release-o_jgpveb
GOPROXY=off npm --prefix "$VERIFY" run build

./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc --noEmit --module nodenext --moduleResolution nodenext \
  --target es2022 --skipLibCheck \
  tests/e2e/m1-agent-control.test.ts tests/e2e/m1-agent-ui.test.ts \
  tests/e2e/m1-cancel-latency.test.ts

TEMP_ROOT=$(mktemp -d -t studio-m1-coverage-release)
TMPDIR="$TEMP_ROOT/" ./node_modules/.bin/vitest run tests/unit tests/smoke \
  --coverage --coverage.reportsDirectory="$TEMP_ROOT/coverage"

./node_modules/.bin/vitest run --root "$VERIFY" \
  --config "$VERIFY/vitest.config.e2e.ts" --reporter=verbose --disableConsoleIntercept \
  tests/e2e/m1-agent-control.test.ts tests/e2e/m1-agent-ui.test.ts \
  tests/e2e/m1-cancel-latency.test.ts tests/e2e/j4-agent-stream.test.ts \
  tests/e2e/j17-agent-runs.test.ts tests/e2e/j18-agent-db.test.ts \
  tests/e2e/j21-parallel-tool-calls.test.ts tests/e2e/j22-history-repair.test.ts \
  tests/e2e/j23-error-display.test.ts tests/e2e/j24-approval-semantics.test.ts \
  tests/e2e/j25-full-conclusion.test.ts tests/e2e/j31-approval-buttons.test.ts \
  tests/e2e/j83-agent-rest.test.ts tests/e2e/reliability-regressions.test.ts

# 生命周期与审批队列额外两轮复跑（每轮 20 项）。
for pass in 1 2; do
  ./node_modules/.bin/vitest run --root "$VERIFY" \
    --config "$VERIFY/vitest.config.e2e.ts" --reporter=verbose --disableConsoleIntercept \
    tests/e2e/m1-agent-control.test.ts tests/e2e/m1-agent-ui.test.ts || exit $?
done
node "$VERIFY/scripts/visual-dialogs.mjs" --shots --out "$VERIFY/m1-dialog-shots"

GOPROXY=off go -C native/agent-browser-masque-bridge test ./...
npm run check:i18n && npm run check:size
cmp i18n.js src/renderer/js/i18n.js
git diff --check
```

当前本地日志目录（临时产物，清理后不能依赖这些路径复验）：

```text
/private/tmp/claude-501/-Users-ahoo-workspace-roxy-lite-cloak-oss/
  f2855d91-13fc-4ff8-b758-4fde20031fc4/tasks/
  byujapt7k.output  — 隔离 build
  bpgihs620.output  — 100 文件 / 1042 项 unit、smoke、coverage
  bssmpsdfp.output  — 14 文件 / 81 项 E2E、原始延迟样本、磁盘与退出证据
  bonvhqta1.output  — 两轮 20/20 稳定性复跑、中英弹窗扫检
```

本轮覆盖率报告目录：`/var/folders/8_/k0tkcx0177b_dqqytbm7r7h00000gn/T/studio-m1-coverage-release.lTeQMnrea7/coverage`。

## 4. 已修问题与验证口径

- 真实审批拒绝返回 `skipped: true`，原先被误记为步骤成功：先写流式/非流式两个红测，再将该结果按未成功记录，真实 UI 与磁盘核对通过。
- 修复刷新后的 Enter 事件绑定、非 Element 事件目标异常、晚到事件复活任务、终态刷新丢步骤及另一会话迟到校验覆盖当前控件。
- 修复协议准备不可取消、load wait 丢失本次 dispatch guard、取消缓存探测误关共享连接。
- 修复真正退出过早结束主进程、使浏览器三秒升级 timer 丢失的问题，改成观测实际 PID 的有界等待。
- 收口时旧 smoke test 固定匹配同步 `stopAllBrowserProfiles()`，已改为约束 await 聊天、await 浏览器退出和清理完成的顺序；真实行为另由假进程单测和真实 PID E2E 验证。
- 修正两处测试时序假设：先等第二项审批事件渲染，再断言 FIFO；已派发步骤可在取消确认后提交，但必须在终态前如实记录。**确认后零新派发与性能阈值均未放宽。**

## 5. 明确未验证与非目标

- 未运行完整历史 Electron journeys；本报告只覆盖列出的 14 个目标文件及完整 unit/smoke。
- 未验证 Windows/Linux 安装包、签名发布包或真实 Firefox 桌面 E2E；BiDi 发送边界有单元测试。
- 未运行 Docker；本轮没有修改 `.env.example`、`docker-compose.yml` 或 `.dockerignore`，桌面验证不代表容器验证。
- LLM 为本地可控 mock，未测真实云模型任务成功率、业务验收准确率或生产性能。
- 未实现 M2 成果存储/导出/验收器、M3 调度通知、M4 首跑引导，也未扩展为 REST/MCP 多租户 RBAC 重构。
