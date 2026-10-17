import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const PATCH_ROOT = path.join(ROOT, "patches", "chromium");
const HEADER = "third_party/blink/public/common/roxy_fingerprint_config.h";
const CPU_PATCH = "0055-native-macos-cpu-metadata.patch";
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const read = (relative: string) => fs.readFileSync(path.join(PATCH_ROOT, relative), "utf8");
const metadata = (header: string) => header.match(/UserAgentMetadata GetUserAgentMetadata\(bool low_entropy_only\) const \{[\s\S]*?\n  \}/)?.[0] || "";
const macBlock = (source: string) => source.match(/^#if BUILDFLAG\(IS_MAC\)\n[\s\S]*?^#endif\n/gm)?.[0] || "";
const manifest = (relative: string) => new Map(read(relative).trim().split(/\r?\n/).map((line) => {
  const [digest, file] = line.split("  ");
  return [file, digest];
}));

// Source/provenance constraints only: reconstruct the real immutable header patch
// chain in a tiny disposable directory. This is NOT native compilation, a native
// CPU/Rosetta runtime test, or browser/site acceptance, and needs no native tree.
describe("Chromium macOS CPU metadata source constraints (not runtime acceptance)", () => {
  let temporary: string;
  let beforeCpuPatch: string;
  let finalHeader: string;

  beforeAll(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-cpu-source-"));
    const target = path.join(temporary, HEADER);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(PATCH_ROOT, "files", HEADER), target);
    for (const name of fs.readdirSync(path.join(PATCH_ROOT, "patches")).filter((file) => file.endsWith(".patch")).sort()) {
      if (name === CPU_PATCH) beforeCpuPatch = fs.readFileSync(target, "utf8");
      const patch = read(path.join("patches", name));
      if (!patch.includes(`+++ b/${HEADER}\n`)) continue;
      const options = {
        encoding: "utf8" as const,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
      };
      const args = ["-C", temporary, "apply", `--include=${HEADER}`];
      const patchPath = path.join(PATCH_ROOT, "patches", name);
      const forward = spawnSync("git", [...args, "--check", patchPath], options);
      if (forward.status === 0) execFileSync("git", [...args, patchPath], options);
      else {
        // Like check.sh, accept an immutable repair already represented by the
        // preceding chain (0048), but never skip a genuinely conflicting patch.
        const reverse = spawnSync("git", [...args, "--reverse", "--check", patchPath], options);
        if (reverse.status !== 0) throw new Error(`${name} header chain conflict: ${forward.stderr}; reverse: ${reverse.stderr}`);
      }
    }
    finalHeader = fs.readFileSync(target, "utf8");
    beforeCpuPatch ??= finalHeader;
  }, 30_000);

  afterAll(() => {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  });

  it("resolves the actual macOS CPU with the exported base API behind an IS_MAC guard", () => {
    const body = metadata(finalHeader);
    const guarded = macBlock(body);
    expect(guarded.length, "managed metadata must contain guarded runtime macOS CPU selection").toBeGreaterThan(0);
    expect(guarded.includes("base::mac::GetCPUType()"), "compile architecture, UA and config values are not a CPU oracle").toBe(true);
    expect(guarded.includes('if (platform_ == "MacIntel")'), "foreign OS personas must retain their existing contract").toBe(true);
    expect(/#include "build\/build_config.h"/.test(finalHeader)).toBe(true);
    expect(/^#if BUILDFLAG\(IS_MAC\)\n#include "base\/mac\/mac_util.h"\n#endif$/m.test(finalHeader), "mac-only include must not escape the platform guard").toBe(true);
    expect(body.replace(guarded, "").includes("base::mac::"), "mac-only symbols must not escape their guard").toBe(false);
    expect(/ARCH_CPU|process\.arch|sysctl|FindString\("architecture"\)/.test(guarded), "reuse native GetCPUType rather than guessing or inventing another CPU detector").toBe(false);
  });

  it("maps native Intel to x86 and both ARM and translated Intel to arm in the shared producer", () => {
    const guarded = macBlock(metadata(finalHeader));
    expect(/switch \(base::mac::GetCPUType\(\)\)/.test(guarded)).toBe(true);
    expect(/case base::mac::CPUType::kIntel:\s*metadata\.architecture = "x86";\s*break;/.test(guarded), "Intel branch must remain x86").toBe(true);
    expect(/case base::mac::CPUType::kArm:\s*case base::mac::CPUType::kTranslatedIntel:\s*metadata\.architecture = "arm";\s*break;/.test(guarded), "Rosetta is ARM for native UA-CH, not an x86 persona").toBe(true);
    expect(metadata(finalHeader).indexOf("if (low_entropy_only)")).toBeLessThan(metadata(finalHeader).indexOf("base::mac::GetCPUType()"));
    expect(metadata(finalHeader).includes('metadata.bitness = "64";')).toBe(true);
  });

  it("preserves all other header bytes, including bitness, low-entropy/off behavior and GPU fall-through", () => {
    const guarded = macBlock(metadata(finalHeader));
    expect(guarded.length).toBeGreaterThan(0);
    const stripped = finalHeader.replace('#include "build/build_config.h"\n', "")
      .replace('#if BUILDFLAG(IS_MAC)\n#include "base/mac/mac_util.h"\n#endif\n\n', "")
      .replace(guarded, "");
    expect(sha256(stripped), "0055 must change only includes and the guarded CPU selection").toBe(sha256(beforeCpuPatch));
    expect(/metadata\.architecture = "x86";\n#if BUILDFLAG\(IS_MAC\)/.test(metadata(finalHeader))).toBe(true);
  });

  it("ships one forward-only header patch without an embedder dependency or unrelated source changes", () => {
    const patch = read(path.join("patches", CPU_PATCH));
    expect(patch.match(/^diff --git /gm)).toHaveLength(1);
    expect(patch.includes(`+++ b/${HEADER}\n`)).toBe(true);
    const added = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++ ")).join("\n");
    expect(/embedder_support|webgpu|webgl|metadata\.(bitness|platform|model|wow64|form_factors)\s*=/.test(added)).toBe(false);
  });

  it("binds the reconstructed final header and appended patch to the exact source/input manifests", () => {
    const sources = manifest("PATCHED_SOURCE.sha256");
    const inputs = manifest("PATCHSET.sha256");
    expect(sources.size).toBe(111);
    expect(inputs.size).toBe(58);
    expect(inputs.get(path.posix.join("patches", CPU_PATCH))).toBe(sha256(read(path.join("patches", CPU_PATCH))));
    expect(sources.get(HEADER)).toBe(sha256(finalHeader));
    expect(inputs.get("PATCHED_SOURCE.sha256")).toBe(sha256(read("PATCHED_SOURCE.sha256")));
    expect(inputs.get(path.posix.join("files", HEADER))).toBe("9cf1b581d5d8ca8094e8f5b0bc87ef64d188cfac98612607a92b14c146ef0fa7");
  });
});
