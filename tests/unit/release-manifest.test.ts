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
const UPDATE_VERSIONS = { current: "0.9.7", next: "0.9.8", equal: "0.9.7", older: "0.9.6" } as const;

vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_DATA = path.join(os.tmpdir(), "agent-browser-release-manifest-test");
  const APP_ROOT = TEST_DATA;
  return {
    app: {
      getPath: (name: string) => {
        if (name === "userData" || name === "home") return TEST_DATA;
        return "/tmp";
      },
      getAppPath: () => APP_ROOT,
    },
  };
});

type ReleaseManifestModule = typeof import("../../scripts/release-manifest.mjs");
let buildManifest: ReleaseManifestModule["buildManifest"];
let sha256File: ReleaseManifestModule["sha256File"];
let compareVersionsDesc: ReleaseManifestModule["compareVersionsDesc"];
let runCli: ReleaseManifestModule["runCli"];
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
  fs.writeFileSync(path.join(TEST_USER_DATA, "package.json"), JSON.stringify({ version: UPDATE_VERSIONS.current }));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAuthoredManifest(value: unknown): asserts value is import("../../scripts/release-manifest.mjs").AuthoredManifest {
  if (!isRecord(value) || value.product !== "agent-browser-studio" || !Array.isArray(value.releases)) {
    throw new Error("Expected an authored release manifest");
  }
  if ("channel" in value && typeof value.channel !== "string") throw new Error("Invalid manifest channel");
  for (const release of value.releases) {
    if (!isRecord(release) || typeof release.version !== "string" || typeof release.url !== "string"
      || typeof release.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(release.sha256)
      || typeof release.publishedAt !== "string") {
      throw new Error("Invalid authored release entry");
    }
    for (const key of ["notes", "minSupported"]) {
      if (key in release && typeof release[key] !== "string") throw new Error("Invalid release " + key);
    }
  }
}

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
    let manifest: import("../../scripts/release-manifest.mjs").MergedManifest = buildManifest({ file, version: "1.0.1" });
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

  it("checkForUpdates() offers only newer compatible releases from the generated manifest", async () => {
    const file = makePayload();
    const { current, next, equal, older } = UPDATE_VERSIONS;
    let manifest: import("../../scripts/release-manifest.mjs").MergedManifest = buildManifest({ file, version: older });
    manifest = buildManifest({ file, version: equal, existing: manifest });
    manifest = buildManifest({ file, version: next, minSupported: current, existing: manifest });
    const manifestPath = path.join(tmp, "update-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = await checkForUpdates("file://" + manifestPath);
    expect(result.currentVersion).toBe(current); // read from the test app's package.json, not the host build
    expect(result.error).toBeNull();
    expect(result.available.map((r) => r.version)).toEqual([next]);

    // A newer release beyond the current app's minSupported gate is filtered out.
    const gated = buildManifest({ file, version: "9.0.0", minSupported: "2.0.0" });
    const gatedPath = path.join(tmp, "gated-manifest.json");
    fs.writeFileSync(gatedPath, JSON.stringify(gated));
    const gatedResult = await checkForUpdates("file://" + gatedPath);
    expect(gatedResult.currentVersion).toBe(current);
    expect(gatedResult.error).toBeNull();
    expect(gatedResult.available).toHaveLength(0);
  }, 30000);

  it("runCli merges into an existing manifest file and writes --out", () => {
    const file = makePayload();
    const firstPath = path.join(tmp, "manifest.json");
    runCli(["--file", file, "--version", "1.0.1", "--out", firstPath]);
    const other = path.join(tmp, "other.zip");
    fs.writeFileSync(other, crypto.randomBytes(512));
    runCli(["--file", other, "--version", "1.0.2", "--manifest", firstPath, "--out", firstPath]);
    const onDisk: unknown = JSON.parse(fs.readFileSync(firstPath, "utf8"));
    assertAuthoredManifest(onDisk);
    expect(onDisk.releases.map((r) => r.version)).toEqual(["1.0.2", "1.0.1"]);
    expect(compareVersionsDesc("1.0.2", "1.0.1")).toBeLessThan(0);
  });
});

