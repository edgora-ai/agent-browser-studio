#!/usr/bin/env node
// Verify Firefox 154 native deterministic WebAudio readback noise.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_VERSION = "154.0";
const EXPECTED_SOURCE_STAMP = "9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc";
const REQUIRED_CAPABILITIES = [
  "config-v1", "native-required-v1", "snapshot-v1", "navigator-v1",
  "screen-v1", "canvas-v1", "webgl-v1", "webgpu-v1", "audio-v1",
];
const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultOutput = path.join(repoRoot, "patches", "firefox", "corpora-154", "audio-firefox-154.0.json");
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] || "") : defaultOutput;
const force = process.argv.includes("--force");
const binary = process.env.AGENT_BROWSER_FIREFOX_BINARY_PATH;

if (!binary || !path.isAbsolute(binary) || !fs.existsSync(binary)) {
  throw new Error("AGENT_BROWSER_FIREFOX_BINARY_PATH must point to the built Firefox executable");
}
if (!outputPath || outputPath === path.parse(outputPath).root) {
  throw new Error("--output must name a JSON file");
}
if (fs.existsSync(outputPath) && !force) {
  throw new Error(`Refusing to overwrite existing corpus without --force: ${outputPath}`);
}

const versionOutput = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
const capabilities = JSON.parse(execFileSync(binary, ["--agent-browser-capabilities"], { encoding: "utf8" }));
if (!versionOutput.includes(EXPECTED_VERSION) ||
    capabilities.product !== "agent-browser-firefox" ||
    capabilities.browserVersion !== EXPECTED_VERSION ||
    capabilities.sourceStamp !== EXPECTED_SOURCE_STAMP ||
    !REQUIRED_CAPABILITIES.every((capability) => capabilities.capabilities?.includes(capability))) {
  throw new Error(`Unexpected Firefox build/capabilities: ${JSON.stringify({ versionOutput, capabilities })}`);
}
const applicationIni = fs.readFileSync(
  path.resolve(path.dirname(binary), "..", "..", "Contents", "Resources", "application.ini"),
  "utf8",
);
if (applicationIni.match(/^SourceStamp=(.+)$/m)?.[1]?.trim() !== EXPECTED_SOURCE_STAMP) {
  throw new Error("Firefox application.ini SourceStamp mismatch");
}

const fingerprint = await import(pathToFileURL(path.join(repoRoot, "dist", "main", "services", "firefox-fingerprint.js")).href);
const identity = fingerprint.buildFirefoxManagedIdentity({
  fingerprintSeed: 154102,
  platform: "windows",
  locale: "en-US",
  timezone: "America/New_York",
}, EXPECTED_VERSION);
const configA = identity.config;
const configB = structuredClone(configA);
configB.audio.seed = configA.audio.seed === "0000000000000000" ? "1111111111111111" : "0000000000000000";

function encodedConfig(config) {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}

