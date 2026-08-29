# Performance Budget（性能预算）

> Review item TE-08. Before this file existed there was no agreed number for
> "fast enough", so every performance claim in the review was unverifiable.
> These are **starting thresholds** — they must be re-calibrated against real
> measurements once observability (TE-01) has collected a baseline.

## 预算表

| # | 场景 | 阈值 | 测量点 | 数据来源 |
|---|---|---|---|---|
| 1 | 应用冷启动到列表可交互 | P50 ≤ 3s | `app.whenReady` → 第一帧 profile 卡片 | `obs:metrics` / `ipc.browser.list` |
| 2 | Profiles 列表首次渲染（200 个 profile） | ≤ 1.5s | `renderProfileList` 起止 | `ipc.browser.list` 耗时 |
| 3 | 单个 profile 冷启动 | P95 ≤ 8s | 点击 Launch → CDP 就绪 | `ipc.browser.launch` 耗时 |
| 4 | 列表刷新（数据无变更） | ≤ 100ms，且 DOM 变更节点数 = 0 | `renderProfileList` 起止 | 渲染签名短路，见代码注释 |
| 5 | 列表类 IPC 往返 | P95 ≤ 500ms | renderer → main → renderer | `ipc.*` 计时 |

超时兜底（review item TE-03，`src/renderer/js/app/ipc.js`）：

| 操作类型 | 超时 |
|---|---|
| launch | 30s |
| stop | 10s |
| detect（漂移 / 环境 / WebRTC） | 20s |
| list | 5s |
| 其他写操作 | 15s |

## 如何测量

1. **本地指标面板**：`api.observability.metrics()` 返回 counters 与每个计时的
   P50 / P95 / max / 最近一次时间。所有 IPC 调用都会自动写入 `ipc.<key>`。
2. **结构化日志**：`<appData>/logs/agent-browser-<date>.log`，每条带
   `traceId`，可把一次 UI 点击和它触发的主进程工作串起来。
3. **诊断包**：渲染层调用 `api.observability.export()`，产出 ≤10MB 的脱敏
   JSON（指标 + 最近事件 + 环境信息）。

## 回归门禁

- 每次发版跑一次固定 fixture（100 / 1000 个 profile）的性能冒烟，输出
  P50/P95 报告。
- 相对上一版回归超过 **10%** 即告警，需要先定位再合入。
- CI 通过 `npm run check` 保证 i18n 与模块体积不退化（不含性能，性能冒烟
  需要真实机型，暂由人工触发）。

## 尚未建立的部分

- 真实基线数据：需要先在目标机型（M 系列 / 16GB）上采集一轮。
- 性能冒烟脚本：依赖 fixture 生成器，尚未实现。
