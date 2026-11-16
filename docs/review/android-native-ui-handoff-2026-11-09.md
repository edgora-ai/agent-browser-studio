# Android 原生浏览器 r13k 开发交接（2026-11-09）

## 0. 先读结论

**本轮 UI 修复、原签名候选包构建和指定环境的真机定向回归已完成；整个浏览器尚未达到正式发行标准。** 用户询问“全搞完了？”时，已明确答复没有。当前要求是“先提交更新 handoff”，不是继续构建、操作手机或宣布发行。

本文是最新 Android 状态入口，替代旧交接中的“最新原生产品未构建／未安装”结论。旧报告保留为各自日期的历史快照，不改写旧失败，也不覆盖桌面同步工作线。

- 工作区：`/Users/ahoo/workspace/roxy-lite-cloak-oss`；分支：`feat/android-resume-20261027`。
- 本次归档前 HEAD：`a35b9a75b6239577f8efa6e191bef133f1e8752d`。本次提交自身以 `git log -1` 为准，不将父提交冒充当前代码身份。
- 归档范围：已有 Android 管理器／编辑器／退出控制／浏览器 UI 与字体处理，以及相关合同和新增 host 回归。未引入新的运行时改动。
- 用户仅要求提交；本轮不推送、不安装、不连接手机、不重新构建 APK。
- `.build-source-sha.txt`、`release-1.0.1-20260926-preserved/` 是原有无关未跟踪项，保留且不提交；APK、缓存、密钥、私有备份不加入 Git。

## 1. 交付身份与证据位置

以下路径均相对仓库根。记 `K=.tmp-apk/proxy-fix-work/v13k-ui`；该目录被 Git 忽略，**clone 本仓库不会取得其中的 APK、设备证据、机器专用构建控制器或完整 Chromium 依赖**。

| 文件（位于 K） | 字节数 | SHA256 |
| --- | ---: | --- |
| `ABS-Browser-v1.0.0-ui-r13k-arm64-release-candidate.apk` | 369843079 | `7d3a43a3da1bfcb85569837a9d380eee0437c4f548365629afe57158c84b718d` |
| `product-v13k-ui-input.tar` | 757760 | `2dfa602d11e21d1eb7df3469d1e0f4b1968d8cb83aa233bdc378245c76c175fa` |
| `ABS-Browser-r13k-QA-evidence.zip` | 2486259 | `cad51da06447cc7b215471de3266a119d9143909074a4c199b487215d81cbe0d` |
| `R13K-交付说明.md` | 5337 | `a5e93abffd688081ce4936ca48e07681453b171cf9b37370b803ceb9c25d95e4` |

- 包名 `com.ahoo.abs.browser`；versionName `1.0.0`、versionCode `10000`；ARM64；minSdk 29／targetSdk 36；`debuggable=false`；APK v3／RSA4096。
- 原签名证书 SHA256：`0f186dd70f80892e04443b7105842eef2ac9e641e9ecefa15015158317f1402f`。延续既有安装身份，不是新的商业签名迁移承诺。
- 产品输入 tar 有 74 个普通文件，其中 72 个产品输入；**只是覆盖包，不是完整 Chromium 源码**。
- 产品源清单 SHA256：`44ea04e6e5cff44ceb5dc338f749978a049d44cafd426b792ec0b53798e086f1`。提交前重新调用只读 `collect_inputs()/manifest()`，全部 72 个输入与实际构建 tar 中的清单一致。
- ZIP 共 95 项，原始 PNG/XML、成功与失败 receipts、冻结源码／测试输入、日志及清理凭据带逐文件摘要；不含 APK 副本、密钥、私有数据备份或完整 Chromium 树。
- 构建／签名／静态检查身份见 `candidate-build-receipt.json`、`signing-receipt.json`、`analysis-receipt.json`；后续运行观察见 `runtime-review-receipt.json` 与 `delivery-receipt.json`。原始仅构建回执的 `NOT_RUNTIME_ACCEPTED` 是当时状态，保持不改写，不与后续定向观察混淆。

