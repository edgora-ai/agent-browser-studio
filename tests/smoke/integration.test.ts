// Integration tests — cross-module consistency
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const RENDERER_MODULE_DIR = path.join(ROOT, "src/renderer/js/app");
const readRendererModule = (name: string): string => fs.readFileSync(path.join(RENDERER_MODULE_DIR, name), "utf-8");
const readRendererModules = (): string => fs.readdirSync(RENDERER_MODULE_DIR)
  .filter((file) => file.endsWith(".js"))
  .map((file) => readRendererModule(file))
  .join("\n");

describe("Integration — IPC System", () => {
  it("all expected IPC channels are registered", () => {
    const ipcFiles = fs.readdirSync(path.join(ROOT, "src/main/ipc")).filter(f => f.endsWith(".ts"));
    const channels: string[] = [];
    for (const f of ipcFiles) {
      const content = fs.readFileSync(path.join(ROOT, "src/main/ipc", f), "utf-8");
      for (const m of content.matchAll(/ipcMain\.handle\("([^"]+)"/g)) channels.push(m[1]);
    }
    expect(channels.length).toBeGreaterThan(20);
    const expected = [
      "profile:list",
      "cloak:launch",
      "proxy:list",
      "sync:push",
      "agent:chat",
      "agent:conversations:list",
      "agent:accounts:list",
      "agent:skills:list",
      "agent:skills:marketplace",
      "agent:skills:add",
      "agent:skills:install",
      "agent:skills:remove",
      "agent:skills:set-meta",
      "agent:skills:export-shared",
      "agent:skills:import-shared",
      "mcp:status",
      "mcp:restart",
      "mcp:reveal-token",
      "settings:extensions",
      "settings:extension-repository",
      "settings:add-repository-extension",
      "detect:webrtc-leak",
    ];
    for (const ch of expected) expect(channels, `missing ${ch}`).toContain(ch);
  });

  it("no duplicate IPC channel names", () => {
    const ipcFiles = fs.readdirSync(path.join(ROOT, "src/main/ipc")).filter(f => f.endsWith(".ts"));
    const chMap = new Map<string, string[]>();
    for (const f of ipcFiles) {
      for (const m of fs.readFileSync(path.join(ROOT, "src/main/ipc", f), "utf-8").matchAll(/ipcMain\.handle\("([^"]+)"/g)) {
        if (!chMap.has(m[1])) chMap.set(m[1], []);
        chMap.get(m[1])!.push(f);
      }
    }
    const dupes = [...chMap].filter(([, files]) => files.length > 1);
    expect(dupes, "Duplicate IPC channels").toHaveLength(0);
  });

  it("preload invocations map to existing IPC channels", () => {
    const ipcFiles = fs.readdirSync(path.join(ROOT, "src/main/ipc")).filter(f => f.endsWith(".ts"));
    const ipcChannels = new Set<string>();
    for (const f of ipcFiles) {
      for (const m of fs.readFileSync(path.join(ROOT, "src/main/ipc", f), "utf-8").matchAll(/ipcMain\.handle\("([^"]+)"/g)) {
        ipcChannels.add(m[1]);
      }
    }
    const preload = fs.readFileSync(path.join(ROOT, "src/main/preload.cjs"), "utf-8");
    for (const m of preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)) {
      expect(ipcChannels.has(m[1]), `preload invokes non-existent: ${m[1]}`).toBe(true);
    }
  });

  it("all IPC modules are registered in index.ts", () => {
    const idx = fs.readFileSync(path.join(ROOT, "src/main/index.ts"), "utf-8");
    for (const h of ["Profile", "Proxy", "Storage", "Sync", "App", "Detect", "Settings", "Agent", "Mcp", "Cloak"]) {
      expect(idx).toContain("register" + h + "Handlers");
    }
  });
});

describe("Integration — Extensions", () => {
  it("private repository functions are properly exported", () => {
    const repo = fs.readFileSync(path.join(ROOT, "src/main/services/extension-repository.ts"), "utf-8");
    expect(repo).toContain("export function listExtensionRepository");
    expect(repo).toContain("export async function addOrUpdateChromeStoreExtension");
    expect(repo).toContain("export function deleteRepositoryExtension");
    expect(repo).toContain("export function exportSharedExtensionRepository");
    expect(repo).toContain("export function getEnabledRepositoryExtensionPaths");
  });

  it("MCP tools route extension work through the private repository", () => {
    const mcp = fs.readFileSync(path.join(ROOT, "src/main/services/mcp-server.ts"), "utf-8");
    expect(mcp).toContain("cloak_list_extensions");
    expect(mcp).toContain("cloak_install_extension");
    expect(mcp).toContain("cloak_delete_extension");
    expect(mcp).toContain("addOrUpdateChromeStoreExtension");
    expect(mcp).toContain("listExtensionRepository");
    expect(mcp).not.toContain("getProfileExtensionsDir");
    expect(mcp).not.toContain("execFileSync");
  });

  it("repository extraction does not shell out to unzip files into place", () => {
    const repo = fs.readFileSync(path.join(ROOT, "src/main/services/extension-repository.ts"), "utf-8");
    expect(repo).toContain("function extractZipSafely");
    expect(repo).toContain("isSymlink");
    expect(repo).not.toContain("execFileSync(\"unzip\", [\"-q\"");
    expect(repo).not.toContain("execFileSync(\"unzip\", [\"-o\"");
  });
});

