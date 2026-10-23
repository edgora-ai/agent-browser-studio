# 严格代理与 TCP / UDP / WebRTC 实测（2026-10-22）

## 交付范围

本轮修改 Chromium 与 Firefox 的启动路由、WebRTC 模式与诊断含义，并增加受控真实传输验收；随后生成本地打包 App 并对其做了真实启动/代理验收，并在获得 Developer ID 后重新签名、复验签名包（见文末）。未安装到 `/Applications`、未公证、未提交、推送或发布；未改动已安装 Studio、真实环境、代理凭据、授权或系统安全设置。Android 继续暂停。

- 自动模式：实际选中代理时使用 `proxy-only`，不依赖出口 IP 检测成功；无代理时使用真实网络。
- 明确选择 `proxy-only` 却没有代理时拒绝启动，不回退直连。关闭指纹身份也不取消代理路由约束。
- `proxy-only` 保留真实 ICE / TURN 候选地址；不将中继地址改成 HTTP 出口 IP。旧版 IP 改写仍需显式选择，且不代表转发。
- `real` 是明确允许真实网络的选项，可能绕过代理；`altered` / `disable` 需要托管指纹。
- 普通 HTTP / CONNECT 的 UDP 明确不支持。SOCKS5 UDP、浏览器 WebRTC UDP、QUIC 和成功的 WebRTC 对等连接分别判定，不互相代替。

## 修正的实际缺口

1. **CLI 参数不等于 Chrome 限制生效。** 早期真实测试中，参数存在，但内核仍向自有 STUN 服务发出直连 UDP。完整 Chrome 的 renderer preferences 桥读取 `webrtc.ip_handling_policy`；同名 force CLI 参数的消费者属于 content_shell。现在启动前验证并持久化 Chrome 实际读取的偏好，再读回核对；清除会削弱全局限制的 `webrtc.ip_handling_url` 覆盖列表，保留无关偏好。损坏、链接、写入或 fsync / readback 失败均拒绝启动，不用空对象重置原数据。
2. **写入的 Chrome profile 必须和启动的 profile 相同。** 原来只写 `Default/Preferences`，但 Local State 可以选择另一个 last-used profile。现在唯一固定 `--profile-directory=Default`，将其纳入启动摘要及新鲜/复用检查；缺失、重复、分离值、非规范前缀和其他 profile 都拒绝。WebRTC 路由策略版本为 3，启动 stamp 格式为 v2；旧证据不升级为新证据。
3. **HTTP 403 不是 origin 成功。** 负向夹具主动拒绝代理时，fetch 可以正常解析到代理的 HTTP 403。验收检查状态、随机 nonce 与 origin 收到的流量，不再把 Promise resolved 当作目标服务成功，也不将 403 归因为指纹检测或认证失败。
4. **旧的配置级“WebRTC 泄漏检测”没有浏览器证据。** 删除 HTTP 查 IP 冒充 STUN / DNS 检测及空结果“无泄漏”结论；返回明确 unavailable，`hasLeak: null`。公开浏览器诊断仍是 ICE 地址暴露检查，新增对等连接“未实测”的独立状态与界面提示。

## 真实测试方法与已经观察的结果

使用现有、明确选择并校验哈希的 macOS ARM64 Chromium 152.0.7977.72；一个任务独占的合成 user-data，动态 IPv4 loopback TCP / UDP / HTTP / SOCKS5 / STUN / TURN 夹具。没有访问公网业务站或使用真实代理、Cookie、密码。DataChannel 不请求摄像头或麦克风。

