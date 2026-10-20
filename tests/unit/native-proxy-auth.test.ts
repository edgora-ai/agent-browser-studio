import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  NATIVE_GOOGLE_API_KEY_INFOBAR_CAPABILITY,
  NATIVE_LOCAL_DNS_POLICY_CAPABILITY,
  NATIVE_PROXY_AUTH_CAPABILITY,
  NATIVE_QUIC_PROXY_CAPABILITY,
  readNativeChromiumCapabilities,
  supportsNativeProxyAuth,
  supportsNativeQuicProxy,
  supportsGoogleApiKeyInfoBarSuppression,
  supportsNativeLocalDnsPolicy,
  writeNativeProxyAuthFile,
} from "../../src/main/services/native-proxy-auth.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-native-auth-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("native proxy authentication handoff", () => {
  it("writes a one-shot 0600 credential file and cleans it idempotently", () => {
    const root = makeRoot();
    const auth = writeNativeProxyAuthFile({
      host: "proxy.example",
      port: 3128,
      username: "user",
      password: "secret",
    }, root);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(auth.filePath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(auth.filePath).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(fs.readFileSync(auth.filePath, "utf8"))).toEqual({
      version: 1,
      host: "proxy.example",
      port: 3128,
      username: "user",
      password: "secret",
    });
    auth.cleanup();
    auth.cleanup();
    expect(fs.existsSync(auth.filePath)).toBe(false);
    expect(fs.existsSync(path.dirname(auth.filePath))).toBe(false);
  });

  it("requires an explicit binary capability marker", () => {
    if (process.platform === "win32") return; // shell-script capability probe is POSIX-only
    const root = makeRoot();
    const capable = path.join(root, "capable-browser");
    fs.writeFileSync(capable, `#!/bin/sh\nprintf '%s\\n' '${NATIVE_PROXY_AUTH_CAPABILITY}' '${NATIVE_QUIC_PROXY_CAPABILITY}' '${NATIVE_GOOGLE_API_KEY_INFOBAR_CAPABILITY}'\n`, { mode: 0o700 });
    fs.chmodSync(capable, 0o700);
    expect(supportsNativeProxyAuth(capable)).toBe(true);
    expect(supportsNativeQuicProxy(capable)).toBe(true);
    expect(supportsGoogleApiKeyInfoBarSuppression(capable)).toBe(true);
    expect([...readNativeChromiumCapabilities(capable)].sort()).toEqual([
      NATIVE_PROXY_AUTH_CAPABILITY,
      NATIVE_QUIC_PROXY_CAPABILITY,
      NATIVE_GOOGLE_API_KEY_INFOBAR_CAPABILITY,
    ].sort());
    expect(supportsNativeProxyAuth("/bin/echo")).toBe(false);
    expect(supportsNativeQuicProxy("/bin/echo")).toBe(false);
    expect(supportsGoogleApiKeyInfoBarSuppression("/bin/echo")).toBe(false);
    expect(supportsNativeProxyAuth(path.join(root, "missing"))).toBe(false);
    expect(supportsNativeLocalDnsPolicy(capable)).toBe(false);
  });

  it.each([false, true])("invalidates cached macOS Framework capabilities through directory aliases (%s)", (useAlias) => {
    if (process.platform === "win32") return; // shell-script capability probe is POSIX-only
    const root = makeRoot();
    const contents = path.join(root, "Chromium.app", "Contents");
    const executable = path.join(contents, "MacOS", "Chromium");
    const framework = path.join(contents, "Frameworks", "Chromium Framework.framework", "Versions", "Current", "Chromium Framework");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.mkdirSync(path.dirname(framework), { recursive: true });
    fs.writeFileSync(framework, NATIVE_LOCAL_DNS_POLICY_CAPABILITY + "\n");
    fs.writeFileSync(executable, `#!/bin/sh\nif /usr/bin/grep -q '${NATIVE_LOCAL_DNS_POLICY_CAPABILITY}' ${JSON.stringify(framework)}; then\n  printf '%s\\n' '${NATIVE_LOCAL_DNS_POLICY_CAPABILITY}'\nfi\n`, { mode: 0o700 });
    fs.chmodSync(executable, 0o700);
    const original = fs.statSync(executable);
    const alias = path.join(root, "browser-bin");
    if (useAlias) fs.symlinkSync(path.dirname(executable), alias, "dir");
    const selected = useAlias ? path.join(alias, "Chromium") : executable;
    expect(supportsNativeLocalDnsPolicy(selected)).toBe(true);
    fs.writeFileSync(framework, "not-capable\n");
    expect(fs.statSync(executable).mtimeMs).toBe(original.mtimeMs);
    expect(supportsNativeLocalDnsPolicy(selected)).toBe(false);
  });

  it("does not infer restricted DNS support from other native capabilities", () => {
    if (process.platform === "win32") return; // shell-script capability probe is POSIX-only
    const root = makeRoot();
    const capable = path.join(root, "dns-policy-browser");
    fs.writeFileSync(capable, `#!/bin/sh\nprintf '%s\\n' '${NATIVE_LOCAL_DNS_POLICY_CAPABILITY}'\n`, { mode: 0o700 });
    fs.chmodSync(capable, 0o700);
    expect(supportsNativeLocalDnsPolicy(capable)).toBe(true);
    expect(supportsNativeLocalDnsPolicy("/bin/echo")).toBe(false);
    expect(supportsNativeLocalDnsPolicy(path.join(root, "missing"))).toBe(false);
    expect(supportsNativeProxyAuth(capable)).toBe(false);
  });
});
