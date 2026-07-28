/// <reference lib="dom" />

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { CAPTURE_EXPRESSION } from "../main/services/fingerprint-baseline.js";
import {
  buildRoxyFingerprintArg,
  buildRoxyFingerprintConfig,
  type RoxyFingerprintConfig,
} from "../main/services/roxy-fingerprint-config.js";
import type { CloakFingerprintMeta } from "../main/types.js";

type Probe = Record<string, string | number | boolean | null | undefined>;

interface RunResult {
  probe: Probe;
  media: {
    devices: Array<{ kind: string; deviceId: string; groupId: string; label: string }>;
    audioTrackDeviceId: string | null;
    videoTrackDeviceId: string | null;
  };
  geolocation: { latitude: number; longitude: number; accuracy: number };
  dnt: { window: string | null; dedicated: string | null; shared: string | null; service: string | null };
  webrtcCandidates: string[];
}

const STABLE_FIELDS = [
  "userAgent", "appVersion", "platform", "language", "languages",
  "hardwareConcurrency", "deviceMemory", "maxTouchPoints", "doNotTrack",
  "screenW", "screenH", "availW", "availH", "colorDepth", "pixelDepth",
  "devicePixelRatio", "tz", "tzOffset", "uaPlatform", "uaHighEntropy",
  "plugins", "mimeTypes", "glVendor", "glUnmaskedVendor", "glRenderer",
  "canvasHash", "audioHash", "clientRect", "fontAvailability",
  "speechVoices", "mediaDevices", "storageQuota", "webgpuVendor",
  "webgpuArchitecture", "webgpuDevice", "webgpuDescription", "workerIdentity",
] as const;

function fail(message: string): never {
  throw new Error(message);
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveExecutable(input: string): string {
  const resolved = path.resolve(input);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() && resolved.endsWith(".app")) {
    const appName = path.basename(resolved, ".app");
    for (const name of [appName, "Chromium", "Google Chrome", "Google Chrome for Testing"]) {
      const candidate = path.join(resolved, "Contents", "MacOS", name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  fail(`Chromium executable not found: ${input}`);
}

function detectVersion(executablePath: string): string {
  try {
    const output = execFileSync(executablePath, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return output.match(/\d+\.\d+\.\d+\.\d+/)?.[0] || "149.0.7827.22";
  } catch {
    return "149.0.7827.22";
  }
}

async function startOrigin(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/echo") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ headers: request.headers }));
      return;
    }
    if (pathname === "/shared-worker.js") {
      response.setHeader("content-type", "text/javascript");
      response.end("onconnect=function(e){var p=e.ports[0];fetch('/echo').then(function(r){return r.json()}).then(function(v){p.postMessage(v.headers.dnt||null)}).catch(function(){p.postMessage(null)})}");
      return;
    }
    if (pathname === "/service-worker.js") {
      response.setHeader("content-type", "text/javascript");
      response.end("self.onmessage=function(e){var p=e.ports[0];e.waitUntil(fetch('/echo').then(function(r){return r.json()}).then(function(v){p.postMessage(v.headers.dnt||null)}).catch(function(){p.postMessage(null)}))}");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><meta charset=utf-8><title>Roxy native verification</title><canvas id=c width=64 height=32></canvas>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") fail("Failed to bind verification origin");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function captureMedia(page: Page): Promise<RunResult["media"]> {
  return page.evaluate(async () => {
    let warmup: MediaStream | null = null;
    try {
      warmup = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch {
      // Fake devices are requested at launch, but keep enumeration diagnostic.
    } finally {
      warmup?.getTracks().forEach((track) => track.stop());
    }
    const devices = (await navigator.mediaDevices.enumerateDevices()).map((device) => ({
      kind: device.kind,
      deviceId: device.deviceId,
      groupId: device.groupId,
      label: device.label,
    }));
    async function exact(kind: "audioinput" | "videoinput"): Promise<string | null> {
      const device = devices.find((entry) => entry.kind === kind);
      if (!device) return null;
      const constraints = kind === "audioinput"
        ? { audio: { deviceId: { exact: device.deviceId } } }
        : { video: { deviceId: { exact: device.deviceId } } };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      try {
        return stream.getTracks()[0]?.getSettings().deviceId || null;
      } finally {
        stream.getTracks().forEach((track) => track.stop());
      }
    }
    return {
      devices,
      audioTrackDeviceId: await exact("audioinput"),
      videoTrackDeviceId: await exact("videoinput"),
    };
  });
}

async function captureDnt(page: Page): Promise<RunResult["dnt"]> {
  return page.evaluate(async () => {
    const windowValue = await fetch("/echo").then((response) => response.json()).then((value) => value.headers.dnt || null);
    const dedicated = await new Promise<string | null>((resolve) => {
      const source = "onmessage=function(){fetch('/echo').then(function(r){return r.json()}).then(function(v){postMessage(v.headers.dnt||null)}).catch(function(){postMessage(null)})}";
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const worker = new Worker(url);
      worker.onmessage = (event) => { worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); };
      worker.onerror = () => { worker.terminate(); URL.revokeObjectURL(url); resolve(null); };
      worker.postMessage(1);
    });
    const shared = await new Promise<string | null>((resolve) => {
      const worker = new SharedWorker("/shared-worker.js");
      worker.port.onmessage = (event) => resolve(event.data);
      worker.port.start();
    });
    await navigator.serviceWorker.register("/service-worker.js");
    const registration = await navigator.serviceWorker.ready;
    const service = await new Promise<string | null>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data);
      registration.active?.postMessage(1, [channel.port2]);
      if (!registration.active) resolve(null);
    });
    await registration.unregister();
    return { window: windowValue, dedicated, shared, service };
  });
}

async function captureDisabledWebRtc(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const connection = new RTCPeerConnection({ iceServers: [] });
    const candidates: string[] = [];
    connection.createDataChannel("verify");
    connection.onicecandidate = (event) => {
      if (event.candidate?.candidate) candidates.push(event.candidate.candidate);
    };
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    connection.close();
    return candidates;
  });
}

