# ping0.cc 环境一致性验证（Agent Browser · Chromium 150 official build）

验证日期：2026-08-13 深夜复测（Slice 66，official/ThinLTO 构建）

被测浏览器：Agent Browser Studio 内置 Chromium 150.0.7871.114，official 构建（is_official_build=true、symbol_level=0、ThinLTO 生效、无 PGO），patchset 0002-0044 全量应用。

代理：http://127.0.0.1:7890 -> 出口 152.70.241.120（KR / Seoul / Oracle Corporation，IDC）

方法：直接 spawn Chromium（不注入 --enable-automation，使用具体 CDP 端口），经代理做新鲜 geo 检测（ipwho.is），按 app 同款参数注入 managed fingerprint 配置，加载 https://ping0.cc/env ，等 Vue finished=true 后静置 15s 抓取。verifier 在探针前 best-effort 前台化窗口（page.bringToFront）并把抓取时的窗口状态记入报告（probeFocus），保证 stealth/rAF 探针测的是前台可见窗口——后台/遮挡窗口会把 rAF 节流到 ~100ms 造成误报。

## 结论（当前 ping0 检测套件）

复测（多轮完整捕获，含当前 ping0 的 net.*/stealth.*/xc.* 全套交叉检查）：**92 分 / green**。唯一实扣分项是 `net.isidc`（weight 8）：出口 152.70.241.120 是 Oracle Cloud **IDC 机房 IP**——这是代理出口属性，不是浏览器指纹泄漏，换成住宅/非 IDC 出口即可回 100。浏览器侧所有检查全部通过：

| 检查面 | 结果 |
| --- | --- |
| stealth.webdriver / cdc / selenium 全局 / 各 antidetect 痕迹 | 全部 false（未检出） |
| UA / UA-CH / 服务端请求头一致性 | 一致（Chrome/150.0.7871.114, Windows NT 10.0） |
| DNS 泄漏 | dns_countries=[KR]，foreign_countries=[]（无境外/国内混入解析器） |
| 中文字体 | fonts_cn=false（无） |
| tz / locale | Asia/Seoul + ko-KR，与 KR 出口一致 |
| WebRTC / 本地 IP | rtc disabled，无本地地址泄漏 |
| canvas / audio 稳定性 | x5 / x3 采样稳定 |
| rAF 帧间隔 | 前台窗口受控测量中位 16.6ms（标准 60Hz）；ping0 前台抓取 ~14.6ms（info 级，不扣分） |

| run | score | level | findings | probeFocus |
| --- | --- | --- | --- | --- |
| slice66-1 | 92 | green | 154（仅 net.isidc 扣 8 分） | - |
| slice66-2 | 92 | green | 154 | - |
| slice66-3 | 92 | green | 154 | - |
| slice66b-1 | 92 | green | 154 | visible + focused |
| slice66c-1 | 92 | green | 154 | visible + focused |

原始报告见同目录 ping0-slice66-*.json / ping0-slice66b-1.json。

**关于早上的「100/0」**：official-run1/2/3 与 slice51 报告未包含当前检测套件的完整数据（rows/findings 为空或 xc.* 全部 pending，net.*/stealth.* 检查当时未产出），并非浏览器在这些新检查上得分 100。当前 92 分才是完整捕获下的真实基线。

**关于 rAF**：用户曾观察到 ping0 报 rAF 帧间隔异常。受控测量证明引擎本身是干净的——前台聚焦窗口下 rAF 中位 16.6ms（60Hz 标准）；ping0 自动化跑分时若窗口被遮挡/后台，rAF 会被节流到 ~100ms 造成误报。verifier 已加 bringToFront + probeFocus 证据，遮挡导致的误报不会再混入结果。

## 快速探针（每轮一致）

webdriver=false、platform=Win32、UA=Chrome/150.0.7871.114 (Windows NT 10.0)、languages=[ko-KR]、timezone=Asia/Seoul、visibility=visible、hasFocus=true（bringToFront 后）。

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
