// Update manager unit tests — version-aware release store, staged install,
// pin + rollback and crash-loop auto-rollback.
import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// Both providers use this actual hoisted binding, not separately reconstructed
// names. Keep the root inode alive until afterAll; per-case cleanup removes only
// verified physical descendants created during this fixture lifetime.
const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-update-manager-test-")));
  const identity = fs.lstatSync(root);
  const marker = path.join(root, ".fixture-owner");
  const owner = JSON.stringify({ role: "update-manager", root, dev: identity.dev, ino: identity.ino });
  fs.writeFileSync(marker, owner, { flag: "wx", mode: 0o600 });
  const markerIdentity = fs.lstatSync(marker);
  const reserved = new Map<string, { dev: number; ino: number }>();
  // The real ZIP writer resolves at finish, before its auto-close callback.
  // Observe only this fixture's reserved archives and keep the actual streams.
  const archiveStreams = new Map<import("node:fs").WriteStream, {
    path: string; closed: Promise<void>; error?: Error;
  }>();
  function observeWriteStream(stream: import("node:fs").WriteStream, destination: import("node:fs").PathLike): void {
    if (typeof destination !== "string" || !reserved.has(destination) ||
        !destination.startsWith(root + path.sep) || !destination.endsWith(".zip")) return;
    const record: { path: string; closed: Promise<void>; error?: Error } = {
      path: destination,
      closed: new Promise<void>((resolve) => stream.once("close", resolve)),
    };
    stream.once("error", (error) => { record.error = error; });
    archiveStreams.set(stream, record);
  }
  async function awaitArchiveClose(p: string): Promise<void> {
    for (const [stream, record] of archiveStreams) {
      if (record.path !== p && !record.path.startsWith(p + path.sep)) continue;
      await record.closed;
      if (!stream.closed) throw new Error("Archive stream emitted close without closing: " + record.path);
      archiveStreams.delete(stream);
      if (record.error) throw record.error;
    }
  }
  function assertTree(p: string): void {
    const st = fs.lstatSync(p);
    const acquired = reserved.get(p);
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1)) ||
        (acquired && (st.dev !== acquired.dev || st.ino !== acquired.ino))) {
      throw new Error("Refusing non-physical or replaced fixture cleanup: " + p);
    }
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) assertTree(path.join(p, name));
  }
  function children(): string[] {
    const st = fs.lstatSync(root);
    const mark = fs.lstatSync(marker);
    if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== identity.dev || st.ino !== identity.ino ||
        fs.realpathSync(root) !== root || !mark.isFile() || mark.isSymbolicLink() || mark.nlink !== 1 ||
        mark.dev !== markerIdentity.dev || mark.ino !== markerIdentity.ino || fs.readFileSync(marker, "utf8") !== owner) {
      throw new Error("Refusing unowned fixture cleanup: " + root);
    }
    const names = fs.readdirSync(root).filter((name) => name !== ".fixture-owner");
    for (const name of names) {
      const p = path.join(root, name);
      if (name !== "updates" && name !== "audit.log.jsonl" && !reserved.has(p)) {
        throw new Error("Unexpected fixture role: " + name);
      }
      assertTree(p);
    }
    return names;
  }
  function makeDirectory(prefix: string): string {
    children();
    if (!/^ab-upd-(manifest-[a-z0-9-]+|payload|archive)-$/.test(prefix)) throw new Error("Invalid fixture role");
    const dir = fs.mkdtempSync(path.join(root, prefix));
    reserved.set(dir, fs.lstatSync(dir));
    return dir;
  }
  function archivePath(name: string): string {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid archive fixture name");
    const p = path.join(makeDirectory("ab-upd-archive-"), name + ".zip");
    const fd = fs.openSync(p, "wx", 0o600);
    fs.closeSync(fd);
    reserved.set(p, fs.lstatSync(p));
    return p;
  }
  async function remove(p: string): Promise<void> {
    children();
    await awaitArchiveClose(root);
    children();
    if (!reserved.has(p) || !p.startsWith(root + path.sep)) throw new Error("Refusing unowned fixture removal");
    assertTree(p);
    fs.rmSync(p, { recursive: true });
    reserved.delete(p);
  }
  async function clear(): Promise<void> {
    children();
    await awaitArchiveClose(root);
    for (const name of children()) fs.rmSync(path.join(root, name), { recursive: true });
    reserved.clear();
  }
  return { root, makeDirectory, archivePath, observeWriteStream, remove, clear,
    dispose: async () => { await clear(); fs.unlinkSync(marker); fs.rmdirSync(root); } };
});
const TEST_USER_DATA = fixture.root;

