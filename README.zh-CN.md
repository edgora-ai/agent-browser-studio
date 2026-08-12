# Agent Browser Studio（Agent 浏览器工作台）

> 面向独立补丁 Chromium 引擎的本地优先浏览器 Profile 管理与 AI 自动化控制台。

Agent Browser Studio（Agent 浏览器工作台）是一个自托管 Electron 桌面应用，用于在授权场景下管理隔离的 Chromium profiles、代理、浏览器状态、AI 辅助工作流、durable automation jobs、审计轨迹和 S3 兼容同步。

**语言:** [English](README.md) | [简体中文](README.zh-CN.md)  
**使用手册:** [English](docs/USER_GUIDE.en.md) | [简体中文](docs/USER_GUIDE.zh-CN.md)

---

## 重要声明

Agent Browser Studio 是具有双用途属性的本地自动化工具。请仅用于合法且已授权的工作流，例如 QA、国际化/本地化测试、隐私保护型个人工作流、授权业务运营和防御性研究。

禁止将 Agent Browser Studio 用于欺诈、垃圾信息、凭证攻击、未授权抓取、平台滥用、封禁规避、虚假身份网络，或滥用 Cookie、凭证、个人数据、商业机密等敏感信息。详见 [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md)。

---

## 功能概览

| 模块 | 能力 |
|---|---|
| 托管 Chromium Profiles | 验证/配置独立构建的 Chromium，创建/启动/停止 profiles，精确版本 pin、保留旧版本回滚，profile tags |
| 指纹设置 | 确定性托管身份或宿主原生 pass-through；平台、时区、语言、WebRTC、GPU、屏幕、CPU、内存、存储额度、字体 |
| 代理管理 | 命名 HTTP/SOCKS 代理，IPv4/IPv6 环境 URL，凭证脱敏，按 profile 分配，代理地理检测 |
| 浏览器状态 | Cookies、localStorage、preferences、bookmarks、extension state、存储检查 |
| 扩展仓库 | 本地 ZIP/CRX 导入，Chrome Web Store 包缓存，安全解包，同步 hash 校验 |
| AI Agent | OpenAI-compatible 和 Claude provider，工具调用，浏览器控制，文件/HTTP/DB 工具，run traces |
| Skills 和模板 | 内置 skills，可导入/导出 recipes，任务模板，平台 adapters |
| 自动化 | 定时/手动 rules，durable jobs，job/run 关联，automation job UI |
| 同步 | S3 兼容配置和 profile artifact 同步，preview，有界读取，恢复加固 |
| 审计/导出 | Activity timeline，run traces，脱敏导出包，跨对象链接 |
| 安全加固 | Renderer sandbox、context isolation、CSP、审批门、SSRF 阻断、脱敏边界 |

---

## 界面截图

| Profiles | Agent |
|---|---|
| ![Profiles](docs/screenshots/profiles.png) | ![Agent Chat](docs/screenshots/agent-chat.png) |
| **Wizard** | **Sync** |
| ![Wizard](docs/screenshots/wizard.png) | ![Sync](docs/screenshots/sync.png) |
| **Automation** | **Activity** |
| ![Automation](docs/screenshots/automation.png) | ![Activity](docs/screenshots/activity.png) |
| **Runs** | **Proxy** |
| ![Runs](docs/screenshots/runs.png) | ![Proxy](docs/screenshots/proxy.png) |

---

## 快速开始

### 环境要求

- Apple Silicon macOS
- Node.js 22.16 或更高版本
- Go 1.25 或更高版本（用于构建随包分发的 MASQUE/SOCKS helper）
- npm

### 安装与启动

```bash
git clone https://github.com/edgora-ai/browser-manger.git
cd browser-manger
npm install
npm start
```

### 使用独立 Chromium 150 指纹引擎

使用 [`patches/chromium`](patches/chromium/README.md) 下独立维护的补丁集构建
Chromium 150，完成验证后安装到本地 OSS 引擎缓存：

```bash
npm run verify:chromium -- /path/to/Chromium.app
npm run install:chromium -- /path/to/Chromium.app
npm start
```

安装器会将版本化构建保存到 `~/.agent-browser-studio/`。Profile 默认选择最新安装版本，
也可以 pin 任一保留的精确版本用于回滚。Profile 编辑器还提供 pass-through 模式，
关闭所有托管身份消费者，以宿主原生指纹进行 stock 对照。不使用任何外部浏览器
wrapper、license key、登录或上游更新服务。`AGENT_BROWSER_CHROMIUM_BINARY_PATH`
用于显式覆盖二进制，`AGENT_BROWSER_CHROMIUM_CACHE_DIR` 用于覆盖托管缓存根目录。
没有独立构建时，Profile 启动会明确失败，不会下载或选择回退引擎。GeoIP
统一使用 Agent Browser Studio 的有界代理探测。同版本重装会比较启动器、
Chromium Framework 和关键资源的运行时构建哈希；构建有变化时原子替换，并把
上一份 bundle 保留在隐藏恢复目录中。

