import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const h = vi.hoisted(() => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), "webrtc-proxy-mode-")) };
});
vi.mock("electron", () => ({ app: { getPath: () => h.root }, BrowserWindow: { getAllWindows: () => [] } }));
import { getConfig, getConfigPath, getProfileMeta, normalizePortableProfileMeta, portableProfileContent, reloadConfig, setProfileMeta, setWebRtcDiagnostics, getWebRtcDiagnostics } from "../../src/main/services/config-manager.js";
import { parseBulkCsv } from "../../src/main/services/bulk-import.js";
import { unmeasuredWebRtcPeerConnectivity } from "../../src/main/services/webrtc-peer-probe.js";

const id = "ab_webrtc_proxy_mode";
const disk = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
beforeEach(() => {
  for (const name of fs.readdirSync(h.root)) fs.rmSync(path.join(h.root, name), { recursive: true, force: true });
  reloadConfig(); getConfig();
});
afterAll(() => {
  if (path.dirname(h.root) !== os.tmpdir() || !path.basename(h.root).startsWith("webrtc-proxy-mode-")) throw new Error("Unsafe owned config cleanup");
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe("proxy-only mode survives actual config, portable projection and reload", () => {
  it("writes and reads the selected mode without retaining a misleading rewritten IP", () => {
    setProfileMeta(id, { name: "Owned proxy-only", fingerprintMode: "off", webrtcMode: "altered", webrtcIp: "203.0.113.45" });
    setProfileMeta(id, { webrtcMode: "proxy-only" });
    expect(path.dirname(getConfigPath())).toBe(h.root);
    expect(disk().browserProfiles[id]).toMatchObject({ webrtcMode: "proxy-only", webrtcIp: null });
    reloadConfig();
    const found = Object.entries(getConfig().browserProfiles).find(([key]) => key === id)?.[1];
    expect(found).toMatchObject({ name: "Owned proxy-only", webrtcMode: "proxy-only", webrtcIp: null });
    expect(getProfileMeta(id)?.webrtcMode).toBe("proxy-only");
    expect(portableProfileContent(found)).toMatchObject({ webrtcMode: "proxy-only", webrtcIp: null });
  });
  it("preserves proxy-only through archive/complete-sync metadata normalization", () => {
    const normalized = normalizePortableProfileMeta({ name: "Owned imported proxy", fingerprintMode: "off", engine: "chromium", webrtcMode: "proxy-only", webrtcIp: "203.0.113.45" });
    expect(normalized).toMatchObject({ webrtcMode: "proxy-only", webrtcIp: null });
    setProfileMeta(id, normalized);
    expect(disk().browserProfiles[id].webrtcMode).toBe("proxy-only");
    reloadConfig();
    expect(portableProfileContent(getProfileMeta(id))).toMatchObject({ webrtcMode: "proxy-only", webrtcIp: null });
  });
  it("keeps unsupported mode values rejected on direct configuration writes", () => {
    expect(() => setProfileMeta(id, { webrtcMode: "proxy-all-udp" as any })).toThrow(/Invalid WebRTC mode/);
    expect(disk().browserProfiles[id]).toBeUndefined();
  });
  it("accepts the explicit mode in bulk CSV rather than silently downgrading to Auto", () => {
    expect(parseBulkCsv("name,webrtc_mode\nOwned,proxy-only")).toEqual([{ name: "Owned", webrtcMode: "proxy-only" }]);
  });
  it("persists untested peer connectivity independently of a successful ICE exposure check", () => {
    setProfileMeta(id, { name: "Owned exposure", fingerprintMode: "off" });
    const entry = { at: 12345, outcome: "pass" as const, success: true, rtcAvailable: true, candidates: [], mdnsHosts: [], hostIps: [], srflxIps: [],
      connectionState: "new", rttMs: null, peerConnectivity: unmeasuredWebRtcPeerConnectivity(), error: null, summary: "Owned ICE exposure observation only" };
    setWebRtcDiagnostics(id, [entry]);
    expect(disk().webrtcDiagnostics[id][0].peerConnectivity.status).toBe("not-tested");
    reloadConfig();
    expect(getWebRtcDiagnostics(id).find(row => row.at === 12345)).toEqual(entry);
    expect(getWebRtcDiagnostics(id)[0].peerConnectivity?.receivedBytes).toBe(0);
  });
});