afterAll(() => fixture.dispose());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      const stream = actual.createWriteStream(...args);
      fixture.observeWriteStream(stream, args[0]);
      return stream;
    },
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: (_name: string) => fixture.root,
    getAppPath: () => require("node:path").resolve(process.cwd()),
  },
}));

import {
  compareVersions,
  parseUpdateManifest,
  checkForUpdates,
  installRelease,
  activateVersion,
  rollback,
  noteAppStarted,
  noteAppCrashed,
  markAppHealthy,
  getUpdateState,
  getCurrentVersion,
} from "../../src/main/services/update-manager.js";
import { writeZipArchive } from "../../src/main/services/zip-writer.js";
import { resetSecretStorageForTests } from "../../src/main/services/secrets.js";
import { listAudit } from "../../src/main/services/audit-log.js";

const MANIFESTS: string[] = [];
const PAYLOAD_DIRS: string[] = [];

function makeManifestDir(name: string): string {
  const dir = fixture.makeDirectory("ab-upd-manifest-" + name + "-");
  MANIFESTS.push(dir);
  return dir;
}

function makePayloadDir(version: string, marker: string): string {
  const dir = fixture.makeDirectory("ab-upd-payload-");
  fs.mkdirSync(path.join(dir, "payload"), { recursive: true });
  fs.writeFileSync(path.join(dir, "payload", "version.txt"), version);
  fs.writeFileSync(path.join(dir, "payload", "marker.json"), JSON.stringify({ marker, version }));
  PAYLOAD_DIRS.push(dir);
  return path.join(dir, "payload");
}

function writeManifest(dir: string, name: string, manifest: any): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
  return p;
}

function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

beforeEach(async () => {
  await fixture.clear();
  fs.mkdirSync(TEST_USER_DATA, { recursive: true });
  delete process.env.AGENT_BROWSER_UPDATE_MANIFEST;
});

afterEach(async () => {
  resetSecretStorageForTests();
  for (const d of MANIFESTS.splice(0)) await fixture.remove(d);
  for (const d of PAYLOAD_DIRS.splice(0)) await fixture.remove(d);
  // Includes both exclusively reserved ZIPs, including the hash-less archive.
  await fixture.clear();
});

describe("version comparison", () => {
  it("compares numeric dot segments (1.10.0 > 1.9.0)", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("150.0.7871.114", "149.0.7827.22")).toBe(1);
  });
});

describe("manifest parsing", () => {
  it("accepts a valid manifest and sorts releases newest-first", () => {
    const m = parseUpdateManifest(JSON.stringify({
      product: "agent-browser-studio",
      channel: "beta",
      releases: [
        { version: "1.0.5", url: "a.zip", sha256: "a".repeat(64) },
        { version: "1.1.0", url: "b.zip" },
        { version: "1.0.10", url: "c.zip" },
      ],
    }));
    expect(m.releases.map((r) => r.version)).toEqual(["1.1.0", "1.0.10", "1.0.5"]);
    expect(m.channel).toBe("beta");
  });

  it("rejects wrong product, empty releases, duplicates and bad sha256", () => {
    expect(() => parseUpdateManifest(JSON.stringify({ product: "other", releases: [{ version: "1.0.0", url: "x" }] }))).toThrow(/product/i);
    expect(() => parseUpdateManifest(JSON.stringify({ product: "agent-browser-studio", releases: [] }))).toThrow(/at least one/i);
    expect(() => parseUpdateManifest(JSON.stringify({ product: "agent-browser-studio", releases: [{ version: "1.0.0", url: "x" }, { version: "1.0.0", url: "y" }] }))).toThrow(/duplicate/i);
    expect(() => parseUpdateManifest(JSON.stringify({ product: "agent-browser-studio", releases: [{ version: "1.0.0", url: "x", sha256: "zz" }] }))).toThrow(/sha256/i);
    expect(() => parseUpdateManifest("not json")).toThrow(/JSON/i);
  });

  it("rejects traversal versions in the manifest (release-store escape)", () => {
    for (const evil of ["../../evil", "..\\evil", "1.0.0/../../x", "/absolute", "1.0.0;rm"]) {
      expect(() => parseUpdateManifest(JSON.stringify({
        product: "agent-browser-studio",
        releases: [{ version: evil, url: "x.zip", sha256: "a".repeat(64) }],
      }))).toThrow(/version/i);
    }
    expect(() => parseUpdateManifest(JSON.stringify({
      product: "agent-browser-studio",
      releases: [{ version: "", url: "x.zip", sha256: "a".repeat(64) }],
    }))).toThrow(/missing version/i);
    // Dotted numerics (incl. Chromium-style 4-segment) still pass.
    const ok = parseUpdateManifest(JSON.stringify({
      product: "agent-browser-studio",
      releases: [{ version: "150.0.7871.114", url: "x.zip", sha256: "a".repeat(64) }],
    }));
    expect(ok.releases[0].version).toBe("150.0.7871.114");
  });
});

