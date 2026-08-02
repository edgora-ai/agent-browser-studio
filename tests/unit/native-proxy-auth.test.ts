import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  NATIVE_PROXY_AUTH_CAPABILITY,
  supportsNativeProxyAuth,
  writeNativeProxyAuthFile,
} from "../../src/main/services/native-proxy-auth.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloak-native-auth-test-"));
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
    expect(fs.statSync(path.dirname(auth.filePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(auth.filePath).mode & 0o777).toBe(0o600);
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
    const root = makeRoot();
    const capable = path.join(root, "capable-browser");
    fs.writeFileSync(capable, `#!/bin/sh\nprintf '%s\\n' '${NATIVE_PROXY_AUTH_CAPABILITY}'\n`, { mode: 0o700 });
    fs.chmodSync(capable, 0o700);
    expect(supportsNativeProxyAuth(capable)).toBe(true);
    expect(supportsNativeProxyAuth("/bin/echo")).toBe(false);
    expect(supportsNativeProxyAuth(path.join(root, "missing"))).toBe(false);
  });
});
