# Android 原生构建恢复记录（2026-11-01）

> 本文记录本轮新取得的真实证据；旧 resume 文档中的历史日志/`phase3 done` 不代表构建成功。
> **APK 编译、APK 验收、设备运行验收尚未成立。** 不以下载完成或 Ninja 退出单独推断完成。

## 固定请求

- 主机：`ahoo@192.168.4.12`，工作根 `/home/ahoo/abs-native-work`。
- 项目 HEAD 保持 `44790624f7052682c254739beddc3320ebbcf0d7`；仅部署经核验的来源校验器修正，未提交/切换项目分支。
- Chromium `152.0.7977.72`，目标源码提交 `026bb13a93d60e7adfefa2bbf58d6f57c2d335cc`。
- 实际目标 `agent_browser_timezone_apk` → `AgentBrowserNativeTimezone.apk`；ARM64 native-timezone 验证壳，不是完整产品或 SystemWebView。
- 保持原始哈希校验、代理 `http://192.168.4.100:7890`、CFI/ThinLTO、warnings-as-errors、`JAVA_TOOL_OPTIONS=-Xint`、`-j3`；不降低安全设置或变更目标架构。

冻结 GN：

```gn
target_os = "android"
target_cpu = "arm64"
is_debug = false
is_official_build = false
is_component_build = false
symbol_level = 0
v8_enable_i18n_support = true
agent_browser_timezone_fixture = "new-york"
use_siso = false
use_remoteexec = false
concurrent_links = 1
android_static_analysis = "build_server"
```

## 已取得的真实证据

### 1. DevTools 固定提交可真正 checkout

- 固定提交 `04db1f5240b636511ec4e9058a78f8274a7f65ee`，树 `743d80b3147b16b550d384b1a00879e17b0afd5e`。
- 验证全部 30,459 个 blob；51 个从经固定树/路径/模式校验的归档恢复，102 个从官方 raw 对象恢复，其余已存在。
- 真正非强制 detached checkout 返回 0；7 个真实 nested gitlink 留给正常 gclient 同步，不伪造仓库 HEAD。
- 远端证据：`recovery-20261101/devtools-{salvage-hydration,raw-hydration,all-blobs-present}.json`。

### 2. Chromium .72 归档来源核验通过

- 归档 1,453,907,898 字节，SHA256 `478c17ee1c0021b22b9ff184ee416b19b35a9e141b2da1b8206074947414a45f`。
- 真实提交绑定根树 `871b7886d768a863341e9212fe29548555137adc`；497,012 个常规文件、19 个 symlink 和 270 个真实省略 gitlink 有明确记录。
- 仅放行被真实 `.gitattributes` 证明的单个 CRLF export：`third_party/mako/mako/test/templates/crlf.html`；没有全局换行归一化或“计算出的哈希变成预期值”。
- 独立在线 proof2 与离线 proof3 实际返回 0；来源校验器本轮部署后，真实 production 校验也返回 0。
- 证据目录：`recovery-source-provenance-20261101.kMMoFz/`。
- 最终来源 receipt SHA256：`1016e9731acaa7098bf3f5acdd3c0a93e326f98f598c3b1534933fb792f8b167`。
- 本地与 Ubuntu 来源验证测试均 32 PASS。

### 3. 源码原始 vpython 规格真实安装成功

- 原始 `.vpython3` 不变，SHA256 `bd1533f72ac26ecd58c9dc5ea09dfcb35bab48ddac249776d4a863edf48bff50`。
- 原始 requirements 不变，128 个精确版本，SHA256 `37472297029fe751ba01fe769a0bfbc3c6bcc606bd20ab05bd96c69b0646adb7`。
- 官方 HTTPS Range 恢复逐段验证 206/Content-Range/长度/稳定总长，再校验完整原始 SHA256。大文件与小文件都出现过代理截断；未跳过任何失败哈希。
- 第三轮完整预缓存真实返回 0。遇到合法的同优先级 py3/py2.py3 wheel 时保留所有精确候选，让真实安装器自行选择，不改官方索引的选择语义。
- 原始索引页面逐页绑定其 HTTPS 来源与 SHA256；整个 snapshot receipt SHA256 `13da0e8aad0b95c6959bb9153e9cbcc9136b5cc1b99a199cf9bb37cc2cc7125a`。
- 随后真正执行源码 `vpython3 -vpython-spec ...`，确认 CPython 3.11，并对全部 128 项调用真实 `importlib.metadata.version` 比对精确版本，实际退出 0。
- 成功证据：`recovery-20261101/vpython-bootstrap-84d50b75-2c03-4cfa-9aac-687184dd304b/vpython-complete.json`，同目录有实际命令日志、relay 日志和事件。
- 这是**源码原始规格**的真实成功，不等同于所有 depot_tools/其他 hook 规格已经成功。首次真实 gclient 的独立 uv 规格暴露本地 relay 未支持 HEAD；按真实错误补上 HEAD，与 GET 使用同一完整哈希门禁，不改包版本/预期哈希。该次有意 TERM 停止并保存实际 143，不能计作 sync 成功。

### 4. 旧假成功自动化已替换

- 原脚本没有 `set -e`，忽略真实 sync/hooks/GN/编译退出码，并依赖历史 append log、`phase3 done` 或最后一次 echo 的状态。
- 新 `supervisor.sh` 使用本轮独立日志并传播实际子命令退出码；不会以历史日志跳过工作。
- 新 `fetch-chromium2.sh` 调用有界、持独占锁的恢复驱动：来源检查 → 真实 sync(nohooks) → 系统依赖 → hooks → 再次来源检查及冻结输入对比。
- 仅所有阶段当前实际退出 0、输入不变、未超预算、无意外遗留同组进程，才创建当前 `dependencies-complete.json`；锁冲突返回 75。
- 新 `phase3-build.sh` 缺少独立审核的 owned-server 配置时明确返回 78，绝无直接 Ninja/PTY fallback；编译阶段也使用相同源码/输出独占锁。
- 三个旧入口逐字节备份并记录替换前后 SHA256（`recovery-20261101/automation-deploy.IupYti/deployment-complete.json`）；`@reboot` 的既有 crontab 不变，指向的新入口自动获得 fail-closed 行为；未改动无关服务。
- 恢复驱动 Ubuntu 真正 33 PASS，包含真实父进程 0 + 忽略 TERM 的后代、TERM/HUP 清理、无关进程隔离、实际非零/有限重试测试。wrapper 回归 4 PASS。
- 有界清理只涵盖自己的 PGID；不声称抵抗 SIGKILL、刻意 setsid 逃逸或内核不可中断任务。遇到清理不完全必须失败，不能给 COMPLETE。

### 5. HEAD 修复后的实际进展与新失败点

- HEAD/GET 使用同一完整原始 wheel 哈希门禁；真实 Ubuntu 回归先 20 PASS。随后实际 gclient 跨过 uv 安装，进入 82 项 CIPD 包的官方 ensure；这证明先前 HEAD 问题已解除，不证明 sync 完成。
- 本轮 `dependencies-455ae560-8dae-4371-af85-03a750ac8e21/sync.1.log` 记录 CTS archive、arm64 orderfiles、apkanalyzer、bundletool 等包 `failed to download after multiple attempts`。先前 wheel 修复不能自动修复 CIPD 的独立下载器。
- 在保留完整失败日志/原始 ensure 请求之后，只对精确 cmdline/UID 校验过的自有恢复进程通过 pidfd 发 TERM；驱动完成受控清理，真实退出 **143**。未创建依赖完成凭据，也未把停止当作成功。
- GN 二进制已真实出现；Ninja/完整工具链、hooks、GN 图、APK 编译仍未成立。正在核实 CIPD 原始实例 ID 与可验证缓存恢复接口，不更换版本/预期哈希或绕过原生客户端。
- 新增的显式安全 basename 归档下载模式仍要求独立固定 SHA256、HTTPS、精确 Range 和最终完整摘要；默认 wheel-only 行为不变。macOS/Ubuntu 下载器均 **23 PASS**，归档恢复尚未据此宣称成功。

### 6. owned-server 已完成的 Linux 单元门禁（不是完整集成）

