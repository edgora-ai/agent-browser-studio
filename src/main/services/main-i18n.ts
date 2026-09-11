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
