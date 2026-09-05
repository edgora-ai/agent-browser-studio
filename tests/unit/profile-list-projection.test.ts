// Audit R1 B1/B2 (#107): listBrowserProfiles must project the fields the
// card and edit form read, or UI renders dead controls:
// - appUrl + lock (card App button + lock badge)
// - windowTitlePrefix (edit-form checkbox state; omission forced it on and
//   every save clobbered the stored value via setMeta)
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-list-projection-test");

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" || name === "home" ? TEST_USER_DATA : "/tmp"),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  createBrowserProfile,
  listBrowserProfiles,
} from "../../src/main/services/browser-manager.js";
import { reloadConfig } from "../../src/main/services/config-manager.js";

describe("listBrowserProfiles projection (audit B1/B2)", () => {
  beforeEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
  });
  afterEach(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
  });

  it("projects appUrl, lock and windowTitlePrefix", () => {
    const { dirId } = createBrowserProfile({
      name: "Proj",
      platform: "windows",
      fingerprintSeed: 11111,
      appUrl: "https://example.com/app",
      windowTitlePrefix: null,
    });
    const found = listBrowserProfiles().find((p) => p.dirId === dirId);
    expect(found).toBeTruthy();
    expect(found!.appUrl).toBe("https://example.com/app");
    // lock defaults to null (unlocked) — the card reads p.lock.owner.
    expect(found!.lock).toBe(null);
    // Explicit null prefix survives (edit form: checkbox off).
    expect(found!.windowTitlePrefix).toBe(null);
  });

  it("projects a custom window title prefix verbatim", () => {
    const { dirId } = createBrowserProfile({
      name: "Proj2",
      platform: "windows",
      fingerprintSeed: 22222,
      windowTitlePrefix: "shop-",
    });
    const found = listBrowserProfiles().find((p) => p.dirId === dirId);
    expect(found!.windowTitlePrefix).toBe("shop-");
  });
});
