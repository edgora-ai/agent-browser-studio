import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import {
  parseCloakProcessLine,
  patchThirdPartyCookieCompatibility,
  stripManagedFingerprintArgs,
} from "../../src/main/services/cloak-manager.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("fingerprint pass-through launch mode", () => {
  it("removes every managed identity consumer while preserving operational and proxy switches", () => {
    expect(stripManagedFingerprintArgs([
      "--user-data-dir=/tmp/profile",
      "--remote-debugging-port=9222",
      "--fingerprint=12345",
      "--fingerprint-platform=windows",
      "--fingerprint-timezone=Asia/Shanghai",
      "--roxy-fingerprint-config=encoded",
      "--user-agent=spoofed",
      "--lang=zh-CN",
      "--window-size=1280,800",
      "--window-position=32,32",
      "--force-device-scale-factor=2",
      "--proxy-server=socks5://127.0.0.1:1080",
    ])).toEqual([
      "--user-data-dir=/tmp/profile",
      "--remote-debugging-port=9222",
      "--proxy-server=socks5://127.0.0.1:1080",
    ]);
  });

  it("uses stock Chromium cookie preferences and restores the exact prior values", () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloak-cookie-compat-"));
    tempDirs.push(profileDir);
    const prefsPath = path.join(profileDir, "Default", "Preferences");
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    const original = {
      profile: { cookie_controls_mode: 1, untouched: "profile" },
      tracking_protection: {
        tracking_protection_3pcd_enabled: true,
        block_all_3pc_toggle_enabled: true,
        untouched: "tracking",
      },
      unrelated: { value: 7 },
    };
    fs.writeFileSync(prefsPath, JSON.stringify(original));

    patchThirdPartyCookieCompatibility(profileDir, true);
    const enabled = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    expect(enabled.profile.cookie_controls_mode).toBe(0);
    expect(enabled.tracking_protection.tracking_protection_3pcd_enabled).toBe(false);
    expect(enabled.tracking_protection.block_all_3pc_toggle_enabled).toBe(false);
    expect(enabled.unrelated).toEqual(original.unrelated);

    // Repeated enable must not replace the original backup with forced values.
    patchThirdPartyCookieCompatibility(profileDir, true);
    patchThirdPartyCookieCompatibility(profileDir, false);
    expect(JSON.parse(fs.readFileSync(prefsPath, "utf-8"))).toEqual(original);
    expect(fs.existsSync(path.join(profileDir, ".roxy-third-party-cookie-backup.json"))).toBe(false);
  });

  it("ignores lingering profile helpers that do not own a valid CDP endpoint", () => {
    const profileDir = "/tmp/Cloak Profile";
    expect(parseCloakProcessLine(
      `4201 Chromium Helper --user-data-dir="${profileDir}" --type=renderer`,
      profileDir,
    )).toBeNull();
    expect(parseCloakProcessLine(
      `4202 Chromium --user-data-dir="${profileDir}" --remote-debugging-port=0`,
      profileDir,
    )).toBeNull();
    expect(parseCloakProcessLine(
      `4203 Chromium --user-data-dir="${profileDir}" --remote-debugging-port=9222`,
      profileDir,
    )).toEqual({ pid: 4203, cdpPort: 9222 });
  });
});