## 2. 本次归档的源码工作

累计相对归档前 HEAD 的 Android 工作包括：

- `Ui`、管理器与环境／代理编辑器：中性浅深色层级、触达与排版、常驻标签、错误与异步反馈归属、Sheet 操作闭环。
- `LaunchCoordinator`、`MainActivity`：退出控制代际／超时／重绑门禁和 session/nonce 验证；不得以回到管理器、Activity finish 或超时假装环境已关闭。
- 浏览器外壳、新标签页、历史、标签总览与弹层：owner-scoped 调色板／字体绑定、保留已有 View、字体变化原位处理、系统栏与输入焦点相关回归。
- manifest 包含 `orientation|screenSize|keyboardHidden|uiMode|fontScale` 配置处理；字体按原始 SP 重新绑定。不得用 PX／缩小字体／全局 View 注册表／跳过生命周期来补绿。
- r13k 相对 r13j 只改两处生产 Java 的三个布局 helper：新标签页把 History 放到身份行下方；两处空编辑器提示缩为“搜索”，完整描述仍为“搜索或输入网址”。访问时间与次数允许多行，保留原有 SP 和行为。
- 新增 palette、tab overview、system bars、font ownership、new-tab tile 的 host 测试和 tile runner；原 source-contract／主 runner 同步扩展。

关键冻结摘要：

| 输入 | SHA256 |
| --- | --- |
| `NewTabPage.java` | `f8f194c743f56a2a505065d7b33769d4289ba62e9c54558a3d88de5d2e2eff62` |
| `NativeBrowserActivity.java` | `a9daadb3ea43fc93221a0d174e4c897425d765bd44e6057af0433aa4c31d7513` |
| `NativeNewTabTileHostTest.java` | `16a3d65558c509611be7956ef1f6c0c0bc7b1d0d638615c8676d02b35508a424` |
| `NativeBrowserUiSourceContractTest.java` | `b9400cc27a231f3472341ac2df15f4931384dc3df2ff91fa15c4ab0f581963aa` |

完整六个 source pins／十一个 host pins 见 `K/reviewed-build-inputs.json`，不是只凭上述四个摘要推断全部相符。

## 3. 构建与提交前回归

### 已消费的 r13k 构建

- 远端：`ahoo@192.168.4.12:/home/ahoo/abs-native-work/chromium-build-152/src`。
- 实际执行 `autoninja -C out/abs-timezone-newyork -j2 agent_browser_product_apk`，7/7、`REMOTE_NINJA_RC=0`；产物来自 `apks/ABSBrowser.apk`。
- build ID `033e72e3-955d-4781-9c83-c316357aaf23`；本轮 ErrorProne／validate_deps 的 QUEUED 与 FINISHED 对应，未以入队当完成、未关闭检查。
- 远端 args.gn SHA256 `ab0ccecc8193675d588fc62e83713dcd8f6a53cb84dd57cdd31b5e5889341c51`，306 字节；构建后只读复验字节／大小／mtime 未变。
- **不要重跑 `build_r13k.py` 或任何已执行的设备一次性脚本；不要触碰受保护的 ninja306540、`out/AgentBrowserRelease` 或擅自改 GN／恢复其他工作线。** 新构建必须重新准入、审查当时源码、并发与输出身份。

### 本次提交前新增的 host 复跑

`K/handoff-commit-host-run1/receipt.json`：`COMMIT_HOST_RERUN_PASS_NOT_ANDROID_RUNTIME`，两个 runner 均 exit 0，9 组共 **138174** 项断言，72 个产品输入与 17 个冻结 source/test pins 在前后不变；没有编译 APK／安装／设备操作。