首次正常启动时，应用会将 `~/Library/Application Support/CloakLite` 非破坏性复制到
`~/Library/Application Support/AgentBrowserStudio`，并将 `~/.roxy-lite-cloak`
中的有效 Chromium 版本复制到 `~/.agent-browser-studio`。旧应用、旧数据和旧缓存
都保持不动。旧 `cloakBin`、`cloakProfiles`、`cloak-profiles/` 和 `cb_` 仅作为
兼容边界继续读取；新数据使用 `chromiumBin`、`browserProfiles`、`profiles/` 和
`ab_`。应用不会选择、下载、授权或调用 CloakBrowser/RoxyBrowser 组件。

经有效团队签名的发行版使用 Electron 的系统凭据存储。macOS 本地/ad-hoc 构建则
使用随机 mode-0600 密钥保护的 AES-256-GCM 凭据库，同时让 Electron 与托管
Chromium 使用 mock Keychain 后端，避免每次重建后重复弹出钥匙串授权。旧
`CloakLite Safe Storage` 密文会一次性、原子地转换；不会删除旧钥匙串项，也不会
把明文写回配置文件。

当前 Apple Silicon 构建已在 Chromium `150.0.7871.114` 上完成验证：
原生严格校验 53 项、现代/旧版 Storage 深层语料、61 项系统主题专项检查及
Window/Worker/DOM/Local Font Access 字体深层语料全部通过，并覆盖 WebGL 1/2
及 WebGPU adapter/device 深层能力语料、同一
Profile 重启及 headed/headless 全能力面对照；安装版的
版本/输入/Cookie/代理旅程全部通过，并保留 Chromium 149 用于回滚。
`0041` 补丁集还验证了认证 SOCKS5 TCP/UDP、代理侧 DNS，以及通过
Profile 自有 MASQUE bridge 建立的真实 HTTP/3。
应用层输入门禁还验证了两层跨源 frame 中的 trusted 操作、布局变化后的
重新定位、遮挡拒绝以及显式按键时长。
`0042` 补丁新增公开的 `agent-browser-*` 运行时协议；旧 `roxy-*` 开关仅用于兼容
保留的 Chromium 149 和早期 150 构建。`0043` 新增显式的托管运行时能力：仅隐藏
Chromium 的“缺少 Google API Key”信息条，不注入伪造 Key，也不声称启用了不可用的
Google 服务。`0044` 让托管 Profile 的 DoH（含探测）始终走出口代理、不再绕过
或落到本机解析器，同时保留托管 ICU locale、字体映射与原生刷新率，使 DNS、字体
与帧率始终与出口身份一致。RoxyChrome/CloakBrowser 只作为历史能力
对照，不是运行时依赖：
36 项引擎/网络/生命周期门禁中，35 项 verified、已无 partial、1 项 missing。
唯一硬缺失是签名的多平台发行包；代理
timing/cache/header 已通过受控 HTTP/HTTPS/WSS 语料，TLS/HTTP2/HTTP3
直连深层指纹也与 Stock Chrome 150 完全一致并标记为 verified；详见
[`ALIGNMENT_MATRIX.md`](patches/chromium/ALIGNMENT_MATRIX.md)。

### 开发检查

```bash
npm run build
npm test
```

定向 E2E 示例：

```bash
npm run build
npx vitest run -c vitest.config.e2e.ts tests/e2e/j34-credential-vault.test.ts
npx vitest run -c vitest.config.e2e.ts tests/e2e/j45-version-pin-pass-through.test.ts
npx vitest run -c vitest.config.e2e.ts tests/e2e/j50-nested-frame-humanization.test.ts
```

> E2E 会在 `tests/e2e/userdata/` 生成本地浏览器数据；该目录已被忽略，不能提交。

---

## 首次使用流程

1. 安装或配置独立构建的 Chromium 150 二进制文件（可保留 149 用于回滚）。
2. 打开 **Profiles** 并创建 profile。
3. 可选：打开 **Proxies**，添加代理并分配给 profile。
4. 启动 profile，运行 **Check Risk** / consistency check。
5. 可选：打开 **Agent**，配置 LLM provider，并执行已授权的浏览器自动化任务。
6. 可选：打开 **Automation** 创建定时或手动规则。
7. 可选：在阅读隐私和安全说明后配置 **Sync**。

