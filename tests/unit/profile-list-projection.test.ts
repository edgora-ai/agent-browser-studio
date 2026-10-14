// Audit R1 B1/B2 (#107): listBrowserProfiles must project the fields the
// card and edit form read, or UI renders dead controls:
// - appUrl + lock (card App button + lock badge)
// - windowTitlePrefix (edit-form checkbox state; omission forced it on and
//   every save clobbered the stored value via setMeta)
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

// One exclusively acquired binding is shared by the test and hoisted mock.
const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-list-projection-test-")));
  const identity = fs.lstatSync(root);
  const marker = path.join(root, ".fixture-owner");
  const owner = JSON.stringify({ role: "profile-list-projection", root, dev: identity.dev, ino: identity.ino });
  fs.writeFileSync(marker, owner, { flag: "wx", mode: 0o600 });
  const markerIdentity = fs.lstatSync(marker);
  function assertTree(p: string): void {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1))) {
      throw new Error("Refusing non-physical fixture cleanup: " + p);
    }
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) assertTree(path.join(p, name));
  }
  function children(): string[] {
    const st = fs.lstatSync(root);
    const mark = fs.lstatSync(marker);
    if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== identity.dev || st.ino !== identity.ino ||
        fs.realpathSync(root) !== root || !mark.isFile() || mark.isSymbolicLink() || mark.nlink !== 1 ||
        mark.dev !== markerIdentity.dev || mark.ino !== markerIdentity.ino || fs.readFileSync(marker, "utf8") !== owner) {
      throw new Error("Refusing unowned fixture cleanup: " + root);
    }
    const names = fs.readdirSync(root).filter((name) => name !== ".fixture-owner");
    for (const name of names) {
      if (name !== "config.json" && name !== "profiles") throw new Error("Unexpected fixture role: " + name);
      assertTree(path.join(root, name));
    }
    return names;
  }
  function clear(): void {
    for (const name of children()) fs.rmSync(path.join(root, name), { recursive: true });
  }
  return { root, clear, dispose: () => { clear(); fs.unlinkSync(marker); fs.rmdirSync(root); } };
});

afterAll(() => fixture.dispose());

vi.mock("electron", () => ({
  app: {
    getPath: (_name: string) => fixture.root,
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  createBrowserProfile,
  listBrowserProfiles,
} from "../../src/main/services/browser-manager.js";
import { reloadConfig, setProfileMeta } from "../../src/main/services/config-manager.js";

describe("listBrowserProfiles projection (audit B1/B2)", () => {
  beforeEach(() => {
    fixture.clear();
    reloadConfig();
  });
  afterEach(() => {
    // Reload while the fixture still exists; do not recreate data after cleanup.
    reloadConfig();
    fixture.clear();
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

  it("projects renderScaleMode with a native default and a strict round-trip", () => {
    const { dirId: defaultId } = createBrowserProfile({
      name: "ScaleDefault",
      platform: "windows",
      fingerprintSeed: 33333,
    });
    expect(listBrowserProfiles().find((p) => p.dirId === defaultId)!.renderScaleMode).toBe("native");

    const { dirId: strictId } = createBrowserProfile({
      name: "ScaleStrict",
      platform: "windows",
      fingerprintSeed: 44444,
      renderScaleMode: "strict",
    });
    expect(listBrowserProfiles().find((p) => p.dirId === strictId)!.renderScaleMode).toBe("strict");

    // setProfileMeta is the edit-dialog path — the stored value must survive
    // a round-trip and project back into the list.
    setProfileMeta(defaultId, { renderScaleMode: "strict" });
    expect(listBrowserProfiles().find((p) => p.dirId === defaultId)!.renderScaleMode).toBe("strict");
  });
});
