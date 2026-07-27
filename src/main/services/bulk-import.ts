// Bulk profile import CSV parser. Supports a header row (recommended) for
// name/platform/locale/timezone/seed/proxy/webrtc/tags, and falls back to the
// legacy positional format. Pure → unit-testable.
export interface ProfileSpec {
  name: string;
  platform?: "windows" | "macos";
  locale?: string;
  timezone?: string;
  fingerprintSeed?: number;
  proxyName?: string;
  webrtcIp?: string;
  geolocationMode?: "real" | "disable" | "custom";
  geolocationLatitude?: number;
  geolocationLongitude?: number;
  geolocationAccuracy?: number;
  tags?: string[];
}

const HEADER_ALIASES: Record<string, keyof ProfileSpec> = {
  name: "name", profile: "name", profile_name: "name",
  platform: "platform", os: "platform",
  locale: "locale", language: "locale",
  timezone: "timezone", tz: "timezone",
  seed: "fingerprintSeed", fingerprintseed: "fingerprintSeed", fingerprint_seed: "fingerprintSeed",
  proxy: "proxyName", proxyname: "proxyName", proxy_name: "proxyName",
  webrtc: "webrtcIp", webrtcip: "webrtcIp", webrtc_ip: "webrtcIp", ip: "webrtcIp",
  geolocation: "geolocationMode", geolocationmode: "geolocationMode", geo_mode: "geolocationMode",
  latitude: "geolocationLatitude", lat: "geolocationLatitude",
  longitude: "geolocationLongitude", lon: "geolocationLongitude", lng: "geolocationLongitude",
  accuracy: "geolocationAccuracy", geoaccuracy: "geolocationAccuracy", geo_accuracy: "geolocationAccuracy",
  tag: "tags", tags: "tags",
};

function splitCsvLine(line: string): string[] {
  // Simple CSV split (no quoted commas) — sufficient for this import flow.
  return line.split(",").map((s) => s.trim());
}

function normalizeTags(value: string): string[] {
  return [...new Set(value.split(/[;|]/).map((t) => t.trim()).filter(Boolean).map((t) => t.slice(0, 40)))].slice(0, 20);
}

export function parseBulkCsv(text: string): ProfileSpec[] {
  if (!text || !text.trim()) return [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const first = splitCsvLine(lines[0]).map((c) => c.toLowerCase().replace(/[\s-]/g, ""));
  const hasHeader = first.some((c) => c in HEADER_ALIASES);

  if (hasHeader) {
    const colMap = first.map((c) => HEADER_ALIASES[c] || null);
    return lines.slice(1).map((line) => {
      const cells = splitCsvLine(line);
      const spec: ProfileSpec = { name: "" };
      cells.forEach((cell, i) => {
        const key = colMap[i];
        if (!key || cell === "") return;
        if (key === "fingerprintSeed") {
          const n = Number(cell); if (Number.isInteger(n) && n > 0) spec.fingerprintSeed = n;
        } else if (key === "geolocationLatitude" || key === "geolocationLongitude" || key === "geolocationAccuracy") {
          const n = Number(cell); if (Number.isFinite(n)) (spec as any)[key] = n;
        } else if (key === "geolocationMode") {
          const mode = cell.toLowerCase();
          if (mode === "real" || mode === "disable" || mode === "custom") spec.geolocationMode = mode;
        } else if (key === "tags") {
          spec.tags = normalizeTags(cell);
        } else if (key === "platform") {
          spec.platform = cell.toLowerCase() === "macos" ? "macos" : "windows";
        } else {
          (spec as any)[key] = cell;
        }
      });
      return spec;
    }).filter((s) => s.name);
  }

  // Legacy positional: name, platform, locale, timezone, seed, webrtcIp
  return lines.map((line) => {
    const p = splitCsvLine(line);
    const seed = Number(p[4]);
    return {
      name: p[0] || "",
      platform: (p[1] || "windows").toLowerCase() === "macos" ? "macos" : "windows",
      locale: p[2] || undefined,
      timezone: p[3] || undefined,
      fingerprintSeed: Number.isInteger(seed) && seed > 0 ? seed : undefined,
      webrtcIp: p[5] || undefined,
    } as ProfileSpec;
  }).filter((s) => s.name);
}