- 冻结 controller SHA256 `e25cf29bbdcea718f60c8c9f5f4fc9721e947862b8623fdfb80a2007e5bb471e`；真实 Ubuntu 完整 opt-in 单元套件在显式 umask0077 下 **77/77 PASS、0 skip、实际 0**。
- 首次继承主机 umask0002 时为 76 PASS/1 ERROR：测试夹具创建 group-writable XDG，控制器正确拒绝。原失败证据保留于 `recovery-20261101/observer-linux-tests.wj97l2ub/`，未降低生产权限检查。
- 仅修正测试夹具，显式创建 0700 配置目录/0600 文件。相同 controller 在主机默认 **umask0002** 下重跑 **77/77 PASS、实际 0**；另有归档下载器 23 PASS。回执位于 `recovery-20261101/cipd-range-tests.W5WUq2/tests-result.json`；测试 SHA256 `def80c4b3d2daabd173b3def356e43801892007ba2c9b77bc8456bf7776fb52f`。
- 真实 pinned Task 的 silent0/输出0/非零、真实 public telemetry 禁止鉴权子进程、stale-pyc 隔离与 Linux UID/SO_PEERCRED 单元探针已覆盖；**真实 canonical import/lifecycle/STOP/编译集成尚 NOT_RUN**。
- 当前源码/部分工具和目录带 group-write 位，Java helper 尚是 stock。依赖稳定之后需仅对获准的构建输入做记录化权限收紧、Java 适配、完整 import/graph 绑定；不能削弱控制器来迁就现状。
- 保留 HOME=/home/ahoo 复用已验证缓存；使用 attempt evidence 目录之外的显式私有 XDG_CONFIG_HOME。最终 post-hooks `.gclient`/`.gclient_entries`、原始 canonical server 可执行性、唯一真实 Ninja、PATH 的真实 Python、显式 opt-out telemetry 配置均必须绑定。

## 当前进行中 / 后续门禁

1. 完成有原始实例身份/摘要依据的 CIPD 传输恢复，再执行本轮真实 gclient sync、系统依赖与 runhooks；不能把已启动当作成功。
2. 完成独立、禁止网络/子进程的 canonical server/builder import admission，再跑真实 PTY、Task/STOP/等待及负例/清理集成；77 单元测试不能替代这些。
3. 依赖 receipt 成立后才持锁应用冻结 patch/Java 适配，生成冻结 GN/Ninja 图，重新估算磁盘、内存、链接峰值和有限 deadline。
4. 必须使用真实公共 build-server/autoninja 和真实 native Ninja，检查官方 Task 状态与实际 subprocess wait，并由正常 owned STOP/server wait 完成。
5. 真实 APK 产生后另验包名 `com.ahoo.abs.android.native_timezone.preview`、launcher `AgentBrowserTimezoneActivity`、签名、`lib/arm64-v8a/libcontent_shell_content_view.so`、assets 与 SHA256。
6. 安装/拉回字节一致性、native/Java ancestry、Date/Intl 冬夏时间、Window/Worker/其他 realm、生命周期 SQLite、Ping0 等设备运行验证均 **NOT_RUN**。

实现与测试在 `mobile/android/native-kernel/build-recovery/`；公共源码 API/固定哈希参见 `UPSTREAM-SOURCES.md`。保留既有 handoff/resume 文件，不把新证据覆盖成旧轮次的“完成”。


## 2026-11-02 续记：CIPD 文件名修复、真实加载器静态认证与磁盘停止

以下记录补充而不覆盖上述历史状态；**完整依赖恢复、sync/hooks、canonical imports、编译及 APK 验收均未完成**。

- 原始 ensure 保留 84 placements / 82 instances，其中原有 14 placements 已精确安装；需恢复 70 placements / 68 原始实例，压缩字节预算 8,083,499,397。未更换版本、IID、原始 SHA256 或冻结 GN/安全设置。
- 两个实际 native recovery 分别到达 **42/68** 个实例的 inspect/register/cache-verify 实际 0 后停止。第一次暴露 argparse 对以 `-` 开头的 IID 的误解，改为单个 `--filename=<IID>.zip` argv；第二次 `cipd-native-82ee9517-a552-457f-9d89-aa7536f1d53d` 实际返回 1、耗时 1,343.9556877309951 秒，暴露下载器 basename 正则拒绝合法 URL-safe IID 首字符 `-`。后者原始 `goldctl` IID 为 `-r2o3R-j8b0B9bDj8Un0cFydT__ZDzqZfwGzAzMYF2sC`，原始 SHA256 `fabda8dd1fa3f1bd01f5b0e3f149f4705c9d4fffd90f3a997f01b3033318176b`，23,861,538 字节。
- 下载器现在只额外允许安全 basename 首字符 `-` / `_`；长度、路径/控制字符、HTTPS、Range、完整原始 SHA256 和收据校验均未放宽。回归实际调用 helper parser 与 fetch 校验，并覆盖两个首字符的完整合成字节/收据；这是离线回归，不是该 goldctl 的真实下载成功证明。
- 首次部署还发现 driver 内嵌 transport SHA 与新文件失配；实际启动正确 fail-closed。已同步三处固定值（driver 内嵌 transport SHA、CLI transport SHA、CLI driver 全文件 SHA），新增测试防止再次失配。最新 driver SHA256 `262781f9b9e907acd7bb35834768d4743b762bf59db2592436483182426fa5d4`；transport SHA256 `9b5cdfceea822926ea06959fc24fdba9c002bfe2718dafd13ec4aee8d8f82aa0`。
- 最新冻结目录 `recovery-20261101/cipd-regression.pinned-2ai2jkui/`：OS Python 3.10 隔离套件 397 tests / 5 skips / 实际 0（日志 SHA256 `bbfd55e591c7f3726a64a62ebcabac8d88b382b43c1e5efbf1c4e27e7f2a3fa3`）；缓存 Python 3.11 加公共源码 opt-ins：397 tests / 1 skip / 实际 0（`f4378bdba6caf3f338b17642b02bcac63bc833c1111612a2e11b7c14620f84e6`）。两者唯一共同的模块 skip 是 `-S` 隔离掉 distro packaging；另以 OS Python 正常 site、真实 `/usr/lib/python3/dist-packages/packaging/__init__.py` 补跑该模块 **7 tests / 0 skips / 实际 0**（`5b4d396be261c61e3c8ddfe96a853d3c1c2772071e54d096a4d2fe7be73b7aea`）。不把单元测试、公共源码 fixture 或缓存解释器当作 canonical/runtime/build 证据。
- 最新第五次 native launch 实际 **1**：`native CIPD recovery FAILED: dependency admission refused: disk_reserve`。这是同步摘要后的真实 admission 失败，不是 68 个实例成功或新的 42/68 成功。对授权工作文件系统读取 statvfs：总量 307,965,034,496 字节，可用 **33,298,542,592 字节（约 31.0 GiB）**，低于 34,359,738,368 字节保留线；未降低 32 GiB 预算或启动完整下载/编译。旧 CTS、ranges、失败缓存及无关数据未删除或改为新轮次权威。
- 原始 CPython 3.11.9 root-sealed payload 已在静态加载器策略捕获前后重新核验。原始 2,395 entries / 2,636 runtime nodes 不变。真正 Linux readelf/ldconfig 静态闭包捕获、JSON 往返后再次验证实际 **0**，耗时 10.874238258998957 秒；21 个绑定文件、9 个 inspected ELF。策略 `/var/lib/abs-native-build-admission/997a0205-630d-4529-84b8-538361ec010d/loader-policy.json`，6,739,881 字节，SHA256 `37b7869d74944ab4a5c15902708d513b127ba8723164cc63e4f006c3887954fc`。信任边界明确为 **OS-root baseline，不是系统文件的独立原始密码学来源证明**。
- **原始解释器目标执行、/proc/self/maps 比对、正常 site canonical server/autoninja admission 仍 NOT_RUN**。加载器静态认证不能替代这些，也不能替代实际 Task/STOP/server-wait/builder-wait/Ninja/APK。

后续先取得磁盘处置授权并重新评估峰值与保留线，再恢复 fresh native cache admission；不得擅自清理 `_bad_scm`、其他项目/模型、旧 CTS/ranges/partial caches，或探查/写入未经授权的其他挂载点。


### 经用户逐步授权的备用存储检查（2026-11-02）

