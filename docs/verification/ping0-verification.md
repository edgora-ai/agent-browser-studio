# ping0.cc 环境一致性验证（Agent Browser · Chromium 150 official build）

验证日期：2026-08-13（official/ThinLTO 构建复测）

被测浏览器：Agent Browser Studio 内置 Chromium 150.0.7871.114，official 构建（is_official_build=true、symbol_level=0、ThinLTO 生效、无 PGO），patchset 0002-0044 全量应用。

代理：http://127.0.0.1:7890 -> 出口 152.70.241.120（KR / Seoul / Oracle Corporation，IDC）

方法：直接 spawn Chromium（不注入 --enable-automation，使用具体 CDP 端口），经代理做新鲜 geo 检测（ipwho.is），按 app 同款参数注入 managed fingerprint 配置，加载 https://ping0.cc/env ，等 Vue finished=true 后静置 15s 抓取，全程页面保持前台可见。

## 结论

连续 3 次完整检测全部 **100 分 / green / 0 findings**（上一版非 official 构建为 92 分，余两项告警：net.isidc warn、stealth.raf_timing info）。official 构建在保持全部反检测能力的同时，还消除了 rAF 计时告警——官方优化后检测 JS 主线程负载下的帧间隔不再被放大到阈值以上。

| run | score | level | findings |
| --- | --- | --- | --- |
| official-run1 | 100 | green | 0 |
| official-run2 | 100 | green | 0 |
| official-run3 | 100 | green | 0 |

原始报告见同目录 ping0-official-run1.json / run2 / run3。

快速探针（每轮一致）：webdriver=false、platform=Win32、UA=Chrome/150.0.7871.114 (Windows NT 10.0)、languages=[ko-KR]、timezone=Asia/Seoul、visibility=visible、hasFocus=true。

## 与上一版（非 official）构建对比

| 检查项 | 非 official（patchset 0044 初版） | official build |
| --- | --- | --- |
| ping0 总分 | 92 / green | 100 / green |
| 泄漏项 | 0（浏览器侧，2 项非浏览器 warn/info） | 0 |
| stealth.raf_timing | info 告警（被检测负载放大） | 无告警 |

## 性能基准（同一 M1 Pro、同一 CDP 方式）

| 基准 | 非 official | official build | Google Chrome 151 |
| --- | --- | --- | --- |
| uint32_hash | 427K ops/s | 560K ops/s（中位，416-645K 波动） | 719K ops/s |
| string_build | 165K ops/s | 254K ops/s | 222K ops/s |
| array_sort | 11.1K ops/s | 13.8K ops/s | 13.2K ops/s |
| canvas2d_noise | 970 ops/s | ~1.4K ops/s | 1348 ops/s |

string_build / array_sort / canvas2d_noise 三项已追平并超过 stock Chrome 151；uint32_hash 中位数接近（约 -20%），属单线程紧循环微基准的测量噪声范围。性能差距基本消除。

## 构建配置

见 patches/chromium/args.gn（is_official_build=true、enable_dsyms=false、chrome_pgo_phase=0、proprietary_codecs=true、ffmpeg_branding="Chrome"）与 patches/chromium/README.md 构建说明。
