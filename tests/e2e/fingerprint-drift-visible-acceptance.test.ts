// Coordinator-only, single visible run against the already-frozen source09/dist.
// Collection is inert. No build, download, installed-App attachment, desktop capture,
// permission request, license injection, transport replacement, or forced teardown.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type JSHandle } from "playwright";
import { setupTestApp, type TestAppHandle } from "./helpers/app.js";
import { localHealthFixture, existingNativeBinary, realDirectory, pidExited } from "./helpers/health-fixture.js";
import { DARWIN_ARGV_READER, NATIVE_ARGV_LIMITATIONS } from "./helpers/native-argv.js";
import type { FingerprintComparisonReport } from "../../src/main/services/fingerprint-drift-reports.js";

type Step = { name: string; at: string; evidence?: unknown };
type Child = { pid: number; port: number; version: string | null; argvSha256: string;
  exited: boolean; exitCode: number | null; signalCode: string | null; exitWitness: unknown };
type Runtime = { roots: Child[]; held: Child[] };
type Receipt = { schema: string; status: string; phase: string; startedAt: string; finishedAt?: string;
  steps: Step[]; screenshots: unknown[]; cleanup: unknown[]; limitations: readonly string[]; error?: unknown };
const R = path.resolve(__dirname, "../..");
const E = "/Volumes/DevProjectsSSD-74bf68f9/Temp/roxy-lite-cloak-oss/2026-10-19/durability-history-fix-er323v1s";
const SOURCE09 = "6deb008a82ec339edb375f4c5d8a46625ae5101c25aaac6894b8a027b5affa15";
const REFRESH_SHA = "3a20abf5b69a325f7e8cb90550da2305b5b80b85314e0db20f68b4415b51187d";
const MiB = 1024 ** 2, GiB = 1024 ** 3;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const LIMITATIONS = [
  "PNG evidence is owned renderer-window content: not-desktop/not-native-chrome; it proves neither physical display pixels nor absence of occlusion. It does not complete pixel tasks #5/#23.",
  "CG evidence queries exactly the controller's media-source windowID; AX reads only that controller PID. No desktop capture or TCC prompt is used.",
  "Firefox is explicitly unavailable; product may stat public /Applications/Firefox.app executable/XUL metadata, but the explicit invalid owned package must not fall back or execute it.",
  "Exactly one owned controller and at most one managed native root concurrently; helper processes and selected-binary version probes are not represented as a fixed total process count.",
  "Confirmation-token bytes stay private inside the real renderer/main exchange. Nested confirmation and same-report acceptedAt witness source09's preview/token/commit path, not independent token extraction.",
  "Normal Stop and actual ChildProcess exit are verified separately. No driver-forced native signals, orphan sweeps, installed-App debugging or health/RTC/external-risk checks are performed.",
  "The transient drift-gated session is tied to the held native child and source09's real native comparison; no post-exit or redundant CDP connection is required to race the product's intentional stop.",
  ...NATIVE_ARGV_LIMITATIONS,
] as const;

function requireThat(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
function childPath(root: string, target: string): void {
  const rel = path.relative(root, target);
  requireThat(rel && !rel.startsWith("..") && !path.isAbsolute(rel), "NOT_AN_OWNED_CHILD");
}
function bytes(root: string, file: string, limit = 4 * MiB): Buffer {
  childPath(root, file); realDirectory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    requireThat(before.isFile() && before.nlink === 1 && before.size <= limit, "UNSAFE_OR_OVERSIZE_INPUT");
    const result = fs.readFileSync(fd), after = fs.fstatSync(fd), final = fs.lstatSync(file);
    requireThat(result.length === before.size && before.dev === after.dev && before.ino === after.ino &&
      before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs &&
      final.dev === after.dev && final.ino === after.ino && !final.isSymbolicLink(), "INPUT_CHANGED_WHILE_READING");
    return result;
  } finally { fs.closeSync(fd); }
}
function allocation(root: string): { allocated: number; free: number; entries: number } {
  realDirectory(root);
  const dev = fs.lstatSync(root).dev;
  let allocated = 0, entries = 0;
  const visit = (directory: string): void => {
    let names: string[];
    try { names = fs.readdirSync(directory); }
    catch (error: any) { if (error.code === "ENOENT" && directory !== root) return; throw error; }
    for (const name of names) {
      requireThat(++entries <= 100_000, "BOUNDED_INVENTORY_EXCEEDED");
      const file = path.join(directory, name);
      let st: fs.Stats;
      try { st = fs.lstatSync(file); }
      catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
      requireThat(st.dev === dev, "MEASURED_VOLUME_CHANGED");
      if (st.isSymbolicLink()) continue; // Browser lock symlinks are never followed.
      allocated += Number(st.blocks || 0) * 512;
      if (st.isDirectory()) visit(file);
    }
  };
  visit(root);
  const volume = fs.statfsSync(root);
  return { allocated, free: volume.bavail * volume.bsize, entries };
}

