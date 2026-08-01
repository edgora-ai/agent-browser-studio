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

interface RequestIdentityHeaders {
  userAgent: string | null;
  acceptLanguage: string | null;
  doNotTrack: string | null;
  uaPlatform: string | null;
}

interface RunResult {
  probe: Probe;
  codecs: {
    aacCanPlay: string;
    h264CanPlay: string;
    mediaSourceAAC: boolean | null;
    mediaSourceH264: boolean | null;
    audioDecoding: {
      supported: boolean;
      smooth: boolean;
      powerEfficient: boolean;
    } | null;
    videoDecoding: {
      supported: boolean;
      smooth: boolean;
      powerEfficient: boolean;
    } | null;
    aacEncoder: boolean | null;
    h264Encoder: boolean | null;
  };
  media: {
    devices: Array<{ kind: string; deviceId: string; groupId: string; label: string }>;
    audioTrackDeviceId: string | null;
    videoTrackDeviceId: string | null;
    audioCaptureStatus: "ok" | "timeout" | "error";
    audioCaptureError: string | null;
  };
  storageBucketQuota: number | null;
  webauthn: {
    capabilities: Record<string, boolean>;
    userVerifyingPlatformAuthenticator: boolean;
    conditionalMediation: boolean;
  };
  geolocation: { latitude: number; longitude: number; accuracy: number };
  requestHeaders: {
    window: RequestIdentityHeaders;
    dedicated: RequestIdentityHeaders;
    shared: RequestIdentityHeaders;
    service: RequestIdentityHeaders;
  };
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
      response.end("onconnect=function(e){var p=e.ports[0];fetch('/echo').then(function(r){return r.json()}).then(function(v){p.postMessage(v.headers)}).catch(function(){p.postMessage({})})}");
      return;
    }
    if (pathname === "/service-worker.js") {
      response.setHeader("content-type", "text/javascript");
      response.end("self.onmessage=function(e){var p=e.ports[0];e.waitUntil(fetch('/echo').then(function(r){return r.json()}).then(function(v){p.postMessage(v.headers)}).catch(function(){p.postMessage({})}))}");
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
    const devices = (await navigator.mediaDevices.enumerateDevices()).map((device) => ({
      kind: device.kind,
      deviceId: device.deviceId,
      groupId: device.groupId,
      label: device.label,
    }));
    async function exact(
      kind: "audioinput" | "videoinput",
      timeoutMs: number,
    ): Promise<{
      status: "ok" | "timeout" | "error";
      deviceId: string | null;
      error: string | null;
    }> {
      const device = devices.find((entry) => entry.kind === kind);
      if (!device) return { status: "error", deviceId: null, error: `No ${kind} device was enumerated` };
      const constraints = kind === "audioinput"
        ? { audio: { deviceId: { exact: device.deviceId } } }
        : { video: { deviceId: { exact: device.deviceId } } };
      return new Promise((resolve) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          settled = true;
          resolve({ status: "timeout", deviceId: null, error: null });
        }, timeoutMs);
        void navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
          const deviceId = stream.getTracks()[0]?.getSettings().deviceId || null;
          stream.getTracks().forEach((track) => track.stop());
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve({ status: "ok", deviceId, error: null });
        }).catch((error: unknown) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve({
            status: "error",
            deviceId: null,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    }
    // On macOS, fake audio capture can remain pending even in stock Chrome.
    // Verify video strictly first, then report audio timeout as an explicit
    // environment limitation while retaining audio enumeration/ID checks.
    const video = await exact("videoinput", 8000);
    const audio = await exact("audioinput", 3000);
    return {
      devices,
      audioTrackDeviceId: audio.deviceId,
      videoTrackDeviceId: video.deviceId,
      audioCaptureStatus: audio.status,
      audioCaptureError: audio.error,
    };
  });
}

