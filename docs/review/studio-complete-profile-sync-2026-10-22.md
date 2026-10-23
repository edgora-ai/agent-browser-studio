# Studio 完整环境迁移修复 — 2026-10-22

> 以下是源码修复验收结束时的快照。后续提交、打包、安装和上传按单独发行记录记载，不把源码验证等同于已部署。

## 状态与范围

本轮回到桌面 Studio，Android 继续暂停。以下是**源码修复与合成数据验证**，不是已安装版本或两台实体机器的真实网站登录验收。未打包、安装、签名、公证、提交、推送或发布。

原有限同步主要覆盖配置、逻辑 Cookie、LocalStorage、Preferences 和另外授权的 History/Places，不能证明保存密码、IndexedDB、Service Worker、会话文件等已迁移。新功能使用独立授权、独立迁移口令和 v4 完整环境产物；旧 v1–v3 仍按有限模式解释，不自动升级授权或冒充完整备份。

## 已修改

- 完整持久化 profile 包：包含保存密码数据库、原生 Cookie、LocalStorage、IndexedDB、Service Worker/CacheStorage/blob、Session Storage/Sessions、History/Places 与 Firefox 配对文件等；仅排除明确临时缓存及运行锁。路径、文件类型、清单、字节数、哈希和稳定性检查失败即拒绝。
- 新完整包使用 AES-256-GCM 和独立迁移口令。源端逐对象上传、读回，再发布主清单；v4 不发布旧明文 Cookie/LocalStorage 兼容 sidecar。配置元数据与扩展包仍有各自的运输语义，不能笼统称全部同步均端到端加密。旧对象不会被自动删除或追溯加密。
- Chromium 保存密码/Cookie 在拥有的 staging 副本中检查并按接收端 codec 转换；转换后重新打开数据库、按字段解密比对，移除已失效的 WAL/SHM/journal，再封存本地派生清单。原始输入不被修改。
- 所需代理用户名和密码放在加密环境元数据内，在接收机用当地 vault 重新加密；不复制源机 vault key，也不把源机密文冒充目标机可用秘密。
- Firefox Cookie 导入复用已注册的 owned BiDi 会话，按真实响应确认；部分/零导入、断线和坏队列明确失败。成功清队列需匹配原文件代次，不能清掉替换队列。
- profile 目录外的待导入 Cookie 队列必须先完成。源/目标任一非空、损坏或不可验证的队列均阻止完整迁移；跨网络 await 后重检，原队列不清空、不覆盖。避免下一次启动用旧队列覆盖刚恢复的登录态。
- 恢复在任何 live 目录切换前写持久 pending receipt，绑定原 restore lease 和文件/目录身份；正常停止、释放普通锁或重启 Studio 都不能解除未决门禁。只有实际配置字节读回、严格持久化确认，或已确认完整回滚之后，才能清除原 receipt。未知/损坏/链接/替换 receipt 均阻止启动或再迁移。
- 已确认回滚的 incoming 副本改为独立 rollback 前缀保留，不再被下一次迁移误判成未决 stage；配置提交失败后真实重试可成功。旧目标保留备份，未知结果不盲目回滚。
- UI、IPC、REST/MCP schema、JS SDK 类型、敏感字段过滤及中英文指南同步更新。完整模式默认远端恢复，同时尊重明确的本地/逐项决定；零远端选中不显示迁移成功。

## 已实际验证

所有数据均为新建合成数据，使用自有动态 loopback HTTP/WebSocket、独立配置目录及独立测试 vault。未读取真实 profile、Cookie、密码、钥匙串、license、deviceID、token 或私钥，未访问真实云/模型/业务网站。

| 验证 | 实际结果 |
| --- | --- |
| 完整 transfer helper + 生产 SyncService PUT/GET/恢复 | **38/38，exit 0**；24 个关键源码/测试前后及最后读盘哈希一致 |
| artifact + ZIP + recovery lock + mutation lock | **160/160，exit 0**；八个相关文件前后哈希一致 |
| 凭据适配与数据库验证 | **59/59，exit 0** |
| Firefox Cookie 相关四组 | **374/374，exit 0** |
| renderer 同步状态与双语错误提示 | **70/70，exit 0**，含新增八个队列错误 DOM/toast 用例 |
| 项目 TypeScript | `tsc --noEmit` **exit 0，空诊断** |
| 两份 i18n 镜像、差异空白检查 | 通过 |
| 最终全量单测 | **256 文件；7647 passed / 1 skipped**；两片真实 exit 0，前后源码/测试指纹相同 |

