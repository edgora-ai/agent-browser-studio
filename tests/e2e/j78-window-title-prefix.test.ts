// J78: OS-level window-title prefix (Slice 55).
// Parity with RoxyBrowser's "Settings > Taskbar Icon Display > Profile Name":
// a managed profile shows its name in the OS taskbar/window title via the
// engine's --agent-browser-window-title-prefix switch, while document.title
// (the fingerprint surface) stays untouched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  setupTestApp,
  closeApp,
  TestAppHandle,
} from './helpers/app.js';
import { shot, filterKnownConsoleErrors } from './helpers/diag.js';
import { waitForCdpPort, connectPageCdp, listTargets } from './helpers/cdp.js';

const execFileAsync = promisify(execFile);
const REPO = path.resolve(__dirname, '..', '..');
const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j78');

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
  const exact = args.find((arg) => arg === flag);
  if (exact) return '';
  const prefixed = args.find((arg) => arg.startsWith(flag + '='));
  return prefixed ? prefixed.slice(flag.length + 1) : null;
}

async function readProcessArgs(pid: number): Promise<string[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command=']);
  return splitCommandLine(stdout);
}

async function launchProfile(
  h: TestAppHandle,
  name: string,
  createOptions: Record<string, unknown>,
): Promise<{ dirId: string; cdpPort: number; pid: number }> {
  const created = await h.page.evaluate(
    async (opts: any) => (window as any).agentBrowser.api.browser.create(opts),
    { name, platform: 'windows', locale: 'en-US', timezone: 'America/New_York', fingerprintSeed: 78001, ...createOptions },
  ) as { dirId: string };
  expect(created.dirId).toBeTruthy();
  const lr = await h.page.evaluate(
    async (id: string) => (window as any).agentBrowser.api.browser.launch(id),
    created.dirId,
  ) as { success: boolean; cdpPort: number; pid: number; error?: string };
  expect(lr.success, lr.error || 'launch failed').toBe(true);
  h.cdpPids.push(lr.pid);
  await waitForCdpPort(lr.cdpPort, 15000);
  return { dirId: created.dirId, cdpPort: lr.cdpPort, pid: lr.pid };
}

describe('J78 — OS-level window-title prefix (RoxyBrowser taskbar Profile Name)', () => {
  let h: TestAppHandle;
  let def: { dirId: string; cdpPort: number; pid: number } | null = null;
  let custom: { dirId: string; cdpPort: number; pid: number } | null = null;
  let off: { dirId: string; cdpPort: number; pid: number } | null = null;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    if (h) await closeApp(h);
  }, 90000);

  it('launches default, custom-prefix and disabled profiles', async () => {
    def = await launchProfile(h, 'J78-TestShop', {});
    custom = await launchProfile(h, 'J78-CustomShop', { windowTitlePrefix: 'Ops-01' });
    off = await launchProfile(h, 'J78-NoTitle', { windowTitlePrefix: null });
  }, 180000);

  it('default profile passes its name as the OS-level window-title prefix', async () => {
    const args = await readProcessArgs(def!.pid);
    expect(argValue(args, '--agent-browser-window-title-prefix')).toBe('J78-TestShop');
  }, 20000);

  it('custom prefix is used verbatim', async () => {
    const args = await readProcessArgs(custom!.pid);
    expect(argValue(args, '--agent-browser-window-title-prefix')).toBe('Ops-01');
  }, 20000);

  it('null prefix disables the switch entirely', async () => {
    const args = await readProcessArgs(off!.pid);
    expect(args.some((arg) => arg.startsWith('--agent-browser-window-title-prefix'))).toBe(false);
  }, 20000);

  it('document.title stays clean (no prefix on the fingerprint surface)', async () => {
    const url = 'data:text/html,' + encodeURIComponent('<html><head><title>ShopPage</title></head><body>hi</body></html>');
    const c = await connectPageCdp(def!.cdpPort);
    try {
      await c.send('Page.enable');
      const targets = await listTargets(def!.cdpPort);
      const page = targets.find((t) => t.type === 'page');
      await c.send('Page.navigate', { url });
      await new Promise((r) => setTimeout(r, 1500));
      const r = await c.send<{ result: { value: string } }>('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
      });
      expect(r.result.value).toBe('ShopPage');
      expect(r.result.value).not.toContain('J78-TestShop');
      void page;
    } finally {
      c.close();
    }
    await shot(h.page, 'j78-01-title');
  }, 30000);

  it('no unexpected console errors', () => {
    const errs = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(errs.length, errs.join('\n')).toBe(0);
  });
});