describe("update check", () => {
  it("reports available newer releases and honors minSupported", async () => {
    const dir = makeManifestDir("check");
    const manifestPath = writeManifest(dir, "update.json", {
      product: "agent-browser-studio",
      releases: [
        { version: "9.9.9", url: "future.zip" },
        { version: "1.1.0", url: "one.zip", minSupported: "1.0.5" },
        { version: "0.9.0", url: "old.zip" },
      ],
    });
    const r = await checkForUpdates(manifestPath);
    expect(r.error).toBeNull();
    expect(r.currentVersion).toBeTruthy();
    // 1.1.0 is gated by minSupported (current app < 1.0.5) and 0.9.0 is older.
    expect(r.available.map((x) => x.version)).toEqual(["9.9.9"]);
  });

  it("returns an error result when no manifest is configured", async () => {
    const r = await checkForUpdates();
    expect(r.error).toMatch(/manifest/i);
    expect(r.available).toEqual([]);
  });

  it("fails cleanly on a missing manifest file", async () => {
    const r = await checkForUpdates("/nonexistent/update.json");
    expect(r.error).toMatch(/not found/i);
  });
});

describe("install / activate / rollback", () => {
  it("installs a directory payload, activates it and pins the previous version", async () => {
    const payload = makePayloadDir("1.1.0", "hello");
    const dir = makeManifestDir("install");
    const manifestPath = writeManifest(dir, "update.json", {
      product: "agent-browser-studio",
      releases: [{ version: "1.1.0", url: payload, notes: "next" }],
    });
    let state = await installRelease("1.1.0", manifestPath);
    expect(state.installed.some((i) => i.version === "1.1.0" && i.status === "staged")).toBe(true);
    const storedPayload = path.join(TEST_USER_DATA, "updates", "releases", "1.1.0", "payload");
    expect(fs.readFileSync(path.join(storedPayload, "version.txt"), "utf8")).toBe("1.1.0");
    expect(fs.existsSync(path.join(storedPayload, "marker.json"))).toBe(true);

    const current = getCurrentVersion();
    state = activateVersion("1.1.0");
    expect(state.activeVersion).toBe("1.1.0");
    expect(state.previousVersion).toBe(current);
    expect(state.installed.find((i) => i.version === "1.1.0")?.status).toBe("active");
  });

  it("rejects unsafe manifestUrl overrides (file://, local path, metadata IP)", async () => {
    const { assertSafeManifestUrl } = await import("../../src/main/services/update-manager.js");
    await expect(assertSafeManifestUrl("file:///etc/passwd")).rejects.toThrow(/http\(s\)|not allowed/i);
    await expect(assertSafeManifestUrl("/etc/passwd")).rejects.toThrow(/absolute http/i);
    await expect(assertSafeManifestUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/not allowed|blocked/i);
    await expect(assertSafeManifestUrl("http://127.0.0.1:9999/update.json")).rejects.toThrow(/not allowed|blocked/i);
    await expect(assertSafeManifestUrl("ftp://example.com/x.json")).rejects.toThrow(/http\(s\)/i);
  });

  it("refuses a hash-less archive payload (spoofable update)", async () => {
    const zipPath = fixture.archivePath("nohash");
    await writeZipArchive(zipPath, [
      { name: "version.txt", data: Buffer.from("3.0.0") },
    ]);
    const dir = makeManifestDir("nohash");
    const manifestPath = writeManifest(dir, "update.json", {
      product: "agent-browser-studio",
      releases: [{ version: "3.0.0", url: zipPath }],
    });
    await expect(installRelease("3.0.0", manifestPath)).rejects.toThrow(/no sha256|hash-less/i);
  });

  it("verifies sha256 for archive payloads and rejects mismatches", async () => {
    const zipPath = fixture.archivePath("payload");
    await writeZipArchive(zipPath, [
      { name: "version.txt", data: Buffer.from("2.0.0") },
    ]);
    const goodSha = sha256File(zipPath);
    const dir = makeManifestDir("zip");
    const goodManifest = writeManifest(dir, "good.json", {
      product: "agent-browser-studio",
      releases: [{ version: "2.0.0", url: zipPath, sha256: goodSha }],
    });
    let state = await installRelease("2.0.0", goodManifest);
    expect(state.installed.some((i) => i.version === "2.0.0")).toBe(true);
    expect(fs.readFileSync(path.join(TEST_USER_DATA, "updates", "releases", "2.0.0", "payload", "version.txt"), "utf8")).toBe("2.0.0");

    const badManifest = writeManifest(dir, "bad.json", {
      product: "agent-browser-studio",
      releases: [{ version: "2.0.1", url: zipPath, sha256: "f".repeat(64) }],
    });
    await expect(installRelease("2.0.1", badManifest)).rejects.toThrow(/sha256 mismatch/i);
    await fixture.remove(zipPath);
  });

  it("rolls back to the previous known-good release", async () => {
    const payload = makePayloadDir("1.2.0", "m2");
    const dir = makeManifestDir("rb");
    const manifestPath = writeManifest(dir, "update.json", {
      product: "agent-browser-studio",
      releases: [{ version: "1.2.0", url: payload }],
    });
    await installRelease("1.2.0", manifestPath);
    activateVersion("1.2.0");
    const rolled = rollback();
    expect(rolled.activeVersion).toBe(getCurrentVersion());
    expect(rolled.previousVersion).toBe("1.2.0");
  });

  it("rejects activation of a release that was never installed", () => {
    expect(() => activateVersion("9.9.9")).toThrow(/not installed/i);
  });
});

