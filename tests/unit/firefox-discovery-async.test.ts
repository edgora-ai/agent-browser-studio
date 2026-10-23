import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nodeFs, * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { FIREFOX_HELPER_APPS, firefoxFixturePlistJson, writeFirefoxFixturePlist, writeFirefoxRuntimeFixture } from "../helpers/firefox-runtime-package.js";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(), execFileSync: vi.fn(), spawnSync: vi.fn(), spawn: vi.fn(),
  bundled: vi.fn(), bundledSync: vi.fn(), existsSync: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(), existsSync: mocks.existsSync,
}));
vi.mock("node:child_process", () => ({
  execFile: mocks.execFile, execFileSync: mocks.execFileSync,
  spawnSync: mocks.spawnSync, spawn: mocks.spawn,
}));
vi.mock("../../src/main/services/bundled-native-browsers.js", () => ({
  bundledFirefoxBinaryPathAsync: mocks.bundled,
  bundledFirefoxBinaryPath: mocks.bundledSync,
}));
import {
  detectFirefoxVersion, detectFirefoxVersionAsync, findFirefoxBinary, findFirefoxBinaryAsync, getFirefoxStatusAsync, getFirefoxStatus,
} from "../../src/main/services/browser-engine.js";
import {
  findManagedFirefoxBinary, findManagedFirefoxBinaryAsync, listManagedFirefoxBinariesAsync,
} from "../../src/main/services/native-firefox-manager.js";
import {
  FIREFOX_CAPABILITY_PRODUCT, FIREFOX_EXPECTED_SOURCE_STAMP,
  FIREFOX_CAPABILITIES_SWITCH, FIREFOX_NATIVE_CONFIG_CAPABILITIES,
  FIREFOX_NATIVE_PARITY_CAPABILITIES, readFirefoxNativeCapabilityReportAsync,
} from "../../src/main/services/firefox-native-capabilities.js";

let rootIdentity: fs.Stats;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const actualAccess = fs.promises.access.bind(fs.promises);
const actualExistsSync = nodeFs.existsSync;
type Reply = (error: Error | null, stdout: string, stderr: string) => void;
interface FixtureResponse { report: Record<string, unknown>; version: string }
let root: string;
let cache: string;
let responses: Map<string, FixtureResponse>;

