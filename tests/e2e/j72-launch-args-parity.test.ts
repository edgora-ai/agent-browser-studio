// J72: Launch-args feature-set parity guard (Slice 47).
// Empirical proof that a managed-profile Chromium command line diverges from
// the pass-through (stock control) launch of the same binary by exactly the
// documented managed set: one extra --disable-features entry
// (ThrottleMainFrameTo60Hz) and nothing else. This guards the class of bug
// upstream CloakBrowser fixed in v0.5.3 (Playwright defaults disabling
// MediaRouter for the Windows font profile): a managed launch must never turn
// off features the stock browser ships enabled, and must never carry
// automation/test-harness flags.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
 setupTestApp,
 closeApp,
 TestAppHandle,
} from './helpers/app.js';
import { shot, closeAllDialogs, filterKnownConsoleErrors } from './helpers/diag.js';
import { waitForCdpPort } from './helpers/cdp.js';

const execFileAsync = promisify(execFile);
const REPO = path.resolve(__dirname, '..', '..');
const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j72');

const AUTOMATION_FLAGS = [
  '--enable-automation',
  '--no-sandbox',
  '--single-process',
  '--in-process-gpu',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--headless',
];

const MANAGED_ONLY_DISABLE = 'ThrottleMainFrameTo60Hz';

function splitCommandLine(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // macOS 'ps -o command=' renders values containing spaces unquoted, but every
  // Chromium argument is --name[=value] and no value in our launch contains the
  // ' --' boundary, so splitting on it is lossless here.
  const tokens = trimmed.split(/ --/);
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    result.push(index === 0 ? tokens[index] : '--' + tokens[index]);
  }
  return result;
}

// Chromium appends its own field-trial overrides between these two markers.
// They reflect per-user-data-dir variations state, not our launch config, so
// the parity comparison below ignores that block.
function stripFlagSwitches(args: string[]): string[] {
  const result: string[] = [];
  let inside = false;
  for (const arg of args) {
    if (arg === '--flag-switches-begin') { inside = true; continue; }
    if (arg === '--flag-switches-end') { inside = false; continue; }
    if (!inside) result.push(arg);
  }
  return result;
}

function argValue(args: string[], flag: string): string | null {
  const exact = args.find((arg) => arg === flag);
  if (exact) return '';
  const prefixed = args.find((arg) => arg.startsWith(flag + '='));
  return prefixed ? prefixed.slice(flag.length + 1) : null;
}

function featureSet(args: string[], flag: string): Set<string> {
  const value = argValue(args, flag);
  if (value == null) return new Set();
  return new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean));
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
    { name: name, ...createOptions },
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

describe('J72 — launch-args feature-set parity (managed vs pass-through)', () => {
  let h: TestAppHandle;
  let managed: { dirId: string; cdpPort: number; pid: number } | null = null;
  let control: { dirId: string; cdpPort: number; pid: number } | null = null;

  beforeAll(async () => {
    h = await setupTestApp({ userDataDir: USERDATA });
  }, 60000);

  afterAll(async () => {
    if (h) await closeApp(h);
  }, 90000);

  it('launches a managed profile and a pass-through control', async () => {
    managed = await launchProfile(h, 'J72-managed', {
      platform: 'windows',
      locale: 'en-US',
      timezone: 'America/New_York',
      fingerprintSeed: 72001,
      fingerprintMode: 'managed',
    });
    control = await launchProfile(h, 'J72-passthrough', {
      platform: 'windows',
      fingerprintMode: 'off',
    });
  }, 120000);

  it('managed launch carries no automation or test-harness flags', async () => {
    const args = await readProcessArgs(managed!.pid);
    for (const flag of AUTOMATION_FLAGS) {
      expect(
        args.some((arg) => arg === flag || arg.startsWith(flag + '=')),
        flag + ' must not appear in a managed launch',
      ).toBe(false);
    }
    expect(args.some((arg) => arg.startsWith('--disable-blink-features'))).toBe(false);
    expect(args.some((arg) => arg.startsWith('--enable-blink-features'))).toBe(false);
  }, 20000);

  it('managed vs pass-through feature flags differ only by the documented refresh-rate setting', async () => {
    const managedArgs = stripFlagSwitches(await readProcessArgs(managed!.pid));
    const controlArgs = stripFlagSwitches(await readProcessArgs(control!.pid));

    const managedEnabled = featureSet(managedArgs, '--enable-features');
    const controlEnabled = featureSet(controlArgs, '--enable-features');
    const managedDisabled = featureSet(managedArgs, '--disable-features');
    const controlDisabled = featureSet(controlArgs, '--disable-features');

    // Managed must not enable anything the stock control does not.
    const managedOnlyEnabled = [...managedEnabled].filter((f) => !controlEnabled.has(f));
    expect(managedOnlyEnabled).toEqual([]);

    // The only managed-only disable is the documented native refresh-rate
    // alignment; every other feature the stock browser ships enabled stays on.
    const managedOnlyDisabled = [...managedDisabled].filter((f) => !controlDisabled.has(f));
    expect(managedOnlyDisabled).toEqual([MANAGED_ONLY_DISABLE]);

    // MediaRouter (the feature upstream v0.5.3 had to re-enable for its
    // Windows font profile) is never disabled by the managed profile.
    expect(managedDisabled.has('MediaRouter')).toBe(false);
  }, 20000);

  it('pass-through control carries no managed fingerprint args', async () => {
    const args = await readProcessArgs(control!.pid);
    const fingerprintPrefixes = [
      '--fingerprint',
      '--agent-browser-fingerprint-config',
      '--user-agent=',
      '--lang=',
      '--window-size=',
      '--window-position=',
      '--force-device-scale-factor=',
      '--fingerprint-webrtc-ip=',
      '--fingerprint-timezone=',
      '--fingerprint-locale=',
    ];
    for (const prefix of fingerprintPrefixes) {
      expect(
        args.some((arg) => arg.startsWith(prefix)),
        prefix + ' leaked into the pass-through launch',
      ).toBe(false);
    }
  }, 20000);

  it('managed profile keeps the declared window geometry and identity args', async () => {
    const args = await readProcessArgs(managed!.pid);
    const size = argValue(args, '--window-size');
    expect(size).toMatch(/^\d+,\d+$/);
    expect(argValue(args, '--force-device-scale-factor')).toBeTruthy();
    expect(argValue(args, '--user-agent')).toContain('Windows');
    expect(argValue(args, '--fingerprint')).toBeTruthy();
  }, 20000);

  it('no unexpected console errors', () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(c.length, c.join('\n')).toBe(0);
  });
});
