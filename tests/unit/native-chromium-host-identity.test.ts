import { describe, expect, it, vi } from "vitest";

const startup = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(() => { throw new Error("Identity unit tests must not launch a browser"); }),
  launch: vi.fn(() => { throw new Error("Identity unit tests must not launch a browser"); }),
  execFileSync: vi.fn(() => { throw new Error("Identity unit tests must not execute a browser"); }),
  createServer: vi.fn(() => { throw new Error("Identity unit tests must not bind an origin"); }),
}));
vi.mock("playwright", () => ({ chromium: startup }));
vi.mock("node:child_process", () => ({ execFileSync: startup.execFileSync }));
vi.mock("node:http", () => ({ createServer: startup.createServer }));

import { buildBrowserFingerprintConfig } from "../../src/main/services/browser-fingerprint-config.js";
import {
  verifyHostIdentityCoherence,
  verifyManagedGpuIdentity,
  type HostIdentityCorpus,
} from "../../src/tools/verify-native-chromium.js";

function fixture(platform: "macos" | "windows" = "macos") {
  const configured = buildBrowserFingerprintConfig({ platform, fingerprintSeed: 424242 }, "152.0.7977.72");
  const uaPlatform = platform === "macos" ? "macOS" : "Windows";
  const navigator = {
    userAgent: configured.userAgent,
    platform: configured.platform,
    uaPlatform,
    mobile: false,
    highEntropy: { platform: uaPlatform, architecture: "x86", bitness: "64", platformVersion: configured.platformVersion },
  };
  const headers = {
    userAgent: configured.userAgent, acceptLanguage: "en-US", doNotTrack: "1",
    uaPlatform: JSON.stringify(uaPlatform), uaArchitecture: '"x86"', uaBitness: '"64"',
    uaPlatformVersion: JSON.stringify(configured.platformVersion),
  };
  const actual: HostIdentityCorpus = {
    window: structuredClone(navigator), worker: structuredClone(navigator),
    requestHeaders: {
      window: { ...headers }, dedicated: { ...headers }, shared: { ...headers }, service: { ...headers },
    },
  };
  return { actual, configured };
}

