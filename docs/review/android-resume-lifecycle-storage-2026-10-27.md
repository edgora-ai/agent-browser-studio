# Android 恢复开发：退出重连与合成存储验证（2026-10-27）

## 本轮结论

用户明确恢复 Android 开发并要求模拟器验证。本轮修复了真实控制链的停止重试、旧连接回执和重复回执问题；新增独立的合成存储诊断，并在实际 Android App 中完成 Cookie、LocalStorage、IndexedDB 的 **A → 正常退出 → B → 正常退出 → A → 正常退出 → B** 读回。

这是限定的开发里程碑，**不是完整 Android 产品、真实网站登录、完整存储持久性或 Ping0 通过声明**。普通浏览门禁没有放开。本报告描述的验证阶段没有合并代码或发布 Android 安装包；后续源码检查点与服务器交接以开发分支提交为准。原桌面版本未修改。

## 身份与环境

- 开发分支：`feat/android-resume-20261027`，基线为桌面 `main` 提交 `2f3b0b3fba206d0a86c209789c191f4d5a4e1811`。原 Android 分支和 `mobile/` 源码保留。
- 冻结 Android 编译输入：92 个文件，摘要 `0b9337db3adc3f340501d21b539f35fda79aa235bc04fa053a31f96c5a2df1cf`。摘要范围由 `tools/build.py` 的 `source_inventory` 定义，不包括 Markdown。
- 产品 APK：3,439,431 bytes，SHA-256 `94373e47062bd78d183207312fab1c6c237229f47aa34a9d7d1deb639b63c36b`；build0018/0019 产品字节相同，仅选择的测试 runner 不同。
- 包：`com.ahoo.abs.android.preview.debug`，内部开发签名，不是正式发行许可/签名。
- 原专用无账号模拟器：Android 15 / API 35 / Pixel Tablet / arm64。沿用原系统 WebView 124；不扩展为其他 provider 或真机结果。
- 原专用 APFS 映像按原 UUID/来源核验后恢复挂载，没有重建、wipe、扩容或接管其他 AVD。私有 ADB 禁止 USB、默认模拟器扫描和 mDNS 自动发现。
- 本轮外层测试网络只保留自有 loopback 通道，测试代理拒绝所有外部请求。这个实验隔离不是产品 DNS/IPv6/WebRTC/UDP enforcement 已实现的证据。

## 1. 生命周期真实 RED → GREEN

### 缺陷及修复

`LaunchCoordinator.beginDrain()` 原来在 `DRAINING` 直接返回，使第一次 DRAIN 投递抛出 `RemoteException` 后，重新握手也不补发。`EXIT_WAIT/EXIT_UNKNOWN` 再次停止又会错误请求原状态迁移。另有失败状态被成功文案覆盖、握手前接受控制以及旧/重复回执推进状态的问题。

现在：

- 将第一次状态迁移与幂等 DRAIN 投递分开；退出等待态可补发，不倒退状态。
- 每条回复绑定连接实例、连接代次、session 与 nonce；握手前不发 DRAIN/EXIT，不接受旧连接回执。
- 重复 HELLO/DrainReply 幂等，显式再次打开同一运行环境仍可重新显示界面。
- 发送失败保留失败状态；已 drained 的 HELLO 只进入等待退出，不当作死亡证明。
- **未修改** `RuntimeStateMachine` 的严格迁移、`confirmAbsent`、数据库退出门禁或实际 PID/生命周期锁证据条件。

### 执行证据

| 层级 | RED | GREEN |
| --- | --- | --- |
| 离线 Java contracts | 203 项中 196 PASS / 7 FAIL | 203 PASS / 0 FAIL |
| 实际 Android coordinator + Messenger + SQLite | 12 场景中 1 PASS / 11 FAIL | 12 PASS / 0 FAIL，268 checks |

真实 RED 的失败包括：首次 DRAIN 发送失败被成功文案覆盖、HELLO 后未重发、退出等待态重停失败、握手前发送/接受控制、旧 HELLO/DrainReply 推进新连接、重复打开/退出，以及 drained HELLO 仍停在 PROBING。原下一环境门禁场景从 RED 到 GREEN 均通过。

原生 fixture 使用每场景新建的合成 SQLite、实际生产 coordinator 和 Android Messenger；service/activity 出口被 fixture 截获，故它**不独自证明**真实浏览进程或 WebView 行为。下面的 UI 场景是另行执行的。

## 2. 独立合成存储诊断

- 使用独立保留 origin 和三个内置文件，不改身份采样页面，不访问外网或真实账号。
- 首次打开仅查询指定 Cookie 名、LocalStorage key 和已有 IndexedDB；缺失不补写。没有数据库时不调用会创建数据库的 IDB open。
- 用户在页面显式点击写入才生成新随机 UUID 样本；只有该页面自己的固定 key 被更新，不清空其他网站数据。
- IndexedDB 只有 transaction complete 才报告写入返回；枚举和打开/事务均有截止，错误不伪装成缺失或成功。
- 没有 `crypto.randomUUID` 的 provider 使用安全随机字节生成 UUID；无安全随机数能力则明确禁用写入，不使用固定样本或 `Math.random` 代替。
- 原生回执校验主 frame、精确 origin、完整当前 URL、challenge、会话期限、报告大小和字段白名单。退出/切换会撤销结果接收，但**撤销不等于证明所有已开始的存储操作已终止**；本轮不作这个原子性声明。
- `storageLifecycle` 仍为 `UNVERIFIED`，不因合成样本成功提升普通浏览权限。