function report(capabilities: readonly string[] = FIREFOX_NATIVE_CONFIG_CAPABILITIES, version = "154.0"): Record<string, unknown> {
  return {
    product: FIREFOX_CAPABILITY_PRODUCT, capabilitySchemaVersion: 1, browserVersion: version,
    buildId: "20260902025601", sourceStamp: FIREFOX_EXPECTED_SOURCE_STAMP, capabilities,
  };
}
function markerPath(file: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(path.dirname(file), platform === "darwin" ? "XUL" : platform === "win32" ? "xul.dll" : "libxul.so");
}
function makeBinary(directory: string, value = report(), marker = true, version = "154.0", name = "firefox"): string {
  if (process.platform === "darwin" && path.basename(directory) !== "MacOS") {
    directory = path.join(directory, "Firefox.app", "Contents", "MacOS");
  }
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, "fixture data; never executable", { mode: 0o600 });
  fs.writeFileSync(markerPath(file), marker ? `prefix-"product":"${FIREFOX_CAPABILITY_PRODUCT}"-suffix` : "stock-xul");
  responses.set(file, { report: value, version });
  if (process.platform === "darwin") writeFirefoxRuntimeFixture(file, version);
  return file;
}
function install(version: string, value = report(FIREFOX_NATIVE_CONFIG_CAPABILITIES, version), marker = true, actual = version): string {
  const directory = path.join(cache, `firefox-${version}`);
  return makeBinary(process.platform === "darwin" ? path.join(directory, "Firefox.app", "Contents", "MacOS") : directory,
    value, marker, actual, process.platform === "win32" ? "firefox.exe" : "firefox");
}
function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { AGENT_BROWSER_FIREFOX_CACHE_DIR: cache, ...overrides };
}
function execute(file: string, args: readonly string[], _options: unknown, callback: Reply): object {
  if (file === "/usr/bin/plutil") {
    const output = firefoxFixturePlistJson(args);
    setImmediate(() => callback(null, output, ""));
    return {};
  }
  const response = responses.get(file);
  if (!response) throw new Error(`Unowned subprocess fixture: ${file}`);
  if (args[0] !== "--version" && args[0] !== FIREFOX_CAPABILITIES_SWITCH) throw new Error("Unexpected subprocess arguments");
  setImmediate(() => callback(null, args[0] === "--version" ? `Mozilla Firefox ${response.version}\n` : JSON.stringify(response.report), ""));
  return {};
}
function binaryCalls() {
  return mocks.execFile.mock.calls.filter(([file]) => file !== "/usr/bin/plutil");
}
function capabilityCalls(): number {
  return mocks.execFile.mock.calls.filter((call) => call[1][0] === FIREFOX_CAPABILITIES_SWITCH).length;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "firefox-discovery-fixture-")));
  rootIdentity = fs.lstatSync(root);
  cache = path.join(root, "cache");
  fs.mkdirSync(cache);
  responses = new Map();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.execFile.mockImplementation(execute);
  mocks.execFileSync.mockImplementation((file: string, args: string[]) => file === "/usr/bin/plutil"
    ? firefoxFixturePlistJson(args) : JSON.stringify(responses.get(file)!.report));
  mocks.spawnSync.mockImplementation((file: string) => ({ stdout: `Mozilla Firefox ${responses.get(file)!.version}\n`, stderr: "", status: 0 }));
  mocks.spawn.mockImplementation(() => { throw new Error("Real browser launch forbidden"); });
  mocks.bundled.mockResolvedValue(null);
  mocks.bundledSync.mockReturnValue(null);
  vi.stubEnv("HOME", root);
  vi.stubEnv("AGENT_BROWSER_FIREFOX_CACHE_DIR", cache);
  // Never touch host Firefox locations while testing the system-stock fallback.
  mocks.existsSync.mockImplementation((file) => String(file).startsWith(root + path.sep) && actualExistsSync(file));
  vi.spyOn(fs.promises, "access").mockImplementation(async (file, mode) => {
    if (!String(file).startsWith(root + path.sep)) throw Object.assign(new Error("Fixture-only access"), { code: "ENOENT" });
    return actualAccess(file, mode);
  });
});
afterEach(() => {
  for (const mock of [mocks.execFile, mocks.execFileSync, mocks.spawnSync]) {
    for (const [file, args] of mock.mock.calls) {
      const fixture = file === "/usr/bin/plutil" ? args[args.length - 1] : file;
      expect(String(fixture).startsWith(root + path.sep)).toBe(true);
    }
  }
  expect(mocks.spawn).not.toHaveBeenCalled();
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const current = fs.lstatSync(root);
  if (!current.isDirectory() || current.isSymbolicLink() ||
      current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino || fs.realpathSync(root) !== root) {
    throw new Error("Firefox discovery fixture ownership changed; preserving it");
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe.each([false, true])("Firefox bundled upgrade selection (async=%s)", (asynchronous) => {
  const discover = (overrides: NodeJS.ProcessEnv = {}) => asynchronous
    ? findFirefoxBinaryAsync(env(overrides)) : findFirefoxBinary(env(overrides));

  it.each([
    { label: "prefers the new bundle at the same version", managedVersion: "154.0", bundledVersion: "154.0", cliVersion: "154.0", preferBundled: true },
    { label: "prefers an equivalent dotted bundle version", managedVersion: "154.0", bundledVersion: "154.0.0", cliVersion: "154.0.0", preferBundled: true },
    { label: "prefers a newer bundled patch", managedVersion: "154.0", bundledVersion: "154.0.1", cliVersion: "154.0.1", preferBundled: true },
    { label: "compares bundled patch versions numerically", managedVersion: "154.0.9", bundledVersion: "154.0.10", cliVersion: "154.0.10", preferBundled: true },
    { label: "retains a newer managed installation", managedVersion: "154.0.1", bundledVersion: "154.0", cliVersion: "154.0", preferBundled: false },
    { label: "uses the actual CLI version rather than newer package metadata", managedVersion: "154.0", bundledVersion: "155.0", cliVersion: "153.0", preferBundled: false },
    { label: "retains managed when the bundled CLI version is unknown", managedVersion: "154.0", bundledVersion: "155.0", cliVersion: "unknown", preferBundled: false },
    { label: "retains managed for malformed bundled version components", managedVersion: "154.0", bundledVersion: "155.0", cliVersion: "155..0", preferBundled: false },
    { label: "retains managed for too many bundled version components", managedVersion: "154.0", bundledVersion: "155.0", cliVersion: "155.0.1.2", preferBundled: false },
  ])("$label", async ({ managedVersion, bundledVersion, cliVersion, preferBundled }) => {
    const managed = install(managedVersion);
    const attested = asynchronous ? await findManagedFirefoxBinaryAsync(null, cache) : findManagedFirefoxBinary(null, cache);
    expect(attested?.binaryPath).toBe(managed);
    const bundled = makeBinary(path.join(root, "bundled-upgrade"), report(FIREFOX_NATIVE_CONFIG_CAPABILITIES, bundledVersion), true, bundledVersion);
    responses.get(bundled)!.version = cliVersion;
    mocks.bundled.mockResolvedValue(bundled);
    mocks.bundledSync.mockReturnValue(bundled);
    // Prove both probe mocks supply the requested CLI version before testing selection.
    const expectedProbe = cliVersion === "unknown" ? "Mozilla Firefox unknown" : cliVersion;
    expect(asynchronous ? await detectFirefoxVersionAsync(bundled) : detectFirefoxVersion(bundled)).toBe(expectedProbe);
    mocks.execFile.mockClear();
    mocks.spawnSync.mockClear();

    // Async version probes may legitimately reuse the identity-bound command cache.
    expect(await discover()).toBe(preferBundled ? bundled : managed);
  });

  it.each(["missing GRE omnijar", "empty browser omnijar", "developer helper"])("retains healthy managed when the bundle has %s", async (failure) => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const managed = install("154.0");
    const bundled = makeBinary(path.join(root, "broken-bundled"), report(FIREFOX_NATIVE_CONFIG_CAPABILITIES, "155.0"), true, "155.0");
    const contents = path.dirname(path.dirname(bundled));
    if (failure === "missing GRE omnijar") fs.unlinkSync(path.join(contents, "Resources", "omni.ja"));
    else if (failure === "empty browser omnijar") fs.truncateSync(path.join(contents, "Resources", "browser", "omni.ja"), 0);
    else writeFirefoxFixturePlist(path.join(contents, "MacOS", "gpu-process.app", "Contents", "Info.plist"), { MozillaDeveloperObjPath: "/missing/objdir" });
    mocks.bundled.mockResolvedValue(bundled);
    mocks.bundledSync.mockReturnValue(bundled);

    expect(await discover()).toBe(managed);
    expect(mocks.execFile.mock.calls.some(([file]) => file === bundled)).toBe(false);
    expect(mocks.spawnSync.mock.calls.some(([file]) => file === bundled)).toBe(false);
  });

  it.each(["AGENT_BROWSER_FIREFOX_BINARY_PATH", "FIREFOX_BINARY_PATH"])("preserves %s above a newer bundle and managed installation", async (key) => {
    const explicit = makeBinary(path.join(root, "explicit-upgrade"));
    install("154.0.1");
    const bundled = makeBinary(path.join(root, "newer-bundled"), report(FIREFOX_NATIVE_CONFIG_CAPABILITIES, "154.0.2"), true, "154.0.2");
    mocks.bundled.mockResolvedValue(bundled);
    mocks.bundledSync.mockReturnValue(bundled);

    expect(await discover({ [key]: explicit })).toBe(explicit);
    expect(mocks.bundled).not.toHaveBeenCalled();
    expect(mocks.bundledSync).not.toHaveBeenCalled();
    expect(binaryCalls()).toEqual([]);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("preserves the unversioned bundled fallback when no healthy managed installation exists", async () => {
    const bundled = makeBinary(path.join(root, "unversioned-bundled"));
    responses.get(bundled)!.version = "unknown";
    mocks.bundled.mockResolvedValue(bundled);
    mocks.bundledSync.mockReturnValue(bundled);

    expect(await discover()).toBe(bundled);
    expect(binaryCalls()).toEqual([]);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
});

describe("asynchronous Firefox discovery and status", () => {
  it("preserves primary/legacy override precedence and never falls back from a missing explicit override", async () => {
    const explicit = makeBinary(path.join(root, "explicit"));
    const legacy = makeBinary(path.join(root, "legacy"));
    install("154.0.1");
    mocks.bundled.mockResolvedValue(legacy);
    expect(await findFirefoxBinaryAsync(env({ AGENT_BROWSER_FIREFOX_BINARY_PATH: explicit, FIREFOX_BINARY_PATH: legacy }))).toBe(explicit);
    expect(await findFirefoxBinaryAsync(env({ FIREFOX_BINARY_PATH: legacy }))).toBe(legacy);
    const missing = env({ AGENT_BROWSER_FIREFOX_BINARY_PATH: path.join(root, "missing"), FIREFOX_BINARY_PATH: legacy, AGENT_BROWSER_FIREFOX_NATIVE: "1" });
    if (process.platform === "darwin") {
      await expect(findFirefoxBinaryAsync(missing)).rejects.toThrow(/Firefox.*runtime package/i);
      await expect(getFirefoxStatusAsync(missing)).rejects.toThrow(/Firefox.*runtime package/i);
    } else {
      expect(await findFirefoxBinaryAsync(missing)).toBeNull();
      expect(await getFirefoxStatusAsync(missing)).toMatchObject({ installed: false, path: null, version: null, nativeRequested: true, nativeConfig: false, fingerprintParity: false });
    }
    expect(mocks.bundled).not.toHaveBeenCalled();
    expect(binaryCalls()).toEqual([]);
  });

  it("retains a newer attested managed installation after checking the bundled CLI version", async () => {
    install("154.0");
    const latest = install("154.0.1");
    const bundled = makeBinary(path.join(root, "bundled"));
    mocks.bundled.mockResolvedValue(bundled);
    expect(await findFirefoxBinaryAsync(env())).toBe(latest);
    expect(mocks.bundled).toHaveBeenCalledOnce();
    expect(binaryCalls().some(([file, args]) => file === bundled && args[0] === "--version")).toBe(true);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it("uses bundled Firefox before fixture-owned system stock", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const stock = makeBinary(path.join(root, "Applications", "Firefox.app", "Contents", "MacOS"), report(), false, "139.0");
    const bundled = makeBinary(path.join(root, "bundled"));
    mocks.bundled.mockResolvedValueOnce(bundled);
    expect(await findFirefoxBinaryAsync(env())).toBe(bundled);
    expect(await findFirefoxBinaryAsync(env())).toBe(stock);
    expect(binaryCalls()).toEqual([]);
  });

  it.each([false, true])("fails explicitly for a developer override without trying healthy fallbacks (async=%s)", async (asynchronous) => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const explicit = makeBinary(path.join(root, "explicit-developer"));
    const contents = path.dirname(path.dirname(explicit));
    writeFirefoxFixturePlist(path.join(contents, "Info.plist"), {
      CFBundleShortVersionString: "154.0", MozillaDeveloperObjPath: "/missing/objdir",
    });
    fs.unlinkSync(path.join(contents, "Resources", "omni.ja"));
    install("154.0.1");
    mocks.bundled.mockResolvedValue(makeBinary(path.join(root, "healthy-bundled")));
    mocks.bundledSync.mockReturnValue(makeBinary(path.join(root, "healthy-bundled-sync")));
    const selected = env({ FIREFOX_BINARY_PATH: explicit });
    if (asynchronous) await expect(findFirefoxBinaryAsync(selected)).rejects.toThrow(/Firefox.*runtime package/i);
    else expect(() => findFirefoxBinary(selected)).toThrow(/Firefox.*runtime package/i);
    expect(mocks.bundled).not.toHaveBeenCalled();
    expect(mocks.bundledSync).not.toHaveBeenCalled();
    expect(binaryCalls()).toEqual([]);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it.each([false, true])("skips invalid managed/bundled/system candidates and rechecks hot bundled hits (async=%s)", async (asynchronous) => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const managed = install("154.0.1");
    fs.unlinkSync(path.join(path.dirname(path.dirname(managed)), "Resources", "omni.ja"));
    const bundled = makeBinary(path.join(root, "bundled"));
    mocks.bundled.mockResolvedValue(bundled);
    mocks.bundledSync.mockReturnValue(bundled);
    const stock = makeBinary(path.join(root, "Applications", "Firefox.app", "Contents", "MacOS"), report(), false, "139.0");
    const discover = () => asynchronous ? findFirefoxBinaryAsync(env()) : findFirefoxBinary(env());
    expect(await discover()).toBe(bundled);
    fs.truncateSync(path.join(path.dirname(path.dirname(bundled)), "Resources", "browser", "omni.ja"), 0);
    expect(await discover()).toBe(stock);
    writeFirefoxFixturePlist(path.join(path.dirname(path.dirname(stock)), "MacOS", "gpu-process.app", "Contents", "Info.plist"), {
      MozillaDeveloperRepoPath: "/missing/repo",
    });
    expect(await discover()).toBeNull();
    expect(binaryCalls()).toEqual([]);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("preserves %s engine selection without imposing an app/omnijar layout", async (platform) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    const explicit = makeBinary(path.join(root, "plain-executable"));
    const selected = env({ AGENT_BROWSER_FIREFOX_BINARY_PATH: explicit });
    expect(findFirefoxBinary(selected)).toBe(explicit);
    expect(await findFirefoxBinaryAsync(selected)).toBe(explicit);
    const managed = install("154.0");
    expect(findFirefoxBinary(env())).toBe(managed);
    expect(await findFirefoxBinaryAsync(env())).toBe(managed);
    fs.unlinkSync(managed);
    const bundled = makeBinary(path.join(root, "bundled-plain"));
    mocks.bundled.mockResolvedValue(bundled);
    mocks.bundledSync.mockReturnValue(bundled);
    expect(findFirefoxBinary(env())).toBe(bundled);
    expect(await findFirefoxBinaryAsync(env())).toBe(bundled);
    expect(mocks.execFile.mock.calls.some(([file]) => file === "/usr/bin/plutil")).toBe(false);
    expect(mocks.execFileSync.mock.calls.some(([file]) => file === "/usr/bin/plutil")).toBe(false);
  });

  it("returns not installed when all fixture-isolated sources are absent", async () => {
    expect(await getFirefoxStatusAsync(env())).toMatchObject({ installed: false, managedInjection: "none", sourceStamp: null, nativeCapabilities: [] });
  });

  it("reports stock Firefox without attestation and native-only mode fails closed", async () => {
    const file = makeBinary(path.join(root, "stock"), report(), false, "139.0");
    const value = await getFirefoxStatusAsync(env({ AGENT_BROWSER_FIREFOX_BINARY_PATH: file, AGENT_BROWSER_FIREFOX_NATIVE: "1" }));
    expect(value).toMatchObject({ installed: true, version: "139.0", fingerprintParity: false, nativeConfig: false, managedInjection: "prefs+bidi-preload", sourceStamp: null });
    expect(value.hint).toContain("launch will fail closed");
    expect(capabilityCalls()).toBe(0);
  });

  it.each([
    { capabilities: [], nativeConfig: false, parity: false },
    { capabilities: [...FIREFOX_NATIVE_CONFIG_CAPABILITIES], nativeConfig: true, parity: false },
    { capabilities: [...FIREFOX_NATIVE_PARITY_CAPABILITIES], nativeConfig: true, parity: true },
    { capabilities: [...FIREFOX_NATIVE_PARITY_CAPABILITIES].filter((value) => value !== "snapshot-v1"), nativeConfig: false, parity: false },
  ])("derives sync/async status from the same required capability sets ($nativeConfig/$parity)", async ({ capabilities, nativeConfig, parity }) => {
    const file = makeBinary(path.join(root, "native"), report(capabilities));
    const selected = env({ AGENT_BROWSER_FIREFOX_BINARY_PATH: file });
    const status = await getFirefoxStatusAsync(selected);
    expect(status).toEqual(getFirefoxStatus(selected));
    expect(status).toMatchObject({ nativeConfig, fingerprintParity: parity, managedInjection: parity ? "native" : "prefs+bidi-preload" });
    const requested = await getFirefoxStatusAsync({ ...selected, AGENT_BROWSER_FIREFOX_NATIVE: "1" });
    expect(requested.managedInjection).toBe(nativeConfig ? "native" : "prefs+bidi-preload");
    expect(requested.fingerprintParity).toBe(parity);
  });

  it("discards status when XUL changes after attestation while the version probe is pending", async () => {
    const file = makeBinary(path.join(root, "status-race"), report(FIREFOX_NATIVE_PARITY_CAPABILITIES));
    let finishVersion!: Reply;
    mocks.execFile.mockImplementation((binary, args, options, callback: Reply) => {
      if (args[0] === "--version") { finishVersion = callback; return {}; }
      return execute(binary, args, options, callback);
    });
    const pending = getFirefoxStatusAsync(env({ AGENT_BROWSER_FIREFOX_BINARY_PATH: file }));
    await vi.waitFor(() => expect(typeof finishVersion).toBe("function"));
    // Ensure the report has completed its own post-response identity check.
    expect(await readFirefoxNativeCapabilityReportAsync(file)).not.toBeNull();
    fs.writeFileSync(markerPath(file), "stock XUL replaced after completed attestation");
    finishVersion(null, "Mozilla Firefox 154.0\n", "");
    await expect(pending).rejects.toMatchObject({
      message: "Firefox binary or XUL changed while status was being checked; retry discovery.",
      code: "FIREFOX_SELECTION_CHANGED",
      retryable: true,
    });
  });

  it.each([false, true])("rejects CMD expansion, escape, and quote syntax in Windows shim paths (async=%s)", async (asynchronous) => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    // A double quote is not a legal Windows filename; keep a real on-disk
    // CMD metacharacter there and retain the quote case on hosts that support it.
    const quoteOrOperator = originalPlatform.value === "win32" ? "firefox&.cmd" : 'firefox".cmd';
    for (const name of ["firefox%PAYLOAD%.cmd", "firefox^.cmd", quoteOrOperator, "firefox'.cmd"]) {
      const file = makeBinary(path.join(root, name.replace(/[^a-z]/g, "_")), report(), false, "154.0", name);
      expect(await (asynchronous ? detectFirefoxVersionAsync(file) : detectFirefoxVersion(file))).toBeNull();
    }
    expect(binaryCalls()).toEqual([]);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("keeps simple Windows shim fallback compatible in synchronous and asynchronous probes", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const file = makeBinary(path.join(root, "simple-shim"), report(), false, "154.0", "firefox.cmd");
    mocks.spawnSync.mockImplementation((_binary, _args, options) => options.shell
      ? { stdout: "Mozilla Firefox 154.0", stderr: "", status: 0 }
      : { stdout: "", stderr: "", status: null, error: new Error("ENOEXEC") });
    expect(detectFirefoxVersion(file)).toBe("154.0");
    expect(mocks.spawnSync.mock.calls.map((call) => call[2].shell)).toEqual([false, true]);
    mocks.execFile.mockImplementation((binary, args, options, callback: Reply) => {
      if (!options.shell) { setImmediate(() => callback(new Error("ENOEXEC"), "", "")); return {}; }
      return execute(binary, args, options, callback);
    });
    expect(await detectFirefoxVersionAsync(file)).toBe("154.0");
    expect(mocks.execFile.mock.calls.map((call) => call[2].shell)).toEqual([false, true]);
  });

  it("keeps version stream precedence and raw non-Mozilla output semantics", async () => {
    const file = makeBinary(path.join(root, "version"));
    mocks.execFile.mockImplementationOnce((_file, _args, _opts, callback: Reply) => { setImmediate(() => callback(null, "", "Mozilla Firefox 138.0.1\n")); return {}; });
    expect(await detectFirefoxVersionAsync(file)).toBe("138.0.1");
    fs.appendFileSync(file, "invalidate");
    mocks.execFile.mockImplementationOnce((_file, _args, _opts, callback: Reply) => { setImmediate(() => callback(null, "custom build\n", "Mozilla Firefox 154.0")); return {}; });
    expect(await detectFirefoxVersionAsync(file)).toBe("custom build");
  });

  it("uses the same guarded Windows shim fallback attempts", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const file = makeBinary(path.join(root, "windows"), report(), false, "154.0", "firefox.cmd");
    mocks.execFile.mockImplementation((binary, args, options, callback: Reply) => {
      if (!options.shell) { setImmediate(() => callback(new Error("ENOEXEC"), "", "")); return {}; }
      return execute(binary, args, options, callback);
    });
    expect(await detectFirefoxVersionAsync(file)).toBe("154.0");
    expect(mocks.execFile.mock.calls.map((call) => call[2].shell)).toEqual([false, true]);
    for (const value of ["evil.cmd & calc.exe", "evil;id", "evil`id`", "evil$(id)", "evil\ncmd"]) expect(await detectFirefoxVersionAsync(value)).toBeNull();
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });
});

describe("managed Firefox attestation and async XUL identity cache", () => {
  it("requires actual/directory/report version equality, complete config capabilities, and numerical ordering", async () => {
    const first = install("154.0");
    install("154.0.1");
    install("154.0.2", report(FIREFOX_NATIVE_CONFIG_CAPABILITIES, "154.0.2"), false);
    install("154.0.3", report(FIREFOX_NATIVE_CONFIG_CAPABILITIES, "154.0.3"), true, "154.0");
    install("154.0.4", report(FIREFOX_NATIVE_CONFIG_CAPABILITIES, "154.0"));
    install("154.0.5", report(["config-v1"], "154.0.5"));
    fs.mkdirSync(path.join(cache, "firefox-154.0.6"));
    expect((await listManagedFirefoxBinariesAsync(cache)).map((value) => value.version)).toEqual(["154.0.1", "154.0"]);
    expect((await findManagedFirefoxBinaryAsync("154.0", cache))?.binaryPath).toBe(first);
    expect(await findManagedFirefoxBinaryAsync("155.0", cache)).toBeNull();
    await expect(findManagedFirefoxBinaryAsync("154", cache)).rejects.toThrow("Invalid Firefox version");
    expect(await listManagedFirefoxBinariesAsync(path.join(root, "absent"))).toEqual([]);
  });

  it.each(["omni.ja", "browser/omni.ja", ...FIREFOX_HELPER_APPS, "version"])("revalidates macOS package %s despite cached version/capability probes", async (mutation) => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const file = install("154.0.1");
    const contents = path.dirname(path.dirname(file));
    expect((await findManagedFirefoxBinaryAsync("154.0.1", cache))?.binaryPath).toBe(file);
    const attested = capabilityCalls();
    if (mutation.endsWith("omni.ja")) fs.unlinkSync(path.join(contents, "Resources", mutation));
    else if (mutation === "version") writeFirefoxFixturePlist(path.join(contents, "Info.plist"), {
      CFBundleShortVersionString: "154.0.2", CFBundleVersion: "154.0.2",
    });
    else writeFirefoxFixturePlist(path.join(contents, "MacOS", mutation, "Contents", "Info.plist"), { MozillaDeveloperObjPath: "" });
    expect(await findManagedFirefoxBinaryAsync("154.0.1", cache)).toBeNull();
    expect(capabilityCalls()).toBe(attested);
  });

  it.each(["154.0a1", "154.0.1.2"])("does not truncate the full probe version %s before comparison", async (actual) => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const version = actual === "154.0a1" ? "154.0" : "154.0.1";
    const file = install(version, report(FIREFOX_NATIVE_CONFIG_CAPABILITIES, version), true, actual);
    writeFirefoxFixturePlist(path.join(path.dirname(path.dirname(file)), "Info.plist"), {
      CFBundleShortVersionString: version, CFBundleVersion: version,
    });
    expect(await findManagedFirefoxBinaryAsync(version, cache)).toBeNull();
  });

  it("rejects package changes while the separate version probe is pending", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const file = install("154.0");
    let finishVersion!: Reply;
    mocks.execFile.mockImplementation((binary, args, options, callback: Reply) => {
      if (args[0] === "--version") { finishVersion = callback; return {}; }
      return execute(binary, args, options, callback);
    });
    const pending = findManagedFirefoxBinaryAsync("154.0", cache);
    await vi.waitFor(() => expect(typeof finishVersion).toBe("function"));
    fs.unlinkSync(path.join(path.dirname(path.dirname(file)), "Resources", "omni.ja"));
    finishVersion(null, "Mozilla Firefox 154.0\n", "");
    expect(await pending).toBeNull();
  });

  it.each([
    { product: "stock-firefox" }, { capabilitySchemaVersion: 2 }, { browserVersion: "153.0" },
    { buildId: "20260902" }, { sourceStamp: "0".repeat(40) },
    { capabilities: ["config-v1", "config-v1"] }, { capabilities: ["invalid capability"] }, { capabilities: "config-v1" },
  ])("rejects malformed or wrong-provenance reports %j", async (mutation) => {
    const file = makeBinary(path.join(root, "invalid"), { ...report(), ...mutation });
    expect(await readFirefoxNativeCapabilityReportAsync(file)).toBeNull();
  });

  it("does not execute stock/missing-marker/missing-binary files and isolates platform marker paths", async () => {
    const file = makeBinary(path.join(root, "stock"), report(), false);
    expect(await readFirefoxNativeCapabilityReportAsync(file)).toBeNull();
    fs.unlinkSync(markerPath(file));
    expect(await readFirefoxNativeCapabilityReportAsync(file)).toBeNull();
    expect(await readFirefoxNativeCapabilityReportAsync(path.join(root, "missing"))).toBeNull();
    fs.writeFileSync(path.join(path.dirname(file), "XUL"), `"product":"${FIREFOX_CAPABILITY_PRODUCT}"`);
    fs.writeFileSync(path.join(path.dirname(file), "xul.dll"), "stock-xul");
    expect(await readFirefoxNativeCapabilityReportAsync(file, "darwin")).not.toBeNull();
    expect(await readFirefoxNativeCapabilityReportAsync(file, "win32")).toBeNull();
    expect(capabilityCalls()).toBe(1);
  });

  it("scans XUL asynchronously with fixed chunks and finds a marker spanning the chunk boundary", async () => {
    const file = makeBinary(path.join(root, "large"));
    const token = Buffer.from(`"product":"${FIREFOX_CAPABILITY_PRODUCT}"`);
    const content = Buffer.alloc(8 * 1024 * 1024, 120);
    token.copy(content, content.length - 64 * 1024 - 8);
    fs.writeFileSync(markerPath(file), content);
    let finished = false;
    const pending = readFirefoxNativeCapabilityReportAsync(file);
    void pending.then(() => { finished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(await pending).not.toBeNull();
    expect(mocks.execFile.mock.calls[0][2]).toMatchObject({ timeout: 3000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true });
  });

  it("caches definitive stock-marker absence by identity without repeating XUL reads", async () => {
    const actualOpen = fs.promises.open.bind(fs.promises);
    let reads = 0;
    const opened = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      handle.read = new Proxy(handle.read, {
        apply(target, receiver, argumentsList) { reads++; return Reflect.apply(target, receiver, argumentsList); },
      });
      return handle;
    });
    const stock = makeBinary(path.join(root, "negative-cache"), report(), false);
    fs.writeFileSync(markerPath(stock), Buffer.alloc(128 * 1024, 120));
    expect(await readFirefoxNativeCapabilityReportAsync(stock)).toBeNull();
    const stockReads = reads;
    expect(stockReads).toBe(2);
    expect(await readFirefoxNativeCapabilityReportAsync(stock)).toBeNull();
    expect(reads).toBe(stockReads);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(capabilityCalls()).toBe(0);

    const control = makeBinary(path.join(root, "positive-control"));
    expect(await readFirefoxNativeCapabilityReportAsync(control)).not.toBeNull();
    expect(reads).toBe(stockReads + 1);
    expect(await readFirefoxNativeCapabilityReportAsync(control)).not.toBeNull();
    expect(reads).toBe(stockReads + 1);
    expect(capabilityCalls()).toBe(1);
    fs.writeFileSync(markerPath(stock), `"product":"${FIREFOX_CAPABILITY_PRODUCT}"`);
    expect(await readFirefoxNativeCapabilityReportAsync(stock)).not.toBeNull();
    expect(reads).toBe(stockReads + 2);
    expect(capabilityCalls()).toBe(2);
  });

  it("retries XUL I/O errors instead of retaining a negative cache entry", async () => {
    const file = makeBinary(path.join(root, "io-retry"));
    const opened = vi.spyOn(fs.promises, "open").mockRejectedValueOnce(Object.assign(new Error("temporary I/O failure"), { code: "EIO" }));
    expect(await readFirefoxNativeCapabilityReportAsync(file)).toBeNull();
    expect(await readFirefoxNativeCapabilityReportAsync(file)).not.toBeNull();
    expect(opened).toHaveBeenCalledTimes(2);
    expect(capabilityCalls()).toBe(1);
  });

  it("bounds XUL scanning by its deadline and retries without retaining that failure", async () => {
    const file = makeBinary(path.join(root, "scan-deadline"));
    const content = Buffer.alloc(128 * 1024, 120);
    Buffer.from(`"product":"${FIREFOX_CAPABILITY_PRODUCT}"`).copy(content, 100_000);
    fs.writeFileSync(markerPath(file), content);
    let ticks = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => ++ticks <= 2 ? 0 : 4000);
    try {
      expect(await readFirefoxNativeCapabilityReportAsync(file)).toBeNull();
      expect(capabilityCalls()).toBe(0);
    } finally {
      clock.mockRestore();
    }
    expect(await readFirefoxNativeCapabilityReportAsync(file)).not.toBeNull();
    expect(capabilityCalls()).toBe(1);
  });

  it("coalesces probes and invalidates binary/XUL identity independently", async () => {
    const file = makeBinary(path.join(root, "cache"));
    const values = await Promise.all(Array.from({ length: 8 }, () => readFirefoxNativeCapabilityReportAsync(file)));
    expect(values.every((value) => value === values[0])).toBe(true);
    await readFirefoxNativeCapabilityReportAsync(file);
    expect(capabilityCalls()).toBe(1);
    const marker = markerPath(file);
    const before = fs.statSync(marker);
    responses.get(file)!.report = report(FIREFOX_NATIVE_PARITY_CAPABILITIES);
    // Preserve size + mtime; ctime/identity must still invalidate XUL attestation.
    fs.writeFileSync(marker, `prefix-"product":"${FIREFOX_CAPABILITY_PRODUCT}"-suffix`);
    fs.utimesSync(marker, before.atime, before.mtime);
    expect((await readFirefoxNativeCapabilityReportAsync(file))?.capabilities).toEqual(FIREFOX_NATIVE_PARITY_CAPABILITIES);
    expect(capabilityCalls()).toBe(2);
    fs.appendFileSync(file, "changed binary");
    await readFirefoxNativeCapabilityReportAsync(file);
    expect(capabilityCalls()).toBe(3);
    fs.unlinkSync(marker);
    expect(await readFirefoxNativeCapabilityReportAsync(file)).toBeNull();
  });

  it("retries transient capability subprocess failures and malformed output", async () => {
    const file = makeBinary(path.join(root, "retry"));
    mocks.execFile.mockImplementationOnce((_file, _args, _opts, callback: Reply) => { setImmediate(() => callback(new Error("ETIMEDOUT"), "", "")); return {}; });
    expect(await readFirefoxNativeCapabilityReportAsync(file)).toBeNull();
    mocks.execFile.mockImplementationOnce((_file, _args, _opts, callback: Reply) => { setImmediate(() => callback(null, "not JSON", "")); return {}; });
    expect(await readFirefoxNativeCapabilityReportAsync(file)).toBeNull();
    expect(await readFirefoxNativeCapabilityReportAsync(file)).not.toBeNull();
    expect(capabilityCalls()).toBe(3);
  });

  it("rechecks XUL after the subprocess response before publishing attestation", async () => {
    const file = makeBinary(path.join(root, "race"));
    let finish!: Reply;
    mocks.execFile.mockImplementationOnce((_file, _args, _opts, callback: Reply) => { finish = callback; return {}; });
    const pending = readFirefoxNativeCapabilityReportAsync(file);
    await vi.waitFor(() => expect(capabilityCalls()).toBe(1));
    fs.writeFileSync(markerPath(file), "replaced stock XUL");
    finish(null, JSON.stringify(report()), "");
    expect(await pending).toBeNull();
    expect(await readFirefoxNativeCapabilityReportAsync(file)).toBeNull();
    expect(capabilityCalls()).toBe(1);
  });

  it("bounds capability identity entries to 64", async () => {
    const files = Array.from({ length: 65 }, (_, index) => makeBinary(path.join(root, `entry-${index}`)));
    for (const file of files) expect(await readFirefoxNativeCapabilityReportAsync(file)).not.toBeNull();
    await readFirefoxNativeCapabilityReportAsync(files[0]);
    expect(capabilityCalls()).toBe(66);
  });
});
