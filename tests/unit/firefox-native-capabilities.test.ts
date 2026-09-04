import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FIREFOX_CAPABILITY_PRODUCT,
  FIREFOX_EXPECTED_SOURCE_STAMP,
  FIREFOX_NATIVE_CONFIG_CAPABILITIES,
  FIREFOX_NATIVE_PARITY_CAPABILITIES,
  firefoxNativeModeRequested,
  readFirefoxNativeCapabilities,
  readFirefoxNativeCapabilityReport,
  supportsFirefoxNativeConfig,
  supportsFirefoxNativeParity,
} from "../../src/main/services/firefox-native-capabilities.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-firefox-capability-test-"));
  roots.push(root);
  return root;
}

function makeFakeFirefox(
  report: Record<string, unknown>,
  { marker = true }: { marker?: boolean } = {},
): string {
  const root = makeRoot();
  const directory = path.join(root, "Nightly.app", "Contents", "MacOS");
  fs.mkdirSync(directory, { recursive: true });
  const binary = path.join(directory, "firefox");
  fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(report)}'\n`, { mode: 0o700 });
  fs.chmodSync(binary, 0o700);
  fs.writeFileSync(
    path.join(directory, "XUL"),
    marker ? `binary-prefix-\"product\":\"${FIREFOX_CAPABILITY_PRODUCT}\"-binary-suffix` : "stock-xul",
  );
  return binary;
}

function report(capabilities: readonly string[]): Record<string, unknown> {
  return {
    product: FIREFOX_CAPABILITY_PRODUCT,
    capabilitySchemaVersion: 1,
    browserVersion: "154.0",
    buildId: "20260902025601",
    sourceStamp: FIREFOX_EXPECTED_SOURCE_STAMP,
    capabilities,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Firefox native capability attestation", () => {
  it("parses the strict config capability report without claiming parity", () => {
    if (process.platform === "win32") return;
    const binary = makeFakeFirefox(report(FIREFOX_NATIVE_CONFIG_CAPABILITIES));
    expect(readFirefoxNativeCapabilityReport(binary, "darwin")).toMatchObject({
      product: FIREFOX_CAPABILITY_PRODUCT,
      browserVersion: "154.0",
      sourceStamp: FIREFOX_EXPECTED_SOURCE_STAMP,
      capabilities: [...FIREFOX_NATIVE_CONFIG_CAPABILITIES],
    });
    expect([...readFirefoxNativeCapabilities(binary, "darwin")]).toEqual(
      FIREFOX_NATIVE_CONFIG_CAPABILITIES,
    );
    expect(supportsFirefoxNativeConfig(binary, "darwin")).toBe(true);
    expect(supportsFirefoxNativeParity(binary, "darwin")).toBe(false);
  });

  it("requires every parity capability before enabling full native mode", () => {
    if (process.platform === "win32") return;
    const binary = makeFakeFirefox(report(FIREFOX_NATIVE_PARITY_CAPABILITIES));
    expect(supportsFirefoxNativeConfig(binary, "darwin")).toBe(true);
    expect(supportsFirefoxNativeParity(binary, "darwin")).toBe(true);
  });

  it("does not execute stock binaries that lack the embedded product marker", () => {
    if (process.platform === "win32") return;
    const binary = makeFakeFirefox(report(FIREFOX_NATIVE_CONFIG_CAPABILITIES), { marker: false });
    expect(readFirefoxNativeCapabilityReport(binary, "darwin")).toBeNull();
    expect(supportsFirefoxNativeConfig(binary, "darwin")).toBe(false);
  });

  it("isolates cached reports by platform-specific marker path", () => {
    if (process.platform === "win32") return;
    const binary = makeFakeFirefox(report(FIREFOX_NATIVE_CONFIG_CAPABILITIES));
    const directory = path.dirname(binary);
    const darwinMarker = path.join(directory, "XUL");
    const windowsMarker = path.join(directory, "xul.dll");
    const markerStat = fs.statSync(darwinMarker);
    fs.writeFileSync(windowsMarker, "x".repeat(markerStat.size));
    fs.utimesSync(windowsMarker, markerStat.atime, markerStat.mtime);
    expect(readFirefoxNativeCapabilityReport(binary, "darwin")).not.toBeNull();
    expect(readFirefoxNativeCapabilityReport(binary, "win32")).toBeNull();
  });

  it("rejects malformed, duplicated, or wrong-provenance reports", () => {
    if (process.platform === "win32") return;
    const wrongSource = makeFakeFirefox({
      ...report(FIREFOX_NATIVE_CONFIG_CAPABILITIES),
      sourceStamp: "0".repeat(40),
    });
    const duplicated = makeFakeFirefox(report([
      ...FIREFOX_NATIVE_CONFIG_CAPABILITIES,
      FIREFOX_NATIVE_CONFIG_CAPABILITIES[0],
    ]));
    const malformed = makeFakeFirefox({ ...report([]), capabilities: ["not valid"] });
    expect(readFirefoxNativeCapabilityReport(wrongSource, "darwin")).toBeNull();
    expect(readFirefoxNativeCapabilityReport(duplicated, "darwin")).toBeNull();
    expect(readFirefoxNativeCapabilityReport(malformed, "darwin")).toBeNull();
    expect(readFirefoxNativeCapabilityReport(path.join(makeRoot(), "missing"), "darwin")).toBeNull();
  });

  it("invalidates cached reports when the binary changes", () => {
    if (process.platform === "win32") return;
    const binary = makeFakeFirefox(report(FIREFOX_NATIVE_CONFIG_CAPABILITIES));
    expect(supportsFirefoxNativeParity(binary, "darwin")).toBe(false);
    fs.writeFileSync(
      binary,
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(report(FIREFOX_NATIVE_PARITY_CAPABILITIES))}'\n# changed-size\n`,
      { mode: 0o700 },
    );
    fs.chmodSync(binary, 0o700);
    expect(supportsFirefoxNativeParity(binary, "darwin")).toBe(true);
  });

  it("only treats an explicit value of one as native A/B mode", () => {
    expect(firefoxNativeModeRequested({ AGENT_BROWSER_FIREFOX_NATIVE: "1" })).toBe(true);
    expect(firefoxNativeModeRequested({ AGENT_BROWSER_FIREFOX_NATIVE: "0" })).toBe(false);
    expect(firefoxNativeModeRequested({})).toBe(false);
  });
});
