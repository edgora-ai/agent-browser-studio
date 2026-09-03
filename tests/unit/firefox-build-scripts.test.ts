import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const FIREFOX = path.join(ROOT, "patches", "firefox");
const PREPARE = path.join(FIREFOX, "prepare-source.sh");
const SEED = path.join(FIREFOX, "seed-source-archive.sh");
const VERIFY = path.join(FIREFOX, "verify-source-provenance.sh");
const VERIFY_RELEASE = path.join(FIREFOX, "verify-release-signature.sh");
const APPLY = path.join(FIREFOX, "apply.sh");
const CHECK = path.join(FIREFOX, "check.sh");
const BUILD = path.join(FIREFOX, "build-macos.sh");
const SOURCE_STAMP = "9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc";
const SOURCE_SHA512 = "a77cd664982add628681167ef5939bd6bf0c894aa380cca66f9b5fb265947874d1e819d42264f1dd07c843f8a6dc020da268cca9ff1e064fca019de91af9b996";

describe("Firefox 154 source and build scripts", () => {
  it("have valid bash syntax", () => {
    execFileSync("bash", ["-n", PREPARE, SEED, VERIFY, VERIFY_RELEASE, APPLY, CHECK, BUILD], { stdio: "pipe" });
  });

  it("pin the exact official release source and reject unsafe archives", () => {
    const prepare = fs.readFileSync(PREPARE, "utf8");
    const seed = fs.readFileSync(SEED, "utf8");
    const verify = fs.readFileSync(VERIFY, "utf8");
    expect(prepare).toContain("firefox-154.0.source.tar.xz");
    expect(prepare).toContain("archive.mozilla.org/pub/firefox/releases/154.0/source");
    expect(seed).toContain(SOURCE_STAMP);
    expect(seed).toContain(SOURCE_SHA512);
    expect(seed).toContain("contains an absolute or traversal path");
    expect(seed).toContain("sourcestamp.txt");
    expect(verify).toContain('source_build_id" != "$EXPECTED_BUILD_ID"');
    expect(verify).toContain('source_url" != "$EXPECTED_SOURCE_URL"');
    const release = fs.readFileSync(VERIFY_RELEASE, "utf8");
    expect(release).toContain("827E658608679618CD349F93678E455D76767AA3");
    expect(release).toContain("gpg --batch --status-fd 1 --verify");
    expect(prepare).toContain("verify-release-signature.sh");
    expect(verify).not.toContain("return true");
  });

  it("uses resumable disk-gated preparation outside the repository", () => {
    const prepare = fs.readFileSync(PREPARE, "utf8");
    expect(prepare).toContain("--continue-at -");
    expect(prepare).toContain("FIREFOX_PREPARE_MIN_FREE_GIB:-100");
    expect(prepare).toContain("FIREFOX_POST_SYNC_MIN_FREE_GIB:-70");
    expect(prepare).not.toContain('rm -rf "$FIREFOX_SRC"');
  });

  it("keeps patch assets append-only and final files verifiable", () => {
    const apply = fs.readFileSync(APPLY, "utf8");
    const check = fs.readFileSync(CHECK, "utf8");
    expect(apply).toContain("agent-browser-firefox-patches");
    expect(apply).toContain("apply --reverse --check");
    expect(apply).toContain("PATCHED_SOURCE.sha256");
    expect(check).toContain("PATCHSET.sha256 must list every Firefox patch");
    expect(check).toContain("Firefox source patch is not recorded as applied");
    expect(check).toContain('[[ -d "$directory" ]]');
    // shasum exists on macOS runners; Windows runners use sha256sum via
    // Git Bash (or neither — then verify the manifest files exist instead of
    // shelling out). Mirrors check.sh's own command -v fallback. Probe by
    // actually executing (not `where`, whose PATH differs from execFileSync's
    // on Windows runners and caused a false-positive -> ENOENT).
    const canRun = (bin: string, args: string[]): boolean => {
      try {
        execFileSync(bin, args, { cwd: FIREFOX, stdio: "pipe" });
        return true;
      } catch (e: any) {
        // ENOENT = binary missing -> try next; checksum mismatch = real failure.
        if (e?.code === "ENOENT" || /ENOENT/i.test(String(e?.message || ""))) return false;
        throw e;
      }
    };
    if (canRun("shasum", ["-a", "256", "-c", "PATCHSET.sha256"])) {
      // verified by the probe itself
    } else if (canRun("sha256sum", ["-c", "PATCHSET.sha256"])) {
      // verified by the probe itself
    } else {
      expect(fs.existsSync(path.join(FIREFOX, "PATCHSET.sha256"))).toBe(true);
    }
  });

  it("builds incrementally with full Xcode and a canonical mozconfig", () => {
    const build = fs.readFileSync(BUILD, "utf8");
    const mozconfig = fs.readFileSync(path.join(FIREFOX, "mozconfig.macos-arm64"), "utf8");
    expect(build).toContain("DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer");
    expect(build).toContain('MOZCONFIG="$PATCH_ROOT/mozconfig.macos-arm64" ./mach build');
    expect(build).toContain("FIREFOX_BUILD_MIN_FREE_GIB:-70");
    expect(build).toContain("codesign --verify --deep --strict");
    expect(mozconfig).toContain("MOZ_OBJDIR=@TOPSRCDIR@/obj-agent-browser-arm64");
    expect(mozconfig).toContain("MOZ_MAKE_FLAGS=\"-j4\"");
    expect(mozconfig).toContain("browser/branding/unofficial");
    expect(mozconfig).not.toContain("branding/official");
  });
});
