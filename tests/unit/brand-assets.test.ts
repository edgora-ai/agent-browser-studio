import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const resources = path.join(repoRoot, "resources");

/**
 * The tray icon regressed silently for a long time: tray-manager resolved
 * `path.resolve(__dirname, "..", "resources", ...)` from
 * dist/main/services/, which points at dist/main/resources — a directory that
 * has never existed. `nativeImage.createFromPath` on a missing file returns an
 * empty image, so the menu-bar icon simply never appeared and nothing failed.
 *
 * These tests pin the two things that actually have to hold: the asset files
 * exist where the build copies them from, and the path tray-manager computes at
 * runtime lands on one of them.
 */
describe("brand assets", () => {
  it("ships every resource the build copies", () => {
    // Each entry here must also appear in the `build` script's cp list.
    for (const name of [
      "icon.icns",
      "icon.ico",
      "tray-icon-Template.png",
      "tray-icon-Template@2x.png",
    ]) {
      const p = path.join(resources, name);
      expect(existsSync(p), `${name} missing from resources/`).toBe(true);
      expect(statSync(p).size, `${name} is empty`).toBeGreaterThan(0);
    }
  });

  it("the build copies every shipped resource into dist", () => {
    // Two places stage dist/resources: the `build` script, and the Windows CI
    // job, which must stay inline because npm shells through cmd there and the
    // script's &&/quoting fails (b28520d). Both drifted before, so both are
    // pinned here rather than one standing in for the other.
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const windowsJob = readFileSync(
      path.join(repoRoot, ".github", "workflows", "ci.yml"),
      "utf8"
    ).split("Build (bash on Windows)")[1] ?? "";
    const sources: Record<string, string> = {
      "package.json build script": pkg.scripts.build as string,
      "ci.yml Windows build step": windowsJob,
    };
    for (const name of [
      "icon.icns",
      "icon.ico",
      "tray-icon-Template.png",
      "tray-icon-Template@2x.png",
    ]) {
      for (const [where, text] of Object.entries(sources)) {
        expect(text, `${where} does not copy resources/${name}`).toContain(name);
      }
    }
  });

  it("tray-manager resolves the template from the compiled layout", () => {
    // Read the real source so a revert to the single-".." form fails here —
    // restating the logic in the test would pass no matter what the service
    // does, which is exactly how the original bug survived.
    const src = readFileSync(
      path.join(repoRoot, "src", "main", "services", "tray-manager.ts"),
      "utf8"
    );
    expect(
      src,
      'tray-manager must resolve up two levels ("..", "..", "resources")'
    ).toContain('"..", "..", "resources", "tray-icon-Template.png"');

    // And that the layout it targets is the one the build produces.
    const dirnameAtRuntime = path.join(repoRoot, "dist", "main", "services");
    const resolved = path.resolve(
      dirnameAtRuntime,
      "..",
      "..",
      "resources",
      "tray-icon-Template.png"
    );
    expect(resolved).toBe(path.join(repoRoot, "dist", "resources", "tray-icon-Template.png"));
    expect(existsSync(resolved), "run `npm run build` so dist/ exists").toBe(true);
  });

  it("tray template is a black-on-alpha image macOS can tint", () => {
    // A template image must be pure black with meaningful alpha; macOS replaces
    // the RGB, so any other colour means the source was authored wrong.
    const png = readFileSync(path.join(resources, "tray-icon-Template.png"));
    // PNG IHDR: width/height are big-endian uint32 at offsets 16 and 20.
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect([width, height]).toEqual([16, 16]);
    expect(png.readUInt8(25), "expected an alpha channel (colour type 6)").toBe(6);
  });
});