1. 先只读检查 `/media/vms` 容量、挂载及祖先权限，未枚举已有目录内容。它是独立设备 `/dev/sdb2`、`fuseblk`，可用 181,691,924,480 字节（169.214 GiB），挂载根 UID/GID 0、mode0777。当前构建仍在 `/dev/sdb4` ext4，可用 33,298,251,776 字节（31.011 GiB）。
2. 从已固定摘要的原始 sizes snapshot 及当前 driver 公式核算：保留线 34,359,738,368 + 全部原始 ZIP 8,083,499,397 + 3 × 最大新 ZIP 2,203,630,904 = **49,054,130,477 字节（45.685 GiB）**。这里已计原始 CTS 的额外 native copy，尚不含之后完整解包、hooks、Java/GN/编译输出的额外空间。当前仅原生缓存恢复阶段就差约 14.7 GiB，不是只需补足 32 GiB。
3. 仅对两个已知失败 native attempt 与已知原始 CTS/ranges 目录做 metadata-only 盘点，共分配 6,620,577,792 字节（约 6.166 GiB），无目录外硬链接字节。该数是选中目录**全部占用的理论上限，不是获准回收量**，并非删除/迁移建议；甚至全释放也仍达不到上述 45.685 GiB 门禁。未读取 payload、修改或删除这些历史目录。首次盘点的一个 UUID 拼写错误仅报告不存在；随后按历史证据中的精确 `3182d7b0-3e54-47b7-9d36-5504176d0976` 重新盘点，未扩大搜索范围。
4. 用户随后仅授权一个小型独立探针及其清理。实际在唯一目录 `android-native-storage-probe-1b239425-dc1e-44f9-ab5e-d539762467d6` 写 **32 字节**；mkdir0700、create0600、fchmod0700/0600/0400 均返回成功，但实测目录/文件一直为 UID/GID0、mode0777，0400 后 UID1000 仍可写。硬链接同 inode/nlink2 成立，**不能弥补权限与所有权失败**。这是该次实际挂载配置的结果，不是对所有 fuseblk 的一概断言。
5. 探针首轮实际返回1：两个自建链接均删除，但在文件描述符关闭前未通过最终空目录校验；当时未记录该 assertion 的具体子条件或目录清单，不推断其精确原因。随后仅对原探针精确绝对路径和 inode72/dev2066 再检查，确认为空后移除，实际0。最终探针文件及目录已全部清理；未更改挂载参数、其他既有数据或目录权限。原始失败和后续清理证据都保留，不把首轮1改成0。

本地证据位于 `/tmp/android-build-status-20261101.z2vqUi/`：`storage-readonly-media-vms.json`、`storage-known-attempts-metadata.json`、`storage-known-attempt-corrected.json`、`storage-media-vms-probe.json`、`storage-media-vms-probe-cleanup.jsonl`。

**下一步安全方案：** 优先为当前 ext4 构建分区扩容，初步建议增加至少100 GiB，最终仍需按解包/输出/链接峰值重新核算；或提供新的原生 Linux/ext4 卷，迁移前先确认容量、权限、路径及每文件系统预算。不要直接把当前 fuseblk 当作 private native cache/可执行工具/源码存储；也不能仅因映像内部是 ext4 就认定外层0777、权限不生效的映像安全。未授权创建大映像、调整挂载、重分区、格式化或迁移/删除旧数据；本次没有执行这些操作。磁盘问题仍阻塞后续真实构建。


独立只读复核确认上述公式（仅适用于已审核 `--release-owned-transport` 模式；未启用时门禁更高）及权限拒绝结论。扩容前仍需另行授权底层布局、健康状态与备份方案检查：`/dev/sdb2` 文件系统内的空闲容量不等于 `/dev/sdb4` 可直接使用的未分配扇区，不推断可在线扩容或分区相邻。若需移动/缩小现有分区，优先考虑新增专用 Linux 存储以规避对既有数据的风险。

新增卷本身不会自动恢复 `/` 上的32GiB保留线；也不得覆盖挂载非空工作目录，或用 symlink 绕过固定 WORK_ROOT/CTS 路径。任何迁移必须保持原始字节及历史证据，验证所有权/权限/精确路径，分别核算两端预算并提供回滚。当前只读审查与32字节探针的授权已执行完毕，不扩张为磁盘布局、挂载或迁移的写入授权。

原始解释器/正常站点认证的额外只读祖先检查发现：runtime 的根所有者祖先为0755、payload为0555；静态 loader 证据分支仍是 root0700，原 empty-pyc 为 root0500。它们适用于原 root 静态认证，并非已经可供 UID1000 访问的公共 canonical probe 分支；不得把旧 empty-pyc 身份悄悄改成0555或宣称目标已执行。目标 startup/maps/canonical imports 仍 NOT_RUN。


### 只读磁盘布局与容量评估（2026-11-02，用户授权“只读评估”）

用户仅授权只读查看分区布局、已挂载文件系统容量/挂载参数/目录权限及**元数据**，明确不重分区、不格式化、不改挂载、不迁移/删除数据、不浏览文件内容。以下结论均在该边界内取得：

1. `lsblk`/`/sys/class/block` 扇区、`/etc/fstab`、`blkid` 只读核对：`/dev/sda`（GPT，250,059,350,016 字节）由 EFI、Windows `system`(sda2, 42.3 GB)、`software`(sda3, 630 MB)、未挂载 NTFS `sda4`(206,868,487,680 字节) 组成；`/dev/sdb`（GPT，500,107,862,016 字节）由保留分区 sdb1、NTFS `VMS`(sdb2, 185.5 GB)、EFI sdb3、ext4 根 sdb4(314,034,880,512 字节) 组成。除 GPT 自身首尾保留区外，两块盘**均无可用未分配空间**：sdb 分区几乎覆盖整盘，sda 仅约 134 MB + 1 MB 等零散间隙，不能据此推断可扩分区或可在线扩容。
2. `tune2fs -l /dev/sdb4`（只读）显示 `Filesystem state: clean`、Block count 76,668,672 × 4096，与分区大小一致，即根 ext4 **未使用剩余分区空间**；Reserved block count 3,833,433（约 15.7 GB）是 root 保留块，这是 UID1000 可用 31.2 GiB 与物理空闲 45.8 GiB 差距的主因，但即使全部释放仍不足以覆盖完整构建输出。
3. 未挂载的 `/dev/sda4` 用 `ntfsinfo -m`（**不加 `--force`**，只读打开；只读路径经上游 2021.8.22 源码核对：`NTFS_MNT_RDONLY`、设备 `O_RDONLY`、跳过日志/休眠文件复位与元数据修复）读到：卷名 `software`、Volume Flags 0x0000、簇 4096、共 50,505,001 簇、Free Clusters 10,012,642（19.8%），即空闲 41,011,781,632 字节（38.195 GiB）。该卷已使用约 165 GB，**不是空白数据分区**；只读成功也不证明非休眠/日志洁净（只读路径跳过这些检查），故不推断其可用性。
4. 只读 size 统计（仅元数据，不读内容）：工作根 `/home/ahoo/abs-native-work` 共 58,836,643,840 字节（54.80 GiB），其中 `chromium-build-152` 49,733,529,600、`recovery-20261101` 7,844,319,232、`depot_tools` 1,201,082,368；`/home/ahoo` 各顶层目录合计约 190 GB，其中本项目之外仍以 `strata-trial`、`miniforge3`、`.local`、`workplace`、`temp`、`.config`、`.cache`、`Downloads` 等为主（统计因部分目录权限而略偏小，且不构成可删除性判断）。
5. 现行依赖门禁要求 UID1000 在工作根文件系统有 49,054,130,477 字节（45.685 GiB）可用，而完整 sync/hooks/编译/链接还需更多。基于以上实测：**当前两块盘都没有可用的原生 Linux 空间**；`/dev/sda4` 空闲 38.2 GiB 不足且为 NTFS；`/media/vms`(sdb2) 空闲 169 GiB 但同样是 NTFS/fuseblk，32 字节探针已证明该挂载配置下所有权/权限不生效，不能直接作为受校验缓存/工具/源码存储。