describe("Integration — Packaging", () => {
  it("build script copies icon.icns to dist/resources", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts.build).toContain("icon.icns");
  });

  it("electron-builder.yml references icon", () => {
    const yml = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf-8");
    expect(yml).toContain("icon:");
    expect(yml).toContain("icon.icns");
  });
});

describe("Integration — Type completeness", () => {
  it("MgmtConfig declares llm and accounts fields", () => {
    const types = fs.readFileSync(path.join(ROOT, "src/main/types.ts"), "utf-8");
    expect(types).toContain("interface LlmConfig");
    expect(types).toContain("interface PlatformAccount");
    expect(types).toContain("llm?: LlmConfig");
    expect(types).toContain("accounts?: PlatformAccount[]");
  });

  it("config-manager normalizes llm and accounts on save", () => {
    const cm = fs.readFileSync(path.join(ROOT, "src/main/services/config-manager.ts"), "utf-8");
    expect(cm).toContain("normalizeLlmConfig");
    expect(cm).toContain("normalizeAccounts");
  });

  it("local-agent has no `as any` casts on getConfig calls", () => {
    const la = fs.readFileSync(path.join(ROOT, "src/main/services/local-agent.ts"), "utf-8");
    expect(la).not.toMatch(/getConfig\(\) as any/);
  });
});

describe("Integration — Agent Run trace", () => {
  it("MgmtConfig declares agentRuns and agentFs", () => {
    const types = fs.readFileSync(path.join(ROOT, "src/main/types.ts"), "utf-8");
    expect(types).toContain("interface AgentRun ");
    expect(types).toContain("agentRuns?: AgentRun[]");
    expect(types).toContain("agentFs?: AgentFsConfig");
  });

  it("config-manager normalizes agentRuns + agentFs", () => {
    const cm = fs.readFileSync(path.join(ROOT, "src/main/services/config-manager.ts"), "utf-8");
    expect(cm).toContain("normalizeAgentRuns");
    expect(cm).toContain("normalizeAgentFs");
  });

  it("preload exposes agentRuns API + run event channels", () => {
    const preload = fs.readFileSync(path.join(ROOT, "src/main/preload.cjs"), "utf-8");
    expect(preload).toContain('ipcRenderer.invoke("agent-run:list")');
    expect(preload).toContain('ipcRenderer.invoke("agent-run:get"');
    expect(preload).toContain("agent:run-step");
    expect(preload).toContain("agent:run-finish");
  });

  it("local-agent registers the 5 new external tools", () => {
    const la = fs.readFileSync(path.join(ROOT, "src/main/services/local-agent.ts"), "utf-8");
    expect(la).toContain('name: "http_request"');
    expect(la).toContain('name: "set_var"');
    expect(la).toContain('name: "get_var"');
    expect(la).toContain('name: "read_file"');
    expect(la).toContain('name: "write_file"');
  });
});

describe("Integration — Agent DB + approval", () => {
  it("local-agent registers db_query + db_exec tools", () => {
    const la = fs.readFileSync(path.join(ROOT, "src/main/services/local-agent.ts"), "utf-8");
    expect(la).toContain('name: "db_query"');
    expect(la).toContain('name: "db_exec"');
    expect(la).toContain("classifyDbSql");
  });
  it("preload exposes agentDb + approval + approval event channel", () => {
    const preload = fs.readFileSync(path.join(ROOT, "src/main/preload.cjs"), "utf-8");
    expect(preload).toContain('ipcRenderer.invoke("agent-db:tables")');
    expect(preload).toContain('ipcRenderer.invoke("approval:resolve"');
    expect(preload).toContain("agent:approval-request");
  });
});

describe("Integration — Dead code cleanup", () => {
  it("does not import dead services", () => {
    for (const svc of ["agy-wrapper.ts", "playwright-bridge.ts"]) {
      expect(fs.existsSync(path.join(ROOT, "src/main/services", svc)), `${svc} should be removed`).toBe(false);
    }
  });

  it("no stale ipc, preload, or test files remain", () => {
    const stale = [
      "src/main/ipc/chrome.ts", "src/main/ipc/firefox.ts", "src/main/ipc/updater.ts",
      "src/main/preload.ts",
      "src/main/services/chrome-manager.ts", "src/main/services/firefox-manager.ts",
      "src/main/services/fingerprint-library.ts", "src/main/services/fingerprint-service.ts",
      "src/main/services/lumi-service.ts", "src/main/services/updater-service.ts",
      "tests/unit/chrome-os-dataflow.test.ts", "tests/unit/fingerprint.test.ts", "tests/unit/lumi.test.ts",
    ];
    for (const p of stale) {
      expect(fs.existsSync(path.join(ROOT, p)), `${p} should be removed`).toBe(false);
    }
  });
});

