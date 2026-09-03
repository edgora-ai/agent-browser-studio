// Version-aware release store for the controller runtime.
//
// Mirrors the independent-Chromium version store (native-chromium-manager) so
// the product always keeps a known-good runtime: a release manifest is checked
// for newer versions, payload archives are downloaded and verified (sha256),
// staged under <appData>/updates/releases/<version>/payload, activated by pin,
// and rolled back on demand or automatically after a crash loop. Every
// transition is recorded in the audit log and in the persisted history.
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as net from "node:net";
import * as dns from "node:dns/promises";
import { app } from "electron";
import { getAppDataDir } from "./config-manager.js";
import { extractZipArchive } from "./zip-writer.js";
import { recordAudit } from "./audit-log.js";
import type {
  UpdateManifest,
  UpdateRelease,
  UpdateState,
  InstalledUpdate,
  UpdateHistoryEntry,
  UpdateCheckResult,
} from "../types.js";

const PRODUCT_NAME = "agent-browser-studio";
const DEFAULT_CHANNEL = "stable";
const MAX_RELEASES = 3; // active + previous + one staged
const MAX_PAYLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB safety cap for controller payloads
const CRASH_THRESHOLD = 3; // consecutive bad starts before auto-rollback
const AUTO_ROLLBACK_COOLDOWN_MS = 10 * 60 * 1000; // don't flip-flop within 10 min
const MAX_HISTORY = 50;

let _statePath: string | null = null;

function getUpdatesDir(): string {
  return path.join(getAppDataDir(), "updates");
}

function getStatePath(): string {
  if (!_statePath) _statePath = path.join(getUpdatesDir(), "state.json");
  return _statePath;
}

function defaultState(): UpdateState {
  return {
    activeVersion: getCurrentVersion(),
    previousVersion: null,
    channel: DEFAULT_CHANNEL,
    manifestUrl: configuredManifestUrl(),
    lastCheckedAt: null,
    lastCheckError: null,
    crashCount: 0,
    lastCrashAt: null,
    lastAutoRollbackAt: null,
    installed: [],
    history: [],
  };
}

export function configuredManifestUrl(): string | null {
  const v = process.env.AGENT_BROWSER_UPDATE_MANIFEST || process.env.CLOAK_UPDATE_MANIFEST;
  return v && v.trim() ? v.trim() : null;
}

export function getCurrentVersion(): string {
  const candidates = [path.join(app.getAppPath(), "package.json"), path.resolve(process.cwd(), "package.json")];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch { /* try next */ }
  }
  return "1.0.0";
}

