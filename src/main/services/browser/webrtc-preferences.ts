import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { syncArchiveDirectory } from "../zip-writer.js";
import { createdDirectoryAncestry } from "./created-directory-ancestry.js";
import type { ChromiumWebRtcRoutingPolicy } from "./webrtc-policy.js";

const MAX_PREFERENCES_BYTES = 16 * 1024 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

export class WebRtcPreferencesError extends Error {
  readonly code = "webrtc-preferences-unavailable";
  constructor() {
    super("WebRTC routing preferences could not be validated, committed and read back. No browser was started; preserve and inspect this profile's Preferences rather than resetting them.");
    this.name = "WebRtcPreferencesError";
  }
}
interface Snapshot { bytes: Buffer; value: Record<string, any>; stat: fs.Stats | null }
const same = (a: fs.Stats, b: fs.Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
function optionalStat(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function directory(file: string): fs.Stats | null {
  const stat = optionalStat(file);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid())) throw new WebRtcPreferencesError();
  return stat;
}
function read(file: string): Snapshot {
  const stat = optionalStat(file);
  if (!stat) return { bytes: Buffer.alloc(0), value: {}, stat: null };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 2 || stat.size > MAX_PREFERENCES_BYTES || process.getuid && stat.uid !== process.getuid()) throw new WebRtcPreferencesError();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    if (!same(stat, fs.fstatSync(fd))) throw new WebRtcPreferencesError();
    const buffer = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < buffer.length) {
      const length = fs.readSync(fd, buffer, count, buffer.length - count, null);
      if (!length) break;
      count += length;
    }
    if (count !== stat.size || !same(stat, fs.fstatSync(fd)) || !same(stat, fs.lstatSync(file))) throw new WebRtcPreferencesError();
    const bytes = buffer.subarray(0, count), text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new WebRtcPreferencesError();
    const value: unknown = JSON.parse(text);
    if (!object(value) || value.webrtc !== undefined && !object(value.webrtc)) throw new WebRtcPreferencesError();
    return { bytes, value, stat };
  } finally { fs.closeSync(fd); }
}
function paths(profileDir: string): { defaultDir: string; file: string } {
  if (!path.isAbsolute(profileDir) || path.resolve(profileDir) !== profileDir) throw new WebRtcPreferencesError();
  directory(profileDir);
  const defaultDir = path.join(profileDir, "Default");
  directory(defaultDir);
  return { defaultDir, file: path.join(defaultDir, "Preferences") };
}

/** The caller holds the profile's launch/restore lease and owns its storage root.
 * Validate before legacy locale/cookie helpers can turn malformed JSON into {}. */
export function validateChromiumWebRtcPreferences(profileDir: string): void {
  try { read(paths(profileDir).file); }
  catch { throw new WebRtcPreferencesError(); }
}

/** Full Chrome consumes this profile preference; the similarly named force CLI
 * switch is consumed by content_shell, not Chrome's renderer preference bridge. */
export function applyChromiumWebRtcPreferences(profileDir: string, policy: ChromiumWebRtcRoutingPolicy): {
  policy: "default" | "disable_non_proxied_udp"; changed: boolean; readbackVerified: true; directorySynced: boolean;
} {
  let temporary: string | undefined, temporaryIdentity: fs.Stats | undefined;
  try {
    const { defaultDir, file } = paths(profileDir);
    const original = read(file);
    let directorySynced = true;
    if (!directory(profileDir)) {
      const first = fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      if (first) {
        for (const at of createdDirectoryAncestry(profileDir, first)) {
          directory(at);
          directorySynced = syncArchiveDirectory(path.dirname(at)) && directorySynced;
        }
      }
    }
    if (!directory(defaultDir)) { fs.mkdirSync(defaultDir, { mode: 0o700 }); directorySynced = syncArchiveDirectory(profileDir) && directorySynced; }
    const owner = directory(defaultDir)!;
    const handling = policy.restrictNonProxiedUdp || policy.effectiveMode === "disable" ? "disable_non_proxied_udp" : "default";
    const prefs = original.value;
    const alreadyConfigured = prefs.webrtc?.ip_handling_policy === handling && Array.isArray(prefs.webrtc?.ip_handling_url) && prefs.webrtc.ip_handling_url.length === 0;
    // Per-URL overrides can otherwise weaken the global setting. These two
    // routing preferences are app-managed; unrelated WebRTC settings are kept.
    prefs.webrtc = { ...prefs.webrtc, ip_handling_policy: handling, ip_handling_url: [] };
    const expected = alreadyConfigured ? original.bytes : Buffer.from(JSON.stringify(prefs));
    if (expected.length > MAX_PREFERENCES_BYTES) throw new WebRtcPreferencesError();
    const changed = !original.bytes.equals(expected);
    if (changed) {
      temporary = path.join(defaultDir, `.agent-browser-webrtc-${randomBytes(12).toString("hex")}.tmp`);
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, original.stat ? original.stat.mode & 0o777 : 0o600);
      try { temporaryIdentity = fs.fstatSync(fd); fs.writeFileSync(fd, expected); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      const current = optionalStat(file), parent = directory(defaultDir)!;
      if (owner.dev !== parent.dev || owner.ino !== parent.ino || (original.stat ? !current || !same(original.stat, current) : current !== null)) throw new WebRtcPreferencesError();
      fs.renameSync(temporary, file); temporary = undefined;
    }
    const actual = read(file);
    if (!actual.bytes.equals(expected) || actual.value.webrtc.ip_handling_policy !== handling || !Array.isArray(actual.value.webrtc.ip_handling_url) || actual.value.webrtc.ip_handling_url.length !== 0) throw new WebRtcPreferencesError();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    try { if (!actual.stat || !same(actual.stat, fs.fstatSync(fd))) throw new WebRtcPreferencesError(); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    directorySynced = syncArchiveDirectory(defaultDir) && directorySynced;
    if (!read(file).bytes.equals(expected)) throw new WebRtcPreferencesError();
    return { policy: handling, changed, readbackVerified: true, directorySynced };
  } catch { throw new WebRtcPreferencesError(); }
  finally {
    if (temporary) {
      try {
        const stat = optionalStat(temporary);
        if (stat && temporaryIdentity && stat.dev === temporaryIdentity.dev && stat.ino === temporaryIdentity.ino && stat.isFile() && stat.nlink === 1) fs.unlinkSync(temporary);
      } catch { throw new WebRtcPreferencesError(); }
    }
  }
}