describe("Integration — System tray", () => {
  it("tray-manager service exists and exports required functions", () => {
    const tm = fs.readFileSync(path.join(ROOT, "src/main/services/tray-manager.ts"), "utf-8");
    expect(tm).toContain("export function createTray");
    expect(tm).toContain("export function refreshTrayMenu");
    expect(tm).toContain("export function destroyTray");
    expect(tm).toContain("setTemplateImage(true)");
  });

  it("index.ts wires tray + close-to-hide behavior", () => {
    const idx = fs.readFileSync(path.join(ROOT, "src/main/index.ts"), "utf-8");
    expect(idx).toContain("createTray(");
    expect(idx).toContain("destroyTray()");
    expect(idx).toContain("isQuitting");
    expect(idx).toContain('mainWindow.on("close"');
  });

  it("tray icon resource exists and is bundled", () => {
    expect(fs.existsSync(path.join(ROOT, "resources/tray-icon-Template.png"))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts.build).toContain("tray-icon-Template.png");
  });
});

describe("Integration — Child process cleanup", () => {
  it("before-quit calls stopAllCloakProfiles and stopMcpServer", () => {
    const idx = fs.readFileSync(path.join(ROOT, "src/main/index.ts"), "utf-8");
    expect(idx).toContain("stopAllCloakProfiles()");
    expect(idx).toContain("stopMcpServer()");
  });

  it("cloak-manager exports stopAllCloakProfiles", () => {
    const cm = fs.readFileSync(path.join(ROOT, "src/main/services/cloak-manager.ts"), "utf-8");
    expect(cm).toContain("export function stopAllCloakProfiles()");
  });
});