| 实测项 | 观测与通过条件 |
| --- | --- |
| HTTP CONNECT TCP | 32 字节随机挑战与精确回显，不只检查 CONNECT 握手 |
| 带认证 SOCKS5 TCP | RFC1929 合成认证、CONNECT 与 32 字节精确回显 |
| SOCKS5 UDP | 真实 UDP ASSOCIATE、存活的控制连接、20 字节 STUN 请求与 40 字节响应；验证中继来源、目标、帧和事务 ID |
| 普通 HTTP UDP | 返回 unsupported；不创建直连 UDP 来冒充能力 |
| HTTP + managed WebRTC | 两个真实 peer，双向共 100 字节 / 2 条应用消息；两端均选中 relay / relay，`relayProtocol: tcp` |
| 带认证 SOCKS + managed WebRTC | 同上；使用生产认证 SOCKS 桥的 TCP 路径，不将该桥标为 UDP 桥 |
| HTTP + fingerprint-off WebRTC | 同上；指纹关闭不解除代理隐私策略 |
| 代理与 TURN 路径归属 | 两个 TURN allocation 分别绑定实际代理上游 TCP socket / route ID；控制流和 UDP relay peer 流量均为正。拒绝直接 TURN Allocate 的独立对照也通过 |
| 禁止静默回退 | 主动拒绝并断开自有代理后，新 peer 不连通；没有新增直连 TURN / allocation，负向 HTTP 请求不增加 origin 接收流量，STUN 不出现新增直连 Binding |
| 选择 profile 的反例 | 合成 Local State 指向偏好为 `default` 的 `Profile 1`；实际 argv 及 `chrome://version` 都确认使用 `Default`，限制有效且未改写备用 profile 偏好 |
| 清理与制品身份 | 每个浏览器正常关闭；短期空 runtime 被移除；所有夹具活动 TCP / UDP socket、监听器、association、allocation 计数归零；内核和 framework 哈希不变 |

`selectedPairs.protocol: udp` 描述 relay 侧候选；本轮浏览器到 TURN 的一段实际为经代理的 TCP。不能据此宣称浏览器已直接使用 SOCKS UDP。

## 验证记录

本机已登记证据子根：`proxy-transport-20261022-zslmfveo`，受原父根累计 1 GiB、子根 64 MiB、开发卷保留 6 GiB / 宿主盘保留 10 GiB 的门禁约束。完整记录保留在本机，不把本地索引或秘密材料写入此报告。

- 早期 `native-transports-01` / `02` / `03` 失败完整保留，分别暴露 argv 观测接口不适用、CLI 策略未生效、负向 fetch 状态判定错误。
- `native-transports-04`：三种路由全部通过；修复选择 profile 的额外缺口后，`native-transports-05` 再次通过并验证备用 profile 反例。
- `default-profile-red-01`：新增的 5 个 profile 选择拒绝断言在修复前真实失败。
- `focused-final-01` 保留 2 个新增夹具断言失败：把启动前已经关闭的 loopback 临时端口预留误当成浏览器 / CDP 启动。已改为明确检查该预留监听和释放，同时保留无 spawn / 无 CDP fetch / 无诊断启动的断言。
- `focused-final-02`：14 文件、786 测试通过，实际 exit 0，源码前后摘要均为 `971e7041ee4e5cbe6f05bf8b3ca3314e578138f01dac38c4f55bd66cc1db87df`。
- `static-final-01`：`tsc --noEmit`、实际 i18n 审计、两份 i18n 字节镜像和 `git diff --check` 均 exit 0；合并后中英文各 2162 个 renderer key，main 各 64 个 key。
- 最终同源码 `native-transports-06`：实际 exit 0，三种原生路由及备用 profile 反例全部通过，资源正常清理；日志 SHA-256 `ae2643b2e37394de3416b37b6cc641f36814efa2a35bad64aface004489f7f41`。
- `static-final-02`：同源码再次执行类型、i18n、镜像及 diff 门禁，实际 exit 0。上述两项及 `focused-final-02` 的源码摘要相同。
- 首轮完整单元分片 1：4070 passed / 20 failed / 1 skipped，失败证据保留。20 个失败来自两个旧 argv 夹具未包含新要求的 `Default` 选择；只补充夹具启动参数，未削弱原代理 / DNS / 显示名断言。`compatibility-fixtures-green-01` 已验证这 20 项通过，exit 0。
- 分片 2 保留 3771 passed / 5 failed 的回执：其中 3 项虚拟文件系统启动夹具未声明新增偏好模块边界，另 2 项来自测试 wrapper 将合成 HOME 放在 TMPDIR 下，改变了归档 allowlist 反例的前提。只修正夹具声明及 HOME/TMPDIR 的独立目录几何关系；归档生产保护、原断言均未放宽。`compatibility-boundaries-green-02` 四文件 / 38 测试通过，exit 0。
- 最终冻结摘要为 `af9ce1583dbd862bc00e7d30bbe9f07940f8be62cd03d0fce3d8941301e93dfa`；native-06 之后的源码变化均为 unit 夹具兼容，生产源码、原生验收代码及所选内核不变。全部记录保留，未修改旧失败回执。
- 最终完整非 GUI 单元回归：两片实际 exit 0，**262 文件 / 7866 passed / 1 skipped / 0 failed**，无 supervisor / 预算错误。`proxy-unit-shard1-03` 为 4090 passed / 1 skipped，日志 SHA `962c56f2849a4fa81b0447397878ee2defdf7fc3d4b708f14631e3314518b26f`；`proxy-unit-shard2-03` 为 3776 passed，日志 SHA `0ca116dbf22c6ff6c17b688f653ebffde8c5487e25eb77fb9c6a503c2c394465`。
- `focused-final-03`：18 文件 / 824 测试通过；`native-transports-07`：三种真实链路及所有反例 / 正常清理通过，日志 SHA `ecf80926c68a8463ba2245295a62759f9b4bbb65b63dec914052f76bd60dbe5e`；`static-final-03`：类型、i18n、镜像及 diff 门禁通过。
- 上述最终验证的 before / after 摘要全部相同：`af9ce1583dbd862bc00e7d30bbe9f07940f8be62cd03d0fce3d8941301e93dfa`。这代表源码与受控原生传输验收，不是已安装 App / GUI / 发行包验收；本轮未重跑全量覆盖率。

