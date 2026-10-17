/// <reference lib="dom" />

import type { BrowserFingerprintConfig } from "../main/services/browser-fingerprint-config.js";
import { getHostBrowserPlatform } from "../main/services/browser-platform-policy.js";

export interface HostNavigatorIdentity {
  userAgent: string;
  platform: string;
  uaPlatform: string | null;
  mobile: boolean | null;
  highEntropy: Record<string, unknown> | null;
}

export interface HostIdentityRequestHeaders {
  userAgent: string | null;
  acceptLanguage: string | null;
  doNotTrack: string | null;
  uaPlatform: string | null;
  uaArchitecture?: string | null;
  uaBitness?: string | null;
  uaPlatformVersion?: string | null;
}

export interface HostIdentityCorpus {
  window: HostNavigatorIdentity;
  worker: HostNavigatorIdentity;
  requestHeaders: Record<"window" | "dedicated" | "shared" | "service", HostIdentityRequestHeaders>;
}

/** Self-contained so the same navigator capture can run in Window and Worker. */
export async function captureHostIdentityInPage(): Promise<Pick<HostIdentityCorpus, "window" | "worker">> {
  async function readNavigator(source: Navigator): Promise<HostNavigatorIdentity> {
    const data = (source as Navigator & {
      userAgentData?: {
        platform: string;
        mobile: boolean;
        getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>>;
      };
    }).userAgentData;
    return {
      userAgent: source.userAgent,
      platform: source.platform,
      uaPlatform: data?.platform ?? null,
      mobile: data?.mobile ?? null,
      highEntropy: data ? await data.getHighEntropyValues([
        "architecture", "bitness", "platformVersion", "fullVersionList", "model", "wow64",
      ]) : null,
    };
  }
  const windowIdentity = await readNavigator(navigator);
  const workerIdentity = await new Promise<HostNavigatorIdentity>((resolve, reject) => {
    const script = `self.onmessage=function(){(${readNavigator.toString()})(self.navigator).then(function(value){self.postMessage({value:value})},function(error){self.postMessage({error:String(error)})})}`;
    const url = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
    const worker = new Worker(url);
    let settled = false;
    const finish = (error: Error | null, value?: HostNavigatorIdentity): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("Worker identity capture returned no value"));
    };
    const timer = window.setTimeout(() => finish(new Error("Worker identity capture timed out")), 5000);
    worker.onmessage = (event) => {
      if (event.data?.error) finish(new Error("Worker identity capture failed: " + event.data.error));
      else finish(null, event.data?.value);
    };
    worker.onerror = () => finish(new Error("Worker identity capture failed"));
    worker.postMessage(1);
  });
  return { window: windowIdentity, worker: workerIdentity };
}

/**
 * Verify OS family and cross-surface agreement, not physical CPU/version.
 * Callers bind any native control to the same executable, host and window mode;
 * this validator checks its captured identity/headers, not process provenance.
 */
export function verifyHostIdentityCoherence(
  actual: HostIdentityCorpus,
  configured: Pick<BrowserFingerprintConfig, "userAgent" | "platform">,
  runtimePlatform: string = process.platform,
  label = "managed host identity",
  nativeControl?: HostIdentityCorpus,
): void {
  const equal = (value: unknown, expected: unknown, surface: string): void => {
    if (value !== expected) throw new Error(`${label} ${surface}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
  };
  const requireValue = (condition: unknown, surface: string): void => {
    if (!condition) throw new Error(`${label} ${surface} was not captured`);
  };
  const host = getHostBrowserPlatform(runtimePlatform);
  const platform = host === "macos" ? "MacIntel" : host === "windows" ? "Win32" : null;
  if (host === null || configured.platform !== platform) {
    throw new Error(`${label} host OS compatibility: ${configured.platform} is not supported on ${runtimePlatform}`);
  }
  const uaPlatform = host === "macos" ? "macOS" : "Windows";
  const matchesHostUa = (userAgent: string): boolean => host === "macos"
    ? /Macintosh;[^)]*Mac OS X/.test(userAgent) && !/Windows NT|Android/.test(userAgent)
    : /Windows NT/.test(userAgent) && !/Macintosh|Android/.test(userAgent);
  const verifyNavigators = (corpus: HostIdentityCorpus, userAgent: string, prefix: string): void => {
    requireValue(matchesHostUa(userAgent), `${prefix}host OS compatibility of User-Agent`);
    for (const context of ["window", "worker"] as const) {
      const identity = corpus[context];
      const surface = `${prefix}${context}`;
      requireValue(identity, `${surface} navigator identity`);
      equal(identity.userAgent, userAgent, `${surface} User-Agent`);
      equal(identity.platform, platform, `${surface} platform`);
      equal(identity.uaPlatform, uaPlatform, `${surface} UA-CH platform`);
      equal(identity.mobile, false, `${surface} UA-CH mobile`);
      requireValue(identity.highEntropy, `${surface} high-entropy identity`);
      equal(identity.highEntropy!.platform, uaPlatform, `${surface} high-entropy platform`);
      for (const field of ["architecture", "bitness", "platformVersion"] as const) {
        const value = identity.highEntropy![field];
        requireValue(typeof value === "string" && value.length > 0, `${surface} high-entropy ${field}`);
        if (context === "worker") equal(value, corpus.window.highEntropy![field], `${prefix}Worker/Window high-entropy ${field}`);
      }
    }
  };
  const decode = (header: string | null | undefined, surface: string): unknown => {
    requireValue(typeof header === "string" && header.length > 0, surface);
    try {
      return JSON.parse(header!);
    } catch (error) {
      throw new Error(`${label} ${surface} is not a quoted string header`, { cause: error });
    }
  };
  const omitsHints = (headers: HostIdentityRequestHeaders | undefined): boolean => Boolean(headers) &&
    (["uaPlatform", "uaArchitecture", "uaBitness", "uaPlatformVersion"] as const).every((field) => headers![field] === null);
  const verifyRequests = (corpus: HostIdentityCorpus, prefix: string, isNativeControl: boolean): void => {
    for (const context of ["window", "dedicated", "shared", "service"] as const) {
      const headers = corpus.requestHeaders[context];
      const surface = `${prefix}${context} request`;
      requireValue(headers, `${surface} headers`);
      equal(headers.userAgent, corpus.window.userAgent, `${surface} User-Agent`);
      // Some native worker fetches omit hints even after the origin opts in.
      // Only an explicit, validated same-build/mode control can justify matching
      // absence. This records no verified value for those omitted HTTP hints.
      if (context !== "window" && omitsHints(headers) &&
          (isNativeControl || (nativeControl && omitsHints(nativeControl.requestHeaders[context])))) continue;
      equal(decode(headers.uaPlatform, `${surface} UA-CH platform`), uaPlatform, `${surface} UA-CH platform`);
      for (const [header, field] of [
        ["uaArchitecture", "architecture"], ["uaBitness", "bitness"], ["uaPlatformVersion", "platformVersion"],
      ] as const) {
        equal(decode(headers[header], `${surface} high-entropy ${field}`), corpus.window.highEntropy![field], `${surface} high-entropy ${field}`);
      }
    }
  };

  verifyNavigators(actual, configured.userAgent, "");
  if (nativeControl) {
    verifyNavigators(nativeControl, nativeControl.window.userAgent, "native control ");
    verifyRequests(nativeControl, "native control ", true);
  }
  verifyRequests(actual, "", false);
}
