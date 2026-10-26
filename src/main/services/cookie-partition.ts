import type { CookiePartitionKey } from "../types.js";
export type { CookiePartitionKey } from "../types.js";

/** Validate the complete CDP partition identity without guessing an eTLD+1 or
 * converting opaque/invalid input into an unpartitioned Cookie. Only undefined
 * means absent. Return independent data; no provider value enters an error. */
export function normalizeCookiePartitionKey(value: unknown): CookiePartitionKey | undefined {
  if (value === undefined) return undefined;
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(value);
    const site = fields.topLevelSite, ancestor = fields.hasCrossSiteAncestor;
    if (Reflect.ownKeys(fields).length !== 2 || !site || !ancestor ||
        !Object.hasOwn(site, "value") || !Object.hasOwn(ancestor, "value") ||
        typeof site.value !== "string" || typeof ancestor.value !== "boolean") throw new Error();
    const topLevelSite: string = site.value;
    // A schemeful site's serialization has no credentials, port, path, query or
    // fragment. Require the native canonical spelling, never silently rewrite it.
    if (topLevelSite.length > 4096) throw new Error();
    const parsed = new URL(topLevelSite);
    if (!["https:", "http:"].includes(parsed.protocol) || !parsed.hostname || parsed.hostname.length > 255 ||
        parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash ||
        parsed.origin !== topLevelSite) throw new Error();
    return { topLevelSite, hasCrossSiteAncestor: ancestor.value };
  } catch {
    throw new Error("COOKIE_PARTITION_KEY_INVALID");
  }
}