/** Numeric dot-segment compare: 1.10.0 > 1.9.0. Returns -1/0/1. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split(".").map((s) => {
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const pb = String(b).split(".").map((s) => {
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

// ── State persistence (atomic, like config.json) ──

export function loadUpdateState(): UpdateState {
  try {
    const raw = JSON.parse(fs.readFileSync(getStatePath(), "utf8"));
    return sanitizeState(raw);
  } catch {
    return defaultState();
  }
}

function sanitizeState(raw: any): UpdateState {
  const base = defaultState();
  const installed: InstalledUpdate[] = Array.isArray(raw?.installed)
    ? raw.installed
        .filter((i: any) => i && typeof i.version === "string")
        .map((i: any) => ({
          version: String(i.version),
          status: i.status === "active" || i.status === "staged" || i.status === "retired" ? i.status : "staged",
          installedAt: Number.isFinite(Number(i.installedAt)) ? Number(i.installedAt) : Date.now(),
          sha256: typeof i.sha256 === "string" ? i.sha256 : null,
          url: typeof i.url === "string" ? i.url : null,
        }))
    : [];
  const history: UpdateHistoryEntry[] = Array.isArray(raw?.history)
    ? raw.history
        .filter((h: any) => h && typeof h.action === "string")
        .map((h: any) => ({
          at: Number.isFinite(Number(h.at)) ? Number(h.at) : Date.now(),
          action: h.action,
          version: h.version == null ? null : String(h.version),
          from: h.from == null ? null : String(h.from),
          detail: h.detail == null ? null : String(h.detail),
        }))
        .slice(-MAX_HISTORY)
    : [];
  return {
    activeVersion: typeof raw?.activeVersion === "string" && raw.activeVersion ? String(raw.activeVersion) : base.activeVersion,
    previousVersion: typeof raw?.previousVersion === "string" && raw.previousVersion ? String(raw.previousVersion) : null,
    channel: typeof raw?.channel === "string" && raw.channel ? String(raw.channel) : DEFAULT_CHANNEL,
    manifestUrl: typeof raw?.manifestUrl === "string" && raw.manifestUrl ? String(raw.manifestUrl) : configuredManifestUrl(),
    lastCheckedAt: raw?.lastCheckedAt == null ? null : Number(raw.lastCheckedAt) || null,
    lastCheckError: typeof raw?.lastCheckError === "string" ? String(raw.lastCheckError) : null,
    crashCount: Number.isFinite(Number(raw?.crashCount)) ? Math.max(0, Number(raw.crashCount)) : 0,
    lastCrashAt: raw?.lastCrashAt == null ? null : Number(raw.lastCrashAt) || null,
    lastAutoRollbackAt: raw?.lastAutoRollbackAt == null ? null : Number(raw.lastAutoRollbackAt) || null,
    installed,
    history,
  };
}

function saveUpdateState(state: UpdateState): void {
  const dir = getUpdatesDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = getStatePath();
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
}

function pushHistory(state: UpdateState, entry: UpdateHistoryEntry): void {
  state.history.push(entry);
  if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
}

export function getUpdateState(): UpdateState {
  return loadUpdateState();
}

export function getInstalledVersions(): string[] {
  return loadUpdateState().installed.map((i) => i.version);
}

// ── Manifest handling ──

/** Version allowlist: dotted numerics only — also enforced on consume, so a
 * tampered manifest cannot smuggle `../../evil` into the release-store path. */
export const UPDATE_VERSION_RE = /^\d+(\.\d+){0,4}$/;

function normalizeVersion(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) throw new Error("Release is missing version");
  if (!UPDATE_VERSION_RE.test(s)) {
    throw new Error("Release has an invalid version (expected dotted numerics): " + JSON.stringify(s).slice(0, 80));
  }
  return s;
}

/** Validate a parsed manifest and return a normalized, version-sorted copy. */
export function parseUpdateManifest(text: string): UpdateManifest {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (e: any) {
    throw new Error("Update manifest is not valid JSON: " + (e?.message || String(e)));
  }
  if (!raw || typeof raw !== "object") throw new Error("Update manifest must be an object");
  if (raw.product !== PRODUCT_NAME) {
    throw new Error("Update manifest product mismatch: expected '" + PRODUCT_NAME + "', got '" + String(raw.product) + "'");
  }
  if (!Array.isArray(raw.releases) || raw.releases.length === 0) {
    throw new Error("Update manifest must declare at least one release");
  }
  const releases: UpdateRelease[] = raw.releases.map((r: any) => {
    if (!r || typeof r !== "object") throw new Error("Update manifest contains an invalid release");
    const version = normalizeVersion(r.version);
    if (typeof r.url !== "string" || !r.url.trim()) throw new Error("Release " + version + " is missing url");
    // sha256 stays optional at parse time (local directory payloads carry no
    // hash by design); acquirePayload enforces it for every non-directory
    // payload, so a hash-less remote/archive update is still rejected.
    if (r.sha256 != null && (typeof r.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(r.sha256))) {
      throw new Error("Release " + version + " has an invalid sha256");
    }
    return {
      version,
      url: r.url.trim(),
      sha256: typeof r.sha256 === "string" ? r.sha256.toLowerCase() : undefined,
      notes: typeof r.notes === "string" ? r.notes : undefined,
      publishedAt: typeof r.publishedAt === "string" ? r.publishedAt : undefined,
      minSupported: typeof r.minSupported === "string" ? r.minSupported : undefined,
    };
  });
  releases.sort((a, b) => compareVersions(b.version, a.version));
  const seen = new Set<string>();
  for (const r of releases) {
    if (seen.has(r.version)) throw new Error("Duplicate release version " + r.version);
    seen.add(r.version);
  }
  return { product: PRODUCT_NAME, channel: typeof raw.channel === "string" ? raw.channel : DEFAULT_CHANNEL, releases };
}

