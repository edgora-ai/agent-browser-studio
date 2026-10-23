import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";

const fixture = vi.hoisted(() => ({
  root: "",
  renameFault: null as null | ((from: string, to: string) => string | null),
  renameFaultHits: 0,
  removeFault: null as null | ((file: string) => string | null),
  removeFaultHits: 0,
  running: new Set<string>(),
  importer: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { sep } = await import("node:path");
  const owned = (p: unknown) => fixture.root && String(p).startsWith(fixture.root + sep);
  const fail = (code: string) => { throw Object.assign(new Error(`${code}: synthetic filesystem fault`), { code }); };
  return {
    ...actual,
    renameSync: (from: any, to: any) => {
      if (owned(to)) {
        const code = fixture.renameFault?.(String(from), String(to));
        if (code) { fixture.renameFaultHits++; fail(code); }
      }
      return actual.renameSync(from, to);
    },
    rmSync: (file: any, ...args: any[]) => {
      if (owned(file)) {
        const code = fixture.removeFault?.(String(file));
        if (code) { fixture.removeFaultHits++; fail(code); }
      }
      return (actual.rmSync as any)(file, ...args);
    },
  };
});
vi.mock("electron", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  fixture.root = mkdtempSync(join(tmpdir(), "studio-sync-safety-"));
  return { app: { getPath: (name: string) => name === "home" ? join(fixture.root, "home") : fixture.root } };
});
vi.mock("../../src/main/services/browser-manager.js", () => ({
  statusBrowser: (id: string) => ({ running: fixture.running.has(id), pid: null, cdpPort: null }),
}));
vi.mock("../../src/main/services/bidi-cookie-service.js", () => ({
  runtimeCookieOps: {
    hasRunningBrowser: (id: string) => fixture.running.has(id),
    importCookies: fixture.importer,
    exportCookies: vi.fn(async () => []),
  },
}));

import { __syncTestHooks, syncService } from "../../src/main/services/sync-service.js";
import { getConfig, getConfigPath, getProfileMeta, getProfilesDir, reloadConfig, saveConfig } from "../../src/main/services/config-manager.js";
import { isRestoreLocked } from "../../src/main/services/profile-restore-lock.js";
import { writeQueuedCookieImports } from "../../src/main/services/cdp-cookie-service.js";