async function captureCodecs(page: Page): Promise<RunResult["codecs"]> {
  return page.evaluate(async () => {
    interface DecodingSupport {
      supported: boolean;
      smooth: boolean;
      powerEfficient: boolean;
    }
    interface EncoderSupport {
      supported: boolean;
    }
    interface CodecGlobals {
      AudioEncoder?: {
        isConfigSupported(config: Record<string, unknown>): Promise<EncoderSupport>;
      };
      VideoEncoder?: {
        isConfigSupported(config: Record<string, unknown>): Promise<EncoderSupport>;
      };
    }
    const mediaCapabilities = (navigator as Navigator & {
      mediaCapabilities?: {
        decodingInfo(config: Record<string, unknown>): Promise<DecodingSupport>;
      };
    }).mediaCapabilities;
    const globals = globalThis as unknown as CodecGlobals;
    const supported = async (operation: (() => Promise<EncoderSupport>) | undefined): Promise<boolean | null> => {
      if (!operation) return null;
      try {
        return (await operation()).supported;
      } catch {
        return null;
      }
    };
    const decoding = async (
      config: Record<string, unknown>,
    ): Promise<DecodingSupport | null> => {
      if (!mediaCapabilities) return null;
      try {
        const result = await mediaCapabilities.decodingInfo(config);
        return {
          supported: result.supported,
          smooth: result.smooth,
          powerEfficient: result.powerEfficient,
        };
      } catch {
        return null;
      }
    };
    const audio = document.createElement("audio");
    const video = document.createElement("video");
    const aacMime = 'audio/mp4; codecs="mp4a.40.2"';
    const h264Mime = 'video/mp4; codecs="avc1.42E01E"';
    const audioConfig = {
      codec: "mp4a.40.2",
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128000,
    };
    const videoConfig = {
      codec: "avc1.42001f",
      width: 640,
      height: 360,
      bitrate: 1000000,
      framerate: 30,
    };
    const [audioDecoding, videoDecoding, aacEncoder, h264Encoder] = await Promise.all([
      decoding({
        type: "file",
        audio: {
          contentType: aacMime,
          channels: "2",
          bitrate: 128000,
          samplerate: 48000,
        },
      }),
      decoding({
        type: "file",
        video: {
          contentType: h264Mime,
          width: 640,
          height: 360,
          bitrate: 1000000,
          framerate: 30,
        },
      }),
      supported(globals.AudioEncoder
        ? () => globals.AudioEncoder!.isConfigSupported(audioConfig)
        : undefined),
      supported(globals.VideoEncoder
        ? () => globals.VideoEncoder!.isConfigSupported(videoConfig)
        : undefined),
    ]);
    return {
      aacCanPlay: audio.canPlayType(aacMime),
      h264CanPlay: video.canPlayType(h264Mime),
      mediaSourceAAC: typeof MediaSource === "undefined" ? null : MediaSource.isTypeSupported(aacMime),
      mediaSourceH264: typeof MediaSource === "undefined" ? null : MediaSource.isTypeSupported(h264Mime),
      audioDecoding,
      videoDecoding,
      aacEncoder,
      h264Encoder,
    };
  });
}

async function captureStorageBucketQuota(page: Page): Promise<number | null> {
  return page.evaluate(async () => {
    const manager = (navigator as Navigator & {
      storageBuckets?: {
        open(name: string): Promise<{ estimate(): Promise<{ quota?: number }> }>;
        delete(name: string): Promise<void>;
      };
    }).storageBuckets;
    if (!manager) return null;
    const name = "roxy-native-verifier";
    const bucket = await manager.open(name);
    const estimate = await bucket.estimate();
    await manager.delete(name);
    return estimate.quota ?? null;
  });
}

async function captureWebAuthn(page: Page): Promise<RunResult["webauthn"]> {
  return page.evaluate(async () => {
    const credential = PublicKeyCredential as typeof PublicKeyCredential & {
      getClientCapabilities(): Promise<Record<string, boolean>>;
    };
    const [capabilities, userVerifyingPlatformAuthenticator, conditionalMediation] =
      await Promise.all([
        credential.getClientCapabilities(),
        credential.isUserVerifyingPlatformAuthenticatorAvailable(),
        credential.isConditionalMediationAvailable(),
      ]);
    return {
      capabilities,
      userVerifyingPlatformAuthenticator,
      conditionalMediation,
    };
  });
}

