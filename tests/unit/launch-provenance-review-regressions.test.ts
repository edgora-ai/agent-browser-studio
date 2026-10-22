import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/main/services/page-eval.js", () => ({ evaluateInPage: vi.fn(() => { throw new Error("No page access in argv regression"); }) }));
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => { throw new Error("No process enumeration in argv regression"); }),
  exec: vi.fn(() => { throw new Error("No process enumeration in argv regression"); }),
}));

import { buildBrowserFingerprintArg, buildBrowserFingerprintConfig } from "../../src/main/services/browser-fingerprint-config.js";
import {
  assertChromiumLaunchProvenance, assertChromiumReuseEvidence,
  chromiumLaunchRequestHash, chromiumLaunchStampArg, stampChromiumLaunch,
} from "../../src/main/services/browser/launch-provenance.js";
import { parseBrowserLaunchProcessLine } from "../../src/main/services/process-discovery.js";
import { CHROMIUM_WEBRTC_PROFILE_ARG } from "../../src/main/services/browser/webrtc-policy.js";

function fixture() {
  const meta = { name: "QA --lang=fr", platform: "macos" as const, fingerprintSeed: 12345, fingerprintMode: "managed" as const };
  const config = buildBrowserFingerprintConfig(meta, "152.0.7977.72");
  const profileDir = "/virtual/profiles/ab_review";
  const executablePath = "/virtual/Managed Chromium/Chromium";
  const args = [
    `--user-data-dir=${profileDir}`, CHROMIUM_WEBRTC_PROFILE_ARG, "--remote-debugging-port=9222", "--fingerprint=12345", "--fingerprint-platform=macos",
    buildBrowserFingerprintArg(meta, "152.0.7977.72"), `--user-agent=${config.userAgent}`, "--lang=en-US",
    "--proxy-server=http://127.0.0.1:18080", "--disable-quic",
    "--agent-browser-window-title-prefix=QA --lang=fr",
  ];
  const requestHash = chromiumLaunchRequestHash(meta, { chromiumBin: executablePath });
  const stamp = stampChromiumLaunch(args, requestHash, "managed");
  return { args, requestHash, stamp, stamped: [...args, chromiumLaunchStampArg(stamp)], profileDir, executablePath };
}

describe("review counterexamples for effective launch argv", () => {
  it("rejects adding --no-proxy-server without changing the stamp", () => {
    const f = fixture();
    expect(() => assertChromiumLaunchProvenance([...f.stamped, "--no-proxy-server"], f.requestHash, "managed"))
      .toThrow(/restart required/i);
  });

  it("does not parse a quoted display-only name as a second --lang argument", () => {
    const f = fixture();
    const line = `4101 "${f.executablePath}" ${f.stamped.map(arg => `"${arg}"`).join(" ")}`;
    const evidence = parseBrowserLaunchProcessLine(line)!;
    expect(evidence.args.filter(arg => arg.startsWith("--lang="))).toEqual(["--lang=en-US"]);
    expect(evidence.args.filter(arg => arg.startsWith("--agent-browser-window-title-prefix=")))
      .toEqual(["--agent-browser-window-title-prefix=QA --lang=fr"]);
    expect(() => assertChromiumReuseEvidence(evidence, {
      profileDir: f.profileDir, executablePath: f.executablePath,
      requestHash: f.requestHash, mode: "managed", pid: 4101, port: 9222,
    })).not.toThrow();
  });
});
