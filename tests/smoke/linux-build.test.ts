// Smoke tests — Linux engine build path + multi-platform packaging config.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "../..");

describe("Smoke — Linux engine build path", () => {
  it("args.gn.linux exists and mirrors the macOS release surface", () => {
    const gn = fs.readFileSync(path.join(ROOT, "patches/chromium/args.gn.linux"), "utf8");
    expect(gn).toContain('target_os = "linux"');
    expect(gn).toContain("is_official_build = true");
    expect(gn).toContain('ffmpeg_branding = "Chrome"');
    expect(gn).toContain("proprietary_codecs = true");
    expect(gn).toContain("enable_widevine = true");
    expect(gn).toContain("enable_widevine_cdm_component = false");
    // Key=value lines only (no GN expressions that a smoke test cannot parse).
    for (const line of gn.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      expect(t, "unparseable gn line: " + t).toMatch(/^[\w]+ = /);
    }
  });

  it("build-linux.sh is present, executable and shell-valid", () => {
    const p = path.join(ROOT, "patches/chromium/build-linux.sh");
    expect(fs.existsSync(p)).toBe(true);
    const mode = fs.statSync(p).mode;
    if (process.platform !== "win32") {
    expect(mode & 0o111, "build-linux.sh must be executable").not.toBe(0);
    }
    // bash -n must pass (dry syntax check).
    expect(() => execFileSync("bash", ["-n", p], { stdio: "pipe" })).not.toThrow();
    const src = fs.readFileSync(p, "utf8");
    expect(src).toContain("args.gn.linux");
    expect(src).toContain("apply.sh");
    expect(src).toContain("autoninja -C");
  });
});

describe("Smoke — Multi-platform packaging", () => {
  it("electron-builder.yml defines mac, win and linux targets", () => {
    const yml = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");
    expect(yml).toContain("mac:");
    expect(yml).toContain("win:");
    expect(yml).toContain("linux:");
    expect(yml).toContain("AppImage");
    expect(yml).toContain("arm64");
  });

  it("Dockerfile wires the Linux engine binary path for the headless image", () => {
    const df = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
    expect(df).toContain("AGENT_BROWSER_CHROMIUM_BINARY_PATH=/opt/chromium/chrome");
    expect(df).toContain("build-linux.sh");
  });

  it("docker-compose mounts the Linux engine binary", () => {
    const dc = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    expect(dc).toContain("./chromium:/opt/chromium");
    expect(dc).toContain("AGENT_BROWSER_CHROMIUM_BINARY_PATH: /opt/chromium/chrome");
  });
});