describe("Integration — Agent LLM provider", () => {
  it("supports both OpenAI and Claude providers in HTML", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    expect(html).toContain('value="openai"');
    expect(html).toContain('value="claude"');
    expect(html).toContain('data-change-cmd="agentProviderChanged"');
  });

  it("Claude API and OpenAI API endpoints are correctly defaulted", () => {
    const la = fs.readFileSync(path.join(ROOT, "src/main/services/local-agent.ts"), "utf-8");
    expect(la).toContain("https://api.anthropic.com/v1/messages");
    expect(la).toContain("https://api.openai.com/v1/chat/completions");
    // Auto-detect from .claude/settings.json
    expect(la).toContain("ANTHROPIC_BASE_URL");
    expect(la).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("OpenAI URL normalizer handles bare /v1 and /chat/completions", () => {
    const la = fs.readFileSync(path.join(ROOT, "src/main/services/local-agent.ts"), "utf-8");
    expect(la).toContain("function normalizeOpenAIUrl");
    expect(la).toContain('endsWith("/chat/completions")');
  });

  it("Claude URL normalizer handles bare /v1 and /messages", () => {
    const la = fs.readFileSync(path.join(ROOT, "src/main/services/local-agent.ts"), "utf-8");
    expect(la).toContain("function normalizeClaudeUrl");
    expect(la).toContain('endsWith("/v1/messages")');
  });

  it("provider change updates placeholder hints", () => {
    const app = readRendererModules();
    expect(app).toContain('claude-sonnet-4-6');
    expect(app).toContain('gpt-4o');
    expect(app).toContain("https://api.anthropic.com/v1/messages");
  });
});

describe("Integration — Fingerprint UX", () => {
  it("profile card includes Identity row with timezone/locale/webrtc", () => {
    const app = readRendererModules();
    expect(app).toContain('"info-row"><span>Identity</span>');
    expect(app).toContain("identityStr");
    expect(app).toContain("fp.timezone");
    expect(app).toContain("fp.locale");
  });

  it("profile card has fingerprint completeness indicator and risk-check action", () => {
    const app = readRendererModules();
    expect(app).toContain("fingerprintCompleteness");
    expect(app).toContain('data-action="risk-check"');
    expect(app).toContain("openRiskCheck");
  });

  it("hardware summary shortens GPU renderer ANGLE strings", () => {
    const app = readRendererModules();
    expect(app).toContain("function shortenGpu");
    expect(app).toContain("ANGLE");
  });

  it("cloak:open-risk-check IPC replaces generic cloak:navigate", () => {
    const ipc = fs.readFileSync(path.join(ROOT, "src/main/ipc/cloak.ts"), "utf-8");
    const preload = fs.readFileSync(path.join(ROOT, "src/main/preload.cjs"), "utf-8");
    expect(ipc).toContain("cloak:open-risk-check");
    expect(ipc).not.toContain("cloak:navigate");
    expect(ipc).toContain("ping0.cc");
    expect(preload).toContain("openRiskCheck");
    expect(preload).not.toContain("cloak:navigate");
  });
});

describe("Integration — i18n dynamic coverage", () => {
  it("most common toast strings are i18n-wrapped", () => {
    const app = readRendererModules();
    const expectedKeys = [
      "toast.profile.started", "toast.profile.stopped", "toast.profile.created",
      "toast.sync.saved", "toast.cookie.saved", "toast.proxy.updated",
      "toast.skill.saved", "toast.llm.saved", "toast.account.deleted",
    ];
    for (const k of expectedKeys) {
      expect(app, `missing i18n call for ${k}`).toContain(`"${k}"`);
    }
  });

  it("toast i18n keys exist in both locales", () => {
    const i18n = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf-8");
    for (const k of [
      "toast.profile.started", "toast.profile.stopped",
      "toast.sync.saved", "toast.cookie.saved",
      "toast.skill.saved", "toast.llm.saved",
    ]) {
      expect(i18n, `missing key ${k}`).toContain(`"${k}"`);
    }
  });
});

describe("Integration — Agent streaming", () => {
  it("streaming IPC and events are wired", () => {
    const ipc = fs.readFileSync(path.join(ROOT, "src/main/ipc/agent.ts"), "utf-8");
    const preload = fs.readFileSync(path.join(ROOT, "src/main/preload.cjs"), "utf-8");
    expect(ipc).toContain("agent:chat-stream");
    expect(ipc).toContain("llmStreamChat");
    expect(ipc).toContain("getAllowedAgentTools");
    expect(preload).toContain("chatStream");
    expect(preload).toContain("agent:stream-chunk");
    expect(preload).toContain("agent:stream-done");
    expect(preload).toContain("agent:stream-error");
  });

  it("renderer subscibes to stream events on send", () => {
    const app = readRendererModules();
    expect(app).toContain("R.agent.chatStream(");
    expect(app).toContain("agent:stream-chunk");
    expect(app).toContain("agent:stream-tool-call");
    expect(app).toContain("agent:stream-error");
  });

  it("ipc handler persists assistant reply after stream completes", () => {
    const ipc = fs.readFileSync(path.join(ROOT, "src/main/ipc/agent.ts"), "utf-8");
    expect(ipc).toContain("addMessage(params.conversationId");
    expect(ipc).toContain('addMessage(params.conversationId, "assistant"');
  });
});

describe("Integration — First-run wizard", () => {
  it("wizard dialog and 3 steps exist in HTML", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    expect(html).toContain('id="dlg-wizard"');
    expect(html).toContain('data-step="1"');
    expect(html).toContain('data-step="2"');
    expect(html).toContain('data-step="3"');
    expect(html).toContain('data-cmd="wizardInstallBinary"');
    expect(html).toContain('data-cmd="wizardCreateProfile"');
    expect(html).toContain('data-cmd="wizardLaunchAndCheck"');
    expect(html).toContain('data-cmd="wizardSkip"');
    expect(html).toContain('data-cmd="wizardNeverShow"');
  });

  it("wizard logic is wired in renderer modules", () => {
    const app = readRendererModules();
    expect(app).toContain("function maybeShowWizard");
    expect(app).toContain("cloak.wizardInstallBinary");
    expect(app).toContain("cloak.wizardCreateProfile");
    expect(app).toContain("cloak.wizardLaunchAndCheck");
    expect(app).toContain("cloak.wizardSkip");
    expect(app).toContain("cloak.wizardNeverShow");
    expect(app).toContain("cloak-wizard-dismissed");
    expect(app).toContain("function advanceWizardStep");
  });

  it("wizard i18n keys exist in both locales", () => {
    const i18n = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf-8");
    for (const key of [
      "wizard.title", "wizard.step1.title", "wizard.step2.title", "wizard.step3.title",
      "wizard.skip", "wizard.never",
    ]) {
      expect(i18n, `missing ${key}`).toContain(`"${key}"`);
    }
  });
});

