# 2026-10-30 本地源码存档

这是 `feat/android-resume-20261027` 上、以 `0906488e5f35d61b7b3c0972f65d4730bbe97783` 为前一检查点的开发存档，不是 Android 开发完成、安装验收、发布或推送记录。

## 保存范围

- Android：引擎无关的启动/控制接口、native-timezone 启动序列化、独立原生时区验收 fixture、原生产品 adapter/overlay 的开发输入、对应测试与交接文档。
- Chromium：追加 `0057` 冻结原生时区和 `0058` Canvas 有界像素访问补丁及清单。`0057` 的配置单例继续使用 `static const base::NoDestructor`；不得改回自动局部对象。既有编号补丁不重写。
- 桌面同步：归属绑定的阶段/字节进度、流式传输及空闲/总时限、受限 sidecar 并发、异步元数据 KDF、组件缓存排除/大小诊断、空间监控目录过滤、IPC/界面/翻译和回归测试。
- 单独保存已有的可见指纹漂移验收 harness。它绑定历史冻结输入和本机专用证据根；本次没有执行它，也不将其描述成当前源码已通过的 GUI 验收。

本地发行 App、安装归档、部署目录、浏览器数据、真实凭据、许可证材料和机器专用构建控制/运行证据不属于这些源码提交。现有产物与证据保留原位，不因存档而清理、迁移或重置预算。此前文档中的未提交/未执行状态是各自阶段的历史快照，不因本次提交而成为新的运行证明。

## 本次实际检查

直接使用已有本地工具，没有调用 `npm test` 的 `pretest`、通用 build、clean、license 注入、依赖安装或原生重建：

```text
node node_modules/typescript/bin/tsc --noEmit --incremental false
actual exit 0

node scripts/check-i18n.mjs
i18n key parity: zh=2225 en=2225
main-process key parity: zh=64 en=64
actual exit 0

node --test mobile/android/native-kernel-tests/fixture.test.mjs mobile/android/probe-tests/native-preflight.test.cjs
21 passed; 0 failed; 0 skipped

node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism <以下八个测试文件>
8 files passed; 386 tests passed
```

八个定向测试文件：

- `tests/unit/chromium-android-timezone-source.test.ts`
- `tests/unit/chromium-canvas-bounded-access-source.test.ts`
- `tests/unit/sync-operation-state.test.ts`
- `tests/unit/sync-operation-transport.test.ts`
- `tests/unit/sync-progress.test.ts`
- `tests/unit/sync-transfer-progress.test.ts`
- `tests/unit/renderer-sync-state.test.ts`
- `tests/unit/storage-monitor.test.ts`

另外实际检查了本次候选中的 6 个 Python 文件 AST、13 个 JavaScript 文件语法、61 项 `PATCHSET.sha256` 文件摘要，以及两份 i18n 镜像的完整字节一致性。验证前后，71 个原始源码候选的 SHA-256 均未变化。上述 Node/VM/source/IPC fixture 测试不是 Android、原生 C++ 或真实浏览器运行证明。

## 原生构建及未完成项

- 本机 `native77-arm-vz-021`（控制代次 536）到原设 Ninja 工作时限，结果为 `timeout` / `Deadline`，宿主总耗时 `10469.965` 秒。没有记录正常 Ninja 退出码，没有 APK，不能把外层非零退出推定为编译器报错。
- 该轮实际记录正常卸载/分离、虚拟机停止、只读配置恢复和停止后释放独占盘锁，清理失败列表为空；已写增量原位保留。没有为存档自动续开新轮、扩容或放宽时限/安全断言。
- `native-kernel/` 产品 adapter 尚未完成真实 GN/Java/C++/JNI/APK 编译和安装。普通浏览继续拒绝未验证准入；原生 Cookie drain 为 `NOT_ATTEMPTED`，完整身份/网络约束/存储生命周期为 `UNVERIFIED`，代理认证为 `UNSUPPORTED`。
- 实际 APK 导出/签名/全字节读回、模拟器安装、native PID/冻结回执、Window 与顺序 Dedicated Workers、真实 `ping0.cc/env` 仍未完成。
- 本次未运行完整桌面数据库/迁移测试套件、Android 宿主 SQLite 全套回归、原生产品构建、GUI E2E、SDK/ADB/模拟器或公开站点验收；已耗尽的宿主 SQLite 测试预算没有重置或借用。

后续编译/导出/安装必须使用与新请求对应的真实准入及产物证据。Git 提交、源码断言或旧代次回执不能替代这些门禁。