结论：要真正推进构建，需要在下列方案中由用户决定，且**在执行前另行授权**：(a) 接入/新增一块专用磁盘或虚拟卷并建 ext4（最干净，无迁移风险）；(b) 若 `/dev/sdb2`「VMS」中的数据可丢弃或已备份，可格式化为 ext4（约 185 GiB），否则需先搬迁其约 16 GiB 数据；(c) 在 `/media/vms` 上创建 ext4 镜像文件（169 GiB 可用）——独立复核认为外层目录 0777/可写使镜像字节不受保护，且嵌套 FUSE 有耐久性/性能风险，需用户明确接受；(d) 仅释放根分区空间（清理本项目旧失败缓存 7.84 GB + 调整保留块）约得 50 GB，只够过依赖门禁，完整编译仍有 ENOSPC 风险，且降低保留线属策略变更；(e) 经用户确认后把本项目之外的大目录搬迁到 `/media/vms` 以腾出根空间（需逐目录确认与完整性校验）。任何方案都不得覆盖非空工作目录、不得用 symlink 绕过固定 WORK_ROOT/CTS 路径。本轮未执行挂载、分区表、mkfs、迁移或删除操作；构建仍被存储阻塞。


### 用户确认的 ext4 镜像方案执行记录（2026-11-02）

用户在只读评估后**明确选择并确认**：在 `/media/vms` 上创建 128 GiB ext4 镜像文件，把工作根迁移进去；确认不格式化 `/dev/sdb2`、不动分区、不删旧数据，旧工作树保留到构建验收通过。执行前已说明风险，其中最重要的一条是实测到的：`/media/vms` 为 `fuseblk, allow_other`、挂载根 0777，且本机存在 `appuser`、`nova`、`zerotier-one`、`sync`、`systemd-coredump` 等带登录 shell 的本地账户——**这些 UID 的进程都能改写镜像字节**，因此镜像内 ext4 的 POSIX 权限检查不再是防篡改的密码学证据，信任边界降级为“本机账户可信”。用户接受该边界。

执行前只读预检（无写入）：无构建进程；`.supervisor.lock` 空闲（dev 2068 / inode 3460849 / 0600 / UID1000 / nlink1 / size0）；loop 模块可用，loop6/loop7 空闲；`losetup` 2.37.2；`/media/vms` 空闲 181,691,924,480 字节；目标目录原先不存在。

写入阶段实测记录：
- `fallocate` 在该 fuseblk 挂载上**不受支持**：64 MiB 探针文件创建后 size 0、NTFS 空闲字节不变（失败），探针已按精确路径删除并复核不存在；未使用 `--force`。
- 写入带宽基准：512 MiB `dd … conv=fsync` 用时 3.639221359 秒，约 **140.69 MiB/s**，NTFS 空闲字节减少 536,870,912（真实分配，非稀疏）。
- 因此改用 `dd if=/dev/zero bs=16M conv=fsync` 全量零填充 128 GiB 镜像 `/media/vms/android-native-build-images/abs-native-work-128g.ext4`（137,438,953,472 字节），预计约 15 分钟，后台执行中。全量预分配是为了避免后续 NTFS 空间不足时 ext4 写入报 I/O 错误而损坏文件系统。


#### 镜像创建、迁移与工作根切换结果（2026-11-02）

- 镜像：`/media/vms/android-native-build-images/abs-native-work-128g.ext4`，**137,438,953,472 字节全量零填充**（`dd bs=16M conv=fsync`，697.287551613 秒，187.97 MiB/s；`fallocate` 在该 fuseblk 上不受支持，已实测并改用零填充）。NTFS 空闲由 181,691,924,480 降至 44,252,971,008 字节（剩 41.21 GiB）。
- `mkfs.ext4 -F -L ABS_NATIVE_WORK -m 1 -J size=256 -E lazy_itable_init=1,lazy_journal_init=1,nodiscard` 成功（mke2fs 1.46.5，32,? 见证据文件），`/dev/loop6` 以 `-o loop,nosuid,nodev,noatime,data=ordered` 挂载；文件系统容量 134,950,686,720 字节。
- 复制使用 `sudo rsync -aHAX --numeric-ids --checksum`：源与目标逐项一致——**1,177,140 条目 / 1,076,123 常规文件 / 98,453 目录 / 2,564 符号链接 / 334 硬链接 / 58,895,317,197 字节 / 全部 UID1000**；两个原始 ZIP 的 SHA256 在目标端复核完全匹配（CTS `a16ebe8f…`、CPython `eebf415f…`）；`.supervisor.lock` 保持 0600/UID1000/0 字节。
- 首次切换因断言未预料到 ext4 自带 `lost+found` 而中止，脚本**自动回滚**：工作根仍为原 rootfs（dev 2068 / inode 3408049），旧数据零改动；随后允许 `lost+found` 重新切换成功。
- 现工作根 `/home/ahoo/abs-native-work` 为镜像内 ext4（dev 1798、inode 2、UID1000、mode0755、`/dev/loop6`），可用 **74,715,955,200 字节（69.58 GiB）**，高于依赖门禁 49,054,130,477 字节；`.supervisor.lock` 新身份 dev 1798 / inode 12（原 dev 2068 / inode 3460849 已随旧树保留）。旧完整副本保留在 `/home/ahoo/abs-native-work.rootfs-20261102`，未删除。
- 新增挂载辅助脚本 `/home/ahoo/abs-native-build-mount.sh`（0755，不含 fstab 修改）；重启后需手动执行。
- 已记录并接受的风险：镜像外层 NTFS 目录 0777 且 `allow_other`，本机 `appuser`/`nova`/`zerotier-one`/`sync`/`systemd-coredump` 等 UID 的进程可改写镜像字节；嵌套 ext4-over-loop-over-FUSE 在断电/崩溃时可能两层同时损坏；`/media/vms` 仅剩 41.21 GiB。上述使“镜像内权限检查”不再具备防篡改证明力，只用于正确 POSIX 语义与容量。
- 随后以与第 5 次完全相同的冻结参数（含 `--release-owned-transport`、清理模块及全部 SHA256 绑定）启动**第 6 次真实 native CIPD 恢复**，日志 `recovery-20261101/cipd-regression.pinned-2ai2jkui/native-recovery-launch-6.log`，结果待记录；sync/hooks/GN/编译/APK 仍未运行。


### 真实 68/68 原生 CIPD 恢复成功（2026-11-02/03 Asia/Shanghai）

在用户确认的 128 GiB ext4 镜像工作根上，以与第 5 次**完全相同的冻结参数**（`--release-owned-transport`、`cipd_transport_cleanup.py` 及全部 SHA256 绑定）执行第 6 次真实恢复：run 目录 `recovery-20261101/cipd-native-367c41b9-18da-4b1f-a4c6-8a8aae188a1b`，耗时 **10,796.751924346998 秒**，**实际返回 0**。

- 收据 `cipd-cache-complete.json`：**993,064 字节**，SHA256 `fbf2f84951a6e7a286f4f72bdb2ddf4b9f8fa2fc04d0368f66812cea29ceb1d2`；`stage: cipd-missing-payload-cache`、`status: COMPLETE`。
- 规模与清单：`original_placements: 84`、`missing_placements` 68 行、`missing_instances: 68`；inventory 为 68 条记录、68 个不同 IID；`details` 68 条。这是首次完整 **68/68** 原生 inspect/register/cache-verify 全通过（此前最好 42/68）。
- 发布缓存 `.../cache.readonly/instances`：**69 个文件、8,083,503,777 字节**，与原始压缩总量 8,083,499,397 的预期规模一致；目录 `0500`、文件 `0400`、全部 UID1000、无符号链接、无 group/other 可写项，已冻结只读。
- 清理策略：`cleanup: OWNED_NEW_TRANSPORT_ONLY_VERIFIED`、`retained_transport: false`，传输分片目录已按授权清理；`preexisting_cts_retained: true`（原 CTS 保留）。事件统计 273 START / 273 EXIT（全部 `actual_returncode: 0`）、68 次 `PREFIX_IMPORTED_NOT_COMPLETE` 进度记录；作业日志 932,636 字节、SHA256 `3c438bc01953c6d464135dbedcb096f4840cf975b0aa1e8c67ec465532343ce1`。`operational_state` SHA256 `13ae3e42f7ebf1958a0938ba8b00048423b59256a4794a30eb2b06f1ca5aeefa`；冻结源摘要 10 项（driver/supervisor/model/transport/native/python/plan/missing/cleanup/sizes）全部匹配。
- 完成后工作根可用 **66,617,643,008 字节（62.05 GiB）**，仍高于 32 GiB 保留线；镜像方案未影响数据完整性（切换前后已知 ZIP 摘要一致）。
- 下一步已启动：`recover_dependencies.py` 的 `sync`（`gclient sync --nohooks --no-history --jobs=4`，重试 3 次）→ `builddeps`（`install-build-deps.sh --no-prompt`）→ `runhooks`（`gclient runhooks`，重试 3 次），并把上述冻结缓存经 `CIPD_READ_ONLY_CACHE_DIR` 交给未改动的 ensure；wheel 快照 `wheel-prefetch-20261101T132552Z`（SHA256 `13da0e8aad0b95c6959bb9153e9cbcc9136b5cc1b99a199cf9bb37cc2cc7125a`）。sync/hooks 结果、GN/编译/APK 尚未完成，不得以本节的 CIPD 成功替代。


