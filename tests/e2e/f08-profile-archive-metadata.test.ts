// F08: real isolated Electron IPC/REST + ZIP/config disk readback. All names,
// browser files, dependency references and baseline fields are synthetic.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { closeApp, setupTestApp, type TestAppHandle } from "./helpers/app.js";
import { extractZipEntry, readZipEntries } from "../../src/main/services/zip-writer.js";

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "studio-f08-archive-e2e-"));
const ZIP_PATH = path.join(USERDATA, "portable.zip");
const CONFIG_PATH = path.join(USERDATA, "config.json");
const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const NOTE = "F08 first line\nSecond line\r\nThird\tcolumn\rLast line";
const BASELINE = {
  userAgent: "F08 synthetic UA", screenW: 1600, webgpuIsFallbackAdapter: false,
  systemColors: JSON.stringify({ light: { Canvas: "rgb(255, 255, 255)" } }),
  workerIdentity: JSON.stringify({ userAgent: "F08 synthetic worker" }),
};
const STORE_URL = pathToFileURL(path.join(__dirname, "../../dist/main/services/config/store.js")).href;
const CONFIG_URL = pathToFileURL(path.join(__dirname, "../../dist/main/services/config-manager.js")).href;
const disk = (): any => JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

function zipMeta(): any {
  const zip = fs.readFileSync(ZIP_PATH);
  const entry = readZipEntries(zip).find((e) => e.name === "meta.json");
  expect(entry).toBeDefined();
  return JSON.parse(extractZipEntry(zip, entry!).toString("utf8"));
}

