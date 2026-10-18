// Integration tests — cross-module consistency
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { buildBrowserFingerprintConfig, encodeBrowserFingerprintConfig, validateBrowserHardwareProfile } from "../../src/main/services/browser-fingerprint-config.js";

// Observe actual production registration, including permission wrappers and
// compatibility aliases. No handler source is copied or evaluated as a script.
const ipc = vi.hoisted(() => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || require("node:os").tmpdir(), "ipc-smoke-"));
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const owners = new Map<string, string>();
  const state = { module: "" };
  const forbidden = vi.fn((...args: unknown[]) => { throw new Error(`Undeclared smoke capability: ${String(args[0])}`); });
  const handle = (channel: string, handler: (...args: any[]) => unknown) => {
    if (typeof channel !== "string" || typeof handler !== "function") throw new Error("Invalid IPC registration");
    if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel} (${owners.get(channel)}, ${state.module})`);
    handlers.set(channel, handler);
    owners.set(channel, state.module);
  };
  return { root, handlers, owners, state, handle, forbidden, modules: new Map<string, string>() };
});
vi.mock("electron", () => ({
  ipcMain: { handle: ipc.handle },
  app: { getPath: (name: string) => {
    if (["userData", "home", "appData", "downloads", "documents", "desktop", "temp"].includes(name)) return ipc.root;
    throw new Error(`Undeclared Electron path: ${name}`);
  }, getAppPath: () => process.cwd(), getName: () => "IPC smoke fixture", getVersion: () => "1.0.1", isPackaged: false, quit: ipc.forbidden },
  BrowserWindow: { getAllWindows: ipc.forbidden, getFocusedWindow: ipc.forbidden, fromWebContents: ipc.forbidden },
  clipboard: { writeText: ipc.forbidden }, screen: { getPrimaryDisplay: ipc.forbidden },
  dialog: { showOpenDialog: ipc.forbidden, showSaveDialog: ipc.forbidden, showMessageBox: ipc.forbidden },
  shell: { openPath: ipc.forbidden, openExternal: ipc.forbidden },
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), exec: ipc.forbidden, execFile: ipc.forbidden,
  execSync: ipc.forbidden, execFileSync: ipc.forbidden, spawn: ipc.forbidden, spawnSync: ipc.forbidden,
}));
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  const external = { request: ipc.forbidden, get: ipc.forbidden, createServer: ipc.forbidden };
  return { ...actual, ...external, default: { ...actual, ...external } };
});
vi.mock("node:https", async (original) => {
  const actual = await original<typeof import("node:https")>();
  const external = { request: ipc.forbidden, get: ipc.forbidden, createServer: ipc.forbidden };
  return { ...actual, ...external, default: { ...actual, ...external } };
});
vi.mock("ws", () => ({ default: ipc.forbidden, WebSocket: ipc.forbidden, WebSocketServer: ipc.forbidden }));

const ROOT = path.resolve(__dirname, "../..");
const RENDERER_MODULE_DIR = path.join(ROOT, "src/renderer/js/app");
const readRendererModule = (name: string): string => fs.readFileSync(path.join(RENDERER_MODULE_DIR, name), "utf-8");
const readRendererModules = (): string => fs.readdirSync(RENDERER_MODULE_DIR)
  .filter((file) => file.endsWith(".js"))
  .map((file) => readRendererModule(file))
  .join("\n");

function syntax(source: string, kind = ts.ScriptKind.TS) {
  return ts.createSourceFile("integration-contract.ts", source, ts.ScriptTarget.Latest, true, kind);
}
function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const matches: T[] = [];
  function visit(node: ts.Node) { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); }
  visit(root);
  return matches;
}
function calls(root: ts.Node, name: string) {
  return nodes(root, ts.isCallExpression).filter(node => ts.isIdentifier(node.expression) && node.expression.text === name);
}
function stringProperty(node: ts.ObjectLiteralExpression, key: string): string | undefined {
  const properties = node.properties.filter(ts.isPropertyAssignment).filter(property =>
    (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && property.name.text === key);
  if (properties.length !== 1 || !ts.isStringLiteralLike(properties[0].initializer)) return undefined;
  return properties[0].initializer.text;
}
function translationKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const call of nodes(syntax(source, ts.ScriptKind.JS), ts.isCallExpression)) {
    const translator = (ts.isIdentifier(call.expression) && call.expression.text === "t") ||
      (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "t");
    if (translator && call.arguments[0] && ts.isStringLiteralLike(call.arguments[0])) keys.add(call.arguments[0].text);
  }
  return keys;
}

beforeAll(async () => {
  vi.stubGlobal("fetch", ipc.forbidden);
  const ipcDir = path.join(ROOT, "src/main/ipc");
  for (const file of fs.readdirSync(ipcDir).filter((name) => name.endsWith(".ts")).sort()) {
    const module = await import(path.join(ipcDir, file));
    const registrations = Object.entries(module).filter(([name, value]) => /^register\w+Handlers$/.test(name) && typeof value === "function");
    expect(registrations, `${file} must expose one actual IPC registrar`).toHaveLength(1);
    const [name, register] = registrations[0];
    ipc.modules.set(file, name);
    ipc.state.module = file;
    (register as () => void)();
  }
});
afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(ipc.root, { recursive: true, force: true });
});
function registeredIpcChannels(): string[] {
  return [...ipc.handlers.keys()];
}

describe("Integration — IPC System", () => {
  it("all expected IPC channels are registered", () => {
    const channels = registeredIpcChannels();
    expect(channels.length).toBeGreaterThan(20);
    const expected = [
      "profile:list",
      "browser:launch",
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
      "settings:update-repository-extension",
      "settings:delete-repository-extension",
      "settings:set-repository-extension-meta",
      "settings:install-extension",
      "settings:install-local-extension",
      "settings:toggle-extension",
      "settings:delete-extension",
      "settings:set-profile-extensions",
      "settings:agent-fs-set",
      "browser:health-history",
      "browser:health-cancel",
      "browser:capture-baseline",
      "cloak:launch",
      "webrtc:diag",
      "detect:webrtc-leak",
    ];
    for (const ch of expected) expect(channels, `missing ${ch}`).toContain(ch);
  });

  it("no duplicate IPC channel names", () => {
    // The capture rejects duplicates during the real registration itself,
    // including dynamically constructed channels; prove that guard is active.
    const existing = registeredIpcChannels()[0];
    expect(existing).toBeDefined();
    expect(() => ipc.handle(existing, () => undefined)).toThrow(`Duplicate IPC channel: ${existing}`);
    expect(ipc.owners.size).toBe(ipc.handlers.size);
    for (const file of ipc.modules.keys()) expect([...ipc.owners.values()], `${file} registered no handlers`).toContain(file);
  });

  it("every browser compatibility alias shares the same production handler", () => {
    const browserChannels = registeredIpcChannels().filter(channel => channel.startsWith("browser:"));
    expect(browserChannels.length).toBeGreaterThan(20);
    for (const channel of browserChannels) expect(ipc.handlers.get(channel.replace(/^browser:/, "cloak:")), channel).toBe(ipc.handlers.get(channel));
    expect(ipc.forbidden).not.toHaveBeenCalled();
  });

  it("preload invocations map to existing IPC channels", () => {
    const ipcChannels = new Set(registeredIpcChannels());
    const preload = fs.readFileSync(path.join(ROOT, "src/main/preload.cjs"), "utf-8");
    const tree = syntax(preload, ts.ScriptKind.JS);
    const invocations = nodes(tree, ts.isCallExpression).filter(call =>
      ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.text === "ipcRenderer" && call.expression.name.text === "invoke" ||
      ts.isIdentifier(call.expression) && call.expression.text === "invokeAccount");
    const literalChannels = invocations.flatMap(call => call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) ? [call.arguments[0].text] : []);
    expect(literalChannels.length).toBeGreaterThan(100);
    for (const channel of literalChannels) expect(ipcChannels.has(channel), `preload invokes non-existent: ${channel}`).toBe(true);
  });

  it("all IPC modules are registered in index.ts", () => {
    const idx = fs.readFileSync(path.join(ROOT, "src/main/index.ts"), "utf-8");
    const tree = syntax(idx);
    for (const [file, name] of ipc.modules) expect(calls(tree, name), `${file} must be invoked by startup`).toHaveLength(1);
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
    expect(mcp).toContain("agent_browser_list_extensions");
    expect(mcp).toContain("agent_browser_install_extension");
    expect(mcp).toContain("agent_browser_delete_extension");
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
    expect(yml).toContain("afterPack: scripts/after-pack.mjs");
    const afterPack = fs.readFileSync(path.join(ROOT, "scripts/after-pack.mjs"), "utf-8");
    expect(afterPack).toContain("--timestamp=none");
    expect(afterPack).toContain('"--verify"');
    expect(afterPack).toContain("com.ahoo.agent-browser-studio");
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
  it("before-quit awaits chats and real browser exit before completing cleanup", () => {
    const idx = fs.readFileSync(path.join(ROOT, "src/main/index.ts"), "utf-8");
    const shutdown = idx.slice(idx.indexOf('app.on("before-quit"'));
    expect(shutdown).toContain("await desktopChatRuns.shutdown()");
    expect(shutdown).toContain("await shutdownAllBrowserProfiles()");
    expect(shutdown).toContain("report.unfinished.length");
    expect(shutdown).toContain("stopMcpServer()");
    expect(shutdown.indexOf("await shutdownAllBrowserProfiles()")).toBeGreaterThan(shutdown.indexOf("await desktopChatRuns.shutdown()"));
    expect(shutdown.indexOf("quitCleanupFinished = true")).toBeGreaterThan(shutdown.indexOf("await shutdownAllBrowserProfiles()"));
  });

  it("browser-manager keeps stopAllBrowserProfiles and exports awaited shutdown", () => {
    const cm = fs.readFileSync(path.join(ROOT, "src/main/services/browser-manager.ts"), "utf-8");
    expect(cm).toContain("export const stopAllBrowserProfiles");
    expect(cm).toContain("export const shutdownAllBrowserProfiles");
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
    expect(app).toContain("identityStr");
    expect(app).toContain("fp.timezone");
    expect(app).toContain("fp.locale");
    // UE-02: row labels come from the i18n table, not hard-coded literals.
    expect(app).toContain("profile.row.identity");
  });

  it("profile card has fingerprint completeness indicator and a single health-check control", () => {
    const app = readRendererModules();
    expect(app).toContain("fingerprintCompleteness");
    // UE-01: the four 9px check buttons collapsed into one <select>.
    expect(app).toContain('data-action="health"');
    expect(app).toContain("openRiskCheck");
    // TE-04: the third-party check is opt-in behind a consent gate.
    expect(app).toContain("EXTERNAL_CONSENT_KEY");
  });

  it("hardware summary shortens GPU renderer ANGLE strings", () => {
    const app = readRendererModules();
    expect(app).toContain("function shortenGpu");
    expect(app).toContain("ANGLE");
  });

  it("browser:open-risk-check IPC replaces generic browser:navigate", () => {
    const ipc = fs.readFileSync(path.join(ROOT, "src/main/ipc/browser.ts"), "utf-8");
    const preload = fs.readFileSync(path.join(ROOT, "src/main/preload.cjs"), "utf-8");
    expect(ipc).toContain('handleBrowser("open-risk-check"');
    expect(ipc).not.toContain("browser:navigate");
    expect(ipc).toContain("ping0.cc");
    expect(preload).toContain("openRiskCheck");
    expect(preload).not.toContain("browser:navigate");
  });
});

describe("Integration — i18n dynamic coverage", () => {
  it("recognizes translator calls independently of quote style without counting comments or unused strings", () => {
    const keys = translationKeys('// t("toast.decoy.comment")\nconst unused = "toast.decoy.string"; t(\'toast.single\'); window.i18n.t("toast.double"); t(`toast.template`);');
    expect([...keys].sort()).toEqual(["toast.double", "toast.single", "toast.template"]);
  });

  it("most common toast strings are i18n-wrapped", () => {
    const keys = translationKeys(readRendererModules());
    const expectedKeys = [
      "toast.profile.started", "toast.profile.stopped", "toast.profile.created",
      "toast.sync.saved", "toast.cookie.saved", "toast.proxy.updated",
      "toast.skill.saved", "toast.llm.saved", "toast.account.deleted",
    ];
    for (const k of expectedKeys) {
      expect(keys.has(k), `missing translator call for ${k}`).toBe(true);
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
    const chat = fs.readFileSync(path.join(ROOT, "src/main/services/agent/desktop-chat.ts"), "utf-8");
    expect(ipc).toContain("agent:chat-stream");
    expect(ipc).toContain("runDesktopChat(event.sender, params, true)");
    expect(ipc).toContain("runDesktopChat(event.sender, params, false)");
    expect(ipc).toContain("agent:chat-cancel");
    expect(ipc).toContain("agent:chat-active");
    expect(chat).toContain("llmStreamChat");
    expect(chat).toContain("filterChatTools(getAllowedAgentTools(), scope)");
    expect(preload).toContain("agent:stream-start");
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

  it("the shared desktop chat service persists linked user and assistant messages", () => {
    const chat = fs.readFileSync(path.join(ROOT, "src/main/services/agent/desktop-chat.ts"), "utf-8");
    expect(chat).toContain('addMessage(context.conversationId, "user"');
    expect(chat).toContain('addMessage(context.conversationId, "assistant"');
    expect(chat).toContain("requestId: context.streamId");
    expect(chat).toContain("agentRunRecorder.finishRun");
  });
});

describe("Integration — First-run wizard", () => {
  it("wizard dialog and 3 steps exist in HTML", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    expect(html).toContain('id="dlg-wizard"');
    expect(html).toContain('data-step="1"');
    expect(html).toContain('data-step="2"');
    expect(html).toContain('data-step="3"');
    expect(html).toContain('data-cmd="wizardVerifyBinary"');
    expect(html).toContain('data-cmd="wizardCreateProfile"');
    expect(html).toContain('data-cmd="wizardLaunchAndCheck"');
    expect(html).toContain('data-cmd="wizardSkip"');
    expect(html).toContain('data-cmd="wizardNeverShow"');
  });

  it("wizard logic is wired in renderer modules", () => {
    const app = readRendererModules();
    expect(app).toContain("function maybeShowWizard");
    expect(app).toContain("agentBrowser.wizardVerifyBinary");
    expect(app).toContain("agentBrowser.wizardCreateProfile");
    expect(app).toContain("agentBrowser.wizardLaunchAndCheck");
    expect(app).toContain("agentBrowser.wizardSkip");
    expect(app).toContain("agentBrowser.wizardNeverShow");
    expect(app).toContain("agent-browser-studio-wizard-dismissed");
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
    expect(i18n).toContain("agent-browser-language-change");
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
    expect(tray).not.toContain('label: "Show Agent Browser Studio"');
    expect(tray).not.toContain('label: "Quit Agent Browser Studio"');
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
    expect(cfg).not.toContain('"Library/Application Support/Agent Browser Studio"');
    expect(cfg).not.toContain('"Library", "Application Support", "Agent Browser Studio"');
    expect(cfg).toContain('app.getPath("userData")');
  });

  it("app index sets app name to Agent Browser Studio for consistent userData path", () => {
    const branding = fs.readFileSync(path.join(ROOT, "src/main/branding.ts"), "utf-8");
    expect(branding).toContain('PRODUCT_NAME = "Agent Browser Studio"');
    expect(branding).toContain("electronApp.setName(PRODUCT_NAME)");
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
    expect(types).toContain("chromiumBin");
    expect(types).toContain("browserProfiles");
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
      const pats = isAsync ? ["export async function " + fn, "export const " + fn] : ["export function " + fn, "export const " + fn]; const ok = pats.some(pat => la.includes(pat)); if(!ok) expect(la, 'missing export: '+fn+' (tried '+pats.join('|')+')').toContain(pats[0]); else expect(true).toBe(true); continue;
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

  it("launch path preserves non-GPU flags and validates engine-specific Chromium GPU support", () => {
    const manager = fs.readFileSync(path.join(ROOT, "src/main/services/browser-manager.ts"), "utf-8");
    const emitters = [...manager.matchAll(/^function addHardwareFingerprintArgs\([\s\S]*?^\}/gm)];
    expect(emitters, "unique Chromium hardware argument emitter").toHaveLength(1);
    const chromiumHardwareArgs = emitters[0][0];
    for (const flag of [
      "--fingerprint-hardware-concurrency",
      "--fingerprint-device-memory",
      "--fingerprint-screen-width",
      "--fingerprint-screen-height",
      "--fingerprint-storage-quota",
      "--fingerprint-taskbar-height",
      "--fingerprint-fonts-dir",
    ]) {
      expect(chromiumHardwareArgs.includes(flag), `missing Chromium launch flag ${flag}`).toBe(true);
    }
    for (const flag of ["--fingerprint-gpu-vendor", "--fingerprint-gpu-renderer"]) {
      expect(chromiumHardwareArgs.includes(flag), `native Chromium GPU policy must not emit ${flag}`).toBe(false);
    }
    const validation = 'if (!passThrough) validateBrowserHardwareProfile(meta, "chromium")';
    const hardwareArgs = "addHardwareFingerprintArgs(requestedArgs, meta)";
    expect(manager.includes(validation), "Chromium GPU overrides must be rejected before launch").toBe(true);
    expect(manager.indexOf(validation)).toBeLessThan(manager.indexOf(hardwareArgs));
    // The current policy allows validated Mac/arm64 model tuples; it does not
    // reject every Chromium override. Exercise the pure policy without a browser.
    const meta = { platform: "macos" as const, fingerprintSeed: 12345 };
    const context = { hostPlatform: "darwin", hostArchitecture: "arm64", kernelArchitecture: "arm64" };
    const chromium = buildBrowserFingerprintConfig(meta, "149.0.7827.22", null, "chromium", context);
    expect(chromium.webgl.vendor.length).toBeGreaterThan(0);
    expect(chromium.webgl.renderer.length).toBeGreaterThan(0);
    const overrides = { ...meta, gpuVendor: chromium.webgl.vendor, gpuRenderer: chromium.webgl.renderer };
    expect(() => validateBrowserHardwareProfile(overrides, "chromium", context)).not.toThrow();
    expect(() => validateBrowserHardwareProfile(overrides, "chromium", { ...context, hostPlatform: "linux" })).toThrow("Unsupported GPU overrides for Chromium");
    // Firefox accepts legacy catalog inputs, not its coarsened observable
    // WebGL privacy bucket (which is deliberately not a catalog tuple).
    const firefoxOverrides = { ...meta, gpuVendor: "Google Inc. (Apple)", gpuRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)" };
    expect(() => validateBrowserHardwareProfile(firefoxOverrides, "firefox", { ...context, hostPlatform: "linux" })).not.toThrow();
    expect(manager).toContain(hardwareArgs);
    expect(manager).toContain("--window-size=${nativeFingerprint.screen.outerWidth},${nativeFingerprint.screen.outerHeight}");
    expect(manager).toContain("--window-position=${nativeFingerprint.screen.windowX},${nativeFingerprint.screen.windowY}");
    // Raster scale goes through resolveRenderScaleFactor: `native` renders at
    // the host's real scale (sharp on HiDPI), `strict` pins the spoofed DPR.
    expect(manager).toContain("resolveRenderScaleFactor(");
    expect(manager).toContain("--force-device-scale-factor=${renderScaleFactor}");
  });

  it("has no upstream wrapper dependency or fallback launch path", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf-8"));
    const manager = fs.readFileSync(path.join(ROOT, "src/main/services/browser-manager.ts"), "utf-8");
    expect(pkg.dependencies.cloakbrowser).toBeUndefined();
    expect(lock.packages["node_modules/cloakbrowser"]).toBeUndefined();
    expect(manager).not.toContain('from "cloakbrowser"');
    expect(manager).not.toContain("buildLaunchOptions({");
    expect(manager).not.toContain("wrapperGeoip");
    expect(manager).not.toContain("CloakHQ/cloakbrowser");
    expect(manager).not.toContain("CLOAKBROWSER_LICENSE_KEY");
    expect(manager).toContain("upstream wrapper fallback is disabled");
    expect(manager).toContain("AGENT_BROWSER_CHROMIUM_BINARY_PATH");
    expect(manager).toContain("env: launchEnv || process.env");
    expect(manager).not.toContain('"--test-type"');
    expect(manager).not.toContain('"--disable-blink-features=AutomationControlled"');
  });

  it("passes a versioned identity to the self-built Chromium 149+ renderer", () => {
    const manager = fs.readFileSync(path.join(ROOT, "src/main/services/browser-manager.ts"), "utf-8");
    const config = fs.readFileSync(path.join(ROOT, "src/main/services/browser-fingerprint-config.ts"), "utf-8");
    const managerTree = syntax(manager);
    const identities = nodes(managerTree, ts.isVariableDeclaration).filter(node =>
      ts.isIdentifier(node.name) && node.name.text === "nativeFingerprint" && node.initializer &&
      ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "buildBrowserFingerprintConfig");
    expect(identities, "one actual native identity construction, not a comment or obsolete wrapper name").toHaveLength(1);
    const identity = identities[0].initializer as ts.CallExpression;
    expect(identity.arguments.map(argument => ts.isStringLiteralLike(argument) ? argument.text : argument.getText(managerTree)))
      .toEqual(["nativeFingerprintMeta", "nativeChromiumVersion", "managedSecureDns", "chromium", "gpuContext"]);
    const switches = nodes(managerTree, ts.isVariableDeclaration).filter(node => ts.isIdentifier(node.name) && node.name.text === "fingerprintSwitch");
    expect(switches).toHaveLength(1);
    const selection = switches[0].initializer!;
    expect(ts.isConditionalExpression(selection)).toBe(true);
    if (!ts.isConditionalExpression(selection)) throw new Error("Missing native switch capability selection");
    expect(selection.condition.getText(managerTree)).toBe("supportsAgentBrowserFingerprintConfig(bin)");
    expect(selection.whenTrue.getText(managerTree)).toBe("AGENT_BROWSER_FINGERPRINT_SWITCH");
    expect(selection.whenFalse.getText(managerTree)).toBe("LEGACY_FINGERPRINT_SWITCH");
    const publications = nodes(managerTree, ts.isCallExpression).filter(call =>
      ts.isPropertyAccessExpression(call.expression) && call.expression.expression.getText(managerTree) === "args" && call.expression.name.text === "push" &&
      call.arguments.length === 1 && ts.isBinaryExpression(call.arguments[0]) && call.arguments[0].operatorToken.kind === ts.SyntaxKind.PlusToken &&
      call.arguments[0].left.getText(managerTree) === "fingerprintSwitch" && calls(call.arguments[0].right, "encodeBrowserFingerprintConfig")
        .some(encode => encode.arguments.length === 1 && encode.arguments[0].getText(managerTree) === "nativeFingerprint"));
    expect(publications, "the constructed identity must reach the selected native switch").toHaveLength(1);
    const payload = buildBrowserFingerprintConfig({ platform: "macos", fingerprintSeed: 12345 }, "149.0.7827.22");
    expect(JSON.parse(Buffer.from(encodeBrowserFingerprintConfig(payload), "base64url").toString("utf8"))).toEqual(payload);
    expect(payload.schemaVersion).toBe(1);
    expect(manager).toContain("managedSecureDns");
    expect(manager).toContain("detectBinaryVersion(bin)");
    expect(manager).not.toContain("--time-zone-for-testing=");
    expect(manager).toContain("const requestedVersion = normalizeManagedChromiumVersion(meta.browserVersion)");
    expect(manager).toContain("await findManagedChromiumBinaryAsync(requestedVersion)");
    expect(manager).toContain("if (requestedVersion && !overrideBin && !managedBin)");
    expect(manager).toContain("Chromium ${requestedVersion} is not installed");
    expect(manager).toContain("if (version !== requestedVersion) throw new Error(");
    const resolver = fs.readFileSync(path.join(ROOT, "src/main/services/native-chromium-manager.ts"), "utf-8");
    const asyncResolver = resolver.slice(resolver.indexOf("export async function findManagedChromiumBinaryAsync("), resolver.indexOf("\nfunction detectBinaryVersion("));
    expect(asyncResolver).toContain("normalizeManagedChromiumVersion(requestedVersion)");
    expect(asyncResolver).toContain("await listManagedChromiumBinariesAsync(root, platform)");
    expect(asyncResolver).toMatch(/return version\s*\? candidates\.find\(candidate => candidate\.version === version\) \|\| null : candidates\[0\] \|\| null/);
    expect(config).toContain('AGENT_BROWSER_FINGERPRINT_SWITCH = "--agent-browser-fingerprint-config="');
    expect(config).toContain('LEGACY_FINGERPRINT_SWITCH = "--roxy-fingerprint-config="');
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
    expect(installer).toContain("signAndVerifyMacBundle");
    const builder = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf-8");
    expect(builder).toContain("dist/tools/webgl-corpus.js");
    expect(builder).toContain("dist/tools/webgpu-corpus.js");
    expect(builder).toContain("dist/tools/font-corpus.js");
    expect(builder).toContain("dist/native");
  });

  it("exposes all WebRTC policy modes from UI through the native config", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8");
    const renderer = readRendererModules();
    const config = fs.readFileSync(path.join(ROOT, "src/main/services/browser-fingerprint-config.ts"), "utf-8");
    expect(html).toContain('id="new-agent-browser-webrtc-mode"');
    expect(html).toContain('id="agent-browser-meta-webrtc-mode"');
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
      "0041-native-managed-quic-proxy.patch",
      "0042-agent-browser-public-runtime-protocol.patch",
      "0043-agent-browser-google-api-key-infobar.patch",
      "0044-agent-browser-managed-dns-locale-refresh.patch",
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
      expect(html, `create dialog missing ${id}`).toContain(`new-agent-browser-${id}`);
      expect(html, `edit dialog missing ${id}`).toContain(`agent-browser-meta-${id}`);
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
    expect(sync).toContain("statusBrowser(dirId).running");
    const tree = syntax(sync);
    const pulls = nodes(tree, ts.isMethodDeclaration).filter(node =>
      (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) && node.name.text === "pull");
    expect(pulls, "inspect the real Pull method, not Push or diagnostic text").toHaveLength(1);
    const pull = pulls[0];
    const runningChecks = nodes(pull, ts.isVariableDeclaration).filter(node => ts.isIdentifier(node.name) && node.name.text === "running" &&
      node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "isProfileRunningForRestore");
    expect(runningChecks).toHaveLength(1);
    const branches = nodes(pull, ts.isIfStatement).filter(node => ts.isIdentifier(node.expression) && node.expression.text === "running");
    const skipBranches = ["localStorage", "preferences"].map(scope => {
      const matched = branches.filter(branch => nodes(branch.thenStatement, ts.isCallExpression).some(call =>
        ts.isPropertyAccessExpression(call.expression) && call.expression.expression.getText(tree) === "operation" && call.expression.name.text === "add" &&
        call.arguments.length === 1 && ts.isObjectLiteralExpression(call.arguments[0]) && stringProperty(call.arguments[0], "scope") === scope &&
        stringProperty(call.arguments[0], "state") === "skipped" && stringProperty(call.arguments[0], "code") === "PROFILE_RUNNING"));
      expect(matched, `${scope} must report a typed running-profile skip`).toHaveLength(1);
      expect(matched[0].elseStatement, `${scope} restore must be behind the stopped-profile branch`).toBeDefined();
      return matched[0];
    });
    expect(calls(skipBranches[0].thenStatement, "importLocalStorage")).toHaveLength(0);
    expect(calls(skipBranches[0].elseStatement!, "importLocalStorage")).toHaveLength(1);
    expect(calls(skipBranches[1].thenStatement, "writeFileAtomic")).toHaveLength(0);
    const writes = calls(skipBranches[1].elseStatement!, "writeFileAtomic");
    expect(writes).toHaveLength(1);
    const write = writes[0];
    expect(ts.isCallExpression(write.arguments[0])).toBe(true);
    const destination = write.arguments[0] as ts.CallExpression;
    expect(destination.expression.getText(tree)).toBe("resolveProfileFile");
    expect(destination.arguments.map(argument => ts.isStringLiteralLike(argument) ? argument.text : argument.getText(tree))).toEqual(["dirId", "Default", "Preferences"]);
    expect(write.arguments[1].getText(tree)).toBe("artifacts.preferences");
    const validations = calls(pull, "validatePreferencesJson");
    expect(validations.length, "remote Preferences must be validated before publication").toBeGreaterThan(0);
    expect(Math.min(...validations.map(call => call.getStart(tree)))).toBeLessThan(write.getStart(tree));
    expect(sync).toContain("extractSafeLocalStorageArchive");
    expect(sync).toContain("LocalStorage archive contains non-regular entries");
  });

  it("uses the Agent Browser sync key with a legacy read-only fallback", () => {
    const sync = fs.readFileSync(path.join(ROOT, "src/main/services/sync-service.ts"), "utf-8");
    expect(sync).toContain('const SYNC_CONFIG_KEY = "agent-browser-studio-config.json"');
    expect(sync).toContain('const LEGACY_SYNC_CONFIG_KEY = "cloak-lite-config.json"');
  });
});
