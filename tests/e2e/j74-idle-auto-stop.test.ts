// J74: idle profile auto-stop (Slice 49).
// Mirrors upstream CloakBrowser cloakserve idle cleanup (#352) for our
// on-demand profile model: in server/headless mode a profile with no
// REST/CDP/automation activity for the configured timeout is stopped
// automatically, while any REST interaction (status / launch / drift / env)
// or CDP tool use resets the idle clock.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { launchHeadlessApp, HeadlessAppHandle } from './helpers/app.js';

const REPO = path.resolve(__dirname, '..', '..');
const USERDATA = path.join(REPO, 'tests', 'e2e', 'userdata', 'j74');
const IDLE_TIMEOUT_MS = 4000;

describe('J74 — idle auto-stop for running profiles (headless server)', () => {
  let h: HeadlessAppHandle;

  beforeAll(async () => {
    h = await launchHeadlessApp({
      userDataDir: USERDATA,
      token: 'j74-idle-token',
      env: { AGENT_BROWSER_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS) },
    });
  }, 60000);

  afterAll(async () => {
    if (h) await h.close();
  }, 90000);

  const api = (method: string, pathname: string, body?: any) =>
    fetch('http://127.0.0.1:' + h.port + pathname, {
      method,
      headers: {
        authorization: 'Bearer ' + h.token,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));

  it('GET /api/server/idle reports the policy and empty running set', async () => {
    const r = await api('GET', '/api/server/idle');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.timeoutMs).toBe(IDLE_TIMEOUT_MS);
    expect(Array.isArray(r.body.running)).toBe(true);
  }, 15000);

  it('launches a profile, tracks idle, and resets the clock on REST activity', async () => {
    const created = await api('POST', '/api/profiles', { name: 'j74-idle', fingerprintSeed: 74001 });
    expect(created.status).toBe(201);
    const dirId = created.body.dirId;

    const launched = await api('POST', '/api/profiles/' + encodeURIComponent(dirId) + '/launch', { headless: true });
    expect(launched.status).toBe(200);
    expect(launched.body.cdpPort).toBeGreaterThan(0);

    // Freshly launched -> idleMs should be tiny.
    let idle = await api('GET', '/api/server/idle');
    let entry = idle.body.running.find((p: any) => p.dirId === dirId);
    expect(entry).toBeTruthy();
    expect(entry.cdpPort).toBe(launched.body.cdpPort);
    expect(entry.idleMs).toBeLessThan(1500);

    // Let the clock run a bit, then touch via /status and prove idle resets.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const touched = await api('GET', '/api/profiles/' + encodeURIComponent(dirId) + '/status');
    expect(touched.status).toBe(200);
    expect(touched.body.running).toBe(true);
    idle = await api('GET', '/api/server/idle');
    entry = idle.body.running.find((p: any) => p.dirId === dirId);
    expect(entry).toBeTruthy();
    expect(entry.idleMs).toBeLessThan(1500);
  }, 60000);

  it('stops the profile automatically once it stays idle past the timeout', async () => {
    // Find the running profile (created by the previous test).
    const profiles = await api('GET', '/api/profiles');
    const target = (profiles.body.profiles || []).find((p: any) => p.name === 'j74-idle' && p.running);
    expect(target).toBeTruthy();
    const dirId = target.dirId;

    // No further REST/CDP activity: wait for the sweep to stop it. Poll the
    // non-touching /api/server/idle endpoint (REST /status would reset the
    // idle clock and keep the profile alive).
    const deadline = Date.now() + 30000;
    let stopped = false;
    while (Date.now() < deadline) {
      const idle = await api('GET', '/api/server/idle');
      if (!idle.body.running.find((p: any) => p.dirId === dirId)) { stopped = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(stopped).toBe(true);

    const idle = await api('GET', '/api/server/idle');
    expect(idle.body.running.find((p: any) => p.dirId === dirId)).toBeFalsy();
  }, 60000);
});