最终两片命令为直接调用本地 `node node_modules/vitest/vitest.mjs run --config <owned>/vitest-main.config.mjs --root <repo> --shard 1/2 tests/unit` 与 `--shard 2/2`，未触发 npm pretest/build。第一片 128 文件、3978 passed / 1 skipped，第二片 128 文件、3669 passed，真实退出均为 0；两个 before/after 及最终当前源码/测试指纹均为 `cba716240d7a5b7a61e125fd1006469e280c50a0106bd13a2531a3a8a96c427d`。最终回执再次核对 38 项整链的 24 个文件 pin 与当前文件一致。指纹范围为 src/tests-unit/sdk 文本源与根 i18n/package/tsconfig，不包括已安装二进制、真实用户数据或新的物理跨机验收。

生产整链直接验证接收端 SQLite 密码/Cookie 解密、按键/URL 检索 LocalStorage 与 History，读回 IndexedDB/SW/session 文件，并验证原目标备份及源数据不变。两设备测试 vault key 不同。另有 Mac/Linux codec 重加密矩阵，但不是两种 OS 的实体浏览器运行验收。

真实故障注入覆盖：错误口令/损坏对象/配置身份不符、运行中或退出未知、网络 await 后配置/代理/许可/队列变化、两个真实目录 rename 后 guard 失效、Studio 模块重载后门禁、配置提交失败及再次恢复，以及 config.tmp fsync 被旧 store 吞错而 post-rename config.json 严格 fsync 仍失败。最后一种情况保留新配置与新数据、旧备份和门禁，禁止假成功或回滚成旧数据配新配置。

早期整仓日志虽报告 255 文件通过，但监督器在自有临时子目录消失时退出，没有收集实际子进程退出与 source-after，因此不作为最终冻结证明。后续第一次分片因既有近 64MiB 配置压力夹具触发初始子预算而主动终止，亦不算通过；失败日志及夹具保留。最终回归复用原输入和缓存，仅在原 controller **1GiB 总预算内**重新分配子额度，开发卷始终留至少 6GiB、宿主至少 10GiB，不扩盘、不重置预算、不复制 App/浏览器/依赖树。

## 明确边界

- 当前生产凭据适配为受管 Chromium 的 Mac/Linux basic/mock-keychain 后端。Windows DPAPI/AppBound 不支持，必须明确拒绝，不能拷贝后宣称可用。完整恢复还要求能确认 recovery receipt 与配置的目录持久化。
- Firefox 验证并保留 `logins.json`/`key4.db` 配对；NSS 的实际运行解锁尚未验证，仍需正常使用原 Primary Password。
- 硬件 Passkey、OS 保护的不可导出密钥、网站服务端会话接受、IP/MFA、实际运行指纹及全部 Studio 账号 vault 不是本轮完整 browser-profile 迁移保证。
- 新 v4 云同步路径不等同旧 ZIP 导入；原机需要重新完整推送，旧有限快照不能恢复出从未上传的密码。
- 未运行真实 GUI、第二台实体机器/真实网站登录、容器构建/启动或新的 native 构建；不把纯 Node/DOM/合成数据库测试称为这些范围的通过。

结束时 `df -h /Volumes/DevProjectsSSD-74bf68f9 /Volumes/ssd` 实测可用分别为 **6.8Gi / 323Gi**；最终回执的精确采样为开发卷 7,259,222,016 B、宿主 346,767,228,928 B。controller 约 351.6MiB、当前子根约 70.1MiB，保留了中断的合成压力夹具与全部旧日志，未删除或重置额度。

本机完整日志、失败记录、源码 pin 与存储回执位于已登记的 `complete-sync-20261022-3c3db75662` 任务根，未提交合成数据库、密钥或数据包。
