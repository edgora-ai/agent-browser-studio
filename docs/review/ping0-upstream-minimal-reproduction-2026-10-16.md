# Ping0 /env 两个未解决结果的最小复现

状态：供公开预览版材料使用的历史最小复现说明；截至原始记录时，未向站点维护者发送。未包含用户出口 IP、代理入口、账户、Cookie、激活信息或报告查询 ID。本文不是实站通过声明。

## 1. DNS 检测权威区不可达的服务方观测

2026-10-16，真实浏览器自然运行 `https://ping0.cc/env` 后，检测完成但 `resolver_count=0`、`xc.dns_blackhole.fail=true`。普通代理侧 DNS 和显式严格 Google DoH 两种生产启动均复现；没有修改站点响应、DNS 答案或关闭 TLS/DNSSEC 检查。

独立的 HTTPS DNS 服务查询同时记录到：

| 查询 | Google DNS JSON 的实际结果 |
| --- | --- |
| `ping0.cc NS` | Status 0，返回 `major.ns.cloudflare.com.`、`jill.ns.cloudflare.com.` |
| `d.ping0.cc NS` | Status 2；Comment=`Name servers did not respond [104.218.235.243].`；EDE 22，`At delegation d.ping0.cc for d.ping0.cc/ns` |
| `d.ping0.cc DS` | Status 0，无 DS 答案，返回父区 SOA |

这些响应的 `CD` 均为 false。更早的独立 Cloudflare wire 查询也返回 EDE 22/23，但不是同一事务，不能互相补填证据。

可供维护者重测的公开查询：

```sh
curl --fail --show-error 'https://dns.google/resolve?name=d.ping0.cc&type=NS&cd=0'
```

请核查 `d.ping0.cc` 的委派、104.218.235.243 上的 DNS 服务及到达路径，并核对该服务与 `/envdetect/probe/dnsleak` 的记录链。以上是解析器在观测时的报告，不声称已定位具体防火墙规则或证明全球持续宕机。

## 2. 真实 macOS / ANGLE Metal 输入被判 GPU 平台不一致

环境：Apple Silicon macOS，Chromium 152.0.7977.72，默认硬件 ANGLE Metal。没有 WebGL vendor/renderer override。真实自然 `POST /envdetect/submit` 包含：

```json
{
  "ident.platform": "MacIntel",
  "ident.ua_high_entropy": "{...\"architecture\":\"arm\",\"bitness\":\"64\",\"platform\":\"macOS\",...}",
  "hw.webgl_vendor": "Google Inc. (Apple)",
  "hw.webgl_renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)",
  "hw.webgpu_adapter_info": "{\"vendor\":\"apple\",\"architecture\":\"metal-3\",\"device\":\"\",\"description\":\"\"}"
}
```

上例使用点路径展示；实际上 `ident`/`hw` 是嵌套对象，高熵/WebGPU 字段则按页面 probe 实现序列化为字符串。原始请求和响应已经分别保留与校验 SHA-256；服务端 `evidence.ident` 和 `evidence.hw` 与自然请求完全相同。

服务端仍返回：

```json
{
  "id": "xc.ua_webgl",
  "value": {
    "platform": "MacIntel",
    "webgl_renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)"
  },
  "fail": true
}
```

`MacIntel` 是 macOS Chromium 的兼容性平台标识，不能单凭该名称断定物理 CPU 为 Intel。ANGLE Metal 是 macOS 的真实硬件路径，不是 Windows Direct3D。请在一台真实 Apple Silicon Mac 上自然运行页面，核查该规则的 macOS、ANGLE Metal 及字段解析分支。当前没有取得服务端代码，不能把某个猜测的正则表达式写成已证实根因。

## 浏览器侧边界

- 六上下文身份及独立 native-off CPU 对照通过，不替代 Ping0 判定。
- 使用固定出口后，地域、语言、时区及多出口失败消失；上述 DNS/GPU 两项仍在。
- 未修改第三方检测逻辑、重放篡改后的评分请求或伪造 GPU 字符串。
- 原始记录时因实站尚未通过，未生成最终交付安装包。后续公开预览候选的资产状态见[Firefox Auto 回归记录](firefox-auto-identity-regression-2026-10-17.md)；预览版不等于实站验收通过。