describe("same-session host OS identity coherence", () => {
  it.each([["macos", "darwin"], ["windows", "win32"]] as const)("accepts %s on %s across navigator, workers and actual headers", (platform, host) => {
    const { actual, configured } = fixture(platform);
    expect(() => verifyHostIdentityCoherence(actual, configured, host)).not.toThrow();
    for (const operation of Object.values(startup)) expect(operation).not.toHaveBeenCalled();
  });

  it("rejects the reported Win32 plus native Apple Metal case despite successful managed activation", () => {
    const { actual, configured } = fixture("windows");
    const reported = { ...actual, webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)" };
    expect(() => verifyManagedGpuIdentity(reported.window, configured)).not.toThrow();
    expect(() => verifyHostIdentityCoherence(reported, configured, "darwin")).toThrow(/host OS compatibility/);
  });

  it.each([["macos", "win32"], ["windows", "linux"], ["macos", "android"]] as const)("does not promote %s on %s to a supported host identity", (platform, host) => {
    const { actual, configured } = fixture(platform);
    expect(() => verifyHostIdentityCoherence(actual, configured, host)).toThrow(/host OS compatibility/);
  });

  it.each(["window", "worker"] as const)("rejects stale Win32 in the %s context", (context) => {
    const { actual, configured } = fixture();
    actual[context].platform = "Win32";
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin")).toThrow(/platform/);
  });

  it.each(["window", "worker"] as const)("rejects %s UA-CH claiming Windows under a macOS UA", (context) => {
    const { actual, configured } = fixture();
    actual[context].uaPlatform = "Windows";
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin")).toThrow(/UA-CH/);
  });

  it.each(["window", "worker"] as const)("rejects %s high-entropy OS conflicts", (context) => {
    const { actual, configured } = fixture();
    actual[context].highEntropy!.platform = "Windows";
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin")).toThrow(/high-entropy/);
  });

  it.each(["window", "dedicated", "shared", "service"] as const)("rejects stale Windows request identity from %s", (context) => {
    const { actual, configured } = fixture();
    actual.requestHeaders[context].uaPlatform = '"Windows"';
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin")).toThrow(/request UA-CH/);
  });

  it("rejects a Windows User-Agent on the wire even when navigator surfaces agree", () => {
    const { actual, configured } = fixture();
    actual.requestHeaders.dedicated.userAgent = fixture("windows").configured.userAgent;
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin")).toThrow(/request User-Agent/);
  });

  it("requires high-entropy capture rather than treating absence as coherence", () => {
    const { actual, configured } = fixture();
    actual.worker.highEntropy = null;
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin")).toThrow(/high-entropy/);
  });

  it("requires the owned-origin opt-in headers and rejects wire/JS architecture drift", () => {
    const { actual, configured } = fixture();
    actual.requestHeaders.service.uaArchitecture = null;
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin")).toThrow(/request high-entropy/);
    actual.requestHeaders.service.uaArchitecture = '"arm"';
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin")).toThrow(/request high-entropy/);
  });

  function withNativeWorkerOmissions() {
    const { actual, configured } = fixture();
    const nativeControl = structuredClone(actual);
    const nativeUa = configured.userAgent.replace("Chrome/152.0.7977.72", "Chrome/152.0.0.0");
    for (const navigator of [nativeControl.window, nativeControl.worker]) {
      navigator.userAgent = nativeUa;
      navigator.highEntropy!.architecture = "arm";
      navigator.highEntropy!.platformVersion = "26.3.0";
    }
    for (const headers of Object.values(nativeControl.requestHeaders)) {
      headers.userAgent = nativeUa;
      headers.uaArchitecture = '"arm"';
      headers.uaPlatformVersion = '"26.3.0"';
    }
    for (const context of ["dedicated", "shared", "service"] as const) {
      for (const corpus of [actual, nativeControl]) {
        Object.assign(corpus.requestHeaders[context], {
          uaPlatform: null, uaArchitecture: null, uaBitness: null, uaPlatformVersion: null,
        });
      }
    }
    return { actual, configured, nativeControl };
  }

  it("accepts matching Worker HTTP hint omission only with a validated native control", () => {
    const { actual, configured, nativeControl } = withNativeWorkerOmissions();
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin")).toThrow(/request UA-CH/);
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin", "controlled", nativeControl)).not.toThrow();
  });

  it("never permits absent Window HTTP hints based on Worker omission", () => {
    const { actual, configured, nativeControl } = withNativeWorkerOmissions();
    actual.requestHeaders.window.uaPlatform = null;
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin", "controlled", nativeControl)).toThrow(/window request UA-CH/);
  });

  it("does not permit a managed omission when the native Worker sent hints", () => {
    const { actual, configured, nativeControl } = withNativeWorkerOmissions();
    nativeControl.requestHeaders.dedicated = { ...nativeControl.requestHeaders.window };
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin", "controlled", nativeControl)).toThrow(/dedicated request UA-CH/);
  });

  it("does not excuse wrong or partially absent Worker hints using native absence", () => {
    const { actual, configured, nativeControl } = withNativeWorkerOmissions();
    actual.requestHeaders.dedicated.uaArchitecture = '"x86"';
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin", "controlled", nativeControl)).toThrow(/dedicated request UA-CH/);
    actual.requestHeaders.dedicated = { ...fixture("windows").actual.requestHeaders.dedicated, userAgent: configured.userAgent };
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin", "controlled", nativeControl)).toThrow(/dedicated request UA-CH/);
  });

  it("still requires the managed UA on Worker requests with matching hint omission", () => {
    const { actual, configured, nativeControl } = withNativeWorkerOmissions();
    actual.requestHeaders.dedicated.userAgent = nativeControl.window.userAgent;
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin", "controlled", nativeControl)).toThrow(/dedicated request User-Agent/);
  });

  it("rejects a foreign-host native control even when the managed capture alone is valid", () => {
    const { actual, configured } = fixture();
    const nativeControl = fixture("windows").actual;
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin", "controlled", nativeControl)).toThrow(/native control.*host OS|native control.*platform/);
  });

  it("rejects a partial or missing native control header rather than manufacturing permission", () => {
    const { actual, configured } = fixture();
    const nativeControl = structuredClone(actual);
    nativeControl.requestHeaders.dedicated.uaArchitecture = null;
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin", "controlled", nativeControl)).toThrow(/native control.*high-entropy/);
  });

  it("rejects stale Worker navigator identity in a native omission control", () => {
    const { actual, configured } = fixture();
    const nativeControl = structuredClone(actual);
    nativeControl.worker.platform = "Win32";
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin", "controlled", nativeControl)).toThrow(/native control.*platform/);
  });

  it("checks coherent OS identity without claiming x86 or a configured OS version is physically native", () => {
    const { actual, configured } = fixture();
    for (const context of [actual.window, actual.worker]) {
      context.highEntropy!.architecture = "arm";
      context.highEntropy!.platformVersion = "26.3.0";
    }
    for (const headers of Object.values(actual.requestHeaders)) {
      headers.uaArchitecture = '"arm"';
      headers.uaPlatformVersion = '"26.3.0"';
    }
    expect(() => verifyHostIdentityCoherence(actual, configured, "darwin")).not.toThrow();
  });
});
