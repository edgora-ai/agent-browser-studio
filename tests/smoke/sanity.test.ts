// Smoke tests — verify all key files exist, compile, and basic structures are valid
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

describe("Smoke — Project Structure", () => {
  const requiredFiles = [
    "src/main/index.ts",
    "src/main/preload.cjs",
    "src/main/ipc/profile.ts",
    "src/main/ipc/proxy.ts",
    "src/main/ipc/storage.ts",
    "src/main/ipc/sync.ts",
    "src/main/ipc/app.ts",
    "src/main/ipc/detect.ts",
    "src/main/ipc/settings.ts",
    "src/main/ipc/agent.ts",
    "src/main/ipc/mcp.ts",
    "src/main/ipc/browser.ts",
    "src/main/services/config-manager.ts",
    "src/main/services/profile-manager.ts",
    "src/main/services/storage-monitor.ts",
    "src/main/services/sync-service.ts",
    "src/main/services/local-agent.ts",
    "src/main/services/mcp-server.ts",
    "src/main/services/cdp-cookie-service.ts",
    "src/main/services/webrtc-detector.ts",
    "src/main/services/launch-args.ts",
    "src/main/services/browser-manager.ts",
    "src/main/types.ts",
    "src/tools/network-fingerprint-corpus.ts",
    "src/tools/verify-network-fingerprint.ts",
    "src/renderer/index.html",
    "src/renderer/css/style.css",
    "src/renderer/js/app/core.js",
    "src/renderer/js/app/tabs.js",
    "src/renderer/js/app/profiles.js",
    "src/renderer/js/app/proxies.js",
    "src/renderer/js/app/extensions.js",
    "src/renderer/js/app/cookies.js",
    "src/renderer/js/app/sync.js",
    "src/renderer/js/app/browser.js",
    "src/renderer/js/app/accounts.js",
    "src/renderer/js/app/agent-chat.js",
    "src/renderer/js/app/agent-config.js",
    "src/renderer/js/app/agent-skills.js",
    "src/renderer/js/app/wizard.js",
    "src/renderer/js/app/delegation.js",
    "src/renderer/js/app/init.js",
    "src/renderer/js/i18n.js",
    "package.json",
    "tsconfig.json",
    "electron-builder.yml",
    "resources/icon.icns",
    "README.md",
  ];

  for (const file of requiredFiles) {
    it(`exists: ${file}`, () => {
      const p = path.join(ROOT, file);
      expect(fs.existsSync(p), `${file} is missing`).toBe(true);
    });
  }
});

describe("Smoke — TypeScript", () => {
  it("tsconfig.json is valid JSON", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "tsconfig.json"), "utf-8"));
    expect(cfg.compilerOptions).toBeDefined();
    expect(cfg.compilerOptions.target).toBe("ES2022");
    expect(cfg.compilerOptions.strict).toBe(true);
  });

  it("package.json is valid JSON", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    expect(pkg.name).toBe("agent-browser-studio");
    expect(pkg.version).toBeDefined();
    expect(pkg.main).toBe("dist/main/index.js");
    expect(pkg.scripts["verify:network"]).toContain("verify-network-fingerprint.js");
  });

  it("electron-builder.yml exists and has mac config", () => {
    const yml = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf-8");
    expect(yml).toContain("mac:");
    expect(yml).toContain("arm64");
  });
});

describe("Smoke — Preload API completeness", () => {
  it("preload exposes all required API groups", () => {
    const preload = fs.readFileSync(path.join(ROOT, "src/main/preload.cjs"), "utf-8");
    const groups = ["profile", "proxy", "detect", "storage", "sync", "app", "settings", "mcp", "browser", "agent"];
    for (const g of groups) {
      expect(preload, `preload missing ${g} group`).toContain(g + ":");
    }
  });

  it("preload exposes on/removeListener", () => {
    const preload = fs.readFileSync(path.join(ROOT, "src/main/preload.cjs"), "utf-8");
    expect(preload).toContain("on:");
    expect(preload).toContain("removeListener:");
  });
});

describe("Smoke — IPC handler registration", () => {
  it("all IPC modules are registered in index.ts", () => {
    const index = fs.readFileSync(path.join(ROOT, "src/main/index.ts"), "utf-8");
    const handlers = [
      "registerProfileHandlers", "registerProxyHandlers",
      "registerStorageHandlers", "registerSyncHandlers", "registerAppHandlers",
      "registerDetectHandlers", "registerSettingsHandlers",
      "registerAgentHandlers", "registerMcpHandlers", "registerBrowserHandlers",
    ];
    for (const h of handlers) {
      expect(index, `index.ts missing ${h}`).toContain(h);
    }
  });
});

describe("Smoke — HTML structure", () => {
  it("all tab sections exist", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    const tabs = ["profiles", "proxy", "storage", "sync", "agent"];
    for (const t of tabs) {
      expect(html, `missing tab-${t}`).toContain(`tab-${t}`);
    }
  });

  it("all dialogs exist", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    const dialogs = ["dlg-profile", "dlg-rename", "dlg-cookies", "dlg-proxy", "dlg-confirm", "dlg-extensions", "dlg-skill-market", "dlg-account", "dlg-note", "dlg-agent-browser-seed"];
    for (const d of dialogs) {
      expect(html, `missing dialog ${d}`).toContain(`id="${d}"`);
    }
  });

  it("no images or external resources (CSP safe)", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toMatch(/<img src="https?:/);
    expect(html).not.toMatch(/<link rel="stylesheet" href="https?:/);
  });

  it("script tags are local only", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    const scripts = html.match(/<script[^>]*src="([^"]+)"/g) || [];
    for (const s of scripts) {
      const src = s.match(/src="([^"]+)"/)![1];
      expect(src, `external script: ${src}`).not.toMatch(/^https?:/);
    }
  });
});

describe("Smoke — Resources", () => {
  it("icon.icns exists", () => {
    expect(fs.existsSync(path.join(ROOT, "resources", "icon.icns"))).toBe(true);
  });
});

describe("Smoke — Delegation regressions", () => {
  // Guards against the class of bug where HTML emitted data-* attributes with a
  // literal "undefined" string (e.g. data-cmd-arg="undefined"), which silently
  // broke all nav/dialog/random-seed clicks. See e2e/journey.test.ts + j1-j4.
  it("index.html has no data-* attribute set to literal \"undefined\"", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    const matches = html.match(/data-[a-z-]+="undefined"/gi) || [];
    expect(matches, `found undefined data-* attrs: ${matches.join(", ")}`).toEqual([]);
  });

  it("every nav-item carries data-tab and data-cmd=\"switchTab\"", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    const navItems = html.match(/<li class="nav-item[^"]*"[^>]*>/g) || [];
    expect(navItems.length).toBeGreaterThanOrEqual(8);
    for (const li of navItems) {
      expect(li).toMatch(/data-tab="[^"]+"/);
      expect(li).toContain('data-cmd="switchTab"');
    }
  });

  it("delegation.js is defensive against the literal undefined arg/target", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/renderer/js/app/delegation.js"), "utf-8");
    expect(src).toContain("arg !== 'undefined'");
    expect(src).toContain("targetId !== 'undefined'");
  });
});