const invalidCases = [
  ["missing-audio", (config) => { delete config.audio; }],
  ["non-object-audio", (config) => { config.audio = "invalid"; }],
  ["null-audio", (config) => { config.audio = null; }],
  ["array-audio", (config) => { config.audio = []; }],
  ["missing-enabled", (config) => { delete config.audio.enabled; }],
  ["non-boolean-enabled", (config) => { config.audio.enabled = 1; }],
  ["numeric-false-enabled", (config) => { config.audio.enabled = 0; }],
  ["string-enabled", (config) => { config.audio.enabled = "true"; }],
  ["null-enabled", (config) => { config.audio.enabled = null; }],
  ["missing-seed", (config) => { delete config.audio.seed; }],
  ["non-string-seed", (config) => { config.audio.seed = null; }],
  ["number-seed", (config) => { config.audio.seed = 123456789; }],
  ["boolean-seed", (config) => { config.audio.seed = true; }],
  ["object-seed", (config) => { config.audio.seed = {}; }],
  ["array-seed", (config) => { config.audio.seed = []; }],
  ["empty-seed", (config) => { config.audio.seed = ""; }],
  ["short-seed", (config) => { config.audio.seed = "0123456789abcde"; }],
  ["long-seed", (config) => { config.audio.seed = "0123456789abcdef0"; }],
  ["trailing-space-seed", (config) => { config.audio.seed = "0123456789abcde "; }],
  ["leading-space-seed", (config) => { config.audio.seed = " 0123456789abcde"; }],
  ["internal-space-seed", (config) => { config.audio.seed = "01234567 9abcdef"; }],
  ["prefixed-seed", (config) => { config.audio.seed = "0x123456789abcde"; }],
  ["uppercase-seed", (config) => { config.audio.seed = "0123456789ABCDEF"; }],
  ["non-hex-seed", (config) => { config.audio.seed = "0123456789abcdeg"; }],
  ["missing-amplitude", (config) => { delete config.audio.amplitude; }],
  ["non-number-amplitude", (config) => { config.audio.amplitude = "0.0000001"; }],
  ["null-amplitude", (config) => { config.audio.amplitude = null; }],
  ["boolean-amplitude", (config) => { config.audio.amplitude = true; }],
  ["object-amplitude", (config) => { config.audio.amplitude = {}; }],
  ["array-amplitude", (config) => { config.audio.amplitude = []; }],
  ["nan-amplitude", (config) => { config.audio.amplitude = Number.NaN; }],
  ["infinite-amplitude", (config) => { config.audio.amplitude = Number.POSITIVE_INFINITY; }],
  ["negative-infinite-amplitude", (config) => { config.audio.amplitude = Number.NEGATIVE_INFINITY; }],
  ["negative-amplitude", (config) => { config.audio.amplitude = -0.0000001; }],
  ["zero-amplitude", (config) => { config.audio.amplitude = 0; }],
  ["tiny-amplitude", (config) => { config.audio.amplitude = 1e-13; }],
  ["oversized-amplitude", (config) => { config.audio.amplitude = 0.01; }],
];
for (const [label, mutate] of invalidCases) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-firefox-audio154-invalid-${label}-`));
  try {
    const config = structuredClone(configA);
    mutate(config);
    fs.writeFileSync(
      path.join(profileDir, "user.js"),
      `user_pref("agent.browser.fingerprint.config", ${JSON.stringify(encodedConfig(config))});\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const launch = spawnSync(binary, [
      "-profile", profileDir,
      "--headless",
      "--agent-browser-native-required",
      "--no-remote",
    ], { encoding: "utf8", timeout: 15000 });
    const stderr = String(launch.stderr);
    if (launch.status === 0 ||
        !stderr.includes("AGENT_BROWSER_NATIVE_CONFIG_ERROR: invalid-field:audio")) {
      throw new Error(`Invalid Audio config did not fail closed (${label}): ${JSON.stringify({
        status: launch.status,
        signal: launch.signal,
        stderr: stderr.slice(-2000),
      })}`);
    }
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}
console.log(`Invalid Audio configs rejected: ${invalidCases.length}/${invalidCases.length}`);

