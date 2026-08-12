# ping0.cc 环境一致性验证（Agent Browser · Chromium 150 patchset 0044）

验证日期：2026-08-13

被测浏览器：Agent Browser Studio 内置 Chromium 150.0.7871.114（Chromium 分支 HEAD c35ff15cc1，构建 hash 9ee802fbd40e9，patchset 0002-0044 全量应用）

代理：http://127.0.0.1:7890 -> 出口 152.70.241.120（KR / Seoul / Oracle Corporation，IDC）

方法：直接 spawn Chromium（不注入 --enable-automation，使用具体 CDP 端口而非 --remote-debugging-port=0），经代理做新鲜 geo 检测（ipwho.is），按 app 同款参数注入 managed fingerprint 配置，加载 https://ping0.cc/env ，等 Vue finished=true + 正文「完成：x/100」出现后再静置 15s 抓取，全程页面保持前台可见。

## 结论

连续 3 次完整检测全部 92 分 / green（此前为 72 分 / red）。浏览器侧已无泄漏：

| 检查项 | 结果 |
| --- | --- |
| stealth.webdriver | false（修复前 true） |
| net.dns 解析器 | 仅 140.204.24.35（KR），foreign=false，无 DNS 泄漏 |
| 中文字体 | locale.fonts_cn=[]，hw.fonts_cn_list=[]，无 CN 字体暴露 |
| xc.ip_tz | IP=KR 与 tz=Asia/Seoul 一致 |
| xc.ip_lang | IP=KR 与 primary_lang=ko-KR 一致 |
| 真实 rAF 节奏 | 中位数 8.3-8.4 ms（120Hz，原生 ProMotion），页面 visible+focused |

## 三次检测明细

| run | score | level | 失败项 |
| --- | --- | --- | --- |
| run2 | 92 | green | net.isidc(warn)、stealth.raf_timing(info) |
| run3 | 92 | green | net.isidc(warn)、stealth.raf_timing(info) |
| run4 | 92 | green | net.isidc(warn)、stealth.raf_timing(info) |

原始报告见同目录 ping0-run2.json / ping0-run3.json / ping0-run4.json。

## 剩余两项的定性

- net.isidc（warn，权重 8）：出口 IP 属于 Oracle 机房（IDC），是代理本身的属性，与浏览器无关；换家庭宽带出口即消除。
- stealth.raf_timing（info，权重 3）：ping0 在检测重负载期间测量 rAF 间隔，被主线程繁忙放大。页内采样器证明真实节奏为 8.3ms（120Hz）。stock Google Chrome 同样被放大（报 34.08ms，而真实节奏也是 8.3ms），只是未过其判定阈值。该项为测量伪影，非浏览器泄漏。

## 与 stock Chrome 的基准对比（同一代理、同一 CDP 方式）

| 指标 | Agent Browser | Google Chrome 151 |
| --- | --- | --- |
| ping0 总分 | 92 / green | 19 / critical |
| 泄漏项 | 0（浏览器侧） | 9（WebRTC 真 IP、CN DNS、CN 字体、ip_tz、ip_lang、UA/WebGL 等） |
| ping0 raf_timing | 57.7-65.2 ms | 34.08 ms |
| 页内真实 rAF 中位数 | 8.3 ms | 8.3 ms |

## 性能差距（本轮新发现）

在同一台 M1 Pro 上用相同 JS/Canvas 基准对比：

| 基准 | Agent Browser | Chrome | 差距 |
| --- | --- | --- | --- |
| uint32_hash | 466K ops/s | 719K ops/s | 慢 54% |
| string_build | 161K ops/s | 222K ops/s | 慢 38% |
| array_sort | 10.5K ops/s | 13.2K ops/s | 慢 25% |
| canvas2d_noise | 787 ops/s | 1348 ops/s | 慢 71% |

根因：patches/chromium/args.gn 使用 is_official_build=false + chrome_pgo_phase=0（无 PGO）。这解释了 ping0 raf_timing 略高于 stock Chrome：检测 JS 主线程负载下帧间隔被放大更多。

建议下一步：启用官方构建 + PGO（is_official_build=true、chrome_pgo_phase=2，两阶段构建）以消除该性能差距；预计需数小时构建。

## 修复记录（对应 Chromium patch）

- 0044（DNS）：DoH probe 因 session_=nullptr 总是 LOAD_BYPASS_PROXY 直连 8.8.8.8；修复为 managed secure DNS 走退出代理（doh_via_proxy）。
- 0044（locale/fonts/refresh）：managed locale 在 Skia/V8/Blink/Worker 启动前初始化 ICU；字体仅保留 profile 白名单 + Blink 内部 kLastResort；rAF/合成保持显示原生刷新率（内部 ProMotion 8.333ms 已实测）。
- 验证 harness 修复 stealth.webdriver：--remote-debugging-port=0 会触发 Chromium 自动开启 AutomationControlled（navigator.webdriver=true），改用具体端口后 webdriver=false。

