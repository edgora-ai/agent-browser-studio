# PM-6 Cloak 双品牌移除计划（deprecation 下个版本执行）

> 决策：下个版本移除。存量 42 行（src 20 文件）+ scripts 1 + tests/docs 若干。
> 原则：先删运行时别名（IPC/header/MCP），再删 env 兼容，最后删迁移垫片。
> 每批独立 PR，CI 全绿才合；删完跑 `grep -rni cloak` 归零（允许 `cloakserve #352` 上游引用注释）。

## 第一批：运行时别名（行为变更，需发版说明）

| # | 位置 | 内容 | 移除方式 |
|---|---|---|---|
| 1 | `src/main/ipc/browser.ts:64` | `cloak:${action}` IPC 兼容别名 | 删除该行 handler 注册 |
| 2 | `src/main/services/browser-manager.ts:1273` | `cloak:exited` 事件发送 | 删除该行（保留 `browser:exited`） |
| 3 | `src/main/services/http/auth.ts:6` | `x-cloak-token` header 兼容 | 只保留 `x-agent-browser-token` |
| 4 | `src/main/services/mcp-server.ts:42,46,203-204,576` | `cloak_*` 工具别名 | 删除别名分支，保留 `agent_browser_*` |
| 5 | `src/main/services/rest-api-server.ts:1413` | `CLOAK_API_*` 相关 | 与 #6 同批确认后删除 |

回归：`tests/unit/mcp-rbac.test.ts`、`tests/e2e/j54-rest-api.test.ts` 相关别名用例同步删除；grep 确认无调用方。

## 第二批：env 兼容变量（需文档同步）

| # | 位置 | 内容 |
|---|---|---|
| 6 | `rest-api-server.ts:70,82` | `CLOAK_API_TOKEN` / `CLOAK_API_PORT` |
| 7 | `server-mode.ts:12,25` | `CLOAK_HEADLESS` |
| 8 | `update-manager.ts:63` | `CLOAK_UPDATE_MANIFEST` |
| 9 | `masque-socks-bridge.ts:51` | `CLOAK_MASQUE_BRIDGE_PATH` |
| 10 | `native-chromium-manager.ts:18` | `CLOAKLITE_CHROMIUM_CACHE_DIR` |
| 11 | `scripts/sync-native-browsers.mjs:62` | `CLOAKLITE_CHROMIUM_CACHE_DIR` |

回归：USER_GUIDE env 章节同步删除；CHANGELOG Breaking 段声明。

## 第三批：迁移垫片（最后删除，需确认无存量用户）

| # | 位置 | 内容 |
|---|---|---|
| 12 | `branding.ts:13-15` | `LEGACY_PRODUCT_NAME/DIR/CACHE` 常量 |
| 13 | `legacy-data-migration.ts` | 整文件（旧目录迁移） |
| 14 | `config-manager.ts` | `cloakBin/cloakProfiles` 读取分支 |
| 15 | `sync-service.ts:33,1217` | legacy sync key |
| 16 | `renderer-storage.ts:34,36,38` | legacy storage keys |
| 17 | `secrets.ts:30` | "CloakLite Safe Storage" 描述 |
| 18 | `wizard.js:53,332` / `init.js:54` / `i18n.js:9` | `cloak-theme`、`cloak-wizard-dismissed`、`cloak-lite-language` |

回归：删除后全新安装 + 存量升级双路径冒烟；`legacy-data-migration` 相关测试删除。

## 不删（非别名）

- `src/main/index.ts:328` `cloakserve #352` 上游引用注释。
- 本文档本身（历史记录）。

验收：`grep -rni "cloak" src scripts --include="*.ts" --include="*.js" --include="*.cjs" --include="*.mjs" | grep -v cloakserve` 输出为空。