describe("Integration — i18n", () => {
  it("i18n.js exists with zh-CN and en-US dictionaries", () => {
    const i18n = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf-8");
    expect(i18n).toContain('"zh-CN"');
    expect(i18n).toContain('"en-US"');
    expect(i18n).toContain("window.i18n");
    expect(i18n).toContain("function applyDom");
    expect(i18n).toContain("nextLanguage");
  });

  it("zh-CN and en-US bundles cover the same keys", () => {
    const i18n = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf-8");
    const extractKeys = (lang: string): Set<string> => {
      const re = new RegExp(`"${lang}":\\s*\\{([\\s\\S]*?)^\\s*\\},`, "m");
      const m = i18n.match(re);
      if (!m) return new Set();
      const body = m[1];
      const keys = new Set<string>();
      for (const km of body.matchAll(/"([\w.\-]+)":\s*"/g)) keys.add(km[1]);
      return keys;
    };
    const zh = extractKeys("zh-CN");
    const en = extractKeys("en-US");
    expect(zh.size, "zh-CN should have entries").toBeGreaterThan(50);
    expect(en.size, "en-US should have entries").toBeGreaterThan(50);
    const missingInZh: string[] = [];
    const missingInEn: string[] = [];
    for (const k of en) if (!zh.has(k)) missingInZh.push(k);
    for (const k of zh) if (!en.has(k)) missingInEn.push(k);
    expect(missingInZh, "zh-CN missing keys").toEqual([]);
    expect(missingInEn, "en-US missing keys").toEqual([]);
  });

  it("main-process i18n exports tray-relevant keys", () => {
    const m18n = fs.readFileSync(path.join(ROOT, "src/main/services/main-i18n.ts"), "utf-8");
    expect(m18n).toContain("tray.show");
    expect(m18n).toContain("tray.running");
    expect(m18n).toContain("tray.quit");
    expect(m18n).toContain("export function setMainLanguage");
    expect(m18n).toContain("export function tMain");
  });

  it("i18n renderer pushes language to main process on change", () => {
    const i18n = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf-8");
    expect(i18n).toContain("app.setLanguage");
    expect(i18n).toContain("cloak-language-change");
  });

  it("toast.fp.opened key exists in both dictionaries", () => {
    const i18n = fs.readFileSync(path.join(ROOT, "src/renderer/js/i18n.js"), "utf-8");
    expect(i18n).toContain('"toast.fp.opened"');
    expect(i18n).toContain('"toast.fp.not-running"');
    expect(i18n).toContain('"toast.fp.nav-failed"');
  });

  it("tray-manager uses tMain() for localized labels", () => {
    const tray = fs.readFileSync(path.join(ROOT, "src/main/services/tray-manager.ts"), "utf-8");
    expect(tray).toContain('tMain("tray.show"');
    expect(tray).toContain('tMain("tray.running"');
    expect(tray).toContain('tMain("tray.quit"');
    expect(tray).not.toContain('label: "Show CloakLite"');
    expect(tray).not.toContain('label: "Quit CloakLite"');
  });
});

describe("Integration — Renderer hardening", () => {
  it("removes inline onclick/oninput/onsubmit/onkeydown/onchange handlers", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    const inlineMatches = html.match(/ on(click|input|submit|keydown|change)="/g) || [];
    expect(inlineMatches, "remaining inline handlers in index.html").toHaveLength(0);
  });

  it("CSP excludes 'unsafe-inline' for script-src", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    const cspMatch = html.match(/Content-Security-Policy"\s+content="([^"]+)"/);
    expect(cspMatch, "CSP meta missing").not.toBeNull();
    const csp = cspMatch![1];
    // script-src 'self' (without unsafe-inline)
    expect(csp).toMatch(/script-src 'self'(?:[^;]*)/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("BrowserWindow uses sandbox:true and contextIsolation:true", () => {
    const idx = fs.readFileSync(path.join(ROOT, "src/main/index.ts"), "utf-8");
    expect(idx).toContain("sandbox: true");
    expect(idx).toContain("contextIsolation: true");
    expect(idx).toContain("nodeIntegration: false");
    expect(idx).not.toContain("sandbox: false");
  });

  it("renderer event delegation is wired up", () => {
    const app = readRendererModules();
    expect(app).toContain("initEventDelegation");
    expect(app).toContain('data-role="cmd"');
    expect(app).toContain("addEventListener('click'");
  });
});

describe("Integration — Cross-platform paths", () => {
  it("config-manager uses app.getPath('userData') not hardcoded macOS paths", () => {
    const cfg = fs.readFileSync(path.join(ROOT, "src/main/services/config-manager.ts"), "utf-8");
    expect(cfg).not.toContain('"Library/Application Support/CloakLite"');
    expect(cfg).not.toContain('"Library", "Application Support", "CloakLite"');
    expect(cfg).toContain('app.getPath("userData")');
  });

  it("app index sets app name to CloakLite for consistent userData path", () => {
    const idx = fs.readFileSync(path.join(ROOT, "src/main/index.ts"), "utf-8");
    expect(idx).toContain('app.setName("CloakLite")');
  });
});

describe("Integration — MCP server", () => {
  it("mcp:status does not return the bearer token", () => {
    const ipc = fs.readFileSync(path.join(ROOT, "src/main/ipc/mcp.ts"), "utf-8");
    expect(ipc).not.toContain("authHeader");
    expect(ipc).not.toContain("`Bearer ${getMcpToken()}`");
  });

  it("mcp:reveal-token is exposed for explicit user-initiated retrieval", () => {
    const ipc = fs.readFileSync(path.join(ROOT, "src/main/ipc/mcp.ts"), "utf-8");
    const preload = fs.readFileSync(path.join(ROOT, "src/main/preload.cjs"), "utf-8");
    expect(ipc).toContain("mcp:reveal-token");
    expect(preload).toContain("mcp:reveal-token");
  });
});

describe("Integration — Sync & Config", () => {
  it("MgmtConfig type covers all fields", () => {
    const types = fs.readFileSync(path.join(ROOT, "src/main/types.ts"), "utf-8");
    expect(types).toContain("SyncConfig");
    expect(types).toContain("MgmtConfig");
    expect(types).toContain("cloakBin");
    expect(types).toContain("cloakProfiles");
  });

  it("sync payload has all file-type categories", () => {
    const sync = fs.readFileSync(path.join(ROOT, "src/main/services/sync-service.ts"), "utf-8");
    expect(sync).toContain("cookies");
    expect(sync).toContain("preferences");
    expect(sync).toContain("localStorage");
  });
});

describe("Integration — Agent ↔ LLM", () => {
  it("agent service exports required functions", () => {
    const la = fs.readFileSync(path.join(ROOT, "src/main/services/local-agent.ts"), "utf-8");
    const expected = ["agentChat", "llmChat", "getOrDetectLlmConfig", "createConversation", "getConversation", "listConversations", "getAccounts", "cdpConnect", "cdpNavigate", "buildAgentSystemPrompt"];
    for (const fn of expected) {
      const isAsync = ["agentChat", "llmChat", "cdpConnect", "cdpNavigate"].includes(fn);
      const pat = isAsync ? "export async function " + fn : "export function " + fn;
      expect(la, `missing export: ${fn}`).toContain(pat);
    }
  });

  it("skill repository functions are properly exported and used by agent runtime", () => {
    const repo = fs.readFileSync(path.join(ROOT, "src/main/services/skill-repository.ts"), "utf-8");
    const agent = fs.readFileSync(path.join(ROOT, "src/main/services/local-agent.ts"), "utf-8");
    for (const fn of [
      "listSkillRepository",
      "listMarketplaceSkills",
      "addOrUpdateSkill",
      "installSkill",
      "removeSkill",
      "setSkillMeta",
      "exportSharedSkillRepository",
      "importSharedSkillRepository",
      "getEnabledSkillPrompts",
    ]) {
      expect(repo, `missing skill export: ${fn}`).toContain("export function " + fn);
    }
    expect(agent).toContain("getEnabledSkillPrompts");
    expect(agent).toContain("Enabled user-managed skill recipes");
  });

  it("renderer uses main-process skill marketplace API instead of hardcoded marketplace state", () => {
    const renderer = readRendererModules();
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    expect(renderer).toContain("R.agent.skills.list()");
    expect(renderer).toContain("R.agent.skills.marketplace");
    expect(renderer).toContain("R.agent.skills.importShared");
    expect(renderer).not.toContain("var installedSkills = []");
    expect(renderer).not.toContain("var communitySkills = [");
    expect(html).toContain("dlg-skill-editor");
    expect(html).toContain("dlg-skill-import");
    expect(html).toContain("not Chrome extensions");
  });
});

describe("Integration — Hardware fingerprint controls", () => {
  const fields = [
    "gpuVendor",
    "gpuRenderer",
    "hardwareConcurrency",
    "deviceMemory",
    "screenWidth",
    "screenHeight",
    "storageQuota",
    "taskbarHeight",
    "fontsDir",
  ];

  it("profile types expose hardware fingerprint metadata", () => {
    const types = fs.readFileSync(path.join(ROOT, "src/main/types.ts"), "utf-8");
    const rendererTypes = fs.readFileSync(path.join(ROOT, "src/renderer/api.d.ts"), "utf-8");
    for (const field of fields) {
      expect(types, `main types missing ${field}`).toContain(field);
      expect(rendererTypes, `renderer types missing ${field}`).toContain(field);
    }
  });

  it("launch path passes explicit hardware flags to CloakBrowser", () => {
    const manager = fs.readFileSync(path.join(ROOT, "src/main/services/cloak-manager.ts"), "utf-8");
    for (const flag of [
      "--fingerprint-gpu-vendor",
      "--fingerprint-gpu-renderer",
      "--fingerprint-hardware-concurrency",
      "--fingerprint-device-memory",
      "--fingerprint-screen-width",
      "--fingerprint-screen-height",
      "--fingerprint-storage-quota",
      "--fingerprint-taskbar-height",
      "--fingerprint-fonts-dir",
    ]) {
      expect(manager, `missing launch flag ${flag}`).toContain(flag);
    }
    expect(manager).toContain("addHardwareFingerprintArgs(requestedArgs, meta)");
    expect(manager).toContain("--window-size=${nativeFingerprint.screen.outerWidth},${nativeFingerprint.screen.outerHeight}");
    expect(manager).toContain("--window-position=${nativeFingerprint.screen.windowX},${nativeFingerprint.screen.windowY}");
    expect(manager).toContain("--force-device-scale-factor=${nativeFingerprint.screen.devicePixelRatio}");
  });

  it("delegates binary, GeoIP, proxy, and launch handling to the community wrapper", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    const manager = fs.readFileSync(path.join(ROOT, "src/main/services/cloak-manager.ts"), "utf-8");
    expect(pkg.dependencies.cloakbrowser).toBe(
      "https://github.com/edgora-ai/CloakBrowser/archive/18180fad1600b4f3c57a0efa3c175961ac01fb8e.tar.gz",
    );
    expect(manager).toContain("buildLaunchOptions({");
    expect(manager).toContain("geoip: wrapperGeoip");
    expect(manager).toContain("shouldUseWrapperGeoip()");
    expect(manager).toContain("buildAuthenticatedProxyUrl(activeProxy)");
    expect(manager).toContain("env: launchEnv || process.env");
    expect(manager).not.toContain('"--test-type"');
    expect(manager).not.toContain('"--disable-blink-features=AutomationControlled"');
  });

  it("passes a versioned identity to the self-built Chromium 149+ renderer", () => {
    const manager = fs.readFileSync(path.join(ROOT, "src/main/services/cloak-manager.ts"), "utf-8");
    const config = fs.readFileSync(path.join(ROOT, "src/main/services/roxy-fingerprint-config.ts"), "utf-8");
    expect(manager).toContain("buildRoxyFingerprintArg(nativeFingerprintMeta, nativeChromiumVersion)");
    expect(manager).toContain("detectBinaryVersion(bin)");
    expect(manager).not.toContain("--time-zone-for-testing=");
    expect(manager).toContain("findManagedRoxyBinary()");
    expect(config).toContain('ROXY_FINGERPRINT_SWITCH = "--roxy-fingerprint-config="');
    expect(config).toContain("schemaVersion: 1");
    const verifier = fs.readFileSync(path.join(ROOT, "src/tools/verify-native-chromium.ts"), "utf-8");
    expect(verifier).toContain("sameSeedStable");
    expect(verifier).toContain("differentSeedsDistinct");
    expect(verifier).toContain("captureDisabledWebRtc");
    expect(verifier).toContain("audioTrackDeviceId");
    expect(verifier).toContain("captureCodecs");
    expect(verifier).toContain("WebCodecs AAC encoder");
    expect(verifier).toContain("captureCdpOverrideIdentity");
    expect(verifier).toContain("crossOriginFrame");
    expect(verifier).toContain("captureVersionIdentity");
    expect(verifier).toContain("chrome://version/");
    expect(verifier).toContain("verifyHeadedHeadlessParity");
    expect(verifier).toContain("captureStockWindowMode");
    expect(verifier).toContain("persistentProfileRestart");
    const networkVerifier = fs.readFileSync(path.join(ROOT, "src/tools/verify-network-fingerprint.ts"), "utf-8");
    expect(networkVerifier).toContain("tls.peet.ws/api/all");
    expect(networkVerifier).toContain("quic.tlsfingerprint.io/api/client-fingerprint-quic");
    expect(networkVerifier).toContain("diffNetworkFingerprint");
    const installer = fs.readFileSync(path.join(ROOT, "src/tools/install-native-chromium.ts"), "utf-8");
    expect(installer).toContain("bundleBuildHash");
    expect(installer).toContain("Chromium Framework");
    expect(installer).toContain("previousPath");
    const builder = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf-8");
    expect(builder).toContain("dist/tools/webgl-corpus.js");
    expect(builder).toContain("dist/tools/webgpu-corpus.js");
    expect(builder).toContain("dist/tools/font-corpus.js");
  });

  it("exposes all WebRTC policy modes from UI through the native config", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    const renderer = readRendererModules();
    const config = fs.readFileSync(path.join(ROOT, "src/main/services/roxy-fingerprint-config.ts"), "utf-8");
    expect(html).toContain('id="new-cloak-webrtc-mode"');
    expect(html).toContain('id="cloak-meta-webrtc-mode"');
    for (const mode of ["auto", "real", "altered", "disable"]) {
      expect(html).toContain(`value="${mode}"`);
    }
    expect(renderer).toContain("webrtcMode: webrtcMode");
    expect(config).toContain("normalizeWebRtc(meta.webrtcMode, meta.webrtcIp)");
  });

  it("moves high-risk fingerprint readbacks into native Chromium patches", () => {
    const patchRoot = path.join(ROOT, "patches/chromium");
    for (const name of [
      "0004-native-canvas-readback-noise.patch",
      "0005-native-webgl-identity.patch",
      "0006-native-audio-buffer-noise.patch",
      "0007-native-storage-quota.patch",
      "0008-native-analyser-noise.patch",
      "0009-native-offscreen-canvas-noise.patch",
      "0010-native-client-rects-noise.patch",
      "0011-native-webrtc-visible-identity.patch",
      "0012-native-webrtc-routing-policy.patch",
      "0013-native-font-allowlist.patch",
      "0014-native-geolocation-policy.patch",
      "0015-native-media-plugin-identity.patch",
      "0016-native-float-canvas-noise.patch",
      "0017-native-custom-font-directory.patch",
      "0018-forward-profile-config-to-renderer.patch",
      "0019-native-media-device-remapping.patch",
      "0020-native-webgpu-identity.patch",
      "0021-native-do-not-track.patch",
      "0022-native-speech-voice-identity.patch",
      "0023-native-touch-identity.patch",
      "0024-idempotent-canvas-noise.patch",
      "0025-native-timezone-identity.patch",
      "0026-native-accept-language.patch",
      "0027-native-storage-buckets-quota.patch",
      "0028-native-webauthn-capabilities.patch",
      "0029-native-cdp-identity-coherence.patch",
      "0030-native-window-geometry-coherence.patch",
      "0031-native-webgpu-adapter-coherence.patch",
      "0032-native-cdp-input-routing.patch",
      "0033-native-system-theme-coherence.patch",
      "0034-native-cdp-wheel-routing.patch",
      "0035-native-cdp-occluded-input-completion.patch",
      "0036-native-cdp-scroll-delta-deduplication.patch",
      "0037-native-cdp-scroll-offset-reconciliation.patch",
      "0038-native-managed-proxy-auth.patch",
      "0039-native-legacy-storage-quota.patch",
      "0040-native-managed-font-resolution.patch",
    ]) {
      expect(fs.existsSync(path.join(patchRoot, "patches", name))).toBe(true);
    }
    expect(fs.existsSync(path.join(patchRoot, "patches", "0001-wire-roxy-fingerprint-agent.patch"))).toBe(false);
    expect(fs.existsSync(path.join(patchRoot, "files", "chrome", "renderer", "roxy_fingerprint", "roxy_fingerprint_agent.cc"))).toBe(false);
    expect(fs.readFileSync(path.join(patchRoot, "README.md"), "utf-8")).toContain("no page-script injection");
    const canvasPatch = fs.readFileSync(path.join(patchRoot, "patches", "0024-idempotent-canvas-noise.patch"), "utf-8");
    expect(canvasPatch).toContain("0xfffffffeU");
    expect(canvasPatch).toContain("0xfffeU");
    expect(canvasPatch).not.toMatch(/^\+.*nextafter/m);
    const inputPatch = fs.readFileSync(path.join(patchRoot, "patches", "0032-native-cdp-input-routing.patch"), "utf-8");
    expect(inputPatch).toContain("GetRenderWidgetHostViewInputAtPoint");
    expect(inputPatch).toContain("RoxyFingerprintConfig::Get().enabled()");
    const buildArgs = fs.readFileSync(path.join(patchRoot, "args.gn"), "utf-8");
    expect(buildArgs).toContain("proprietary_codecs = true");
    expect(buildArgs).toContain('ffmpeg_branding = "Chrome"');
  });

  it("renderer create/edit dialogs include hardware controls", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    const renderer = readRendererModules();
    for (const id of [
      "gpu-vendor",
      "gpu-renderer",
      "hardware-concurrency",
      "device-memory",
      "screen-width",
      "screen-height",
      "storage-quota",
      "taskbar-height",
      "fonts-dir",
      "geolocation-mode",
      "geolocation-latitude",
      "geolocation-longitude",
      "geolocation-accuracy",
    ]) {
      expect(html, `create dialog missing ${id}`).toContain(`new-cloak-${id}`);
      expect(html, `edit dialog missing ${id}`).toContain(`cloak-meta-${id}`);
    }
    expect(renderer).toContain("readHardwareFields");
    expect(renderer).toContain("writeHardwareFields");
  });

  it("offers coherent Greek locale and timezone pairs in create/edit dialogs", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    for (const value of ["el-GR", "el-CY", "Europe/Athens", "Asia/Nicosia"]) {
      expect(html.match(new RegExp(`value="${value}"`, "g"))?.length).toBe(2);
    }
  });
});

describe("Integration — Seeded native interaction policy", () => {
  it("routes pointer, wheel, keyboard and typing through bounded native CDP input", () => {
    const agent = fs.readFileSync(path.join(ROOT, "src/main/services/local-agent.ts"), "utf-8");
    expect(agent).toContain("buildHumanizedPointerPath");
    expect(agent).toContain("jitterInteractionTarget");
    expect(agent).toContain("buildHumanizedScrollDeltas");
    expect(agent).toContain('type: "mouseWheel"');
    expect(agent).toContain('commands: ["SelectAll"]');
    expect(agent).toContain("if (!nativeSent)");
    expect(agent).not.toContain("window.scrollBy({top:");
  });
});

describe("Integration — Sync restore hardening", () => {
  it("guards running profile restore and validates artifacts", () => {
    const sync = fs.readFileSync(path.join(ROOT, "src/main/services/sync-service.ts"), "utf-8");
    expect(sync).toContain("isProfileRunningForRestore(dirId)");
    expect(sync).toContain("statusCloak(dirId).running");
    expect(sync).toContain("skipped localStorage for running profile");
    expect(sync).toContain("skipped preferences for running profile");
    expect(sync).toContain("validatePreferencesJson(rawPrefs)");
    expect(sync).toContain("writeFileAtomic(prefPath, rawPrefs)");
    expect(sync).toContain("extractSafeLocalStorageArchive");
    expect(sync).toContain("LocalStorage archive contains non-regular entries");
  });

  it("uses a single Cloak-branded sync key (no legacy fallback)", () => {
    const sync = fs.readFileSync(path.join(ROOT, "src/main/services/sync-service.ts"), "utf-8");
    expect(sync).toContain('const SYNC_CONFIG_KEY = "cloak-lite-config.json"');
    expect(sync).not.toContain("LEGACY_SYNC_CONFIG_KEY");
  });
});
