import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const h = vi.hoisted(() => ({ failRename: false, failFsync: false }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => { if (h.failRename) throw Object.assign(new Error("synthetic EIO"), { code: "EIO" }); return actual.renameSync(...args); },
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => { if (h.failFsync) throw Object.assign(new Error("synthetic EIO"), { code: "EIO", syscall: "fsync" }); return actual.fsyncSync(...args); },
  };
});
import { applyChromiumWebRtcPreferences, validateChromiumWebRtcPreferences } from "../../src/main/services/browser/webrtc-preferences.js";
import { resolveChromiumWebRtcRoutingPolicy } from "../../src/main/services/browser/webrtc-policy.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "webrtc-preferences-"));
const profile = path.join(root, "owned-profile"), file = path.join(profile, "Default", "Preferences");
const strict = (fingerprintMode: "managed" | "off" = "managed") => resolveChromiumWebRtcRoutingPolicy({ requestedMode: "auto", hasProxy: true, fingerprintMode });
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
beforeEach(() => {
  h.failRename = false; h.failFsync = false;
  for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
});
afterAll(() => { h.failRename = false; h.failFsync = false; fs.rmSync(root, { recursive: true, force: true }); });

describe("Chrome-consumed WebRTC profile preferences", () => {
  it.each(["managed", "off"] as const)("commits and directly reads the actual privacy setting for %s mode", mode => {
    const result = applyChromiumWebRtcPreferences(profile, strict(mode));
    expect(result).toMatchObject({ policy: "disable_non_proxied_udp", changed: true, readbackVerified: true });
    expect(read().webrtc).toEqual({ ip_handling_policy: "disable_non_proxied_udp", ip_handling_url: [] });
    const reopened = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.entries(reopened.webrtc).find(([key]) => key === "ip_handling_policy")?.[1]).toBe("disable_non_proxied_udp");
    expect(() => validateChromiumWebRtcPreferences(profile)).not.toThrow();
  });
  it("preserves unrelated preferences and removes weaker per-origin routing exceptions", () => {
    const original = { intl: { accept_languages: "en-US,en" }, profile: { name: "Owned synthetic profile" },
      webrtc: { event_logs_collection: "disabled", ip_handling_policy: "default", ip_handling_url: [{ url: "https://owned.invalid", handling: "default" }] } };
    fs.writeFileSync(file, JSON.stringify(original));
    applyChromiumWebRtcPreferences(profile, strict());
    const saved = read();
    expect(saved.intl).toEqual(original.intl); expect(saved.profile).toEqual(original.profile);
    expect(saved.webrtc).toEqual({ event_logs_collection: "disabled", ip_handling_policy: "disable_non_proxied_udp", ip_handling_url: [] });
  });
  it("applies explicit Real rather than retaining a stale app-managed proxy restriction", () => {
    applyChromiumWebRtcPreferences(profile, strict());
    const real = resolveChromiumWebRtcRoutingPolicy({ requestedMode: "real", hasProxy: true, fingerprintMode: "managed" });
    expect(applyChromiumWebRtcPreferences(profile, real).policy).toBe("default");
    expect(read().webrtc.ip_handling_policy).toBe("default");
  });
  it("creates only the requested profile/default directories and reads the resulting file", () => {
    const fresh = path.join(root, "fresh", "profile");
    applyChromiumWebRtcPreferences(fresh, strict());
    expect(JSON.parse(fs.readFileSync(path.join(fresh, "Default", "Preferences"), "utf8")).webrtc.ip_handling_policy).toBe("disable_non_proxied_udp");
  });
  it.each(["{", "[]", "null", '{"webrtc":false}', '{"webrtc":[]}'])("refuses malformed preferences without discarding other data: %s", bytes => {
    fs.writeFileSync(file, bytes);
    expect(() => validateChromiumWebRtcPreferences(profile)).toThrow(/could not be validated/);
    expect(() => applyChromiumWebRtcPreferences(profile, strict())).toThrow(/could not be validated/);
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  });
  it("does not follow a Preferences symlink", () => {
    const outside = path.join(root, "unselected-preferences"); fs.writeFileSync(outside, '{"untouched":true}');
    fs.symlinkSync(outside, file);
    expect(() => applyChromiumWebRtcPreferences(profile, strict())).toThrow(/could not be validated/);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe('{"untouched":true}');
  });
  it("does not replace a multiply linked Preferences file", () => {
    fs.writeFileSync(file, "{}"); fs.linkSync(file, path.join(root, "owned-hardlink"));
    expect(() => applyChromiumWebRtcPreferences(profile, strict())).toThrow(/could not be validated/);
    expect(fs.readFileSync(file, "utf8")).toBe("{}");
  });
  it.each(["rename", "fsync"] as const)("reports %s failure without publishing a partial preference file", failure => {
    const original = '{"profile":{"name":"Owned unchanged"}}'; fs.writeFileSync(file, original);
    if (failure === "rename") h.failRename = true; else h.failFsync = true;
    expect(() => applyChromiumWebRtcPreferences(profile, strict())).toThrow(/could not be validated/);
    h.failRename = false; h.failFsync = false;
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["Preferences"]);
  });
});