完整说明请阅读 [English User Guide](docs/USER_GUIDE.en.md) 或 [中文使用手册](docs/USER_GUIDE.zh-CN.md)。

---

## 项目结构

```text
src/
  main/
    index.ts              Electron 入口、窗口、托盘、MCP bootstrap
    preload.cjs           contextBridge API
    ipc/                  IPC handler modules
    services/             业务逻辑和持久化
    types.ts              共享类型
  renderer/
    index.html            UI shell
    css/                  renderer 样式
    js/                   模块化 renderer 应用
tests/
  unit/                   service 和 hardening tests
  e2e/                    Playwright Electron journeys
  smoke/                  结构检查
docs/                     使用手册和 roadmap
patches/chromium/         独立 Chromium 源码补丁和验收矩阵
resources/                应用图标
```

---

## 安全、隐私和合规

Agent Browser Studio 会处理敏感本地数据，包括浏览器 profile 状态、Cookies、localStorage、代理凭证、LLM API keys、同步凭证、审计日志、截图和 agent traces。

安全控制包括：

- Electron renderer sandbox、context isolation、renderer 无 Node integration
- CSP，仅允许 self-hosted scripts
- 本地 config 权限和原子写入
- IPC、UI、export、sync-safe config、run trace views 中的 secret redaction
- HTTP 写方法和危险 DB 操作审批门
- Agent HTTP requests 阻断本地/私网/link-local/CGNAT 目标
- HTTP/LLM 响应有界处理
- 安全 ZIP/CRX 解包和扩展包 hash 校验
- loopback-only MCP server，并使用 bearer token 认证

使用前请阅读：

- [SECURITY.md](SECURITY.md)
- [PRIVACY.md](PRIVACY.md)
- [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md)
- [NOTICE.md](NOTICE.md)

---

## 已知限制

| 领域 | 当前状态 |
|---|---|
| 平台支持 | 开箱支持 Apple Silicon macOS。Windows/Linux 跨平台代码路径已存在，但端到端尚未完全验证。 |
| 国际化 | 支持 zh-CN / en-US 运行时切换。核心 UI、侧边栏、向导、托盘，以及自动化/运行记录/活动审计/数据库/审批/同步模块均已翻译；少量长文本模板提示仍保留中文回退。 |
| Agent 聊天流式 | OpenAI 兼容和 Claude provider 支持逐 token 流式。工具调用元数据在工具调用块完成后发出；工具执行会阻塞下一轮流式。 |
| 新手引导向导 | 首次运行（无二进制或无 profile 时）显示 4 步向导：安装二进制 → 创建 profile → 启动并检测 → 可选 AI 配置。 |
| Renderer 架构 | Renderer 为按 script 加载的模块化 vanilla JS，未做打包。部分模块仍较大并依赖共享全局命名空间。 |
| E2E 测试 | 单元/冒烟测试在 CI 中运行。E2E（Playwright Electron）需要真实 Electron 环境和独立 Chromium 二进制，因此尚未在 CI 中全部运行。 |

---

## 测试和发布检查清单

发布或分享构建前：

```bash
npm run build
npm test
npm audit --json
```

推荐仓库卫生检查：

```bash
rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!.git/**' 'sk-|AKIA|BEGIN .*PRIVATE KEY|github_pat_|ghp_' . || true
git status --short --ignored
```

不要提交：

- `.env` 或本地 config 文件
- sqlite/db 文件
- Cookies、Local Storage、Session Storage
- audit logs、screenshots、exported bundles
- `dist/`、`node_modules/`、E2E userdata

---

## 文档

- [User Guide — English](docs/USER_GUIDE.en.md)
- [使用手册 — 简体中文](docs/USER_GUIDE.zh-CN.md)
- [Improvement Roadmap](docs/improvement-roadmap.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Privacy Notice](PRIVACY.md)
- [Acceptable Use Policy](ACCEPTABLE_USE.md)

---

## 贡献

欢迎贡献。请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，安全敏感或持久化相关改动需要包含测试。

---

## License

MIT — see [LICENSE](LICENSE)。

---

## 商标和非隶属声明

除非相关方明确声明，Agent Browser Studio 与 Google、Chrome、Chromium、Meta、Facebook、Instagram、TikTok、Amazon、Shopee、OpenAI、Anthropic、AWS、S3 兼容存储提供商、CloakBrowser 或 RoxyBrowser 没有关联、背书、赞助或官方连接。