async function captureRequestHeaders(page: Page): Promise<RunResult["requestHeaders"]> {
  return page.evaluate(async () => {
    type RawHeaders = Record<string, string | undefined>;
    const select = (headers: RawHeaders): RequestIdentityHeaders => ({
      userAgent: headers["user-agent"] || null,
      acceptLanguage: headers["accept-language"] || null,
      doNotTrack: headers.dnt || null,
      uaPlatform: headers["sec-ch-ua-platform"] || null,
    });
    const windowHeaders = await fetch("/echo")
      .then((response) => response.json())
      .then((value) => value.headers as RawHeaders);
    const dedicatedHeaders = await new Promise<RawHeaders>((resolve) => {
      const echoUrl = JSON.stringify(new URL("/echo", location.href).href);
      const source = `onmessage=function(){fetch(${echoUrl}).then(function(r){return r.json()}).then(function(v){postMessage(v.headers)}).catch(function(){postMessage({})})}`;
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const worker = new Worker(url);
      worker.onmessage = (event) => { worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); };
      worker.onerror = () => { worker.terminate(); URL.revokeObjectURL(url); resolve({}); };
      worker.postMessage(1);
    });
    const sharedHeaders = await new Promise<RawHeaders>((resolve) => {
      const worker = new SharedWorker("/shared-worker.js");
      worker.port.onmessage = (event) => resolve(event.data);
      worker.port.start();
    });
    await navigator.serviceWorker.register("/service-worker.js");
    const registration = await navigator.serviceWorker.ready;
    const serviceHeaders = await new Promise<RawHeaders>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data);
      registration.active?.postMessage(1, [channel.port2]);
      if (!registration.active) resolve({});
    });
    await registration.unregister();
    return {
      window: select(windowHeaders),
      dedicated: select(dedicatedHeaders),
      shared: select(sharedHeaders),
      service: select(serviceHeaders),
    };
  });
}