// Public CoreGraphics/Accessibility metadata only, exact window/PID, no titles,
// no enumeration of other apps, no AXIsProcessTrustedWithOptions or capture API.
const OWN_WINDOW_READER = String.raw`
import ctypes as C,json,sys
pid,wid=map(int,sys.argv[1:])
assert pid>0 and wid>0
cf=C.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
cg=C.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
ax=C.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
P=C.c_void_p
cf.CFRelease.argtypes=[P]
cf.CFStringCreateWithCString.argtypes=[P,C.c_char_p,C.c_uint32];cf.CFStringCreateWithCString.restype=P
cf.CFDictionaryGetValue.argtypes=[P,P];cf.CFDictionaryGetValue.restype=P
cf.CFArrayGetCount.argtypes=[P];cf.CFArrayGetCount.restype=C.c_long
cf.CFArrayGetValueAtIndex.argtypes=[P,C.c_long];cf.CFArrayGetValueAtIndex.restype=P
cf.CFNumberGetValue.argtypes=[P,C.c_int,P];cf.CFNumberGetValue.restype=C.c_bool
cf.CFBooleanGetValue.argtypes=[P];cf.CFBooleanGetValue.restype=C.c_bool
cg.CGWindowListCopyWindowInfo.argtypes=[C.c_uint32,C.c_uint32];cg.CGWindowListCopyWindowInfo.restype=P
ax.AXIsProcessTrusted.restype=C.c_bool
ax.AXUIElementCreateApplication.argtypes=[C.c_int];ax.AXUIElementCreateApplication.restype=P
ax.AXUIElementCopyAttributeValue.argtypes=[P,P,C.POINTER(P)];ax.AXUIElementCopyAttributeValue.restype=C.c_int
ax.AXValueGetValue.argtypes=[P,C.c_int,P];ax.AXValueGetValue.restype=C.c_bool
class Point(C.Structure): _fields_=[('x',C.c_double),('y',C.c_double)]
class Size(C.Structure): _fields_=[('width',C.c_double),('height',C.c_double)]
class Rect(C.Structure): _fields_=[('origin',Point),('size',Size)]
cg.CGRectMakeWithDictionaryRepresentation.argtypes=[P,C.POINTER(Rect)];cg.CGRectMakeWithDictionaryRepresentation.restype=C.c_bool
def key(s):
    p=cf.CFStringCreateWithCString(None,s.encode(),0x08000100)
    assert p
    return p
def field(d,s):
    k=key(s)
    try: return cf.CFDictionaryGetValue(d,k)
    finally: cf.CFRelease(k)
def number(p):
    assert p
    n=C.c_longlong();assert cf.CFNumberGetValue(p,4,C.byref(n))
    return n.value
def boolean(p):
    assert p
    return bool(cf.CFBooleanGetValue(p))
def attribute(el,s):
    k=key(s);v=P()
    try: assert ax.AXUIElementCopyAttributeValue(el,k,C.byref(v))==0 and v.value
    finally: cf.CFRelease(k)
    return v
lst=cg.CGWindowListCopyWindowInfo(8,wid) # kCGWindowListOptionIncludingWindow ONLY.
assert lst and cf.CFArrayGetCount(lst)==1
try:
    d=cf.CFArrayGetValueAtIndex(lst,0)
    owner=number(field(d,'kCGWindowOwnerPID'));ident=number(field(d,'kCGWindowNumber'))
    layer=number(field(d,'kCGWindowLayer'));onscreen=boolean(field(d,'kCGWindowIsOnscreen'))
    rect=Rect();assert cg.CGRectMakeWithDictionaryRepresentation(field(d,'kCGWindowBounds'),C.byref(rect))
finally: cf.CFRelease(lst)
assert owner==pid and ident==wid
assert ax.AXIsProcessTrusted() # Read existing permission; never request it.
app=ax.AXUIElementCreateApplication(pid);assert app
front=focus=mini=None
try:
    p=attribute(app,'AXFrontmost')
    try: front=boolean(p)
    finally: cf.CFRelease(p)
    win=attribute(app,'AXFocusedWindow')
    try:
        p=attribute(win,'AXMinimized')
        try: mini=boolean(p)
        finally: cf.CFRelease(p)
        pos=Point();size=Size()
        p=attribute(win,'AXPosition')
        try: assert ax.AXValueGetValue(p,1,C.byref(pos))
        finally: cf.CFRelease(p)
        p=attribute(win,'AXSize')
        try: assert ax.AXValueGetValue(p,2,C.byref(size))
        finally: cf.CFRelease(p)
        # AXFocusedWindow is the focus witness; bind it to this exact CG window by frame.
        focus=(abs(pos.x-rect.origin.x)<1 and abs(pos.y-rect.origin.y)<1 and
               abs(size.width-rect.size.width)<1 and abs(size.height-rect.size.height)<1)
    finally: cf.CFRelease(win)
finally: cf.CFRelease(app)
print(json.dumps({'pid':owner,'windowID':ident,'onscreen':onscreen,'layer':layer,
 'rect':{'x':rect.origin.x,'y':rect.origin.y,'width':rect.size.width,'height':rect.size.height},
 'axTrusted':True,'appActive':front,'focusedWindow':focus,'minimized':mini}))
`;

