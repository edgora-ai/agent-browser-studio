import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ProxyConfig } from "../types.js";
import type { ProxyDetectionResult } from "./proxy-detector.js";

// Process-local only: neither credential-comparable tokens nor orders are DTOs,
// persisted IDs or log fields. The same keyed identity serves cache and CAS.
export const PROXY_OBSERVATION_TTL_MS = 10 * 60 * 1000;
const secret = randomBytes(32);
function token(domain: string, value: unknown): string {
  return createHmac("sha256", secret).update(JSON.stringify([domain, value])).digest("hex");
}
export interface ProxyWitness {
  readonly storedPassword: string;
  readonly password: string;
  readonly identity: string;
}
export function proxyIdentityToken(config: ProxyConfig, password = token("password", config.password || "")): string {
  return token("proxy", [config.type, String(config.host || "").trim(), Number(config.port), config.username || "", password,
    (config.bypassList || []).map(entry => entry.trim()).filter(Boolean).sort()]);
}
/** An unchanged encoded envelope never needs decryption. A changed envelope is
 * compared transiently, then only keyed opaque tokens enter the witness. */
export function createProxyWitness(config: ProxyConfig, previous?: ProxyWitness,
  comparablePassword: (value: string | undefined) => string = value => value || ""): ProxyWitness {
  const storedPassword = token("stored-password", config.password || "");
  const password = previous?.storedPassword === storedPassword ? previous.password : token("password", comparablePassword(config.password));
  return Object.freeze({ storedPassword, password, identity: proxyIdentityToken(config, password) });
}

export interface AuthenticatedProxyObservation {
  readonly identity: string;
  readonly order: number;
  readonly result: Readonly<ProxyDetectionResult>;
}
const observations = new WeakMap<object, AuthenticatedProxyObservation>();
const stamps = new WeakSet<object>();
let order = 0;
export function nextProxyObservationOrder(): number { return ++order; }

function attach(result: ProxyDetectionResult, identity: string, order: number): ProxyDetectionResult {
  const snapshot = Object.freeze(structuredClone(result));
  const stamp = Object.freeze({ identity, order, result: snapshot });
  stamps.add(stamp);
  observations.set(result, stamp);
  return result;
}
/** Called only after an actually dispatched, non-cancelled probe completes. */
export function completeProxyObservation(result: ProxyDetectionResult, identity: string, order: number): ProxyDetectionResult {
  return attach({ ...result, observedAt: Date.now(), source: "network", observationId: randomUUID() }, identity, order);
}
export function readProxyObservation(result: object): AuthenticatedProxyObservation | null {
  const stamp = observations.get(result);
  return stamp && isDeepStrictEqual(result, stamp.result) ? stamp : null;
}
export function isAuthenticatedProxyObservation(stamp: AuthenticatedProxyObservation): boolean { return stamps.has(stamp); }
/** Cache storage and every return value are detached. Copying within main may
 * preserve authority; structured clone across IPC carries metadata, NOT trust. */
export function cloneProxyObservation(result: ProxyDetectionResult, source?: "cache"): ProxyDetectionResult {
  const stamp = readProxyObservation(result);
  // Cloning may downgrade a network result to cache reuse, never promote a
  // cached DTO into an authenticated new physical sample.
  const copy = { ...structuredClone(result), source: source === "cache" ? "cache" as const : result.source };
  return stamp ? attach(copy, stamp.identity, stamp.order) : copy;
}
export function proxyObservationTime(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
