// Opt-in serial acceptance through the actual headless controller and native
// Chromium. This does not establish visible desktop UI or LocalStorage durability.
// ABS_SYNC_HISTORY_ACCEPTANCE=1 ABS_SYNC_ACCEPTANCE_DIST_READY=1 \
// ABS_SYNC_HISTORY_ACCEPTANCE_ROOT=<fresh empty owned directory> \
// AGENT_BROWSER_CHROMIUM_BINARY_PATH=<existing managed executable> \
// ./node_modules/.bin/vitest run -c vitest.config.e2e.ts tests/e2e/sync-history-identity-acceptance.test.ts
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type Page } from "playwright";
import { launchHeadlessApp, type HeadlessAppHandle } from "./helpers/app.js";
import { startSyncAcceptanceFixture } from "./helpers/sync-fixture.js";
import { compareProfileIdentity, describeProfileIdentity } from "../../src/main/services/profile-identity.js";
import { readOwnedNativeArgv } from "./helpers/native-argv.js";
import { assertChromiumReuseEvidence, chromiumLaunchRequestHash } from "../../src/main/services/browser/launch-provenance.js";
import { readChromiumGpuContext } from "../../src/main/services/browser/chromium-gpu-context.js";
import { captureFullHostIdentity, HostIdentityCaptureError, startHostIdentityFixture, type HostIdentityFixture } from "../../src/tools/host-identity-capture.js";
import { compareCapturedProfileIdentity, type ProfileIdentityRuntimeSample } from "../../src/tools/profile-identity-comparison.js";
import type { IdentityRunBinding } from "../../src/tools/host-identity-validation.js";
import { extractZipEntry, readZipEntries } from "../../src/main/services/zip-writer.js";

const OPTED_IN = process.env.ABS_SYNC_HISTORY_ACCEPTANCE === "1";
const REPO = path.resolve(__dirname, "..", "..");
const CONFIG_KEY = "agent-browser-studio-config.json";
const BUCKET = "history-acceptance";
const TITLE = "Restored history sentinel 20261019 — 中文";
const MAX_BYTES = 16 * 1024 * 1024;
const sha256 = (bytes: Buffer | string): string => crypto.createHash("sha256").update(bytes).digest("hex");

