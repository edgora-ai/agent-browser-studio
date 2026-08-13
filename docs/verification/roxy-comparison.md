# 与真实 RoxyBrowser 引擎的横向反检测对比（Slice 72）

验证日期：2026-08-14

被测对象：
- **我方引擎**：Agent Browser Studio 内置 Chromium 150.0.7871.114（official 构建），按 app 同款参数注入 managed 指纹（Windows 身份，tz/locale 随出口地理生成，走 proxy DNS / managed DoH）。
- **RoxyBrowser 真实引擎**：`RoxyBrowser/chrome-bin/149/RoxyChrome.app`（Chrome 149.0.7827.22）+ 真实 RoxyBrowser profile（US / macOS 身份：en-US、America/Los_Angeles、Intel Mac 10_15_7、AMD Radeon Pro 5500M），profile 复制到临时目录后启动（不触碰原数据），由引擎自带 `fingerprint_inject` 服务注入。

方法：两者走同一代理 `http://127.0.0.1:7890`，同一检测页 `https://ping0.cc/env`，同一 verifier 逻辑（等 Vue `finished=true` 再静置 15s 抓取、窗口 bringToFront、记录 probeFocus）。这是我们首次用**同一套方法**对真实 RoxyBrowser 跑完整 ping0。

## 结果

| run | 引擎 | 身份 | 出口 IP | score | 真实扣分 |
| --- | --- | --- | --- | --- | --- |
| slice72-2-1 | 我方 Chromium 150 | Win / KR | KR 152.70.241.120 | **92 / green** | 仅 `net.isidc`（Oracle IDC 出口，weight 8，代理属性非浏览器泄漏） |
| slice72-roxy1 | RoxyChrome 149 + 真实 profile | macOS / US | US 204.0.23.126 | **82 / yellow** | `xc.ip_fonts_cn`（8）+ `xc.dns_ip_country`（10） |
| slice72-roxy2 | RoxyChrome 149 + 真实 profile | macOS / US | US 204.0.23.126 | **82 / yellow** | 同上（复测稳定） |

> 注：slice72-1-1/1-2 两轮我方引擎在默认 180s 等待内未等完 ping0 末尾交叉检查，抓到的 `score=100 / 0 findings` 是**部分评估假象**（net.*/stealth.*/xc.* 尚未产出）。把等待提到 360s 后完整跑完，真实基线即 92（与 Slice 66 基线一致）。这也印证了「页面别关太快、要等监测结果出完」——verifier 默认等待已由 180s 提到 360s。

## 浏览器侧表面对比（ping0 完整评估）

| 检查面 | 我方（92/green） | RoxyChrome 真实 profile（82/yellow） |
| --- | --- | --- |
| stealth.webdriver / cdc / selenium_globals | false / false / false | false / false / false |
| 中文字体 `xc.ip_fonts_cn` | **has_cn_fonts=false**（fonts_count=10，`locale.fonts_cn=[]`） | **has_cn_fonts=true**（fonts_count=337，30+ 中文字体） |
| DNS 解析器 `xc.dns_ip_country` | **[KR]，foreign=[]**，与 KR 出口一致，无泄漏 | **[IN, IN]，foreign=[IN]**，与 US 出口不一致，真·泄漏 |
| DNS 解析器来源 | 1 个（proxy DNS / managed DoH） | 2 个（系统/Google DNS，172.253.244.x） |
| rtc.local_ip | 空（mDNS 混淆，无本地 IP） | 空（无本地 IP） |
| tz / locale / voices 一致性 | Asia/Seoul + ko-KR + voice_top=KR，自洽 | America/Los_Angeles + en-US + voice_top=US，自洽 |
| UA / UA-CH 服务端一致性 | 通过（Chrome/150，Win） | 通过（Chrome/148，Intel Mac） |
| WebGL 身份 | Google Inc. (NVIDIA) / RTX 3060 D3D11（Win 身份） | AMD / Radeon Pro 5500M OpenGL（Mac 身份） |
| canvas / audio 稳定性 | x5 / x3 采样稳定 | x5 / x3 采样稳定 |
| api.missing_count | 0 | 0 |

## 结论

1. **浏览器侧两者都干净**：webdriver/cdc/selenium/antidetect 痕迹、UA 一致性、WebRTC、canvas/audio 稳定性全部通过。
2. **用户此前给我们点名的两类问题，RoxyBrowser 自己也存在，且我们处理得更干净**：
   - 中文字体：RoxyBrowser 不剥离 CN 字体（继承宿主机字体表，本机装有中文字体即暴露 337 个含 SimSun/雅黑/苹方等）；我方引擎已剥离，`fonts_cn=[]`。
   - DNS 泄漏：RoxyBrowser 用系统 DNS（本机解析到 Google 印度节点 172.253.244.x），与 US 出口不一致；我方引擎走 proxy DNS / managed DoH，解析器与出口同国。
3. **双方唯一的分差来源不同**：我方扣分项是代理出口是 Oracle IDC（换住宅/非 IDC 出口即回 100）；RoxyBrowser 扣分项是浏览器侧真实泄漏（字体 + DNS）。

## 原始表面探针（about:blank）说明

- 双方 `navigator.userAgentData.getHighEntropyValues` 在 about:blank 上均返回空对象，而 ping0（https 页面）能取到真实高熵值——是页面上下文差异，非两者差异。
- `document.fonts.check` 对两引擎返回同一份系统字体表（约 30 项含 CN）——该 API 反映 macOS 系统字体可用性，两个引擎都没对它注入，不是区分项；区分以 ping0 的字体枚举为准（我方 10 个无 CN / Roxy 337 个含 CN）。
- WebRTC ICE 主机候选：我方返回 1 个 mDNS `.local` 候选（标准 Chrome 混淆），RoxyChrome 返回空（彻底隐藏）——两者都不泄漏本地 IP。

## 复现方式

```bash
npm run build
# 我方引擎（含 managed 指纹 + ping0）
node dist/tools/verify-ping0.js --browser="$HOME/.agent-browser-studio/chromium-150.0.7871.114/Chromium.app" --upstream=127.0.0.1:7890 --runs=1 --tag=slice72-2 --out=docs/verification
# RoxyChrome 149 + 真实 profile 副本（对比工具）
node dist/tools/compare-roxy-ping0.js --roxy="/Users/ahoo/Library/Application Support/RoxyBrowser/chrome-bin/149/RoxyChrome.app" --profile="/Users/ahoo/Library/Application Support/RoxyBrowser/browser-cache/<uuid>" --upstream=127.0.0.1:7890 --tag=slice72-roxy1 --out=docs/verification
# 我方引擎原始表面（同一探针）
node dist/tools/compare-roxy-ping0.js --ours="$HOME/.agent-browser-studio/chromium-150.0.7871.114/Chromium.app" --upstream=127.0.0.1:7890 --raw-only --tag=slice72-ours1 --out=docs/verification
```

原始报告：`ping0-slice72-1-{1,2}.json`、`ping0-slice72-2-1.json`、`roxy-ping0-slice72-roxy1.json`、`roxy-ping0-slice72-roxy2.json`、`ours-raw-slice72-ours1.json`（同目录）。