function resolveAgainst(base: string | null, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (/^file:\/\//i.test(url)) return url;
  if (path.isAbsolute(url)) return url;
  // Relative — resolve against the manifest location (dir for file manifests).
  if (base) {
    if (/^https?:\/\//i.test(base)) {
      try { return new URL(url, base).toString(); } catch { return url; }
    }
    const basePath = base.replace(/^file:\/\//, "");
    const dir = fs.existsSync(basePath) && fs.statSync(basePath).isDirectory() ? basePath : path.dirname(basePath);
    return path.resolve(dir, url);
  }
  return path.resolve(url);
}

/** Mirrors local-agent's SSRF guard: no loopback/link-local/private/multicast. */
function isBlockedUpdateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost")) return true;
  if (net.isIPv4(h)) {
    const parts = h.split(".").map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] >= 224;
  }
  if (net.isIPv6(h)) {
    const first = Number.parseInt(h.split(":")[0] || "0", 16);
    return h === "::1" || h === "::" || (first >= 0xfe80 && first <= 0xfebf) ||
      h.startsWith("fc") || h.startsWith("fd");
  }
  return false;
}

/** A caller-supplied manifestUrl override must be http(s) to a public host —
 * no file:// LFI, no absolute/relative local paths, no metadata/private IPs
 * (DNS-resolved too). The configured default manifest is unaffected. */
export async function assertSafeManifestUrl(raw: string): Promise<string> {
  const url = String(raw || "").trim();
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new Error("manifestUrl must be an absolute http(s) URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("manifestUrl must be http(s) — file:// and local paths are not allowed as overrides");
  }
  const host = parsed.hostname.toLowerCase();
  if (isBlockedUpdateHost(host)) {
    throw new Error("manifestUrl host is not allowed (loopback/private/link-local)");
  }
  if (!net.isIP(host)) {
    let records: Array<{ address: string }> = [];
    try { records = await dns.lookup(host, { all: true }); }
    catch { throw new Error("manifestUrl host did not resolve"); }
    if (!records.length) throw new Error("manifestUrl host did not resolve");
    for (const r of records) {
      if (isBlockedUpdateHost(r.address)) throw new Error("manifestUrl resolves to a blocked address");
    }
  }
  return url;
}

