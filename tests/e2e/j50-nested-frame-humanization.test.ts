// J50: native humanized interaction resolves deeply nested cross-origin OOPIFs,
// rechecks coordinates after a late layout shift, rejects covered targets and
// preserves an explicit keyboard hold delay.
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
  cdpType,
  type CdpClient,
} from "../../src/main/services/local-agent.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j50");
const SEED = 50505;

interface InteractionReport {
  kind: string;
  trusted?: boolean;
  value?: string;
  key?: string;
  time?: number;
}

describe("J50 — nested-frame humanized actionability", () => {
  let h: TestAppHandle;
  let server: http.Server;
  let origin = "";
  let client: CdpClient | null = null;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("cache-control", "no-store");

      if (pathname === "/inner") {
        response.end(`<!doctype html><meta charset="utf-8"><title>J50 inner</title>
          <style>
            body{margin:24px;height:900px;font-family:sans-serif}
            .spacer{height:260px}
            input,button{display:block;width:180px;height:38px;margin:18px}
            #moving{transition:none}
            #covered-wrap{position:relative;width:220px;height:80px}
            #cover{position:absolute;left:18px;top:18px;width:180px;height:38px;background:#333;z-index:4}
          </style>
          <div class="spacer"></div>
          <input id="deep-input" value="old">
          <button id="deep-button">Deep click</button>
          <button id="moving">Moving click</button>
          <div id="covered-wrap"><button id="covered">Covered</button><div id="cover"></div></div>
          <script>
            function report(kind, event, extra) {
              top.postMessage(Object.assign({source:'j50',kind:kind,trusted:event ? event.isTrusted : undefined,time:performance.now()}, extra || {}), '*');
            }
            const input = document.querySelector('#deep-input');
            input.addEventListener('input', event => report('input', event, {value:input.value}));
            input.addEventListener('keydown', event => report('keydown', event, {key:event.key}));
            input.addEventListener('keyup', event => report('keyup', event, {key:event.key}));
            document.querySelector('#deep-button').addEventListener('click', event => report('deep-click', event));
            const moving = document.querySelector('#moving');
            let shifted = false;
            moving.addEventListener('mousemove', () => {
              if (!shifted) {
                shifted = true;
                moving.style.transform = 'translateX(260px)';
                report('moving-shift', null);
              }
            });
            moving.addEventListener('click', event => report('moving-click', event));
            document.querySelector('#covered').addEventListener('click', event => report('covered-click', event));
          <\/script>`);
        return;
      }

      if (pathname === "/middle") {
        response.end(`<!doctype html><meta charset="utf-8"><title>J50 middle</title>
          <style>body{margin:20px}.spacer{height:280px}iframe{width:620px;height:520px;border:5px solid #789}</style>
          <div class="spacer"></div>
          <iframe id="inner-frame" src="http://[::1]:${port}/inner"></iframe>`);
        return;
      }

      response.end(`<!doctype html><meta charset="utf-8"><title>J50 top</title>
        <style>body{margin:20px}.spacer{height:240px}iframe{width:760px;height:620px;border:7px solid #456}</style>
        <script>
          window.__j50Reports = [];
          addEventListener('message', event => {
            if (event.data && event.data.source === 'j50') window.__j50Reports.push(event.data);
          });
        <\/script>
        <div class="spacer"></div>
        <iframe id="middle-frame" src="http://localhost:${port}/middle"></iframe>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "::", port: 0, ipv6Only: false }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("J50 server did not bind");
    origin = `http://127.0.0.1:${address.port}`;

    h = await setupTestApp({ userDataDir: USERDATA });
    const created = await h.page.evaluate(async (seed: number) =>
      (window as any).agentBrowser.api.browser.create({
        name: "J50 nested frames",
        platform: "windows",
        fingerprintSeed: seed,
        proxyMode: "none",
      }), SEED);
    const launched = await h.page.evaluate(async (dirId: string) =>
      (window as any).agentBrowser.api.browser.launch(dirId), created.dirId) as {
      success: boolean; cdpPort: number; pid: number; error?: string;
    };
    expect(launched.success, launched.error || "J50 launch failed").toBe(true);
    h.cdpPort = launched.cdpPort;
    h.cdpPids.push(launched.pid);
    await waitForCdpPort(launched.cdpPort, 15_000);
    client = await cdpConnect(launched.cdpPort, SEED);
    await cdpNavigate(client, `${origin}/top`);
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      const ready = await cdpEvaluate(client, "document.readyState === 'complete' && frames.length === 1");
      if (ready) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 90_000);

  afterAll(async () => {
    if (client) cdpDisconnect(client);
    if (h) await closeApp(h);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 90_000);

  it("types and clicks with trusted events inside a two-level cross-origin frame", async () => {
    if (!client) throw new Error("J50 CDP client unavailable");
    const typed = await cdpType(client, "#deep-input", "nested-frame");
    expect(typed).toMatchObject({ success: true, native: true, fallback: false, frameDepth: 2 });
    const pressed = await cdpPressKey(client, "Enter", 180);
    expect(pressed).toMatchObject({ native: true, delayMs: 180 });
    const clicked = await cdpClick(client, "#deep-button");
    expect(clicked).toMatchObject({ success: true, native: true, frameDepth: 2 });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const reports = await cdpEvaluate(client, "window.__j50Reports") as InteractionReport[];
    expect(reports.some((event) => event.kind === "input" && event.trusted && event.value === "nested-frame")).toBe(true);
    expect(
      reports.some((event) => event.kind === "deep-click" && event.trusted),
      JSON.stringify({ clicked, reports }),
    ).toBe(true);
    const down = reports.find((event) => event.kind === "keydown" && event.key === "Enter");
    const up = reports.find((event) => event.kind === "keyup" && event.key === "Enter");
    expect(down?.trusted).toBe(true);
    expect(up?.trusted).toBe(true);
    expect((up?.time || 0) - (down?.time || 0)).toBeGreaterThanOrEqual(170);
  }, 45_000);

  it("repositions after pointer travel triggers a late layout shift", async () => {
    if (!client) throw new Error("J50 CDP client unavailable");
    const clicked = await cdpClick(client, "#moving");
    expect(clicked).toMatchObject({ success: true, native: true, frameDepth: 2 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const reports = await cdpEvaluate(client, "window.__j50Reports") as InteractionReport[];
    expect(
      reports.some((event) => event.kind === "moving-shift"),
      JSON.stringify({ clicked, reports }),
    ).toBe(true);
    expect(reports.some((event) => event.kind === "moving-click" && event.trusted)).toBe(true);
  }, 30_000);

  it("fails closed when another element covers the target", async () => {
    if (!client) throw new Error("J50 CDP client unavailable");
    await expect(cdpClick(client, "#covered")).rejects.toThrow(/covered|pointer events/i);
    const reports = await cdpEvaluate(client, "window.__j50Reports") as InteractionReport[];
    expect(reports.some((event) => event.kind === "covered-click")).toBe(false);
  }, 30_000);

  it("has no unexpected console errors", () => {
    const errors = filterKnownConsoleErrors(h.consoleErrors).filter((error: string) =>
      !/file is not a database|connect to 127\.0\.0\.1 port 1/i.test(error));
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