## 界面与能力边界

- 新建 / 编辑 Chromium 环境增加“仅代理”，旧版改写才可输入自定义 IP。模式、批量导入、配置磁盘读回、重载和可迁移投影均有回归。
- 代理卡显示 HTTP 的普通 UDP 不支持、SOCKS UDP / RTC 未验证；一次 TCP Detect 不会把这些能力升级为已验证。
- 失败提示中英文一致。Preferences 不可验证时提示保留数据检查，不引导清空站点或放宽安全策略；强行启动不可达代理也不表示移除代理或允许直连。
- 新的 TCP / UDP 与双 peer 探针是 main 内部可信目标组件和开发验收入口，没有新增可由 UI / REST / MCP 指定任意目标的公共 API，没有自动部署公网 TURN，也没有宣称已为每个用户代理执行这些测试。
- 本轮已修改 Firefox 路由并完成其真实运行验收（见文末）；Chromium 部分不受影响。TURN/TLS、真实 IPv6 socket、浏览器 SOCKS UDP / QUIC、音视频、异机公网互通、完整 OS 抓包仍未验收；打包 App 已做真实启动/代理验收，但未做可见 GUI 交互截图验收。未观察到绕过仅限上述自有端点与测试窗口，不是 OS 级全流量不泄漏证明。

## Firefox 支持（2026-10-22 追加；同源码已验证并打包）

Firefox 154 源码核对（`PeerConnectionImpl::ShouldForceProxy`、`WebrtcTCPSocket`）后的实际语义：

- **Auto 有代理 → Proxy-only**：写入 `media.peerconnection.ice.proxy_only=true`，强制 ICE 使用浏览器代理配置；无代理的 Auto 使用 Real。
- **显式 Real**：不再被旧代码无条件覆盖，写入 `proxy_only=false`，使用原生路由。
- **关闭指纹**：沿用既有约定，已存的 WebRTC 模式与其他身份字段一样休眠；但**配置代理时仍强制 Proxy-only**，不会因关闭指纹而静默直连。
- **Disabled**：写入 `media.peerconnection.enabled=false`，真实移除 `RTCPeerConnection` API（比 Chromium 的仅拦 ICE 更强）。
- **Altered**：Firefox 没有对应引擎改写通道，明确拒绝，不伪造等价。
- 路由选择通过独立 checkpoint 绑定到实际进程；`proxy_only` 只在确实有代理时有效——它强制走代理路由，本身不承诺阻断所有直连，且 Firefox 的 WebRTC 代理路径是 **TCP/TLS**，不承载 SOCKS UDP。

真实本机 Firefox 验收（`firefox-native-18`，exit 0，只清理临时测试 profile）：

| 场景 | 结果 |
| --- | --- |
| HTTP 代理 + Auto（proxy_only） | 页面请求 2 次经自有 HTTP 代理；STUN 直连 0；无裸 IP 候选 |
| 直连 + Real | 出现 2 个 host 候选（符合显式 Real 语义） |
| SOCKS5h + Real | 页面经 SOCKS 连接 2 次；6 个候选含 srflx；WebRTC 经 TURN/TCP 双向连通（2 relay pair） |
| HTTP 代理 + Disabled | 页面经代理；`typeof RTCPeerConnection === "undefined"` |

同源码定向回归 711 项通过；`tsc --noEmit` 通过。

## 打包与打包后验收（2026-10-22）