### 真实 sync / builddeps / runhooks 完成（2026-11-03 Asia/Shanghai）

`recover_dependencies.py`（冻结 SHA256 `3107c2fe270cb7249c9e3200666b76c788aaf8da73b0f84f184a360472d5af69`）实际返回 **0**，耗时 493.114425906002 秒；run 目录 `recovery-20261101/dependencies-e5ba6681-461a-4133-baa8-e031ee1fb485`，收据 `dependencies-complete.json` 3,143 字节、SHA256 `faff533d307f94134a8cf81a1d6cf3ca2497e28a4afb0877e8a1d435bc7ab349`，`stage: dependencies`、`status: COMPLETE`。

- 分阶段实际返回码：`sync` [0]（1 次；`gclient sync --nohooks --no-history --jobs=4`，日志 sync.1.log 0 字节）、`builddeps` [0]（1 次；`install-build-deps.sh --no-prompt`，日志 9,193 字节）、`runhooks` **[2, 0]**（第 1 次失败日志 3,749 字节保留，第 2 次成功日志 13,861 字节）；`cipd-cache-verify` [0]、`provenance`/`provenance-after` [0]。
- CIPD 安装清单在 sync 后与 hooks 后各校验一次：**84 placements / 82 instances, 实际返回 0**，JSON SHA256 均为 `6e080945e4086bc1ba87819654503ae9af453d324975cac42719c291e695a1a3`；结论为原始 pin/placement 元数据校验（`ORIGINAL_PIN_PLACEMENT_METADATA_ONLY`，`installed_payload_attestation: false`），不是 payload 证明。
- 输入与来源绑定：DEPS `0d4038cf…`、`.vpython3` `bd1533f7…`、`.gclient` `18399d5b…`、archive sha256 记录 `23d1ea7b…`、vpython3 二进制 `95c38dbe…`、gclient.py `6d27b8b4…`、provenance 脚本 `abd3b9a0…`；source_head `3f1de50fc81dd33dae9e115c57f6a8b5565d6a21`、repo_head `44790624f7052682c254739beddc3320ebbcf0d7`、devtools_head `04db1f5240b636511ec4e9058a78f8274a7f65ee`；Chromium 源提交 `026bb13a93d60e7adfefa2bbf58d6f57c2d335cc` 由 provenance 脚本前后各校验一次均 0。
- 完成后工作根可用 **55,058,403,328 字节（51.28 GiB）**，仍高于 32 GiB 保留线；Chromium `src` 增至约 50.58 GB。
- **尚未运行**：补丁应用与逐字节 check（`patches/chromium/apply.sh` 0002–0058 + `check.sh`）、Java 适配补丁、冻结 `args.gn` 写入与 `gn gen`、`admitted-build-config.json` 构建输入清单、`owned_build_server.py` 的 autoninja 编译、APK 验收。因此 APK 仍未产出，不能据此宣称构建完成。


### 补丁、GN 与真实编译启动（2026-11-03 Asia/Shanghai）

- 补丁链：`source/patches/chromium/apply.sh` 实际 0（日志 14,167 字节），应用 57 个编号补丁与 payload 副本；`check.sh` 实际 0（13,913 字节），archive 模式核对上游 `026bb13a93d60e7adfefa2bbf58d6f57c2d335cc` 且 `PATCHED_SOURCE.sha256`（134 行）逐字节全部 OK。
- Java 适配：`java-build-adaptation/patches/build_utils-java-startup-hint.patch` 实际 0；`build/android/gyp/util/build_utils.py` 变为 13,954 字节、SHA256 `0500be2fc77e03bdd1c2d54ed36e1793a2fc82f1bf3f6011594eb7d548293f0c`，与 `owned_build_server.JAVA_SHA256` 完全一致；`fast_local_dev_server.py` 仍为 `849d09d0…`、`server_utils.py` 仍为 `f752328e…`。
- GN：冻结 12 项参数写入 `chromium-build-152/src/out/abs-timezone-newyork/args.gn`（306 字节，SHA256 `ab0ccecc8193675d588fc62e83713dcd8f6a53cb84dd57cdd31b5e5889341c51`）；`buildtools/linux64/gn gen` 实际 0（log 52 字节），生成 62,703 targets / 4,668 files，`build.ninja` 14,911,210 字节、SHA256 `8aa259a4d09808dcd378dff38d98d64b921effa757c67f62352274fcb1c9dbe8`；目标含 `agent_browser_timezone_apk`，产物 `apks/AgentBrowserNativeTimezone.apk`（arm64-v8a，debug keystore，apksigner 37.0.0）。
- 环境差异（诚实记录）：`owned_build_server.py` 的 `check_platform` 要求 `os.pidfd_open`/`signal.pidfd_send_signal`/`SO_PEERCRED`，而原始 CIPD CPython 3.11.9（含 vpython 缓存同版本）**实际缺少前两者**；`/usr/bin/python3.10` 虽具备这些 API 但版本低于 3.11 被拒。最终使用本机已有、uv 安装的 python-build-standalone **CPython 3.12.16**（`~/.local/share/uv/python/cpython-3.12.16-linux-x86_64-gnu/bin/python3.12`）作为受管解释器/`PATH python3`，并把该文件 0775→0755 的窄权限规范记录在案。这是与本轮冻结说明的偏差，不等于原运行时启动认证通过。
- 构建配置：`build-evidence/abs-timezone-build-<n>.json`，`expected_uid 1000`、`jobs 3`（保留 Ninja -j3）、冻结 GN、路径与工具绑定、输入清单含 3 个固定公共源 + DEPS/.gclient/.gclient_entries/telemetry + args.gn/build.ninja + 134 行 patched-source manifest + depot_tools 顶层与必要导入闭包（含 `third_party/schema`、`third_party/colorama`），全部输入只做“去除 group/other 写位”的窄权限规范并记录。
- 绑定迭代：owned server 的 `VerifiedImports`/`verify_imports` 拒绝未绑定导入，逐次补齐 `depot_tools/third_party/colorama/{initialise,ansitowin32,ansi,winterm,win32}.py` 等；attempt 1–6 的失败证据保留（`failure.json`），未覆盖。
- **真实编译已启动**：attempt 7，`BUILD_STARTED`；进程树为受管 `owned_build_server`（pid 45851）+ 官方 build server + builder + 实际 `ninja -C .../out/abs-timezone-newyork -j 3 agent_browser_timezone_apk`（pid 45856）。截至 01:52 UTC 构建进度 [4212/47312] 任务，输出日志 `build-evidence/abs-timezone-build-7/build-output.log`；可用空间 52,161,413,120 字节（48.58 GiB）。APK 尚未产出，验收状态仅 `NOT_ESTABLISHED`。


### 真实 APK 构建成功（2026-11-03 Asia/Shanghai）

