// SERIAL COORDINATOR ONLY, after the CURRENT build is frozen and RUN is granted.
// ABS_HEALTH_ACCEPTANCE=1 DIST_READY=1 ABS_HEALTH_ACCEPTANCE_ROOT=<fresh empty child of approved SSD root>
// AGENT_BROWSER_CHROMIUM_BINARY_PATH=<existing managed native binary>
// AGENT_BROWSER_FIREFOX_BINARY_PATH=<existing managed native binary>
// Auto-launch-then-immediate-RTC is individually BLOCKED: CDP readiness does not
// prove the owned fault page loaded, so that path could reach Google STUN. All
// running RTC checks first verify the owned fault page; the rest of the case runs.
// Run this file alone with the already-approved isolated E2E runner. Never build here.
// Original preload/IPC, actual windows, HTTP auth and on-disk history are real.
// RTC constructor faults belong ONLY to the labeled local fixture, never a PASS oracle.
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { setupTestApp, type TestAppHandle } from "./helpers/app.js";
import {
  createOwnedRoot, existingNativeBinary, inside, jsonRequest, localHealthFixture,
  ownedPids, pause, pidExited, realDirectory, regularBytes, sha256, storageBudget, until,
} from "./helpers/health-fixture.js";

type Kind = "env" | "webrtc" | "drift" | "consistency";
type Entry = { kind: Kind; at: number; outcome: string; summary: string; requestId?: string; source: string };
type Live = { id: string; pid: number; port: number; engine: "chromium" | "firefox"; browser?: Browser; page?: Page };
type Receipt = {
  schema: string; status: string; phase: string; startedAt: string; finishedAt?: string;
  observations: Record<string, any>; screenshots: Array<{ file: string; bytes: number; sha256: string; scope: string }>;
  limitations: string[]; cleanup: string[]; error?: string;
};
const REPO = path.resolve(__dirname, "../..");
const OUTCOMES = ["pass", "warn", "risk", "error", "unavailable", "inconclusive", "cancelled", "baseline-established"];
const MENU = ["drift", "lock", "consistency", "env", "webrtc", "risk", "history"];
const PROXY = "health-acceptance-loopback-deny";
const RTC_ERROR = "Owned health acceptance fixture: deliberate constructor failure";
const OPTED_IN = process.env.ABS_HEALTH_ACCEPTANCE === "1";