describe("crash-loop auto-rollback", () => {
  it("auto-rolls back to the previous known-good after repeated crashes", async () => {
    const payload = makePayloadDir("1.3.0", "m3");
    const dir = makeManifestDir("crash");
    const manifestPath = writeManifest(dir, "update.json", {
      product: "agent-browser-studio",
      releases: [{ version: "1.3.0", url: payload }],
    });
    await installRelease("1.3.0", manifestPath);
    activateVersion("1.3.0");
    const current = getCurrentVersion();

    noteAppCrashed();
    noteAppCrashed();
    noteAppCrashed();
    const state = noteAppStarted();
    expect(state.activeVersion).toBe(current);
    expect(state.previousVersion).toBe("1.3.0");
    expect(state.crashCount).toBe(0);
    expect(state.history.some((h) => h.action === "auto-rollback")).toBe(true);
  });

  it("does not auto-rollback before reaching the crash threshold", async () => {
    const payload = makePayloadDir("1.4.0", "m4");
    const dir = makeManifestDir("crash2");
    const manifestPath = writeManifest(dir, "update.json", {
      product: "agent-browser-studio",
      releases: [{ version: "1.4.0", url: payload }],
    });
    await installRelease("1.4.0", manifestPath);
    activateVersion("1.4.0");
    noteAppCrashed();
    noteAppCrashed();
    const state = noteAppStarted();
    expect(state.activeVersion).toBe("1.4.0");
  });

  it("markAppHealthy resets the crash counter after a stable run", async () => {
    noteAppCrashed();
    noteAppCrashed();
    const state = markAppHealthy();
    expect(state.crashCount).toBe(0);
  });
});

describe("observability", () => {
  it("records every transition in the audit log and persisted history", async () => {
    const payload = makePayloadDir("1.5.0", "m5");
    const dir = makeManifestDir("audit");
    const manifestPath = writeManifest(dir, "update.json", {
      product: "agent-browser-studio",
      releases: [{ version: "1.5.0", url: payload }],
    });
    await installRelease("1.5.0", manifestPath);
    activateVersion("1.5.0");
    const audits = listAudit(100, { category: "updates" });
    expect(audits.some((a) => a.action === "install")).toBe(true);
    expect(audits.some((a) => a.action === "activate")).toBe(true);
    const state = getUpdateState();
    expect(state.history.some((h) => h.action === "install" && h.version === "1.5.0")).toBe(true);
    expect(state.history.some((h) => h.action === "activate" && h.version === "1.5.0")).toBe(true);
  });
});
