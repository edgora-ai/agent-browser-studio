# Agent Browser Studio（Agent 浏览器工作台）使用手册

Agent Browser Studio（Agent 浏览器工作台）是一个本地桌面控制台，用于管理独立补丁 Chromium 引擎上的隔离浏览器配置文件、代理、AI 浏览器自动化、自动化任务、审计轨迹和 S3 兼容同步。

> 请仅将 Agent Browser Studio 用于合法且已授权的工作流。禁止用于欺诈、垃圾信息、凭证攻击、未授权抓取、平台滥用、封禁规避，或滥用 Cookie、凭证、个人数据、商业机密等敏感信息。

## 1. 安装

### 环境要求

- Apple Silicon macOS
- Node.js 22.16 或更高版本
- 使用 `npm run install:chromium -- /path/to/Chromium.app` 安装独立构建的 Chromium 补丁集，或通过 `AGENT_BROWSER_CHROMIUM_BINARY_PATH` 显式选择

### 从源码启动

```bash
git clone https://github.com/edgora-ai/browser-manger.git
cd browser-manger
npm install
npm start
```

开发检查：

```bash
npm run build
npm test
```

## 2. 首次使用

首次启动时，若无托管 Chromium 二进制且无 profile，会显示 4 步向导：

1. **验证托管 Chromium** — 确认独立构建的引擎已安装。
2. **创建首个 profile** — 设置名称、平台、时区、语言、硬件、WebRTC。
3. **启动并检测指纹** — 启动 profile 并打开风险检测页面。
4. **配置 AI Agent（可选）** — 跳转到 Agent 配置页接入 LLM provider。

"稍后" 仅本次会话隐藏向导；"不再显示" 持久化关闭。你也可以随时从各标签页手动执行这些步骤。

从 CloakLite 升级时，首次正常启动会把旧用户数据及有效的托管 Chromium 版本
复制到 Agent Browser Studio 的新目录，核验复制后的 Profile 文件树，并保留旧应用、
旧数据和旧缓存不动。新 Profile 使用 `ab_` 标识，迁移后的 `cb_` Profile 仍可继续使用。

macOS 上若存在旧 `v1:` 凭据，首次修复版启动可能会对 `CloakLite Safe Storage`
发起一次受控授权。应用会原子地把全部旧字段转换到本地 AES-GCM 凭据库，之后不再
重复申请；若拒绝授权，应用会停止启动并保持旧密文原样。在迁移成功前不要删除旧
钥匙串项。

## 3. Profile 管理

Profile 保存浏览器状态和指纹配置。

常用操作：

- **Launch / Stop**：启动或停止托管 Chromium profile。
- **Edit**：修改 profile 元数据和指纹字段。
- **Chromium build**：使用最新安装的独立构建，或 pin 保留的精确版本用于回滚。
- **Pass-through**：关闭托管的 UA/平台/语言/时区/WebRTC/GPU/屏幕/noise 消费者，以宿主原生身份进行对照。
- **Clone / Batch create**：用确定性 seed 创建多个 profile。
- **Consistency check**：检查 profile 的时区、语言、WebRTC、代理检测信息是否一致。
- **Tags**：用标签组织批量操作和导出。

最佳实践：

- 使用一致的命名方式，例如 `market-region-purpose-01`。
- 使用 `amazon`、`qa`、`us`、`operator-a` 等标签。
- 不要在无关工作流之间复用 Cookie 或账号状态。
- 如果需要恢复同步的 localStorage/preferences，请先停止 profile。

## 4. 代理管理

打开 **Proxies** 可添加命名 HTTP、SOCKS5、SOCKS5H 代理。

推荐流程：

1. 添加代理 host、port、type 和可选认证信息。
2. 使用 **Detect** 测试连通性并获取出口地理信息。
3. 将代理分配给指定 profile。
4. 操作 profile 前运行 **Consistency Check**。

说明：

- 代理凭证会在 IPC/UI/export 路径中脱敏。
- 已验证的 Chromium 在 Browser 进程内处理 HTTP 407 凭证；带认证的 SOCKS5
  TCP 使用临时回环桥，目标域名仍交由上游代理解析。
- 在具备 UDP 认证传输前，受管代理会禁用 QUIC，避免流量绕过代理。
- 代理地理检测结果会缓存，并参与一致性风险提示。
- 生产使用中不要硬编码本地或私网端点。

## 5. Cookie、存储和扩展工具