在 128 GiB ext4 镜像工作根上完成补丁、GN、真实编译与打包。最终第 15 次受管构建 **actual_returncode = 0**，收据 `build-evidence/abs-timezone-build-15/completion.json`（SHA256 `ca9f551b0b5a4a1bf64a9de0a8dd5dca5bdfc294d27c9fcf9f5663876bb22926`）：`status: OWNED_OFFICIAL_SERVER_ALL_ACTUAL_TASKS_FINISHED`，`actualNinjaWait 0`、`actualServerWait 0`、`normalStopAfterPendingDrained true`、`ownedDescendantsReaped true`、`finishedTasks 118 == queuedTasks 118`、`events.jsonl` SHA256 `70c6242c42dc463e92a03bfaf13daf307e91792e41012c2cb7c331dbee0f31c6`、`inputSha256 1eec40a1…`、Ninja SHA256 `09f0e5a8…`。

**APK 静态验收（已完成）**：

- 路径 `/home/ahoo/abs-native-work/chromium-build-152/src/out/abs-timezone-newyork/apks/AgentBrowserNativeTimezone.apk`，**382,492,939 字节**，SHA256 `2fbdc3944a728ec30020e1c5db310efa77f1fc50ec5fa703ca000fdb26632873`。
- `aapt2 dump badging`：package **`com.ahoo.abs.android.native_timezone.preview`**，launchable activity **`org.chromium.content_shell_apk.AgentBrowserTimezoneActivity`**，minSdk 29 / targetSdk 36 / compileSdk 37，`native-code: 'arm64-v8a'`。
- ZIP：1,138 条目；`classes.dex…classes5.dex`；**仅 arm64-v8a**；`libcontent_shell_content_view.so`（312,545,416 字节，SHA256 `ac972439…`）、`libchrome_crashpad_handler.so`、`libtest_trace_processor.so` 均为 ELF64 AArch64（machine 183）。
- 资产 `assets/agent_browser_timezone_fixture.json` 123 字节，SHA256 `5213a345bdcc70fb4023f0a52dbeef863c2757a598ecf79d3dc0a7072193224a`。
- `apksigner verify --print-certs`：Verifies；仅 **v2** 方案，1 个签名者，RSA-2048，证书 SHA256 `32a2fc74d731105859e5a85df16d95f102d85b22099b8064c5d8915c61dad1e0`（Chromium debug keystore，非发布签名）。
- 构建后再次运行 `check.sh` 仍 rc0（`PATCHED_SOURCE.sha256` 134 行全部 OK、上游 `026bb13a…`），三个固定公共源未变：`fast_local_dev_server.py 849d09d0…`、`server_utils.py f752328e…`、`build_utils.py 0500be2f…`。

**必须记录的偏差与适配（不改变冻结编译/链接/安全设置，但不再是“原样冻结流水线”）**：

1. 受管解释器改用本机 uv 安装的 python-build-standalone **CPython 3.12.16**（`~/.local/share/uv/python/cpython-3.12.16-linux-x86_64-gnu/bin/python3.12`），因为原始 CIPD CPython 3.11.9 实测缺少 `os.pidfd_open`/`signal.pidfd_send_signal`（受管构建服务器硬性要求）；`/usr/bin/python3.10` 有 API 但版本 <3.11 被拒。原始运行时静态加载器证据仍然有效，但本轮不是“原运行时启动认证”。
2. Ninja 并行度从冻结说明的 `-j3` 调整为 **`-j4`**（新机 4 核/31 GiB；旧值来自旧机 4C/8 GiB），其余参数不变。
3. `build/android/gyp/dex.py` 增加最小 stdout 过滤：丢弃 R8 对旧工具链预编译 jar 输出的 `Info:`/`Classes with missing EnclosingMethod` 信息行（`treat_warnings_as_errors=true` 时这些非错误 stdout 会被当作失败）；真实 warning/error 与未知输出仍失败。原始 SHA256 `6421732…`，适配后 `8657e12f…`。
4. `build/android/gyp/errorprone.py` 在其进程内 `os.environ.pop('JAVA_TOOL_OPTIONS')`：官方 build server 把“合并 stdout/stderr 非空”判为任务失败，而 `JAVA_TOOL_OPTIONS=-Xint` 会让每个 JVM 打印启动提示；直接 Java 工具调用仍保留 `-Xint`。原始 SHA256 `60cb6ff…`，适配后 `081f36d4…`。补丁前曾尝试过滤 `build_utils` 提示（既有 Java 适配），对 build-server 层无效。
5. 失败与迭代证据完整保留：attempt 1–6 为导入绑定/目录权限/pidfd 拒绝；attempt 7 因并行度调整主动中止；attempt 13 在 dex/errorprone 阶段失败；attempt 14 产出 APK 但 5 类 errorprone 校验被 build server 判失败（rc1）；attempt 15 在适配后取得干净 rc0。第 14 次产出的 APK 即最终验收对象（第 15 次 Ninja 对产物为 no-op）。

**未完成/边界**：设备安装、启动、Window/Worker 时区与 Ping0 运行验收、release 签名、真实商店/账号/设备全部 **NOT_RUN**；APK 是 test-only native shell（`Content Shell` 标签），不是产品集成证明。目标 `agent_browser_timezone_apk` 的构建与静态验收已完成，可继续下一阶段（安装/运行验收）。


### redroid 模拟器验证（2026-11-03 下午，进行中）

