// J44: profile-seeded interaction policy drives real Chromium through native
// CDP Input events. The page records event trust/shape; no production page
// script is installed or modified by the interaction implementation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as http from "node:http";
import * as path from "node:path";
import { closeApp, setupTestApp, type TestAppHandle } from "./helpers/app.js";
import { waitForCdpPort } from "./helpers/cdp.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";
import {
  cdpClick,
  cdpConnect,
  cdpDisconnect,
  cdpEvaluate,
  cdpNavigate,
  cdpPressKey,
  cdpScroll,
  cdpType,
  type CdpClient,
} from "../../src/main/services/local-agent.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j44");
const SEED = 44444;

describe("J44 — seeded native humanized input", () => {
  let h: TestAppHandle;
  let server: http.Server;
  let origin = "";
  let client: CdpClient | null = null;

  beforeAll(async () => {
    server = http.createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><meta charset="utf-8"><title>J44 input</title>
        <style>body{margin:40px}button,input{display:block;margin:30px;width:180px;height:38px}.space{height:2200px}</style>
        <button id="target">Buy</button><input id="name" value="old"><div class="space"></div>
        <script>
          window.__events=[];
          for(const type of ['mousemove','mousedown','mouseup','click','keydown','keypress','keyup','beforeinput','input','wheel']){
            document.addEventListener(type,function(event){
              window.__events.push({type:type,trusted:event.isTrusted,key:event.key||null,data:event.data||null,deltaY:event.deltaY||0,x:event.clientX||0,y:event.clientY||0,time:performance.now()});
            },true);
          }
        </script>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("J44 server did not bind");
    origin = `http://127.0.0.1:${address.port}`;

    h = await setupTestApp({ userDataDir: USERDATA });
    const created = await h.page.evaluate(async (seed: number) =>
      (window as any).cloak.api.cloak.create({ name: "J44", platform: "windows", fingerprintSeed: seed }), SEED);
    const launched = await h.page.evaluate(async (dirId: string) =>
      (window as any).cloak.api.cloak.launch(dirId), created.dirId) as { success: boolean; cdpPort: number; pid: number; error?: string };
    expect(launched.success, launched.error || "J44 launch failed").toBe(true);
    h.cdpPort = launched.cdpPort;
    h.cdpPids.push(launched.pid);
    await waitForCdpPort(launched.cdpPort, 15_000);
    client = await cdpConnect(launched.cdpPort, SEED);
    await cdpNavigate(client, origin);
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      if (await cdpEvaluate(client, "document.readyState === 'complete' && !!document.querySelector('#target')")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 90_000);

  afterAll(async () => {
    if (client) cdpDisconnect(client);
    if (h) await closeApp(h);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 90_000);

  it("emits trusted curved pointer, keyboard/input and wheel event sequences", async () => {
    if (!client) throw new Error("J44 CDP client unavailable");
    await cdpClick(client, "#target");
    await cdpType(client, "#name", "hello");
    const keyResult = await cdpPressKey(client, "Enter");
    expect(keyResult.native, keyResult.nativeError || "native key dispatch failed").toBe(true);
    await cdpScroll(client, "down", 731);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const state = await cdpEvaluate(client, `({
      value: document.querySelector('#name').value,
      scrollY: window.scrollY,
      events: window.__events
    })`) as { value: string; scrollY: number; events: Array<{ type: string; trusted: boolean; key: string | null; deltaY: number; x: number; y: number; time: number }> };
    expect(state.value).toBe("hello");
    expect(state.scrollY).toBeGreaterThan(0);

    const moves = state.events.filter((event) => event.type === "mousemove");
    const keyboard = state.events.filter((event) => ["keydown", "keypress", "keyup"].includes(event.type));
    const input = state.events.filter((event) => ["beforeinput", "input"].includes(event.type));
    const wheel = state.events.filter((event) => event.type === "wheel");
    expect(moves.length).toBeGreaterThanOrEqual(8);
    expect(new Set(moves.map((event) => `${event.x},${event.y}`)).size).toBeGreaterThan(5);
    expect(keyboard.length).toBeGreaterThanOrEqual(15);
    expect(input.length).toBeGreaterThanOrEqual(5);
    expect(wheel.length).toBeGreaterThanOrEqual(5);
    const untrusted = [...moves, ...keyboard, ...input, ...wheel].filter((event) => !event.trusted);
    expect(untrusted, JSON.stringify(untrusted)).toEqual([]);
    expect(wheel.reduce((sum, event) => sum + event.deltaY, 0)).toBe(731);
  }, 30_000);

  it("has no unexpected console errors", () => {
    const errors = filterKnownConsoleErrors(h.consoleErrors).filter((error: string) =>
      !/file is not a database|connect to 127\.0\.0\.1 port 1/i.test(error));
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