const bidi = await import(pathToFileURL(path.join(repoRoot, "dist", "main", "services", "bidi-client.js")).href);
const {
  connectBidi,
  bidiCreateContext,
  bidiCloseContext,
  bidiEvaluateInContext,
  bidiNavigate,
} = bidi;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const expression = String.raw`(async function () {
  function hashBytes(bytes) {
    var hash = 2166136261;
    for (var i = 0; i < bytes.length; i++) {
      hash ^= bytes[i] & 255;
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  function hashFloats(array) {
    return hashBytes(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }
  function equalFloats(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  function methodEvidence(object, name) {
    var proto = object;
    while (proto) {
      var descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor && typeof descriptor.value === "function") {
        return {
          source: Function.prototype.toString.call(descriptor.value),
          name: descriptor.value.name,
          length: descriptor.value.length,
          writable: descriptor.writable,
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
          owner: proto.constructor && proto.constructor.name,
        };
      }
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }
  function makeSignal(length) {
    var signal = new Float32Array(length);
    for (var i = 0; i < length; i++) {
      signal[i] = Math.fround(Math.sin(i * 0.071) * 0.55 + Math.cos(i * 0.019) * 0.2);
    }
    return signal;
  }
  async function bufferProbe(scope) {
    var length = 512;
    var sampleRate = 48000;
    var original = makeSignal(length);
    var buffer = new scope.AudioBuffer({numberOfChannels:1,length:length,sampleRate:sampleRate});
    buffer.copyToChannel(original, 0);
    var view1 = buffer.getChannelData(0);
    var view2 = buffer.getChannelData(0);
    var snapshot = new Float32Array(view1);
    var copied = new Float32Array(length);
    buffer.copyFromChannel(copied, 0);
    var changed = 0;
    var maxDelta = 0;
    for (var i = 0; i < length; i++) {
      var delta = Math.abs(snapshot[i] - original[i]);
      if (delta !== 0) changed++;
      if (delta > maxDelta) maxDelta = delta;
    }
    var offline = new scope.OfflineAudioContext(1, length, sampleRate);
    var source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start(0);
    var detachedAfterGraphAcquire = view1.length === 0;
    var rendered = await offline.startRendering();
    var renderedView = rendered.getChannelData(0);
    var renderedSnapshot = new Float32Array(renderedView);

    var writeBuffer = new scope.AudioBuffer({numberOfChannels:1,length:length,sampleRate:sampleRate});
    writeBuffer.copyToChannel(original, 0);
    var writeView = writeBuffer.getChannelData(0);
    writeView[17] = 0.75;
    var writeCopy = new Float32Array(length);
    writeBuffer.copyFromChannel(writeCopy, 0);
    var writeOffline = new scope.OfflineAudioContext(1, length, sampleRate);
    var writeSource = writeOffline.createBufferSource();
    writeSource.buffer = writeBuffer;
    writeSource.connect(writeOffline.destination);
    writeSource.start(0);
    var writeRendered = await writeOffline.startRendering();
    var writeRenderedValue = writeRendered.getChannelData(0)[17];

    var copyUpdateBuffer = new scope.AudioBuffer({numberOfChannels:1,length:length,sampleRate:sampleRate});
    copyUpdateBuffer.copyToChannel(original, 0);
    var liveView = copyUpdateBuffer.getChannelData(0);
    var replacement = new Float32Array([0.625]);
    copyUpdateBuffer.copyToChannel(replacement, 0, 23);
    var liveCopy = new Float32Array(length);
    copyUpdateBuffer.copyFromChannel(liveCopy, 0);

    return {
      originalHash: hashFloats(original),
      viewHash: hashFloats(snapshot),
      copyHash: hashFloats(copied),
      renderedHash: hashFloats(renderedSnapshot),
      sameViewObject: view1 === view2,
      repeatedStable: equalFloats(snapshot, copied),
      renderedMatchesSource: equalFloats(snapshot, renderedSnapshot),
      detachedAfterGraphAcquire: detachedAfterGraphAcquire,
      changedSamples: changed,
      maxDelta: maxDelta,
      pageWriteVisibleToCopy: writeCopy[17] === 0.75,
      pageWritePreservedByGraph: Math.abs(writeRenderedValue - 0.75) <= 0.000001,
      copyToUpdatesLiveView: Math.abs(liveView[23] - 0.625) <= 0.000001,
      copyToMatchesCopyFrom: liveView[23] === liveCopy[23],
      nativeMethods: {
        getChannelData: methodEvidence(buffer, "getChannelData"),
        copyFromChannel: methodEvidence(buffer, "copyFromChannel"),
        copyToChannel: methodEvidence(buffer, "copyToChannel"),
        startRendering: methodEvidence(offline, "startRendering"),
      },
    };
  }
  async function analyserProbe(scope) {
    var offline = new scope.OfflineAudioContext(1, 4096, 48000);
    var oscillator = offline.createOscillator();
    oscillator.type = "triangle";
    oscillator.frequency.value = 997;
    var analyser = offline.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    oscillator.connect(analyser);
    analyser.connect(offline.destination);
    oscillator.start(0);
    oscillator.stop(4096 / 48000);
    var rendered = await offline.startRendering();
    var floatFrequency1 = new Float32Array(analyser.frequencyBinCount);
    var floatFrequency2 = new Float32Array(analyser.frequencyBinCount);
    var byteFrequency1 = new Uint8Array(analyser.frequencyBinCount);
    var byteFrequency2 = new Uint8Array(analyser.frequencyBinCount);
    var floatTime1 = new Float32Array(analyser.fftSize);
    var floatTime2 = new Float32Array(analyser.fftSize);
    var byteTime1 = new Uint8Array(analyser.fftSize);
    var byteTime2 = new Uint8Array(analyser.fftSize);
    analyser.getFloatFrequencyData(floatFrequency1);
    analyser.getFloatFrequencyData(floatFrequency2);
    analyser.getByteFrequencyData(byteFrequency1);
    analyser.getByteFrequencyData(byteFrequency2);
    analyser.getFloatTimeDomainData(floatTime1);
    analyser.getFloatTimeDomainData(floatTime2);
    analyser.getByteTimeDomainData(byteTime1);
    analyser.getByteTimeDomainData(byteTime2);
    return {
      renderedHash: hashFloats(new Float32Array(rendered.getChannelData(0))),
      floatFrequencyHash: hashFloats(floatFrequency1),
      byteFrequencyHash: hashBytes(byteFrequency1),
      floatTimeHash: hashFloats(floatTime1),
      byteTimeHash: hashBytes(byteTime1),
      stable: {
        floatFrequency: equalFloats(floatFrequency1, floatFrequency2),
        byteFrequency: hashBytes(byteFrequency1) === hashBytes(byteFrequency2),
        floatTime: equalFloats(floatTime1, floatTime2),
        byteTime: hashBytes(byteTime1) === hashBytes(byteTime2),
      },
      nativeMethods: {
        getFloatFrequencyData: methodEvidence(analyser, "getFloatFrequencyData"),
        getByteFrequencyData: methodEvidence(analyser, "getByteFrequencyData"),
        getFloatTimeDomainData: methodEvidence(analyser, "getFloatTimeDomainData"),
        getByteTimeDomainData: methodEvidence(analyser, "getByteTimeDomainData"),
      },
    };
  }
  function workerMain(shared) {
    var value = {
      audioContext: typeof AudioContext,
      offlineAudioContext: typeof OfflineAudioContext,
      audioBuffer: typeof AudioBuffer,
      analyserNode: typeof AnalyserNode,
    };
    if (shared) {
      self.onconnect = function(event){event.ports[0].postMessage(value);event.ports[0].close();};
    } else {
      self.postMessage(value);
      self.close();
    }
  }
  function workerResult(shared) {
    return new Promise(function(resolve) {
      var source = "(" + workerMain.toString() + ")(" + (shared ? "true" : "false") + ");";
      var url = URL.createObjectURL(new Blob([source], {type:"text/javascript"}));
      var timer = setTimeout(function(){URL.revokeObjectURL(url);resolve({supported:false,error:"timeout"});},15000);
      if (shared) {
        var worker = new SharedWorker(url);
        worker.port.onmessage = function(event){clearTimeout(timer);worker.port.close();URL.revokeObjectURL(url);resolve({supported:true,value:event.data});};
        worker.port.start();
      } else {
        var worker = new Worker(url);
        worker.onmessage = function(event){clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);resolve({supported:true,value:event.data});};
      }
    });
  }

  var frame = document.createElement("iframe");
  frame.src = "about:blank";
  var loaded = new Promise(function(resolve){frame.onload=resolve;setTimeout(resolve,2000);});
  document.body.appendChild(frame);
  await loaded;
  var result = {
    window: {
      buffer: await bufferProbe(window),
      analyser: await analyserProbe(window),
    },
    iframe: {
      buffer: await bufferProbe(frame.contentWindow),
      analyser: await analyserProbe(frame.contentWindow),
    },
    dedicatedWorker: await workerResult(false),
    sharedWorker: await workerResult(true),
  };
  frame.remove();
  return result;
})()`;

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><meta charset=utf-8><title>Firefox 154 Audio Gate</title><body></body>");
});
const pagePort = await listen(server);

