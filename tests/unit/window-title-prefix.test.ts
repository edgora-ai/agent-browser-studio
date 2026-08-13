import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import {
  resolveWindowTitlePrefix,
  sanitizeWindowTitlePrefix,
} from "../../src/main/services/browser-manager.js";

describe("window title prefix (RoxyBrowser taskbar Profile Name)", () => {
  it("defaults to the profile name when the field is unset or empty", () => {
    expect(resolveWindowTitlePrefix({ name: "US-Buyer" } as any)).toBe("US-Buyer");
    expect(resolveWindowTitlePrefix({ name: "US-Buyer", windowTitlePrefix: "" } as any)).toBe("US-Buyer");
  });

  it("uses a custom prefix verbatim when set", () => {
    expect(resolveWindowTitlePrefix({ name: "US-Buyer", windowTitlePrefix: "Ops-01" } as any)).toBe("Ops-01");
  });

  it("disables the prefix when set to null", () => {
    expect(resolveWindowTitlePrefix({ name: "US-Buyer", windowTitlePrefix: null } as any)).toBeNull();
  });

  it("sanitizes control characters, collapses whitespace and caps length", () => {
    expect(sanitizeWindowTitlePrefix("  Ops\n\u0001 One  ")).toBe("Ops One");
    expect(sanitizeWindowTitlePrefix("x".repeat(200)).length).toBe(64);
    expect(sanitizeWindowTitlePrefix("   ")).toBe("");
  });

  it("returns null when the resolved prefix is empty", () => {
    expect(resolveWindowTitlePrefix({ name: "   " } as any)).toBeNull();
    expect(resolveWindowTitlePrefix({ name: "", windowTitlePrefix: "" } as any)).toBeNull();
  });
});
