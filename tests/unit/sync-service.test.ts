import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createHmac, createHash } from "node:crypto";

vi.mock("electron", () => {
  return {
    app: {
      getPath: (name: string) => {
        if (name === "home") return path.join(os.tmpdir(), "agent-browser-sync-test-home");
        return os.tmpdir();
      },
    },
  };
});

import { __syncTestHooks, signV2, signS3Request } from "../../src/main/services/sync-service.js";
import { getProfilesDir, getConfig } from "../../src/main/services/config-manager.js";

const TEST_HOME = path.join(os.tmpdir(), "agent-browser-sync-test-home");

function tarHeader(name: string, typeFlag: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf-8");
  header.write("0000600\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(typeFlag, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function tarEntry(name: string, body: Buffer | string, typeFlag = "0"): Buffer {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const size = typeFlag === "0" ? data.length : 0;
  const padding = Buffer.alloc(Math.ceil(size / 512) * 512 - size);
  return Buffer.concat([tarHeader(name, typeFlag, size), typeFlag === "0" ? data : Buffer.alloc(0), padding]);
}

function tgz(entries: Buffer[]): Buffer {
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

describe("Sync Service — S3 V2 Signing", () => {
  const AK = "testAccessKey123";
  const SK = "testSecretKey456";

  it("generates Authorization header for PUT", () => {
    const headers = signV2({
      method: "PUT",
      objectPath: "/bucket/key.json",
      body: Buffer.from(JSON.stringify({ test: true })),
      accessKey: AK,
      secretKey: SK,
    });
    expect(headers.Authorization).toMatch(/^AWS testAccessKey123:/);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Content-MD5"]).toBeTruthy();
    expect(headers.Date).toBeTruthy();
  });

  it("generates Authorization header for GET", () => {
    const headers = signV2({ method: "GET", objectPath: "/bucket/key.json", accessKey: AK, secretKey: SK });
    expect(headers.Authorization).toMatch(/^AWS testAccessKey123:/);
    expect(headers["Content-Type"]).toBeFalsy();
    expect(headers["Content-MD5"]).toBeFalsy();
  });

  it("MD5 is valid base64", () => {
    const body = Buffer.from("hello world");
    const md5 = createHash("md5").update(body).digest("base64");
    expect(md5).toBe("XrY7u+Ae7tCTyyK7j1rNww==");
  });

  it("signature format uses AWS access key prefix", () => {
    const stringToSign = "GET\n\n\nThu, 01 Jan 2026 00:00:00 GMT\n/b/k";
    const sig = createHmac("sha1", "SK").update(stringToSign).digest("base64");
    expect(`AWS AK:${sig}`).toMatch(/^AWS AK:/);
  });
});

describe("AWS Signature V4 (signS3Request)", () => {
  const AK = "TESTACCESSKEYEXAMPLE";
  const SK = "testSecretKeyExampleForSigningOnly";
  const ENDPOINT = "https://minio.example.com";

  it("produces a well-formed AWS4 Authorization header for PUT", () => {
    const headers = signS3Request({
      method: "PUT",
      endpoint: ENDPOINT,
      objectPath: "/my-bucket/agent-browser-studio-config.json",
      body: Buffer.from(JSON.stringify({ data: "x" })),
      accessKey: AK,
      secretKey: SK,
    });
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=TESTACCESSKEYEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9-;]+, Signature=[0-9a-f]{64}$/);
    expect(headers.Authorization).toContain("SignedHeaders=");
    // content-type must be among signed headers when a body is present
    expect(headers.Authorization).toMatch(/content-type/);
    expect(headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/); // signed payload
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers.host).toBe("minio.example.com");
  });

  it("uses UNSIGNED-PAYLOAD only when body is absent", () => {
    const headers = signS3Request({
      method: "GET",
      endpoint: ENDPOINT,
      objectPath: "/my-bucket/key",
      accessKey: AK,
      secretKey: SK,
    });
    expect(headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
  });

  it("canonical request signs the actual payload hash (deterministic)", () => {
    const body = Buffer.from("hello");
    const h1 = signS3Request({ method: "PUT", endpoint: ENDPOINT, objectPath: "/b/k", body, accessKey: AK, secretKey: SK });
    const expectedHash = createHash("sha256").update(body).digest("hex");
    expect(h1["x-amz-content-sha256"]).toBe(expectedHash);
  });

  it("different bodies produce different signatures", () => {
    const h1 = signS3Request({ method: "PUT", endpoint: ENDPOINT, objectPath: "/b/k", body: Buffer.from("a"), accessKey: AK, secretKey: SK });
    const h2 = signS3Request({ method: "PUT", endpoint: ENDPOINT, objectPath: "/b/k", body: Buffer.from("b"), accessKey: AK, secretKey: SK });
    const sig1 = h1.Authorization!.split("Signature=")[1];
    const sig2 = h2.Authorization!.split("Signature=")[1];
    expect(sig1).not.toBe(sig2);
  });

  it("encodes object path segments but preserves slashes", () => {
    const headers = signS3Request({
      method: "GET",
      endpoint: ENDPOINT,
      objectPath: "/my-bucket/path with space/file.json",
      accessKey: AK,
      secretKey: SK,
    });
    // The Authorization header must still build (signature computed over the
    // percent-encoded canonical URI). Presence of a 64-hex signature proves it.
    expect(headers.Authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it("host header is derived from endpoint (with port)", () => {
    const headers = signS3Request({
      method: "GET",
      endpoint: "http://127.0.0.1:9000",
      objectPath: "/b/k",
      accessKey: AK,
      secretKey: SK,
    });
    expect(headers.host).toBe("127.0.0.1:9000");
  });
});

describe("Sync service hardening", () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("rejects invalid Preferences JSON before callers overwrite existing files", () => {
    expect(() => __syncTestHooks.validatePreferencesJson(Buffer.from("[]"))).toThrow(/object/);
    expect(() => __syncTestHooks.validatePreferencesJson(Buffer.from("{not json"))).toThrow();
    expect(() => __syncTestHooks.validatePreferencesJson(Buffer.from(JSON.stringify({ profile: { name: "ok" } })))).not.toThrow();
  });

  it("preserves managed browser hardware fingerprint metadata in sync-safe config", () => {
    const safe = __syncTestHooks.serializeSyncSafeConfig({
      version: 3,
      chromiumBin: "auto",
      defaultProxy: "default",
      proxies: { default: { type: "http", host: "127.0.0.1", port: 7890, username: "u", password: "p" } },
      sync: { enabled: true, endpoint: "https://example.test", bucket: "bucket-name", accessKey: "AK", secretKey: "SK" },
      browserProfiles: {
        cb_hw: {
          name: "Hardware",
          fingerprintSeed: 123,
          platform: "macos",
          timezone: "Asia/Shanghai",
          locale: "zh-CN",
          webrtcIp: "1.2.3.4",
          geolocationMode: "custom",
          geolocationLatitude: 31.2304,
          geolocationLongitude: 121.4737,
          geolocationAccuracy: 25,
          gpuVendor: "Intel Inc.",
          gpuRenderer: "Intel Iris OpenGL",
          hardwareConcurrency: 8,
          deviceMemory: 16,
          screenWidth: 1440,
          screenHeight: 900,
          storageQuota: 120000,
          taskbarHeight: 28,
          fontsDir: "/tmp/fonts",
        },
      },
      extensionRepository: {
        local_ext: {
          id: "local_ext",
          name: "Local Extension",
          version: "1.0.0",
          description: "fixture",
          source: "local",
          unpackedPath: "/Users/example/Library/Application Support/Agent Browser Studio/extension-repository/local_ext/current",
          packageHash: "a".repeat(128),
          manifestHash: "b".repeat(128),
          shared: true,
          tags: ["sync"],
          addedAt: 1,
          updatedAt: 2,
        },
      },
    } as any) as any;

    expect(safe.sync.accessKey).toBeUndefined();
    expect(safe.proxies.default.password).toBeUndefined();
    expect(safe.browserProfiles.cb_hw).toMatchObject({
      gpuVendor: "Intel Inc.",
      gpuRenderer: "Intel Iris OpenGL",
      hardwareConcurrency: 8,
      deviceMemory: 16,
      screenWidth: 1440,
      screenHeight: 900,
      storageQuota: 120000,
      taskbarHeight: 28,
      fontsDir: null,
      geolocationMode: "custom",
      geolocationLatitude: 31.2304,
      geolocationLongitude: 121.4737,
      geolocationAccuracy: 25,
    });
    expect(safe.extensionRepository.local_ext).toMatchObject({
      id: "local_ext",
      name: "Local Extension",
      packageHash: "a".repeat(128),
      manifestHash: "b".repeat(128),
      shared: true,
      tags: ["sync"],
    });
    expect(safe.extensionRepository.local_ext.unpackedPath).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain("/Users/example");
  });

  it("strips unpackedPath from verified legacy remote extension metadata", () => {
    const safe = __syncTestHooks.sanitizeRemoteConfig({
      version: 3,
      chromiumBin: "auto",
      defaultProxy: "default",
      proxies: {},
      sync: { enabled: true, endpoint: "https://example.test", bucket: "bucket-name", accessKey: "AK", secretKey: "SK" },
      browserProfiles: {},
      extensionRepository: {
        local_abcdefgh: {
          id: "local_abcdefgh",
          name: "Legacy Extension",
          version: "1.0.0",
          description: "fixture",
          source: "local",
          unpackedPath: "/Users/example/Library/Application Support/Agent Browser Studio/extension-repository/local_abcdefgh/current",
          packageHash: "a".repeat(128),
          manifestHash: "b".repeat(128),
          shared: true,
          tags: ["sync"],
          addedAt: 1,
          updatedAt: 2,
        },
      },
    } as any) as any;

    expect(safe.sync).toBeUndefined();
    expect(safe.extensionRepository.local_abcdefgh).toMatchObject({
      id: "local_abcdefgh",
      name: "Legacy Extension",
      packageHash: "a".repeat(128),
      manifestHash: "b".repeat(128),
    });
    expect(safe.extensionRepository.local_abcdefgh.unpackedPath).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain("/Users/example");
  });

  it("skips remote extension metadata without verified hashes", () => {
    const safe = __syncTestHooks.sanitizeRemoteConfig({
      version: 3,
      chromiumBin: "auto",
      defaultProxy: "default",
      proxies: {},
      sync: { enabled: true, endpoint: "https://example.test", bucket: "bucket-name", accessKey: "AK", secretKey: "SK" },
      browserProfiles: {},
      extensionRepository: {
        local_abcdefgh: {
          id: "local_abcdefgh",
          name: "Unverified Extension",
          version: "1.0.0",
          description: "fixture",
          source: "local",
          packageHash: "pkg-hash",
          manifestHash: "manifest-hash",
          shared: true,
          tags: ["sync"],
        },
      },
    } as any) as any;

    expect(safe.extensionRepository.local_abcdefgh).toBeUndefined();
  });

  it("rejects oversized streamed responses before materializing them", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    const resp = new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {},
    }));

    await expect(__syncTestHooks.readResponseBytesLimited(resp, 1024 * 1024 + 1, "too large")).rejects.toThrow(/too large/);
  });

  it("rejects LocalStorage archives with symlink entries before extraction", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-ls-test-"));
    try {
      const archive = tgz([
        tarEntry("CURRENT", "MANIFEST-000001"),
        tarEntry("evil.ldb", "target", "2"),
      ]);
      expect(() => __syncTestHooks.extractSafeLocalStorageArchive(archive, outDir)).toThrow(/non-regular/);
      expect(fs.readdirSync(outDir)).toEqual([]);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("extracts only allowed LocalStorage files from regular tar entries", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-ls-test-"));
    try {
      const archive = tgz([
        tarEntry("CURRENT", "MANIFEST-000001"),
        tarEntry("000003.log", "log"),
        tarEntry("MANIFEST-000001", "manifest"),
      ]);
      expect(__syncTestHooks.extractSafeLocalStorageArchive(archive, outDir)).toEqual({ files: 3, bytesWritten: 26 });
      expect(fs.existsSync(path.join(outDir, "CURRENT"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "000003.log"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "MANIFEST-000001"))).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("does not treat a stopped LevelDB LOCK marker as a running browser", () => {
    const dirId = "cb_locked_restore";
    const lockDir = path.join(getProfilesDir(), dirId, "Default", "Local Storage", "leveldb");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "LOCK"), "");
    expect(__syncTestHooks.isProfileRunningForRestore(dirId)).toBe(false);
  });

  it("fetches remote cookies from the Agent Browser Studio sync key", async () => {
    const remoteCookies = { cb_offline: zlib.gzipSync(JSON.stringify([{ domain: "example.com", name: "sid", value: "1", path: "/", secure: false, httpOnly: true, sameSite: 0 }])).toString("base64") };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/agent-browser-studio-config.json")) return new Response(JSON.stringify({ cookies: remoteCookies }), { status: 200, headers: { "content-length": "100" } });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(__syncTestHooks.fetchRemoteCookiesForPush({
        enabled: true,
        endpoint: "https://sync.example.test",
        bucket: "agent-browser-bucket",
        accessKey: "AK",
        secretKey: "SK",
      })).resolves.toEqual(remoteCookies);
      // The current key succeeds, so no legacy fallback is needed.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain("/agent-browser-studio-config.json");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to the legacy CloakLite sync key when the current key is absent", async () => {
    const remoteCookies = { cb_legacy: zlib.gzipSync(JSON.stringify([{ domain: "example.com", name: "sid", value: "legacy", path: "/", secure: false, httpOnly: true, sameSite: 0 }])).toString("base64") };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/cloak-lite-config.json")) return new Response(JSON.stringify({ cookies: remoteCookies }), { status: 200, headers: { "content-length": "100" } });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(__syncTestHooks.fetchRemoteCookiesForPush({
        enabled: true,
        endpoint: "https://sync.example.test",
        bucket: "agent-browser-bucket",
        accessKey: "AK",
        secretKey: "SK",
      })).resolves.toEqual(remoteCookies);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain("/agent-browser-studio-config.json");
      expect(fetchMock.mock.calls[1][0]).toContain("/cloak-lite-config.json");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("propagates cancellation into remote cookie fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(__syncTestHooks.fetchRemoteCookiesForPush({
      enabled: true,
      endpoint: "https://sync.example.test",
      bucket: "agent-browser-bucket",
      accessKey: "AK",
      secretKey: "SK",
    }, controller.signal)).rejects.toThrow(/cancelled/);
  });

  it("rejects oversized remote payloads even without content-length", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {},
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));
    try {
      await expect(__syncTestHooks.fetchRemoteCookiesForPush({
        enabled: true,
        endpoint: "https://sync.example.test",
        bucket: "agent-browser-bucket",
        accessKey: "AK",
        secretKey: "SK",
      })).resolves.toEqual({});
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Sync diff preview (buildSyncDiff)", () => {
  const local = {
    defaultProxy: "default",
    browserProfiles: {
      cb_local_only: { name: "LocalOnly", fingerprintMode: "managed", fingerprintSeed: 1, platform: "windows" },
      cb_both: { name: "Both", fingerprintMode: "managed", fingerprintSeed: 5, platform: "windows", timezone: "Asia/Shanghai", syncedAt: 111, syncedHash: "abc" },
    },
    proxies: {
      default: { type: "http", host: "127.0.0.1", port: 7890 },
      local_proxy: { type: "socks5", host: "10.0.0.1", port: 1080 },
    },
    extensionRepository: {
      ext_both: { id: "ext_both", name: "Ext", version: "1.0.0", packageHash: "a".repeat(128), manifestHash: "b".repeat(128) },
    },
    accounts: [
      { platformUrl: "https://amazon.com", platformUserName: "alice", tags: ["us"] },
      { platformUrl: "https://ebay.com", platformUserName: "bob", tags: [] },
    ],
  };
  const remote = {
    defaultProxy: "default",
    browserProfiles: {
      cb_remote_only: { name: "RemoteOnly", fingerprintMode: "managed", fingerprintSeed: 2, platform: "windows" },
      cb_both: { name: "Both", fingerprintMode: "managed", fingerprintSeed: 5, platform: "windows", timezone: "Europe/Berlin", syncedAt: 222, syncedHash: "xyz" },
    },
    proxies: {
      default: { type: "http", host: "127.0.0.1", port: 7890 },
      remote_proxy: { type: "http", host: "10.0.0.2", port: 3128 },
    },
    extensionRepository: {
      ext_both: { id: "ext_both", name: "Ext", version: "2.0.0", packageHash: "a".repeat(128), manifestHash: "b".repeat(128) },
      ext_remote: { id: "ext_remote", name: "Remote Ext", version: "1.0.0", packageHash: "c".repeat(128), manifestHash: "d".repeat(128) },
    },
    accounts: [
      { platformUrl: "https://ebay.com", platformUserName: "bob", tags: [] },
      { platformUrl: "https://walmart.com", platformUserName: "carol", tags: ["us"] },
    ],
  };
  const payload = {
    cookies: { cb_both: "x", cb_remote_only: "y" },
    localStorage: { cb_both: "z" },
    preferences: { cb_remote_only: "w" },
  };

  it("classifies profiles into local-only / remote-only / changed (ignoring sync bookkeeping)", () => {
    const diff = __syncTestHooks.buildSyncDiff(local, remote, payload);
    expect(diff.profiles.localOnly).toEqual(["cb_local_only"]);
    expect(diff.profiles.remoteOnly).toEqual(["cb_remote_only"]);
    expect(diff.profiles.changed).toEqual([{ id: "cb_both", fields: ["timezone"] }]);
  });

  it("classifies proxies, extensions and accounts", () => {
    const diff = __syncTestHooks.buildSyncDiff(local, remote, payload);
    expect(diff.proxies.localOnly).toEqual(["local_proxy"]);
    expect(diff.proxies.remoteOnly).toEqual(["remote_proxy"]);
    expect(diff.proxies.changed).toEqual([]);
    expect(diff.extensions.localOnly).toEqual([]);
    expect(diff.extensions.remoteOnly).toEqual(["ext_remote"]);
    expect(diff.extensions.changed).toEqual([{ id: "ext_both", fields: ["version"] }]);
    expect(diff.accounts.localOnly).toEqual(["alice @ https://amazon.com"]);
    expect(diff.accounts.remoteOnly).toEqual(["carol @ https://walmart.com"]);
    expect(diff.accounts.changed).toEqual([]);
  });

  it("reports artifact keys and remote-only push/pull guidance", () => {
    const diff = __syncTestHooks.buildSyncDiff(local, remote, payload);
    expect(diff.artifacts).toEqual({
      cookies: ["cb_both", "cb_remote_only"],
      localStorage: ["cb_both"],
      preferences: ["cb_remote_only"],
    });
    // pushWarnings: remote-only profiles (1) + proxies (1) + extensions (1) + accounts (1)
    expect(diff.pushWarnings).toHaveLength(4);
    expect(diff.pushWarnings[0]).toContain("cb_remote_only");
    // pullNotes: remote-only profiles + remote-only proxies + changed profiles
    expect(diff.pullNotes).toHaveLength(3);
    expect(diff.pullNotes[0]).toContain("cb_remote_only");
  });

  it("reports an identical sync as clean", () => {
    const diff = __syncTestHooks.buildSyncDiff(local, local, {});
    expect(diff.profiles.localOnly).toEqual([]);
    expect(diff.profiles.remoteOnly).toEqual([]);
    expect(diff.profiles.changed).toEqual([]);
    expect(diff.pushWarnings).toEqual([]);
    expect(diff.pullNotes).toEqual([]);
  });

  it("stableStringify canonicalizes key order for deep comparison", () => {
    expect(__syncTestHooks.stableStringify({ b: 1, a: { d: 2, c: 3 } }))
      .toBe(__syncTestHooks.stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("mergeAccountArrays keeps remote-only accounts and prefers local on duplicates", () => {
    const remoteAccs = [
      { platformUrl: "https://a.com", platformUserName: "u1", tags: ["r"] },
      { platformUrl: "https://b.com", platformUserName: "u2" },
    ];
    const localAccs = [
      { platformUrl: "https://a.com", platformUserName: "u1", tags: ["l"] },
      { platformUrl: "https://c.com", platformUserName: "u3" },
    ];
    const merged = __syncTestHooks.mergeAccountArrays(remoteAccs as any, localAccs as any);
    expect(merged).toHaveLength(3);
    expect(merged.find((a: any) => a.platformUrl === "https://a.com").tags).toEqual(["l"]);
    expect(merged.some((a: any) => a.platformUrl === "https://b.com")).toBe(true);
    expect(merged.some((a: any) => a.platformUrl === "https://c.com")).toBe(true);
  });

  it("serializeSyncSafeConfig strips account passwords", () => {
    const safe = __syncTestHooks.serializeSyncSafeConfig({
      version: 4,
      defaultProxy: "default",
      sync: { enabled: true, endpoint: "https://x", bucket: "b", accessKey: "AK", secretKey: "SK" },
      browserProfiles: {},
      accounts: [{ platformUrl: "https://amazon.com", platformUserName: "alice", platformPassword: "s3cr3t", tags: ["us"] }],
    } as any) as any;
    expect(safe.accounts).toHaveLength(1);
    expect(safe.accounts[0].platformUserName).toBe("alice");
    expect(safe.accounts[0].platformPassword).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain("s3cr3t");
  });
});

describe("Sync team profile locks", () => {
  it("serializeSyncSafeConfig carries profile locks", () => {
    const safe = __syncTestHooks.serializeSyncSafeConfig({
      version: 4,
      defaultProxy: "default",
      sync: { enabled: true, endpoint: "https://x", bucket: "b", accessKey: "AK", secretKey: "SK" },
      browserProfiles: {
        cb_locked: { name: "Locked", fingerprintMode: "managed", fingerprintSeed: 1, platform: "windows", lock: { owner: "d1", ownerName: "mac", at: 5 } },
      },
    } as any) as any;
    expect(safe.browserProfiles.cb_locked.lock).toEqual({ owner: "d1", ownerName: "mac", at: 5 });
  });

  it("buildSyncDiff flags profiles locked by other devices", () => {
    const local = {
      defaultProxy: "default",
      browserProfiles: { cb_a: { name: "A", fingerprintMode: "managed", fingerprintSeed: 1, platform: "windows" } },
    };
    const remote = {
      defaultProxy: "default",
      browserProfiles: {
        cb_a: { name: "A", fingerprintMode: "managed", fingerprintSeed: 1, platform: "windows" },
        cb_b: { name: "B", fingerprintMode: "managed", fingerprintSeed: 2, platform: "windows", lock: { owner: "other-device", ownerName: "Colleague Mac", at: 1 } },
        cb_c: { name: "C", fingerprintMode: "managed", fingerprintSeed: 3, platform: "windows", lock: { owner: "my-device", ownerName: "Me", at: 1 } },
      },
    };
    const diff = __syncTestHooks.buildSyncDiff(local, remote, {}, "my-device");
    expect(diff.remoteLocks).toEqual([{ id: "cb_b", ownerName: "Colleague Mac" }]);
    expect(diff.pushWarnings.some((w: string) => w.includes("锁定"))).toBe(true);
    expect(diff.pushWarnings.some((w: string) => w.includes("cb_b"))).toBe(true);
  });

  it("buildSyncDiff does not flag own-device locks", () => {
    const remote = {
      defaultProxy: "default",
      browserProfiles: {
        cb_x: { name: "X", fingerprintMode: "managed", fingerprintSeed: 1, platform: "windows", lock: { owner: "my-device", ownerName: "Me", at: 1 } },
      },
    };
    const diff = __syncTestHooks.buildSyncDiff({ defaultProxy: "default", browserProfiles: {} }, remote, {}, "my-device");
    expect(diff.remoteLocks).toEqual([]);
  });

  it("collectRemoteLocksBlockingPush returns profiles locked by another device", async () => {
    const cfg = getConfig();
    const myDevice = cfg.deviceId || "";
    const remoteCfg = {
      version: 4,
      defaultProxy: "default",
      proxies: {},
      browserProfiles: {
        cb_other: { name: "A", fingerprintMode: "managed", fingerprintSeed: 1, platform: "windows", lock: { owner: "other-device", ownerName: "Colleague Mac", at: 1 } },
        cb_me: { name: "B", fingerprintMode: "managed", fingerprintSeed: 2, platform: "windows", lock: { owner: myDevice, ownerName: "Me", at: 1 } },
      },
    };
    const payload = JSON.stringify({ version: 4, timestamp: 123, data: zlib.gzipSync(JSON.stringify(remoteCfg)).toString("base64"), cookies: {}, localStorage: {}, preferences: {} });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/agent-browser-studio-config.json")) return new Response(payload, { status: 200, headers: { "content-length": String(Buffer.byteLength(payload)) } });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const blocked = await __syncTestHooks.collectRemoteLocksBlockingPush({
        enabled: true,
        endpoint: "https://sync.example.test",
        bucket: "bucket",
        accessKey: "AK",
        secretKey: "SK",
      });
      expect(blocked).toEqual([{ id: "cb_other", ownerName: "Colleague Mac" }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
