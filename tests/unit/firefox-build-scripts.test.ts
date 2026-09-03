import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const FIREFOX = path.join(ROOT, "patches", "firefox");
const PREPARE = path.join(FIREFOX, "prepare-source.sh");
const SEED = path.join(FIREFOX, "seed-source-archive.sh");
const VERIFY = path.join(FIREFOX, "verify-source-provenance.sh");
const VERIFY_RELEASE = path.join(FIREFOX, "verify-release-signature.sh");
const APPLY = path.join(FIREFOX, "apply.sh");
const CHECK = path.join(FIREFOX, "check.sh");
const BUILD = path.join(FIREFOX, "build-macos.sh");
const CAPTURE_STOCK = path.join(FIREFOX, "scripts", "capture-stock154.mjs");
const VERIFY_GATE_A = path.join(FIREFOX, "scripts", "verify-gate-a154.mjs");
const VERIFY_AUDIO = path.join(FIREFOX, "scripts", "verify-audio154.mjs");
const VERIFY_CANVAS = path.join(FIREFOX, "scripts", "verify-canvas154.mjs");
const VERIFY_GPU = path.join(FIREFOX, "scripts", "verify-gpu154.mjs");
const VERIFY_GEO_STORAGE = path.join(FIREFOX, "scripts", "verify-geo-storage154.mjs");
const VERIFY_MEDIA_DEVICES = path.join(FIREFOX, "scripts", "verify-media-devices154.mjs");
const STOCK_CORPUS = path.join(FIREFOX, "corpora-154", "stock-firefox-154.0.json");
const GATE_A_CORPUS = path.join(FIREFOX, "corpora-154", "gate-a-firefox-154.0.json");
const AUDIO_CORPUS = path.join(FIREFOX, "corpora-154", "audio-firefox-154.0.json");
const CANVAS_CORPUS = path.join(FIREFOX, "corpora-154", "canvas-firefox-154.0.json");
const GPU_CORPUS = path.join(FIREFOX, "corpora-154", "gpu-firefox-154.0.json");
const GEO_STORAGE_CORPUS = path.join(FIREFOX, "corpora-154", "geo-storage-firefox-154.0.json");
const MEDIA_DEVICES_CORPUS = path.join(FIREFOX, "corpora-154", "media-devices-firefox-154.0.json");
const CONFIG_PATCH = path.join(FIREFOX, "patches", "0001-agent-browser-config-capabilities.patch");
const GATE_A_PATCH = path.join(FIREFOX, "patches", "0002-agent-browser-navigator-screen.patch");
const CANVAS_PATCH = path.join(FIREFOX, "patches", "0003-agent-browser-canvas-noise.patch");
const GPU_PATCH = path.join(FIREFOX, "patches", "0004-agent-browser-webgl-webgpu-identity.patch");
const AUDIO_PATCH = path.join(FIREFOX, "patches", "0005-agent-browser-audio-readback.patch");
const GEO_STORAGE_PATCH = path.join(FIREFOX, "patches", "0006-agent-browser-geolocation-storage.patch");
const MEDIA_DEVICES_PATCH = path.join(FIREFOX, "patches", "0007-agent-browser-media-devices.patch");
const PATCHED_SOURCE = path.join(FIREFOX, "PATCHED_SOURCE.sha256");
const SOURCE_STAMP = "9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc";
const SOURCE_SHA512 = "a77cd664982add628681167ef5939bd6bf0c894aa380cca66f9b5fb265947874d1e819d42264f1dd07c843f8a6dc020da268cca9ff1e064fca019de91af9b996";

