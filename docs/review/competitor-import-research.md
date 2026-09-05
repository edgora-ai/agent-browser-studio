# A4 竞品数据导入可行性调研（只做调研，未写代码）

> 方法：WebSearch 查五家公开文档/博客/逆向文章；我方字段以 repo 内实际代码为准
> （`config-manager.ts`、`browser-manager.ts`、`types.ts`）。
> 无官方口径处均标注"未找到公开资料"，不虚构链接。

## 0. 我方数据模型（导入目标，代码为准）

- 每个 profile 是一个目录 `getProfilesDir()/dirId`，内含 `Default/`，启动参数
  `--user-data-dir=<profileDir>`（标准 Chromium user-data-dir，可直接承载
  cookies / Local Storage / IndexedDB 文件拷贝）。
- 配置载体为 `config.json`（`MgmtConfig`，`storeTransact` 原子写）。
- 代理命名绑定：`cfg.proxies: Record<name, ProxyConfig>` +
  `browserProfiles[dirId].{proxyMode: none|default|named, proxyName}`。
  代理名约束 `/^[A-Za-z0-9_.-]{1,64}$/`。
- `ProxyConfig = { type: http|socks5|socks5h, host, port, username?, password?(加密),
  bypassList?, fallbacks? }`。**不支持 `https`、`ssh`、`socks4`**。
- Cookie 经排队导入（`cdpCookieService.applyQueuedImports` / Firefox 对应服务），
  不必手写 SQLite。

## 1. 五家形态与难度

| 竞品 | 难度 | 关键障碍 |
|---|---|---|
| AdsPower | 中 | `https/ssh` 代理无处去；指纹私有结构仅部分可映射；`.adb`（Chromium 包）可全量拷贝但 `expires_utc` 需 FILETIME→epoch 转换 |
| GoLogin | 中 | **CSV 列头无公开规范**（需容错解析）；`sameSite: no_restriction` 与浮点 `expirationDate` 需归一化；`mode:gologin` 托管代理不可迁移 |
| Dolphin Anty | 低-中（代理+cookie）/ 高（整 profile） | 单行代理文法需解析器（`socks4` 拒绝）；cookie payload 无公开字段表；**无整 profile 导出 schema** |
| Multilogin | 高 | 主导出不含 cookies/书签（多步）；cookie 是字符串化 JSON；55+ masking 指纹不对等；`stealthfox` 粗映射 `engine:firefox` |
| BitBrowser | 低 | `https/ssh` 与 API 提取代理不支持；`browserFingerPrint` 仅四件套但够用；cookie 是 JSON 字符串 |

## 2. 推荐：第一家做 BitBrowser

批量模板列最规整（单文件含名/组/账号/代理）；创建 API 字段明确；代理类型
重叠最大；同为 Chromium user-data，拷贝路径最短。次选 AdsPower。

### BitBrowser → 我方字段映射表

| BitBrowser 字段 | 我方字段 | 转换规则 |
|---|---|---|
| Browser Name | `browserProfiles[dirId].name` | 去空格；空则用 dirId 前 8 位 |
| Group | `tags[]` | 一组一 tag，多组逗号拆分 |
| Platform(URL) | `accounts[].platformUrl` + `appUrl`（可选） | URL 校验 |
| Username + Password + URL | `accounts[]`（密码加密存，`profileIds:[dirId]`） | 无 URL 时只建 profile |
| Proxy Type/Host/Port/user/pass | `proxies[<name>]` + `proxyMode:named` | `http→http, socks5→socks5`；`noproxy→none`；`https/ssh→拒绝` |
| `cookie`（JSON 字符串） | 排队 cookie 导入 | 先 parse；归一化后写入 |
| `browserFingerPrint.coreVersion` | `browserVersion` | 按引擎校验，对不上降 auto + 警告 |
| `ostype/os` | `platform` | PC/Win→windows，Mac→macos，Android→android |
| ID 列 | 仅幂等键 | 重导去重/更新 |

## 3. 风险

只迁移用户经官方导出拿到的数据、不碰他人账号与 DRM/认证绕过，风险可控；
逆向私有格式、大规模代管他人账号或违反竞品 ToS/网站反机器人条款则可能
违约乃至违法，须先经法务确认。

## 4. 未找到公开资料清单

GoLogin CSV 列头；Dolphin 整 profile schema 与 cookie payload；BitBrowser 指纹列
明细；AdsPower 官方目录结构；Multilogin cookie 单字段表。除 BitBrowser/AdsPower
外，其余首版只能做部分导入。