- legacy/source/lifecycle/focus/palette/overview/system-bars/font 共 4914 项。
- tile 共 133260 项：原 90 cases／450 状态保留；新增 18 个空编辑器 cases／90 状态；6 个敏感性反例均被拒绝。
- 日志：`suite-1.log` SHA256 `84144628d0f02bada408857368e0ade0ba0496d0ea0885a409098a90ff7de75d`；`suite-2.log` SHA256 `f26422a2c2c952b31a45d36946a06bc1fb6ac6017cdbd9e448aa1c6682b370db`。
- 另行复跑启动／退出合同：`FreshSessionLaunchContractTest` **213 checks passed**，见同目录 `launch-contracts.log`；这也是 host doubles，不是额外真机验收。
- 独立只读归档审阅未发现明确阻断提交的差异问题，重新计算17个冻结输入摘要均匹配；该审阅没有执行测试／构建／设备操作，不是完整正确性证明。
- 本次 tile 的保留输出：`.tmp-apk/proxy-fix-work/v13j-font-tests/tests.ncug0Y`。runner 沿用历史目录名，不代表测了 r13j；实际源码摘要为上述 r13k NTP。
- 主机模拟不是 Android shaping／绘制／IME／TalkBack，也不能证明所有生命周期和视觉质量。此次 host 复跑发生在已交付 evidence ZIP 之后，未重写该 ZIP。

未来重跑先阅读两个 runner：`run-tests.sh` 可接工作区参数及 `NATIVE_HISTORY_TEST_OUTPUT_ROOT`；`run-newtab-tile-tests.sh` **不能接工作区参数**，仅可选 `--fixture-control`。使用新保留目录，不删除失败产物补绿。

## 4. 真机已观察到的范围

设备为用户授权的 OnePlus `PKG110`，Android 16／API 36。实际截图 1080×2376、480dpi，即 **360dp 竖屏**，不是 1080dp；原有 wm 覆盖保持不变。

| K 内 session | 已观察结论 | 不可外推 |
| --- | --- | --- |
| `phone-r13k-continuity-run1` | 升级后管理器3环境／2代理；仅打开 UI-Demo；History 中 ping0.cc=3次、ui.test=6次 | 不代表其他环境逐一验证、私有数据字节相等或 Cookie 持久性 |
| `phone-r13k-font-matrix-run1` | 1.0→1.3→2.0→重复2.0→1.0；同 PID24514／已有 Activity/View tokens；重复200%稳定，恢复100%几何一致 | 只证明保留实例配置变化，不是销毁重建、崩溃恢复 |
| `phone-r13k-editor-run1` | 精确草稿、焦点、IME 在1.0→2.0→1.0保持；随后只删除QA草稿并收起键盘；未提交或导航 | 未测选区偏移／组合输入／其他输入法 |
| `phone-r13k-confirm-exit-reopen-run1` | 正常确认退出后旧 native PID24514不存在；仅重开UI-Demo，新PID31937，历史仍3／6 | 不等于所有存储 flush 完整、Cookie／登录长期有效 |

- 唯一一次原签名覆盖安装保留 UID10629、CE inode2984885、DE inode2984897、firstInstallTime `2026-11-05 21:35:16`。这是元数据连续性，不是完整备份或数据相等证明。
- 原始截图已由 Lead 查看，另有独立只读复核：100/130/200% 首页身份说明与 History 分离，两处搜索提示和“前往”可见，200% 次数完整换行。首个站点标题仍可省略为 `ping…`。
- 200% 键盘图显示编辑器的横向滚动后缀及末尾 caret，全文由 XML／receipt 核对，不误判被滚出屏幕的前缀丢失。下方卡片部分被键盘遮挡，滚动可达性尚未单独验收。
- 最后采样是 UI-Demo 首页、font1.0、IME关闭、QA草稿已清理；不是本次提交时新采样，也不保证进程此后未被系统回收。

### 必须保留的失败