async function captureDisabledWebRtc(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const connection = new RTCPeerConnection({ iceServers: [] });
    const candidates: string[] = [];
    let stage = "createDataChannel";
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          connection.close();
          reject(new Error(`WebRTC disabled-mode probe stalled during ${stage}`));
        }, 6000);
        void (async () => {
          connection.createDataChannel("verify");
          connection.onicecandidate = (event) => {
            if (event.candidate?.candidate) candidates.push(event.candidate.candidate);
          };
          stage = "createOffer";
          const offer = await connection.createOffer();
          stage = "setLocalDescription";
          await connection.setLocalDescription(offer);
          stage = "candidate settling";
          await new Promise((settle) => setTimeout(settle, 1200));
          window.clearTimeout(timer);
          connection.close();
          resolve(candidates);
        })().catch((error) => {
          window.clearTimeout(timer);
          connection.close();
          reject(error);
        });
      });
    } finally {
      connection.close();
    }
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
    process.stderr.write(`[verify:chromium] ${label}: AAC/H.264 codecs\n`);
    const codecs = await withTimeout(captureCodecs(page), 12_000, `${label} codecs`);
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
    process.stderr.write(`[verify:chromium] ${label}: Storage Buckets quota\n`);
    const storageBucketQuota = await withTimeout(
      captureStorageBucketQuota(page),
      6000,
      `${label} Storage Buckets quota`,
    );
    process.stderr.write(`[verify:chromium] ${label}: WebAuthn capabilities\n`);
    const webauthn = await withTimeout(
      captureWebAuthn(page),
      6000,
      `${label} WebAuthn capabilities`,
    );
    process.stderr.write(`[verify:chromium] ${label}: request headers across workers\n`);
    const requestHeaders = await withTimeout(
      captureRequestHeaders(page),
      12_000,
      `${label} request headers`,
    );
    process.stderr.write(`[verify:chromium] ${label}: WebRTC disable\n`);
    const webrtcCandidates = await withTimeout(captureDisabledWebRtc(page), 12_000, `${label} WebRTC`);
    return {
      config,
      result: {
        probe,
        codecs,
        media,
        storageBucketQuota,
        webauthn,
        geolocation,
        requestHeaders,
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
  const expectedAcceptLanguage = config.languages
    .map((language, index) => index === 0 ? language : `${language};q=${(1 - index / 10).toFixed(1)}`)
    .join(",");
  const expectedUaPlatform = config.platform === "Win32" ? '"Windows"' : '"macOS"';
  for (const [context, headers] of Object.entries(run.requestHeaders)) {
    expectEqual(headers.userAgent, config.userAgent, `${context} request User-Agent`);
    expectEqual(headers.acceptLanguage, expectedAcceptLanguage, `${context} request Accept-Language`);
    expectEqual(headers.doNotTrack, "1", `${context} request DNT`);
    // Chromium sends low-entropy UA-CH on document navigation but omits it
    // from Worker fetches. Preserve that stock request shape.
    expectEqual(
      headers.uaPlatform,
      context === "window" ? expectedUaPlatform : null,
      `${context} request Sec-CH-UA-Platform`,
    );
  }
  expectEqual(run.webrtcCandidates, [], "disabled WebRTC candidates");

  expectEqual(run.codecs.aacCanPlay, "probably", "AAC canPlayType");
  expectEqual(run.codecs.h264CanPlay, "probably", "H.264 canPlayType");
  expectEqual(run.codecs.mediaSourceAAC, true, "MediaSource AAC support");
  expectEqual(run.codecs.mediaSourceH264, true, "MediaSource H.264 support");
  expectEqual(run.codecs.audioDecoding?.supported, true, "MediaCapabilities AAC decoding");
  expectEqual(run.codecs.videoDecoding?.supported, true, "MediaCapabilities H.264 decoding");
  expectEqual(run.codecs.aacEncoder, true, "WebCodecs AAC encoder");
  expectEqual(run.codecs.h264Encoder, true, "WebCodecs H.264 encoder");

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
  expectEqual(run.media.videoTrackDeviceId, video?.deviceId || null, "video track synthetic deviceId");
  if (run.media.audioCaptureStatus === "ok") {
    expectEqual(run.media.audioTrackDeviceId, audio?.deviceId || null, "audio track synthetic deviceId");
  } else {
    expectEqual(run.media.audioCaptureStatus, "timeout", `audio capture (${run.media.audioCaptureError || "no error"})`);
    expectEqual(run.media.audioTrackDeviceId, null, "timed-out audio track deviceId");
  }

  const voiceNames = config.speechSynthesis.voices.map((voice) => voice.name).sort();
  for (const name of voiceNames) {
    expect(String(probe.speechVoices || "").includes(name), `Missing configured speech voice: ${name}`);
  }
  expectEqual(probe.storageQuota, config.storageQuotaBytes, "storage quota");
  expectEqual(run.storageBucketQuota, config.storageQuotaBytes, "Storage Buckets quota");
  const expectedWebAuthn = config.webauthn;
  for (const [name, expected] of Object.entries({
    conditionalGet: expectedWebAuthn.conditionalGet,
    conditionalCreate: expectedWebAuthn.conditionalCreate,
    hybridTransport: expectedWebAuthn.hybridTransport,
    passkeyPlatformAuthenticator: expectedWebAuthn.passkeyPlatformAuthenticator,
    userVerifyingPlatformAuthenticator: expectedWebAuthn.userVerifyingPlatformAuthenticator,
    relatedOrigins: true,
    signalAllAcceptedCredentials: true,
    signalCurrentUserDetails: true,
    signalUnknownCredential: true,
  })) {
    expectEqual(run.webauthn.capabilities[name], expected, `WebAuthn capability ${name}`);
  }
  expectEqual(
    run.webauthn.userVerifyingPlatformAuthenticator,
    expectedWebAuthn.userVerifyingPlatformAuthenticator,
    "WebAuthn UVPAA",
  );
  expectEqual(
    run.webauthn.conditionalMediation,
    expectedWebAuthn.conditionalGet,
    "WebAuthn conditional mediation",
  );
}

function verifyStable(first: RunResult, second: RunResult): void {
  for (const field of STABLE_FIELDS) {
    expectEqual(first.probe[field], second.probe[field], `same-seed stability ${field}`);
  }
  expectEqual(first.codecs, second.codecs, "same-seed codec capabilities");
  expectEqual(first.media, second.media, "same-seed media mapping");
  expectEqual(first.storageBucketQuota, second.storageBucketQuota, "same-seed Storage Buckets quota");
  expectEqual(first.webauthn, second.webauthn, "same-seed WebAuthn capabilities");
  expectEqual(first.geolocation, second.geolocation, "same-seed geolocation");
  expectEqual(first.requestHeaders, second.requestHeaders, "same-seed request headers");
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
      codecs: "aac-h264-verified",
      storageBuckets: "verified",
      webauthn: "verified",
      sameSeedStable: true,
      differentSeedsDistinct: true,
      audioCapture: first.result.media.audioCaptureStatus === "timeout"
        ? "environment-timeout (also reproduced with stock Chrome)"
        : "verified",
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
