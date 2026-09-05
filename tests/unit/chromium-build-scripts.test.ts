import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const PREPARE = path.join(ROOT, "patches", "chromium", "prepare-source.sh");
const SEED_ARCHIVE = path.join(ROOT, "patches", "chromium", "seed-source-archive.sh");
const ADVANCE_SOURCE = path.join(ROOT, "patches", "chromium", "advance-source-compare.mjs");
const ADVANCE_GITILES = path.join(ROOT, "patches", "chromium", "advance-gitiles-dependency.mjs");
const VERIFY_PROVENANCE = path.join(ROOT, "patches", "chromium", "verify-source-provenance.sh");
const APPLY_PATCHES = path.join(ROOT, "patches", "chromium", "apply.sh");
const CHECK_PATCHES = path.join(ROOT, "patches", "chromium", "check.sh");
const BUILD_MACOS = path.join(ROOT, "patches", "chromium", "build-macos.sh");
const PATCHED_SOURCE = path.join(ROOT, "patches", "chromium", "PATCHED_SOURCE.sha256");
const ENGINE_VERIFY = path.join(ROOT, ".github", "workflows", "engine-verify.yml");

describe("Chromium macOS source and build scripts", () => {
  it("have valid bash syntax", () => {
    execFileSync("bash", ["-n", PREPARE, SEED_ARCHIVE, VERIFY_PROVENANCE, APPLY_PATCHES, CHECK_PATCHES, BUILD_MACOS], { stdio: "pipe" });
    execFileSync(process.execPath, ["--check", ADVANCE_SOURCE], { stdio: "pipe" });
    execFileSync(process.execPath, ["--check", ADVANCE_GITILES], { stdio: "pipe" });
  });

  it("preserves payload evolution across incremental patch resumes", () => {
    const apply = fs.readFileSync(APPLY_PATCHES, "utf8");
    expect(apply).toContain("preserving evolved payload");
    expect(apply.indexOf('STATE_DIR="$GIT_DIR/roxy-fingerprint-patches"')).toBeLessThan(
      apply.indexOf('copy_file "third_party/blink/public/common/roxy_fingerprint_config.h"'),
    );
    const repair = fs.readFileSync(
      path.join(ROOT, "patches", "chromium", "patches", "0048-restore-evolved-fingerprint-payload.patch"),
      "utf8",
    );
    expect(repair).toContain("ManagedGenericFontFamily");
    expect(repair).toContain("agent-browser-fingerprint-config");
    const genericSemantics = fs.readFileSync(
      path.join(ROOT, "patches", "chromium", "patches", "0049-preserve-generic-font-family-semantics.patch"),
      "utf8",
    );
    expect(genericSemantics).toContain("bool is_generic");
    expect(genericSemantics).toContain("!is_generic || !enabled_");
    const secureDns = fs.readFileSync(
      path.join(ROOT, "patches", "chromium", "patches", "0050-parse-managed-secure-dns-config.patch"),
      "utf8",
    );
    expect(secureDns).toContain('root->FindDict("secureDns")');
    expect(secureDns).toContain("secure_dns_templates_.size() >= 8");

    const patchedSourceBytes = fs.readFileSync(PATCHED_SOURCE);
    const patchedSource = patchedSourceBytes.toString("utf8").trim().split(/\r?\n/);
    expect(patchedSource).toHaveLength(95);
    expect(patchedSource.some((line) => line.endsWith("  third_party/blink/public/common/roxy_fingerprint_config.h"))).toBe(true);
    const patchedSourceSha = createHash("sha256").update(patchedSourceBytes).digest("hex");
    expect(fs.readFileSync(path.join(ROOT, "patches", "chromium", "PATCHSET.sha256"), "utf8"))
      .toContain(`${patchedSourceSha}  PATCHED_SOURCE.sha256`);
    expect(apply).toContain('verify_sha256_manifest "$CHROMIUM_SRC" "$PATCH_ROOT/PATCHED_SOURCE.sha256"');
    const check = fs.readFileSync(CHECK_PATCHES, "utf8");
    expect(check).toContain("verify_source_manifest");
    expect(check).toContain("apply --cached --reverse --check");
  });

  it("prepares a standard resumable gclient root/src checkout", () => {
    const script = fs.readFileSync(PREPARE, "utf8");
    expect(script).toContain("GCLIENT_COMMAND");
    expect(script).toContain("config --name=src --unmanaged");
    expect(script).toContain("--revision \"src@$CHROMIUM_COMMIT\"");
    expect(script).toContain("--no-history");
    expect(script).toContain("CHROMIUM_PREPARE_MIN_FREE_GIB");
    expect(script).not.toContain("rm -rf");
  });

  it("runs every engine job for scheduled and version-tag events", () => {
    const workflow = fs.readFileSync(ENGINE_VERIFY, "utf8");
    // Sale-91: linux x64 + linux arm64 + windows x64 + macos arm64 = 4 artifacts.
    expect(workflow.match(/github\.event_name != 'workflow_dispatch'/g)).toHaveLength(4);
    expect(workflow).not.toMatch(/^\s*if: \$\{\{ inputs\.platform/m);
  });

  it("ships a linux arm64 AppImage (sale-91: x64+arm64)", () => {
    const workflow = fs.readFileSync(ENGINE_VERIFY, "utf8");
    expect(workflow).toContain("runs-on: ubuntu-24.04-arm");
    expect(workflow).toContain("name: agent-browser-linux-arm64");
    expect(workflow).toContain('bash patches/chromium/build-linux.sh "${{ github.workspace }}/chromium-src-152" arm64');
  });

  it("supports a provenance-checked archive seed when Git pack streams truncate", () => {
    const prepare = fs.readFileSync(PREPARE, "utf8");
    const seed = fs.readFileSync(SEED_ARCHIVE, "utf8");
    expect(prepare).toContain("CHROMIUM_SOURCE_PRESEEDED");
    expect(prepare).toContain("verify-source-provenance.sh");
    expect(fs.readFileSync(VERIFY_PROVENANCE, "utf8")).toContain(".chromium-source-commit");
    expect(prepare).toContain("GCLIENT_NO_HISTORY");
    expect(seed).toContain("tar -tf");
    expect(seed).toContain("cygpath -u");
    expect(seed).toContain('"${SHA256_COMMAND[@]}" < "$ARCHIVE"');
    expect(seed).toContain("contains an absolute or traversal path");
    expect(seed).toContain("trusted Chromium 152.0.7977.65 archive");
    expect(seed).toContain("Archive-SHA256");
    expect(seed).toContain("commit-tree");
    const advance = fs.readFileSync(ADVANCE_SOURCE, "utf8");
    expect(advance).toContain('const EXPECTED_FILES = 172');
    expect(advance).toContain('const EXPECTED_DELTA_SHA256 = "0d5cbb9363bf4b5b33bf77aac43a982cbf767a89875081645921db50b1185c2d"');
    expect(advance).toContain('createHash("sha256")');
    expect(advance).toContain('!/^[0-9a-f]{40}$/.test(file.sha || "")');
    expect(advance).toContain("repos/chromium/chromium/git/blobs/");
    expect(advance).toContain("gitBlobSha(target)");
    expect(advance).toContain(".chromium-source-commit");
    expect(advance).toContain('file.status === "removed"');
    expect(advance).toContain('file.status === "renamed"');
    const gitiles = fs.readFileSync(ADVANCE_GITILES, "utf8");
    expect(gitiles).toContain("Unsafe symlink target");
    expect(gitiles).toContain('["hash-object", "--stdin"]');
    const check = fs.readFileSync(CHECK_PATCHES, "utf8");
    expect(check).toContain("verify-source-provenance.sh");
    expect(check).toContain("archive source patch is not recorded as applied");
  });

  // Windows Git Bash tar/gzip of even a tiny tree can exceed the 5s default
  // vitest timeout on loaded CI runners — allow 60s (Linux/macOS unaffected).
  it("seeds archive provenance without adding the source tree to Git", { timeout: 60000 }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-archive-seed-"));
    try {
      const root = path.join(temp, "build");
      const src = path.join(root, "src");
      const archiveTree = path.join(temp, "chromium-152.0.7977.72");
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(root, ".gclient"), "solutions = []\n");
      execFileSync("git", ["-C", src, "init", "-q"]);
      fs.mkdirSync(path.join(archiveTree, "chrome", "renderer"), { recursive: true });
      fs.writeFileSync(path.join(archiveTree, "DEPS"), "deps = {}\n");
      fs.writeFileSync(
        path.join(archiveTree, "chrome", "VERSION"),
        "MAJOR=152\nMINOR=0\nBUILD=7977\nPATCH=72\n",
      );
      fs.writeFileSync(path.join(archiveTree, "chrome", "renderer", "chrome_content_renderer_client.cc"), "// seed\n");
      const archiveName = "chromium.tar.gz";
      const archive = path.join(temp, archiveName);
      execFileSync("tar", ["-czf", archiveName, path.basename(archiveTree)], { cwd: temp });
      const archiveSha256 = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
      execFileSync("bash", [SEED_ARCHIVE, root, archive], {
        stdio: "pipe",
        env: { ...process.env, CHROMIUM_ARCHIVE_SHA256: archiveSha256 },
      });
      expect(fs.readFileSync(path.join(src, ".chromium-source-commit"), "utf8").trim()).toBe(
        "026bb13a93d60e7adfefa2bbf58d6f57c2d335cc",
      );
      expect(fs.existsSync(path.join(src, "DEPS"))).toBe(true);
      expect(execFileSync("git", ["-C", src, "ls-files"], { encoding: "utf8" })).toBe("");
      expect(execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects a tampered archive provenance chain", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-provenance-"));
    try {
      execFileSync("git", ["-C", temp, "init", "-q"]);
      execFileSync("git", ["-C", temp, "config", "user.name", "test"]);
      execFileSync("git", ["-C", temp, "config", "user.email", "test@example.invalid"]);
      execFileSync("git", [
        "-C", temp, "commit", "--allow-empty", "-q", "-m", "archive seed",
        "-m", "Upstream-Commit: fc4d67f1788019a27e32511137ceccbd2fafdaaa\nArchive-SHA256: 1a544857555a0c391753e7f9f3016cc07b0288d9da02260c451aa9082b305066",
      ]);
      fs.writeFileSync(path.join(temp, ".chromium-source-base-commit"), "fc4d67f1788019a27e32511137ceccbd2fafdaaa\n");
      fs.writeFileSync(path.join(temp, ".chromium-source-commit"), "026bb13a93d60e7adfefa2bbf58d6f57c2d335cc\n");
      const archiveShaPath = path.join(temp, ".chromium-source-archive.sha256");
      fs.writeFileSync(archiveShaPath, "1a544857555a0c391753e7f9f3016cc07b0288d9da02260c451aa9082b305066\n");
      expect(execFileSync("bash", [VERIFY_PROVENANCE, temp, "026bb13a93d60e7adfefa2bbf58d6f57c2d335cc"], { encoding: "utf8" })).toContain("trusted archive base");
      fs.writeFileSync(archiveShaPath, "0".repeat(64) + "\n");
      expect(() => execFileSync("bash", [VERIFY_PROVENANCE, temp, "026bb13a93d60e7adfefa2bbf58d6f57c2d335cc"], { stdio: "pipe" })).toThrow();
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("keeps source sync separate from the canonical build", () => {
    const script = fs.readFileSync(BUILD_MACOS, "utf8");
    expect(script).toContain("prepare-source.sh");
    expect(script).toContain("CHROMIUM_BUILD_MIN_FREE_GIB");
    expect(script).toContain('autoninja -C "$OUT_DIR" -j "$BUILD_JOBS" chrome');
    expect(script).not.toContain("git clone");
    expect(script).not.toContain("gclient sync");
  });
});