async function captureWorld(name, config) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-firefox-audio154-${name}-`));
  const port = await freePort();
  let stderr = "";
  let child;
  let connection;
  let context;
  try {
    if (config) {
      const prefs = {
        ...identity.nativePrefs,
        "agent.browser.fingerprint.config": encodedConfig(config),
      };
      const userJs = Object.entries(prefs)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([pref, value]) => `user_pref(${JSON.stringify(pref)}, ${JSON.stringify(value)});`)
        .join("\n");
      fs.writeFileSync(path.join(profileDir, "user.js"), `${userJs}\n`, { encoding: "utf8", mode: 0o600 });
    }
    child = spawn(binary, [
      "-profile", profileDir,
      `--remote-debugging-port=${port}`,
      "--headless",
      ...(config ? ["--agent-browser-native-required"] : []),
      "--no-remote",
    ], { env: { ...process.env, TZ: config?.timezone || process.env.TZ }, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (data) => { stderr += String(data); });
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error(`${name} exited early (${child.exitCode}): ${stderr.slice(-2000)}`);
      try {
        connection = await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: 2000 });
        break;
      } catch (error) {
        await sleep(250);
      }
    }
    if (!connection) throw new Error(`${name} did not expose BiDi: ${stderr.slice(-2000)}`);
    context = await bidiCreateContext(connection, 15000);
    await bidiNavigate(connection, `http://127.0.0.1:${pagePort}/`, context, 15000);
    return await bidiEvaluateInContext(connection, expression, context, 180000);
  } finally {
    if (context && connection) {
      try { await bidiCloseContext(connection, context, 8000); } catch (error) { console.error(String(error)); }
    }
    if (connection) connection.close();
    if (child) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        sleep(10000).then(() => { if (child.exitCode === null) child.kill("SIGKILL"); }),
      ]);
    }
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

