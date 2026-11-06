import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "patches", "chromium");
const PATCH = "patches/0058-canvas-bounded-pixel-access.patch";
const SOURCE = "third_party/blink/renderer/platform/graphics/image_data_buffer.cc";
const read = (name: string) => fs.readFileSync(path.join(ROOT, name), "utf8");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const patch = read(PATCH);
const added = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1)).join("\n");
const resultingHunks = patch.split("\n").filter((line) => line.startsWith(" ")
  || (line.startsWith("+") && !line.startsWith("+++")))
  .map((line) => line.slice(1)).join("\n");

// Portable source/ledger contracts only, not C++ execution or Android acceptance.
describe("bounded native Canvas pixel access source contracts", () => {
  it("appends 0058 while preserving every earlier patch and initial payload", () => {
    const prior = read("PATCHSET.sha256").split(/\r?\n/).filter((line) => {
      if (!line || line.endsWith("  PATCHED_SOURCE.sha256")) return false;
      const numbered = / {2}patches\/(\d{4})-/.exec(line);
      return !numbered || numbered[1] < "0058";
    }).join("\n") + "\n";
    expect(sha(prior)).toBe("b61bb144115bfabb32de128aac00e4366848ee42d88dd2e5f14d87c9e26928a4");
    expect(sha(patch)).toBe("39ac1d00d6017247088381d0fc0fccceff230a700ddb525fcec41f65fd2904f7");
  });

  it("hashes the exact new patch and rolling source manifest once", () => {
    const ledger = read("PATCHSET.sha256").trim().split(/\r?\n/);
    const paths = ledger.map((line) => line.slice(66));
    expect(new Set(paths).size).toBe(paths.length);
    expect(ledger.filter((line) => line.endsWith(`  ${PATCH}`))).toEqual([`${sha(patch)}  ${PATCH}`]);
    expect(ledger.filter((line) => line.endsWith("  PATCHED_SOURCE.sha256")))
      .toEqual([`${sha(read("PATCHED_SOURCE.sha256"))}  PATCHED_SOURCE.sha256`]);
    for (const line of ledger) {
      expect(line).toMatch(/^[a-f0-9]{64} {2}\S+$/);
      expect(sha(fs.readFileSync(path.join(ROOT, line.slice(66))))).toBe(line.slice(0, 64));
    }
  });

  it("changes only the Canvas implementation, not compiler policy or fingerprint configuration", () => {
    expect(patch.match(/^diff --git /gm)).toHaveLength(1);
    expect(patch).toContain(`+++ b/${SOURCE}`);
    expect(patch).not.toMatch(/^\+\+\+ b\/.*(?:\.gn|\.gni|roxy_fingerprint_config\.h)$/m);
    expect(added).not.toMatch(/UNSAFE_BUFFERS|UNSAFE_BUFFER_USAGE|reinterpret_cast|#pragma|Wno-|no_sanitize/);
  });

  it("bounds the complete pixel storage, each row and each pixel", () => {
    expect(added).toContain("gfx::SkPixmapToWritableSpan(pixmap)");
    expect(added).toContain("if (pixels.empty())");
    expect(added).toContain("const auto row = pixels.subspan(");
    expect(added).toContain("static_cast<size_t>(y) * pixmap.rowBytes()");
    expect(added).toContain("static_cast<size_t>(pixmap.width()) * bytes_per_pixel");
    expect(added).toContain("row.subspan(static_cast<size_t>(x) * bytes_per_pixel,");
    expect(added.indexOf("if (pixels.empty())")).toBeLessThan(added.indexOf("pixels.subspan("));
    expect(added).not.toMatch(/row\s*\+|uint8_t\s*\*/);
  });

  it("copies half and float words through aligned arrays without aliasing raw pixel memory", () => {
    expect(added).toContain("std::array<uint16_t, 4> channels;");
    expect(added).toContain("std::array<uint32_t, 4> channels;");
    expect(added.match(/base::as_writable_byte_span\(channels\)\.copy_from\(pixel\)/g)).toHaveLength(2);
    expect(added.match(/pixel\.copy_from\(base::as_byte_span\(channels\)\)/g)).toHaveLength(2);
    expect(added).not.toContain("std::bit_cast");
  });

  it("preserves coordinate hashing, RGB-only deterministic LSBs and alpha/nonfinite skipping", () => {
    expect(resultingHunks).toContain("uint64_t hash = config.canvas_noise_seed();");
    expect(resultingHunks).toContain("static_cast<uint64_t>(y) << 32 | static_cast<uint32_t>(x)");
    expect(resultingHunks).toContain("hash = MixCanvasNoise(hash);");
    expect(resultingHunks).toContain("hash % 3");
    expect(resultingHunks).toContain("(hash >> 8) & 1");
    expect(resultingHunks).toContain("if (pixel[3] == 0)");
    expect(resultingHunks).toContain("(pixel[channel] & 0xfeU) | desired_bit");
    expect(resultingHunks).toContain("(channels[3] & 0x7fff) == 0");
    expect(resultingHunks).toContain("(channels[3] & 0x7fffffffU) == 0");
    expect(resultingHunks).toContain("(value & 0x7c00) == 0x7c00");
    expect(resultingHunks).toContain("(value & 0x7f800000U) == 0x7f800000U");
    expect(resultingHunks).toContain("(value & 0xfffeU) | desired_bit");
    expect(resultingHunks).toContain("(value & 0xfffffffeU) | desired_bit");
  });

  it("records the tested Canvas bytes and explicitly limits acceptance claims", () => {
    const manifest = read("PATCHED_SOURCE.sha256").trim().split(/\r?\n/);
    expect(manifest.filter((line) => line.endsWith(`  ${SOURCE}`)))
      .toEqual([`4297afdbc0e0a16f37dbc3e14532e5e62431dd673d7fec51fb1e23c4737bf234  ${SOURCE}`]);
    const entry = read("PATCH_HISTORY.md").split("### `0058`")[1];
    expect(entry).toContain("object-only validation");
    expect(entry).toContain("174 whole-buffer oracle cases");
    expect(entry).toContain("test shims");
    expect(entry).toContain("not a full Chromium link/APK");
    expect(entry).toContain("explicit new source epoch");
  });
});