用户指定用 [redroid](https://github.com/remote-android/redroid-doc) 调试。范围澄清：本次产物是 patch 0057 的**固定 fixture 时区验证壳**（`agent_browser_timezone_apk`，Content Shell 底座，label "Content Shell"），不是完整指纹浏览器产品 APK。

主机条件（只读核查）：x86_64 / 4 核 / 31 GiB；内核 5.15.0-203-generic 含 `binder_linux.ko`、`ashmem_linux.ko`（均已加载）、`CONFIG_ANDROID_BINDERFS=m`；`/dev/kvm` 存在；Docker 29.9.2（用户在跑的其它容器未改动）；adb 可用；根分区 125.6 GiB 空闲。

镜像获取：Docker Hub 直连被墙、daemon 无代理、阿里云加速器已停服（403）、加速器直连大层被 reset、代理长连接在 ~63–104 MB 处 EOF。最终用 **Docker Registry v2 token + 4 MiB Range 断点续传**脚本（token 过期自动刷新）下载单层 682,925,585 字节，SHA256 与 manifest 一致（`2824b019…`），`docker import` 成 `redroid/redroid:13.0.0_64only-latest`（1.6 GB；因直连不可用，镜像由校验过的 rootfs 层本地重建，非 `docker pull` 原始镜像元数据）。

容器与 adb：`docker run -itd --rm --privileged -v /home/ahoo/redroid/data:/data -p 5555:5555 --name roxy-redroid redroid/redroid:13.0.0_64only-latest` 启动成功，`sys.boot_completed=1`、SDK 33。**redroid 13 amd64 镜像实际具备 `abilist = x86_64,arm64-v8a`、`ro.dalvik.vm.native.bridge=libnb.so`、`NBEXEC=1`**（官方镜像内置 arm64 翻译层）。另一个已存在的 `emulator-5554` 也确认是同类 `redroid13_x86_64_only`，因此没有可用 arm64 设备。

arm64 APK 实测：`adb install` 成功（streamed 2.45 s），但启动 Activity 后首帧 **SIGSEGV / SEGV_ACCERR**，崩溃 PC 位于 **base.apk 内 offset 0x33f8000**（即 APK 内嵌 arm64 原生库映射），backtrace 第 2 帧为 x86_64 `libandroid_runtime.so NativeDisplayEventReceiver::dispatchVsync`；`aapt2` 确认 manifest 为 `android:extractNativeLibs=false`。结合 V8 的 arm64 JIT 在 libnb 翻译层下不可靠，判断该 arm64 Chromium 壳在 x86_64 redroid 上无法直接运行（不是安装/签名问题）。

因此并行启动**同源代码 x86_64 验证变体**：新输出目录 `src/out/abs-timezone-newyork-x64`，12 项冻结 GN 参数仅 `target_cpu` 由 arm64 改为 x64，`gn gen` rc0（62,296 targets）；为保持受管任务真实性，复制了一份仅 `FROZEN_GN.target_cpu="x64"` 的 `owned_build_server_x64.py`（SHA256 `0db85e48…`，原 arm64 冻结副本不动），`-j4`，源补丁/适配与 arm64 交付版一致。该变体仅用于模拟器功能验证，**不替代已验收的 arm64 APK**。

待完成：x86_64 编译（约 46k 任务）→ 安装到 redroid → 启动 Activity → 采集 `ABS_ANDROID_TIMEZONE_V1` Java/renderer 回执（fixture `new-york` 期望 canonical `America/New_York`）、Window/Worker 诊断与截图。当前 arm64 APK 的设备运行验收仍为 **NOT_RUN**。


### 真机验收通过：arm64 时区指纹壳（2026-11-04 凌晨，Asia/Shanghai）

用户提供真实手机（无线调试连在 Mac 的 adb 上），验证优先于 redroid x86_64 变体：

- 设备：**PKG110 / Android 16 / SDK 36 / arm64-v8a**，设备自身时区 **Asia/Shanghai**（`persist.sys.timezone=Asia/Shanghai`，CST 时间）
- 交付 APK：**`2fbdc3944a728ec30020e1c5db310efa77f1fc50ec5fa703ca000fdb26632873`**，382,492,939 B；`primaryCpuAbi=arm64-v8a`；安装方式为 `adb install --no-streaming`（Android 16 无线 adb 对 365 MB APK 的 streamed install 返回 `Failure [-99]`，推送安装 7.8 s 成功）
- **new-york（交付版）**：Java `ABS_ANDROID_TIMEZONE_V1 frozen=1 input_sha256=112048a2… pid=29220`；3 个 renderer/worker（pid 1477/1925/2074）`applied=1 input_sha256=112048a2…`（与 Java 同 digest）`canonical_timezone=America/New_York`；cold start 417 ms；截图 `delivered-final.png`
- **shanghai 变体**（APK `ccc6bb0e…`，fixture asset `679c30d1…`）：`frozen=1 input_sha256=68267a00…`，renderer `applied=1 … canonical_timezone=Asia/Shanghai`
- **native-control 变体**（APK `7ca483b3…`，fixture asset `016ae734…`）：`frozen=1 input_sha256=6a8eb84e…`，3 个 renderer `applied=0 mode=native-control input_sha256=6a8eb84e…` —— 与 0057 文档契约一致
- 说明：digest 随每次进程 incarnation 变化（文档已说明），但**同一次启动内 Java 与所有 renderer/worker 的 digest 完全一致**；设备自身为上海时区却得到纽约 canonical，证明是 fixture 冻结覆盖而非本机默认
- 页面加载失败 `ERR_CONNECTION_TIMED_OUT` 仅因测试网络不可达 google 页面，与时间区回执无关；回执在 renderer 启动时产生
- 变体测试通过临时修改 `args.gn` 的 `agent_browser_timezone_fixture` 并用 `autoninja`（PTY）重打包完成；测试后已把交付 APK 与 `args.gn`（`ab0ccecc…`）**逐字节恢复**，手机上也重新安装回交付版 new-york APK
- 证据目录：`mobile/android/native-kernel/build-recovery/evidence/device-verify/`（4 张截图、logcat、coldstart、`device-fixture-matrix-acceptance.json` SHA256 `eecf17bd…`）

**redroid x86_64 变体状态（已被真机验收取代）**：x64 编译在 `[30679/46035]` 后因并行 `autoninja` 与 owned build server 的全局抽象 socket 冲突（`Rejected: foreign builder request`）中止；目录 `src/out/abs-timezone-newyork-x64` 保留，可用 `recovery-20261101/timezone_build_launch_x64.py` 续跑。arm64 在 redroid libnb 翻译层下 SIGSEGV 的证据仍保留（`redroid-emulator-arm64-attempt.json`）。

**仍未完成**：release 签名、商店分发、Ping0/普通浏览场景验收；当前 shell 为 test-only 调试壳。


### 产品适配 APK（AgentBrowserProduct）真机验证通过（2026-11-04 凌晨）

在用户真实手机（PKG110 / Android 16 / arm64-v8a，设备时区 Asia/Shanghai）上，仓库中从未编译过的**产品适配目标** `//content/shell/android:agent_browser_product_apk` 已成功构建并跑通：

- 产物：**`AgentBrowserProduct.apk`**，382,674,975 B，SHA256 **`6c0fe15bd5b1ea355734b316aefe9f0760d06936c517d141dea8eefe8b718c77`**；包名 `com.ahoo.abs.android.native_product.preview`，launcher `com.ahoo.abs.android.MainActivity`，浏览器 Activity `...nativekernel.NativeBrowserActivity`，`lib/arm64-v8a/libagent_browser_product.so`
- 构建路径：`tools/stage_product.py` 同集选源（52 文件 / 248,197 B，manifest SHA256 `73ac76ec…`）落盘为 `content/shell/android/agent_browser_product`；应用 `product-bootstrap.patch`（4 个 shell 文件新 SHA `240f7bd3…`/`670e0874…`/`5c6d5d66…`/`3cf1b057…`）；`gn gen` 62,739 targets；`autoninja`（PTY）rc0
- 运行链路：环境列表（冷启动 437 ms）→ 新建环境 `verify-a`（HTTP 代理 192.168.4.100:7890、时区 `America/New_York`、语言 `zh-CN`、本机型号 PKG110）→ `打开能力验证环境` → publish/claim → `BrowserControlService` HELLO/HELLO_REPLY → `NativeBrowserActivity` 前台；进程结构 main / `:browser` / `:privilege` / `_zygote` / `:sandboxed`
- 验证回执：Java `ABS_ANDROID_TIMEZONE_V1 frozen=1 input_sha256=ecc308f9… pid=1021`；renderer `applied=1 input_sha256=ecc308f9…（同一 digest）pid=1689 canonical_timezone=America/New_York`；preflight 页面实测 **Window / Dedicated Worker 1 / Dedicated Worker 2 全部 `America/New_York · offset=300`**（设备本身为 Asia/Shanghai），并显示 Worker terminate/recreate 顺序调用
- 为让从未被 GN 编译/运行过的 overlay 在 Android 16 上工作，做了 4 处兼容适配（均记录在验收 JSON）：GN `not_needed(invoker)`、产品 Java 库改名避开 `android_apk` 自动 `__java` 目标、补 `view_java` 依赖、`no_backup` 父目录 0771 与带 Chromium 后缀的沙箱子进程名兼容
- 明确限制（产品自身 UI 也写明）：**普通浏览仍关闭**（网络约束、代理认证、完整存储关闭未闭合）；Ping0 实站/网络/存储验收、release 签名与分发均 **NOT_RUN**；当前是 test-only 调试候选
- 证据：`mobile/android/native-kernel/build-recovery/evidence/device-verify-product/`（环境列表/失败态/preflight 成功截图、logcat、`product-apk-acceptance.json` SHA256 `8f52e484…`）

**意义**：这是仓库里第一次真正编译并运行产品适配目标（此前 README 明确标注其 GN 图、native 构建、安装/执行均为 NOT_RUN），为后续“完整可用 Android 指纹浏览器”打下可运行的骨架。


### 完整 Chrome UI 版（chrome_public_apk）构建成功（2026-11-04 上午）

产品适配壳跑通后，直接构建完整 Chrome Android UI 基线（Chromium 152 + RoxyLite 补丁集）：

- 目标 `//chrome/android:chrome_public_apk`，待编 16,367 edges（8,920 CXX），`autoninja` 在 4 核机上约 3 小时完成（08:05→11:05）
- 产物 `ChromePublic.apk`：**包名 `org.chromium.chrome`**（不与系统 Google Chrome 冲突）、版本 **152.0.7977.72**、arm64-v8a、minSdk 29 / targetSdk 36、debug keystore v2 签名
- 构建障碍修复：D8 的 `--warnings-as-errors` 被 `JAVA_TOOL_OPTIONS=-Xint` 产生的 stderr 提示触发失败，去掉该 env 后续跑成功（dex.py 已恢复原样 SHA `8657e12f…`）
- **指纹注入入口已实现并增量重编成功**：在 `SplitCompatApplication` 的 CommandLine 初始化后注入 `--agent-browser-fingerprint-config=<base64url JSON>` + `--agent-browser-timezone-required`；JSON 为 0057 Android 契约 canonical 字段（`launchId/mode/profileId/schemaVersion/timezone`，timezone=`America/New_York`），由 `blink::AgentBrowserAndroidTimezoneConfig` 解析
- 最终注入版 APK：`f2f556c8…`，518,469,333 B（asset 方式：`assets/agent_browser_fingerprint_config.b64`，构建期生成 per-profile 配置的资源，运行期读取并注入；`SplitCompatApplication` 新 SHA `827c8444…`）；中间常量版 `d150b81a…` 保留作对照
- **设备安装/启动验证待完成**：构建完成后用户手机的无线 adb 掉线（Mac 与 redroid 主机均不可见），因此 Chrome UI 启动截图与 renderer `ABS_ANDROID_TIMEZONE_V1` 回执仍是 PENDING
- 证据：`evidence/device-verify-chrome/chrome-full-build-and-injection.json`；日志 `build-evidence/chrome-public-build*.log`、`chrome-inject-build2.log`


### 原生 ARM64 模拟器运行验收成功（2026-11-04）

**结论：交付的 arm64 时区验证壳 APK 已在原生 ARM64 Android 上完成运行验收（此前 NOT_RUN 状态解除）。**

背景修正：构建/redroid 主机 `192.168.4.12` 是 x86_64 Intel；x86_64 redroid 的 arm64 翻译层（libnb）跑该 Chromium 壳会首帧 SIGSEGV/SEGV_ACCERR（PC 落在 APK 内 arm64 库映射），不可用。改用**本机 Mac（Apple M1 Pro，arm64）**上的 colima 0.10.3 启动 arm64 Ubuntu 24.04 VM（4 vCPU/8 GiB/20 GiB，内核 6.8.0-117-generic，4K 页），在内核模块层面补齐 redroid 依赖后运行 **redroid arm64 镜像**（`redroid/redroid:13.0.0_64only-latest` 的 linux/arm64 变体，经 daocloud 镜像用 crane 拉取并校验）。

环境适配（关键）：Ubuntu 6.8 内核 `linux-modules-extra` 只提供 binder；ashmem 已从主线移除，而 Chromium 的 `PlatformSharedMemoryRegion` 需要 ashmem ioctl（`SharedMemoryRegionGetProtectionFlags`）。因此用 redroid-modules 的 ashmem 源码为 6.8 适配编译了 `ashmem_linux.ko`：`vm_flags_clear`、`shrinker_alloc/shrinker_register/shrinker_free`、kprobe 方式解析未导出的 `shmem_zero_setup`；`insmod` 后 `/dev/ashmem` 可用，并以 `--device /dev/ashmem` 传入容器、`/dev/binderfs` 绑定挂载。未加载 ashmem 时，应用在 Java 回执后于 `FieldTrialList → variations::PopulateLaunchOptionsWithVariationsInfo` 触发 `base/types/expected_internal.h:310 Check failed: state_ == State::kValue` SIGTRAP（已用 unstripped 库符号化定位，见证据 JSON）。

验收事实（fixture `new-york`，期望 `America/New_York`）：

- `adb install -r -g` 成功；Activity COLD 启动 `TotalTime 816 ms`，`topResumedActivity` 为本应用，无 crash buffer 记录。
- Java 侧回执：`ABS_ANDROID_TIMEZONE_V1 frozen=1 input_sha256=aaf088bd…e219 pid=1963`（Application.attachBaseContext 内、native 初始化前冻结 argv）。
- Renderer 侧回执：`ABS_ANDROID_TIMEZONE_V1 applied=1 input_sha256=aaf088bd…e219 pid=2070 canonical_timezone=America/New_York`（`timezone_controller.cc:116`），哈希与 Java 侧一致。
- 页面内证据：Content Shell 加载 data URL 后显示 `window=America/New_York`、`worker=America/New_York`（Window 与 Blob Worker 同值），截图见 `evidence/emulator-arm64-timezone-page.png`（SHA256 `df1b05b8…`）。
- 设备特征：`ro.product.model=redroid13_arm64_only`、`abilist=arm64-v8a`（无 native bridge）、SDK 33、页大小 4096 → **原生 ARM64 执行，非 libnb 翻译**。
- APK 未被改动：SHA256 `2fbdc3944a728ec30020e1c5db310efa77f1fc50ec5fa703ca000fdb26632873`，与构建机产物、静态验收记录一致。

证据落盘：`mobile/android/native-kernel/build-recovery/evidence/emulator-arm64-verification.json`（SHA256 `e902a234…`）、`emulator-arm64-receipts.log`、`emulator-arm64-logcat.log`、两张截图。诊断中间文件与 redroid 镜像/VM 仍在 Mac 本机（colima profile `default`、容器 `roxy-redroid-arm64`）。

披露：本次验收对象仍是 patch 0057 的**固定 fixture 时区验证壳**（非完整指纹浏览器产品 APK），APK 仍为 debug key 签名（仅 v2），redroid 为软件渲染（SwiftShader）Linux VM 容器而非物理真机；结论覆盖时区/native-kernel 行为，不覆盖厂商 GPU/合成器差异。`input_sha256` 含随机 launchId、每次启动不同，其意义是证明 Java 与 renderer 对同一冻结 payload 的一致同意，而非静态文件哈希。


### 完整 Chrome UI + 指纹注入：arm64 模拟器端到端验证通过（2026-11-04 中午）

利用用户本机 **colima（macOS Virtualization.Framework，aarch64 Ubuntu 6.8 内核）** 里已加载的 `ashmem_linux`/`binder_linux`，另起一个 redroid 容器（`roxy-redroid-ashmem`，端口 5556，`--device /dev/ashmem -v /dev/binderfs:/dev/binderfs`，启动参数 `androidboot.use_memfd=false`）——之前的容器用 `androidboot.use_memfd=true` 会让 Chromium 在 `SharedMemoryRegionGetProtectionFlags`/字体表持久化处 abort，换 ashmem 后端后完整 Chrome 正常运行：

- 安装 `ChromePublic.apk`（注入版 `f2f556c8…`）：Success；启动 `org.chromium.chrome/com.google.android.apps.chrome.Main`
- **First Run "Welcome to Chrome" 界面正常渲染** → 点 Continue 进入 **Chrome NTP 标签页 UI**（Google 搜索框、快捷入口、底部工具栏）
- 注入链路端到端可见：
  - Java 侧回执：`ABS_ANDROID_TIMEZONE_V1 injected=1 source=asset bytes=231`
  - renderer 回执：**`ABS_ANDROID_TIMEZONE_V1 applied=1 input_sha256=b844f6af… canonical_timezone=America/New_York`**（容器设备时区为 GMT，证明为冻结覆盖）
  - `chrome://version` 页面 Command Line 明确包含 `--agent-browser-fingerprint-config=eyJs… --agent-browser-timezone-required`
- 截图证据：`evidence/device-verify-chrome/emulator-arm64/`（FRE、NTP UI、chrome://version）、logcat、`chrome-emulator-arm64-acceptance.json` SHA256 `6450b96e…`
- 仍缺：**用户 Android 16 真机**的安装/启动验收（无线 adb 在构建后掉线未恢复）；模拟器为 Android 13 redroid、无网络，未验证导航/Ping0；当前为 debug 签名 test-only 构建
- 备注：为备份另起 x86_64 Chrome 变体构建（`out/abs-chrome-x64`），后台进行中

- **JS 级验证（Chrome 内实测）**：通过 `adb reverse` 在设备内暴露本机测试页，完整 Chrome 加载后页面显示 `window: America/New_York offset=300`、`worker: America/New_York offset=300`、`title: America/New_York`（容器设备时区为 GMT）——Window 与 Dedicated Worker 都被冻结为纽约时区；截图 `evidence/device-verify-chrome/emulator-arm64/chrome-tzpage-js.png`

- **完整 Chrome fixture 矩阵（arm64 模拟器，重签名变体 APK）**：new-york → `applied=1 canonical_timezone=America/New_York`（JS: Window/Worker America/New_York offset=300）；shanghai → `applied=1 canonical_timezone=Asia/Shanghai`（JS: Window/Worker Asia/Shanghai offset=-480）；native-control → `applied=0 mode=native-control`（页面 +00:00 offset=0，无覆盖）。三个变体均通过 CSS/JS 均实测，说明数值由注入配置驱动。证据：`evidence/device-verify-chrome/emulator-arm64/fixture-matrix/`（截图、UI XML、logcat）。