function allNative(record, expected) {
  return record && Object.entries(record).every(([name, evidence]) => {
    const contract = expected[name];
    return contract && evidence && evidence.source?.includes("[native code]") &&
      evidence.name === name && evidence.length === contract.length &&
      evidence.owner === contract.owner && evidence.writable === true &&
      evidence.enumerable === true && evidence.configurable === true;
  });
}
const BUFFER_METHODS = {
  getChannelData: { owner: "AudioBuffer", length: 1 },
  copyFromChannel: { owner: "AudioBuffer", length: 2 },
  copyToChannel: { owner: "AudioBuffer", length: 2 },
  startRendering: { owner: "OfflineAudioContext", length: 0 },
};
const ANALYSER_METHODS = {
  getFloatFrequencyData: { owner: "AnalyserNode", length: 1 },
  getByteFrequencyData: { owner: "AnalyserNode", length: 1 },
  getFloatTimeDomainData: { owner: "AnalyserNode", length: 1 },
  getByteTimeDomainData: { owner: "AnalyserNode", length: 1 },
};
function assertWorld(world, label, managed) {
  for (const realm of ["window", "iframe"]) {
    const buffer = world[realm].buffer;
    const analyser = world[realm].analyser;
    if (!buffer.sameViewObject || !buffer.repeatedStable || !buffer.renderedMatchesSource ||
        !buffer.detachedAfterGraphAcquire || !buffer.pageWriteVisibleToCopy ||
        !buffer.pageWritePreservedByGraph || !buffer.copyToUpdatesLiveView ||
        !buffer.copyToMatchesCopyFrom ||
        !allNative(buffer.nativeMethods, BUFFER_METHODS)) {
      throw new Error(`${label}.${realm}.AudioBuffer failed: ${JSON.stringify(buffer)}`);
    }
    if (!Object.values(analyser.stable).every(Boolean) ||
        !allNative(analyser.nativeMethods, ANALYSER_METHODS)) {
      throw new Error(`${label}.${realm}.AnalyserNode failed: ${JSON.stringify(analyser)}`);
    }
    if (managed) {
      if (buffer.changedSamples < 256 ||
          buffer.maxDelta < configA.audio.amplitude * 0.5 ||
          buffer.maxDelta > configA.audio.amplitude * 1.25) {
        throw new Error(`${label}.${realm}.AudioBuffer noise bound failed: ${JSON.stringify(buffer)}`);
      }
    } else if (buffer.changedSamples !== 0 || buffer.maxDelta !== 0 ||
               buffer.originalHash !== buffer.viewHash) {
      throw new Error(`${label}.${realm} stock AudioBuffer changed: ${JSON.stringify(buffer)}`);
    }
  }
  const expectedWorker = {
    audioContext: "undefined",
    offlineAudioContext: "undefined",
    audioBuffer: "undefined",
    analyserNode: "undefined",
  };
  for (const worker of [world.dedicatedWorker, world.sharedWorker]) {
    if (worker?.supported !== true || JSON.stringify(worker.value) !== JSON.stringify(expectedWorker)) {
      throw new Error(`${label} expanded Worker WebAudio exposure: ${JSON.stringify(worker)}`);
    }
  }
}
function hashes(world) {
  const out = {};
  for (const realm of ["window", "iframe"]) {
    const buffer = world[realm].buffer;
    const analyser = world[realm].analyser;
    out[realm] = {
      bufferView: buffer.viewHash,
      bufferRendered: buffer.renderedHash,
      analyserRendered: analyser.renderedHash,
      floatFrequency: analyser.floatFrequencyHash,
      byteFrequency: analyser.byteFrequencyHash,
      floatTime: analyser.floatTimeHash,
      byteTime: analyser.byteTimeHash,
    };
  }
  return out;
}