// Import/collection without explicit opt-in does not touch disk, discover engines,
// listen on a socket, launch Electron or start a browser.
describe.skipIf(!OPTED_IN)("real Electron health functional acceptance (coordinator RUN only)", () => {
  let owned = "", userData = "", h: TestAppHandle | undefined, receipt: Receipt | undefined;
  let fixture: Awaited<ReturnType<typeof localHealthFixture>> | undefined;
  let restPort = 0, mcpPort = 0, restToken = "", mcpToken = "";
  let frozen: Record<string, string> = {};
  const ids: string[] = [], live = new Map<string, Live>(), unhandled: string[] = [], blocked: string[] = [];
  let budgetTimer: ReturnType<typeof setInterval> | undefined, budgetFailure: Error | undefined, cleaningUp = false;

  async function deadline<T>(label: string, promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline; underlying completion/cancellation is not claimed`)), ms); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  const api = (group: string, method: string, ...args: any[]): Promise<any> => deadline(`Original preload ${group}.${method}`, h!.page.evaluate(async input => {
    const bridge = (window as any).agentBrowserAPI;
    if (typeof bridge?.[input.group]?.[input.method] !== "function") throw new Error(`Missing original preload API ${input.group}.${input.method}`);
    return bridge[input.group][input.method](...input.args);
  }, { group, method, args }), cleaningUp ? 2_500 : 30_000);
  const card = (id: string) => h!.page.locator(`#profile-list .profile-card[data-dir-id="${id}"]`);
  const disk = (): any => JSON.parse(regularBytes(owned, path.join(userData, "config.json")).toString("utf8"));
  const raw = (id: string, kind: "env" | "webrtc"): any[] => disk()[kind === "env" ? "envRiskDiagnostics" : "webrtcDiagnostics"]?.[id] || [];
  const canonical = (id: string): Entry[] => disk().profileHealthHistory?.[id] || [];
  function checkpoint(): void { if (budgetFailure) throw budgetFailure; storageBudget(); }
  async function phase(name: string, task: () => Promise<void>): Promise<void> {
    checkpoint(); receipt!.phase = name; await task(); checkpoint();
  }
  async function refresh(): Promise<void> {
    await h!.page.evaluate(() => (window as any).agentBrowser.loadProfiles());
    for (const id of ids) await card(id).waitFor({ state: "visible" });
  }
  async function menu(id: string, value: string): Promise<void> {
    const select = card(id).locator('select[data-action="health"]');
    await select.waitFor({ state: "visible" });
    expect(await select.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value).filter(Boolean))).toEqual(MENU);
    await select.selectOption(value); // actual visible native select/change handler
  }
  async function closeDialog(kind: "env" | "webrtc"): Promise<void> {
    const dialog = h!.page.locator(kind === "env" ? "#dlg-env-risk" : "#dlg-webrtc-diag");
    await dialog.locator('[data-cmd="close-dialog"]').click();
    await until("health dialog closed", async () => !(await dialog.evaluate((element: HTMLDialogElement) => element.open)));
  }
  async function confirmation(accept: boolean): Promise<void> {
    const dialog = h!.page.locator("#dlg-confirm"); await dialog.waitFor({ state: "visible" });
    await dialog.locator(accept ? 'button[type="submit"]' : '[data-cmd="close-dialog"]').click();
    await until("confirmation closed", async () => !(await dialog.evaluate((element: HTMLDialogElement) => element.open)));
  }
  async function screenshot(name: string, scope: string, page = h!.page, png?: Buffer): Promise<void> {
    checkpoint();
    if (receipt!.screenshots.length >= 8) throw new Error("Health acceptance PNG count exceeds 8");
    const bytes = png || await page.screenshot({ animations: "disabled", fullPage: false, timeout: 10_000 });
    if (bytes.length > 2 * 1024 * 1024) throw new Error("Health acceptance PNG exceeds 2 MiB");
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const file = path.join(owned, name + ".png"); fs.writeFileSync(file, bytes, { flag: "wx" });
    expect(regularBytes(owned, file, 2 * 1024 * 1024)).toEqual(bytes);
    receipt!.screenshots.push({ file, bytes: bytes.length, sha256: sha256(bytes), scope });
  }
  function artifactIdentity(): Record<string, string> {
    const native = ["ipc/browser", "ipc/webrtc", "ipc/app", "services/browser-manager", "services/browser/runtime-table", "services/browser/lifecycle", "services/browser/graceful-close",
      "services/config-manager", "services/main-i18n", "services/profile-health", "services/environment-risk", "services/webrtc-diagnostics",
      "services/fingerprint-baseline", "services/rest-api-server", "services/mcp-server", "services/page-eval", "services/bidi-client",
      "services/browser-engine", "services/native-firefox-manager", "services/firefox-runtime-package"];
    const copied = ["main/preload.cjs", "renderer/index.html", "renderer/js/app/profiles.js", "renderer/js/app/ipc.js", "renderer/js/i18n.js"];
    const files = ["dist/main/index.js", "src/main/index.ts", "src/main/types.ts",
      ...native.flatMap(file => [`dist/main/${file}.js`, `src/main/${file}.ts`]),
      ...copied.flatMap(file => [`dist/${file}`, `src/${file}`])];
    return Object.fromEntries(files.map(file => [file, sha256(regularBytes(REPO, path.join(REPO, file), 4 * 1024 * 1024))]));
  }
  async function history(id: string): Promise<Entry[]> {
    const response = await api("browser", "healthHistory", id);
    expect(response.error).toBeUndefined(); expect(response.ok).not.toBe(false); expect(response.success).not.toBe(false); expect(Array.isArray(response.entries)).toBe(true);
    const entries: Entry[] = response.entries;
    for (const entry of entries) {
      expect(["env", "webrtc", "drift", "consistency"]).toContain(entry.kind);
      expect(OUTCOMES).toContain(entry.outcome); expect(["runtime", "host", "baseline", "cached", "legacy"]).toContain(entry.source);
      expect(Number.isSafeInteger(entry.at) && entry.at > 0).toBe(true); expect(typeof entry.summary).toBe("string");
      if (entry.requestId !== undefined) expect(entry.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/);
      if (entry.source === "legacy" || entry.kind === "consistency") expect(entry.outcome).not.toBe("pass");
    }
    expect(entries.map(entry => entry.at)).toEqual(entries.map(entry => entry.at).sort((a, b) => a - b));
    expect(entries).toEqual(canonical(id)); return entries;
  }
  async function assertCard(id: string, entry?: Entry): Promise<void> {
    const last = entry || (await history(id)).at(-1);
    const verdict = card(id).locator(".health-verdict");
    await until("card reflects canonical health outcome and summary", async () =>
      (await verdict.getAttribute("data-health-outcome")) === (last?.outcome || "inconclusive") && (!last || (await verdict.getAttribute("title")) === last.summary));
    if (last) expect(await verdict.getAttribute("title")).toBe(last.summary);
    if (!last || last.outcome !== "pass") expect(await verdict.innerText()).not.toMatch(/\bpass\b|通过/i);
  }
  async function diagnosticReadback(id: string, kind: "env" | "webrtc", expectedOutcome?: string): Promise<any> {
    await until("detailed and canonical diagnostic committed", () => raw(id, kind).length > 0 && canonical(id).some(entry => entry.kind === kind));
    const rows = raw(id, kind), latest = rows.at(-1);
    const entry = canonical(id).find(item => item.kind === kind && item.requestId === latest.requestId)!;
    expect(entry).toMatchObject({ kind, at: latest.at, outcome: latest.outcome, summary: latest.summary, requestId: latest.requestId, source: "runtime" });
    if (expectedOutcome) expect(latest.outcome).toBe(expectedOutcome);
    const detailResponse = await api(kind === "env" ? "browser" : "webrtc", kind === "env" ? "envRiskHistory" : "diagHistory", id);
    expect(detailResponse.error).toBeUndefined(); expect(kind === "env" ? detailResponse.ok : detailResponse.success).toBe(true); expect(detailResponse.entries).toEqual(rows);
    const body = h!.page.locator(kind === "env" ? "#env-risk-body" : "#webrtc-diag-body");
    expect(await body.locator("[data-health-outcome]").first().getAttribute("data-health-outcome")).toBe(latest.outcome);
    if (kind === "env") {
      for (const finding of latest.findings) { expect(await body.innerText()).toContain(finding.code); expect(await body.innerText()).toContain(finding.message); }
      for (const address of latest.resolvers) expect(await body.innerText()).toContain(address);
    } else {
      expect(await body.innerText()).toContain(latest.summary);
      if (latest.success === false) expect(await body.innerText()).not.toMatch(/\bpass\b|通过/i);
    }
    // Write -> direct config read -> real config reload -> read by ID -> search
    // the authoritative requestId -> rendered card and expandable history.
    expect((await api("app", "reloadConfig")).success).toBe(true);
    expect(await history(id)).toEqual(canonical(id));
    const readback = await api("profile", "get", id), list = await api("browser", "list");
    expect(readback.dirId).toBe(id); expect(readback.name).toBe(disk().browserProfiles[id].name);
    expect(list.filter((profile: any) => profile.dirId === id)).toHaveLength(1);
    expect((await history(id)).filter(item => item.requestId === latest.requestId)).toEqual([entry]);
    const host = h!.page.locator(kind === "env" ? "#env-risk-history" : "#webrtc-diag-history");
    const attr = kind === "env" ? "env" : "webrtc";
    const row = host.locator(`[data-${attr}-hist="${rows.length - 1}"]`); await row.waitFor({ state: "visible" }); await row.click();
    expect(await host.locator(`[data-${attr}-hist-detail="${rows.length - 1}"] [data-health-outcome]`).getAttribute("data-health-outcome")).toBe(latest.outcome);
    await assertCard(id, entry); return { raw: latest, canonical: entry };
  }
  async function mcp(name: string, args: any = {}): Promise<any> {
    const response = await jsonRequest(mcpPort, mcpToken, "POST", "/mcp", { jsonrpc: "2.0", id: 51, method: "tools/call", params: { name, arguments: args } });
    expect(response.status).toBe(200); expect(response.body.error).toBeUndefined(); expect(response.body.result.isError).toBeFalsy();
    return JSON.parse(response.body.result.content[0].text);
  }
  async function attach(id: string, engine: Live["engine"]): Promise<Live> {
    await until("actual profile process/port and original launch IPC settled", async () => {
      const status = await api("browser", "status", id);
      const busy = await h!.page.evaluate(profileId => (window as any).agentBrowser.ipc.isBusy("browser.launch:" + profileId), id);
      return status.running && status.pid > 0 && status.cdpPort > 0 && !busy;
    }, 75_000);
    await card(id).locator('[data-action="stop"]').waitFor({ state: "visible" });
    const status = await api("browser", "status", id);
    const target: Live = { id, pid: status.pid, port: status.cdpPort, engine }; live.set(id, target);
    const command = path.join(userData, "logs", `browser-${id}.log`);
    const log = regularBytes(owned, command).toString("utf8");
    expect(log).not.toMatch(/--no-sandbox|--headless|(?:^|\s)-headless(?:\s|$)/);
    expect(pidExited(target.pid)).toBe(false);
    if (engine === "chromium") {
      target.browser = await chromium.connectOverCDP(`http://127.0.0.1:${target.port}`, { timeout: 30_000 });
      const context = target.browser.contexts()[0]; expect(context).toBeDefined();
      await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === fixture!.origin || ["data:", "blob:", "about:", "chrome:"].includes(url.protocol)) await route.continue();
        else await route.abort("blockedbyclient");
      });
      target.page = context.pages().find(page => page.url().startsWith(fixture!.origin)) || context.pages()[0];
      expect(target.page).toBeDefined();
      target.page!.on("console", message => {
        const text = message.text();
        if (!text.startsWith("[font-corpus:page]")) return;
        const stages = receipt!.observations.nativeCaptureStages ||= [];
        if (stages.length < 40) stages.push({ id, at: Date.now(), type: message.type(), text: text.slice(0, 512) });
      });
    }
    (receipt!.observations.launches ||= []).push({ id, pid: target.pid, port: target.port, engine, headful: true, launchLogSha256: sha256(log) });
    return target;
  }
  async function nativePage(target: Live, mode: string, url = `${fixture!.origin}/${mode}`): Promise<void> {
    let read: any;
    if (target.engine === "firefox") {
      read = await firefox(target, "navigate", url); expect(read.mode).toBe(mode); expect(read.userAgent).toContain("Firefox/");
    } else {
      await target.page!.goto(url, { waitUntil: "load", timeout: 12_000 });
      expect(await target.page!.locator("#fixture-mode").innerText()).toBe(mode);
      await target.page!.bringToFront(); await target.page!.locator("#fixture-read").click();
      read = JSON.parse(await target.page!.locator("#fixture-values").innerText());
      expect(read.clicks).toBeGreaterThan(0); expect(read.userAgent).toMatch(/Chrome|Chromium/);
    }
    expect(read.url).toBe(url);
    if (mode === "native") { expect(read.rtc).toBe("function"); expect(read.rtcFault).toBe("none"); }
    else if (mode === "unavailable") { expect(read.rtc).toBe("undefined"); expect(read.rtcFault).toBe("unavailable"); }
    else {
      // Fail closed BEFORE running PROBE_JS if a preload/navigation race left
      // the real network-capable constructor on this page instead of our fault.
      expect(read.rtcFault).toBe("constructor-failure"); expect(read.rtcName).toBe("HealthAcceptanceRtcConstructorFault");
    }
    await h!.page.bringToFront();
  }
  async function firefox(target: Live, action: "navigate" | "read" | "click" | "screenshot", url?: string): Promise<any> {
    // Reuse the product's REAL registered BiDi session; never start a second
    // session or replace its send/evaluate functions. These actions only drive
    // our owned page, read native identity, or capture an actual viewport.
    return h!.app.evaluate(async (_electron, input) => {
      const bidi = await import(input.moduleUrl);
      const connection = bidi.getRegisteredFirefoxSession(input.port);
      if (!connection) throw new Error("BLOCKED: actual launched Firefox has no registered BiDi session");
      const context = await bidi.bidiGetTopContext(connection);
      if (input.action === "navigate") { await bidi.bidiNavigate(connection, input.url, context); await bidi.bidiActivateContext(connection, context); }
      if (input.action === "click") {
        const rect = await bidi.bidiEvaluateInContext(connection, 'JSON.stringify((function(){var r=document.getElementById("fixture-read").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})())', context);
        const point = JSON.parse(rect);
        await bidi.bidiPerformActions(connection, context, [{ type: "pointer", id: "health-owned-pointer", parameters: { pointerType: "mouse" }, actions: [
          { type: "pointerMove", x: point.x, y: point.y, duration: 0, origin: "viewport" }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 },
        ] }]);
      }
      if (input.action === "screenshot") {
        const image = await bidi.bidiCaptureScreenshot(connection, context);
        if (!image || image.length > 2_800_000) throw new Error("Firefox viewport PNG absent/over budget");
        return image;
      }
      return JSON.parse(await bidi.bidiEvaluateInContext(connection, 'JSON.stringify({url:location.href,title:document.title,mode:document.getElementById("fixture-mode").textContent,nativeRtc:document.documentElement.dataset.nativeRtc,rtc:typeof RTCPeerConnection,rtcName:typeof RTCPeerConnection==="function"?RTCPeerConnection.name:null,rtcFault:document.documentElement.dataset.rtcFault,userAgent:navigator.userAgent,platform:navigator.platform,clicks:Number(document.documentElement.dataset.clicks||0)})', context));
    }, { moduleUrl: pathToFileURL(path.join(REPO, "dist/main/services/bidi-client.js")).href, port: target.port, action, url });
  }
  async function stop(id: string): Promise<void> {
    const status = await api("browser", "status", id), target = live.get(id);
    if (status.running) {
      expect((await api("browser", "stop", id)).success).toBe(true);
      await until("owned profile status stopped", async () => !(await api("browser", "status", id)).running, cleaningUp ? 5_000 : 15_000);
      await until("owned browser PID actually exited", () => pidExited(status.pid), cleaningUp ? 5_000 : 15_000);
      (receipt!.observations.stops ||= []).push({ id, pid: status.pid, pidConfirmedExited: true, via: "original preload browser.stop", gracefulFlush: "not inferred" });
    }
    if (target) { await until("tracked owned browser exited", () => pidExited(target.pid), cleaningUp ? 5_000 : 15_000); if (target.browser) await until("owned CDP disconnected", () => !target.browser!.isConnected(), 5_000); live.delete(id); }
  }
  async function createProfile(engine: Live["engine"], label: string): Promise<string> {
    const result = await api("browser", "create", { name: `Health acceptance ${label}`, engine, platform: "macos", fingerprintMode: "off",
      webrtcMode: "real", proxyMode: "named", proxyName: PROXY, appUrl: fixture!.origin + "/unavailable", tags: ["health-acceptance-fixture"] });
    expect(result.dirId, JSON.stringify(result)).toMatch(/^ab_[A-Za-z0-9_-]+$/); ids.push(result.dirId);
    expect(disk().browserProfiles[result.dirId]).toMatchObject({ name: `Health acceptance ${label}`, engine, fingerprintMode: "off" });
    await refresh(); return result.dirId;
  }
  async function gateRun(id: string): Promise<{ id: string; url: string }> {
    const gate = fixture!.arm(); await nativePage(live.get(id)!, "held-failure", gate.url);
    await menu(id, "webrtc"); await until("actual browser constructor reached local XHR gate", () => fixture!.reached(gate.id), 8_000);
    return gate;
  }

  it("keeps native health facts, failures, history, cancellation and baseline consent consistent across actual UI/IPC/disk/transports", async () => {
    expect(process.env.DIST_READY, "Coordinator must explicitly freeze/build current dist before RUN").toBe("1");
    expect(process.platform).toBe("darwin"); expect(process.env.AGENT_BROWSER_E2E_UNSANDBOXED).not.toBe("1");
    ({ owned } = createOwnedRoot(process.env.ABS_HEALTH_ACCEPTANCE_ROOT));
    receipt = { schema: "actual-app-health-functional-acceptance/v1", status: "running", phase: "preflight", startedAt: new Date().toISOString(), observations: {}, screenshots: [], cleanup: [], limitations: [
      "Fresh HOME/userData are exclusively owned fixtures, not proof of the real user's activation, vault or default provider configuration.",
      "Original product env/baseline measurements are neither rewritten nor coerced to PASS; risk/warn/inconclusive remain valid observed outcomes.",
      "RTC unavailable/constructor failure/local synchronous-XHR delay are explicitly labeled negative page fixtures. They never create a native peer or contact the production Google STUN targets; no native RTC-success/latency/all-routes claim is made.",
      "The local HTTP proxy denies external-origin requests it receives; it is NOT a UDP/STUN egress fence. Chromium CDP additionally blocks non-fixture page requests. Every running RTC probe first verifies the owned fault constructor; the unsafe auto-launch/immediate-probe positive is individually blocked. Ping0 consent is cancelled; external navigation/health scores are not claimed.",
      "Public REST/MCP /health proves service liveness only. Business env-risk uses the original REST/IPC coordinator; MCP currently has no env-risk tool.",
      "Closing a diagnostic view does not cancel main work or stop its browser. Only request-scoped cancellation plus actual underlying settle releases the lease.",
      "Captured PNGs require coordinator visual review after RUN; this test's assertions do not substitute for looking at the screenshots.",
    ] };
    try {
      const binary = existingNativeBinary(process.env.AGENT_BROWSER_CHROMIUM_BINARY_PATH, "chromium");
      // Both selections are explicit BEFORE app discovery: omitting Firefox
      // would let the original finder inspect/execute an unapproved system-stock
      // /Applications candidate. Missing means BLOCKED, never that fallback or
      // a fake executable. The coordinator already identified a managed build.
      let firefoxBinary: string;
      try { firefoxBinary = existingNativeBinary(process.env.AGENT_BROWSER_FIREFOX_BINARY_PATH, "firefox"); }
      catch (error) { receipt.observations.firefox = { status: "blocked", reason: String(error), beforeGuiDiscovery: true }; throw error; }
      frozen = artifactIdentity(); receipt.observations.artifacts = frozen;
      for (const relative of ["main/preload.cjs", "renderer/index.html", "renderer/js/app/profiles.js", "renderer/js/app/ipc.js", "renderer/js/i18n.js"]) {
        expect(sha256(regularBytes(REPO, path.join(REPO, "dist", relative), 4 * 1024 * 1024)), `Stale frozen copied artifact ${relative}`)
          .toBe(sha256(regularBytes(REPO, path.join(REPO, "src", relative), 4 * 1024 * 1024)));
      }
      fixture = await localHealthFixture();
      userData = fs.mkdtempSync(path.join(owned, "userdata-")); realDirectory(userData);
      restToken = "health-rest-" + path.basename(userData); mcpToken = "health-mcp-" + path.basename(userData);
      budgetTimer = setInterval(() => { try { storageBudget(); } catch (error) { budgetFailure = error instanceof Error ? error : new Error(String(error)); } }, 2_000);
      h = await setupTestApp({ userDataDir: userData, resetUserData: false, env: {
        AGENT_BROWSER_CHROMIUM_BINARY_PATH: binary, AGENT_BROWSER_FIREFOX_BINARY_PATH: firefoxBinary,
        AGENT_BROWSER_API_PORT: "0", AGENT_BROWSER_MCP_PORT: "0", AGENT_BROWSER_API_TOKEN: restToken, AGENT_BROWSER_MCP_TOKEN: mcpToken,
      } });
      h.app.process().stderr?.on("data", data => { const text = String(data); if (/unhandled|uncaught/i.test(text)) { if (unhandled.length < 20) unhandled.push(text.slice(0, 1000)); else budgetFailure = new Error("Unhandled main-process error budget exceeded"); } });
      const isolation = await h.app.evaluate(({ app, BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes("index.html"));
        if (!win || win.isDestroyed()) throw new Error("Actual Electron main window is unavailable");
        return { home: process.getBuiltinModule("os").homedir(), envHome: process.env.HOME, userData: app.getPath("userData"),
          appPath: app.getAppPath(), windowUrl: win.webContents.getURL(), visible: win.isVisible(),
          noSandbox: app.commandLine.hasSwitch("no-sandbox"), nodeVersion: process.versions.node,
          providerKeys: Object.keys(process.env).filter(key => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(key)) };
      });
      expect(realDirectory(isolation.home)).toBe(realDirectory(path.join(userData, "test-home")));
      expect(realDirectory(isolation.envHome!)).toBe(realDirectory(isolation.home)); expect(realDirectory(isolation.userData)).toBe(realDirectory(userData));
      expect(realDirectory(isolation.appPath)).toBe(realDirectory(REPO)); expect(isolation.windowUrl).toBe(pathToFileURL(path.join(REPO, "dist/renderer/index.html")).href);
      expect(isolation.visible).toBe(true); expect(isolation.noSandbox).toBe(false); expect(isolation.providerKeys).toEqual([]);
      const bridge = await h.page.evaluate(() => ({ frozen: Object.isFrozen((window as any).agentBrowserAPI), nodeRequire: typeof (window as any).require, nodeProcess: typeof (window as any).process }));
      expect(bridge).toEqual({ frozen: true, nodeRequire: "undefined", nodeProcess: "undefined" });
      receipt.observations.originalBridge = { ...bridge, copiedPreloadSha256: frozen["dist/main/preload.cjs"], qualification: "Unchanged built preload + real sandboxed UI API; private WebPreferences inspection is not available in Electron's public API" };
      await h.page.evaluate(() => (window as any).i18n.set("en-US"));
      receipt.observations.isolation = isolation;
      await until("real REST/MCP listeners", async () => (await api("apiRpc", "status")).running && (await api("mcp", "status")).running);
      restPort = (await api("apiRpc", "status")).port; mcpPort = (await api("mcp", "status")).port;
      expect(restPort).toBeGreaterThan(0); expect(mcpPort).toBeGreaterThan(0);
      expect((await api("proxy", "add", PROXY, { type: "http", host: "127.0.0.1", port: fixture.port })).success).toBe(true);
      const a = await createProfile("chromium", "Chromium A"), b = await createProfile("chromium", "Chromium B");
      receipt.observations.profiles = { chromiumA: a, chromiumB: b, binary };

      await phase("public liveness is distinct from authenticated business health", async () => {
        const auth: Record<string, number[]> = {};
        for (const [name, port, token, method, route, body] of [
          ["rest", restPort, restToken, "GET", `/api/profiles/${a}/env-risk`, undefined],
          ["mcp", mcpPort, mcpToken, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }],
        ] as const) {
          const before = raw(a, "env"); const publicReply = await jsonRequest(port, null, "GET", "/health");
          expect(publicReply.status).toBe(200); expect(publicReply.body.status).toBe("ok"); expect(raw(a, "env")).toEqual(before);
          auth[name] = [];
          for (const credential of [null, "wrong-health-fixture-token"]) auth[name].push((await jsonRequest(port, credential, method, route, body)).status);
          expect(raw(a, "env")).toEqual(before); // denied requests cannot run diagnostics
          const allowed = await jsonRequest(port, token, method, route, body); auth[name].push(allowed.status);
          expect(auth[name]).toEqual([401, 401, 200]);
          if (name === "rest") {
            expect(allowed.body.outcome).not.toBe("pass"); expect(raw(a, "env").at(-1)).toMatchObject({ requestId: allowed.body.requestId, outcome: allowed.body.outcome, source: "host" });
          } else expect(allowed.body.result.tools.some((tool: any) => tool.name === "agent_browser_profile_info")).toBe(true);
        }
        expect(await mcp("agent_browser_profile_info", { dirId: a })).toMatchObject({ dirId: a, name: disk().browserProfiles[a].name, running: false });
        receipt!.observations.auth = { statuses: auth, publicHealthIsOnlyLiveness: true };
      });
      await phase("stopped diagnostic requires visible launch consent; Cancel starts zero processes", async () => {
        const log = path.join(userData, "logs", `browser-${a}.log`), existed = fs.existsSync(log);
        const before = existed ? regularBytes(owned, log) : null;
        expect((await api("browser", "status", a)).running).toBe(false);
        await menu(a, "webrtc"); await h!.page.locator("#dlg-confirm").waitFor({ state: "visible" });
        expect(await h!.page.locator("#dlg-confirm-msg").innerText()).toMatch(/running browser|Start the profile/i);
        expect(await h!.page.locator("#dlg-confirm-detail").innerText()).toMatch(/left running/i);
        await confirmation(false); await pause(400);
        expect((await api("browser", "status", a)).running).toBe(false); expect(ownedPids(path.join(userData, "profiles", a))).toEqual([]);
        expect(fs.existsSync(log)).toBe(existed); if (before) expect(regularBytes(owned, log)).toEqual(before);
        await closeDialog("webrtc");
        const reason = "Automatic confirm-launch-then-RTC is not exercised: CDP-ready does not prove that the owned fault script replaced the initial about:blank context; no inherited UDP/STUN egress fence is authorized. Direct IPC launch-permission unit coverage is separate, not this GUI positive case.";
        blocked.push(reason);
        // Do not click Confirm and race the production Google STUN probe.
        // Launch normally through the actual card, then verify the owned page
        // before issuing ANY running RTC diagnostic. This is not an automatic
        // launch+diagnostic success and is labeled accordingly in the receipt.
        await card(a).locator('[data-action="launch"]').click();
        const target = await attach(a, "chromium"); await nativePage(target, "unavailable");
        await menu(a, "webrtc");
        await until("real unavailable result on verified owned page", async () => (await h!.page.locator('#webrtc-diag-body [data-health-outcome]').getAttribute("data-health-outcome")) === "unavailable", 30_000);
        receipt!.observations.launchConsent = { cancelZeroLaunch: true, automaticLaunchAndImmediateRtc: { status: "blocked", reason }, manualCardLaunchPid: target.pid, runningOwnedUnavailable: await diagnosticReadback(a, "webrtc", "unavailable") };
        await closeDialog("webrtc"); await nativePage(target, "native");
        await screenshot("01-real-chromium-page", "Actual managed Chromium headful local page and native identity", target.page!);
      });
      await phase("real runtime environment measurement is persisted, reloaded and rendered without outcome rewriting", async () => {
        await menu(a, "env");
        await until("environment UI completed", async () => (await h!.page.locator("#env-risk-body [data-health-outcome]").count()) > 0, 30_000);
        const env = await diagnosticReadback(a, "env");
        expect(env.raw.findings.length).toBeLessThanOrEqual(50); expect(env.raw.resolvers.length).toBeGreaterThan(0);
        receipt!.observations.nativeEnvironment = env;
        await screenshot("02-runtime-environment", "Real environment findings, canonical outcome and expandable stored history; no forced PASS");
        await closeDialog("env");
        // Same product coordinator, not a cached success or /health liveness.
        const ipc = await api("browser", "envRisk", a, { requestId: "health-acceptance-ipc-native" });
        expect(ipc.result).toBeDefined(); expect(ipc.result.raf.samples).toBeGreaterThan(0); expect(ipc.result.measurements.raf).toBe("complete");
        expect(raw(a, "env").at(-1)).toMatchObject({ requestId: ipc.requestId, outcome: ipc.outcome, findings: ipc.result.findings, resolvers: ipc.result.resolvers.map((resolver: any) => resolver.address) });
        const rest = await jsonRequest(restPort, restToken, "GET", `/api/profiles/${a}/env-risk`);
        expect(rest.status).toBe(200); expect(rest.body.raf.samples).toBeGreaterThan(0);
        expect(raw(a, "env").at(-1)).toMatchObject({ requestId: rest.body.requestId, outcome: rest.body.outcome, findings: rest.body.findings, resolvers: rest.body.resolvers.map((resolver: any) => resolver.address) });
        for (const result of [ipc.result, rest.body]) expect(result.ok).toBe(!result.findings.some((finding: any) => finding.severity === "high"));
        const project = (result: any) => ({ hostPlatform: result.hostPlatform, hostLocale: result.hostLocale, resolvers: result.resolvers, cnFonts: result.cnFonts, proxy: result.proxy, measurements: result.measurements });
        expect(project(rest.body)).toEqual(project(ipc.result)); // timing values/outcomes are measured separately, not normalized away
        expect((await api("app", "reloadConfig")).success).toBe(true); await history(a); await refresh(); await assertCard(a);
        receipt!.observations.businessEnvironment = { ipc: { requestId: ipc.requestId, outcome: ipc.outcome, rawOk: ipc.result.ok, raf: ipc.result.raf }, rest: { requestId: rest.body.requestId, outcome: rest.body.outcome, rawOk: rest.body.ok, raf: rest.body.raf }, sharedProjection: project(rest.body) };
      });
      await phase("real constructor error with result/ok:false is not green and clear updates disk/card/history", async () => {
        await nativePage(live.get(a)!, "failure"); await menu(a, "webrtc");
        await until("real constructor failure committed", () => raw(a, "webrtc").at(-1)?.outcome === "error");
        const failure = await diagnosticReadback(a, "webrtc", "error");
        expect(failure.raw).toMatchObject({ success: false, rtcAvailable: true, candidates: [], hostIps: [], rttMs: null }); expect(failure.raw.error).toContain(RTC_ERROR);
        expect(await h!.page.locator("#webrtc-diag-body").innerText()).toMatch(/not measured|connected peer/i);
        await screenshot("03-rtc-real-fault-history", "Actual product result with empty candidates, controlled constructor error, error badge and replay; NOT native RTC success");
        await h!.page.locator('#dlg-webrtc-diag [data-cmd="webRtcDiagClear"]').click(); await confirmation(true);
        await until("both RTC histories cleared", () => raw(a, "webrtc").length === 0 && !canonical(a).some(entry => entry.kind === "webrtc"));
        await history(a); await assertCard(a);
        expect(await h!.page.locator("#webrtc-diag-history").innerText()).toMatch(/No history/i);
        receipt!.observations.rtcFaultAndClear = { failure, readBackEmpty: true, remainingCanonical: canonical(a) };
        await closeDialog("webrtc");
      });
      await phase("cancellation keeps main ownership until actual protocol settle and never stops the browser", async () => {
        const gate = await gateRun(a), before = canonical(a), pid = live.get(a)!.pid;
        expect(await api("browser", "healthCancel", a, { kind: "webrtc", requestId: "health-not-the-owning-request" })).toMatchObject({ success: false, cancelled: false, code: "HEALTH_NOT_OWNED" });
        await h!.page.locator("#webrtc-diag-cancel").click();
        await until("cancel request button disabled", async () => h!.page.locator("#webrtc-diag-cancel").isDisabled());
        expect(await api("browser", "envRisk", a, { requestId: "health-lease-before-underlying-settle" })).toMatchObject({ ok: false, code: "HEALTH_BUSY" });
        expect(canonical(a)).toEqual(before); expect(pidExited(pid)).toBe(false); expect((await api("browser", "status", a)).pid).toBe(pid);
        fixture!.release(gate.id);
        await until("cancelled actual response rendered", async () => (await h!.page.locator('#webrtc-diag-body [data-health-outcome]').getAttribute("data-health-outcome")) === "cancelled");
        expect(canonical(a)).toEqual(before); expect(raw(a, "webrtc")).toEqual([]); expect(pidExited(pid)).toBe(false);
        await closeDialog("webrtc"); await nativePage(live.get(a)!, "native");
        const settled = await api("browser", "envRisk", a, { requestId: "health-lease-after-underlying-settle" });
        expect(settled.code).not.toBe("HEALTH_BUSY"); expect(settled.result.raf.samples).toBeGreaterThan(0); await history(a);
        receipt!.observations.cancellation = { cancelledBeforeSettleRemainedBusy: true, browserPidStillRunning: pid, cancelledHistoryNotCommitted: true, releasedAfterRealSettle: settled.requestId };
      });
      await phase("closing/switching profiles fences late UI replies; clear fences late persistent replies", async () => {
        await card(b).locator('[data-action="launch"]').click(); const other = await attach(b, "chromium"); await nativePage(other, "unavailable");
        const gate = await gateRun(a); await closeDialog("webrtc");
        await menu(b, "webrtc"); await until("second profile unavailable result committed", () => raw(b, "webrtc").at(-1)?.outcome === "unavailable");
        await diagnosticReadback(b, "webrtc", "unavailable");
        const bodyBefore = await h!.page.locator("#webrtc-diag-body").innerHTML(), bBefore = canonical(b);
        await screenshot("04-profile-switch-fence", "B's actual unavailable dialog while A's separate native protocol call is still held locally");
        fixture!.release(gate.id); await until("closed A probe settled into A only", () => raw(a, "webrtc").at(-1)?.outcome === "error");
        await pause(250); expect(await h!.page.locator("#webrtc-diag-body").innerHTML()).toBe(bodyBefore); expect(canonical(b)).toEqual(bBefore);
        expect(await h!.page.evaluate(() => (window as any).__webrtcDiagDirId)).toBe(b); await closeDialog("webrtc");
        // A valid closed-view result may persist for A. It may not paint B or
        // reopen A; after an authoritative refresh A must show its own result.
        await refresh(); await assertCard(a); await assertCard(b);
        const clearGate = await gateRun(a);
        await h!.page.locator('#dlg-webrtc-diag [data-cmd="webRtcDiagClear"]').click(); await confirmation(true);
        await until("pending clear removes raw/canonical rows", () => raw(a, "webrtc").length === 0 && !canonical(a).some(entry => entry.kind === "webrtc"));
        expect(await api("browser", "envRisk", a, { requestId: "health-clear-still-settling" })).toMatchObject({ ok: false, code: "HEALTH_BUSY" });
        fixture!.release(clearGate.id); await until("cleared RTC request actually settled", async () => h!.page.locator("#webrtc-diag-cancel").isDisabled());
        await until("main lease released only after the cleared underlying call settled", async () => {
          const settled = await api("browser", "envRisk", a, { requestId: "health-clear-after-underlying-settle" });
          if (settled.code === "HEALTH_BUSY") return false;
          expect(settled.result.raf.samples).toBeGreaterThan(0); return true;
        });
        expect(raw(a, "webrtc")).toEqual([]); expect(canonical(a).some(entry => entry.kind === "webrtc")).toBe(false);
        expect(await h!.page.locator("#webrtc-diag-body").innerText()).toMatch(/Not checked yet/i); await history(a); await refresh(); await assertCard(a);
        receipt!.observations.lateReplyFences = { closedACommittedOnlyToA: true, bUnchanged: bBefore, clearPreventedResurrection: true };
        await closeDialog("webrtc"); await stop(b); await nativePage(live.get(a)!, "native");
      });
      await phase("stable native baseline is not PASS; risky replacement requires snapshot-bound explicit consent", async () => {
        const fontPermission = () => live.get(a)!.page!.evaluate(async () => {
          try { return (await navigator.permissions.query({ name: "local-fonts" as PermissionName })).state; }
          catch (error) { return error instanceof Error ? error.name : String(error); }
        });
        const permissionBefore = await deadline("Read existing font permission without requesting it", fontPermission(), 3_000);
        receipt!.observations.baselinePreflight = { localFontPermission: permissionBefore, qualification: "Permission query only; never requests/grants Local Font Access" };
        const before = canonical(a).length; await menu(a, "lock");
        await until("native baseline established", () => canonical(a).length > before && canonical(a).at(-1)?.outcome === "baseline-established", 30_000);
        await assertCard(a); const stable = disk().browserProfiles[a].fingerprintBaseline;
        expect(typeof stable.userAgent).toBe("string"); expect(stable.platform).toMatch(/^Mac/);
        expect(stable.fontAvailability).toContain("Arial|"); expect(stable.fontCapabilityHash).toMatch(/^[0-9a-f]+$/i);
        expect((receipt!.observations.nativeCaptureStages || []).map((entry: any) => entry.text)).toContain("[font-corpus:page] worker canvas complete");
        expect(await deadline("Font permission remains unrequested after baseline capture", fontPermission(), 3_000)).toBe(permissionBefore);
        expect(await mcp("agent_browser_profile_info", { dirId: a })).toMatchObject({ dirId: a, fingerprintBaseline: stable });
        // Legitimate saved intent edit creates an ACTUAL declared/live mismatch.
        // No navigator/canvas/DNS/time/baseline bytes or detector return is patched.
        const actualTz = stable.tz, mismatched = actualTz === "Pacific/Honolulu" ? "Europe/London" : "Pacific/Honolulu";
        expect((await api("browser", "setMeta", a, { timezone: mismatched })).success).toBe(true);
        const old = disk().browserProfiles[a].fingerprintBaseline;
        await menu(a, "lock"); await h!.page.locator("#dlg-confirm").waitFor({ state: "visible" });
        expect(await h!.page.locator("#dlg-confirm-detail").innerText()).toMatch(/not been replaced|previous baseline/i);
        expect(await h!.page.locator("#dlg-confirm-detail").innerText()).toContain("persona.tz"); expect(disk().browserProfiles[a].fingerprintBaseline).toEqual(old);
        await screenshot("05-risky-baseline-consent", "Real native snapshot vs deliberately mismatched saved timezone intent; old baseline is not silently replaced");
        await confirmation(false); expect(disk().browserProfiles[a].fingerprintBaseline).toEqual(old);
        const required = await api("browser", "captureBaseline", a);
        expect(required).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_REQUIRED", outcome: "risk", risky: true }); expect(required.confirmationToken).toBeTruthy();
        expect(disk().browserProfiles[a].fingerprintBaseline).toEqual(old);
        const changedIntent = ["Europe/Paris", "Asia/Tokyo"].find(timezone => timezone !== actualTz && timezone !== mismatched)!;
        expect((await api("browser", "setMeta", a, { timezone: changedIntent })).success).toBe(true);
        const stale = await api("browser", "captureBaseline", a, { confirmationToken: required.confirmationToken });
        expect(stale).toMatchObject({ ok: false, code: "BASELINE_CONFIRMATION_STALE", outcome: "inconclusive" }); expect(disk().browserProfiles[a].fingerprintBaseline).toEqual(old);
        // A new review through the REAL UI is required; never auto-retry a stale
        // token or bypass native snapshot changes to manufacture a successful save.
        const beforeRisk = canonical(a).length; await menu(a, "lock"); await confirmation(true);
        await until("explicit risky baseline accepted without laundering its risk", () => canonical(a).length > beforeRisk && canonical(a).at(-1)?.outcome === "risk", 30_000);
        await history(a); await assertCard(a); expect(canonical(a).at(-1)?.source).toBe("baseline");
        receipt!.observations.baseline = { stableOutcome: "baseline-established", stableSnapshotSha256: sha256(JSON.stringify(stable)), riskyNoSilentReplacement: true, requiredCode: required.code, staleCode: stale.code, explicitAcceptanceOutcome: canonical(a).at(-1)?.outcome, faultInput: "saved timezone intent only; native live fingerprint unchanged" };
        // Restore the real original intent through the product API, not the
        // captured fingerprint or any historic timestamp/outcome.
        expect((await api("browser", "setMeta", a, { timezone: null })).success).toBe(true);
        await menu(a, "drift"); await until("read-only live drift recorded", () => canonical(a).at(-1)?.source === "runtime", 30_000); await history(a); await assertCard(a);
        const beforeConsistency = canonical(a).length; await menu(a, "consistency");
        await until("stored/cached consistency is authoritative but remains unverified", () => canonical(a).length > beforeConsistency && canonical(a).at(-1)?.kind === "consistency");
        expect(canonical(a).at(-1)).toMatchObject({ kind: "consistency", outcome: "inconclusive", source: "cached" });
        expect((await api("app", "reloadConfig")).success).toBe(true); await history(a); await assertCard(a);
        expect(await card(a).locator(".health-verdict").innerText()).not.toMatch(/\bpass\b|通过/i);
        receipt!.observations.consistency = { liveAlignment: "unknown", card: await card(a).locator(".health-verdict").innerText(), canonical: await history(a) };
        await menu(a, "history"); await h!.page.locator("#dlg-confirm").waitFor({ state: "visible" });
        expect(await h!.page.locator("#dlg-confirm-detail [data-health-outcome]").count()).toBeGreaterThan(0);
        await screenshot("06-authoritative-health-history", "Canonical health history retains baseline-established/risk/unverified distinctions, not an all-green fingerprint score");
        await confirmation(false);
        const beforeExternal = fixture!.stats().deniedPing0; await menu(a, "risk"); await h!.page.locator("#dlg-confirm").waitFor({ state: "visible" });
        expect(await h!.page.locator("#dlg-confirm-detail").innerText()).toMatch(/external|fingerprint|proxy exit/i); await confirmation(false);
        expect(fixture!.stats().deniedPing0).toBe(beforeExternal); expect(live.get(a)!.page!.url()).toBe(fixture!.origin + "/native");
        receipt!.observations.externalRisk = { consentCancelled: true, externalNavigation: "not performed", profileHealthPass: "not inferred from navigation" };
      });
      await phase("real warm-reused Stop card automatically reflects observed exit without a fallback refresh", async () => {
        // B is the independent synthetic profile stopped above. Unlike A, its
        // declared identity was not edited by the risky-baseline review. Keep
        // the original named proxy and all original launch/reuse gates intact.
        const stopId = b;
        expect((await api("browser", "status", stopId)).running).toBe(false);
        await card(stopId).locator('[data-action="launch"]').click();
        const target = await attach(stopId, "chromium");
        await nativePage(target, "unavailable");
        const launchInputs = disk().browserProfiles[stopId];
        expect(launchInputs).toMatchObject({ engine: "chromium", fingerprintMode: "off", proxyMode: "named", proxyName: PROXY });
        const beforeWarm = await api("browser", "status", stopId);
        expect(beforeWarm).toMatchObject({ running: true, pid: target.pid, cdpPort: target.port });
        const launchLog = path.join(userData, "logs", `browser-${stopId}.log`);
        const launchHeaders = () => regularBytes(owned, launchLog).toString("utf8").split("\n").filter(line => /^\[[^\]\r\n]+\] Launching /.test(line));
        const headersBeforeWarm = launchHeaders();
        expect(headersBeforeWarm.length).toBeGreaterThan(0);
        // Actual frozen preload -> original gated launch; no forceDeadProxy,
        // replacement executable, private launch helper or synthetic response.
        const warmReply = await api("browser", "launch", stopId);
        expect(warmReply).toMatchObject({ success: true, pid: target.pid, cdpPort: target.port, driftCheck: { checked: false }, envCheck: { checked: false } });
        const afterWarm = await api("browser", "status", stopId);
        expect(afterWarm).toMatchObject({ running: true, pid: beforeWarm.pid, cdpPort: beforeWarm.cdpPort });
        expect(pidExited(target.pid)).toBe(false);
        expect(launchHeaders()).toEqual(headersBeforeWarm); // Reuse must not record another process launch.
        const warmObservedAt = Date.now();
        // ONLY excludes the renderer launch's one-shot 5000ms refresh plus its
        // 120ms debounce. This wait is not a storage-flush/durability test.
        await pause(5_500);
        await until("original launch refresh is quiescent before visible Stop", () => h!.page.evaluate(() => {
          const app = (window as any).agentBrowser;
          return app.state.profileRefreshTimer === null && !app.ipc.isBusy("browser.list");
        }), 5_000);
        const launchRefreshExclusionMs = Date.now() - warmObservedAt;
        expect(launchRefreshExclusionMs).toBeGreaterThan(5_120);
        const before = await api("browser", "status", stopId);
        expect(before).toMatchObject({ running: true, pid: target.pid, cdpPort: target.port });
        expect(await card(stopId).locator(".badge-lifecycle").innerText()).toMatch(/^Running$/i);
        const evidence: Record<string, any> = receipt!.observations.rendererStop = {
          status: "awaiting-visible-stop", id: stopId, via: "original visible card Stop button",
          warmReuse: { via: "original preload browser.launch", before: beforeWarm, after: afterWarm,
            reply: { success: warmReply.success, pid: warmReply.pid, cdpPort: warmReply.cdpPort, driftCheck: warmReply.driftCheck, envCheck: warmReply.envCheck },
            samePid: beforeWarm.pid === afterWarm.pid, samePort: beforeWarm.cdpPort === afterWarm.cdpPort,
            launchHeaderCountUnchanged: true, declaredInputs: { engine: launchInputs.engine, fingerprintMode: launchInputs.fingerprintMode, proxyMode: launchInputs.proxyMode, proxyName: launchInputs.proxyName } },
          launchRefreshExclusion: { observedElapsedMs: launchRefreshExclusionMs, oneShotMs: 5_000, debounceMs: 120, purpose: "Exclude one-shot launch refresh only; not a durability wait" },
          beforeStop: before, pid: before.pid, pidExitObservation: "pending", automaticCardObservation: "pending",
          persistence: "not inferred from reuse, acceptance, PID exit or the refresh-exclusion wait",
        };
        await card(stopId).locator('[data-action="stop"]').click();
        const notice = h!.page.locator(".toast").filter({ hasText: /stop request.*(?:accepted|submitted)|request.*waiting.*exit/i }).last();
        await notice.waitFor({ state: "visible", timeout: 10_000 });
        const text = await notice.innerText();
        expect(text).not.toMatch(/Browser stopped|浏览器已停止/);
        evidence.notice = text; evidence.noticeIsCompletionProof = false;
        // Do not call refresh(), loadProfiles(), stop(), or browser.status here.
        // statusBrowser can prune a dead entry and change the callback-vs-poll
        // race; its real readback follows the automatic-card assertion instead.
        await until("warm-reused Stop UI PID actually exited", () => pidExited(before.pid), 15_000);
        evidence.pidExitObservation = "observed"; evidence.pidConfirmedExited = true;
        const lifecycle = card(stopId).locator(".badge-lifecycle");
        await lifecycle.filter({ hasText: /^Stopped$/i }).waitFor({ state: "visible", timeout: 15_000 });
        expect(await lifecycle.innerText()).toMatch(/^Stopped$/i);
        expect(await card(stopId).getAttribute("class")).not.toMatch(/\brunning\b/);
        evidence.automaticCardObservation = "observed";
        evidence.manualRefreshBeforeCardAssertion = false; evidence.additionalStopBeforeCardAssertion = false;
        const afterAutomaticCard = await api("browser", "status", stopId);
        expect(afterAutomaticCard).toMatchObject({ running: false, pid: null });
        expect(pidExited(before.pid)).toBe(true);
        await until("warm-reused owned CDP disconnected", () => !target.browser!.isConnected(), 5_000);
        live.delete(stopId);
        evidence.statusAfterAutomaticCard = afterAutomaticCard; evidence.finalRunning = afterAutomaticCard.running; evidence.status = "observed";
        await screenshot("07-stop-request-and-verified-exit", "Original named-proxy Chromium B was warm-reused with the same PID/port; after the one-shot launch refresh expired, visible Stop and actual PID exit updated its card automatically without stop/refresh fallback; no durability claim");
        // Other-profile cleanup is deliberately after the automatic-card proof
        // and screenshot, so its exit event cannot make that assertion pass.
        await stop(a);
      });
      await phase("actual managed Firefox window and BiDi share the same health failure/persistence semantics", async () => {
        const binary = firefoxBinary;
        let engine: any;
        try { engine = await api("browser", "engineStatus"); }
        catch (error) {
          if (!/Invalid Firefox runtime package:/.test(String(error))) throw error;
          const reason = `Selected existing Firefox was rejected by the original runtime integrity check: ${String(error).slice(0, 1200)}`;
          blocked.push(reason);
          receipt!.observations.firefox = { status: "blocked", binary, reason, actualFirefoxLaunch: "not performed", nativeBidiEvidence: "not acquired", qualification: "No package repair/download, integrity bypass or fake executable/session is allowed" };
          return;
        }
        if (!engine.firefox?.installed) {
          const reason = "The selected existing Firefox is not installed/available to the original runtime; no replacement engine or mock is used";
          blocked.push(reason); receipt!.observations.firefox = { status: "blocked", binary, reason, actualFirefoxLaunch: "not performed", nativeBidiEvidence: "not acquired" };
          return;
        }
        expect(engine.firefox.path).toBe(binary); // preserve the finder-selected lowercase launcher vs uppercase body, never substitute
        const id = await createProfile("firefox", "Firefox BiDi"); await card(id).locator('[data-action="launch"]').click();
        const target = await attach(id, "firefox");
        expect(regularBytes(owned, path.join(userData, "logs", `browser-${id}.log`)).toString("utf8")).toContain(`Launching ${binary}`);
        await nativePage(target, "native");
        const read = await firefox(target, "click"); expect(read).toMatchObject({ mode: "native", rtc: "function", nativeRtc: "function" }); expect(read.clicks).toBeGreaterThan(0); expect(read.userAgent).toContain("Firefox/");
        await screenshot("07-real-firefox-bidi-page", "Actual headful managed Firefox viewport, native pointer click and native page identity via its registered BiDi session", h!.page, Buffer.from(await firefox(target, "screenshot"), "base64"));
        await h!.page.bringToFront(); await menu(id, "env");
        await until("Firefox native runtime env rendered", async () => (await h!.page.locator("#env-risk-body [data-health-outcome]").count()) > 0, 30_000);
        const env = await diagnosticReadback(id, "env");
        expect(await h!.page.locator("#env-risk-body").innerText()).toMatch(/rAF:.*[1-9][0-9]* samples/i);
        await closeDialog("env");
        const measured = await api("browser", "envRisk", id, { requestId: "health-firefox-native-bidi-env" });
        expect(measured.result.raf.samples).toBeGreaterThan(0); expect(measured.result.measurements.raf).toBe("complete");
        expect(raw(id, "env").at(-1)).toMatchObject({ requestId: measured.requestId, outcome: measured.outcome, source: "runtime", findings: measured.result.findings });
        await nativePage(target, "failure"); await h!.page.bringToFront(); await menu(id, "webrtc");
        await until("actual Firefox constructor failure committed", () => raw(id, "webrtc").at(-1)?.outcome === "error");
        const rtc = await diagnosticReadback(id, "webrtc", "error"); expect(rtc.raw.error).toContain(RTC_ERROR); expect(rtc.raw.success).toBe(false);
        await screenshot("08-firefox-rtc-failure-history", "Real Firefox/BiDi negative fixture failure and saved/replayed error, not fake BiDi or native RTC health success");
        receipt!.observations.firefox = { status: "observed", binary, finderPath: engine.firefox.path, version: engine.firefox.version, managedInjection: engine.firefox.managedInjection, id, pid: target.pid, nativeRead: read, env, nativeRaf: measured.result.raf, rtc };
        await closeDialog("webrtc"); await stop(id);
      });
      expect(h.pageErrors).toEqual([]); expect(h.consoleErrors.filter(error => /unhandled|uncaught/i.test(error))).toEqual([]); expect(unhandled).toEqual([]);
      expect(fixture.failures).toEqual([]); expect(artifactIdentity()).toEqual(frozen);
      receipt.observations.blockedCases = [...blocked];
      receipt.status = blocked.length ? "partial-blocked-awaiting-visual-review" : "passed-awaiting-visual-review";
      receipt.phase = "All runnable assertions completed; named blocked cases and coordinator PNG review remain";
    } catch (error) {
      receipt.status = /\bBLOCKED:/.test(String(error)) ? "blocked" : "failed";
      receipt.error = String(error).slice(0, 6000);
      if (h && !h.page.isClosed() && receipt.screenshots.length < 8) {
        try { await screenshot("failure-current-owned-app", "Failure-state screenshot of this exclusively owned Electron window"); }
        catch (captureError) { receipt.cleanup.push("Failure capture unavailable: " + String(captureError).slice(0, 300)); }
      }
      if (receipt.phase.includes("baseline")) {
        // Observe the same native page after failure; no API/value is replaced,
        // no second capture runs, and making it visible never changes this FAIL.
        const target = [...live.values()].find(item => item.engine === "chromium" && item.page && !item.page.isClosed());
        if (target?.page) {
          const readState = () => target.page!.evaluate(() => ({ url: location.href, visibilityState: document.visibilityState,
            focused: document.hasFocus(), secureContext: isSecureContext, readyState: document.readyState,
            localFontAccess: typeof (globalThis as any).queryLocalFonts, mediaDevices: typeof navigator.mediaDevices?.enumerateDevices }));
          try {
            const before = await deadline("Native page still responds after capture timeout", readState(), 3_000);
            const stagesBefore = [...(receipt.observations.nativeCaptureStages || [])];
            await target.page.bringToFront(); await pause(2_000);
            receipt.observations.captureFailure = { id: target.id, before, afterForeground: await deadline("Native foreground read", readState(), 3_000),
              stagesBefore, stagesAfterForeground: [...(receipt.observations.nativeCaptureStages || [])],
              canonical: canonical(target.id), qualification: "Existing native corpus stage logs only; window visibility is observed, not assumed; foregrounding does not turn the failed acceptance into a pass" };
          } catch (diagnosticError) { receipt.observations.captureFailure = { id: target.id, error: String(diagnosticError).slice(0, 1000) }; }
        }
      }
      throw error;
    }
  }, 480_000);

  afterAll(async () => {
    cleaningUp = true;
    if (budgetTimer) clearInterval(budgetTimer);
    const errors: string[] = [];
    // Release only our page gates first. Never use expect.poll from a hook.
    try { fixture?.releaseAll(); } catch (error) { errors.push("Owned page gate release: " + String(error)); }
    if (h) {
      for (const id of ids) { try { await stop(id); } catch (error) { errors.push(`Normal owned browser stop ${id}: ${String(error)}`); } }
      const pid = h.app.process().pid;
      try { await deadline("Normal Electron close", h.app.close(), 12_000); if (pid) await until("owned Electron PID exited", () => pidExited(pid), 8_000); }
      catch (error) { errors.push("Normal Electron close: " + String(error)); }
      if (h.pageErrors.length || unhandled.length || h.consoleErrors.some(error => /unhandled|uncaught/i.test(error))) errors.push("Unhandled actual app/renderer errors were observed");
    }
    // A setup failure can leave an owned app without a returned Playwright
    // handle. Do NOT pkill a browser name or call the helper's force-kill-first
    // closeApp. The approved runner/coordinator handles any residual process.
    if (userData) { try { const remaining = ownedPids(userData); if (remaining.length) errors.push("Owned residual PIDs (not signalled): " + remaining.join(",")); } catch (error) { errors.push(String(error)); } }
    if (fixture) {
      if (receipt) receipt.observations.localFixture = fixture.stats();
      try { await fixture.close(); if (fixture.failures.length) errors.push(...fixture.failures); } catch (error) { errors.push("Owned fixture close: " + String(error)); }
    }
    if (receipt && owned) {
      receipt.finishedAt = new Date().toISOString(); receipt.cleanup.push(...errors); receipt.observations.unhandled = unhandled; receipt.observations.blockedCases = [...blocked];
      if (budgetFailure) { receipt.cleanup.push(String(budgetFailure)); errors.push(String(budgetFailure)); }
      if (errors.length) receipt.status = "cleanup-failed";
      // Delete only the mkdtemp userData created above, AFTER PID exit. Never
      // erase the supplied parent, other acceptance runs, browser installations,
      // repo/cache trees or evidence. Keep <=8 PNGs and one <=128 KiB receipt.
      if (!errors.length && userData) { inside(owned, userData); realDirectory(userData); fs.rmSync(userData, { recursive: true, force: false }); receipt.cleanup.push("Only this test's owned bulky userData/HOME removed after browser and Electron PID exit"); }
      const json = JSON.stringify(receipt, null, 2) + "\n";
      if (Buffer.byteLength(json) > 128 * 1024) throw new Error("Health acceptance receipt exceeds 128 KiB");
      const file = path.join(owned, "receipt.json"); fs.writeFileSync(file, json, { flag: "wx" });
      expect(sha256(regularBytes(owned, file, 128 * 1024))).toBe(sha256(json));
      console.log(`HEALTH_FUNCTIONAL_ACCEPTANCE_RECEIPT=${file}`);
      console.log(`HEALTH_FUNCTIONAL_ACCEPTANCE_STATUS=${receipt.status}; blockedCases=${blocked.length}; visualReview=required`);
      storageBudget();
    }
    if (errors.length) throw new Error(errors.join("\n"));
  }, 90_000);
});
