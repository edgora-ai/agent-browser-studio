import { describe, expect, it } from "vitest";
import { getHostBrowserPlatform } from "../../src/main/services/browser-platform-policy.js";

describe("native-GPU Chromium host platform", () => {
  it.each([
    ["darwin", "macos"],
    ["win32", "windows"],
    ["linux", null],
    ["android", null],
    ["freebsd", null],
    ["MacIntel", null],
    ["Win32", null],
    ["windows", null],
    ["", null],
  ] as const)("maps trusted host %j to %j without guessing from profile labels", (host, expected) => {
    expect(getHostBrowserPlatform(host)).toBe(expected);
  });
});
