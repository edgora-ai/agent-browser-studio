# Android Ping0 延长等待实测（2026-10-21）

## 结论

按用户“多等一会”的要求，重新运行同一专用模拟器，**在同一次导航后持续等待至十分钟观察上限，不刷新、不重新检测、不注入页面脚本**。30 秒、2 分钟、5 分钟、9 分 30 秒的真实截图均仍显示 `{{ animatedScore }}` 等模板，没有可读的数字评分或完成计数。600 秒后诊断按设定撤销；615 秒采样显示撤销提示及已卸载的空白页面。**未观察到有效 Ping0 结果，不判 PASS，也不把它当作已测出的指纹 FAIL。**

这补充了[上一轮记录](android-emulator-ping0-2026-10-21.md)，不是抹掉旧失败或凭首帧重复下结论。第一帧确实仍可能处于导航过程，不能据此判断站点最终状态。

## 1. 本轮仅改变观察时长

原固定观察上限为 120 秒，若不改会自动卸载页面，无法实际等十分钟。build0013 将 `Ping0ObservationPolicy.DURATION_MILLIS` 改为 **600000 ms**，原生确认框和 banner 实际显示 600 秒。

从 build0011 的冻结输入对比，只有两个编译输入变化：

- `core/src/main/java/com/ahoo/abs/core/Ping0ObservationPolicy.java`：观察上限。
- `core/src/test/java/com/ahoo/abs/core/CoreContractTest.java`：十分钟边界、超过两/五分钟仍有效以及 elapsed overflow 回归。

启动票据的两分钟有效期、session/config/incarnation 绑定、撤销、普通浏览门禁、允许域名/静态脚本路径、TLS、指纹取值及数据目录策略未改变。没有将不支持能力改成 VERIFIED。

回归先 RED：build0012 实际 `TOTAL 189 PASS 187 FAIL 2`，分别为旧 120 秒上限和两分钟后已失效；失败原样保留。改正时长后 build0013 实际 `TOTAL 189 PASS 189 FAIL 0`，离线构建成功，Lint 0 errors / 9 warnings。

## 2. 实际环境与版本

仍是本轮专用、无账号的 Android 15 / Pixel Tablet / WebView 124 模拟器，复用同一 AVD 和合成 profile 数据，不 wipe/reset。没有接触旧 AVD 或真实手机，未使用真实账号/代理凭据。

| 项目 | 结果 |
| --- | --- |
| build0013 冻结输入 | 85 个；SHA-256 `88f8dd5cad779665d4e69a8cd62f4b627c41357c8a413156758f0924ac7f2a90` |
| App APK | 3,429,471 B；SHA-256 `573af38da72b2c050e45fb8684b2e2a74d97007e2abffd34416270e8b8366794` |
| 已安装 APK 读回 | 从本模拟器 pull，大小/哈希与 build0013 一致 |
| APK 静态核验 | v2 签名、ZIP CRC、16 个原始 assets 匹配 |
| 原生 instrumentation | 新 ownedScope，48 项 PASSED / stage COMPLETE；不是网页评分证明 |
| 最终 host 复验 | Node/VM 75/75、SQL/static 54/54、buildguard 9/9，各一次、exit 0、源码前后不变 |

host 复验在这次十分钟页面观察结束之后执行，不将 synthetic realm/SQL 检查当成浏览器站点结果。

## 3. 时间与截图

本地证据根 `B`：

```text
/Volumes/ABSAndroidSSD-a08cc0639bed/Temp/roxy-lite-cloak-oss/2026-10-21/ping0-emulator-7dab2608
```

时间原点为原生 `开始本次观察` 点击命令返回后的 host monotonic；截图和随后 AX 读取不是原子操作，各自时间保存在回执中。导航、确认按钮和 App 页面都是真实 UI，不用外部 Chrome/DOM mock 替代。

| 实际截图开始 elapsed | 截图（B 下） | 人工查看的可见状态 |
| --- | --- | --- |
| 0.007 s | `screens/0013-session0006-wait-000/screen.png` | 首帧仍是本地 probe，不能算远站结果；随后 AX 已出现远站，所以两者不能混作同一时刻 |
| 30.014 s | `screens/0013-session0006-wait-030/screen.png` | 真实 Ping0 页面，Vue 模板未展开，无数字评分 |
| 120.011 s | `screens/0013-session0006-wait-120/screen.png` | 仍为模板，无数字评分/完成计数 |
| 300.014 s | `screens/0013-session0006-wait-300/screen.png` | 仍为模板，无数字评分/完成计数 |
| 570.014 s | `screens/0013-session0006-wait-570/screen.png` | 仍为模板，无数字评分/完成计数；native banner 仍为 600 秒许可、partial 2 |
| 615.009 s | `screens/0013-session0006-wait-615/screen.png` | 显示“到达诊断截止时间”，页面卸载为空白；这不是模板修复或检测完成 |

