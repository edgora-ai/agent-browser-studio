// ── Agent Browser Studio main-process i18n (tray menu only) ──
// Renderer-side i18n is in src/renderer/js/i18n.js. This module mirrors
// the small subset of strings used by the tray menu, keyed identically.
// The renderer signals language changes via the "app:set-language" IPC.

let currentLang: "zh-CN" | "en-US" = "en-US";

const dict: Record<"zh-CN" | "en-US", Record<string, string>> = {
  "zh-CN": {
    "tray.show": "显示 Agent 浏览器工作台",
    "tray.running": "运行中配置",
    "tray.idle": "暂无配置在运行",
    "tray.quit": "退出 Agent 浏览器工作台",
    "tray.tooltip": "Agent Browser Studio",
  },
  "en-US": {
    "tray.show": "Show Agent Browser Studio",
    "tray.running": "Running profiles",
    "tray.idle": "No profiles running",
    "tray.quit": "Quit Agent Browser Studio",
    "tray.tooltip": "Agent Browser Studio",
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