### 实际界面与数据流

实际使用安装后的 App 表单创建两个无凭据合成环境，直接 SQLite 查询到两行、不同稳定目录、64 字符配置摘要；关闭后重开查询和按名称检索一致，`integrity_check=ok`。

| 步骤 | Cookie | LocalStorage | IndexedDB |
| --- | --- | --- | --- |
| A 首次只读 | missing | missing | missing |
| A 显式写入并读回 | A 原值 | A 原值 | A 原值 |
| A 正常退出后，B 首次只读 | missing | missing | missing |
| B 显式写入并读回 | B 原值，且不同于 A | B 原值 | B 原值 |
| B 正常退出后，A 新浏览进程只读 | A 原值，未补写 | A 原值 | A 原值 |
| A 再退出后，B 新浏览进程只读 | B 原值，未补写 | B 原值 | B 原值 |

四次自有浏览进程 PID 分别为 4185、4496、4809、5079；数据库四行均为 `EXIT_CONFIRMED / phase 100`，两个目录在重开后各自保持一致。最终自有 `:browser` 的 `pidof` 返回 1、stdout/stderr 为空。这里的冷读指新的浏览进程，不是整台设备重启或断电恢复。

实际截图已查看，非空白启动或仅 shell ACK：

- B 初次缺失：800×1280，SHA-256 `82e661a7b61df556d6fb9e64356c37a538a0c35bc33905b803cbb31661701616`。
- A 新进程读回：800×1280，SHA-256 `883db4a313788e4fd0352ca06162ceea2c328f680620a570987f55ec08b28c6e`。

最后正常请求停止本次测试会话：模拟器 exit 0，私有 ADB exit -15；两者 `forced=false` 且自有进程组无残留。保留测试数据、APK 和所有失败记录，没有自动清理历史产物。

## 3. 构建与其他回归

- 全程使用现有 JDK 17、Gradle 8.9、SDK 35 和已有只读依赖缓存离线构建，没有下载内核/SDK/依赖。
- build0018 完整执行 Core、App APK、测试 APK、lint，exit 0；源码前后相同，Gradle 自有进程组退出。
- Java 203/203；Node/VM 89/89；宿主 SQLite/static 54/54；buildguard 9/9。
- 原 48 项 Android 原生 SQLite/解析/启动票据检查在相同产品 APK 上重跑通过，`INSTRUMENTATION_CODE=-1`。
- APK v2 签名、ZIP CRC、19 个 packaged assets 与源码匹配；实际安装后分别拉回 App 和测试 APK，大小/SHA-256 一致。
- Lint **0 errors / 10 warnings**，没有关闭 lint。新增一项是 `StorageProbe.addWebMessageListener` 的跨方法 feature-guard 提示；调用方在注册前已检查 `WEB_MESSAGE_LISTENER`。保留此诊断，不宣称零警告或所有旧 provider 已验收。

## 4. 失败记录没有改绿

- build0015 因只读 cache 指到了 `modules-2` 而不是其父目录，插件离线解析失败；没有执行产品测试。改为正确缓存父目录后使用新构建编号。
- native 首次包装器不接受 Android 实际 `/~~` 安装路径，安装后读回被拒绝；独立修正路径正反例后重新验证。
- 添加第二 instrumentation manifest 未出现在实际 APK manifest，原生 runner 未找到；随后用明确的 `owned/lifecycle` 二选一构建配置注册，并核对实际编译 manifest。
- 新存储功能初始 11 项缺实现 RED，以及审查后增加的 3 项超时/随机数兼容 RED 均保留。
- 首次 profile selector 在 compressed AX 缺少布局父节点时拒绝了歧义，没有点击；后按完整实际卡片顺序和几何选择。
- 一次只读 SQL 命令因设备 shell 引号解析失败，后使用严格预定义 SQL 并正确引用；不是数据库写入丢失。
- 两次冷启动过渡中的 `uiautomator` capture 失败；原 wrapper 未保存足够错误细节，**根因未知**。后来独立读取焦点/捕获成功后才继续操作，不把失败帧当作成功观察，也没有重新写入原值。

## 5. 参考项目与未完成范围

只读比较了用户指定的 [Damru](https://github.com/akwin1234/damru) 和 [GeoSpoof](https://github.com/GeoSpoof/geospoof)，未执行或复制第三方代码：

- Damru 的支持路径依赖特权 Redroid、系统级设置与 CDP，且有非商用许可限制；不能作为普通未 root Android App 的直接实现。
- GeoSpoof 是 Apache-2.0 浏览器扩展，其默认页面注入和扩展 debugger API 不是普通 System WebView 的每环境原生时区接口。

仍未完成：原生每环境时区/完整 locale、代理认证、DNS/IPv6/WebRTC/UDP enforcement、CacheStorage/SW/SessionStorage/真实账号与登录态、崩溃/强停/断电后的全存储持久性、真机和其他 WebView provider、正式授权/发行。未重跑外部 Ping0；历史 52 分/5 异常/partial68 不因本轮本地测试而改为 PASS。
