// J80: launch-path geo detection dedup + cache (Slice 57 — launch speed).
// Two profiles through the same proxy must launch cleanly and resolve the same
// bounded geo-detection outcome. When the external provider is reachable that
// includes --fingerprint-webrtc-ip; offline runs consistently fall back without
// treating provider availability as a browser-engine failure.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  setupTestApp,
  closeApp,
  TestAppHandle,
} from "./helpers/app.js";
import { waitForCdpPort } from "./helpers/cdp.js";
import { shot, filterKnownConsoleErrors } from "./helpers/diag.js";

const execFileAsync = promisify(execFile);
const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j80");

function splitCommandLine(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const tokens = trimmed.split(/ --/);
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    result.push(index === 0 ? tokens[index] : '--' + tokens[index]);
  }
  return result;
}

function argValue(args: string[], flag: string): string | null {
  const prefixed = args.find((arg) => arg.startsWith(flag + '='));
  return prefixed ? prefixed.slice(flag.length + 1) : null;
}

async function readProcessArgs(pid: number): Promise<string[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command=']);
  return splitCommandLine(stdout);
}

async function launchAutoThroughDefaultProxy(h: TestAppHandle): Promise<{ ip: string | null; pid: number }> {
  const created = await h.page.evaluate(
    async (opts: any) => (window as any).agentBrowser.api.browser.create(opts),
    { name: "J80-proxy-" + Math.floor(Math.random() * 1e6), platform: "windows", proxyMode: "default" },
  ) as { dirId: string };
  expect(created.dirId).toBeTruthy();
  const lr = await h.page.evaluate(
    async (id: string) => (window as any).agentBrowser.api.browser.launch(id),
    created.dirId,
  ) as { success: boolean; cdpPort: number; pid: number; error?: string };
  expect(lr.success, lr.error || 'launch failed').toBe(true);
  h.cdpPids.push(lr.pid);
  await waitForCdpPort(lr.cdpPort, 20000);
  const args = await readProcessArgs(lr.pid);
  const ip = argValue(args, '--fingerprint-webrtc-ip');
  return { ip, pid: lr.pid };
}

describe('J80 — launch-path geo detection dedup + cache', () => {
  let h: TestAppHandle;
  let first: { ip: string | null; pid: number } | null = null;
  let second: { ip: string | null; pid: number } | null = null;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
    // A1: there is no built-in default proxy anymore — j80 tests same-proxy
    // geo caching, so it must pin its own local proxy explicitly.
    const added = await h.page.evaluate(() =>
      (window as any).agentBrowser.api.proxy.add("j80-local", { type: "http", host: "127.0.0.1", port: 7890 }));
    expect(added.success, "j80-local proxy add should succeed").toBe(true);
    const marked = await h.page.evaluate(() =>
      (window as any).agentBrowser.api.proxy.setDefault("j80-local"));
    expect(marked.success, "setDefault should succeed").toBe(true);
  }, 60000);

  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it('first and second auto-identity launches through the same proxy succeed', async () => {
    first = await launchAutoThroughDefaultProxy(h);
    await new Promise((r) => setTimeout(r, 500));
    second = await launchAutoThroughDefaultProxy(h);
    expect(second.pid).not.toBe(first.pid);
    await shot(h.page, 'j80-01-two-launches');
  }, 120000);

  it('successful geo detections are consistent and failures fall back safely', async () => {
    expect(second!.ip === null).toBe(first!.ip === null);
    if (first!.ip !== null) expect(second!.ip).toBe(first!.ip);
    expect(argValue(await readProcessArgs(first!.pid), '--fingerprint-timezone')).toBeTruthy();
    expect(argValue(await readProcessArgs(second!.pid), '--fingerprint-timezone')).toBeTruthy();
  }, 20000);

  it('no unexpected console errors', () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(c.length, c.join('\n')).toBe(0);
  });
});