async function fileHash(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function childPath(root: string, ...parts: string[]): string {
  const file = path.resolve(root, ...parts), relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Evidence path is not an owned child");
  return file;
}
function bytes(root: string, file: string): Buffer {
  childPath(root, path.relative(root, file));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("Evidence must be a bounded regular owned file");
  childPath(fs.realpathSync(root), path.relative(fs.realpathSync(root), fs.realpathSync(file)));
  return fs.readFileSync(file);
}
function profile(handle: HeadlessAppHandle, id: string): Record<string, any> {
  return JSON.parse(bytes(handle.userDataDir, childPath(handle.userDataDir, "config.json")).toString()).browserProfiles[id];
}
async function until(label: string, condition: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  throw new Error(`Owned acceptance deadline: ${label}`);
}
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error: any) { if (error.code === "ESRCH") return true; throw error; }
}
async function request(port: number, token: string | null, method: string, route: string, body?: unknown, options: { allowNonJsonProbe?: boolean } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const req = http.request({ hostname: "127.0.0.1", port, method, path: route, headers }, (res) => {
      const chunks: Buffer[] = []; let count = 0;
      res.on("data", (chunk: Buffer) => {
        count += chunk.length;
        if (count > MAX_BYTES) req.destroy(new Error("Owned HTTP reply exceeded budget"));
        else chunks.push(Buffer.from(chunk));
      });
      res.on("error", reject);
      res.on("end", () => {
        const status = res.statusCode || 0;
        // The owned process also has Playwright's V8 Inspector socket, whose
        // /health response is deliberately plain text, not a product service.
        if (options.allowNonJsonProbe && !String(res.headers["content-type"]).includes("application/json")) {
          resolve({ status, body: null }); return;
        }
        try { resolve({ status, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(new Error(`Non-JSON owned reply ${method} ${route}: ${String(error)}`)); }
      });
    });
    req.setTimeout(60_000, () => req.destroy(new Error(`Owned HTTP deadline ${method} ${route}`)));
    req.on("error", reject); req.end(payload);
  });
}
async function api(handle: HeadlessAppHandle, method: string, route: string, body?: unknown) {
  const result = await request(handle.port, handle.token, method, route, body);
  expect(result.status, JSON.stringify(result.body)).toBeGreaterThanOrEqual(200);
  expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
  return result.body;
}
function inspectHistory(root: string, directory: string, markerUrl: string, label: string) {
  const analysis = fs.mkdtempSync(path.join(root, `${label}-history-sql-`));
  const members = ["History", "History-wal"].filter((name) => fs.existsSync(path.join(directory, name))).map((name) => {
    const source = path.join(directory, name), data = bytes(root, source);
    fs.writeFileSync(path.join(analysis, name), data, { flag: "wx", mode: 0o600 });
    return { path: name, bytes: data.length, sha256: sha256(data) };
  });
  expect(members.some((member) => member.path === "History")).toBe(true);
  const db = new DatabaseSync(path.join(analysis, "History"), { readOnly: true });
  try {
    expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    const statement = db.prepare("SELECT u.id AS url_id,u.url,u.title,u.visit_count,v.id AS visit_id,v.visit_time,v.from_visit,v.transition FROM urls u JOIN visits v ON v.url=u.id WHERE u.url=? ORDER BY v.id");
    statement.setReadBigInts(true);
    const rows = statement.all(markerUrl);
    expect(rows.length, "Native on-disk History must contain the browser-created URL and its visit relation").toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.title).toBe(TITLE); expect(row.url).toBe(markerUrl);
      expect(typeof row.url_id).toBe("bigint"); expect(typeof row.visit_time).toBe("bigint");
      expect(row.visit_time as bigint).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    }
    const exactRows = rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      typeof value === "bigint" ? { type: "integer", decimal: value.toString() } : { type: typeof value, value }])));
    expect(db.prepare("SELECT COUNT(*) AS missing FROM visits v LEFT JOIN urls u ON u.id=v.url WHERE u.id IS NULL").get()).toEqual({ missing: 0 });
    return { analysis, members, integrity: "ok", exactRows, searchedUrl: markerUrl, syntheticRowCount: rows.length };
  } finally {
    db.close();
    for (const member of members) expect(sha256(bytes(root, path.join(directory, member.path)))).toBe(member.sha256);
  }
}

interface NativeOwner { handle: HeadlessAppHandle; id: string; pid: number; port: number; browser?: Browser; cdpContradiction?: boolean }
interface LiveBrowser extends NativeOwner { browser: Browser; page: Page }