try {
  const managedA1 = await captureWorld("managed-a1", configA);
  const managedA2 = await captureWorld("managed-a2", configA);
  const managedB = await captureWorld("managed-b", configB);
  const stock = await captureWorld("stock", null);
  assertWorld(managedA1, "managedA1", true);
  assertWorld(managedA2, "managedA2", true);
  assertWorld(managedB, "managedB", true);
  assertWorld(stock, "stock", false);
  const hashesA1 = hashes(managedA1);
  const hashesA2 = hashes(managedA2);
  const hashesB = hashes(managedB);
  const hashesStock = hashes(stock);
  if (JSON.stringify(hashesA1) !== JSON.stringify(hashesA2)) {
    throw new Error(`Same Audio seed changed across restarts: ${JSON.stringify({hashesA1,hashesA2})}`);
  }
  for (const [label, worldHashes] of Object.entries({hashesA1,hashesA2,hashesB,hashesStock})) {
    if (JSON.stringify(worldHashes.iframe) !== JSON.stringify(worldHashes.window)) {
      throw new Error(`${label} Audio identity diverged across realms: ${JSON.stringify(worldHashes)}`);
    }
  }
  const cleanOriginalHash = stock.window.buffer.originalHash;
  for (const [label, world] of Object.entries({managedA1,managedA2,managedB,stock})) {
    for (const realm of ["window", "iframe"]) {
      if (world[realm].buffer.originalHash !== cleanOriginalHash) {
        throw new Error(`${label}.${realm} mutated the copyToChannel source: ${world[realm].buffer.originalHash}`);
      }
    }
  }
  for (const realm of ["window", "iframe"]) {
    for (const field of Object.keys(hashesA1[realm])) {
      const values = [hashesA1[realm][field], hashesB[realm][field], hashesStock[realm][field]];
      if (new Set(values).size !== values.length) {
        throw new Error(`Audio seeds/stock were not distinct: ${realm}.${field}=${JSON.stringify(values)}`);
      }
    }
  }

  const result = {
    schemaVersion: 1,
    browser: {
      engine: "firefox",
      version: EXPECTED_VERSION,
      sourceStamp: EXPECTED_SOURCE_STAMP,
      versionOutput,
      platform: "macos-arm64",
      branding: "unofficial",
    },
    capture: {
      mode: "webdriver-bidi-headless-native-audio",
      fingerprintConfig: configA,
      comparisonSeed: configB.audio.seed,
      preloadScript: false,
      nativeRequired: true,
    },
    capabilities,
    hashes: {managed:hashesA1,differentSeed:hashesB,stock:hashesStock},
    surfaces: managedA1,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const staging = `${outputPath}.staging-${process.pid}`;
  if (fs.existsSync(staging)) throw new Error(`Audio corpus staging path already exists: ${staging}`);
  fs.writeFileSync(staging, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  fs.renameSync(staging, outputPath);
  const text = fs.readFileSync(outputPath, "utf8");
  const readback = JSON.parse(text);
  assertWorld(readback.surfaces, "readback", true);
  const readbackHashes = hashes(readback.surfaces);
  const readbackHashGroupsValid = ["window", "iframe"].every((realm) =>
    Object.keys(readback.hashes?.managed?.[realm] || {}).every((field) =>
      new Set([
        readback.hashes.managed[realm][field],
        readback.hashes.differentSeed?.[realm]?.[field],
        readback.hashes.stock?.[realm]?.[field],
      ]).size === 3,
    ),
  );
  if (readback.browser?.sourceStamp !== EXPECTED_SOURCE_STAMP ||
      readback.capabilities?.sourceStamp !== EXPECTED_SOURCE_STAMP ||
      !readback.capabilities?.capabilities?.includes("audio-v1") ||
      readback.capture?.preloadScript !== false ||
      readback.capture?.nativeRequired !== true ||
      readback.capture?.fingerprintConfig?.audio?.enabled !== true ||
      readback.capture?.fingerprintConfig?.audio?.seed !== configA.audio.seed ||
      readback.capture?.fingerprintConfig?.audio?.amplitude !== configA.audio.amplitude ||
      readback.capture?.comparisonSeed !== configB.audio.seed ||
      !readbackHashGroupsValid ||
      JSON.stringify(readback.hashes?.managed) !== JSON.stringify(readbackHashes) ||
      readback.surfaces?.dedicatedWorker?.value?.audioContext !== "undefined" ||
      readback.surfaces?.sharedWorker?.value?.audioContext !== "undefined") {
    throw new Error("Audio corpus readback/search validation failed");
  }
  console.log(`Firefox Audio corpus written: ${outputPath}`);
  console.log(`Same seed restart: ${JSON.stringify(hashesA1) === JSON.stringify(hashesA2)}`);
  console.log(`Managed hashes: ${JSON.stringify(hashesA1)}`);
  console.log(`Different-seed hashes: ${JSON.stringify(hashesB)}`);
  console.log(`Stock hashes: ${JSON.stringify(hashesStock)}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