async function request(port: number, token: string, method: string, route: string, body?: unknown, auth = true) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) headers.authorization = `Bearer ${token}`;
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (piece) => parts.push(piece));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        try { resolve({ status: res.statusCode || 0, body: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode || 0, body: text }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("F08 — portable Profile backup behavior metadata", () => {
  let h: TestAppHandle;
  let port = 0;
  let token = "";

  async function main(op: "seed" | "role" | "reload", id?: string): Promise<any> {
    return h.app.evaluate(async (_app, args: { op: string; id?: string; storeUrl: string; configUrl: string; extId: string; baseline: typeof BASELINE }) => {
      const vm = process.getBuiltinModule("node:vm");
      const load = (url: string): Promise<any> => vm.runInThisContext(`import(${JSON.stringify(url)})`, {
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      });
      const [store, config] = await Promise.all([load(args.storeUrl), load(args.configUrl)]);
      if (args.op === "seed") {
        store.transact((draft: any) => {
          const p = draft.browserProfiles[args.id!];
          p.preset = "amazon-seller-us";
          p.fingerprintBaseline = args.baseline;
          p.proxyMode = "named";
          p.proxyName = "absent_f08_proxy";
          p.extensions = { [args.extId]: true };
          p.syncedAt = 123;
          p.syncedHash = "synthetic-hash";
          p.lock = { owner: "synthetic-other-device", ownerName: "synthetic", at: 1 };
        });
      } else if (args.op === "role") {
        store.transact((draft: any) => {
          const deviceId = draft.deviceId;
          draft.team = {
            name: "F08 fixture", ownerDeviceId: deviceId, enabled: true, updatedAt: Date.now(),
            members: [{ deviceId, name: "F08 local", role: args.id, addedAt: Date.now() }],
          };
        });
      } else config.reloadConfig();
      return args.id ? config.getProfileMeta(args.id) : Object.keys(config.getConfig().browserProfiles);
    }, { op, id, storeUrl: STORE_URL, configUrl: CONFIG_URL, extId: EXT_ID, baseline: BASELINE });
  }

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA, env: { AGENT_BROWSER_API_PORT: "0" } });
    const environment = await h.app.evaluate(({ app }) => ({
      nodeHome: process.getBuiltinModule("node:os").homedir(),
      home: process.env.HOME,
      userData: app.getPath("userData"),
      providerKeys: Object.keys(process.env).filter((key) => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(key)),
    }));
    expect(fs.realpathSync(environment.nodeHome)).toBe(fs.realpathSync(path.join(USERDATA, "test-home")));
    expect(fs.realpathSync(environment.home!)).toBe(fs.realpathSync(environment.nodeHome));
    expect(fs.realpathSync(environment.userData)).toBe(fs.realpathSync(USERDATA));
    expect(environment.providerKeys).toEqual([]);
    const llm = await h.page.evaluate(async () => ({
      configured: await (window as any).agentBrowserAPI.agent.llmConfig(),
      detected: await (window as any).agentBrowserAPI.agent.detectLlmConfig(),
    }));
    expect(llm.configured?.hasApiKey ?? false).toBe(false);
    expect(llm.detected?.hasApiKey ?? false).toBe(false);
    const status = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.status());
    port = status.port;
    expect(port).toBeGreaterThan(0);
    token = (await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.revealToken())).token;
    expect(token).toBeTruthy();
  }, 90_000);

  afterAll(async () => {
    if (h) await closeApp(h);
    if (path.dirname(USERDATA) !== os.tmpdir() || !path.basename(USERDATA).startsWith("studio-f08-archive-e2e-")) {
      throw new Error("Unsafe F08 cleanup path");
    }
    fs.rmSync(USERDATA, { recursive: true, force: true });
  }, 90_000);

  it("restores portable metadata through IPC, disk, reload, list and REST ID lookup", async () => {
    expect((await request(port, token, "GET", "/health", undefined, false)).status).toBe(200);
    expect((await request(port, token, "GET", "/api/profiles", undefined, false)).status).toBe(401);
    expect((await request(port, token, "GET", "/api/profiles")).status).toBe(200);
    const created = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.create({
      name: "F08 portable", platform: "windows", fingerprintSeed: 4242,
      drm: true, appUrl: "https://example.test/app", renderScaleMode: "strict",
      windowTitlePrefix: null, allowThirdPartyCookies: true,
    }));
    expect(created.dirId).toBeTruthy();
    const id = created.dirId as string;
    const localFontsDir = path.join(USERDATA, "fonts", "synthetic");
    fs.mkdirSync(localFontsDir, { recursive: true });
    const setMeta = await h.page.evaluate(({ id, fontsDir, note }) => (window as any).agentBrowser.api.browser.setMeta(id, { fontsDir, note }), { id, fontsDir: localFontsDir, note: NOTE });
    expect(setMeta.success, JSON.stringify(setMeta)).toBe(true);
    await main("seed", id);
    const source = disk().browserProfiles[id];
    expect(source).toMatchObject({ drm: true, appUrl: "https://example.test/app", renderScaleMode: "strict", fingerprintBaseline: BASELINE, note: NOTE });
    const prefsPath = path.join(USERDATA, "profiles", id, "Default", "Preferences");
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    fs.writeFileSync(prefsPath, JSON.stringify({ profile: { name: "synthetic-f08" } }));
    const exported = await h.page.evaluate(({ id, zipPath }) => (window as any).agentBrowser.api.profile.exportArchive(id, zipPath), { id, zipPath: ZIP_PATH });
    expect(exported).toMatchObject({ success: true, filePath: ZIP_PATH });
    const doc = zipMeta();
    expect(doc.formatVersion).toBe(1);
    expect(doc.omitted).toEqual({ fontsDir: true });
    expect(JSON.stringify(doc)).not.toContain(localFontsDir);
    expect(doc.profile).toMatchObject({
      drm: true, appUrl: "https://example.test/app", renderScaleMode: "strict",
      windowTitlePrefix: null, preset: "amazon-seller-us", fingerprintBaseline: BASELINE, note: NOTE,
      extensions: { [EXT_ID]: true }, proxyMode: "named", proxyName: "absent_f08_proxy",
    });
    for (const field of ["lock", "syncedAt", "syncedHash", "updatedAt", "fontsDir"]) expect(doc.profile).not.toHaveProperty(field);
    const byteCount = fs.statSync(ZIP_PATH).size;
    expect(byteCount).toBeGreaterThan(0);

    const before = Date.now();
    const ipc = await h.page.evaluate((zipPath) => (window as any).agentBrowser.api.profile.importArchive(zipPath), ZIP_PATH);
    expect(ipc.success, JSON.stringify(ipc)).toBe(true);
    expect(ipc.dirId).not.toBe(id);
    expect(ipc.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/Named proxy.*not included/i),
      expect.stringMatching(/Extension.*not included/i),
      expect.stringMatching(/fonts directory.*not included/i),
    ]));
    const restored = disk().browserProfiles[ipc.dirId];
    expect(restored).toMatchObject({
      drm: true, appUrl: "https://example.test/app", renderScaleMode: "strict",
      windowTitlePrefix: null, preset: "amazon-seller-us", fingerprintBaseline: BASELINE, note: NOTE,
      extensions: { [EXT_ID]: true }, proxyMode: "named", proxyName: "absent_f08_proxy",
    });
    expect(restored.updatedAt).toBeGreaterThanOrEqual(before);
    expect(restored.fontsDir).toBeNull();
    for (const field of ["lock", "syncedAt", "syncedHash"]) expect(restored).not.toHaveProperty(field);
    expect(JSON.parse(fs.readFileSync(path.join(USERDATA, "profiles", ipc.dirId, "Default", "Preferences"), "utf8")).profile.name).toBe("synthetic-f08");
    expect(await main("reload", ipc.dirId)).toMatchObject({ drm: true, renderScaleMode: "strict", fingerprintBaseline: BASELINE, note: NOTE });
    const list: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
    expect(list.filter((p) => p.dirId === ipc.dirId)).toHaveLength(1);
    expect(list.find((p) => p.dirId === ipc.dirId)).toMatchObject({ drm: true, appUrl: "https://example.test/app", renderScaleMode: "strict", note: NOTE });
    const byId = await request(port, token, "GET", `/api/profiles/${ipc.dirId}`);
    expect(byId).toMatchObject({ status: 200, body: { drm: true, appUrl: "https://example.test/app", renderScaleMode: "strict", fingerprintBaseline: BASELINE, note: NOTE } });
    expect(fs.realpathSync((await h.page.evaluate((profileId) => (window as any).agentBrowser.api.profile.get(profileId), ipc.dirId)).path))
      .toBe(fs.realpathSync(path.join(USERDATA, "profiles", ipc.dirId)));
    expect((await request(port, token, "GET", "/health", undefined, false)).body.profiles).toBe(2);

    const beforeDenied = fs.readFileSync(CONFIG_PATH);
    expect((await request(port, token, "POST", "/api/profiles/import", { zipPath: ZIP_PATH }, false)).status).toBe(401);
    expect(fs.readFileSync(CONFIG_PATH)).toEqual(beforeDenied);
    await main("role", "viewer");
    const viewerConfig = fs.readFileSync(CONFIG_PATH);
    expect((await request(port, token, "POST", "/api/profiles/import", { zipPath: ZIP_PATH })).status).toBe(403);
    expect((await request(port, token, "POST", "/api/profiles/import-batch", { zipPaths: [ZIP_PATH] })).status).toBe(403);
    const deniedIpc = await h.page.evaluate((zipPath) => (window as any).agentBrowser.api.profile.importArchive(zipPath), ZIP_PATH);
    expect(deniedIpc.success).toBe(false);
    expect(fs.readFileSync(CONFIG_PATH)).toEqual(viewerConfig);
    expect(Object.keys(disk().browserProfiles)).toHaveLength(2);
    await main("role", "owner");
    const rest = await request(port, token, "POST", "/api/profiles/import", { zipPath: ZIP_PATH });
    expect(rest.status, JSON.stringify(rest.body)).toBe(200);
    expect(rest.body.success).toBe(true);
    expect(rest.body.warnings).toHaveLength(3);
    expect(rest.body.dirId).not.toBe(ipc.dirId);
    expect(disk().browserProfiles[rest.body.dirId].fingerprintBaseline).toEqual(BASELINE);
    expect(disk().browserProfiles[rest.body.dirId].note).toBe(NOTE);
    expect(await main("reload", rest.body.dirId)).toMatchObject({ drm: true, note: NOTE });
    expect((await request(port, token, "GET", `/api/profiles/${rest.body.dirId}`)).body).toMatchObject({ drm: true, note: NOTE });
    expect(Object.keys(disk().browserProfiles).filter((key) => key === rest.body.dirId)).toHaveLength(1);
  }, 120_000);

  it("shows dependency help in the real Profiles import flow", async () => {
    const beforeIds = new Set(Object.keys(disk().browserProfiles));
    await h.app.evaluate(async (_app, zipPath: string) => {
      const vm = process.getBuiltinModule("node:vm");
      const electron = await vm.runInThisContext('import("electron")', {
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      }) as typeof import("electron");
      const d = electron.dialog as any;
      d.__f08OriginalOpen = d.showOpenDialog;
      d.showOpenDialog = async () => ({ canceled: false, filePaths: [zipPath] });
    }, ZIP_PATH);
    try {
      await h.page.evaluate(() => (window as any).agentBrowser.importProfileArchive());
      await h.page.waitForFunction(() => {
        const toast = document.querySelector(".toast-warn .toast-msg");
        return toast && /dependency warnings|依赖需检查/.test(toast.textContent || "");
      });
      const text = await h.page.locator(".toast-warn .toast-msg").last().textContent();
      expect(text).toMatch(/proxy|代理/);
      expect(text).toMatch(/extension|扩展/);
      expect(text).toMatch(/fonts|字体/);
      const after = disk().browserProfiles;
      const newIds = Object.keys(after).filter((id) => !beforeIds.has(id));
      expect(newIds).toHaveLength(1);
      expect(after[newIds[0]]).toMatchObject({ drm: true, renderScaleMode: "strict", fingerprintBaseline: BASELINE, note: NOTE });
      // Count + service lookup are the durable evidence; the UI toast alone is not.
      expect(await main("reload", newIds[0])).toMatchObject({ note: NOTE });
      const list: any[] = await h.page.evaluate(() => (window as any).agentBrowser.api.browser.list());
      expect(list.filter((p) => p.dirId === newIds[0])).toHaveLength(1);
      expect(list.find((p) => p.dirId === newIds[0])?.note).toBe(NOTE);
      expect((await request(port, token, "GET", `/api/profiles/${newIds[0]}`)).body).toMatchObject({ drm: true, note: NOTE });
    } finally {
      await h.app.evaluate(async () => {
        const vm = process.getBuiltinModule("node:vm");
        const electron = await vm.runInThisContext('import("electron")', {
          importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        }) as typeof import("electron");
        const d = electron.dialog as any;
        d.showOpenDialog = d.__f08OriginalOpen;
        delete d.__f08OriginalOpen;
      });
    }
  }, 45_000);
});