六张截图均已查看。采样器 618.401 秒结束，`planned-window-finished`，六个采样均无 capture/AX failure。完整时序及每张图的 SHA-256/REA Evidence 保存在 `B/artifacts/0013-session0006-wait-ended.json`；这是分时取证，不是逐帧录像。

9 分 30 秒截图：

- SHA-256 `ff64dbf4005a1e72d784f38a6fe39c86ee37c63f32521d66c47052872e9ce05e`。
- REA Evidence `ev_8e3615366eeeb207ea761fa45607a4eddd0357869fa95fcd4ffc356fc353a30d`。

## 4. 等待结束后的独立运输复查

本次私有 ADB/session0006、受限 CONNECT proxy0004，guest `127.0.0.1:61470` 仅通过本次 reverse 到 host `127.0.0.1:59965`。只允许 `ping0.cc:443` / `cdn.ping0.cc:443`，App 另限制 CDN 静态路径；没有 DIRECT 回退。沿本机出口，不是不同国家代理覆盖。外层 egress fence 仍仅为实验隔离，不证明产品无泄漏。

在十分钟观察结束后，经同一代理、正常 TLS 校验独立请求：

```text
https://ping0.cc/env
curl exit=0, HTTP=200, received=53886 B

https://cdn.ping0.cc/js/vue.min.js
curl exit=35, HTTP=000, received=0 B
LibreSSL SSL_connect: SSL_ERROR_SYSCALL
```

proxy0004 日志内已结束的 CDN 隧道 `receivedBytes` 全部为 0（日志含浏览器及之后 host 对比，不按 ordinal 猜测具体 JS URL）。native banner 的 partial 2 是 WEB/SW 依赖/导航拦截回调计数；proxy 中五条 denied 是另一层的事件，不能相加或认作相同请求。未保留被阻止请求的完整路径，因此其具体类型仍未知。

本轮结束时按确切自有 browser PID 投影最后 300 行 logcat，**未匹配到 TLS 错误码行**；只说明该有界读取没取得它，不能用旧 build0011 的 SSL/-100 记录冒充本轮日志，也不证明连接已恢复。没有记录原始日志、响应正文/headers/Cookie 或私钥。

因此，有证据支持“延长等待仍未观察到结果，必需 CDN 运输在本测试路径上仍失败”。具体网络 hop、服务端/中间网络原因和其他 JS 初始化故障尚未完全归因；这不是网站指纹识别、认证失败或证书根因的证明。没有忽略 TLS、换评分脚本、修改原型或自动扩大第三方白名单来补绿。

## 5. 正常退出与容量

到期后通过真实 App UI 返回列表并请求退出。界面实际显示确切 PID ESRCH + 生命周期锁可获取。直接对合成默认配置库执行 native readonly SQL：

```text
emu-native-default|0|64|1
EXIT_CONFIRMED|100|4
0
ok
```

依次为名称/无凭据/hash 长度/固定 suffix 校验、退出历史 state/phase/count、未确认 launch 数量和 integrity_check。本次 `:browser` 的 pidof 返回 1、stdout 为空。此处仅为配置/生命周期证据，不证明全部网站存储持久性。

移除本次唯一 reverse 后，请求关闭 proxy0004、emulator、private ADB。代理 `requested-stop` / 22 connections / 118743 B；emulator exit 0，ADB SIGTERM exit -15，均 `forced=false`、`remainingPids=[]`。2026-10-21T10:41:50Z 复查本次两组为空，61469/61470/61471/61472/59965 均无 listener。未关闭未知设备/浏览器或全局 ADB。

该时点 B retained 1,144,785,720 B，image allocated 1,363,148,800 B；仍为原 12-GiB 累计预算、32-GiB 虚拟映像，未 reset/扩容/删除旧证据。新 APFS free 32,912,404,480 B，host free 347,635,449,856 B，各留 10 GiB；原开发卷 free 7,341,633,536 B，仍留 6 GiB。构建根原 cap 1 GiB 不变。

**本轮“多等并取证”已执行；Ping0 完整验收仍未完成，普通浏览继续阻止。** 原始失败/旧 STOP 和元数据保留；proxy0003 因剩余观察时间门槛在启动页面前被停用，connections=0，没有把其旧 readiness 当作可用连接。后续需先定位必需 CDN 的真实连接故障，再继续完整站点、真实手机、跨地区代理及未实现能力验收。没有 Android 提交、推送或公开发布。