Agent Browser Studio 可以通过 CDP 或在 profile 停止时读取本地文件来管理浏览器状态。

敏感数据包括：

- Cookie
- localStorage
- preferences
- bookmarks
- extension state
- screenshots
- exported audit bundles

这些数据都应视为敏感数据，不要提交到 Git。

### 扩展仓库

扩展仓库可以导入本地 ZIP/CRX，也可以缓存 Chrome Web Store 扩展包。

安全控制包括：

- 安全 ZIP 解包
- 拒绝符号链接和路径穿越
- 同步恢复时校验 package hash 和 manifest hash
- pull 时限制扩展数量和总字节数

## 6. AI Agent

打开 **Agent** 可配置 LLM Provider，并执行带工具调用的浏览器自动化。

### 配置 LLM

1. 打开 **Agent → Config**。
2. 选择 OpenAI-compatible 或 Claude provider。
3. 输入 API URL、API Key 和 Model。
4. 保存配置。

### 常用 Agent 工具

- Browser：navigate、click、type、screenshot、get text、get URL/title、cookies
- Files：根据配置模式进行沙箱读写
- HTTP：访问外部 API，写操作需要审批
- DB：本地 Agent 数据库查询/执行，危险操作需要审批
- Variables：当前 run 内的短期变量

安全说明：

- 回复支持按 token 流式显示在聊天视图（OpenAI 兼容和 Claude provider）。
- 每次发送都通过 stream id 关联，并发或过期发送不会污染其他助手消息。
- HTTP 请求会阻断 localhost、私网、link-local、CGNAT 等目标。
- HTTP 写方法需要用户审批。
- 工具 trace 会脱敏请求/响应 body 和变量值。
- LLM streaming 有总字节、事件、文本、工具参数和超时限制。

## 7. 自动化

Automation rules 支持按计划或手动触发动作。

支持的模式包括：

- 打开 profile
- 运行 AI agent task
- 执行沙箱 JavaScript
- 导出数据
- 检查 profile/proxy 一致性
- 跟踪 durable jobs

使用 **Automation Jobs** 可以查看 queued、running、done、failed、skipped、cancelled 状态。Agent-task job 会关联到对应的 Agent Run trace。

## 8. 同步

Agent Browser Studio 支持通过 S3 兼容存储同步部分配置和 profile 数据。

Push/Pull 前建议：

1. 配置 endpoint、bucket、access key 和 secret key。
2. 使用 **Preview** 查看影响范围和远端状态。
3. 如果需要恢复 localStorage/preferences，请先停止正在运行的 profile。
4. 将远端同步 bucket 视为敏感存储。

同步加固包括：

- sync-safe config 中移除 secret
- 限制远端读取大小
- 安全恢复 localStorage/preferences
- 校验扩展 package hash
- 限制扩展总字节数

## 9. 导出和审计

数据导出用于调试、评估和治理。

导出脱敏包括：

- 移除代理凭证
- 移除 LLM/API secret-like 字段
- Agent run variables 只导出 key/metadata，不导出原始值
- 敏感 Agent DB scope 只导出表 metadata
- HTTP body 在 trace 中脱敏

即便如此，导出文件仍可能包含运营元数据、profile 名称、tags、URL、时间信息和非 secret 标识符，因此仍应视为敏感文件。

## 10. 运营检查清单

在业务工作流中使用 Agent Browser Studio 前：

- 确认你对所有账号、网站和数据都有授权。
- 审查平台条款和适用法律。
- 不同账号/工作流使用独立 profile。
- 操作 profile 前验证代理地理一致性。
- 妥善保护 API Key 和同步凭证。
- 分享审计/导出文件前先人工检查。
- 修改安全敏感代码前后运行构建和测试。

## 11. 常见问题

### Electron 应用无法启动

```bash
npm install
npm run build
npm start
```

如果 Electron 下载不完整，可以重装依赖：

```bash
rm -rf node_modules
npm install
```

### E2E 后测试数据残留

E2E 测试会在 `tests/e2e/userdata/` 下生成本地数据。该目录已被忽略，可安全删除：

```bash
rm -rf tests/e2e/userdata tests/e2e/screenshots dist
```

### LLM 工具调用失败

检查：

- provider 类型
- API URL 格式
- API Key 是否有效
- model 名称
- 工具审批提示
- 网络连接

### Sync pull 跳过 profile 数据

正在运行的 profile 可能会跳过 localStorage/preferences 恢复，以避免损坏数据。请先停止 profile 后再 pull。