describe.skipIf(process.env.ABS_FP_DRIFT_VISIBLE_ACCEPTANCE !== "1")("owned visible fingerprint drift acceptance", () => {
  it("reviews real restarted drift, explicitly updates its reference, starts and rechecks via visible UI", async () => {
    const started = Date.now(), workEnd = started + 420_000, cleanupEnd = started + 485_000;
    let root = "", userData = "", abortFile = "", python = "", binary = "", id = "", phase = "admission";
    let h: TestAppHandle | undefined, observer: JSHandle<any> | undefined;
    let fixture: Awaited<ReturnType<typeof localHealthFixture>> | undefined;
    let cleaning = false, outputAdmitted = false, controllerAttempted = false, failure: unknown, pngBytes = 0;
    let controllerExit: { code: number | null; signal: string | null } | undefined;
    const connections: Browser[] = [], pending = new Set<Promise<unknown>>();
    const receipt: Receipt = { schema: "fp-drift-visible/v1", status: "failed", phase,
      startedAt: new Date(started).toISOString(), steps: [], screenshots: [], cleanup: [], limitations: LIMITATIONS };
    const record = (name: string, evidence?: unknown) => receipt.steps.push({ name, at: new Date().toISOString(), evidence });
    function signalCheck(): void {
      if (cleaning) { requireThat(Date.now() < cleanupEnd, "CLEANUP_DEADLINE"); return; }
      requireThat(Date.now() < workEnd, "WORK_DEADLINE");
      requireThat(!abortFile || !fs.lstatSync(abortFile, { throwIfNoEntry: false }), "PARENT_ABORT_SIGNAL");
    }
    async function call<T>(label: string, fn: () => Promise<T>, ms = 15_000): Promise<T> {
      signalCheck();
      const original = Promise.resolve().then(fn); pending.add(original);
      original.then(() => pending.delete(original), () => pending.delete(original));
      let timer: ReturnType<typeof setInterval> | undefined;
      const expires = Math.min(Date.now() + ms, cleaning ? cleanupEnd : workEnd);
      try {
        const result = await Promise.race([original, new Promise<never>((_resolve, reject) => {
          timer = setInterval(() => {
            try { signalCheck(); requireThat(Date.now() < expires, "AWAIT_DEADLINE:" + label); }
            catch (error) { reject(error); }
          }, 100);
        })]);
        signalCheck(); return result;
      } finally { if (timer) clearInterval(timer); }
    }
    async function wait(label: string, condition: () => Promise<boolean> | boolean, ms = 25_000): Promise<void> {
      const end = Math.min(Date.now() + ms, cleaning ? cleanupEnd : workEnd);
      while (Date.now() < end) {
        signalCheck(); if (await condition()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("CONDITION_DEADLINE:" + label);
    }
    function budget(): void {
      signalCheck();
      const st = fs.lstatSync(E);
      requireThat(st.dev === 16777255 && st.ino === 2885282 && st.uid === 501 && !st.isSymbolicLink(), "E_ROOT_IDENTITY_CHANGED");
      const total = allocation(E), own = root ? allocation(root).allocated : 0;
      requireThat(total.allocated <= 2 * GiB && total.free >= 10 * GiB && own <= 256 * MiB, "STORAGE_BUDGET_EXCEEDED");
    }
    async function stage(name: string): Promise<void> { phase = name; receipt.phase = name; budget(); record(name); }
    const api = (group: string, method: string, ...args: any[]) => call(group + "." + method, () => h!.page.evaluate(async input => {
      const bridge = (window as any).agentBrowserAPI;
      if (typeof bridge?.[input.group]?.[input.method] !== "function") throw new Error("MISSING_ORIGINAL_PRELOAD");
      return bridge[input.group][input.method](...input.args);
    }, { group, method, args }));
    const card = () => h!.page.locator(`#profile-list .profile-card[data-dir-id="${id}"]`);
    const config = () => JSON.parse(bytes(root, path.join(userData, "config.json")).toString("utf8"));
    const baseline = () => config().browserProfiles?.[id]?.fingerprintBaseline;
    const baselineSha = () => sha(JSON.stringify(baseline()));
    const readReport = (): FingerprintComparisonReport => {
      const store = JSON.parse(bytes(root, path.join(userData, "fingerprint-comparisons.json")).toString("utf8"));
      requireThat(store.schemaVersion === 1 && Array.isArray(store.reports), "REPORT_STORE_SHAPE");
      const reports = store.reports.filter((entry: any) => entry.report?.dirId === id);
      requireThat(reports.length === 1, "EXPECTED_ONE_OWNED_REPORT"); return reports[0].report;
    };
    const runtime = () => call("held-runtime-observation", () => observer!.evaluate((state: any) => state.snapshot())) as Promise<Runtime>;
    async function idle(): Promise<boolean> {
      return call("original-renderer-idle", () => h!.page.evaluate(() => {
        const app = (window as any).agentBrowser;
        return app.ipc._inflightCount() === 0 && !document.querySelector('[aria-busy="true"]') &&
          !document.querySelector('.profile-card[data-busy="true"]');
      }));
    }
    async function visible(name: string, screenshot = false): Promise<void> {
      await call("owned-controller-focus", () => h!.app.evaluate(({ app, BrowserWindow }, url) => {
        const wins = BrowserWindow.getAllWindows().filter(w => w.webContents.getURL() === url);
        if (wins.length !== 1) throw new Error("CONTROLLER_WINDOW_AMBIGUOUS");
        if (!wins[0].isVisible() || wins[0].isMinimized()) throw new Error("ALREADY_VISIBLE_CONTROLLER_REQUIRED");
        // Activate only this already-visible owned window, as a normal UI interaction.
        app.focus({ steal: true }); wins[0].focus();
      }, h!.page.url()));
      await call("owned-page-front", () => h!.page.bringToFront());
      const win = await call("bound-browser-window", () => h!.app.browserWindow(h!.page));
      const electron = await call("window-state", () => win.evaluate(w => ({ id: w.id, visible: w.isVisible(), minimized: w.isMinimized(),
        focused: w.isFocused(), rendererPID: w.webContents.getOSProcessId(), url: w.webContents.getURL(), media: w.getMediaSourceId() })));
      requireThat(electron.url === h!.page.url() && electron.visible && !electron.minimized && electron.focused && electron.rendererPID > 0, "ELECTRON_NOT_VISIBLE_FOCUSED");
      const windowID = /^window:(\d+):\d+$/.exec(electron.media)?.[1];
      requireThat(windowID, "NO_EXACT_OWNED_WINDOW_ID");
      let os: any;
      try {
        os = JSON.parse(execFileSync(python, ["-I", "-S", "-B", "-c", OWN_WINDOW_READER, String(h!.app.process().pid), windowID],
          { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024, env: { PATH: path.dirname(python), LC_ALL: "C" }, stdio: "pipe" }));
      } catch (error) {
        record("OS-visibility-proof-unavailable", { stage: name, errorSha256: sha(String(error)) });
        throw new Error("EXACT_WINDOW_CG_AX_PROOF_UNAVAILABLE");
      }
      requireThat(os.pid === h!.app.process().pid && os.windowID === Number(windowID) && os.onscreen === true && os.layer === 0 &&
        os.axTrusted === true && os.appActive === true && os.focusedWindow === true && os.minimized === false &&
        os.rect.width > 0 && os.rect.height > 0, "OS_WINDOW_NOT_FRONTMOST_VISIBLE");
      record("visible-" + name, { controllerPID: h!.app.process().pid, windowID: Number(windowID),
        browserWindowID: electron.id, rendererPID: electron.rendererPID, electron: { visible: electron.visible, minimized: electron.minimized, focused: electron.focused }, os });
      if (screenshot) {
        requireThat(receipt.screenshots.length < 4, "PNG_COUNT_LIMIT");
        const png = await call("owned-renderer-PNG", () => h!.page.screenshot({ fullPage: false, animations: "disabled", timeout: 8_000 }));
        requireThat(png.length <= 2 * MiB && pngBytes + png.length <= 8 * MiB, "PNG_BYTE_LIMIT");
        const file = path.join(root, name + ".png");
        fs.writeFileSync(file, png, { flag: "wx", mode: 0o600 });
        requireThat(bytes(root, file, 2 * MiB).equals(png), "PNG_READBACK_MISMATCH"); pngBytes += png.length;
        receipt.screenshots.push({ file, bytes: png.length, sha256: sha(png), scope: "owned-controller-renderer/not-desktop/not-native-chrome" });
      }
      await win.dispose(); signalCheck();
    }
    function reportEvidence(report: FingerprintComparisonReport): unknown {
      return { id: report.id, dirId: report.dirId, source: report.source, observedAt: report.observedAt, acceptedAt: report.acceptedAt,
        counts: report.counts, risky: report.risky, partial: report.partial, comparedFields: report.comparedFields,
        changes: report.changes.map(change => ({ field: change.field, category: change.category, severity: change.severity, reason: change.reason,
          beforeType: typeof change.baseline, afterType: typeof change.current,
          beforeSha256: sha(JSON.stringify(change.baseline ?? null)), afterSha256: sha(JSON.stringify(change.current ?? null)),
          ...(change.field === "timezone" ? { before: change.baseline, after: change.current } : {}) })),
        configDiskSha256: sha(bytes(root, path.join(userData, "config.json"))),
        reportDiskSha256: sha(bytes(root, path.join(userData, "fingerprint-comparisons.json"))) };
    }
    async function observeNative(child: Child, timezone: string): Promise<void> {
      const expected = { pid: child.pid, executablePath: binary, argv0: binary, profileDir: path.join(userData, "profiles", id), port: child.port };
      const raw = execFileSync(python, ["-I", "-S", "-B", "-c", DARWIN_ARGV_READER, "observe"],
        { input: JSON.stringify(expected), encoding: "utf8", timeout: 5_000, maxBuffer: 512 * 1024,
          env: { PATH: path.dirname(python), LC_ALL: "C" }, stdio: "pipe" });
      const observed = JSON.parse(raw);
      requireThat(observed.pid === child.pid && observed.executablePath === binary && Array.isArray(observed.args) &&
        !observed.args.some((arg: string) => /^--(?:headless|no-sandbox|disable-gpu-sandbox)(?:=|$)/.test(arg)), "NATIVE_ARGV_IDENTITY_OR_HEADFUL_FAILED");
      requireThat(observed.args.includes("--use-mock-keychain"), "NORMAL_MOCK_KEYCHAIN_MISSING");
      await wait("owned-native-CDP-ready", async () => {
        requireThat(!pidExited(child.pid), "OWNED_NATIVE_EXITED_BEFORE_PAGE_OBSERVATION");
        try {
          const response = await call("owned-CDP-ready-metadata", () => fetch(`http://127.0.0.1:${child.port}/json/version`,
            { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(750) }), 1_000);
          const text = await response.text();
          requireThat(text.length <= 64 * 1024, "CDP_READY_REPLY_TOO_LARGE");
          return response.status === 200 && typeof JSON.parse(text).webSocketDebuggerUrl === "string";
        } catch (error: any) {
          signalCheck();
          if (["ECONNREFUSED", "ECONNRESET"].includes(error.cause?.code) || ["TimeoutError", "AbortError"].includes(error.name)) return false;
          throw error;
        }
      }, 15_000);
      const browser = await call("owned-native-CDP", () => chromium.connectOverCDP(`http://127.0.0.1:${child.port}`, { timeout: 15_000 }));
      connections.push(browser);
      const cdp = await call("owned-browser-session", () => browser.newBrowserCDPSession());
      const info: any = await call("owned-CDP-process-identity", () => cdp.send("SystemInfo.getProcessInfo"));
      requireThat(info.processInfo.filter((p: any) => p.type === "browser").length === 1 &&
        info.processInfo.some((p: any) => p.type === "browser" && p.id === child.pid), "CDP_PID_MISMATCH");
      await wait("owned-native-fixture-navigation", () => browser.contexts().flatMap(context => context.pages())
        .some(page => page.url() === fixture!.origin + "/native"), 10_000);
      const native = browser.contexts().flatMap(context => context.pages()).find(page => page.url() === fixture!.origin + "/native");
      requireThat(native, "OWNED_NATIVE_FIXTURE_NOT_LOADED");
      await call("native-fixture-load", () => native.waitForLoadState("load", { timeout: 10_000 }));
      const identity = await call("native-fixture-identity", () => native.evaluate(() => ({ url: location.href,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language,
        mode: document.getElementById("fixture-mode")?.textContent, fault: document.documentElement.dataset.rtcFault,
        headlessUA: /HeadlessChrome/.test(navigator.userAgent), visibility: document.visibilityState })));
      expect(identity).toMatchObject({ url: fixture!.origin + "/native", timezone, language: "en-US", mode: "native", fault: "none", headlessUA: false });
      record("native-runtime", { pid: child.pid, port: child.port, selectedVersion: child.version, identity,
        argvSha256: sha(JSON.stringify(observed.args)), witness: observed.ownershipWitness,
        versionProbe: { source: "product-selected-binary version probe", selectedVersion: child.version, processCount: "not independently enumerated" } });
      await call("detach-readonly-CDP-session", () => cdp.detach());
    }
    async function stopped(child: Child): Promise<void> {
      await wait("held-child-actual-exit-and-runtime-empty", async () => {
        const state = await runtime(), held = state.held.find(c => c.pid === child.pid);
        return state.roots.length === 0 && !!held?.exited && held.exitWitness !== null && pidExited(child.pid);
      }, cleaning ? 25_000 : 35_000);
      const held = (await runtime()).held.find(c => c.pid === child.pid)!;
      requireThat(held.signalCode !== "SIGKILL", "FORCED_NATIVE_EXIT_NOT_ACCEPTED");
      record("actual-native-exit", held);
    }
    async function stopUI(child: Child): Promise<void> {
      if (await h!.page.locator("#dlg-fingerprint-drift").isVisible()) {
        await call("close-owned-drift-view", () => h!.page.locator("#fingerprint-drift-close").click({ timeout: 5_000 }));
      }
      await visible("stop");
      await call("normal-UI-Stop", () => card().locator('[data-action="stop"]').click({ timeout: 8_000 }));
      await stopped(child); await wait("Stop settled", idle);
    }
    try {
      requireThat(process.platform === "darwin" && process.getuid?.() === 501, "MACOS_OWN_UID_REQUIRED");
      requireThat(!["AGENT_BROWSER_E2E_UNSANDBOXED", "AGENT_BROWSER_E2E_TRACE", "CLOAK_E2E_TRACE"].some(key => process.env[key] === "1"), "FORBIDDEN_TRACE_OR_SANDBOX_OVERRIDE");
      requireThat(process.env.ABS_FP_DRIFT_VISIBLE_BUDGET_ROOT === E, "EXACT_E_BUDGET_ROOT_REQUIRED");
      const supplied = process.env.ABS_FP_DRIFT_VISIBLE_ACCEPTANCE_ROOT;
      requireThat(supplied && path.isAbsolute(supplied), "FRESH_SUPPLIED_EVIDENCE_ROOT_REQUIRED");
      root = realDirectory(supplied); childPath(realDirectory(E), root);
      requireThat(fs.readdirSync(root).length === 0 && fs.lstatSync(root).uid === 501, "EVIDENCE_ROOT_NOT_FRESH_OWNED");
      abortFile = process.env.ABS_FP_DRIFT_VISIBLE_ABORT_FILE || "";
      requireThat(path.isAbsolute(abortFile), "PARENT_ABORT_FILE_REQUIRED"); childPath(E, abortFile);
      const abortParent = realDirectory(path.dirname(abortFile));
      requireThat(abortParent === root || abortParent === path.dirname(root), "ABORT_SIGNAL_NOT_IN_OWNED_RUN");
      python = process.env.ABS_FP_VISIBLE_PYTHON || "";
      requireThat(path.isAbsolute(python) && fs.statSync(python).isFile(), "EXPLICIT_PYTHON_REQUIRED");
      binary = existingNativeBinary(process.env.AGENT_BROWSER_CHROMIUM_BINARY_PATH, "chromium");
      budget(); outputAdmitted = true;
      const refreshFile = path.join(E, "controller-refresh-09.json"), refreshRaw = bytes(E, refreshFile);
      requireThat(sha(refreshRaw) === REFRESH_SHA, "SOURCE09_REFRESH_RECEIPT_MISMATCH");
      const frozen = JSON.parse(refreshRaw.toString("utf8"));
      requireThat(frozen.status === "passed" && frozen.sourceIdentity === SOURCE09 && frozen.compilerExit === 0, "SOURCE09_NOT_FROZEN");
      const checkCompiled = () => {
        const entries = [...Object.entries(frozen.compiledAndCopied).map(([name, hash]) => [path.join(R, "dist", name), hash]),
          ...Object.entries(frozen.protectedInputs).map(([name, hash]) => [path.join(R, "dist", name), hash])];
        requireThat(entries.length === 414, "SOURCE09_OUTPUT_COUNT");
        for (const [file, hash] of entries) requireThat(sha(bytes(R, String(file), 16 * MiB)) === hash, "FROZEN_COMPILED_INPUT_CHANGED");
      };
      checkCompiled();
      const harnessSha = sha(bytes(R, path.join(R, "tests/e2e/fingerprint-drift-visible-acceptance.test.ts")));
      record("frozen-inputs", { source09: SOURCE09, refreshFile, refreshSha256: REFRESH_SHA, compiledAndProtectedReadbacks: 414,
        harnessSha256: harnessSha, sourceFreezeAuthority: "parent wrapper recomputes source09 before/after; this harness verifies all 414 frozen outputs/protected inputs" });
      userData = path.join(root, "fresh-user-data");
      requireThat(!fs.lstatSync(userData, { throwIfNoEntry: false }), "USERDATA_ALREADY_EXISTS");
      fixture = await call("local-native-only-fixture", localHealthFixture);
      await stage("fresh-visible-controller");
      controllerAttempted = true;
      h = await call("setup-real-headful-controller", async () => {
        const handle = await setupTestApp({ userDataDir: userData, resetUserData: false, keepInitialDialogs: true, args: [],
          timeoutMs: 30_000, env: { AGENT_BROWSER_CHROMIUM_BINARY_PATH: binary,
            AGENT_BROWSER_FIREFOX_BINARY_PATH: path.join(root, "unavailable-owned-firefox.app/Contents/MacOS/firefox") } });
        h = handle;
        handle.app.process().once("exit", (code, signal) => { controllerExit = { code, signal }; });
        return handle;
      }, 40_000);
      const controller = await call("owned-controller-identity", () => h!.app.evaluate(({ app }) => ({
        pid: process.pid, appPath: app.getAppPath(), userData: app.getPath("userData"),
        forbiddenArgs: process.argv.some(arg => /^--(?:headless|no-sandbox|disable-gpu-sandbox)(?:=|$)/.test(arg)),
      })));
      requireThat(controller.pid === h.app.process().pid && controller.appPath === R && controller.userData === userData &&
        controller.forbiddenArgs === false, "CONTROLLER_OWNERSHIP_OR_HEADFUL_FAILED"); record("owned-controller", controller);
      h.page.setDefaultTimeout(8_000);
      const terms = h.page.locator("#dlg-terms");
      await call("visible-terms", () => terms.waitFor({ state: "visible" }));
      await visible("terms");
      await call("terms-ack", () => h!.page.locator("#terms-ack").check());
      await call("terms-accept", () => h!.page.locator("#terms-accept-btn").click());
      const wizard = h.page.locator("#dlg-wizard");
      await call("visible-fresh-wizard", () => wizard.waitFor({ state: "visible" }));
      await call("normal-visible-wizard-skip", () => wizard.locator('[data-cmd="wizardSkip"]:visible:not([disabled])').click());
      await call("wizard-closed", () => wizard.waitFor({ state: "hidden" }));
      const trial = await call("natural-trial-projection", () => h!.page.evaluate(async () => {
        const status = await (window as any).agentBrowserAPI.license.status();
        return { plan: status.plan, expired: status.expired, trialStartedAt: status.trialStartedAt };
      }));
      expect(trial.plan).toBe("trial"); expect(trial.expired).toBe(false); record("natural-fresh-trial", trial);
      const proxy = "owned-fp-drift-loopback-deny";
      requireThat((await api("proxy", "add", proxy, { type: "http", host: "127.0.0.1", port: fixture.port })).success === true, "PROXY_CREATE_FAILED");
      const created = await api("browser", "create", { name: "Owned visible fingerprint drift", engine: "chromium", fingerprintMode: "managed",
        platform: "macos", timezone: "Asia/Tokyo", locale: "en-US", proxyMode: "named", proxyName: proxy,
        appUrl: fixture.origin + "/native", tags: ["owned-visible-acceptance"] });
      requireThat(/^ab_[A-Za-z0-9_-]+$/.test(created.dirId), "SYNTHETIC_PROFILE_CREATE_FAILED"); id = created.dirId;
      const saved = config();
      expect(Object.keys(saved.browserProfiles)).toEqual([id]);
      expect(saved.browserProfiles[id]).toMatchObject({ fingerprintMode: "managed", platform: "macos", timezone: "Asia/Tokyo", locale: "en-US", proxyMode: "named", proxyName: proxy });
      requireThat(saved.blockOnFingerprintDrift !== false && !baseline(), "FRESH_BASELINE_OR_NORMAL_GATE_INVALID");
      const readback = (await api("browser", "list")).filter((p: any) => p.dirId === id);
      requireThat(readback.length === 1 && readback[0].timezone === "Asia/Tokyo", "PROFILE_READBACK_SEARCH_FAILED");
      expect((await api("proxy", "get", proxy)).port).toBe(fixture.port);
      await call("render-real-profile-list", () => h!.page.evaluate(() => (window as any).agentBrowser.loadProfiles()));
      await call("owned-profile-card", () => card().waitFor({ state: "visible" }));
      observer = await call("hold-original-native-children", () => h!.app.evaluateHandle(async (_electron, input) => {
        const vm = process.getBuiltinModule("node:vm");
        const table = await vm.runInThisContext(`import(${JSON.stringify(input.module)})`, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
        const crypto = process.getBuiltinModule("node:crypto");
        const held: any[] = [];
        return { snapshot() {
          if (table.runningProcesses.size > 1) throw new Error("MORE_THAN_ONE_NATIVE_ROOT");
          const roots: any[] = [];
          for (const [profile, entry] of table.runningProcesses) {
            const child = entry.process;
            if (profile !== input.id || child?.pid !== entry.pid || child.spawnfile !== input.binary ||
                !child.spawnargs?.includes("--user-data-dir=" + input.profileDir) ||
                !child.spawnargs?.includes("--remote-debugging-port=" + entry.port)) throw new Error("UNPROVEN_RUNTIME_OWNERSHIP");
            let row = held.find(row => row.child === child);
            if (!row) {
              if (held.some(row => row.child.exitCode === null && row.child.signalCode === null)) throw new Error("CONCURRENT_OWNED_NATIVE_ROOTS");
              row = { child, pid: entry.pid, port: entry.port, version: entry.browserVersion || null,
                argvSha256: crypto.createHash("sha256").update(JSON.stringify(child.spawnargs)).digest("hex"),
                exitWitness: child.exitCode !== null || child.signalCode !== null
                  ? { kind: "actual-terminal-fields", code: child.exitCode, signal: child.signalCode, observedAt: Date.now() } : null };
              held.push(row); child.once("exit", (code: number | null, signal: string | null) => {
                row.exitWitness = { kind: "actual-exit-event", code, signal, observedAt: Date.now() };
              });
            }
            roots.push(row);
          }
          const project = (row: any) => ({ pid: row.pid, port: row.port, version: row.version, argvSha256: row.argvSha256,
            exited: row.child.exitCode !== null || row.child.signalCode !== null, exitCode: row.child.exitCode, signalCode: row.child.signalCode, exitWitness: row.exitWitness });
          return { roots: roots.map(project), held: held.map(project) };
        } };
      }, { module: pathToFileURL(path.join(R, "dist/main/services/browser/runtime-table.js")).href,
        id, binary, profileDir: path.join(userData, "profiles", id) }));
      await stage("UI-launch-Tokyo-and-live-baseline");
      await visible("initial-launch");
      await call("UI-Launch", () => card().locator('[data-action="launch"]').click());
      await wait("first-root-and-launch-settled", async () => (await runtime()).roots.length === 1 && await idle(), 65_000);
      const first = (await runtime()).roots[0]; await observeNative(first, "Asia/Tokyo");
      await visible("lock-baseline");
      await call("UI-health-lock", () => card().locator('select[data-action="health"]').selectOption("lock"));
      await wait("product-captured-Tokyo-baseline", async () => !!baseline() && await idle(), 40_000);
      expect(baseline().timezone).toBe("Asia/Tokyo");
      const oldBaselineSha = baselineSha();
      const locked = await api("browser", "driftReport", id);
      requireThat(locked.ok && locked.report?.source === "baseline", "REAL_BASELINE_REPORT_MISSING");
      record("baseline-disk-readback", { baselineSha256: oldBaselineSha, report: reportEvidence(readReport()) });
      await stopUI(first);
      await stage("UI-edit-timezone-and-restart-for-real-drift");
      await call("UI-Edit", () => card().locator('[data-action="edit"]').click());
      await call("edit-timezone-visible", () => h!.page.locator("#agent-browser-meta-timezone").waitFor({ state: "visible" }));
      await call("UI-select-Shanghai", () => h!.page.locator("#agent-browser-meta-timezone").selectOption("Asia/Shanghai"));
      await call("UI-Save", () => h!.page.locator('#dlg-agent-browser-seed form[data-submit-cmd="saveBrowserMeta"] button[type="submit"]').click());
      await wait("real-edit-persisted", async () => config().browserProfiles[id].timezone === "Asia/Shanghai" && await idle());
      expect(baselineSha()).toBe(oldBaselineSha);
      const changed = (await api("browser", "list")).filter((p: any) => p.dirId === id);
      requireThat(changed.length === 1 && changed[0].timezone === "Asia/Shanghai", "EDIT_READBACK_SEARCH_FAILED");
      await visible("drift-launch");
      await call("UI-restarted-Launch", () => card().locator('[data-action="launch"]').click());
      await wait("held-new-native-root", async () => (await runtime()).held.length === 2, 35_000);
      const driftChild = (await runtime()).held[1];
      requireThat(driftChild.pid !== first.pid && driftChild.port !== first.port, "RESTART_DID_NOT_CREATE_NEW_IDENTITY");
      // This ordinary gate intentionally closes the transient native session.
      // Verify its real native comparison and held-child exit instead of racing it with another CDP client.
      await call("automatic-drift-dialog", () => h!.page.locator("#dlg-fingerprint-drift").waitFor({ state: "visible", timeout: 60_000 }), 65_000);
      await stopped(driftChild);
      await wait("launch-and-view-settled", idle);
      await stage("review");
      const review = await api("browser", "driftReport", id), report = readReport();
      requireThat(review.ok && review.report.id === report.id && review.currentConfigMatches === true && review.canUpdateBaseline === true, "CURRENT_SESSION_CANDIDATE_NOT_ELIGIBLE");
      requireThat(report.source === "launch" && report.risky && !report.changes.some(c => c.field.startsWith("persona.")), "NOT_REAL_ELIGIBLE_LAUNCH_DRIFT");
      const timezoneChange = report.changes.find(c => c.field === "timezone");
      requireThat(timezoneChange?.baseline === "Asia/Tokyo" && timezoneChange.current === "Asia/Shanghai", "NATIVE_TIMEZONE_DRIFT_MISSING");
      record("gate-stopped-native-observation", { pid: driftChild.pid, port: driftChild.port, argvSha256: driftChild.argvSha256,
        exitWitness: (await runtime()).held.find(child => child.pid === driftChild.pid)?.exitWitness,
        nativeComparison: { reportId: report.id, source: report.source, observedAt: report.observedAt,
          beforeTimezone: timezoneChange.baseline, afterTimezone: timezoneChange.current,
          currentConfigMatches: review.currentConfigMatches, canUpdateBaseline: review.canUpdateBaseline },
        authority: "source09 production native-candidate comparison plus held-child identity/exit; no post-exit CDP" });
      const row = h.page.locator("#fingerprint-drift-body .fingerprint-drift-row").filter({ has: h.page.locator("code.fingerprint-drift-key", { hasText: /^timezone$/ }) });
      await call("visible-typed-timezone-row", () => row.waitFor({ state: "visible" }));
      expect(await row.locator(".fingerprint-drift-value").allTextContents()).toEqual(["Asia/Tokyo", "Asia/Shanghai"]);
      expect(await h.page.locator("#fingerprint-drift-body time").first().getAttribute("datetime")).toBe(new Date(report.observedAt).toISOString());
      const expectedSource = await call("real-source-translation", () => h!.page.evaluate(() => (window as any).i18n.t("fingerprint.source.launch")));
      expect((await h.page.locator(".fingerprint-drift-meta dd").first().innerText()).trim()).toBe(expectedSource);
      await call("visible-timezone-review-scroll", () => row.scrollIntoViewIfNeeded());
      const rowRect = await row.boundingBox(), viewport = h.page.viewportSize();
      requireThat(rowRect && rowRect.width > 0 && rowRect.height > 0 && rowRect.y >= 0 &&
        (!viewport || rowRect.y + rowRect.height <= viewport.height), "REVIEW_ROW_OUTSIDE_OWNED_VIEWPORT");
      await visible("review", true); record("reviewed-typed-disk-comparison", reportEvidence(report));
      await stage("update");
      await call("UI-Update-once", () => h!.page.locator("#fingerprint-drift-update").click());
      const confirm = h.page.locator("#dlg-confirm");
      await call("nested-confirm-visible", () => confirm.waitFor({ state: "visible" }));
      requireThat(await h.page.locator("#dlg-fingerprint-drift").isVisible(), "COMPARISON_NOT_UNDER_NESTED_CONFIRM");
      const confirmationText = await confirm.innerText();
      requireThat(confirmationText.trim().length > 80 && (await confirm.locator("#dlg-confirm-ack-label").innerText()).trim().length > 0, "CONFIRMATION_SCOPE_NOT_READABLE");
      expect(baselineSha()).toBe(oldBaselineSha);
      expect(readReport().id).toBe(report.id); requireThat((await runtime()).roots.length === 0, "PREVIEW_STARTED_BROWSER");
      record("same-report-preview-with-private-token", { reportId: report.id, confirmationTextSha256: sha(confirmationText),
        baselineUnchanged: true, nativeRoots: 0, previewCount: 1, token: "not extracted; issued and bound by original product" });
      await call("UI-ACK", () => confirm.locator("#dlg-confirm-ack").check());
      await visible("update", true);
      await call("UI-confirm-submit-once", () => confirm.locator('button[type="submit"]').click());
      await wait("baseline-commit-actually-persisted", async () => baselineSha() !== oldBaselineSha && !!readReport().acceptedAt && await idle());
      expect(baseline().timezone).toBe("Asia/Shanghai");
      const accepted = readReport(); expect(accepted.id).toBe(report.id);
      requireThat((await runtime()).roots.length === 0, "BASELINE_COMMIT_STARTED_BROWSER");
      const history = await api("browser", "healthHistory", id);
      const baselineEntry = history.entries?.at(-1);
      requireThat(baselineEntry?.source === "baseline" && ["risk", "baseline-established"].includes(baselineEntry.outcome), "BASELINE_UPDATE_FALSE_HEALTH_PASS");
      expect(config().profileHealthHistory[id].at(-1).outcome).toBe(baselineEntry.outcome);
      requireThat((await api("browser", "driftReport", id)).report.id === report.id, "COMMITTED_REPORT_NOT_RETRIEVABLE");
      record("same-report-committed-without-launch", { report: reportEvidence(accepted), baselineBeforeSha256: oldBaselineSha,
        baselineAfterSha256: baselineSha(), history: { source: baselineEntry.source, outcome: baselineEntry.outcome }, submitCount: 1 });
      await stage("start-and-verify");
      await visible("before-start");
      await call("UI-Start-and-verify", () => h!.page.locator("#fingerprint-drift-launch").click());
      await wait("fresh-owned-start-and-normal-gates-settled", async () => (await runtime()).held.length === 3 && (await runtime()).roots.length === 1 && await idle(), 70_000);
      const third = (await runtime()).roots[0];
      requireThat(third.pid !== first.pid && third.pid !== driftChild.pid && third.port !== driftChild.port, "START_REUSED_OLD_NATIVE_ROOT");
      await observeNative(third, "Asia/Shanghai");
      const launchReport = readReport(); requireThat(launchReport.source === "launch" && launchReport.id !== report.id, "START_DID_NOT_RUN_NORMAL_COMPARISON_GATE");
      await visible("start", true); record("normal-launch-result-not-assumed-green", reportEvidence(launchReport));
      await stage("recheck");
      await visible("before-recheck");
      await call("UI-Recheck-once", () => h!.page.locator("#fingerprint-drift-recheck").click());
      await wait("new-manual-runtime-report", async () => readReport().source === "manual" && readReport().id !== launchReport.id && await idle(), 40_000);
      const manual = readReport();
      requireThat(manual.observedAt >= launchReport.observedAt && (await runtime()).roots[0]?.pid === third.pid, "RECHECK_REPLAY_OR_RUNTIME_CHANGED");
      const manualHistory = await api("browser", "healthHistory", id), latest = manualHistory.entries?.at(-1);
      requireThat(latest?.kind === "drift" && latest.source === "runtime" &&
        ["pass", "warn", "risk", "error", "unavailable", "inconclusive", "cancelled"].includes(latest.outcome), "MANUAL_RUNTIME_OUTCOME_MISSING");
      expect(config().profileHealthHistory[id].at(-1).requestId).toBe(latest.requestId);
      requireThat((await api("browser", "driftReport", id)).report.id === manual.id, "MANUAL_REPORT_NOT_RETRIEVABLE");
      await visible("recheck", true); record("fresh-manual-runtime-result-not-assumed-green", { report: reportEvidence(manual),
        outcome: latest.outcome, source: latest.source, requestId: latest.requestId });
      await stopUI(third); checkCompiled();
      requireThat(sha(bytes(R, path.join(R, "tests/e2e/fingerprint-drift-visible-acceptance.test.ts"))) === harnessSha, "HARNESS_CHANGED_DURING_RUN");
      requireThat(fixture.failures.length === 0, "OWNED_FIXTURE_FAILURE");
      requireThat(h.pageErrors.length === 0, "UNHANDLED_RENDERER_ERROR");
      record("renderer-error-observation", { unhandledPageErrors: h.pageErrors.length,
        consoleErrorCount: h.consoleErrors.length, consoleErrorHashes: h.consoleErrors.slice(0, 32).map(value => sha(value)),
        scope: "owned controller renderer; console bodies not retained or relayed; explicit missing Firefox status stays unknown" });
      record("fixture-summary", fixture.stats()); receipt.status = "passed";
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      failure = error; receipt.error = { phase, name: error instanceof Error ? error.name : "unknown",
        code: /^[A-Z][A-Z0-9_]*(?::[A-Za-z0-9_. -]{1,100})?$/.test(message) ? message : "REDACTED_RUNTIME_FAILURE",
        sha256: sha(String(error)) };
    } finally {
      cleaning = true;
      try {
        // A deadline/parent abort is not an original-operation cancellation.
        await wait("pending-driver-operations-settled", () => pending.size === 0, 15_000);
        if (h && observer) {
          const state = await runtime();
          requireThat(state.roots.length <= 1 && state.held.every(c => c.pid > 0), "CLEANUP_OWNERSHIP_UNVERIFIED");
          for (const child of state.roots) {
            const current = (await runtime()).roots.find(c => c.pid === child.pid);
            requireThat(current && !current.exited, "CLEANUP_CHILD_IDENTITY_UNVERIFIED");
            // Failure cleanup uses the unchanged product Stop API, only for the
            // child held and ownership-checked above; never browser.close().
            const stop = await api("browser", "stop", id);
            requireThat(stop.success === true, "NORMAL_CLEANUP_STOP_REFUSED"); await stopped(child);
          }
          const final = await runtime();
          requireThat(final.roots.length === 0 && final.held.every(c => c.exited && c.exitWitness !== null && c.signalCode !== "SIGKILL" && pidExited(c.pid)), "CLEANUP_ACTUAL_CHILD_EXIT_UNVERIFIED");
          await wait("all-original-renderer-work-settled", idle, 15_000);
          requireThat(pending.size === 0, "CLEANUP_PENDING_OPERATIONS");
          for (const browser of connections) await wait("owned-CDP-disconnected-by-native-exit", () => !browser.isConnected(), 5_000);
          await call("normal-controller-close", () => h!.app.close(), 12_000);
          await wait("controller-actual-exit", () => controllerExit !== undefined && pidExited(h!.app.process().pid!), 10_000);
          requireThat(controllerExit?.code === 0 && controllerExit.signal === null, "CONTROLLER_NOT_EXIT_ZERO");
          receipt.cleanup.push({ status: "verified", controller: controllerExit, native: final.held, noDriverForcedSignals: true,
            installedApp: "never opened/attached; no installed-App userdata or files written" });
        } else if (h) {
          // No target Launch can be clicked before observer installation.
          const empty = await call("pre-launch-runtime-empty", () => h!.app.evaluate(async (_electron, module) => {
            const vm = process.getBuiltinModule("node:vm");
            const table = await vm.runInThisContext(`import(${JSON.stringify(module)})`, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
            return table.runningProcesses.size === 0;
          }, pathToFileURL(path.join(R, "dist/main/services/browser/runtime-table.js")).href));
          requireThat(empty && pending.size === 0, "PRE_LAUNCH_CLEANUP_UNVERIFIED");
          await wait("pre-launch-original-work-settled", idle, 10_000);
          await call("normal-pre-launch-controller-close", () => h!.app.close(), 12_000);
          await wait("pre-launch-controller-actual-exit", () => controllerExit !== undefined && pidExited(h!.app.process().pid!), 10_000);
          requireThat(controllerExit?.code === 0 && controllerExit.signal === null, "PRE_LAUNCH_CONTROLLER_EXIT_UNVERIFIED");
          receipt.cleanup.push({ status: "verified", controller: controllerExit, native: [], targetLaunchNeverAttempted: true });
        } else if (controllerAttempted) {
          throw new Error("SETUP_FAILED_WITHOUT_CONTROLLER_HANDLE_CLEANUP_UNVERIFIED");
        } else {
          receipt.cleanup.push({ status: "not-started", controller: "not launched", native: [] });
        }
      } catch (error) {
        failure ||= error; receipt.status = "failed";
        receipt.cleanup.push({ status: "cleanup-unverified", errorSha256: sha(String(error)),
          action: "no force, unknown process signalling, or controller close used to disguise missing child-exit proof" });
      }
      if (fixture) {
        try { await call("normal-owned-fixture-close", () => fixture!.close(), 5_000); receipt.cleanup.push({ fixture: "normally-closed" }); }
        catch (error) { failure ||= error; receipt.status = "failed"; receipt.cleanup.push({ fixture: "cleanup-unverified", errorSha256: sha(String(error)) }); }
      }
      receipt.finishedAt = new Date().toISOString(); receipt.phase = phase;
      if (failure) receipt.status = "failed";
      if (root && outputAdmitted) {
        try {
          realDirectory(root); childPath(realDirectory(E), root);
          const encoded = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
          requireThat(encoded.length <= 256 * 1024, "RECEIPT_SIZE_LIMIT");
          const file = path.join(root, "visible-acceptance-receipt.json");
          const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          requireThat(bytes(root, file).equals(encoded), "RECEIPT_READBACK_FAILED");
          // Only bounded metadata is emitted, never console/stdout/stderr bodies.
          console.info(JSON.stringify({ status: receipt.status, phase, receipt: file, receiptSha256: sha(encoded), screenshots: receipt.screenshots.length }));
        } catch (error) { failure ||= error; }
      }
    }
    if (failure) throw new Error("Visible acceptance failed at " + phase + "; inspect owned receipt (no retry or product patch applied)");
    expect(receipt.status).toBe("passed");
  }, 500_000);
});