- 产物：`release-firefox-webrtc-20261022-arm64/mac-arm64/Agent Browser Studio.app`（本地 dir 包，672 MB，内含 Chromium 152 / Firefox 154 官方内核 zip、正式公钥 `73eb0f64…`）。旧 `release/` 与旧候选目录未覆盖。
- 打包 App 实际启动：`/health` 200；未认证与错误 token 均 401，正确 token 200；引擎状态 Chromium 152.0.7977.72、Firefox 154.0 均由包内资源解出。
- Chromium：无代理 Auto → `ip_handling_policy=default`；有代理 Auto → `disable_non_proxied_udp`、`--profile-directory=Default`、`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`，启动 33 次 CONNECT 全部经自有代理。
- Firefox：无代理 Auto → `proxy_only=false`、`proxy.type=0`；有代理 Auto → `proxy_only=true`、`proxy.type=1`、`obfuscate_host_addresses=true`，37 次连接全部经自有代理；**关闭指纹 + 代理**时存档模式为休眠的 `real`，实际仍写入 `proxy_only=true` 并走代理。
- 签名：本自动化会话无钥匙串访问，Developer ID 签名报 `errSecInternalComponent`；最终包为 ad-hoc/未签名本地构建，**未公证、未安装、未发布**。

仍未覆盖：普通 HTTP UDP（不支持）、Firefox 的 SOCKS UDP（其代理路径为 TCP）、TURN/TLS、真实 IPv6、音视频、公开代理/STUN/TURN、任意外网站点、OS 全量抓包。

## 重新签名与签名包验收（2026-10-22 追加）

- 产物：`release-firefox-webrtc-20261022-arm64-signed/mac-arm64/Agent Browser Studio.app`，由 electron-builder 以 `CSC_NAME="tiger wang (Y62N77529N)"` 完整重签（不是在已打包产物上手工 `--deep` 覆盖）。
- 首次失败已保留：`sign-release-02` 手工 `codesign --deep` 后嵌套 `libffmpeg.dylib` Team ID 与主程序不一致，dyld 拒绝加载；该包作废。正确做法是让打包器对全部嵌套项使用同一身份签名。
- 签名核验：`codesign --verify --deep --strict` 有效；`CDHash=54b3d6a6a3cd4e541e785969d30bd936a2dc1f47`；主程序与嵌套 `libffmpeg.dylib` 均为 `TeamIdentifier=Y62N77529N`，Authority 为 `Developer ID Application: tiger wang (Y62N77529N)`。`spctl` 仍报 `Unnotarized Developer ID`——**未公证**，需要显式决定。
- asar SHA-256 与之前已验证的本地构建一致：`d177fa58…4ef3cc51`；正式公钥 `73eb0f64…` 未变。
- 签名包真实启动验收（`package-acceptance-06`，13/13 通过）：
  - `/health` 200；无 token 401、错误 token 401、正确 token 200。
  - 两个引擎均由包内 zip 解出：Chromium 152.0.7977.72、Firefox 154.0。
  - Chromium + 命名代理 + Auto：`Default/Preferences` 写入 `webrtc.ip_handling_policy=disable_non_proxied_udp`、`ip_handling_url=[]`；实际 argv 含 `--profile-directory=Default` 与 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`。
  - Firefox + 命名代理 + Auto：`user.js` 写入 `proxy_only=true`、`obfuscate_host_addresses=true`、`network.proxy.type=1`。
  - Firefox 关闭指纹 + 代理：存档 `webrtcMode=real` 仍是休眠值，实际应用 `proxy_only=true` 且 `network.proxy.type=1`，不因关闭指纹直连。
  - 三次启动期间自有代理累计 49 次 CONNECT / 1 次转发，10 个不同目标。
- 已知会话边界：签名后 App 走 macOS Keychain 凭据库；当前自动化 shell 属于 launchd **Background** 会话，`SecItemAdd → makeLoginAuthUI → AuthorizationCopyRights` 无 UI 可答，进程停在启动、不写日志。这是会话限制而非包缺陷：正常登录的桌面会话可以应答。本次验收使用产品支持的 `AGENT_BROWSER_SECRET_BACKEND=file` 覆盖完成；默认 Keychain 路径在后台会话中记为 **blocked（未验证）**，不记为失败，也不修改钥匙串/安全策略来绕过。

仍未覆盖：公证与 Gatekeeper 首启、安装到 `/Applications`、可见 GUI 交互截图、普通 HTTP UDP（不支持）、Firefox 的 SOCKS UDP（其代理路径为 TCP）、TURN/TLS、真实 IPv6、音视频、公开代理/STUN/TURN、任意外网站点、OS 全量抓包。