async function runOnce(
  executablePath: string,
  version: string,
  meta: CloakFingerprintMeta,
  origin: string,
  userDataDir: string,
  label: string,
): Promise<{ result: RunResult; config: RoxyFingerprintConfig }> {
  const config = buildRoxyFingerprintConfig(meta, version);
  let context: BrowserContext | null = null;
  try {
    process.stderr.write(`[verify:chromium] ${label}: launch\n`);
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: true,
      timeout: 20_000,
      viewport: null,
      args: [
        buildRoxyFingerprintArg(meta, version),
        `--user-agent=${config.userAgent}`,
        `--lang=${config.languages[0]}`,
        ...(config.timezone ? [`--time-zone-for-testing=${config.timezone}`] : []),
        "--enable-unsafe-webgpu",
        "--ignore-gpu-blocklist",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    });
    await context.grantPermissions(["geolocation"], { origin });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(origin, { waitUntil: "load", timeout: 15_000 });
    process.stderr.write(`[verify:chromium] ${label}: fingerprint probe\n`);
    const raw = await withTimeout(
      page.evaluate(async (expression) => await (0, eval)(expression), CAPTURE_EXPRESSION),
      20_000,
      `${label} fingerprint probe`,
    );
    const probe = JSON.parse(String(raw)) as Probe;
    process.stderr.write(`[verify:chromium] ${label}: geolocation\n`);
    const geolocation = await withTimeout(
      page.evaluate(() => new Promise<{ latitude: number; longitude: number; accuracy: number }>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (position) => resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          }),
          (error) => reject(new Error(error.message)),
          { timeout: 4000 },
        );
      })),
      6000,
      `${label} geolocation`,
    );
    process.stderr.write(`[verify:chromium] ${label}: media devices\n`);
    const media = await withTimeout(captureMedia(page), 15_000, `${label} media devices`);
    process.stderr.write(`[verify:chromium] ${label}: DNT workers\n`);
    const dnt = await withTimeout(captureDnt(page), 12_000, `${label} DNT workers`);
    process.stderr.write(`[verify:chromium] ${label}: WebRTC disable\n`);
    const webrtcCandidates = await withTimeout(captureDisabledWebRtc(page), 5000, `${label} WebRTC`);
    return {
      config,
      result: {
        probe,
        media,
        geolocation,
        dnt,
        webrtcCandidates,
      },
    };
  } finally {
    if (context) await withTimeout(context.close(), 10_000, `${label} browser close`).catch(() => undefined);
  }
}

