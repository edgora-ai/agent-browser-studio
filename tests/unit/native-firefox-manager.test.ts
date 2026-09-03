import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  compareFirefoxVersions,
  findManagedFirefoxBinary,
  getManagedFirefoxRoot,
  listManagedFirefoxBinaries,
  normalizeManagedFirefoxVersion,
} from "../../src/main/services/native-firefox-manager.js";
import {
  FIREFOX_CAPABILITY_PRODUCT,
  FIREFOX_EXPECTED_SOURCE_STAMP,
  FIREFOX_NATIVE_CONFIG_CAPABILITIES,
} from "../../src/main/services/firefox-native-capabilities.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-managed-firefox-test-"));
  roots.push(root);
  return root;
}

function installFake(root: string, version: string, capable = true): string {
  const directory = path.join(root, `firefox-${version}`, "Firefox.app", "Contents", "MacOS");
  fs.mkdirSync(directory, { recursive: true });
  const binary = path.join(directory, "firefox");
  const report = {
    product: FIREFOX_CAPABILITY_PRODUCT,
    capabilitySchemaVersion: 1,
    browserVersion: version,
    buildId: "20260902025601",
    sourceStamp: FIREFOX_EXPECTED_SOURCE_STAMP,
    capabilities: FIREFOX_NATIVE_CONFIG_CAPABILITIES,
  };
  fs.writeFileSync(binary, `#!/bin/sh\ncase "$1" in\n  --version) printf '%s\\n' 'Mozilla Firefox ${version}' ;;\n  *) printf '%s\\n' '${JSON.stringify(report)}' ;;\nesac\n`, { mode: 0o700 });
  fs.chmodSync(binary, 0o700);
  fs.writeFileSync(
    path.join(directory, "XUL"),
    capable ? `\"product\":\"${FIREFOX_CAPABILITY_PRODUCT}\"` : "stock-xul",
  );
  return binary;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("managed native Firefox discovery", () => {
  it("uses the caller-provided environment for cache isolation", () => {
    const root = path.join(makeRoot(), "isolated-cache");
    expect(getManagedFirefoxRoot({ AGENT_BROWSER_FIREFOX_CACHE_DIR: root })).toBe(path.resolve(root));
  });

  it("normalizes exact versions and rejects ambiguous input", () => {
    expect(normalizeManagedFirefoxVersion("154.0")).toBe("154.0");
    expect(normalizeManagedFirefoxVersion("154.0.1")).toBe("154.0.1");
    expect(normalizeManagedFirefoxVersion("auto")).toBeNull();
    expect(normalizeManagedFirefoxVersion(null)).toBeNull();
    expect(() => normalizeManagedFirefoxVersion("154")).toThrow("Invalid Firefox version");
  });

  it("lists only binary-attested installs and selects the requested version", () => {
    if (process.platform === "win32") return;
    const root = makeRoot();
    const first = installFake(root, "154.0");
    const latest = installFake(root, "154.0.1");
    installFake(root, "153.0", false);
    fs.mkdirSync(path.join(root, "firefox-152.0"));

    expect(listManagedFirefoxBinaries(root, "darwin").map((entry) => entry.version)).toEqual([
      "154.0.1",
      "154.0",
    ]);
    expect(findManagedFirefoxBinary(null, root, "darwin")?.binaryPath).toBe(latest);
    expect(findManagedFirefoxBinary("154.0", root, "darwin")?.binaryPath).toBe(first);
    expect(findManagedFirefoxBinary("155.0", root, "darwin")).toBeNull();
  });

  it("compares dotted Firefox versions numerically", () => {
    expect(compareFirefoxVersions("154.0.1", "154.0")).toBeGreaterThan(0);
    expect(compareFirefoxVersions("154.0", "153.9.9")).toBeGreaterThan(0);
    expect(compareFirefoxVersions("154.0", "154.0.0")).toBe(0);
  });
});
