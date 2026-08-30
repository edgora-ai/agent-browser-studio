// Round-trip check for the update-manifest authoring tool (review item A2):
// what scripts/release-manifest.mjs emits must be accepted by the real
// parser (parseUpdateManifest) and surface as an available update via
// checkForUpdates(). Without this, a hand-rolled publish flow could drift
// from what update-manager.ts accepts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const isWindows = process.platform === "win32";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-release-manifest-test");

vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_DATA = path.join(os.tmpdir(), "agent-browser-release-manifest-test");
  const REPO_ROOT = path.resolve(TEST_DATA, "..", "..", "..", "..");
  return {
    app: {
      getPath: (name: string) => {
        if (name === "userData" || name === "home") return TEST_DATA;
        return "/tmp";
      },
      getAppPath: () => REPO_ROOT,
    },
  };
});

let buildManifest: any, sha256File: any, compareVersionsDesc: any, runCli: any;
if (!isWindows) {
  const m = await import(/* @vite-ignore */ "../../scripts/release-manifest.mjs");
  buildManifest = m.buildManifest;
  sha256File = m.sha256File;
  compareVersionsDesc = m.compareVersionsDesc;
  runCli = m.runCli;
}
import { parseUpdateManifest, checkForUpdates } from "../../src/main/services/update-manager.js";

let tmp: string;

beforeEach(() => {
  if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relmanifest-"));
  fs.mkdirSync(TEST_USER_DATA, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
});

function makePayload(): string {
  const file = path.join(tmp, "agent-browser-studio-1.0.1-mac-arm64.zip");
  fs.writeFileSync(file, crypto.randomBytes(2048));
  return file;
}

describe.skipIf(isWindows)("release-manifest authoring tool", () => {
  it("computes a correct sha256 and a full release entry", () => {
    const file = makePayload();
    const manifest = buildManifest({ file, version: "1.0.1", notes: "test release" });
    expect(manifest.product).toBe("agent-browser-studio");
    expect(manifest.releases).toHaveLength(1);
    const r = manifest.releases[0];
    expect(r.version).toBe("1.0.1");
    expect(r.url).toBe(file); // no base-url -> absolute local path
    expect(r.sha256).toBe(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    expect(r.publishedAt).toBeTruthy();
    expect(sha256File(file)).toBe(r.sha256);
  });

  it("emits a manifest the real parseUpdateManifest accepts", () => {
    const file = makePayload();
    const manifest = buildManifest({ file, version: "1.0.1", minSupported: "1.0.0" });
    const parsed = parseUpdateManifest(JSON.stringify(manifest));
    expect(parsed.product).toBe("agent-browser-studio");
    expect(parsed.releases[0].sha256).toBe(manifest.releases[0].sha256);
    expect(parsed.releases[0].minSupported).toBe("1.0.0");
  });

  it("re-publishing the same version replaces the entry and keeps newest first", () => {
    const file = makePayload();
    let manifest = buildManifest({ file, version: "1.0.1" });
    manifest = buildManifest({ file, version: "1.0.0", existing: manifest });
    manifest = buildManifest({ file, version: "1.0.2", existing: manifest });
    manifest = buildManifest({ file, version: "1.0.1", existing: manifest }); // replace
    expect(manifest.releases.map((r) => r.version)).toEqual(["1.0.2", "1.0.1", "1.0.0"]);
  });

  it("rejects invalid versions and missing payloads", () => {
    const file = makePayload();
    expect(() => buildManifest({ file, version: "abc" })).toThrow(/Invalid --version/);
    expect(() => buildManifest({ file, version: "1.0" })).not.toThrow();
    expect(() => buildManifest({ file: path.join(tmp, "missing.zip"), version: "1.0.1" })).toThrow(/not found/i);
  });

  it("checkForUpdates() surfaces the generated release as an available update", async () => {
    const file = makePayload();
    const manifest = buildManifest({ file, version: "1.0.1", minSupported: "1.0.0" });
    const manifestPath = path.join(tmp, "update-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = await checkForUpdates("file://" + manifestPath);
    expect(result.error).toBeNull();
    expect(result.available.map((r) => r.version)).toContain("1.0.1");

    // A release beyond the current app's minSupported gate is filtered out.
    const gated = buildManifest({ file, version: "9.0.0", minSupported: "2.0.0" });
    const gatedPath = path.join(tmp, "gated-manifest.json");
    fs.writeFileSync(gatedPath, JSON.stringify(gated));
    const gatedResult = await checkForUpdates("file://" + gatedPath);
    expect(gatedResult.available).toHaveLength(0);
  }, 30000);

  it("runCli merges into an existing manifest file and writes --out", () => {
    const file = makePayload();
    const firstPath = path.join(tmp, "manifest.json");
    runCli(["--file", file, "--version", "1.0.1", "--out", firstPath]);
    const other = path.join(tmp, "other.zip");
    fs.writeFileSync(other, crypto.randomBytes(512));
    runCli(["--file", other, "--version", "1.0.2", "--manifest", firstPath, "--out", firstPath]);
    const onDisk = JSON.parse(fs.readFileSync(firstPath, "utf8"));
    expect(onDisk.releases.map((r: any) => r.version)).toEqual(["1.0.2", "1.0.1"]);
    expect(compareVersionsDesc("1.0.2", "1.0.1")).toBeLessThan(0);
  });
});
