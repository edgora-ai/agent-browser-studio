#!/usr/bin/env node
/**
 * Update-manifest authoring tool (review item A2).
 *
 * src/main/services/update-manager.ts only CONSUMES update manifests
 * (product=agent-browser-studio, releases[{version,url,sha256,notes,publishedAt,minSupported}]).
 * Nothing produced them, so shipping a release meant hand-writing JSON with a
 * hand-computed sha256. This script closes that half of the loop:
 *
 *   node scripts/release-manifest.mjs \
 *     --file release/abs/agent-browser-studio-1.0.1-mac-arm64.zip \
 *     --version 1.0.1 \
 *     --base-url https://releases.example.com/abs \
 *     --min-supported 1.0.0 \
 *     --notes "First signed arm64 build" \
 *     --out update-manifest.json
 *
 * Re-running with the same version REPLACES that entry (idempotent re-publish);
 * other versions are kept and the list stays sorted newest-first, matching
 * parseUpdateManifest's ordering. Run `npm run build` first if you also want a
 * round-trip check: tests/unit/release-manifest.test.ts validates the generated
 * manifest through the real parser and checkForUpdates().
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const PRODUCT = "agent-browser-studio";
const VERSION_RE = /^\d+(\.\d+)+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function sha256File(filePath) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

/** Numeric dot-segment compare, newest first -- mirrors update-manager.compareVersions. */
export function compareVersionsDesc(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return db - da;
  }
  return 0;
}

function joinUrl(base, fileName) {
  if (!base) return path.resolve(fileName);
  return base.replace(/\/+$/, "") + "/" + fileName.split(/[\\/]/).pop();
}

/**
 * Build (or merge into) a manifest object.
 * opts: { file, version, baseUrl?, notes?, minSupported?, channel?, publishedAt?, existing? }
 */
export function buildManifest(opts) {
  const { file, version } = opts;
  if (!file) throw new Error("--file is required (the release payload archive)");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error("Payload file not found: " + file);
  }
  if (!version || !VERSION_RE.test(version.trim())) {
    throw new Error("Invalid --version: expected dot-separated numerics like 1.0.1, got " + JSON.stringify(version));
  }
  const sha256 = sha256File(file);
  if (!SHA256_RE.test(sha256)) throw new Error("Internal error: computed sha256 is malformed");

  const release = {
    version: version.trim(),
    url: joinUrl(opts.baseUrl, file),
    sha256,
    notes: typeof opts.notes === "string" ? opts.notes : undefined,
    publishedAt: opts.publishedAt || new Date().toISOString(),
    minSupported: typeof opts.minSupported === "string" ? opts.minSupported.trim() : undefined,
  };

  let releases = [];
  let channel = typeof opts.channel === "string" ? opts.channel : undefined;
  if (opts.existing) {
    if (opts.existing.product && opts.existing.product !== PRODUCT) {
      throw new Error("Existing manifest product mismatch: " + opts.existing.product);
    }
    if (!Array.isArray(opts.existing.releases)) throw new Error("Existing manifest has no releases array");
    releases = opts.existing.releases.filter((r) => r && r.version !== release.version);
    if (!channel && typeof opts.existing.channel === "string") channel = opts.existing.channel;
  }
  releases.push(release);
  releases.sort((a, b) => compareVersionsDesc(a.version, b.version));
  return { product: PRODUCT, channel, releases };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error("Unexpected argument: " + a);
    const key = a.slice(2);
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Missing value for --" + key);
    out[key] = argv[i + 1];
    i += 1;
  }
  return out;
}

export function runCli(argv) {
  const args = parseArgs(argv);
  let existing;
  if (args.manifest) {
    if (!fs.existsSync(args.manifest)) throw new Error("Existing manifest not found: " + args.manifest);
    existing = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  }
  const manifest = buildManifest({
    file: args.file,
    version: args.version,
    baseUrl: args["base-url"],
    notes: args.notes,
    minSupported: args["min-supported"],
    channel: args.channel,
    existing,
  });
  const outPath = args.out || "update-manifest.json";
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const top = manifest.releases[0];
  console.log(`OK ${outPath}`);
  for (const r of manifest.releases) {
    console.log(`  ${r.version}  ${r.sha256 ? r.sha256.slice(0, 12) + "..." : "(no sha256)"}  ${r.url}`);
  }
  return { manifest, outPath, top };
}

const _isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (() => {
    try {
      return import.meta.url === pathToFileURL(process.argv[1]).href;
    } catch {
      return false;
    }
  })();
if (_isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (e) {
    console.error("X " + ((e && e.message) || String(e)));
    process.exit(1);
  }
}
