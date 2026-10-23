import { describe, expect, it, vi } from "vitest";
import type { BrowserProfileMeta } from "../../src/main/types.js";

// Pure argument fixtures: no config, browser, process or network access.
vi.mock("../../src/main/services/page-eval.js", () => ({
  evaluateInPage: vi.fn(() => { throw new Error("No page/network access"); }),
}));
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => { throw new Error("No process access"); }),
  exec: vi.fn(() => { throw new Error("No process access"); }),
}));

import {
  assertChromiumLaunchProvenance,
  chromiumLaunchRequestHash,
  chromiumLaunchStampArg,
  stampChromiumLaunch,
} from "../../src/main/services/browser/launch-provenance.js";

import { CHROMIUM_WEBRTC_PROFILE_ARG } from "../../src/main/services/browser/webrtc-policy.js";

const policy = "--agent-browser-local-dns-policy=proxy-local-dns-deny";
const bootstrap = "--agent-browser-proxy-bootstrap-host=proxy.example.test";

type Mode = "managed" | "off";

function fixture(mode: Mode) {
  const meta: BrowserProfileMeta = {
    name: "Native DNS provenance fixture", engine: "chromium", platform: "macos",
    fingerprintMode: mode, fingerprintSeed: 12345, proxyMode: "default",
  };
  const requestHash = chromiumLaunchRequestHash(meta, {
    chromiumBin: "/virtual/Chromium.app/Contents/MacOS/Chromium",
    defaultProxy: "fixture",
    proxies: { fixture: { type: "http", host: "proxy.example.test", port: 80 } },
  });
  const payload = { schemaVersion: 1, seed: 12345, platform: "MacIntel", userAgent: "Fixture UA" };
  const args = [
    "--user-data-dir=/virtual/native-dns-profile", CHROMIUM_WEBRTC_PROFILE_ARG, policy, bootstrap,
    ...(mode === "managed" ? [
      `--agent-browser-fingerprint-config=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`,
      `--user-agent=${payload.userAgent}`,
    ] : []),
  ];
  const provenance = stampChromiumLaunch(args, requestHash, mode);
  const stamp = chromiumLaunchStampArg(provenance);
  return { args, requestHash, provenance, stamp };
}

const changes: Array<[string, (args: string[]) => string[]]> = [
  ["removes the deny policy", args => args.filter(arg => arg !== policy)],
  ["changes the deny policy", args => args.map(arg => arg === policy ? "--agent-browser-local-dns-policy=off" : arg)],
  ["removes the bootstrap exception", args => args.filter(arg => arg !== bootstrap)],
  ["changes the bootstrap exception", args => args.map(arg => arg === bootstrap ? "--agent-browser-proxy-bootstrap-host=other.example.test" : arg)],
  ["duplicates the deny policy", args => [...args, "--agent-browser-local-dns-policy=off"]],
  ["duplicates the bootstrap exception", args => [...args, "--agent-browser-proxy-bootstrap-host=other.example.test"]],
  ["removes both operational switches", args => args.filter(arg => arg !== policy && arg !== bootstrap)],
];

for (const mode of ["managed", "off"] as const) {
  describe(`native DNS policy launch provenance in ${mode} mode`, () => {
    it("accepts the unchanged operational policy", () => {
      const value = fixture(mode);
      expect(assertChromiumLaunchProvenance([...value.args, value.stamp], value.requestHash, mode))
        .toEqual(value.provenance);
    });

    it("keeps equivalent argument ordering compatible", () => {
      const value = fixture(mode);
      expect(assertChromiumLaunchProvenance([...value.args].reverse().concat(value.stamp), value.requestHash, mode))
        .toEqual(value.provenance);
    });

    it.each(changes)("rejects an old stamp when a process %s", (_name, change) => {
      const value = fixture(mode);
      expect(() => assertChromiumLaunchProvenance([...change(value.args), value.stamp], value.requestHash, mode))
        .toThrow(/Browser restart required/);
    });
  });
}
