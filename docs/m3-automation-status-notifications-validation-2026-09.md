# M3 自动化状态与通知 — 实现与验证记录

- 日期：2026-09-26
- 代码基线：`main` 工作区（包含 R0925 复核修复，自动化调度/通知代码自 `8330cba` 起就位）。
- 方案来源：[产品优化方案](product-optimization-plan-2026-09.md) M3 章节；历史状态见 [M1 记录](m1-execution-control-validation-2026-09.md)、[M2 记录](m2-verifiable-results-validation-2026-09.md)。
- 结论：**M3 已实现并通过 macOS 主路径的目标验收**（单元 + 真实 Electron E2E）。Windows/Linux 未实测，不声明支持。

## 1. 范围

M3 覆盖自动化任务的**状态真话**与**终态通知**：

- 规则列表/详情显示真实的调度状态（未来 once 已排期、cron 已排期、非法 cron 如实报错、禁用规则标注为用户禁用、事件触发标注为事件驱动）。
- 过期未执行的 once 任务标记为 missed，可重新安排到新时间；重排拒绝过去时间与 cron 规则。
- 试运行不计入计划的执行结果。
- 终态通知（应用内记录默认保留；系统横幅/声音为显式 opt-in，默认关闭）。
- 配置被外部修改后状态仍如实反映。
- 启动对账（automation-reconcile）与重试语义（automation-retry）。

## 2. 实现位置

- `src/main/services/automation-state.ts` — 调度状态派生。
- `src/main/services/automation-reconcile.ts` — 启动对账。
- `src/main/services/automation-notify.ts` — 终态通知。
- `src/main/ipc/settings.ts` — `settings:automation-notify*` IPC（默认关闭，布尔强转）。
- renderer：`src/renderer/js/app/` 自动化页面（`renderer-automation-m3.test.ts` 直接运行真实源码）。

## 3. 验证证据（2026-09-26 实跑）

### 3.1 单元/集成（真实服务与真实 renderer 源码）

```text
$ ./node_modules/.bin/vitest run \
    tests/unit/renderer-automation-m3.test.ts \
    tests/unit/automation-scheduler.test.ts \
    tests/unit/automation-state.test.ts \
    tests/unit/automation-reconcile.test.ts \
    tests/unit/automation-notify.test.ts \
    tests/unit/automation-retry.test.ts \
    tests/unit/automation-cron-time.test.ts

Test Files  7 passed (7)
     Tests  150 passed (150)
```

### 3.2 真实 Electron E2E（macOS arm64，本机）

```text
$ npm run build
$ ./node_modules/.bin/vitest run -c vitest.config.e2e.ts \
    tests/e2e/m3-scheduling-notifications.test.ts

Test Files  1 passed (1)
     Tests  22 passed (22)   Duration ~11.8s
```

覆盖：未来 once 报已排期且给出真实下次时间、cron 报已排期、非法 cron 如实报错、禁用规则如实标注、事件触发如实标注、外部改配置后仍说真话、过期 once 标 missed 并可重排、重排拒绝过去时间、重排拒绝 cron、试运行不算计划结果、终态通知默认关闭与 opt-in 行为等 22 项。

## 4. 未验证边界

- Windows / Linux 未实测；E2E 跨平台启动路径（R0925-04）已修复但目标 runner 未执行。
- 通知的 OS 级横幅展示在本机以默认关闭路径验证；不同桌面环境的横幅渲染未逐一走查。
- 长周期 cron 的真实跨天触发未做时间加速外的实盘观察。

## 5. 与 M4 的关系

M4（首次业务成功体验/引导）仍为方案，未实施；本记录不构成 M4 的任何验收。
