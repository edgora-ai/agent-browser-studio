// ── Agent Browser Studio main-process i18n ──
// Renderer-side i18n is in src/renderer/js/i18n.js. This module mirrors the
// subset of strings the main process itself renders, keyed identically.
// The renderer signals language changes via the "app:set-language" IPC.
//
// R146: this started as "tray menu only", which left service-layer copy stuck
// in one language. proxy-health.ts emitted Chinese suggestions, so the EN UI
// showed Chinese on every proxy card — the mirror image of the renderer leak
// (English baked into zh). Any user-visible string the main process composes
// belongs here, not inline in the service.

let currentLang: "zh-CN" | "en-US" = "en-US";

const dict: Record<"zh-CN" | "en-US", Record<string, string>> = {
  "zh-CN": {
    "tray.show": "显示 Agent 浏览器工作台",
    "tray.running": "运行中配置",
    "tray.idle": "暂无配置在运行",
    "tray.quit": "退出 Agent 浏览器工作台",
    "tray.tooltip": "Agent Browser Studio",
    "proxy.sug.cooldown": "连续失败 ≥3 次，已进入 30 分钟冷却，建议先检查代理凭据或更换节点",
    "proxy.sug.consecutive": "连续失败，建议更换节点或检查代理配置",
    "proxy.sug.geo-drift": "出口国家/地区频繁漂移，建议固定到单一节点",
    "proxy.sug.ip-drift": "出口 IP 频繁漂移，可能触发账号风控，建议使用固定 IP",
    "proxy.sug.idc": "出口是机房/IDC IP{who}，云机房出口会被 ping0/平台风控标记（net.isidc），建议换住宅/非 IDC 出口",
    "proxy.sug.idc-org": "（{who}）",
    "proxy.sug.latency": "延迟偏高，建议换更近的节点",
    "proxy.sug.unchecked": "尚未检测",
    "proxy.sug.good": "状态良好",
    "webrtc.sum.no-result": "探测无结果",
    "webrtc.sum.unavailable": "WebRTC 不可用（被指纹策略禁用或移除）",
    "webrtc.sum.error": "探测异常：",
    "webrtc.sum.host-ip": "暴露本地 IP：",
    "webrtc.sum.mdns-only": "仅暴露 mDNS 主机名，无本地 IP 泄漏",
    "webrtc.sum.clean": "未检测到本地 IP 泄漏",
    "webrtc.sum.inconclusive": "探针未完成或未获得可用的 ICE 证据",
    "health.env.no-findings": "已完成的检查未发现风险信号",
    "health.env.inconclusive": "部分环境检查尚未验证",
    "health.env.font-scan-unavailable": "部分主机字体目录无法读取；空列表不能证明未安装字体。",
    "health.env.font-scan-retry": "请检查字体目录的访问权限后重试。",
    "health.env.raf-unavailable": "无法测量帧时序，尚未完成验证。",
    "health.env.raf-retry": "请将配置的浏览器切换到前台后重试。",
    "health.env.font-probe-unavailable": "无法验证浏览器字体暴露情况；主机存在某字体不代表运行时已暴露。",
    "health.env.font-probe-retry": "请在已启动配置的普通网页中重试。",
    "health.env.dns-resolver-unknown": "尚未验证上游 DNS；本地存根、路由器或未知地址不能证明解析归属国家。",
    "health.env.dns-resolver-retry": "请核对实际上游 DNS 交易；仅凭系统配置地址不足以完成验证。",
    "health.env.font-platform-mismatch": "浏览器实际暴露了与声明平台不一致的字体：{fonts}",
    "health.env.font-platform-unverified": "主机存在下列字体，但尚未验证浏览器是否隔离：{fonts}",
    "health.env.font-platform-retry": "请核对声明的平台，并在运行中的浏览器内验证字体暴露情况。",
    "health.env.runtime-proxy-unavailable": "该运行进程没有可验证的启动代理快照；当前设置不能证明其实际路由。",
    "health.env.runtime-proxy-retry": "请通过正常启动流程重启该配置，再核验启动时的代理设置。",
    "health.env.proxy-dns-unknown": "虽然配置了代理路由，但本次检查未观测浏览器 DNS 交易，无法证明已绕过主机解析器。",
    "health.env.proxy-direct": "直连配置：已读取主机 DNS 设置，但浏览器实际解析链路仍需交易证据。",
    "health.env.proxy-configured": "代理协议配置预期使用代理端 DNS；未采集 DNS 交易，不能仅凭类型证明无泄漏。",
    "proxy.rotate.reason-cooldown": "冷却中（连续失败）",
    "proxy.rotate.reason-poor": "健康评分较差",
    "sync.warn.remote-locks": "远端 {n} 个 profile 被其他设备锁定，Push 会被拒绝（除非强制）：{ids}（{owners}）",
    "sync.warn.push-removes-profiles": "Push 会把 {n} 个远端独有的 profile 从远端移除（本地不存在）：{ids}",
    "sync.warn.push-removes-proxies": "Push 会把 {n} 个远端独有的代理从远端移除：{ids}",
    "sync.warn.push-removes-extensions": "Push 会把 {n} 个远端独有的扩展从远端移除",
    "sync.warn.push-removes-accounts": "Push 会把 {n} 个远端独有的账号从远端移除",
    "sync.note.pull-imports-profiles": "Pull 会把 {n} 个远端独有的 profile 导入本地：{ids}",
    "sync.note.pull-imports-proxies": "Pull 会把 {n} 个远端独有的代理导入本地",
    "sync.note.pull-overwrites-conflicts": "Pull 会用远端版本覆盖 {n} 个两边都有的 profile 冲突字段（本地优先不覆盖整档）",
    "notify.done": "定时任务已完成",
    "notify.failed": "定时任务执行失败",
    "notify.cancelled": "定时任务已取消",
    "notify.missed": "定时任务已错过",
    "notify.default-rule-name": "定时任务",
    "archive.export.title": "导出配置备份",
    "archive.export.batch-title": "批量导出配置备份",
    "archive.import.title": "导入配置备份",
    "archive.import.batch-title": "批量导入配置备份",
    "archive.filter.backup": "配置备份",
    "archive.replace.title": "替换现有备份？",
    "archive.replace.message": "替换 {n} 个现有备份文件？",
    "archive.replace.detail": "仅允许替换下列现有备份文件：\n{files}",
    "archive.replace.confirm": "替换备份",
    "archive.cancel": "取消",
  },
  "en-US": {
    "tray.show": "Show Agent Browser Studio",
    "tray.running": "Running profiles",
    "tray.idle": "No profiles running",
    "tray.quit": "Quit Agent Browser Studio",
    "tray.tooltip": "Agent Browser Studio",
    "proxy.sug.cooldown": "3+ consecutive failures — in a 30-minute cooldown. Check the proxy credentials or switch nodes.",
    "proxy.sug.consecutive": "Failing repeatedly — switch nodes or check the proxy configuration.",
    "proxy.sug.geo-drift": "Exit country/region keeps drifting — pin this proxy to a single node.",
    "proxy.sug.ip-drift": "Exit IP keeps drifting, which can trigger account risk checks — use a fixed IP.",
    "proxy.sug.idc": "Exit is a datacenter/IDC IP{who}. Cloud datacenter exits get flagged by ping0 and platform risk engines (net.isidc) — prefer a residential, non-IDC exit.",
    "proxy.sug.idc-org": " ({who})",
    "proxy.sug.latency": "Latency is high — switch to a closer node.",
    "proxy.sug.unchecked": "Not checked yet",
    "proxy.sug.good": "Healthy",
    "webrtc.sum.no-result": "No result from the probe",
    "webrtc.sum.unavailable": "WebRTC unavailable (disabled or removed by fingerprint policy)",
    "webrtc.sum.error": "Probe error: ",
    "webrtc.sum.host-ip": "Local IP exposed: ",
    "webrtc.sum.mdns-only": "Only mDNS hostnames exposed — no local IP leak",
    "webrtc.sum.clean": "No local IP leak detected",
    "webrtc.sum.inconclusive": "The probe did not complete with usable ICE evidence",
    "health.env.no-findings": "No risk signals found in the completed checks",
    "health.env.inconclusive": "Some environment checks were not verified",
    "health.env.font-scan-unavailable": "Some host font directories could not be read; an empty list is not proof that no fonts are installed.",
    "health.env.font-scan-retry": "Check access to the font directories and retry.",
    "health.env.raf-unavailable": "Frame timing could not be measured; it has not been verified.",
    "health.env.raf-retry": "Bring the profile to the foreground and retry.",
    "health.env.font-probe-unavailable": "Browser font exposure could not be verified; host presence is not runtime exposure evidence.",
    "health.env.font-probe-retry": "Retry with a running profile on a normal page.",
    "health.env.dns-resolver-unknown": "The upstream resolver is unverified; a local stub, router or unknown address does not establish its country.",
    "health.env.dns-resolver-retry": "Verify the actual upstream DNS transactions; the configured address alone is insufficient.",
    "health.env.font-platform-mismatch": "The browser exposed fonts inconsistent with its declared platform: {fonts}",
    "health.env.font-platform-unverified": "Host fonts were found, but browser isolation has not been verified: {fonts}",
    "health.env.font-platform-retry": "Review the declared platform and verify font exposure in the running browser.",
    "health.env.runtime-proxy-unavailable": "This running process has no verified launch proxy snapshot; current settings are not evidence of its active route.",
    "health.env.runtime-proxy-retry": "Restart the profile through its normal launch flow before checking the launch configuration again.",
    "health.env.proxy-dns-unknown": "A proxy route is configured, but this check did not observe browser DNS transactions and cannot certify that host resolvers were bypassed.",
    "health.env.proxy-direct": "Direct configuration: host DNS settings were read, but the browser's actual resolver path still needs transaction evidence.",
    "health.env.proxy-configured": "The proxy protocol is configured for proxy-side DNS; without DNS transactions, its type alone does not prove that no queries leak.",
    "proxy.rotate.reason-cooldown": "in cooldown (repeated failures)",
    "proxy.rotate.reason-poor": "health score is poor",
    "sync.warn.remote-locks": "{n} profile(s) are locked by another device; push will be rejected unless forced: {ids} ({owners})",
    "sync.warn.push-removes-profiles": "Push will remove {n} remote-only profile(s) from the remote: {ids}",
    "sync.warn.push-removes-proxies": "Push will remove {n} remote-only proxy/proxies from the remote: {ids}",
    "sync.warn.push-removes-extensions": "Push will remove {n} remote-only extension(s) from the remote",
    "sync.warn.push-removes-accounts": "Push will remove {n} remote-only account(s) from the remote",
    "sync.note.pull-imports-profiles": "Pull will import {n} remote-only profile(s): {ids}",
    "sync.note.pull-imports-proxies": "Pull will import {n} remote-only proxy/proxies",
    "sync.note.pull-overwrites-conflicts": "Pull will overwrite conflicting fields on {n} profile(s) present on both sides (local-first does not replace the whole profile)",
    "notify.done": "Scheduled task finished",
    "notify.failed": "Scheduled task failed",
    "notify.cancelled": "Scheduled task cancelled",
    "notify.missed": "Scheduled task missed",
    "notify.default-rule-name": "Scheduled task",
    "archive.export.title": "Export Profile Backup",
    "archive.export.batch-title": "Export Profile Backups",
    "archive.import.title": "Import Profile Backup",
    "archive.import.batch-title": "Import Profile Backups",
    "archive.filter.backup": "Profile backup",
    "archive.replace.title": "Replace existing backups?",
    "archive.replace.message": "Replace {n} existing backup file(s)?",
    "archive.replace.detail": "Only these existing backup files are approved for replacement:\n{files}",
    "archive.replace.confirm": "Replace backups",
    "archive.cancel": "Cancel",
  },
};

export function setMainLanguage(lang: string): void {
  if (lang === "zh-CN" || lang === "en-US") {
    currentLang = lang;
  }
}

export function getMainLanguage(): "zh-CN" | "en-US" {
  return currentLang;
}

export function tMain(key: string, fallback?: string): string {
  const bundle = dict[currentLang] || dict["en-US"];
  if (bundle && bundle[key] !== undefined) return bundle[key];
  if (dict["en-US"][key] !== undefined) return dict["en-US"][key];
  return fallback !== undefined ? fallback : key;
}

export function detectInitialLanguage(): "zh-CN" | "en-US" {
  // Best-effort: use process.env.LANG or default to en-US.
  // The renderer will push the actual user choice via IPC after window load.
  const lang = String(process.env.LANG || process.env.LC_ALL || "").toLowerCase();
  if (/^zh/.test(lang)) return "zh-CN";
  return "en-US";
}
