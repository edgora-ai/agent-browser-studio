# Android r13u：滚动卡死/白屏第三根因修复（触摸序列锁存，2026-11-14）

## 0. 先读结论

接手用户真机报告「来回切换 tab，滚动卡住」——真机现场捕获到第三条独立根因：

**渲染器 FATAL**：`cc/input/input_handler.cc:2689` DCHECK `!is_handling_touch_sequence || !is_handling_touch_sequence_`——tab 切换在页面触摸序列未结束时分离内容 surface，TouchEnd 永远不会送达，锁存停在 true；下一次 TouchStart 渲染器崩溃 → 内容冻结（用户看到的“卡住”）→ PRE_ANR（Choreographer 跳帧 13785）。官方 Chrome 发布版把这条 DCHECK 编译剔除、容忍重叠；我们的构建 DCHECK 生效故必崩。

**补丁 0064**：`SetIsHandlingTouchSequence(true)` 在已处理中变为 no-op（保留锁存，序列结束自然清除），false 恒生效——与发布版行为对齐。

**r13u（`ce7856db…`）真机验收**：5 轮「滚动 → 切 tab 打断触摸 → 滚动」复现场景 **FATAL 计数 0**（r13t 同手势必崩）；滚动以像素差分验证正常（gfxinfo 帧计数不归属 WebView 合成帧，改用像素差分）。白屏三根因至此全部闭环：中继允许名单（relay v3）、gUM 崩溃（0063）、触摸锁存（0064）。

## 1. 证据链

| 环节 | 内容 |
| --- | --- |
| 现场捕获 | 用户复现时 logcat：`FATAL cc/input/input_handler.cc:2689` + `PRE_ANR` + `Skipped 13785 frames` |
| 机制 | 委托应答/表面分离打断触摸 → TouchEnd 丢失 → 锁存 true → 下次 TouchStart 双重启动 → DCHECK |
| 修复 | 0064（sha e39b7a05…）：重叠时保留锁存不崩溃；false 恒生效 |
| 验收 | r13u 装机 sha 一致；5 轮复现 FATAL=0；滚动像素差分通过 |

## 2. 遗留与记录

- **渲染器编号膨胀**（当日到 37/40）：崩溃+切换的累计；彻底退出应用即清零。跨切换的渲染器复用是引擎级后续项。
- gfxinfo 帧计数不含 WebView 合成帧——滚动验证改用像素差分（测量口径记录在案）。
- ping0 评分：r13t=100/0；r13u 仅改输入路径，评分路径零差异。

## 3. 提交与证据

- 补丁：`0064-android-product-input-touch-latch.patch`（sha e39b7a05…）
- r13u：`ce7856db…`（装机 sha 一致）
- 证据：`.tmp-apk/proxy-fix-work/v13u/`（回执、host 三套件绿、run/ 截图）

关联：[r13t 终验](android-r13t-final-2026-11-14.md)、[r13s 清零轮](android-r13s-zeroing-2026-11-14.md)。