async function readManifestText(manifestUrl: string): Promise<{ text: string; base: string | null }> {
  if (/^https?:\/\//i.test(manifestUrl)) {
    const res = await fetchWithTimeout(manifestUrl, 15000, 1024 * 1024);
    if (!res.ok) throw new Error("Failed to fetch update manifest: HTTP " + res.status);
    return { text: await res.text(), base: manifestUrl };
  }
  const local = manifestUrl.replace(/^file:\/\//, "");
  if (!fs.existsSync(local)) throw new Error("Update manifest not found: " + local);
  return { text: fs.readFileSync(local, "utf8"), base: local };
}

/** fetch with timeout + streaming size cap (not buffer-then-check). */
async function fetchWithTimeout(url: string, timeoutMs: number, maxBytes: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
    if (!res.ok || !res.body) return res;
    // Stream through a cap: abort before buffering past maxBytes.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error("Response exceeds size cap (" + maxBytes + " bytes)");
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
    return new Response(merged, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("Request timed out after " + timeoutMs + "ms: " + url);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Check a manifest for releases newer than the active version. */
export async function checkForUpdates(manifestUrl?: string): Promise<UpdateCheckResult> {
  const url = manifestUrl || configuredManifestUrl();
  const state = loadUpdateState();
  const currentVersion = getCurrentVersion();
  const result: UpdateCheckResult = {
    currentVersion,
    available: [],
    checkedAt: Date.now(),
    error: null,
  };
  if (!url) {
    result.error = "No update manifest configured (set AGENT_BROWSER_UPDATE_MANIFEST)";
    state.lastCheckedAt = result.checkedAt;
    state.lastCheckError = result.error;
    saveUpdateState(state);
    return result;
  }
  try {
    const { text, base } = await readManifestText(url);
    const manifest = parseUpdateManifest(text);
    result.available = manifest.releases.filter((r) => {
      if (compareVersions(r.version, currentVersion) <= 0) return false;
      if (r.minSupported && compareVersions(currentVersion, r.minSupported) < 0) return false;
      return true;
    });
    state.channel = manifest.channel || state.channel;
    state.manifestUrl = url;
    state.lastCheckedAt = result.checkedAt;
    state.lastCheckError = null;
    saveUpdateState(state);
  } catch (e: any) {
    result.error = e?.message || String(e);
    state.lastCheckedAt = result.checkedAt;
    state.lastCheckError = result.error;
    saveUpdateState(state);
  }
  return result;
}

// ── Payload acquisition (download / verify / extract) ──

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function fetchBytes(url: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to download " + url + ": HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error("Downloaded payload is empty");
    return buf;
  }
  if (/^file:\/\//i.test(url)) {
    const p = url.replace(/^file:\/\//, "");
    if (!fs.existsSync(p)) throw new Error("Payload not found: " + p);
    if (fs.statSync(p).isDirectory()) throw new Error("file:// payload must be an archive file");
    const buf = fs.readFileSync(p);
    if (buf.length === 0) throw new Error("Downloaded payload is empty");
    return buf;
  }
  if (fs.existsSync(url) && fs.statSync(url).isDirectory()) {
    throw new Error("Expected an archive file, got a directory (use a local dir payload directly)");
  }
  if (!fs.existsSync(url)) throw new Error("Payload not found: " + url);
  const buf = fs.readFileSync(url);
  if (buf.length === 0) throw new Error("Downloaded payload is empty");
  return buf;
}

/** Resolve a release URL (relative against the manifest) and acquire it.
 *  Returns { kind: "archive", bytes } or { kind: "dir", source }. */
async function acquirePayload(release: UpdateRelease, manifestBase: string | null): Promise<{ kind: "archive"; bytes: Buffer } | { kind: "dir"; source: string }> {
  const url = resolveAgainst(manifestBase, release.url);
  // Local directory payloads (dev/staging flow) carry no hash by design and
  // are exempt. Every other payload kind must present a valid sha256 —
  // otherwise a tampered manifest yields a spoofable update.
  const isLocalDirPayload =
    !/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url) &&
    fs.existsSync(url) && fs.statSync(url).isDirectory();
  if (!isLocalDirPayload && typeof release.sha256 !== "string") {
    throw new Error("Release " + release.version + " has no sha256 — refusing a hash-less update");
  }
  if (/^https?:\/\//i.test(url) || /^file:\/\//i.test(url)) {
    const bytes = await fetchBytes(url);
    const actual = sha256Hex(bytes);
    if (actual !== (release.sha256 as string)) {
      throw new Error("sha256 mismatch for release " + release.version + ": expected " + release.sha256 + ", got " + actual);
    }
    return { kind: "archive", bytes };
  }
  const local = url;
  if (fs.existsSync(local) && fs.statSync(local).isDirectory()) {
    return { kind: "dir", source: local };
  }
  const bytes = await fetchBytes(local);
  const actual = sha256Hex(bytes);
  if (actual !== (release.sha256 as string)) {
    throw new Error("sha256 mismatch for release " + release.version + ": expected " + release.sha256 + ", got " + actual);
  }
  return { kind: "archive", bytes };
}

function copyDirTree(source: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name === "__MACOSX") continue;
    const src = path.join(source, entry.name);
    const dst = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

// ── Install / activate / rollback ──

/** Find a release by version in the last fetched manifest. */
async function findRelease(version: string, manifestUrl?: string): Promise<{ release: UpdateRelease; base: string | null }> {
  const url = manifestUrl || configuredManifestUrl();
  if (!url) throw new Error("No update manifest configured (set AGENT_BROWSER_UPDATE_MANIFEST)");
  const { text, base } = await readManifestText(url);
  const manifest = parseUpdateManifest(text);
  const release = manifest.releases.find((r) => r.version === version);
  if (!release) throw new Error("Release " + version + " is not in the update manifest");
  return { release, base };
}

function releasePayloadDir(version: string): string {
  return path.join(getUpdatesDir(), "releases", version, "payload");
}

function releaseMetaPath(version: string): string {
  return path.join(getUpdatesDir(), "releases", version, "meta.json");
}

function isInstalled(state: UpdateState, version: string): boolean {
  // The running app is always the known-good baseline even before any payload
  // was staged into the release store.
  if (version === getCurrentVersion()) return true;
  return state.installed.some((i) => i.version === version) || fs.existsSync(releasePayloadDir(version));
}

/** Download + verify + stage a release payload under releases/<version>. */
export async function installRelease(version: string, manifestUrl?: string): Promise<UpdateState> {
  // Re-validate the requested version: it lands in filesystem paths below.
  normalizeVersion(version);
  const { release, base } = await findRelease(version, manifestUrl);
  const state = loadUpdateState();
  const payloadDir = releasePayloadDir(version);
  const stagingParent = path.join(getUpdatesDir(), "releases", version);
  const stagingDir = path.join(getUpdatesDir(), ".staging-" + version);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

  const acquired = await acquirePayload(release, base);
  if (acquired.kind === "archive") {
    if (acquired.bytes.length > MAX_PAYLOAD_BYTES) {
      throw new Error("Payload exceeds size cap (" + MAX_PAYLOAD_BYTES + " bytes)");
    }
    const zipPath = path.join(stagingDir, "payload.zip");
    fs.writeFileSync(zipPath, acquired.bytes, { mode: 0o600 });
    extractZipArchive(zipPath, path.join(stagingDir, "payload"), {
      maxTotalBytes: MAX_PAYLOAD_BYTES,
      skipNames: (name) => name === ".DS_Store" || name.startsWith("__MACOSX/") || name.startsWith("__MACOSX"),
    });
    fs.rmSync(zipPath, { force: true });
  } else {
    copyDirTree(acquired.source, path.join(stagingDir, "payload"));
  }

  // Commit: swap the staging dir into place and write release metadata.
  fs.mkdirSync(stagingParent, { recursive: true, mode: 0o700 });
  fs.rmSync(payloadDir, { recursive: true, force: true });
  fs.renameSync(path.join(stagingDir, "payload"), payloadDir);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  const meta = {
    version,
    sha256: release.sha256 || null,
    url: release.url,
    installedAt: Date.now(),
  };
  fs.writeFileSync(releaseMetaPath(version), JSON.stringify(meta, null, 2), { mode: 0o600 });

  const existing = state.installed.find((i) => i.version === version);
  if (existing) existing.status = "staged";
  else state.installed.push({ version, status: "staged", installedAt: meta.installedAt, sha256: meta.sha256, url: meta.url });

  pushHistory(state, { at: Date.now(), action: "install", version, from: null, detail: "staged payload" });
  recordAudit({ category: "updates", action: "install", target: version, actor: "user", detail: "staged" });
  pruneReleases(state);
  saveUpdateState(state);
  return state;
}

/** Pin a staged (or installed) version as the active release for next launch. */
export function activateVersion(version: string): UpdateState {
  const state = loadUpdateState();
  if (!isInstalled(state, version)) throw new Error("Release " + version + " is not installed");
  if (version === state.activeVersion) return state;
  const previous = state.activeVersion;
  state.previousVersion = previous;
  state.activeVersion = version;
  state.crashCount = 0;
  for (const i of state.installed) i.status = i.version === version ? "active" : i.version === previous ? "staged" : i.status;
  pushHistory(state, { at: Date.now(), action: "activate", version, from: previous, detail: "pinned for next launch" });
  recordAudit({ category: "updates", action: "activate", target: version, actor: "user", detail: "from " + previous });
  saveUpdateState(state);
  return state;
}

/** Switch back to the previous known-good release (manual rollback). */
export function rollback(): UpdateState {
  const state = loadUpdateState();
  const previous = state.previousVersion;
  if (!previous) throw new Error("No previous version available for rollback");
  if (!isInstalled(state, previous)) throw new Error("Previous release " + previous + " is no longer installed");
  const from = state.activeVersion;
  state.previousVersion = from;
  state.activeVersion = previous;
  state.crashCount = 0;
  for (const i of state.installed) i.status = i.version === previous ? "active" : i.version === from ? "staged" : i.status;
  pushHistory(state, { at: Date.now(), action: "rollback", version: previous, from, detail: "manual rollback" });
  recordAudit({ category: "updates", action: "rollback", target: previous, actor: "user", detail: "from " + from });
  saveUpdateState(state);
  return state;
}

// ── Crash-loop guard ──

/** Called once at app startup. If the app crashed >= CRASH_THRESHOLD times
 *  since the last activation, roll back to the previous known-good release. */
export function noteAppStarted(): UpdateState {
  const state = loadUpdateState();
  const now = Date.now();
  if (state.crashCount >= CRASH_THRESHOLD && state.lastAutoRollbackAt && now - state.lastAutoRollbackAt < AUTO_ROLLBACK_COOLDOWN_MS) {
    // Already rolled back recently — don't flip-flop; just reset the counter.
    state.crashCount = 0;
    saveUpdateState(state);
    return state;
  }
  if (state.crashCount >= CRASH_THRESHOLD) {
    const previous = state.previousVersion;
    if (previous && isInstalled(state, previous)) {
      const from = state.activeVersion;
      state.activeVersion = previous;
      state.previousVersion = from;
      state.crashCount = 0;
      state.lastCrashAt = null;
      state.lastAutoRollbackAt = now;
      for (const i of state.installed) i.status = i.version === previous ? "active" : i.status;
      pushHistory(state, { at: now, action: "auto-rollback", version: previous, from, detail: "crash loop detected (" + CRASH_THRESHOLD + " bad starts)" });
      recordAudit({ category: "updates", action: "auto-rollback", target: previous, actor: "system", detail: "from " + from });
    } else {
      state.crashCount = 0;
    }
    saveUpdateState(state);
  }
  return state;
}

/** Called when the controller main process exits abnormally. */
export function noteAppCrashed(): UpdateState {
  const state = loadUpdateState();
  state.crashCount += 1;
  state.lastCrashAt = Date.now();
  pushHistory(state, { at: Date.now(), action: "check", version: null, from: null, detail: "crashCount=" + state.crashCount });
  saveUpdateState(state);
  return state;
}

/** Called after a healthy run (e.g. some uptime) to clear the crash counter. */
export function markAppHealthy(): UpdateState {
  const state = loadUpdateState();
  if (state.crashCount !== 0) {
    state.crashCount = 0;
    state.lastCrashAt = null;
    saveUpdateState(state);
  }
  return state;
}

// ── Retention ──

/** Keep at most MAX_RELEASES payloads: active, previous, and the newest staged. */
function pruneReleases(state: UpdateState): void {
  const keep = new Set<string>([state.activeVersion]);
  if (state.previousVersion) keep.add(state.previousVersion);
  const staged = state.installed
    .filter((i) => i.status === "staged" && !keep.has(i.version))
    .sort((a, b) => b.installedAt - a.installedAt);
  for (const s of staged.slice(0, Math.max(0, MAX_RELEASES - keep.size))) keep.add(s.version);
  for (const i of state.installed) {
    if (!keep.has(i.version) && i.status !== "active") {
      const dir = path.join(getUpdatesDir(), "releases", i.version);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      i.status = "retired";
    }
  }
  state.installed = state.installed.filter((i) => i.status !== "retired" || keep.has(i.version));
}

/** For tests: point the state store at an isolated directory. */
export function _setUpdateStatePathForTesting(p: string | null): void {
  _statePath = p;
}