function verifyExpected(run: RunResult, config: RoxyFingerprintConfig): void {
  const probe = run.probe;
  expectEqual(probe.userAgent, config.userAgent, "navigator.userAgent");
  expectEqual(probe.appVersion, config.appVersion, "navigator.appVersion");
  expectEqual(probe.platform, config.platform, "navigator.platform");
  expectEqual(probe.languages, config.languages.join(","), "navigator.languages");
  expectEqual(probe.hardwareConcurrency, config.hardwareConcurrency, "navigator.hardwareConcurrency");
  expectEqual(probe.deviceMemory, config.deviceMemory, "navigator.deviceMemory");
  expectEqual(probe.maxTouchPoints, config.maxTouchPoints, "navigator.maxTouchPoints");
  expectEqual(probe.doNotTrack, config.doNotTrack, "navigator.doNotTrack");
  expectEqual(probe.screenW, config.screen.width, "screen.width");
  expectEqual(probe.screenH, config.screen.height, "screen.height");
  expectEqual(probe.availW, config.screen.availWidth, "screen.availWidth");
  expectEqual(probe.availH, config.screen.availHeight, "screen.availHeight");
  expectEqual(probe.devicePixelRatio, config.screen.devicePixelRatio, "devicePixelRatio");
  expectEqual(probe.tz, config.timezone, "Intl timezone");
  expectEqual(probe.glUnmaskedVendor, config.webgl.vendor, "WebGL unmasked vendor");
  expectEqual(probe.glRenderer, config.webgl.renderer, "WebGL unmasked renderer");
  expectEqual(probe.webgpuVendor, config.webgpu.vendor, "WebGPU vendor");
  expect(String(probe.workerIdentity || "").includes(config.userAgent), "Worker user agent did not match Window");
  expect(String(probe.workerIdentity || "").includes(config.platform), "Worker platform did not match Window");
  expectEqual(run.geolocation.latitude, config.geolocation.latitude, "geolocation latitude");
  expectEqual(run.geolocation.longitude, config.geolocation.longitude, "geolocation longitude");
  expectEqual(run.geolocation.accuracy, config.geolocation.accuracy, "geolocation accuracy");
  expectEqual(run.dnt, { window: "1", dedicated: "1", shared: "1", service: "1" }, "DNT request headers");
  expectEqual(run.webrtcCandidates, [], "disabled WebRTC candidates");

  const expectedCounts: Record<string, number> = {
    audioinput: config.mediaDevices.audioInputs,
    videoinput: config.mediaDevices.videoInputs,
    audiooutput: config.mediaDevices.audioOutputs,
  };
  for (const [kind, count] of Object.entries(expectedCounts)) {
    expectEqual(run.media.devices.filter((device) => device.kind === kind).length, count, `mediaDevices ${kind} count`);
  }
  const audio = run.media.devices.find((device) => device.kind === "audioinput");
  const video = run.media.devices.find((device) => device.kind === "videoinput");
  expectEqual(run.media.audioTrackDeviceId, audio?.deviceId || null, "audio track synthetic deviceId");
  expectEqual(run.media.videoTrackDeviceId, video?.deviceId || null, "video track synthetic deviceId");

  const voiceNames = config.speechSynthesis.voices.map((voice) => voice.name).sort();
  for (const name of voiceNames) {
    expect(String(probe.speechVoices || "").includes(name), `Missing configured speech voice: ${name}`);
  }
  expectEqual(probe.storageQuota, config.storageQuotaBytes, "storage quota");
}

function verifyStable(first: RunResult, second: RunResult): void {
  for (const field of STABLE_FIELDS) {
    expectEqual(first.probe[field], second.probe[field], `same-seed stability ${field}`);
  }
  expectEqual(first.media, second.media, "same-seed media mapping");
  expectEqual(first.geolocation, second.geolocation, "same-seed geolocation");
  expectEqual(first.dnt, second.dnt, "same-seed DNT");
  expectEqual(first.webrtcCandidates, second.webrtcCandidates, "same-seed WebRTC");
}

function verifyDistinct(first: RunResult, second: RunResult): void {
  for (const field of ["canvasHash", "audioHash", "clientRect"] as const) {
    expect(first.probe[field] !== second.probe[field], `different seeds produced identical ${field}`);
  }
  const firstIds = first.media.devices.map((device) => device.deviceId).sort();
  const secondIds = second.media.devices.map((device) => device.deviceId).sort();
  expect(JSON.stringify(firstIds) !== JSON.stringify(secondIds), "different seeds produced identical media device IDs");
}

async function main(): Promise<void> {
  const executableArg = process.argv[2];
  if (!executableArg) fail("usage: npm run verify:chromium -- /path/to/Chromium[.app]");
  const executablePath = resolveExecutable(executableArg);
  const version = detectVersion(executablePath);
  expect(Number(version.split(".")[0]) >= 149, `Chromium 149+ required, detected ${version}`);

  const origin = await startOrigin();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roxy-native-verify-"));
  const baseMeta: CloakFingerprintMeta = {
    fingerprintSeed: 424242,
    platform: "windows",
    locale: "en-US",
    timezone: "America/New_York",
    webrtcMode: "disable",
    geolocationMode: "custom",
    geolocationLatitude: 40.7128,
    geolocationLongitude: -74.006,
    geolocationAccuracy: 25,
    gpuVendor: "Google Inc. (NVIDIA)",
    gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    hardwareConcurrency: 8,
    deviceMemory: 16,
    screenWidth: 1920,
    screenHeight: 1080,
    taskbarHeight: 48,
    storageQuota: 120000,
  };

  try {
    const first = await runOnce(executablePath, version, baseMeta, origin.origin, path.join(tempRoot, "same-a"), "same-seed A");
    const repeat = await runOnce(executablePath, version, baseMeta, origin.origin, path.join(tempRoot, "same-b"), "same-seed B");
    const distinct = await runOnce(
      executablePath,
      version,
      { ...baseMeta, fingerprintSeed: 424243 },
      origin.origin,
      path.join(tempRoot, "distinct"),
      "different-seed",
    );
    verifyExpected(first.result, first.config);
    verifyExpected(repeat.result, repeat.config);
    verifyExpected(distinct.result, distinct.config);
    verifyStable(first.result, repeat.result);
    verifyDistinct(first.result, distinct.result);
    process.stdout.write(JSON.stringify({
      ok: true,
      executablePath,
      version,
      checkedSurfaces: STABLE_FIELDS.length,
      sameSeedStable: true,
      differentSeedsDistinct: true,
    }, null, 2) + "\n");
  } finally {
    await origin.close().catch(() => undefined);
    if (tempRoot.startsWith(os.tmpdir() + path.sep + "roxy-native-verify-")) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[verify:chromium] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
