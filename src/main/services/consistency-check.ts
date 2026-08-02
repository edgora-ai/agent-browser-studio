// Profile launch consistency check — flags conflicts between the profile's
// declared fingerprint (timezone / locale / WebRTC IP / platform) and its proxy
// before the browser starts. Pure logic, no network → unit-testable. The
// proxy-side geo comes from a cached detection result (passed in); when absent,
// only the declared-field self-consistency checks run.
//
// Severity:
//   - blocker: a real risk (e.g. WebRTC IP set with no proxy → real IP leaks).
//   - warning: a likely-detectable inconsistency (tz/locale/proxy country drift).
// Launch behavior: warnings are always recorded; blockers only refuse launch
// when config.blockOnConsistencyConflict is true (default false → warn only).

export interface ConsistencyInput {
  timezone?: string | null;
  locale?: string | null;
  webrtcIp?: string | null;
  platform?: string | null;
  proxyMode: "none" | "default" | "named";
  /** Cached proxy geo (from proxy-detector), if a detection exists. */
  proxyGeo?: { country?: string | null; countryCode?: string | null; timezone?: string | null } | null;
}

export interface ConsistencyFinding {
  severity: "warning" | "blocker";
  code: string;
  message: string;
}

export interface ConsistencyResult {
  ok: boolean;                 // true iff no blockers
  warnings: ConsistencyFinding[];
  blockers: ConsistencyFinding[];
}

// A pragmatic subset of IANA tz → ISO-3166 alpha-2 country. Unknown → null.
const TZ_TO_COUNTRY: Record<string, string> = {
  "america/new_york": "US", "america/chicago": "US", "america/denver": "US", "america/los_angeles": "US", "america/toronto": "CA", "america/vancouver": "CA", "america/sao_paulo": "BR", "america/mexico_city": "MX",
  "europe/london": "GB", "europe/dublin": "IE", "europe/paris": "FR", "europe/berlin": "DE", "europe/madrid": "ES", "europe/rome": "IT", "europe/amsterdam": "NL", "europe/brussels": "BE", "europe/warsaw": "PL", "europe/stockholm": "SE", "europe/athens": "GR", "europe/moscow": "RU", "europe/istanbul": "TR",
  "asia/tokyo": "JP", "asia/seoul": "KR", "asia/shanghai": "CN", "asia/hong_kong": "HK", "asia/taipei": "TW", "asia/singapore": "SG", "asia/kuala_lumpur": "MY", "asia/bangkok": "TH", "asia/jakarta": "ID", "asia/manila": "PH", "asia/kolkata": "IN", "asia/dubai": "AE", "asia/riyadh": "SA", "asia/nicosia": "CY",
  "australia/sydney": "AU", "australia/melbourne": "AU", "pacific/auckland": "NZ",
};

/** IANA timezone → ISO country (lowercased), or null. */
export function tzToCountry(tz: string | null | undefined): string | null {
  if (!tz) return null;
  return TZ_TO_COUNTRY[String(tz).trim().toLowerCase()] || null;
}

/** BCP-47 locale ("en-US", "zh-CN") → region country code, or null. */
export function localeToRegion(locale: string | null | undefined): string | null {
  if (!locale) return null;
  const m = String(locale).trim().match(/[-_]([a-zA-Z]{2})$/);
  return m ? m[1].toUpperCase() : null;
}

function sameCountry(a: string | null, b: string | null): boolean {
  if (!a || !b) return true; // unknown → don't flag
  return a.toUpperCase() === b.toUpperCase();
}

export function checkProfileConsistency(input: ConsistencyInput): ConsistencyResult {
  const warnings: ConsistencyFinding[] = [];
  const blockers: ConsistencyFinding[] = [];

  // Blocker: WebRTC IP configured but no proxy → real IP leaks via WebRTC.
  if (input.webrtcIp && input.proxyMode === "none") {
    blockers.push({
      severity: "blocker",
      code: "webrtc-no-proxy",
      message: `WebRTC IP is set (${input.webrtcIp}) but the profile has no proxy — the real IP can leak via WebRTC.`,
    });
  }

  const tzCountry = tzToCountry(input.timezone);
  const localeRegion = localeToRegion(input.locale);
  const geoCountry = input.proxyGeo?.countryCode
    ? String(input.proxyGeo.countryCode).toUpperCase()
    : input.proxyGeo?.country ? String(input.proxyGeo.country).toUpperCase() : null;

  // Warning: declared timezone vs declared locale region.
  if (tzCountry && localeRegion && !sameCountry(tzCountry, localeRegion)) {
    warnings.push({
      severity: "warning",
      code: "tz-locale",
      message: `Timezone ${input.timezone} (${tzCountry}) doesn't match locale ${input.locale} (${localeRegion}).`,
    });
  }

  // Warning: proxy exit country vs declared timezone.
  if (geoCountry && tzCountry && !sameCountry(geoCountry, tzCountry)) {
    warnings.push({
      severity: "warning",
      code: "proxy-tz",
      message: `Proxy exits in ${geoCountry} but the profile timezone is ${input.timezone} (${tzCountry}).`,
    });
  }

  // Warning: proxy exit country vs declared locale region.
  if (geoCountry && localeRegion && !sameCountry(geoCountry, localeRegion)) {
    warnings.push({
      severity: "warning",
      code: "proxy-locale",
      message: `Proxy exits in ${geoCountry} but the profile locale is ${input.locale} (${localeRegion}).`,
    });
  }

  // Warning: proxy-detected timezone vs declared timezone.
  if (input.proxyGeo?.timezone && input.timezone &&
      String(input.proxyGeo.timezone).toLowerCase() !== String(input.timezone).toLowerCase()) {
    warnings.push({
      severity: "warning",
      code: "proxy-tz-mismatch",
      message: `Proxy timezone ${input.proxyGeo.timezone} doesn't match profile timezone ${input.timezone}.`,
    });
  }

  return { ok: blockers.length === 0, warnings, blockers };
}
