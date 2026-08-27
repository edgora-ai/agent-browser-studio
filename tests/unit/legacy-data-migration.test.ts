import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  hashDirectoryTree,
  migrateLegacyChromiumCache,
  migrateLegacyUserData,
} from "../../src/main/services/legacy-data-migration.js";

const roots: string[] = [];

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-migration-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("legacy Agent Browser Studio migration", () => {
  it("copies profiles byte-for-byte and rewrites the config schema and paths", () => {
    const base = root();
    const source = path.join(base, "CloakLite");
    const target = path.join(base, "AgentBrowserStudio");
    const oldCache = path.join(base, ".roxy-lite-cloak");
    const newCache = path.join(base, ".agent-browser-studio");
    const profile = path.join(source, "cloak-profiles", "cb_existing", "Default");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "Preferences"), JSON.stringify({ stable: true }));
    fs.symlinkSync("Preferences", path.join(profile, "Preferences.link"));
    fs.writeFileSync(path.join(source, "config.json"), JSON.stringify({
      version: 3,
      "cloakBin": path.join(oldCache, "chromium-150.0.0.0", "chromium"),
      "cloakProfiles": { cb_existing: { name: "Existing", fontsDir: path.join(source, "fonts", "windows") } },
    }));

    const before = hashDirectoryTree(path.join(source, "cloak-profiles"));
    const report = migrateLegacyUserData({ source, target, legacyChromiumRoot: oldCache, chromiumRoot: newCache });
    const after = hashDirectoryTree(path.join(target, "profiles"));
    const config = JSON.parse(fs.readFileSync(path.join(target, "config.json"), "utf8"));

    expect(report.migrated).toBe(true);
    expect(report.profileCount).toBe(1);
    expect(report.profileFileCount).toBe(1);
    expect(report.profileSymlinkCount).toBe(1);
    expect(after).toEqual(before);
    expect(config.version).toBe(4);
    expect(config["cloakBin"]).toBeUndefined();
    expect(config["cloakProfiles"]).toBeUndefined();
    expect(config.chromiumBin).toContain(".agent-browser-studio");
    expect(config.browserProfiles.cb_existing.fontsDir.replace(/\\/g, "/")).toContain("AgentBrowserStudio/fonts/windows");
    expect(fs.existsSync(source)).toBe(true);
  });

  it("imports only active version directories from the legacy Chromium cache", () => {
    const base = root();
    const source = path.join(base, ".roxy-lite-cloak");
    const target = path.join(base, ".agent-browser-studio");
    fs.mkdirSync(path.join(source, "chromium-149.0.0.0"), { recursive: true });
    fs.mkdirSync(path.join(source, "chromium-150.0.0.0"), { recursive: true });
    fs.mkdirSync(path.join(source, ".chromium-150.0.0.0-previous-deadbeef"), { recursive: true });
    fs.writeFileSync(path.join(source, "chromium-149.0.0.0", "chromium"), "149");
    fs.writeFileSync(path.join(source, "chromium-150.0.0.0", "chromium"), "150");

    const report = migrateLegacyChromiumCache({ source, target });
    expect(report.migratedVersions).toEqual(["149.0.0.0", "150.0.0.0"]);
    expect(fs.existsSync(path.join(target, "chromium-149.0.0.0", "chromium"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".chromium-150.0.0.0-previous-deadbeef"))).toBe(false);
    expect(fs.existsSync(source)).toBe(true);
  });
});
