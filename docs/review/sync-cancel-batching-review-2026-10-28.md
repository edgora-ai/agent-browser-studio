# 同步取消与本地分批处理：两轮审查记录

日期：2026-10-28（Asia/Shanghai）。审查基线：`47626e006eb27eba939edbf93044af48025146d2`。

## 范围与安全边界

- 实现按调用绑定的同步取消、有限批次本地读取/校验、按阶段的真实处理进度。
- 取消确认不等于完成：原操作、清理或回滚真正结束前不释放租约，不允许重复提交。
- 部分/未知的本地或远端提交必须保留，不以取消掩盖副作用，也不自动重试。
- 源码、测试和构建均在隔离 worktree；不改变根工作区的 Android/桌面未提交工作。
- 未启动、安装、替换运行中的应用；未操作真实配置、profiles、staging 或同步服务；未访问192.168.4.6。
- 测试只用自有临时目录、内存数据和测试自建的临时 loopback 服务。无 push 或发布。

## 第一轮：独立审查与修复

| 发现 | 修复与验证 |
|---|---|
| 已导航页面可能保留非空但 detached 的 senderFrame，旧页面仍能持有调用权限（P2） | IPC统一检查 sender/frame 存活、detached 和抛错 getter；拒绝旧页面发起/取消及状态能力泄漏，不自动中断旧操作。新增4个生命周期回归。 |
| 新增的终态进度回调/await 出现在最后一次文件见证之后，可使旧校验结果失效（P2） | capture在终态回调与最后 guard 后核对原始 root/all 元数据；prepare在所有 profile/extras阶段后同时核对两个树并检查workspace归属。原哈希/清单比较不变，不重新哈希，最终见证之后没有回调/让出。12个新增回归先失败后通过。 |
| 原有扩展PUT路径在取消/回读失败时会丢失远端副作用记录（基线已有，取消相关修复） | PUT返回后、检查取消和回读之前记录partial/unknown及唯一未知条目；字节相等回读才升级为uploaded。新增实际service模块的10个合成场景。 |

第一轮修复后针对性验证：IPC/renderer/progress共245项通过；artifact/transfer/read-batching/complete-profile/responsiveness共184项通过。

## 第二轮：重新独立复审与回归修正

- 新的独立审查者复核完整生产差异、所有新测试和调用链，IPC/renderer/service/result/progress范围结论：PASS，无未解决的已确认引入问题。独立执行4文件296项通过。
- 另一个新的独立审查者复核artifact/transfer/ZIP/进程快照范围，结论：PASS，无未解决的已确认引入问题。独立执行ZIP/进程发现2文件70项通过。
- 扩大回归首次执行37文件：1329通过、3失败。3项旧发布边界断言错误地将已发送的扩展PUT记作远端none；改为HTTP500的unknown或已接受PUT的partial，同时强化实际存储对象及唯一未知条目断言，保留“不得发布清单/不得更新基线”检查。不是删除或跳过失败测试。21边界+92传输测试重新通过。
- 第二轮独立审查者也复核了最终发布边界测试差异；之后生产源码未变。

## 最终验证门禁

- **39个测试文件，1449项全部通过，无跳过；98.90秒，退出码0。** 这是同步/归档/扩展/自动重试的定向扩大回归，不是全仓库所有测试。
- `tsc --noEmit`通过。
- preload、renderer同步控制器、两份i18n脚本的`node --check`通过。
- 两份i18n逐字节一致，i18n键检查通过：renderer zh/en各2243，main zh/en各64。
- `git diff --check`通过。

最终测试命令（直接Vitest，未执行会预先build的npm test）：

```sh
../../node_modules/.bin/vitest run \
  tests/unit/sync-full-profile-transfer.test.ts \
  tests/unit/sync-full-profile-artifact.test.ts \
  tests/unit/sync-protocol-roundtrip.test.ts \
  tests/unit/sync-sqlite-local-storage.test.ts \
  tests/unit/sync-history-transport.test.ts \
  tests/unit/profile-mutation-restore-lock.test.ts \
  tests/unit/profile-sync-state.test.ts \
  tests/unit/sync-publication-boundaries.test.ts \
  tests/unit/sync-read-batching.test.ts \
  tests/unit/archive-operation-routing.test.ts \
  tests/unit/sync-operation-state.test.ts \
  tests/unit/full-profile-responsiveness.test.ts \
  tests/unit/sync-snapshot-commit.test.ts \
  tests/unit/profile-archive-safety.test.ts \
  tests/unit/renderer-sync-state-r3.test.ts \
  tests/unit/sync-bidi-mutation-lifecycle.test.ts \
  tests/unit/sync-history-api.test.ts \
  tests/unit/process-discovery.test.ts \
  tests/unit/full-profile-recovery-lock.test.ts \
  tests/unit/renderer-sync-state.test.ts \
  tests/unit/sync-restore-safety.test.ts \
  tests/unit/sync-pull-runtime-selection.test.ts \
  tests/unit/rest-sync-archive-socket.test.ts \
  tests/unit/sdk-sync-result.test.ts \
  tests/unit/zip-cancel-progress.test.ts \
  tests/unit/profile-tool-sync-state.test.ts \
  tests/unit/sync-transfer-progress.test.ts \
  tests/unit/zip-writer.test.ts \
  tests/unit/sync-tar-lifecycle.test.ts \
  tests/unit/sync-operation-transport.test.ts \
  tests/unit/sync-service.test.ts \
  tests/unit/full-profile-config-durability.test.ts \
  tests/unit/profile-restore-lock-retry.test.ts \
  tests/unit/sync-progress.test.ts \
  tests/unit/sync-cancel.test.ts \
  tests/unit/sync-acceptance-window.test.ts \
  tests/unit/sync-complete-profile.test.ts \
  tests/unit/extension-sync-snapshot.test.ts \
  tests/unit/automation-scheduler.test.ts \
  --maxWorkers=2 --testTimeout=20000 --hookTimeout=10000 --no-cache --configLoader runner
```

## 明确不承诺的范围

- 4MiB/128检查点/16ms是合作式payload批次预算，昂贵准入完成后才开始计时；不是端到端取消延迟保证。
- 原生系统调用、整块加解密、解包、最终O(entries)元数据见证、发布/应用/重封装/回滚仍有同步区段。
- 进程快照只在词法同步批次内有效；不是跨await缓存或降低每块非进程守卫。
- 文件见证不是原子文件系统快照，仍依赖原有冷profile/恢复锁约束。
- 进度是已处理字节；可能重复访问同一数据，ZIP处理约为payload三遍，不能当作网络已上传字节或最终提交完成度。
- 未对真实409MiB profile、真实Electron导航/UI或现有运行同步进行侵入式验收；测试中的延迟/吞吐不能当作其性能保证。

## 后续打包与本地合并门禁

本记录随已审查源码提交，随后才构建。只生成arm64 ZIP，明确使用匹配的Electron42.4.0 arm64；保持原公钥与原生浏览器资源；要求Developer ID Application签名，不公证、不安装、不发布。

产物需通过严格深度签名、架构、ASAR与构建输出逐文件一致性、原资源哈希、ZIP完整性及全部ZIP文件/链接与已签名bundle一致性检查。构建与验收日志、源码commit/tree和SHA256保存在隔离worktree的本地证据目录，产物校验成功后才在新干净worktree快进合并本地main。

用户确认本地main合并包含先决发布基线`47626e0`（传输进度/内部存储目录过滤）。禁止push、远程发布及安装；原根工作区分支、HEAD、差异和既有未跟踪文件另行核验。