describe.skipIf(!OPTED_IN)("actual headless history transport and identity acceptance", () => {
  it("restores browser-created history before revisiting its URL and independently compares runtime identity", async () => {
    expect(process.platform).toBe("darwin");
    expect(process.env.ABS_SYNC_ACCEPTANCE_DIST_READY).toBe("1");
    expect(process.env.AGENT_BROWSER_E2E_UNSANDBOXED).not.toBe("1");
    const supplied = process.env.ABS_SYNC_HISTORY_ACCEPTANCE_ROOT;
    if (!supplied || !path.isAbsolute(supplied)) throw new Error("A fresh absolute owned acceptance root is required");
    const rootStat = fs.lstatSync(supplied);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.readdirSync(supplied).length) throw new Error("Acceptance root must be a new empty real directory");
    const root = fs.realpathSync(supplied);
    if (root.startsWith("/Volumes/")) execFileSync("python3", ["/Users/ahoo/.local/share/agent-storage/move_verified_storage.py", "check-mount"], { stdio: "pipe" });
    const owned = fs.mkdtempSync(path.join(root, "history-identity-"));
    const binaryInput = process.env.AGENT_BROWSER_CHROMIUM_BINARY_PATH;
    if (!binaryInput || !path.isAbsolute(binaryInput)) throw new Error("Select one existing managed executable explicitly; no discovery/download fallback");
    const binary = fs.realpathSync(binaryInput);
    const binarySha = await fileHash(binary);
    const framework = path.resolve(path.dirname(binary), "../Frameworks/Chromium Framework.framework/Versions/Current/Chromium Framework");
    const frameworkSha = await fileHash(framework);
    const productVersion = execFileSync(binary, ["--version"], { timeout: 10_000, encoding: "utf8", env: { PATH: process.env.PATH, HOME: owned, TMPDIR: owned } }).match(/\d+\.\d+\.\d+\.\d+/)?.[0];
    expect(productVersion).toBeTruthy();
    const buildInputs = ["main/index.js", "main/services/sync-service.js", "main/services/sync/sqlite-history.js", "main/services/profile-identity.js"];
    const compiled = Object.fromEntries(buildInputs.map((relative) => [relative, sha256(bytes(path.join(REPO, "dist"), path.join(REPO, "dist", relative)))]));
    const receipt: Record<string, any> = { schema: "actual-headless-history-identity/v1", status: "running", phase: "startup", compiled,
      executable: { path: binary, sha256: binarySha, frameworkSha256: frameworkSha, version: productVersion }, observations: {}, cleanup: [], limitations: [
        "Headless controller CLI/HTTP and native headless Chromium History DOM, not visible Studio/preload or physical desktop UI acceptance.",
        "Chromium History only in this actual-runtime lane; Firefox Places transport has a separate synthetic database gate and needs its own runnable engine UI acceptance.",
        "Six-context navigator/UA-CH and identity request headers only; full GPU, fonts, canvas, audio and all fingerprint surfaces are not attested.",
        "Public macOS PID/start-time, executable, exact argv and CDP witnesses are bracketed observations; the SDK supplies no exec-generation counter, so same-image exec/ABA is not an atomic-snapshot proof.",
        "This does not repair or reverify the separately failing immediate-stop LocalStorage gate. No secret/license/user profile or real cloud is used.",
      ] };
    let fixture: Awaited<ReturnType<typeof startSyncAcceptanceFixture>> | undefined;
    let identityFixture: HostIdentityFixture | undefined;
    const controllers: HeadlessAppHandle[] = [];
    let nativeOwner: NativeOwner | undefined;
    async function stopBrowser(): Promise<void> {
      if (!nativeOwner) return;
      const target = nativeOwner;
      if (target.cdpContradiction) throw new Error("CDP belongs to another PID; no close command sent to that endpoint");
      expect((await api(target.handle, "POST", `/api/profiles/${target.id}/stop`, {})).success).toBe(true);
      await until("native browser exited", () => gone(target.pid));
      if (target.browser) await until("native CDP disconnected", () => !target.browser!.isConnected());
      await until("native CDP endpoint closed", async () => {
        try { await request(target.port, null, "GET", "/json/version"); return false; }
        catch (error: any) { if (error.code === "ECONNREFUSED") return true; throw error; }
      }, 5_000);
      expect((await api(target.handle, "GET", `/api/profiles/${target.id}/status`)).running).toBe(false);
      receipt.cleanup.push({ kind: "browser", pid: target.pid, normalProductStop: true, exited: true, endpointClosed: true });
      nativeOwner = undefined;
    }
    async function launch(handle: HeadlessAppHandle, id: string): Promise<LiveBrowser> {
      const result = await api(handle, "POST", `/api/profiles/${id}/launch`, { headless: true });
      expect(result.success).toBe(true); expect(result.pid).toBeGreaterThan(0); expect(result.cdpPort).toBeGreaterThan(0);
      nativeOwner = { handle, id, pid: result.pid, port: result.cdpPort };
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${result.cdpPort}`, { timeout: 20_000 });
      const proof = await browser.newBrowserCDPSession();
      try {
        const processes = (await proof.send("SystemInfo.getProcessInfo")).processInfo.filter((entry) => entry.type === "browser");
        if (processes.length !== 1 || processes[0].id !== result.pid) {
          nativeOwner.cdpContradiction = true;
          throw new Error("Native CDP browser PID does not match the product-owned launch");
        }
      } catch (error) {
        // connectOverCDP close disconnects this client, not the external browser.
        await browser.close(); throw error;
      } finally { if (browser.isConnected()) await proof.detach(); }
      nativeOwner.browser = browser;
      const context = browser.contexts()[0];
      if (!context) throw new Error("Production launch did not expose an owned browser context");
      const allowed = [fixture!.origin, identityFixture!.origin, identityFixture!.crossOrigin];
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return allowed.includes(url.origin) || ["chrome:", "about:", "data:", "blob:"].includes(url.protocol)
          ? route.continue() : route.abort("blockedbyclient");
      });
      const page = context.pages().find((candidate) => !candidate.url().startsWith("chrome-extension:")) || await context.newPage();
      return { browser, page, handle, id, pid: result.pid, port: result.cdpPort };
    }
    async function captureIdentity(target: LiveBrowser, phase: string): Promise<ProfileIdentityRuntimeSample> {
      const profileDirectory = path.join(target.handle.userDataDir, "profiles", target.id);
      const observed = readOwnedNativeArgv({ pid: target.pid, executablePath: binary, argv0: binary, profileDir: profileDirectory, port: target.port });
      receipt.observations[`${phase}ProcessOwnership`] = observed.ownershipWitness;
      expect(observed?.malformed).toBe(false);
      expect(observed?.pid).toBe(target.pid); expect(observed?.engine).toBe("chromium");
      expect(fs.realpathSync(observed!.executablePath)).toBe(binary);
      expect(observed!.profileDirs.map((file) => fs.realpathSync(file))).toEqual([fs.realpathSync(profileDirectory)]);
      expect(observed!.cdpPorts).toEqual([target.port]);
      expect(observed!.args).toContain("--headless=new");
      expect(observed!.args.some((arg) => /^--(?:no-sandbox|disable-gpu-sandbox)(?:=|$)/.test(arg))).toBe(false);
      const saved = JSON.parse(bytes(target.handle.userDataDir, path.join(target.handle.userDataDir, "config.json")).toString());
      const expectedRequestHash = chromiumLaunchRequestHash(saved.browserProfiles[target.id], saved, { headless: true, binaryOverride: binary, gpuContext: readChromiumGpuContext(binary) });
      assertChromiumReuseEvidence(observed!, { profileDir: profileDirectory, executablePath: binary,
        requestHash: expectedRequestHash, mode: "managed", pid: target.pid, port: target.port });
      const payloadArg = observed!.args.find((arg) => /^--(?:agent-browser|roxy)-fingerprint-config=/.test(arg));
      expect(payloadArg).toBeTruthy();
      const actualPayload = JSON.parse(Buffer.from(payloadArg!.slice(payloadArg!.indexOf("=") + 1), "base64url").toString());
      expect(actualPayload.seed).toBe(saved.browserProfiles[target.id].fingerprintSeed);
      const observedIdentityMode = payloadArg ? "managed" as const : "off" as const;
      expect(await fileHash(observed!.executablePath)).toBe(binarySha); expect(await fileHash(framework)).toBe(frameworkSha);
      const session = await target.browser.newBrowserCDPSession();
      let version: string;
      try {
        const processes = (await session.send("SystemInfo.getProcessInfo")).processInfo.filter((entry) => entry.type === "browser");
        if (processes.length !== 1 || processes[0].id !== target.pid) {
          if (nativeOwner) nativeOwner.cdpContradiction = true;
          throw new Error("Native CDP browser PID changed before identity capture; no endpoint close is authorized");
        }
        version = (await session.send("Browser.getVersion")).product.match(/\d+\.\d+\.\d+\.\d+/)![0];
      } finally { await session.detach(); }
      expect(version).toBe(productVersion);
      const runId = crypto.randomUUID(), hostId = sha256(JSON.stringify({ hostname: os.hostname(), platform: os.platform(), arch: os.arch(), release: os.release() }));
      const binding: IdentityRunBinding = { runId, hostId, profileId: target.id, pid: target.pid, executablePath: binary,
        executableSha256: binarySha, mode: "headless", identityMode: "managed" };
      const verifiedBinding: IdentityRunBinding = { runId, hostId, profileId: path.basename(observed!.profileDirs[0]), pid: observed!.pid,
        executablePath: fs.realpathSync(observed!.executablePath), executableSha256: await fileHash(observed!.executablePath),
        mode: observed!.args.includes("--headless=new") ? "headless" : "headed", identityMode: observedIdentityMode };
      // Ownership path, CDP port and per-run launch stamp are checked above but
      // are not identity policy. Preserve every remaining observed switch/value.
      const volatile = ["--user-data-dir=", "--remote-debugging-port=", "--agent-browser-launch-stamp="];
      const policy = observed!.args.filter((arg) => !volatile.some((prefix) => arg.startsWith(prefix)));
      const launchPolicyHash = sha256(JSON.stringify({ version: 1, engine: "chromium", frameworkSha256: frameworkSha, policy }));
      let capture: Awaited<ReturnType<typeof captureFullHostIdentity>>;
      try { capture = await captureFullHostIdentity(target.page, { fixture: identityFixture!, binding, timeoutMs: 90_000 }); }
      catch (error) {
        if (error instanceof HostIdentityCaptureError) {
          const partial = JSON.stringify(error.evidence, null, 2);
          expect(Buffer.byteLength(partial)).toBeLessThan(1024 * 1024);
          const partialFile = path.join(owned, `${phase}-identity-partial.json`);
          fs.writeFileSync(partialFile, partial, { flag: "wx", mode: 0o600 });
          receipt.observations[`${phase}IdentityFailure`] = { file: partialFile, sha256: sha256(partial), state: "not-verifiable" };
        }
        throw error;
      }
      const sample: ProfileIdentityRuntimeSample = { capture, runtime: { engine: "chromium", binding, verifiedBinding,
        executableVersion: productVersion!, browserVersion: version!, browserVersionSource: "cdp", launchPolicyHash } };
      const file = path.join(owned, `${phase}-identity.json`);
      const serialized = JSON.stringify(sample, null, 2);
      expect(Buffer.byteLength(serialized)).toBeLessThan(1024 * 1024);
      fs.writeFileSync(file, serialized, { flag: "wx", mode: 0o600 });
      expect(JSON.parse(bytes(owned, file).toString())).toEqual(sample);
      return sample;
    }
    try {
      fixture = await startSyncAcceptanceFixture({ bucket: BUCKET, configKey: CONFIG_KEY, businessPage: `<!doctype html><title>${TITLE}</title><h1 id="sentinel">${TITLE}</h1>`,
        cookieName: "unused_synthetic_cookie", cookieValue: "unused_synthetic_value", maxObjectBytes: MAX_BYTES });
      identityFixture = await startHostIdentityFixture();
      async function controller(label: string): Promise<HeadlessAppHandle> {
        const userDataDir = fs.mkdtempSync(path.join(owned, `${label}-userdata-`));
        const handle = await launchHeadlessApp({ userDataDir, token: `history-${label}-synthetic-token`,
          env: { AGENT_BROWSER_CHROMIUM_BINARY_PATH: binary, AGENT_BROWSER_API_PORT: "0", AGENT_BROWSER_MCP_PORT: "0",
            AGENT_BROWSER_MCP_TOKEN: `history-${label}-synthetic-mcp` } });
        controllers.push(handle);
        const isolation = await handle.app.evaluate(({ app, BrowserWindow }) => ({ mode: process.argv.includes("--headless"), windows: BrowserWindow.getAllWindows().length, platform: process.platform, architecture: process.arch,
          userData: app.getPath("userData"), home: process.getBuiltinModule("os").homedir(), noSandbox: app.commandLine.hasSwitch("no-sandbox"),
          providerKeys: Object.keys(process.env).filter((key) => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(key)) }));
        expect(isolation).toMatchObject({ mode: true, windows: 0, platform: process.platform, architecture: process.arch, noSandbox: false, providerKeys: [] });
        expect(fs.realpathSync(isolation.userData)).toBe(fs.realpathSync(userDataDir));
        expect(fs.realpathSync(isolation.home)).toBe(fs.realpathSync(path.join(userDataDir, "test-home")));
        expect((await request(handle.port, null, "GET", "/health")).status).toBe(200);
        const auth = [];
        for (const token of [null, "wrong-synthetic-token", handle.token]) auth.push((await request(handle.port, token, "GET", "/api/sync/status")).status);
        expect(auth).toEqual([401, 401, 200]);
        for (const route of ["/api/sync/config", "/api/sync/push", "/api/sync/pull"]) {
          for (const token of [null, "wrong-synthetic-token"]) expect((await request(handle.port, token, "POST", route, {})).status).toBe(401);
        }
        // Discover only this owned controller's actual listening sockets. No
        // dynamic module import inside Playwright's VM or real token-file read.
        let mcpPort = 0;
        await until("owned MCP listener ready", async () => {
          const listeners = execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(handle.app.process().pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8", timeout: 5_000 })
            .split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
          expect(listeners.every((listener) => /^127\.0\.0\.1:\d+$/.test(listener))).toBe(true);
          for (const listener of listeners) {
            const port = Number(listener.slice(listener.lastIndexOf(":") + 1));
            if (port === handle.port) continue;
            const health = await request(port, null, "GET", "/health", undefined, { allowNonJsonProbe: true });
            if (health.status === 200 && health.body?.service === "agent-browser-studio-mcp") {
              mcpPort = port; return true;
            }
          }
          return false;
        });
        expect(mcpPort).toBeGreaterThan(0);
        const mcpAuth = [];
        for (const token of [null, "wrong-synthetic-mcp", `history-${label}-synthetic-mcp`]) mcpAuth.push((await request(mcpPort, token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).status);
        expect(mcpAuth).toEqual([401, 401, 200]);
        receipt.observations[`${label}Isolation`] = { ...isolation, restAuth: auth, mcpAuth };
        return handle;
      }
      const receiver = await controller("receiver");
      const receiverDeviceId = (await api(receiver, "GET", "/api/team")).local.deviceId;
      const source = await controller("source");
      await api(source, "POST", "/api/team/init", { name: "History acceptance workspace" });
      await api(source, "POST", "/api/team/members", { deviceId: receiverDeviceId, name: "Synthetic receiver", role: "member" });
      for (const handle of [source, receiver]) await api(handle, "POST", "/api/sync/config", { enabled: true, endpoint: fixture.origin, bucket: BUCKET,
        accessKey: "synthetic-access", secretKey: "synthetic-secret", custodyConsent: true, includeHistory: true, historyConsent: true });
      await api(source, "POST", "/api/proxies", { name: "history-local-only", config: { type: "http", host: "127.0.0.1", port: fixture.port } });
      const created = await api(source, "POST", "/api/profiles", { name: "History identity acceptance", engine: "chromium", fingerprintMode: "managed",
        platform: "macos", fingerprintSeed: 730147, locale: "en-US", timezone: "UTC", webrtcMode: "disable", appUrl: null,
        proxyMode: "named", proxyName: "history-local-only" });
      const id = created.dirId;
      expect(id).toMatch(/^ab_[A-Za-z0-9_-]+$/);
      const initialProfile = profile(source, id);
      const markerUrl = `${fixture.origin}/business?history=${crypto.randomUUID()}`;
      receipt.phase = "native source history and identity";
      const nativeSource = await launch(source, id);
      await nativeSource.page.goto(markerUrl, { waitUntil: "load", timeout: 15_000 });
      expect(await nativeSource.page.title()).toBe(TITLE);
      await nativeSource.page.goto(`chrome://history/?q=${encodeURIComponent(TITLE)}`, { waitUntil: "load" });
      await nativeSource.page.getByRole("link", { name: TITLE, exact: true }).first().waitFor({ state: "visible", timeout: 20_000 });
      const before = await captureIdentity(nativeSource, "before");
      await nativeSource.page.goto("about:blank");
      await stopBrowser();
      const sourceDirectory = path.join(source.userDataDir, "profiles", id, "Default");
      const sourceSql = inspectHistory(owned, sourceDirectory, markerUrl, "source");
      receipt.observations.sourceSql = sourceSql;
      receipt.phase = "actual artifact upload/readback/publication";
      const push = await api(source, "POST", "/api/sync/push", { history: true });
      expect(push.success).toBe(true);
      const document = fixture.config();
      expect(document.artifactVersion).toBe(3);
      const history = document.history[id];
      expect(history).toMatchObject({ version: 1, dirId: id, engine: "chromium", state: "complete" });
      const object = history.artifact.object, uploaded = fixture.objects.get(object.key);
      expect(uploaded).toBeDefined(); expect(sha256(uploaded!)).toBe(object.sha256); expect(uploaded!.length).toBe(object.bytes);
      const artifactPut = fixture.journal.findIndex((entry) => entry.method === "PUT" && entry.key === object.key);
      const artifactGet = fixture.journal.findIndex((entry, index) => index > artifactPut && entry.method === "GET" && entry.key === object.key);
      const configPut = fixture.journal.findIndex((entry) => entry.method === "PUT" && entry.key === CONFIG_KEY);
      expect(artifactPut).toBeGreaterThanOrEqual(0); expect(artifactGet).toBeGreaterThan(artifactPut); expect(configPut).toBeGreaterThan(artifactGet);
      const entries = readZipEntries(uploaded!);
      expect(entries.some((entry) => /-shm$/.test(entry.name))).toBe(false);
      for (const member of history.artifact.members) {
        const entry = entries.find((candidate) => candidate.name === member.path);
        expect(entry).toBeDefined(); const contents = extractZipEntry(uploaded!, entry!);
        expect(contents.length).toBe(member.bytes); expect(sha256(contents)).toBe(member.sha256);
      }
      const uploadedFile = path.join(owned, object.key), envelopeFile = path.join(owned, "published-envelope.json");
      fs.writeFileSync(uploadedFile, uploaded!, { flag: "wx", mode: 0o600 });
      fs.writeFileSync(envelopeFile, fixture.objects.get(CONFIG_KEY)!, { flag: "wx", mode: 0o600 });
      expect(bytes(owned, uploadedFile)).toEqual(uploaded!);
      expect(JSON.parse(bytes(owned, envelopeFile).toString())).toEqual(document);
      const historyRoute = `/api/sync/history/${id}`;
      expect((await request(source.port, null, "GET", historyRoute)).status).toBe(401);
      expect((await request(source.port, "synthetic-wrong-token", "GET", historyRoute)).status).toBe(401);
      const sourceConfigBeforeState = bytes(source.userDataDir, path.join(source.userDataDir, "config.json"));
      const sourceHistoryState = await api(source, "GET", historyRoute);
      expect(sourceHistoryState).toMatchObject({ dirId: id, status: "synced", coverage: "complete", reason: "history-baseline-match" });
      expect(bytes(source.userDataDir, path.join(source.userDataDir, "config.json"))).toEqual(sourceConfigBeforeState);
      receipt.observations.push = { result: push, history, actualObjectSha256: sha256(uploaded!), uploadedFile, envelopeFile,
        artifactPut, artifactGet, configPut, historyAuth: [401, 401, 200], sourceHistoryState };
      receipt.phase = "same-ID receiver restore and independent SQL";
      expect(Object.keys(JSON.parse(bytes(receiver.userDataDir, path.join(receiver.userDataDir, "config.json")).toString()).browserProfiles)).toEqual([]);
      const observation = fixture.beginBusinessCookieObservation();
      const pull = await api(receiver, "POST", "/api/sync/pull", { history: true, strategy: "remote" });
      expect(pull.success).toBe(true);
      expect(observation.count, "Receiver restore must not revisit the history marker").toBe(0);
      const restoredProfile = profile(receiver, id);
      const configIdentity = compareProfileIdentity(initialProfile, restoredProfile);
      expect(configIdentity.configuration.state).toBe("retained"); expect(configIdentity.runtime.state).toBe("not-verified");
      expect(describeProfileIdentity(restoredProfile).hash).toBe(describeProfileIdentity(initialProfile).hash);
      const receiverDirectory = path.join(receiver.userDataDir, "profiles", id, "Default");
      const receiverSql = inspectHistory(owned, receiverDirectory, markerUrl, "receiver");
      expect(receiverSql.exactRows).toEqual(sourceSql.exactRows);
      const receiverConfigBeforeState = bytes(receiver.userDataDir, path.join(receiver.userDataDir, "config.json"));
      const receiverHistoryState = await api(receiver, "GET", historyRoute);
      expect(receiverHistoryState).toMatchObject({ dirId: id, status: "synced", coverage: "complete", reason: "history-baseline-match" });
      expect(bytes(receiver.userDataDir, path.join(receiver.userDataDir, "config.json"))).toEqual(receiverConfigBeforeState);
      receipt.observations.pull = { result: pull, sql: receiverSql, configIdentity, receiverHistoryState };
      receipt.phase = "restored native history DOM before any marker revisit";
      const nativeReceiver = await launch(receiver, id);
      expect(observation.count, "Restored startup must not revisit the history marker").toBe(0);
      await nativeReceiver.page.goto(`chrome://history/?q=${encodeURIComponent(TITLE)}`, { waitUntil: "load" });
      const restoredLink = nativeReceiver.page.getByRole("link", { name: TITLE, exact: true }).first();
      await restoredLink.waitFor({ state: "visible", timeout: 20_000 });
      expect(await restoredLink.getAttribute("href")).toBe(markerUrl);
      expect(observation.count, "History search must not recreate its own expected entry").toBe(0);
      const screenshot = path.join(owned, "restored-headless-native-history.png");
      await nativeReceiver.page.screenshot({ path: screenshot, fullPage: false, animations: "disabled" });
      expect(bytes(owned, screenshot).length).toBeLessThan(2 * 1024 * 1024);
      receipt.observations.historyUi = { mode: "headless-native-webui", searchedTitle: TITLE, restoredHref: markerUrl,
        markerRequestsBeforeAndAfterSearch: observation.count, screenshot, screenshotSha256: sha256(bytes(owned, screenshot)), visualReview: "pending" };
      fixture.endBusinessCookieObservation();
      receipt.phase = "independent runtime identity comparison";
      const after = await captureIdentity(nativeReceiver, "after");
      const identity = compareCapturedProfileIdentity(before, after);
      receipt.observations.runtimeIdentity = identity;
      expect(identity.state, JSON.stringify(identity)).toBe("reverified"); expect(identity.fullFingerprintVerified).toBe(false);
      await nativeReceiver.page.goto("about:blank"); await stopBrowser();
      const receiverConfigAfterBrowsing = bytes(receiver.userDataDir, path.join(receiver.userDataDir, "config.json"));
      const historyAfterNewBrowsing = await api(receiver, "GET", historyRoute);
      expect(historyAfterNewBrowsing).toMatchObject({ dirId: id, status: "dirty", reason: "history-content-changed" });
      expect(bytes(receiver.userDataDir, path.join(receiver.userDataDir, "config.json"))).toEqual(receiverConfigAfterBrowsing);
      receipt.observations.historyAfterNewBrowsing = historyAfterNewBrowsing;
      expect(fixture.failures).toEqual([]);
      expect(await fileHash(binary)).toBe(binarySha); expect(await fileHash(framework)).toBe(frameworkSha);
      receipt.status = "passed"; receipt.phase = "complete";
    } catch (error: any) {
      receipt.status = "failed"; receipt.error = String(error?.stack || error); throw error;
    } finally {
      try { await stopBrowser(); } catch (error) { receipt.cleanup.push({ kind: "browser", error: String(error) }); receipt.status = "failed"; }
      for (const handle of controllers.reverse()) {
        const pid = handle.app.process().pid;
        if (nativeOwner?.handle === handle && !gone(nativeOwner.pid)) {
          receipt.cleanup.push({ kind: "controller", pid, retained: true, reason: "Native child cleanup is unverified; no implicit shutdown through an unverified CDP endpoint" });
          receipt.status = "failed"; continue;
        }
        try { await handle.app.close(); if (pid) await until("headless controller exited", () => gone(pid)); receipt.cleanup.push({ kind: "controller", pid, exited: true }); }
        catch (error) { receipt.cleanup.push({ kind: "controller", pid, error: String(error) }); receipt.status = "failed"; }
      }
      for (const ownedFixture of [identityFixture, fixture]) {
        try { await ownedFixture?.close(); } catch (error) { receipt.cleanup.push({ kind: "fixture", error: String(error) }); receipt.status = "failed"; }
      }
      receipt.finishedAt = new Date().toISOString();
      fs.writeFileSync(path.join(owned, "receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
      expect(JSON.parse(bytes(owned, path.join(owned, "receipt.json")).toString())).toEqual(receipt);
      if (!receipt.error) expect(receipt.status, JSON.stringify(receipt.cleanup)).toBe("passed");
    }
  }, 300_000);
});
