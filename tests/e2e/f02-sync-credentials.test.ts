// F02: pull must preserve *local-only* credentials for the same identity,
// without exporting them or lending them to a changed proxy target/account.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as zlib from "node:zlib";
import { closeApp, setupTestApp, type TestAppHandle } from "./helpers/app.js";

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "f02-sync-credentials-"));
const CONFIG_PATH = path.join(USERDATA, "config.json");
const CONFIG_KEY = "/bucket/agent-browser-studio-config.json";
const REPO = path.resolve(__dirname, "..", "..");
const CONFIG_MANAGER_URL = pathToFileURL(path.join(REPO, "dist/main/services/config-manager.js")).href;
const LOCAL_AGENT_URL = pathToFileURL(path.join(REPO, "dist/main/services/local-agent.js")).href;
const PROXY_PASSWORD = "f02-synthetic-proxy-secret";
const ACCOUNT_PASSWORD = "f02-synthetic-account-secret";
const ATTACKER_PASSWORD = "f02-remote-untrusted-secret";
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

async function mockS3() {
  const objects = new Map<string, Buffer>();
  const server = http.createServer((req, res) => {
    if (req.url !== CONFIG_KEY) { res.writeHead(404); res.end(); return; }
    if (req.method === "GET") {
      const body = objects.get(CONFIG_KEY);
      if (!body) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-length": String(body.length) }); res.end(body);
    } else if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => { objects.set(CONFIG_KEY, Buffer.concat(chunks)); res.writeHead(200); res.end(); });
    } else { res.writeHead(405); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as any).port}`,
    read(): { envelope: any; data: any } {
      const envelope = JSON.parse(objects.get(CONFIG_KEY)!.toString("utf8"));
      const data = JSON.parse(zlib.gunzipSync(Buffer.from(envelope.data, "base64")).toString("utf8"));
      return { envelope, data };
    },
    set(data: any): void {
      const { envelope } = this.read();
      envelope.data = zlib.gzipSync(JSON.stringify(data)).toString("base64");
      envelope.timestamp = Date.now();
      objects.set(CONFIG_KEY, Buffer.from(JSON.stringify(envelope)));
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe("F02 sync credential identity and redaction", () => {
  let h: TestAppHandle;
  let s3: Awaited<ReturnType<typeof mockS3>>;

  beforeAll(async () => {
    s3 = await mockS3();
    h = await setupTestApp({ userDataDir: USERDATA });
    const environment = await h.app.evaluate(({ app }) => ({
      nodeHome: process.getBuiltinModule("os").homedir(),
      userData: app.getPath("userData"),
      envHome: process.env.HOME,
      providerKeys: Object.keys(process.env).filter((key) => /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|DEEPSEEK|COHERE|MISTRAL)_/.test(key)),
    }));
    expect(fs.realpathSync(environment.nodeHome)).toBe(fs.realpathSync(path.join(USERDATA, "test-home")));
    expect(fs.realpathSync(environment.userData)).toBe(fs.realpathSync(USERDATA));
    expect(fs.realpathSync(environment.envHome!)).toBe(fs.realpathSync(environment.nodeHome));
    expect(environment.providerKeys).toEqual([]);
    const llm = await h.page.evaluate(async () => ({
      configured: await (window as any).agentBrowserAPI.agent.llmConfig(),
      detected: await (window as any).agentBrowserAPI.agent.detectLlmConfig(),
    }));
    expect(llm.configured?.hasApiKey ?? false).toBe(false);
    expect(llm.detected?.hasApiKey ?? false).toBe(false);
    const configured = await h.page.evaluate((endpoint) => (window as any).agentBrowser.api.sync.configure({
      enabled: true, endpoint, bucket: "bucket", accessKey: "f02-local-test-key", secretKey: "f02-local-test-secret", custodyConsent: true,
    }), s3.endpoint);
    expect(configured.success).toBe(true);
    expect((await h.page.evaluate(() => (window as any).agentBrowser.api.sync.status())).custodyConsentAt).toBeGreaterThan(0);
  }, 90000);

  afterAll(async () => {
    if (h) await closeApp(h);
    if (s3) await s3.close();
    if (path.dirname(USERDATA) !== os.tmpdir() || !path.basename(USERDATA).startsWith("f02-sync-credentials-")) throw new Error("Unsafe F02 cleanup path");
    fs.rmSync(USERDATA, { recursive: true, force: true });
  }, 90000);

  async function addProxy(name: string, password: string, port = 4100) {
    const result = await h.page.evaluate(({ name, password, port }) => (window as any).agentBrowser.api.proxy.add(name, {
      type: "http", host: "proxy.example.test", port, username: "local-user", password,
    }), { name, password, port });
    expect(result.success).toBe(true);
    return readConfig().proxies[name];
  }

  async function addAccount(user: string, password: string) {
    const result = await h.page.evaluate(({ user, password }) => (window as any).agentBrowser.api.agent.accounts.add({
      platformUrl: "https://accounts.example.test", platformUserName: user, platformPassword: password, tags: ["local"],
    }), { user, password });
    expect(result.platformUserName).toBe(user);
    return readConfig().accounts.find((entry: any) => entry.platformUserName === user);
  }

  async function pull(data: any, opts: any = { strategy: "remote" }) {
    s3.set(data);
    const result = await h.page.evaluate((input) => (window as any).agentBrowser.api.sync.pull(input), opts);
    expect(result.success, result.message).toBe(true);
    return result;
  }

  async function assertProxy(name: string, expected: { type: string; host: string; port: number; password: string | null; stored?: string; username?: string }) {
    const stored = readConfig().proxies[name];
    expect(stored).toMatchObject({ type: expected.type, host: expected.host, port: expected.port });
    if (expected.stored !== undefined) expect(stored.password).toBe(expected.stored);
    if (expected.password === null) {
      expect(stored.username).toBeUndefined();
      expect(stored.password).toBeUndefined();
    } else {
      expect(stored.username).toBe(expected.username ?? "local-user");
      if (expected.password) expect(stored.password).toMatch(/^(v2:|os1:)/);
      if (expected.password) expect(JSON.stringify(readConfig())).not.toContain(expected.password);
    }
    const secret = await h.app.evaluate(async (_electron, args) => {
      const vm = process.getBuiltinModule("node:vm");
      const mod = await vm.runInThisContext(`import(${JSON.stringify(args.moduleUrl)})`, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
      const actual = mod.getProxySecret(args.name);
      return { matches: actual?.password === args.password, type: actual?.type, host: actual?.host, port: actual?.port };
    }, { moduleUrl: CONFIG_MANAGER_URL, name, password: expected.password ?? undefined });
    expect(secret).toMatchObject({ matches: true, type: expected.type, host: expected.host, port: expected.port });
    const publicGet = await h.page.evaluate((proxyName) => (window as any).agentBrowser.api.proxy.get(proxyName), name);
    const publicList = (await h.page.evaluate(() => (window as any).agentBrowser.api.proxy.list()) as any[]).find((p) => p.name === name)?.config;
    for (const result of [publicGet, publicList]) {
      expect(result).toMatchObject({ type: expected.type, host: expected.host, port: expected.port });
      expect(result.password).toBeUndefined();
      expect(result.hasAuth ?? false).toBe(expected.password !== null);
    }
  }

  async function assertAccount(user: string, password: string | null, stored?: string, url = "https://accounts.example.test") {
    const disk = readConfig();
    const index = disk.accounts.findIndex((a: any) => a.platformUserName === user && a.platformUrl === url);
    expect(index).toBeGreaterThanOrEqual(0);
    if (stored !== undefined) expect(disk.accounts[index].platformPassword).toBe(stored);
    if (password) {
      expect(disk.accounts[index].platformPassword).toMatch(/^(v2:|os1:)/);
      expect(JSON.stringify(disk)).not.toContain(password);
    } else if (stored === undefined) expect(disk.accounts[index].platformPassword ?? "").toBe("");
    const publicList = await h.page.evaluate(() => (window as any).agentBrowser.api.agent.accounts.list()) as any[];
    const publicEntry = publicList.filter((a) => a.platformUserName === user && a.platformUrl === url);
    expect(publicEntry).toHaveLength(1);
    const selectedRef = publicEntry[0].ref;
    expect(selectedRef.index).toBe(index);
    const secret = await h.app.evaluate(async (_electron, args) => {
      const vm = process.getBuiltinModule("node:vm");
      const mod = await vm.runInThisContext(`import(${JSON.stringify(args.moduleUrl)})`, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
      return mod.getAccountPassword(args.index, args.ref) === args.password;
    }, { moduleUrl: LOCAL_AGENT_URL, index: selectedRef.index, ref: selectedRef, password });
    expect(secret).toBe(true);
    expect(publicEntry[0].platformPassword).toBeUndefined();
    expect(publicEntry[0].hasPassword).toBe(Boolean(stored ?? password));
  }

  it("keeps encrypted local credentials when remote metadata wins; push uploads neither plaintext nor ciphertext", async () => {
    const localProxy = await addProxy("f02-same", PROXY_PASSWORD);
    const localAccount = await addAccount("f02-same-user", ACCOUNT_PASSWORD);
    expect(localProxy.password).toMatch(/^(v2:|os1:)/);
    expect(localAccount.platformPassword).toMatch(/^(v2:|os1:)/);
    const push = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.push());
    expect(push.success, push.message).toBe(true);
    const { data } = s3.read();
    expect(data.proxies["f02-same"].username).toBeUndefined();
    expect(data.proxies["f02-same"].password).toBeUndefined();
    expect(data.accounts.find((a: any) => a.platformUserName === "f02-same-user").platformPassword).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(localProxy.password);
    expect(JSON.stringify(data)).not.toContain(localAccount.platformPassword);
    expect(JSON.stringify(data)).not.toContain(PROXY_PASSWORD);
    expect(JSON.stringify(data)).not.toContain(ACCOUNT_PASSWORD);
    data.proxies["f02-same"].bypassList = ["api.example.test"];
    data.proxies["f02-same"].updatedAt = localProxy.updatedAt + 10000;
    const account = data.accounts.find((a: any) => a.platformUserName === "f02-same-user");
    account.tags = ["remote"];
    account.updatedAt = localAccount.updatedAt + 10000;
    await pull(data);
    expect(readConfig().proxies["f02-same"].bypassList).toEqual(["api.example.test"]);
    expect(readConfig().accounts.find((a: any) => a.platformUserName === "f02-same-user").tags).toEqual(["remote"]);
    await assertProxy("f02-same", { type: "http", host: "proxy.example.test", port: 4100, password: PROXY_PASSWORD, stored: localProxy.password });
    await assertAccount("f02-same-user", ACCOUNT_PASSWORD, localAccount.platformPassword);
    // Treat hand-edited remote credential fields as untrusted, even for this
    // same target: the only usable credentials must come from local storage.
    data.proxies["f02-same"].username = "attacker";
    data.proxies["f02-same"].password = ATTACKER_PASSWORD;
    account.platformPassword = ATTACKER_PASSWORD;
    await pull(data); // Repeated pulls must not strip or replace credentials.
    await assertProxy("f02-same", { type: "http", host: "proxy.example.test", port: 4100, password: PROXY_PASSWORD, stored: localProxy.password });
    await assertAccount("f02-same-user", ACCOUNT_PASSWORD, localAccount.platformPassword);
    expect(JSON.stringify(readConfig())).not.toContain(ATTACKER_PASSWORD);
    const afterPullPush = await h.page.evaluate(() => (window as any).agentBrowser.api.sync.push());
    expect(afterPullPush.success, afterPullPush.message).toBe(true);
    const snapshot = JSON.stringify(s3.read().data);
    for (const secret of [PROXY_PASSWORD, ACCOUNT_PASSWORD, ATTACKER_PASSWORD, localProxy.password, localAccount.platformPassword]) {
      expect(snapshot).not.toContain(secret);
    }
    expect(s3.read().data.proxies["f02-same"].username).toBeUndefined();
    expect(s3.read().data.accounts.find((a: any) => a.platformUserName === "f02-same-user").platformPassword).toBeUndefined();
  }, 60000);

  it("newest/tie/local and per-entry overrides keep the right metadata and same-target credentials", async () => {
    const old = await addProxy("f02-strategy", "f02-synthetic-strategy-secret", 4101);
    const account = await addAccount("f02-strategy-user", "f02-synthetic-strategy-account-secret");
    const { data } = s3.read();
    data.proxies["f02-strategy"] = { type: "http", host: "proxy.example.test", port: 4101, bypassList: ["new.example.test"], updatedAt: old.updatedAt + 10000 };
    data.accounts.push({ platformUserName: "f02-strategy-user", platformUrl: "https://accounts.example.test", tags: ["new"], updatedAt: account.updatedAt + 10000 });
    await pull(data, { strategy: "newest" });
    expect(readConfig().proxies["f02-strategy"].bypassList).toEqual(["new.example.test"]);
    expect(readConfig().accounts.find((a: any) => a.platformUserName === "f02-strategy-user").tags).toEqual(["new"]);
    await assertProxy("f02-strategy", { type: "http", host: "proxy.example.test", port: 4101, password: "f02-synthetic-strategy-secret", stored: old.password });
    await assertAccount("f02-strategy-user", "f02-synthetic-strategy-account-secret", account.platformPassword);
    data.proxies["f02-strategy"].bypassList = ["tied.example.test"];
    data.proxies["f02-strategy"].updatedAt = readConfig().proxies["f02-strategy"].updatedAt;
    data.accounts.find((a: any) => a.platformUserName === "f02-strategy-user").tags = ["tied"];
    data.accounts.find((a: any) => a.platformUserName === "f02-strategy-user").updatedAt = readConfig().accounts.find((a: any) => a.platformUserName === "f02-strategy-user").updatedAt;
    await pull(data, { strategy: "newest" });
    expect(readConfig().proxies["f02-strategy"].bypassList).toEqual(["new.example.test"]);
    expect(readConfig().accounts.find((a: any) => a.platformUserName === "f02-strategy-user").tags).toEqual(["new"]);
    await pull(data, { strategy: "local" });
    expect(readConfig().proxies["f02-strategy"].bypassList).toEqual(["new.example.test"]);
    expect(readConfig().accounts.find((a: any) => a.platformUserName === "f02-strategy-user").tags).toEqual(["new"]);
    await pull(data, { strategy: "remote", resolutions: { "proxies:f02-strategy": "local", "accounts:f02-strategy-user @ https://accounts.example.test": "local" } });
    expect(readConfig().proxies["f02-strategy"].bypassList).toEqual(["new.example.test"]);
    expect(readConfig().accounts.find((a: any) => a.platformUserName === "f02-strategy-user").tags).toEqual(["new"]);
    await pull(data, { strategy: "local", resolutions: { "proxies:f02-strategy": "remote", "accounts:f02-strategy-user @ https://accounts.example.test": "remote" } });
    expect(readConfig().proxies["f02-strategy"].bypassList).toEqual(["tied.example.test"]);
    expect(readConfig().accounts.find((a: any) => a.platformUserName === "f02-strategy-user").tags).toEqual(["tied"]);
    await assertProxy("f02-strategy", { type: "http", host: "proxy.example.test", port: 4101, password: "f02-synthetic-strategy-secret", stored: old.password });
    await assertAccount("f02-strategy-user", "f02-synthetic-strategy-account-secret", account.platformPassword);
  }, 60000);

  it("never lends old credentials to changed host/type/port or another account identity, nor trusts remote secrets", async () => {
    const old = await addProxy("f02-changed", "f02-synthetic-old-endpoint-secret", 4102);
    const account = await addAccount("f02-old-user", "f02-synthetic-old-account-secret");
    const { data } = s3.read();
    data.proxies["f02-changed"] = { type: "http", host: "other.example.test", port: 4102, username: "attacker", password: ATTACKER_PASSWORD, updatedAt: old.updatedAt + 10000 };
    data.accounts.push({ platformUserName: "f02-new-user", platformUrl: "https://accounts.example.test", platformPassword: ATTACKER_PASSWORD, tags: ["remote"] });
    data.accounts.push({ platformUserName: "f02-old-user", platformUrl: "https://different.example.test", platformPassword: ATTACKER_PASSWORD, tags: ["other-url"] });
    await pull(data);
    await assertProxy("f02-changed", { type: "http", host: "other.example.test", port: 4102, password: null });
    await assertAccount("f02-old-user", "f02-synthetic-old-account-secret", account.platformPassword);
    await assertAccount("f02-new-user", null);
    await assertAccount("f02-old-user", null, undefined, "https://different.example.test");
    expect(JSON.stringify(readConfig())).not.toContain(ATTACKER_PASSWORD);
    // Changing protocol or port under the same proxy name also requires reconfiguration.
    data.proxies["f02-changed"] = { type: "socks5", host: "proxy.example.test", port: 4102, username: "attacker", password: ATTACKER_PASSWORD };
    await pull(data);
    await assertProxy("f02-changed", { type: "socks5", host: "proxy.example.test", port: 4102, password: null });
    data.proxies["f02-changed"] = { type: "http", host: "proxy.example.test", port: 4103, username: "attacker", password: ATTACKER_PASSWORD };
    await pull(data);
    await assertProxy("f02-changed", { type: "http", host: "proxy.example.test", port: 4103, password: null });
    // Remote-only secrets are untrusted even if a remote snapshot was hand-edited.
    data.proxies["f02-remote-only"] = { type: "http", host: "remote.example.test", port: 4104, username: "attacker", password: ATTACKER_PASSWORD };
    await pull(data);
    await assertProxy("f02-remote-only", { type: "http", host: "remote.example.test", port: 4104, password: null });
    expect(JSON.stringify(readConfig())).not.toContain(old.password);
  }, 60000);

  it("does not invent a password for empty local credentials", async () => {
    const emptyProxy = await addProxy("f02-empty", "", 4105);
    const emptyAccount = await addAccount("f02-empty-user", "");
    expect(emptyProxy.password).toBe("");
    // The existing account-add boundary encrypts even an empty string. Preserve
    // its ciphertext unchanged; getAccountPassword intentionally reads it as null.
    expect(emptyAccount.platformPassword).toMatch(/^(v2:|os1:)/);
    const { data } = s3.read();
    data.proxies["f02-empty"] = { type: "http", host: "proxy.example.test", port: 4105, updatedAt: emptyProxy.updatedAt + 10000, bypassList: ["empty.example.test"] };
    data.accounts.push({ platformUrl: "https://accounts.example.test", platformUserName: "f02-empty-user", updatedAt: emptyAccount.updatedAt + 10000, tags: ["empty-remote"] });
    await pull(data);
    expect(readConfig().proxies["f02-empty"].password).toBe("");
    await assertProxy("f02-empty", { type: "http", host: "proxy.example.test", port: 4105, password: "", stored: "" });
    await assertAccount("f02-empty-user", null, emptyAccount.platformPassword);
  }, 60000);
});
