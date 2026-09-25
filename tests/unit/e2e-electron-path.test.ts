// R0925-04 regression: dev-mode E2E launchers must resolve the node_modules
// Electron binary per platform. The previous hard-coded
// dist/Electron.app/Contents/MacOS/Electron path cannot exist on the
// Windows/Linux engine-verify runners.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveElectronBinary } from "../e2e/helpers/app.js";

const REPO = path.resolve(__dirname, "..", "..");

describe("resolveElectronBinary (R0925-04)", () => {
  it("maps each target platform to its standard Electron dist layout", () => {
    expect(resolveElectronBinary(REPO, "darwin"))
      .toBe(path.join(REPO, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"));
    expect(resolveElectronBinary(REPO, "win32"))
      .toBe(path.join(REPO, "node_modules", "electron", "dist", "electron.exe"));
    expect(resolveElectronBinary(REPO, "linux"))
      .toBe(path.join(REPO, "node_modules", "electron", "dist", "electron"));
  });

  it("resolves to an executable file that actually exists on this host", () => {
    const bin = resolveElectronBinary(REPO);
    expect(fs.existsSync(bin), `missing Electron binary: ${bin}`).toBe(true);
    expect(fs.statSync(bin).isFile()).toBe(true);
  });

  it("no E2E launcher splices the macOS .app path from node_modules anymore", () => {
    const e2eDir = path.join(REPO, "tests", "e2e");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".mjs")) continue;
        // helpers/app.ts is the resolver itself — the mapping lives there.
        if (full.endsWith(path.join("helpers", "app.ts"))) continue;
        const text = fs.readFileSync(full, "utf8");
        // Packaged-app paths (/Applications/*.app, dist staging) are legitimately
        // mac-only; only node_modules/electron splices are forbidden.
        if (/node_modules["']?,?\s*["']electron["'][\s\S]{0,120}MacOS/.test(text)) {
          offenders.push(path.relative(REPO, full));
        }
      }
    };
    walk(e2eDir);
    expect(offenders).toEqual([]);
  });
});