describe.skipIf(isWindows)("release-manifest version component parity", () => {
  it("rejects six numeric components before authoring a release", () => {
    const file = makePayload();
    expect(() => buildManifest({ file, version: "1.0.0.0.0.0" })).toThrow(/Invalid --version: expected 2 to 5 dot-separated numeric components/);
    expect(() => buildManifest({ file, version: " 1.0.0.0.0.0 " })).toThrow(/Invalid --version/);
  });

  it("runCli rejects six components without output or destination changes", () => {
    const file = makePayload();
    const absentPath = path.join(tmp, "rejected-manifest.json");
    const existingPath = path.join(tmp, "existing-manifest.json");
    const destinationBytes = Buffer.from('{"keep":"original destination bytes"}\n');
    fs.writeFileSync(existingPath, destinationBytes);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(() => runCli(["--file", file, "--version", "1.0.0.0.0.0", "--out", absentPath])).toThrow(/Invalid --version/);
      expect(fs.existsSync(absentPath)).toBe(false);
      expect(() => runCli(["--file", file, "--version", "1.0.0.0.0.0", "--out", existingPath])).toThrow(/Invalid --version/);
      expect(fs.readFileSync(existingPath)).toEqual(destinationBytes);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  for (const version of ["1.0", "1.0.1", "1.2.3.4.5"]) {
    it(`roundtrips supported ${version.split(".").length}-component versions through the builder, CLI and update check`, async () => {
      const file = makePayload();
      const expectedHash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const authored = buildManifest({ file, version, minSupported: UPDATE_VERSIONS.current });
      expect(authored.releases[0].version).toBe(version);
      expect(authored.releases[0].sha256).toBe(expectedHash);
      expect(parseUpdateManifest(JSON.stringify(authored)).releases[0].version).toBe(version);

      const manifestPath = path.join(tmp, "supported-manifest.json");
      const previous = buildManifest({ file, version: UPDATE_VERSIONS.next });
      fs.writeFileSync(manifestPath, JSON.stringify(previous));
      runCli(["--file", file, "--version", version, "--min-supported", UPDATE_VERSIONS.current,
        "--manifest", manifestPath, "--out", manifestPath]);
      const rawBytes = fs.readFileSync(manifestPath, "utf8");
      const onDisk: unknown = JSON.parse(rawBytes);
      assertAuthoredManifest(onDisk);
      // Assert the authored order before the production parser can sort it.
      expect(onDisk.releases.map((r) => r.version)).toEqual([version, UPDATE_VERSIONS.next]);
      expect(onDisk.releases.map((r) => r.sha256)).toEqual([expectedHash, expectedHash]);
      expect(onDisk.releases[0].minSupported).toBe(UPDATE_VERSIONS.current);
      const parsed = parseUpdateManifest(rawBytes);
      expect(parsed.releases.map((r) => r.version)).toEqual([version, UPDATE_VERSIONS.next]);
      expect(parsed.releases.find((r) => r.version === version)?.sha256).toBe(expectedHash);

      const result = await checkForUpdates("file://" + manifestPath);
      expect(result.currentVersion).toBe(UPDATE_VERSIONS.current);
      expect(result.error).toBeNull();
      expect(result.available.map((r) => r.version)).toEqual([version, UPDATE_VERSIONS.next]);
      expect(result.available.find((r) => r.version === version)?.sha256).toBe(expectedHash);
    });
  }
});

import { loadUpdateState, getInstalledVersions } from "../../src/main/services/update-manager.js";

function expectMinSupportedState(manifestPath: string, result: Awaited<ReturnType<typeof checkForUpdates>>): void {
  const rawState: unknown = JSON.parse(fs.readFileSync(path.join(TEST_USER_DATA, "updates", "state.json"), "utf8"));
  if (!isRecord(rawState)) throw new Error("Expected persisted update state");
  expect(rawState.manifestUrl).toBe("file://" + manifestPath);
  expect(rawState.lastCheckError).toBeNull();
  expect(rawState.lastCheckedAt).toBe(result.checkedAt);
  expect(rawState.installed).toEqual([]);
  expect(rawState.history).toEqual([]);
  // loadUpdateState reads the actual persisted file again, not a cached result.
  expect(loadUpdateState()).toEqual(rawState);
  expect(getInstalledVersions()).toEqual([]);
  expect(fs.existsSync(path.join(TEST_USER_DATA, "updates", "releases"))).toBe(false);
}

describe.skipIf(isWindows)("release-manifest minSupported validation", () => {
  const invalidMinSupported = ["1.0.0.0.0.0", "0.0.0.0.0.0", " 1.0.0.0.0.0 ", " \t0.0.0.0.0.0\n ", "not-a-version"];

  it("rejects malformed nonblank minSupported before authoring a release", () => {
    const file = makePayload();
    for (const minSupported of invalidMinSupported) {
      expect(() => buildManifest({ file, version: "1.0.1", minSupported }))
        .toThrow(/Invalid --min-supported: expected 2 to 5 dot-separated numeric components/);
    }
  });

  it("runCli rejects malformed minSupported without output, logs or destination changes", () => {
    const file = makePayload();
    const absentPath = path.join(tmp, "invalid-min-supported.json");
    const existingPath = path.join(tmp, "preserved-min-supported.json");
    const destinationBytes = Buffer.from('{"keep":"original destination bytes"}\n');
    fs.writeFileSync(existingPath, destinationBytes);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      for (const minSupported of invalidMinSupported) {
        expect(() => runCli(["--file", file, "--version", "1.0.1", "--min-supported", minSupported, "--out", absentPath]))
          .toThrow(/Invalid --min-supported/);
        expect(fs.existsSync(absentPath)).toBe(false);
        expect(() => runCli(["--file", file, "--version", "1.0.1", "--min-supported", minSupported, "--out", existingPath]))
          .toThrow(/Invalid --min-supported/);
        expect(fs.readFileSync(existingPath)).toEqual(destinationBytes);
        expect(log).not.toHaveBeenCalled();
      }
    } finally {
      log.mockRestore();
    }
  });

  for (const supported of ["0.9", "0.9.7", "0.9.7.0.0"]) {
    it(`roundtrips supported ${supported.split(".").length}-component minSupported with and without padding`, async () => {
      const file = makePayload();
      const expectedHash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      for (const minSupported of [supported, " \t" + supported + "\n "]) {
        const authored = buildManifest({ file, version: "1.0.1", minSupported });
        expect(authored.releases[0].minSupported).toBe(supported);
        expect(authored.releases[0].sha256).toBe(expectedHash);
        expect(parseUpdateManifest(JSON.stringify(authored)).releases[0].minSupported).toBe(supported);
        const manifestPath = path.join(tmp, "supported-min-supported.json");
        runCli(["--file", file, "--version", UPDATE_VERSIONS.next, "--channel", "preview", "--out", manifestPath]);
        runCli(["--file", file, "--version", "1.0.1", "--min-supported", minSupported, "--manifest", manifestPath, "--out", manifestPath]);
        const rawBytes = fs.readFileSync(manifestPath, "utf8");
        const onDisk: unknown = JSON.parse(rawBytes);
        assertAuthoredManifest(onDisk);
        expect(onDisk.releases.map((r) => r.version)).toEqual(["1.0.1", UPDATE_VERSIONS.next]);
        expect(onDisk.channel).toBe("preview");
        expect(onDisk.releases[0].minSupported).toBe(supported);
        expect(onDisk.releases.map((r) => r.sha256)).toEqual([expectedHash, expectedHash]);
        const parsed = parseUpdateManifest(rawBytes);
        expect(parsed.releases.find((r) => r.version === "1.0.1")?.minSupported).toBe(supported);
        const result = await checkForUpdates("file://" + manifestPath);
        expect(result.currentVersion).toBe(UPDATE_VERSIONS.current);
        expect(result.error).toBeNull();
        expect(result.available.map((r) => r.version)).toEqual(["1.0.1", UPDATE_VERSIONS.next]);
        expect(result.available.find((r) => r.version === "1.0.1")?.sha256).toBe(expectedHash);
        expectMinSupportedState(manifestPath, result);
      }
    });
  }

  it("preserves omitted, blank and ignored non-string builder minSupported semantics", async () => {
    const file = makePayload();
    const controls: Array<{ label: string; options: Record<string, unknown>; expected: string | undefined }> = [
      { label: "omitted", options: {}, expected: undefined },
      { label: "empty", options: { minSupported: "" }, expected: "" },
      { label: "whitespace", options: { minSupported: " \t\n " }, expected: "" },
      ...[undefined, null, 123, false, {}, []].map((minSupported, index) => ({
        label: "non-string-" + index, options: { minSupported }, expected: undefined,
      })),
    ];
    for (const control of controls) {
      // Deliberately exercise runtime input outside the typed string API without changing its declaration.
      const authored: unknown = Reflect.apply(buildManifest, undefined, [{ file, version: "1.0.1", ...control.options }]);
      const manifestPath = path.join(tmp, control.label + ".json");
      fs.writeFileSync(manifestPath, JSON.stringify(authored));
      const rawBytes = fs.readFileSync(manifestPath, "utf8");
      const onDisk: unknown = JSON.parse(rawBytes);
      assertAuthoredManifest(onDisk);
      expect(onDisk.releases[0].minSupported).toBe(control.expected);
      expect(Object.hasOwn(onDisk.releases[0], "minSupported")).toBe(control.expected !== undefined);
      expect(onDisk.releases[0].sha256).toBe(sha256File(file));
      expect(parseUpdateManifest(rawBytes).releases[0].minSupported).toBe(control.expected);
      const result = await checkForUpdates("file://" + manifestPath);
      expect(result.currentVersion).toBe(UPDATE_VERSIONS.current);
      expect(result.error).toBeNull();
      expect(result.available.map((r) => r.version)).toEqual(["1.0.1"]);
      expect(result.available[0].minSupported).toBe(control.expected);
      expectMinSupportedState(manifestPath, result);
    }
  });

  it("preserves omitted and whitespace CLI minSupported and the existing empty-argument error", async () => {
    const file = makePayload();
    for (const args of [[], ["--min-supported", " \t\n "]]) {
      const manifestPath = path.join(tmp, "blank-cli-" + args.length + ".json");
      runCli(["--file", file, "--version", "1.0.1", ...args, "--out", manifestPath]);
      const rawBytes = fs.readFileSync(manifestPath, "utf8");
      const onDisk: unknown = JSON.parse(rawBytes);
      assertAuthoredManifest(onDisk);
      const expected = args.length ? "" : undefined;
      expect(onDisk.releases[0].minSupported).toBe(expected);
      expect(parseUpdateManifest(rawBytes).releases[0].minSupported).toBe(expected);
      const result = await checkForUpdates("file://" + manifestPath);
      expect(result.error).toBeNull();
      expect(result.available.map((r) => r.version)).toEqual(["1.0.1"]);
      expectMinSupportedState(manifestPath, result);
    }
    const absentPath = path.join(tmp, "empty-cli.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(() => runCli(["--file", file, "--version", "1.0.1", "--min-supported", "", "--out", absentPath]))
        .toThrow(/Missing value for --min-supported/);
      expect(fs.existsSync(absentPath)).toBe(false);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
