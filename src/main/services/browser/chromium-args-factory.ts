import { buildBrowserFingerprintArg, buildBrowserFingerprintConfig, AGENT_BROWSER_FINGERPRINT_SWITCH, LEGACY_FINGERPRINT_SWITCH, MANAGED_SECURE_DNS_TEMPLATES } from "../browser-fingerprint-config.js";

export interface ChromiumArgsInput {
  profileDir: string;
  seed: number;
  platform: string;
  cdpPort: number;
  fingerprintMode: string;
  headless?: boolean;
  effectiveTimezone?: string | null;
  effectiveLocale?: string | null;
  webrtcIp?: string | null;
  hardwareMeta?: any;
  nativeChromiumVersion: string | null;
  supportsFingerprintConfig: boolean;
  supportsGoogleApiKeyInfoBar: boolean;
  windowTitlePrefix?: string | null;
  activeProxy?: any;
  managedSecureDns?: any;
  nativeFingerprintMeta?: any;
  extensionPaths?: string[];
  drmArgs?: string[];
  appUrl?: string | null;
  allowThirdPartyCookies?: boolean;
  NATIVE_SUPPRESS_GOOGLE_API_KEY_INFOBAR_SWITCH?: string;
}

export function dedupeChromeArgs(args: string[]): string[] {
  const keyOf = (arg: string) => arg.startsWith("--") ? arg.split("=", 1)[0] : arg;
  const map = new Map<string, string>();
  for (const arg of args) map.set(keyOf(arg), arg);
  return [...map.values()];
}

export function buildBaseChromiumArgs(input: ChromiumArgsInput): string[] {
  const args = [
    `--user-data-dir=${input.profileDir}`,
    `--remote-debugging-port=${input.cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
  ];
  if (input.headless) args.push("--headless=new");
  if (input.fingerprintMode === "managed") args.push(`--fingerprint=${input.seed}`, `--fingerprint-platform=${input.platform}`);
  if (process.platform === "darwin") args.push("--use-mock-keychain");
  return dedupeChromeArgs(args);
}

export function finalizeChromiumArgs(input: ChromiumArgsInput, baseArgs: string[]): string[] {
  let args = [...baseArgs];
  if (!input.hardwareMeta) return args;
  // Hardware args are pushed by caller before; this is a placeholder for pure args assembly.
  return args;
}