describe("Firefox 154 source and build scripts", () => {
  it("have valid bash syntax", () => {
    execFileSync("bash", ["-n", PREPARE, SEED, VERIFY, VERIFY_RELEASE, APPLY, CHECK, BUILD], { stdio: "pipe" });
  });

  it("pin the exact official release source and reject unsafe archives", () => {
    const prepare = fs.readFileSync(PREPARE, "utf8");
    const seed = fs.readFileSync(SEED, "utf8");
    const verify = fs.readFileSync(VERIFY, "utf8");
    expect(prepare).toContain("firefox-154.0.source.tar.xz");
    expect(prepare).toContain("archive.mozilla.org/pub/firefox/releases/154.0/source");
    expect(seed).toContain(SOURCE_STAMP);
    expect(seed).toContain(SOURCE_SHA512);
    expect(seed).toContain("contains an absolute or traversal path");
    expect(seed).toContain("sourcestamp.txt");
    expect(verify).toContain('source_build_id" != "$EXPECTED_BUILD_ID"');
    expect(verify).toContain('source_url" != "$EXPECTED_SOURCE_URL"');
    const release = fs.readFileSync(VERIFY_RELEASE, "utf8");
    expect(release).toContain("827E658608679618CD349F93678E455D76767AA3");
    expect(release).toContain("gpg --batch --status-fd 1 --verify");
    expect(prepare).toContain("verify-release-signature.sh");
    expect(verify).not.toContain("return true");
  });

  it("uses resumable disk-gated preparation outside the repository", () => {
    const prepare = fs.readFileSync(PREPARE, "utf8");
    expect(prepare).toContain("--continue-at -");
    expect(prepare).toContain("FIREFOX_PREPARE_MIN_FREE_GIB:-100");
    expect(prepare).toContain("FIREFOX_POST_SYNC_MIN_FREE_GIB:-70");
    expect(prepare).not.toContain('rm -rf "$FIREFOX_SRC"');
  });

  it("keeps patch assets append-only and final files verifiable", () => {
    const apply = fs.readFileSync(APPLY, "utf8");
    const check = fs.readFileSync(CHECK, "utf8");
    expect(apply).toContain("agent-browser-firefox-patches");
    expect(apply).toContain("apply --reverse --check");
    expect(apply).toContain("PATCHED_SOURCE.sha256");
    expect(check).toContain("PATCHSET.sha256 must list every Firefox patch");
    expect(check).toContain("Firefox source patch is not recorded as applied");
    expect(check).toContain('[[ -d "$directory" ]]');
    expect(() => execFileSync("shasum", ["-a", "256", "-c", "PATCHSET.sha256"], {
      cwd: FIREFOX,
      stdio: "pipe",
    })).not.toThrow();
  });

  it("pins the native config channel without claiming page-surface parity", () => {
    const patch = fs.readFileSync(CONFIG_PATCH, "utf8");
    expect(patch).toContain("agent-browser-capabilities");
    expect(patch).toContain("agent-browser-native-required");
    expect(patch).toContain("agent.browser.fingerprint.config");
    expect(patch).toContain("AGENT_BROWSER_NATIVE_CONFIG_ERROR");
    expect(patch).toContain("config-v1");
    expect(patch).toContain("native-required-v1");
    expect(patch).toContain("snapshot-v1");
    expect(patch).toContain("InitializeChild");
    expect(patch).toContain("dom/ipc/ContentProcess.cpp");
    expect(patch).not.toContain("navigator-v1");
    expect(patch).not.toContain("canvas-v1");
  });

  it("pins native Navigator, WorkerNavigator and screen overrides without expanding worker APIs", () => {
    const patch = fs.readFileSync(GATE_A_PATCH, "utf8");
    const patchedSource = fs.readFileSync(PATCHED_SOURCE, "utf8").trim().split("\n");
    expect(patch).toContain("navigator-v1");
    expect(patch).toContain("screen-v1");
    expect(patch).toContain("GetNavigatorOverrides");
    expect(patch).toContain("GetScreenOverrides");
    expect(patch).toContain("mUserAgent");
    expect(patch).toContain("incoherent-platform-version");
    expect(patch).toContain("incoherent-user-agent");
    expect(patch).toContain("Atomic<Snapshot*, ReleaseAcquire>");
    expect(patch).toContain("dom/workers/WorkerNavigator.cpp");
    expect(patch).toContain("dom/webidl/Screen.webidl");
    expect(patch).toContain("dom/webidl/Window.webidl");
    expect(patch).toContain("[Constant, Cached, NeedsCallerType]");
    expect(patch).toContain("[NeedsCallerType] readonly attribute long width");
    expect(patch).toContain("[Replaceable, Throws, NeedsCallerType] readonly attribute double innerWidth");
    expect(patch).toContain("aCallerType != CallerType::System");
    expect(patch).not.toContain("dom/webidl/WorkerNavigator.webidl");
    expect(patch).not.toContain("canvas-v1");
    expect(patchedSource).toHaveLength(39);
    expect(patchedSource.some((line) => line.endsWith("  toolkit/xre/AgentBrowserFingerprint.cpp"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/ipc/ContentProcess.cpp"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/base/Navigator.cpp"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/base/nsScreen.cpp"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/base/nsScreen.h"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/base/nsGlobalWindowInner.h"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/base/nsGlobalWindowOuter.h"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/webidl/Screen.webidl"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/webidl/Window.webidl"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/workers/WorkerNavigator.cpp"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/workers/WorkerNavigator.h"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  xpfe/appshell/AppWindow.cpp"))).toBe(true);
  });

  it("pins native deterministic Canvas/OffscreenCanvas readback noise", () => {
    const patch = fs.readFileSync(CANVAS_PATCH, "utf8");
    const patchedSource = fs.readFileSync(PATCHED_SOURCE, "utf8").trim().split("\n");
    expect(patch).toContain("canvas-v1");
    expect(patch).toContain("CanvasOverrideConfig");
    expect(patch).toContain("DeriveCanvasKey");
    expect(patch).toContain("IsCanvasNoiseEnabled");
    expect(patch).toContain("dom/canvas/CanvasUtils.cpp");
    expect(patch).toContain("GenerateCanvasKeyFromImageData");
    expect(patch).not.toContain("webgl-v1");
    expect(patch).not.toContain("audio-v1");
    expect(patchedSource.some((line) => line.endsWith("  dom/canvas/CanvasUtils.cpp"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  toolkit/components/resistfingerprinting/nsRFPService.cpp"))).toBe(true);
  });

  it("pins native WebGL and WebGPU identity without changing GPU capabilities", () => {
    const patch = fs.readFileSync(GPU_PATCH, "utf8");
    const patchedSource = fs.readFileSync(PATCHED_SOURCE, "utf8").trim().split("\n");
    expect(patch).toContain("webgl-v1");
    expect(patch).toContain("webgpu-v1");
    expect(patch).toContain("WebGLOverrideConfig");
    expect(patch).toContain("WebGPUOverrideConfig");
    expect(patch).toContain("GetWebGLOverrides");
    expect(patch).toContain("GetWebGPUOverrides");
    expect(patch).toContain("incoherent-gpu-identity");
    expect(patch).toContain("dom/canvas/ClientWebGLContext.cpp");
    expect(patch).toContain("dom/webgpu/Adapter.cpp");
    expect(patch).toContain("principal->IsSystemPrincipal()");
    expect(patch).toContain("UNMASKED_VENDOR_WEBGL");
    expect(patch).toContain("LOCAL_GL_RENDERER");
    expect(patch).not.toContain("audio-v1");
    expect(patchedSource.some((line) => line.endsWith("  dom/canvas/ClientWebGLContext.cpp"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/webgpu/Adapter.cpp"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/webgpu/Adapter.h"))).toBe(true);
  });

  it("pins deterministic readback-only AudioBuffer and Analyser noise", () => {
    const patch = fs.readFileSync(AUDIO_PATCH, "utf8");
    const patchedSource = fs.readFileSync(PATCHED_SOURCE, "utf8").trim().split("\n");
    expect(patch).toContain("audio-v1");
    expect(patch).toContain("AudioOverrideConfig");
    expect(patch).toContain("ShouldApplyAudioNoise");
    expect(patch).toContain("AudioNoiseForSample");
    expect(patch).toContain("AudioNoiseForByte");
    expect(patch).toContain("mAgentBrowserChannelViews");
    expect(patch).toContain("MergeAndDetachAgentBrowserChannelViews");
    expect(patch).toContain("JS::DetachArrayBuffer");
    expect(patch).toContain("GetFloatFrequencyData");
    expect(patch).toContain("GetByteFrequencyData");
    expect(patch).toContain("GetFloatTimeDomainData");
    expect(patch).toContain("GetByteTimeDomainData");
    expect(patch).not.toContain("fonts-v1");
    expect(patchedSource.some((line) => line.endsWith("  dom/media/webaudio/AudioBuffer.cpp"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/media/webaudio/AudioBuffer.h"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/media/webaudio/AnalyserNode.cpp"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/media/webaudio/AnalyserNode.h"))).toBe(true);
  });

  it("pins permission-preserving geolocation and storage quota overrides", () => {
    const patch = fs.readFileSync(GEO_STORAGE_PATCH, "utf8");
    const patchedSource = fs.readFileSync(PATCHED_SOURCE, "utf8").trim().split("\n");
    expect(patch).toContain("geolocation-v1");
    expect(patch).toContain("storage-quota-v1");
    expect(patch).toContain("GeolocationOverrideConfig");
    expect(patch).toContain("StorageOverrideConfig");
    expect(patch).toContain("GetRequiredNullableDouble");
    expect(patch).toContain("GetRequiredUInt64");
    expect(patch).toContain("incoherent-geolocation");
    expect(patch).toContain("IsManagedContentGlobal");
    expect(patch).toContain("ShouldApplyAgentGeolocationOverrides");
    expect(patch).toContain("ShouldApplyContentOverrides(window->AsGlobal())");
    expect(patch).toContain("aCallerType == CallerType::System");
    expect(patch).toContain("mApplyAgentOverrides");
    expect(patch).toContain("PERMISSION_DENIED");
    expect(patch).toContain("+      Shutdown();\n+      NotifyError(");
    expect(patch).toContain("MarkAgentCustomWatch");
    expect(patch).toContain("!request->IsAgentCustomWatch()");
    expect(patch).toContain("std::max({usage, realQuota, config->mQuotaBytes})");
    expect(patch).not.toContain("media-devices-v1");
    expect(patch).not.toContain("speech-voices-v1");
    expect(patchedSource.some((line) => line.endsWith("  dom/geolocation/Geolocation.cpp"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/quota/StorageManager.cpp"))).toBe(true);
  });

  it("pins a real native geolocation and storage runtime corpus", () => {
    execFileSync(process.execPath, ["--check", VERIFY_GEO_STORAGE], { stdio: "pipe" });
    const verifier = fs.readFileSync(VERIFY_GEO_STORAGE, "utf8");
    const corpus = JSON.parse(fs.readFileSync(GEO_STORAGE_CORPUS, "utf8"));
    expect(verifier).toContain("--agent-browser-native-required");
    expect(verifier).toContain("Invalid geo/storage config did not fail closed");
    expect(verifier).toContain("geo.prompt.testing.allow");
    expect(verifier).toContain("navigator.geolocation.watchPosition");
    expect(verifier).toContain("navigator.storage.estimate");
    expect(verifier).toContain("indexedDB.open");
    expect(verifier).toContain("geo/storage corpus readback/search validation failed");
    expect(verifier).not.toContain("bidiAddPreloadScript");
    expect(corpus.capture).toMatchObject({
      mode: "webdriver-bidi-headless-native-geo-storage",
      preloadScript: false,
      nativeRequired: true,
    });
    expect(corpus.capabilities.capabilities).toEqual([
      "config-v1",
      "native-required-v1",
      "snapshot-v1",
      "navigator-v1",
      "screen-v1",
      "canvas-v1",
      "webgl-v1",
      "webgpu-v1",
      "audio-v1",
      "geolocation-v1",
      "storage-quota-v1",
      "media-devices-v1",
      "speech-voices-v1",
    ]);
    const custom = corpus.evidence.custom;
    expect(custom.stress).toEqual({
      requested: 1510,
      callbacks: 1510,
      successes: 1510,
      callbackErrors: 0,
      syncFailures: 0,
    });
    for (const realm of ["window", "iframe"] as const) {
      for (const mode of ["current", "watch"] as const) {
        expect(custom[realm][mode]).toMatchObject({
          supported: true,
          success: true,
          timestampFinite: true,
          coords: {
            latitude: corpus.capture.fingerprintConfig.geolocation.latitude,
            longitude: corpus.capture.fingerprintConfig.geolocation.longitude,
            accuracy: corpus.capture.fingerprintConfig.geolocation.accuracy,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null,
          },
        });
        expect(corpus.evidence.denied[realm][mode]).toMatchObject({ success: false, error: { code: 1 } });
        expect(corpus.evidence.disabled[realm][mode]).toMatchObject({ success: false, error: { code: 1 } });
      }
      expect(corpus.evidence.real[realm].current.success).toBe(corpus.evidence.stock[realm].current.success);
      expect(corpus.evidence.real[realm].current.error.code).toBe(corpus.evidence.stock[realm].current.error.code);
      for (const field of ["current", "watch"] as const) {
        expect(custom[realm].geoNative[field]).toMatchObject({
          writable: true,
          enumerable: true,
          configurable: true,
          owner: "Geolocation",
        });
        expect(custom[realm].geoNative[field].source).toContain("[native code]");
      }
      const managedStorage = custom[realm].storage;
      const lowStorage = corpus.evidence.lowQuota[realm].storage;
      const stockStorage = corpus.evidence.stock[realm].storage;
      expect(managedStorage.readbackVerified).toBe(true);
      expect(managedStorage.after.usage).toBeGreaterThan(managedStorage.before.usage);
      expect(managedStorage.after.quota).toBe(corpus.capture.fingerprintConfig.storageQuotaBytes);
      expect(managedStorage.after.usage).toBe(stockStorage.after.usage);
      expect(lowStorage).toMatchObject({ before: stockStorage.before, after: stockStorage.after });
      expect(managedStorage.nativeMethod).toMatchObject({ owner: "StorageManager" });
      expect(managedStorage.nativeMethod.source).toContain("[native code]");
    }
    for (const realm of ["dedicatedWorker", "sharedWorker"] as const) {
      const worker = custom[realm];
      expect(worker).toMatchObject({ supported: true, value: { geolocation: "undefined" } });
      expect(worker.value.storage.readbackVerified).toBe(true);
      expect(worker.value.storage.after.usage).toBeGreaterThan(worker.value.storage.before.usage);
      expect(worker.value.storage.after.quota).toBe(corpus.capture.fingerprintConfig.storageQuotaBytes);
      expect(worker.value.storage.after.usage).toBe(corpus.evidence.stock[realm].value.storage.after.usage);
      expect(corpus.evidence.lowQuota[realm].value.storage).toMatchObject({
        before: corpus.evidence.stock[realm].value.storage.before,
        after: corpus.evidence.stock[realm].value.storage.after,
      });
    }
  });

  it("pins caller-gated media device persona roster overrides", () => {
    const patch = fs.readFileSync(MEDIA_DEVICES_PATCH, "utf8");
    const patchedSource = fs.readFileSync(PATCHED_SOURCE, "utf8").trim().split("\n");
    expect(patch).toContain("media-devices-v1");
    expect(patch).toContain("MediaDevicesOverrideConfig");
    expect(patch).toContain("GetMediaDevicesOverrides");
    expect(patch).toContain("dom/media/MediaDevices.cpp");
    expect(patch).toContain("dom/media/MediaDevices.h");
    expect(patch).toContain("mPendingEnumerateDevicesAgentOverrides");
    expect(patch).toContain("ResolveAgentEnumerateDevicesPromise");
    expect(patch).toContain("ShouldApplyContentOverrides(owner->AsGlobal())");
    expect(patch).toContain("agent-browser-media-devices-v1\\x1f");
    expect(patch).toContain("nsContentUtils::OriginFormat::Plain");
    expect(patch).toContain("agent-browser-group-audio");
    expect(patch).toContain("agent-browser-group-video");
    // Caller gate is captured once at the WebIDL boundary; at promise
    // resolution the subject principal is the system principal, so only the
    // RFP gate may be re-checked on the event loop.
    expect(patch).toContain("system principal");
    // Pre-permission roster mirrors the stock one-per-kind cap.
    expect(patch).toContain("std::min(config->mAudioInputs, 1u)");
    expect(patch).toContain("std::min(config->mVideoInputs, 1u)");
    // Speakers follow the stock rule: mic info exposure or an explicit
    // selectAudioOutput() grant.
    expect(patch).toContain("mExplicitlyGrantedAudioOutputRawIds.IsEmpty()");
    // Persona ids are isolated per OriginAttributes suffix and salted for
    // null-principal documents.
    expect(patch).toContain("CreateSuffix");
    expect(patch).toContain("window-%llu");
    expect(patch).not.toContain("speech-voices-v1");
    expect(patch).not.toContain("fonts-v1");
    expect(patchedSource.some((line) => line.endsWith("  dom/media/MediaDevices.cpp"))).toBe(true);
    expect(patchedSource.some((line) => line.endsWith("  dom/media/MediaDevices.h"))).toBe(true);
  });

  it("pins a real native media devices runtime corpus", () => {
    execFileSync(process.execPath, ["--check", VERIFY_MEDIA_DEVICES], { stdio: "pipe" });
    const verifier = fs.readFileSync(VERIFY_MEDIA_DEVICES, "utf8");
    const corpus = JSON.parse(fs.readFileSync(MEDIA_DEVICES_CORPUS, "utf8"));
    expect(verifier).toContain("--agent-browser-native-required");
    expect(verifier).toContain("Invalid mediaDevices config did not fail closed");
    expect(verifier).toContain("media.navigator.streams.fake");
    expect(verifier).toContain("managed roster changed across restarts");
    expect(verifier).toContain("managed roster ids correlate across origins");
    expect(verifier).toContain("managed denied-policy iframe roster not empty");
    expect(verifier).toContain("managed persona roster identical to stock roster");
    expect(verifier).toContain("multi pre-permission roster wrong");
    expect(verifier).toContain("zero-count roster wrong");
    expect(verifier).toContain("camera-denied iframe roster wrong");
    expect(verifier).toContain("speaker-denied iframe roster wrong");
    expect(verifier).toContain("legacy pre-permission roster wrong");
    expect(verifier).toContain("legacy live-capture roster wrong");
    expect(verifier).toContain("setsinkid-disabled roster wrong");
    expect(verifier).toContain("RFP pass-through diverged");
    expect(verifier).toContain("RFP window leaked persona roster");
    expect(verifier).toContain("media devices corpus readback/search validation failed");
    expect(verifier).not.toContain("bidiAddPreloadScript");
    expect(corpus.capture).toMatchObject({
      mode: "webdriver-bidi-headless-native-media-devices",
      preloadScript: false,
      nativeRequired: true,
    });
    expect(corpus.capabilities.capabilities).toEqual([
      "config-v1",
      "native-required-v1",
      "snapshot-v1",
      "navigator-v1",
      "screen-v1",
      "canvas-v1",
      "webgl-v1",
      "webgpu-v1",
      "audio-v1",
      "geolocation-v1",
      "storage-quota-v1",
      "media-devices-v1",
      "speech-voices-v1",
    ]);
    const shapeOf = (devices) => devices.map((device) => ({ kind: device.kind, label: device.label }));
    const managed = corpus.evidence.managed;
    const config = corpus.capture.fingerprintConfig.mediaDevices;
    expect(config).toEqual({ enabled: true, audioInputs: 1, videoInputs: 1, audioOutputs: 1 });
    // Pre-permission: persona-shaped roster, every field empty, same as stock shape.
    expect(managed.pre.devices.map((device) => device.kind)).toEqual(["audioinput", "videoinput"]);
    for (const device of managed.pre.devices) {
      expect(device).toMatchObject({ label: "", deviceId: "", groupId: "" });
    }
    expect(corpus.evidence.disabled.pre.devices).toEqual(corpus.evidence.stock.pre.devices);
    expect(managed.iframeDenied.devices).toEqual([]);
    expect(managed.iframeDeniedPost.devices).toEqual([]);
    // Post-permission: persona labels, anonymized ids, restart-stable, origin-bound.
    expect(managed.post.repeatIdentical).toBe(true);
    expect(shapeOf(managed.post.devices)).toEqual([
      { kind: "audioinput", label: "Default - 'default'" },
      { kind: "videoinput", label: "FaceTime HD Camera (Built-in)" },
      { kind: "audiooutput", label: "Default - 'default'" },
    ]);
    for (const device of managed.post.devices) {
      expect(device.deviceId).toMatch(/^[A-Za-z0-9+/=]{44}$/);
      expect(device.groupId).toMatch(/^[A-Za-z0-9+/=]{44}$/);
    }
    const mic = managed.post.devices.find((device) => device.kind === "audioinput");
    const cam = managed.post.devices.find((device) => device.kind === "videoinput");
    const speaker = managed.post.devices.find((device) => device.kind === "audiooutput");
    expect(mic.groupId).toBe(speaker.groupId);
    expect(cam.groupId).not.toBe(mic.groupId);
    const restart = corpus.evidence.crossOrigin.sameOriginRestart.post.devices;
    expect(restart.map((device) => device.deviceId)).toEqual(managed.post.devices.map((device) => device.deviceId));
    const otherOrigin = corpus.evidence.crossOrigin.otherOrigin.post.devices;
    expect(shapeOf(otherOrigin)).toEqual(shapeOf(managed.post.devices));
    expect(otherOrigin.map((device) => device.deviceId)).not.toEqual(managed.post.devices.map((device) => device.deviceId));
    // Multi-persona roster follows the configured counts with numbered labels.
    expect(shapeOf(corpus.evidence.multi.post.devices)).toEqual([
      { kind: "audioinput", label: "Default - 'default'" },
      { kind: "audioinput", label: "Microphone (2)" },
      { kind: "videoinput", label: "FaceTime HD Camera (Built-in)" },
      { kind: "videoinput", label: "Camera (2)" },
      { kind: "audiooutput", label: "Default - 'default'" },
      { kind: "audiooutput", label: "Speaker (2)" },
    ]);
    // Pre-permission the multi-persona roster is capped at one device per
    // kind with every field empty, exactly like stock FilterExposedDevices.
    expect(corpus.evidence.multi.pre.devices.map((device) => device.kind)).toEqual(["audioinput", "videoinput"]);
    for (const device of corpus.evidence.multi.pre.devices) {
      expect(device).toMatchObject({ label: "", deviceId: "", groupId: "" });
    }
    // Zero-count persona: audio is dropped pre- and post-permission, the
    // configured camera still appears after the grant.
    expect(corpus.evidence.zero.pre.devices.map((device) => device.kind)).toEqual(["videoinput"]);
    expect(shapeOf(corpus.evidence.zero.post.devices)).toEqual([
      { kind: "videoinput", label: "FaceTime HD Camera (Built-in)" },
    ]);
    // Decomposed Permissions-Policy: a camera-denied iframe keeps only the
    // microphone (no speaker — the iframe holds no capture of its own); a
    // speaker-denied iframe keeps mic+camera. Fields stay empty.
    expect(corpus.evidence.managed.iframeNoCameraPost.devices.map((device) => device.kind)).toEqual(["audioinput"]);
    expect(corpus.evidence.managed.iframeNoSpeakerPost.devices.map((device) => device.kind)).toEqual(["audioinput", "videoinput"]);
    for (const device of [...corpus.evidence.managed.iframeNoCameraPost.devices, ...corpus.evidence.managed.iframeNoSpeakerPost.devices]) {
      expect(device).toMatchObject({ label: "", deviceId: "", groupId: "" });
    }
    // Legacy enumeration mode: anonymized ids are exposed, label visibility
    // mirrors the stock per-kind map, and persona ids never alias stock ids.
    const legacy = corpus.evidence.legacy;
    for (const device of legacy.noGrant.pre.devices) {
      expect(device.deviceId).toMatch(/^[A-Za-z0-9+/=]{44}$/);
    }
    const legacyStockVisible = new Map(
      legacy.noGrantStock.pre.devices.map((device) => [device.kind, device.label !== ""]),
    );
    for (const device of legacy.noGrant.pre.devices) {
      expect(device.label !== "").toBe(legacyStockVisible.get(device.kind) ?? false);
    }
    expect(legacy.noGrantStock.pre.devices.some((device) => device.kind === "audiooutput")).toBe(false);
    expect(legacy.grant.post.devices.map((device) => device.kind)).toEqual(["audioinput", "videoinput", "audiooutput"]);
    const legacyGrantStockVisible = new Map(
      legacy.grantStock.post.devices.map((device) => [device.kind, device.label !== ""]),
    );
    for (const device of legacy.grant.post.devices) {
      expect(device.label !== "").toBe(legacyGrantStockVisible.get(device.kind) ?? false);
      expect(device.deviceId).toMatch(/^[A-Za-z0-9+/=]{44}$/);
    }
    expect(legacy.grant.post.devices.map((device) => device.deviceId)).not.toEqual(
      legacy.grantStock.post.devices.map((device) => device.deviceId),
    );
    // media.setsinkid.enabled=false removes speakers from both rosters.
    expect(corpus.evidence.noSinkid.managed.post.devices.map((device) => device.kind)).toEqual(["audioinput", "videoinput"]);
    expect(corpus.evidence.noSinkid.stock.post.devices.some((device) => device.kind === "audiooutput")).toBe(false);
    // RFP windows resolve the stock RFP roster: kind+label shape is identical
    // to stock and persona labels never leak.
    const rfpShape = (devices) => devices.map((device) => ({ kind: device.kind, label: device.label }));
    expect(rfpShape(corpus.evidence.rfp.managed.pre.devices)).toEqual(rfpShape(corpus.evidence.rfp.stock.pre.devices));
    expect(rfpShape(corpus.evidence.rfp.managed.post.devices)).toEqual(rfpShape(corpus.evidence.rfp.stock.post.devices));
    for (const device of corpus.evidence.rfp.managed.post.devices) {
      expect(device.label).not.toBe("Default - 'default'");
      expect(device.label).not.toBe("FaceTime HD Camera (Built-in)");
    }
    // Disabled config and managed rosters must not alias the physical host roster.
    expect(shapeOf(corpus.evidence.disabled.post.devices)).toEqual(shapeOf(corpus.evidence.stock.post.devices));
    expect(shapeOf(managed.post.devices)).not.toEqual(shapeOf(corpus.evidence.stock.post.devices));
    // Workers never gain MediaDevices; enumerate stays a native MediaDevices method.
    expect(managed.dedicatedWorker).toMatchObject({ mediaDevices: "undefined" });
    expect(managed.sharedWorker).toMatchObject({ mediaDevices: "undefined" });
    for (const snapshot of [managed.pre, managed.post]) {
      expect(snapshot.nativeEnumerate).toMatchObject({
        writable: true,
        enumerable: true,
        configurable: true,
        owner: "MediaDevices",
      });
      expect(snapshot.nativeEnumerate.source).toContain("[native code]");
    }
  });

  it("pins a real native Audio verifier and readback-only runtime corpus", () => {
    execFileSync(process.execPath, ["--check", VERIFY_AUDIO], { stdio: "pipe" });
    const verifier = fs.readFileSync(VERIFY_AUDIO, "utf8");
    const corpus = JSON.parse(fs.readFileSync(AUDIO_CORPUS, "utf8"));
    expect(verifier).toContain("--agent-browser-native-required");
    expect(verifier).toContain("Invalid Audio config did not fail closed");
    expect(verifier).toContain("Same Audio seed changed across restarts");
    expect(verifier).toContain("Audio seeds/stock were not distinct");
    expect(verifier).toContain("mutated the copyToChannel source");
    expect(verifier).toContain("Audio corpus readback/search validation failed");
    expect(verifier).not.toContain("bidiAddPreloadScript");
    expect(corpus.capture).toMatchObject({
      mode: "webdriver-bidi-headless-native-audio",
      preloadScript: false,
      nativeRequired: true,
    });
    expect(corpus.capabilities.capabilities).toEqual([
      "config-v1",
      "native-required-v1",
      "snapshot-v1",
      "navigator-v1",
      "screen-v1",
      "canvas-v1",
      "webgl-v1",
      "webgpu-v1",
      "audio-v1",
      "geolocation-v1",
      "storage-quota-v1",
      "media-devices-v1",
      "speech-voices-v1",
    ]);
    for (const realm of ["window", "iframe"]) {
      const buffer = corpus.surfaces[realm].buffer;
      const analyser = corpus.surfaces[realm].analyser;
      expect(buffer).toMatchObject({
        sameViewObject: true,
        repeatedStable: true,
        renderedMatchesSource: true,
        detachedAfterGraphAcquire: true,
        pageWriteVisibleToCopy: true,
        pageWritePreservedByGraph: true,
        copyToUpdatesLiveView: true,
        copyToMatchesCopyFrom: true,
      });
      expect(buffer.changedSamples).toBeGreaterThanOrEqual(256);
      expect(buffer.maxDelta).toBeGreaterThanOrEqual(corpus.capture.fingerprintConfig.audio.amplitude * 0.5);
      expect(buffer.maxDelta).toBeLessThanOrEqual(corpus.capture.fingerprintConfig.audio.amplitude * 1.25);
      expect(analyser.stable).toEqual({
        floatFrequency: true,
        byteFrequency: true,
        floatTime: true,
        byteTime: true,
      });
      for (const evidence of [...Object.values(buffer.nativeMethods), ...Object.values(analyser.nativeMethods)] as Array<Record<string, unknown>>) {
        expect(evidence).toMatchObject({
          writable: true,
          enumerable: true,
          configurable: true,
        });
        expect(evidence.source).toContain("[native code]");
      }
      for (const field of Object.keys(corpus.hashes.managed[realm])) {
        const values = [
          corpus.hashes.managed[realm][field],
          corpus.hashes.differentSeed[realm][field],
          corpus.hashes.stock[realm][field],
        ];
        expect(values.every((value) => /^[0-9a-f]{8}$/.test(value))).toBe(true);
        expect(new Set(values).size).toBe(3);
      }
    }
    const workerShape = {
      audioContext: "undefined",
      offlineAudioContext: "undefined",
      audioBuffer: "undefined",
      analyserNode: "undefined",
    };
    expect(corpus.surfaces.dedicatedWorker).toMatchObject({ supported: true, value: workerShape });
    expect(corpus.surfaces.sharedWorker).toMatchObject({ supported: true, value: workerShape });
  });

  it("pins a real headed GPU verifier and identity-only runtime corpus", () => {
    execFileSync(process.execPath, ["--check", VERIFY_GPU], { stdio: "pipe" });
    const verifier = fs.readFileSync(VERIFY_GPU, "utf8");
    const corpus = JSON.parse(fs.readFileSync(GPU_CORPUS, "utf8"));
    expect(verifier).toContain("--agent-browser-native-required");
    expect(verifier).toContain('process.argv.includes("--headed")');
    expect(verifier).toContain("Invalid GPU config did not fail closed");
    expect(verifier).toContain("Same GPU config changed across restarts");
    expect(verifier).toContain("Different GPU personas were identical");
    expect(verifier).toContain("changed WebGL extensions/limits");
    expect(verifier).toContain("changed WebGPU features/limits/WGSL");
    expect(verifier).toContain("GPU corpus readback/search validation failed");
    expect(verifier).not.toContain("bidiAddPreloadScript");
    expect(corpus.capture).toMatchObject({
      mode: "webdriver-bidi-headed-native-gpu",
      preloadScript: false,
      nativeRequired: true,
    });
    expect(corpus.capabilities.capabilities).toEqual([
      "config-v1",
      "native-required-v1",
      "snapshot-v1",
      "navigator-v1",
      "screen-v1",
      "canvas-v1",
      "webgl-v1",
      "webgpu-v1",
      "audio-v1",
      "geolocation-v1",
      "storage-quota-v1",
      "media-devices-v1",
      "speech-voices-v1",
    ]);
    expect(corpus.identities.managed).toMatchObject({
      webgl: {
        maskedVendor: "Mozilla",
        maskedRenderer: corpus.capture.fingerprintConfig.webgl.renderer,
        unmaskedVendor: corpus.capture.fingerprintConfig.webgl.vendor,
        unmaskedRenderer: corpus.capture.fingerprintConfig.webgl.renderer,
      },
      webgpu: {
        vendor: corpus.capture.fingerprintConfig.webgpu.vendor,
        architecture: corpus.capture.fingerprintConfig.webgpu.architecture,
        device: corpus.capture.fingerprintConfig.webgpu.device,
        description: corpus.capture.fingerprintConfig.webgpu.description,
      },
    });
    expect(corpus.identities.managed).not.toEqual(corpus.identities.differentWindows);
    expect(corpus.identities.stock.webgpu).toEqual({
      vendor: "",
      architecture: "",
      device: "",
      description: "",
    });
    const stockWebgpu = corpus.capabilityShape.webgpu.window;
    expect(stockWebgpu).toMatchObject({
      subgroupMinSize: 4,
      subgroupMaxSize: 128,
      isFallbackAdapter: false,
    });
    expect(corpus.capture.fingerprintConfig.webgpu).toMatchObject({
      subgroupMinSize: 32,
      subgroupMaxSize: 32,
    });
    expect(stockWebgpu.features.length).toBeGreaterThan(0);
    expect(Object.keys(stockWebgpu.limits).length).toBeGreaterThan(20);
    expect(corpus.capabilityShape.webgl["window.html"].webgl2.extensions.length).toBeGreaterThan(0);
    for (const worker of [corpus.surfaces.dedicatedWorker, corpus.surfaces.sharedWorker]) {
      expect(worker).toMatchObject({
        supported: true,
        value: {
          webgl: { webgl: { supported: true }, webgl2: { supported: true } },
          webgpu: { supported: true, adapter: true },
        },
      });
    }
  });

  it("pins a real native Canvas verifier and deterministic runtime corpus", () => {
    execFileSync(process.execPath, ["--check", VERIFY_CANVAS], { stdio: "pipe" });
    const verifier = fs.readFileSync(VERIFY_CANVAS, "utf8");
    const corpus = JSON.parse(fs.readFileSync(CANVAS_CORPUS, "utf8"));
    expect(verifier).toContain("--agent-browser-native-required");
    expect(verifier).toContain("Invalid Canvas config did not fail closed");
    expect(verifier).toContain("Same Canvas seed changed across restarts");
    expect(verifier).toContain("Managed Canvas did not differ from stock");
    expect(verifier).toContain("Different Canvas seeds were identical");
    expect(verifier).toContain("Canvas corpus readback/search validation failed");
    expect(verifier).toContain("getImageData");
    expect(verifier).toContain("toDataURL");
    expect(verifier).toContain("toBlob");
    expect(verifier).toContain("convertToBlob");
    expect(verifier).toContain("gl.readPixels");
    expect(verifier).toContain("gl.FLOAT");
    expect(verifier).toContain("dedicatedWorker");
    expect(verifier).toContain("sharedWorker");
    expect(verifier).not.toContain("bidiAddPreloadScript");
    expect(corpus.capture).toMatchObject({
      mode: "webdriver-bidi-headless-native-canvas",
      preloadScript: false,
      nativeRequired: true,
    });
    expect(corpus.capabilities.capabilities).toEqual([
      "config-v1",
      "native-required-v1",
      "snapshot-v1",
      "navigator-v1",
      "screen-v1",
      "canvas-v1",
      "webgl-v1",
      "webgpu-v1",
      "audio-v1",
      "geolocation-v1",
      "storage-quota-v1",
      "media-devices-v1",
      "speech-voices-v1",
    ]);
    for (const field of Object.keys(corpus.hashes.managed)) {
      expect(corpus.hashes.managed[field]).toMatch(/^[0-9a-f]{8}$/);
      expect(corpus.hashes.managed[field]).not.toBe(corpus.hashes.differentSeed[field]);
      expect(corpus.hashes.managed[field]).not.toBe(corpus.hashes.stock[field]);
    }
    for (const realm of [corpus.surfaces.window, corpus.surfaces.iframe]) {
      for (const surface of [realm.canvas2d, realm.offscreen2d]) {
        expect(surface).toMatchObject({
          pixelsStable: true,
          pixelsReplayStable: true,
          blobStable: true,
          blobReplayStable: true,
        });
      }
      for (const surface of [realm.webgl, realm.offscreenWebgl]) {
        expect(surface).toMatchObject({
          supported: true,
          pixelsStable: true,
          blobStable: true,
          floatReadPixels: { supported: true, stable: true },
        });
      }
    }
    for (const worker of [corpus.surfaces.dedicatedWorker, corpus.surfaces.sharedWorker]) {
      expect(worker).toMatchObject({
        supported: true,
        value: {
          canvas2d: {
            pixelsStable: true,
            pixelsReplayStable: true,
            blobStable: true,
            blobReplayStable: true,
          },
          webgl: {
            supported: true,
            pixelsStable: true,
            blobStable: true,
            floatReadPixels: { supported: true, stable: true },
          },
        },
      });
    }
  });

  it("pins a native Gate A verifier with write/readback/search validation", () => {
    execFileSync(process.execPath, ["--check", VERIFY_GATE_A], { stdio: "pipe" });
    const verifier = fs.readFileSync(VERIFY_GATE_A, "utf8");
    const corpus = JSON.parse(fs.readFileSync(GATE_A_CORPUS, "utf8"));
    expect(verifier).toContain("--agent-browser-native-required");
    expect(verifier).toContain('process.argv.indexOf("--persona")');
    expect(verifier).toContain('"windows", "macos", "android"');
    expect(verifier).toContain("navigator-v1");
    expect(verifier).toContain("screen-v1");
    expect(verifier).toContain("dedicatedWorker");
    expect(verifier).toContain("sharedWorker");
    expect(verifier).toContain('hasWebdriver: "webdriver" in navigator');
    expect(verifier).toContain("Invalid native config did not fail closed");
    expect(verifier).toContain("Gate A corpus readback/search validation failed");
    expect(verifier).toContain('"preloadScript": false');
    expect(verifier).not.toContain("bidiAddPreloadScript");
    expect(corpus.capture).toMatchObject({
      mode: "webdriver-bidi-headless-native",
      persona: "windows",
      preloadScript: false,
      nativeRequired: true,
    });
    expect(corpus.capture.fingerprintConfig.userAgent).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0",
    );
    expect(corpus.capabilities.capabilities).toEqual([
      "config-v1",
      "native-required-v1",
      "snapshot-v1",
      "navigator-v1",
      "screen-v1",
      "canvas-v1",
      "webgl-v1",
      "webgpu-v1",
      "audio-v1",
      "geolocation-v1",
      "storage-quota-v1",
      "media-devices-v1",
      "speech-voices-v1",
    ]);
    expect(corpus.surfaces.window.navigator).toMatchObject({
      platform: "Win32",
      oscpu: "Windows NT 10.0; Win64; x64",
      appVersion: "5.0 (Windows)",
      hardwareConcurrency: 12,
      webdriver: false,
    });
    expect(corpus.surfaces.window.navigator.getters.webdriver).toContain("[native code]");
    expect(corpus.surfaces.window.screen).toMatchObject({
      width: 1920,
      height: 1080,
      outerWidth: 1280,
      outerHeight: 800,
      innerWidth: 1280,
      innerHeight: 800,
      screenX: 32,
      screenY: 32,
    });
    expect(corpus.surfaces.iframe.screen).toMatchObject({ innerWidth: 300, innerHeight: 150 });
    for (const worker of [corpus.surfaces.dedicatedWorker, corpus.surfaces.sharedWorker]) {
      expect(worker.supported).toBe(true);
      expect(worker.value.navigator).toMatchObject({
        platform: "Win32",
        appVersion: "5.0 (Windows)",
        hardwareConcurrency: 12,
        hasMaxTouchPoints: false,
        hasOscpu: false,
        hasWebdriver: false,
      });
    }
  });

  it("pins a reproducible no-config Window and Worker stock corpus", () => {
    execFileSync(process.execPath, ["--check", CAPTURE_STOCK], { stdio: "pipe" });
    const capture = fs.readFileSync(CAPTURE_STOCK, "utf8");
    const corpus = JSON.parse(fs.readFileSync(STOCK_CORPUS, "utf8"));
    expect(capture).toContain("Refusing to overwrite existing corpus without --force");
    expect(capture).toContain("Corpus readback validation failed");
    expect(corpus.browser).toMatchObject({
      engine: "firefox",
      version: "154.0",
      sourceStamp: SOURCE_STAMP,
      platform: "macos-arm64",
      branding: "unofficial",
    });
    expect(corpus.capture).toMatchObject({
      mode: "webdriver-bidi-headless",
      fingerprintConfig: null,
      preloadScript: false,
    });
    expect(corpus.surfaces.dedicatedWorker.supported).toBe(true);
    expect(corpus.surfaces.sharedWorker.supported).toBe(true);
    const canvasHash = corpus.surfaces.window.canvas2d.hash;
    expect(canvasHash).toMatch(/^[0-9a-f]{8}$/);
    expect(corpus.surfaces.window.offscreenCanvas2d.hash).toBe(canvasHash);
    expect(corpus.surfaces.iframe.canvas2d.hash).toBe(canvasHash);
    expect(corpus.surfaces.dedicatedWorker.value.offscreenCanvas2d.hash).toBe(canvasHash);
    expect(corpus.surfaces.sharedWorker.value.offscreenCanvas2d.hash).toBe(canvasHash);
    expect(corpus.surfaces.window.navigator.getters.platform).toContain("[native code]");
    expect(corpus.surfaces.dedicatedWorker.value.navigator.getters.platform).toContain("[native code]");
    expect(corpus.surfaces.sharedWorker.value.navigator.getters.platform).toContain("[native code]");
    expect(corpus.surfaces.window.webgl.extensions).toEqual(
      corpus.surfaces.dedicatedWorker.value.offscreenWebgl.extensions,
    );
  });

  it("builds incrementally with full Xcode and a canonical mozconfig", () => {
    const build = fs.readFileSync(BUILD, "utf8");
    const mozconfig = fs.readFileSync(path.join(FIREFOX, "mozconfig.macos-arm64"), "utf8");
    expect(build).toContain("DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer");
    expect(build).toContain('MOZCONFIG="$PATCH_ROOT/mozconfig.macos-arm64" ./mach build');
    expect(build).toContain("FIREFOX_BUILD_MIN_FREE_GIB:-70");
    expect(build).toContain("codesign --verify --deep --strict");
    expect(build).toContain("hdiutil attach -readonly -nobrowse");
    expect(build).toContain('ditto "$packaged_app"');
    expect(build).toContain('xattr -cr "$app"');
    expect(build).toContain("agent-browser-packaged-app");
    expect(build).toContain('awk -F= \'$1 == "SourceStamp"');
    expect(build).toContain("Mach-O 64-bit executable arm64");
    expect(build.indexOf("./mach package")).toBeLessThan(build.indexOf("codesign --force --deep"));
    expect(mozconfig).toContain("MOZ_OBJDIR=@TOPSRCDIR@/obj-agent-browser-arm64");
    expect(mozconfig).toContain("MOZ_MAKE_FLAGS=\"-j4\"");
    expect(mozconfig).not.toContain("--target=aarch64-apple-darwin");
    expect(mozconfig).toContain("versionless --target is misdetected as cross-compilation");
    expect(mozconfig).not.toContain("--enable-bootstrap");
    expect(build).toContain("FIREFOX_LLVM_PREFIX");
    expect(build).toContain("FIREFOX_LLD_PREFIX");
    expect(build).toContain("brew --prefix llvm@21");
    expect(build).toContain("brew --prefix lld@21");
    expect(build).toContain("FIREFOX_WASI_SYSROOT");
    expect(build).toContain("brew --prefix wasi-libc");
    expect(build).toContain("brew --prefix wasi-runtimes");
    expect(build).toContain("wasi-sysroot-clang21.1.8-libc33-runtimes23.1.0");
    expect(build).toContain("refusing to reuse an unrecognized WASI sysroot");
    expect(build).toContain("--target=wasm32-wasip1 --sysroot=\"$WASI_SYSROOT\"");
    expect(build).toContain("WASI C/C++ link probe failed");
    expect(build).toContain("brew install wasi-libc wasi-runtimes");
    expect(build).toContain('export CC="$LLVM_PREFIX/bin/clang"');
    expect(build).toContain("clang version 21.1.8");
    expect(build).toContain("-fuse-ld=lld -Wl,--version");
    expect(build).toContain("Homebrew LLD 21.1.8");
    expect(build).toContain("FIREFOX_RUST_TOOLCHAIN:-1.94.1-aarch64-apple-darwin");
    expect(build).toContain("rustc 1.94.1 (e408947bf 2026-03-25)");
    expect(build).not.toContain("DYLD_LIBRARY_PATH");
    expect(build).toContain("Rust 1.94.1 rust-objcopy is not executable");
    expect(build).toContain('cbindgen --version)" != "cbindgen 0.29.4"');
    expect(build).toContain("cargo install cbindgen --version 0.29.4 --locked");
    expect(mozconfig).toContain("browser/branding/unofficial");
    expect(mozconfig).not.toContain("branding/official");
  });
});