const ID = "ab_sync_safety";
const remoteCookie = { domain: "example.test", name: "safety", value: "synthetic-remote", path: "/", expires: null, secure: false, httpOnly: true, sameSite: 0 };
const gzip = (value: unknown) => zlib.gzipSync(JSON.stringify(value)).toString("base64");
const localStorageDir = () => path.join(getProfilesDir(), ID, "Default", "Local Storage", "leveldb");
const preferencesPath = () => path.join(getProfilesDir(), ID, "Default", "Preferences");
const queuePath = () => path.join(fixture.root, "pending-cookie-imports", `${ID}.json`);
const diskConfig = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function tarEntry(name: string, text: string): Buffer {
  const data = Buffer.from(text);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000600\0", 100, 8, "ascii");
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return Buffer.concat([header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length)]);
}
function archive(entries?: Buffer[], endBlocks = 2): Buffer {
  return zlib.gzipSync(Buffer.concat([
    ...(entries || [tarEntry("CURRENT", "MANIFEST-000002\n"), tarEntry("MANIFEST-000002", "remote-manifest"), tarEntry("000004.log", "remote-session")]),
    Buffer.alloc(512 * endBlocks),
  ]));
}
function seed(artifacts: Record<string, Record<string, string>> = {}, remoteOverrides: Record<string, unknown> = {}): { localHash: string; localPrefs: string } {
  expect(path.dirname(getProfilesDir())).toBe(fixture.root);
  expect(getConfigPath()).toBe(path.join(fixture.root, "config.json"));
  const cfg = structuredClone(getConfig());
  cfg.sync = { enabled: true, endpoint: "https://sync.example.test", bucket: "synthetic", accessKey: "synthetic-access", secretKey: "synthetic-secret", custodyConsentAt: Date.now() } as any;
  cfg.browserProfiles = { [ID]: { name: "local", engine: "chromium", fingerprintMode: "managed", fingerprintSeed: 42, platform: "windows", updatedAt: 100 } as any };
  cfg.extensionRepository = {};
  saveConfig(cfg);
  const local = localStorageDir();
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, "CURRENT"), "MANIFEST-000001\n");
  fs.writeFileSync(path.join(local, "MANIFEST-000001"), "original-manifest");
  fs.writeFileSync(path.join(local, "000003.log"), "original-session");
  fs.writeFileSync(preferencesPath(), JSON.stringify({ safety: "original" }));
  const payload = {
    timestamp: 1000,
    data: gzip({ version: 4, browserProfiles: { [ID]: { ...cfg.browserProfiles[ID], name: "remote", updatedAt: 200 } }, proxies: {}, accounts: [], ...remoteOverrides }),
    ...artifacts,
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
  return { localHash: digest(path.join(local, "000003.log")), localPrefs: digest(preferencesPath()) };
}
function assertLocalMetadata(): void {
  expect(diskConfig().browserProfiles[ID].name).toBe("local");
  expect(getProfileMeta(ID)?.name).toBe("local");
  reloadConfig();
  expect(getConfig().browserProfiles[ID].name).toBe("local");
}
function ownedCleanup(): void {
  expect(path.dirname(fixture.root)).toBe(os.tmpdir());
  expect(path.basename(fixture.root)).toMatch(/^studio-sync-safety-/);
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

beforeEach(() => {
  fixture.renameFault = null;
  fixture.renameFaultHits = 0;
  fixture.removeFault = null;
  fixture.removeFaultHits = 0;
  fixture.running.clear();
  fixture.importer.mockReset().mockImplementation(async (_id: string, cookies: unknown[]) => cookies.length);
  ownedCleanup();
  fs.mkdirSync(fixture.root, { mode: 0o700 });
  reloadConfig();
});
afterEach(() => {
  fixture.renameFault = null;
  fixture.removeFault = null;
  vi.unstubAllGlobals();
  expect(isRestoreLocked(ID)).toBe(false);
});
afterAll(ownedCleanup);

describe("sync restore data-commit safety", () => {
  it("rejects a bad TAR checksum before extracting any file", () => {
    const output = path.join(fixture.root, "extract");
    fs.mkdirSync(output);
    const tar = zlib.gunzipSync(archive());
    tar[100] ^= 1;
    expect(() => __syncTestHooks.extractSafeLocalStorageArchive(zlib.gzipSync(tar), output)).toThrow(/checksum/i);
    expect(fs.readdirSync(output)).toEqual([]);
  });

  it("rejects a CURRENT reference to a missing MANIFEST before extracting", () => {
    const output = path.join(fixture.root, "extract");
    fs.mkdirSync(output);
    expect(() => __syncTestHooks.extractSafeLocalStorageArchive(archive([tarEntry("CURRENT", "MANIFEST-000099\n")]), output)).toThrow(/manifest/i);
    expect(fs.readdirSync(output)).toEqual([]);
  });

  it("requires complete TAR end markers and rejects duplicate normalized names before writes", () => {
    const output = path.join(fixture.root, "extract");
    fs.mkdirSync(output);
    expect(() => __syncTestHooks.extractSafeLocalStorageArchive(archive(undefined, 1), output)).toThrow(/end|truncat|terminat/i);
    expect(fs.readdirSync(output)).toEqual([]);
    const duplicate = archive([tarEntry("CURRENT", "MANIFEST-000002\n"), tarEntry("./CURRENT", "MANIFEST-000002\n"), tarEntry("MANIFEST-000002", "remote")]);
    expect(() => __syncTestHooks.extractSafeLocalStorageArchive(duplicate, output)).toThrow(/duplicate/i);
    expect(fs.readdirSync(output)).toEqual([]);
  });

  it("never writes a pending-cookie queue through the legacy predictable temporary symlink", () => {
    seed();
    fs.mkdirSync(path.dirname(queuePath()), { recursive: true });
    const unrelated = path.join(fixture.root, "unrelated-owned-fixture.txt");
    fs.writeFileSync(unrelated, "untouched");
    fs.symlinkSync(unrelated, queuePath() + ".tmp");
    writeQueuedCookieImports(ID, [remoteCookie]);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("untouched");
    expect(fs.lstatSync(queuePath()).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(queuePath(), "utf8"))).toEqual([remoteCookie]);
  });

  it("rejects a symlinked queue directory without writing to its owned test target", () => {
    seed();
    const other = path.join(fixture.root, "other-owned-directory");
    fs.mkdirSync(other);
    fs.symlinkSync(other, path.dirname(queuePath()));
    expect(() => writeQueuedCookieImports(ID, [remoteCookie])).toThrow(/symlink|real directory|unsafe/i);
    expect(fs.readdirSync(other)).toEqual([]);
  });

  it("prepares all selected artifacts before queuing cookies or adopting metadata", async () => {
    const local = seed({ cookies: { [ID]: gzip([remoteCookie]) }, preferences: { [ID]: gzip([]) } });
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result.success).toBe(false);
    expect(fs.existsSync(queuePath())).toBe(false);
    expect(digest(preferencesPath())).toBe(local.localPrefs);
    expect(digest(path.join(localStorageDir(), "000003.log"))).toBe(local.localHash);
    assertLocalMetadata();
  });

  it("does not apply an earlier valid profile when a later selected profile has invalid Preferences", async () => {
    const second = "ab_sync_later";
    const local = seed({ cookies: { [ID]: gzip([remoteCookie]) }, localStorage: { [ID]: archive().toString("base64") }, preferences: { [second]: gzip([]) } }, {
      browserProfiles: { [ID]: { name: "remote", fingerprintSeed: 42 }, [second]: { name: "later", fingerprintSeed: 43 } },
    });
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result).toMatchObject({ success: false, localCommit: "none" });
    expect(fs.existsSync(queuePath())).toBe(false);
    expect(fs.existsSync(path.join(getProfilesDir(), second))).toBe(false);
    expect(digest(path.join(localStorageDir(), "000003.log"))).toBe(local.localHash);
    assertLocalMetadata();
  });

  it("validates needed extension packages before touching profile files or queues", async () => {
    const local = seed({ cookies: { [ID]: gzip([remoteCookie]) }, preferences: { [ID]: gzip({ safety: "remote" }) } }, {
      extensionRepository: { local_01234567: { id: "local_01234567", name: "synthetic extension", source: "local", packageHash: "a".repeat(128), manifestHash: "b".repeat(128) } },
    });
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result).toMatchObject({ success: false, localCommit: "none" });
    expect(fs.existsSync(queuePath())).toBe(false);
    expect(digest(preferencesPath())).toBe(local.localPrefs);
    assertLocalMetadata();
  });

  it("rejects cookies that the pending queue would silently discard before any mutation", async () => {
    seed({ cookies: { [ID]: gzip([{ ...remoteCookie, name: "invalid;name" }]) } });
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(result.success).toBe(false);
    expect(fs.existsSync(queuePath())).toBe(false);
    assertLocalMetadata();
  });

  it("does not adopt metadata when LocalStorage publication fails and compensation succeeds", async () => {
    const local = seed({ localStorage: { [ID]: archive().toString("base64") } });
    fixture.renameFault = (from, to) => to === localStorageDir() && /stage-/.test(path.basename(from)) ? "EIO" : null;
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(fixture.renameFaultHits).toBe(1);
    expect(result.success).toBe(false);
    expect(digest(path.join(localStorageDir(), "000003.log"))).toBe(local.localHash);
    assertLocalMetadata();
  });

  it("retains the only old LocalStorage copy when publication and compensation both fail", async () => {
    const local = seed({ localStorage: { [ID]: archive().toString("base64") } });
    fixture.renameFault = (from, to) => to === localStorageDir() && /stage-|backup-/.test(path.basename(from)) ? "EACCES" : null;
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(fixture.renameFaultHits).toBe(2);
    const parent = path.dirname(localStorageDir());
    const backups = fs.readdirSync(parent).filter((name) => name.startsWith(".leveldb-backup-"));
    expect(backups).toHaveLength(1);
    expect(digest(path.join(parent, backups[0], "000003.log"))).toBe(local.localHash);
    expect(result).toMatchObject({ success: false, outcome: "recovery-required" });
    fixture.renameFault = null;
    const retried = await syncService.pull(undefined, { strategy: "remote" });
    expect(retried).toMatchObject({ success: false, outcome: "recovery-required" });
    expect(digest(path.join(parent, backups[0], "000003.log"))).toBe(local.localHash);
    assertLocalMetadata();
  });

  it("reports queued cookies as a partial change when a later Preferences publish fails", async () => {
    const local = seed({ cookies: { [ID]: gzip([remoteCookie]) }, preferences: { [ID]: gzip({ safety: "remote" }) } });
    fixture.renameFault = (_from, to) => to === preferencesPath() ? "EACCES" : null;
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(fixture.renameFaultHits).toBe(1);
    expect(result).toMatchObject({ success: false, outcome: "partial", localCommit: "partial" });
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "cookies", id: ID, state: "queued" }), expect.objectContaining({ scope: "preferences", id: ID, state: "failed" })]));
    expect(JSON.parse(fs.readFileSync(queuePath(), "utf8"))).toEqual([remoteCookie]);
    expect(digest(preferencesPath())).toBe(local.localPrefs);
    assertLocalMetadata();
  });

  it("keeps committed data and reports only cleanup warnings if owned staging removal fails", async () => {
    seed({ preferences: { [ID]: gzip({ safety: "remote" }) } });
    fixture.removeFault = (file) => path.basename(file).startsWith(".sync-pull-stage-") ? "EACCES" : null;
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(fixture.removeFaultHits).toBe(1);
    expect(result).toMatchObject({ success: true, outcome: "complete", localCommit: "committed" });
    expect(result.warnings?.some((warning) => /staging.*synthetic filesystem fault/i.test(warning))).toBe(true);
    expect(JSON.parse(fs.readFileSync(preferencesPath(), "utf8"))).toEqual({ safety: "remote" });
    expect(diskConfig().browserProfiles[ID].name).toBe("remote");
    reloadConfig();
    expect(getProfileMeta(ID)?.name).toBe("remote");
  });

  it("reports an applied file separately if the later config transaction cannot commit", async () => {
    seed({ preferences: { [ID]: gzip({ safety: "remote" }) } });
    fixture.renameFault = (_from, to) => to === getConfigPath() ? "EACCES" : null;
    const result = await syncService.pull(undefined, { strategy: "remote" });
    expect(fixture.renameFaultHits).toBe(1);
    expect(result).toMatchObject({ success: false, outcome: "partial", localCommit: "partial" });
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "preferences", id: ID, state: "applied" })]));
    expect(JSON.parse(fs.readFileSync(preferencesPath(), "utf8"))).toEqual({ safety: "remote" });
    fixture.renameFault = null;
    assertLocalMetadata();
  });
});