`phone-r13k-exit-reopen-run1` 仍为 `STOPPED_REVIEW_REQUIRED_NO_RETRY / AssertionError()`：脚本期望独立文本“环境：UI-Demo”，实际与完整退出后果合在同一个 TextView，**停止在确认按钮之前**。检查原 XML/PNG 后，单独建立 fresh-identity／精确全文守卫的 continuation，继续当前尚未确认的对话框；没有重跑安装、原脚本或前序输入。原失败及 selector review 原样保留，不能改写为通过或描述成产品崩溃。

历史 r13h 大字体 onCreate SIGSEGV、r13j host/emulator 通过却在手机发现裁切等证据也保留；不要用旧版本图或旧主机绿灯冒充 r13k 真机证明。

### 再次接设备前

- ADB 本机路径 `.tmp-apk/v6-emulator/sdk/platform-tools/adb`；历史授权 TLS alias `adb-69a2181d-5sUDJE._adb-tls-connect._tcp`、server `127.0.0.1:5037`，USB serial `69a2181d`。这些是历史连接信息，不保证当前可用。
- 后续必须重新确认授权、设备型号／serial／安装 APK 摘要、解锁和自有前台；使用显式 transport 与 `ADB_MDNS_AUTO_CONNECT=0`，不得回退默认设备、重置 ADB 或连到无关模拟器。
- 只操作自有包；锁屏／无关前台即停。不得卸载、clear-data、force-stop、删历史、root／读取私有数据，或为补证据覆盖已有用户草稿。

## 5. 未闭环项与下一步顺序

1. **评分与网络证据先行**：真实公网 DNS 国家混杂／实际解析链和 RAF 帧调度尚未完成最终根因验证与复测。先在受控、经授权环境采集真实网络与性能证据，再决定修改；禁止硬编码检测值、用旧分数替代本轮结果或伪造通过。
2. **数据可靠性**：专门验证正常进程切换的 Cookie／登录保持、其他环境隔离与网络路径，再做经授权的 crash／LMK／重启／断电及长时间矩阵。正常退出一次和历史次数保持不能代替这些结果。
3. **产品完整性**：标签总览的本轮物理设备验证、130/200% History、多机型／方向／窄屏／长名字、TalkBack、组合输入与键盘遮挡下的内容可达性。不得给虚构数字评分或声称已超过微信／美团；仍欠用户审美验收。
4. **发行／源码闭环**：匹配完整 Chromium／DEPS、全部基线与补丁来源、工具链、可重复构建、NOTICE／credits 和分发配套。远端曾只有空树 HEAD／缺少基线关系；现有72输入覆盖包不能冒充完整源码发布。

这四类问题没有因本次 commit 而解决；继续工作应明确每轮范围、证据等级和真实失败，不能再把“这一轮完成”说成“全量完成”。

## 6. 清理和恢复保护

- 本轮只删除已完成的未签名 k 中间 APK 369789632 字节；此前6个明确文件2218856280字节。累计7个文件 **2588645912字节（约2.59GB／2.41GiB）**；APFS实际空闲增加未实测。
- 凭据：`K/lead-cleanup-plan-run1.json`、`K/lead-cleanup-execution-run1.json`，以及 `v13j-ui` 中对应历史记录。
- 保留 k 原签名候选、j 签名回退包（SHA `22de220e7c9e82c617b249000a5985c00c06c0dac24aa1427f65662aa6bb4556`）、r12b 回退包（SHA `0ef79bde291fd0b9d6f6fe69df78192b363f88330f9c368a7036ffc7d0dcb008`）、源码、失败证据、签名身份和环境数据。
- 不递归清理 Chromium out／SDK／AVD／源树；删除前必须核验精确绝对路径、文件身份／摘要及保留件。不要把本地忽略目录当成可重建垃圾。

历史入口：[2026-10-31 跨机器交接](android-native-development-handoff-2026-10-31.md)。本地旧 UI 快照 `output/android-ui-handoff-20261108.md` 与 `deployment-artifacts/android-native-v12-ui-20261108/HANDOFF-当前状态-r12b.md` 仅作历史参考。
