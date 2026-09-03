#!/usr/bin/env node
// Verify Firefox 154 native speech-voices-v1: a caller-gated persona roster for
// window.speechSynthesis.getVoices().
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
  "geolocation-v1", "storage-quota-v1", "media-devices-v1",
  "speech-voices-v1",
];
const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultOutput = path.join(repoRoot, "patches", "firefox", "corpora-154", "speech-voices-firefox-154.0.json");
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
  fingerprintSeed: 154107,
  platform: "macos",
  locale: "en-US",
  timezone: "America/Los_Angeles",
}, EXPECTED_VERSION);
const configManaged = identity.config;
const configMulti = structuredClone(configManaged);
configMulti.speechSynthesis.voices = [
  { name: "Samantha", lang: "en-US", localService: true },
  { name: "Daniel", lang: "en-GB", localService: true },
  { name: "Melina", lang: "el-GR", localService: true },
];
const configZh = structuredClone(configManaged);
configZh.speechSynthesis.voices = [{ name: "Tingting", lang: "zh-CN", localService: true }];
const configDisabled = structuredClone(configManaged);
configDisabled.speechSynthesis.enabled = false;

function encodedConfig(config) {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}

const invalidCases = [
  ["missing-speechSynthesis", (config) => { delete config.speechSynthesis; }],
  ["non-object-speechSynthesis", (config) => { config.speechSynthesis = "invalid"; }],
  ["null-speechSynthesis", (config) => { config.speechSynthesis = null; }],
  ["array-speechSynthesis", (config) => { config.speechSynthesis = []; }],
  ["missing-enabled", (config) => { delete config.speechSynthesis.enabled; }],
  ["non-boolean-enabled", (config) => { config.speechSynthesis.enabled = 1; }],
  ["string-enabled", (config) => { config.speechSynthesis.enabled = "true"; }],
  ["null-enabled", (config) => { config.speechSynthesis.enabled = null; }],
  ["missing-voices", (config) => { delete config.speechSynthesis.voices; }],
  ["empty-voices", (config) => { config.speechSynthesis.voices = []; }],
  ["non-array-voices", (config) => { config.speechSynthesis.voices = {}; }],
  ["string-voices", (config) => { config.speechSynthesis.voices = "Samantha"; }],
  ["missing-voice-name", (config) => { config.speechSynthesis.voices = [{ lang: "en-US", localService: true }]; }],
  ["missing-voice-lang", (config) => { config.speechSynthesis.voices = [{ name: "Samantha", localService: true }]; }],
  ["non-string-voice-name", (config) => { config.speechSynthesis.voices = [{ name: 7, lang: "en-US", localService: true }]; }],
  ["empty-voice-name", (config) => { config.speechSynthesis.voices = [{ name: "", lang: "en-US", localService: true }]; }],
  ["non-string-voice-lang", (config) => { config.speechSynthesis.voices = [{ name: "Samantha", lang: 7, localService: true }]; }],
  ["non-boolean-localService", (config) => { config.speechSynthesis.voices = [{ name: "Samantha", lang: "en-US", localService: "yes" }]; }],
  ["missing-localService", (config) => { config.speechSynthesis.voices = [{ name: "Samantha", lang: "en-US" }]; }],
  ["65-voices", (config) => { config.speechSynthesis.voices = Array.from({ length: 65 }, (_, i) => ({ name: `V${i}`, lang: "en-US", localService: true })); }],
  ["overlong-voice-name", (config) => { config.speechSynthesis.voices = [{ name: "X".repeat(129), lang: "en-US", localService: true }]; }],
  ["overlong-voice-lang", (config) => { config.speechSynthesis.voices = [{ name: "Samantha", lang: "x".repeat(65), localService: true }]; }],
];
let rejectedInvalid = 0;
for (const [label, mutate] of invalidCases) {
  const config = structuredClone(configManaged);
  mutate(config);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-firefox-voice-invalid-${label}-`));
  try {
    fs.writeFileSync(path.join(profileDir, "user.js"),
      `user_pref("agent.browser.fingerprint.config", ${JSON.stringify(encodedConfig(config))});\n`);
    const launch = spawnSync(binary, ["-profile", profileDir, "--headless", "--no-remote", "--agent-browser-native-required"], {
      encoding: "utf8",
      timeout: 15000,
    });
    const stderr = String(launch.stderr);
    if (launch.status === 0 || !stderr.includes("AGENT_BROWSER_NATIVE_CONFIG_ERROR: invalid-field:speechSynthesis")) {
      throw new Error(`Invalid speechSynthesis config did not fail closed (${label}): ${JSON.stringify({
        status: launch.status,
        signal: launch.signal,
        stderr: stderr.slice(-2000),
      })}`);
    }
    rejectedInvalid++;
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}
if (rejectedInvalid !== invalidCases.length) {
  throw new Error(`Invalid speechSynthesis configs rejected: ${rejectedInvalid}/${invalidCases.length}`);
}
console.log(`Invalid speechSynthesis configs rejected: ${invalidCases.length}/${invalidCases.length}`);

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><meta charset=utf-8><title>Firefox 154 Speech Voices Gate</title><body></body>");
});
const pagePort = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const bidi = await import(pathToFileURL(path.join(repoRoot, "dist", "main", "services", "bidi-client.js")).href);
const {
  connectBidi,
  bidiCreateContext,
  bidiCloseContext,
  bidiEvaluateInContext,
  bidiNavigate,
} = bidi;

async function captureWorld(name, config, extraPrefs = {}) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-firefox-speech-${name}-`));
  const port = await freePort();
  let stderr = "";
  let child;
  let connection;
  let context;
  try {
    const prefs = {
      ...identity.nativePrefs,
      "agent.browser.fingerprint.config": encodedConfig(config),
      ...extraPrefs,
    };
    const userJs = Object.entries(prefs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([pref, value]) => `user_pref(${JSON.stringify(pref)}, ${JSON.stringify(value)});`)
      .join("\n");
    fs.writeFileSync(path.join(profileDir, "user.js"), `${userJs}\n`, { encoding: "utf8", mode: 0o600 });
    child = spawn(binary, [
      "-profile", profileDir,
      `--remote-debugging-port=${port}`,
      "--headless",
      "--agent-browser-native-required",
      "--no-remote",
    ], { env: { ...process.env, TZ: "America/Los_Angeles" }, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (data) => { stderr += String(data); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`${name} exited early (${child.exitCode}): ${stderr.slice(-2000)}`);
      try {
        connection = await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: 2000 });
        break;
      } catch (error) {
        await sleep(200);
      }
    }
    if (!connection) throw new Error(`${name} did not expose BiDi: ${stderr.slice(-2000)}`);
    context = await bidiCreateContext(connection, 15000);
    await bidiNavigate(connection, `http://127.0.0.1:${pagePort}/`, context, 15000);
    const expression = `(async function(){
      const out = {};
      try {
        const p = window.speechSynthesis;
        out.exists = !!p;
        if (!p) return JSON.stringify(out);
        const initial = Array.from(p.getVoices());
        out.initial = initial.map(v => ({ name: v.name, lang: v.lang, localService: v.localService, default: v.default, voiceURI: v.voiceURI }));
        let changedFired = false;
        if (!initial.length) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 3000);
            p.addEventListener("voiceschanged", () => { clearTimeout(timer); changedFired = true; resolve(); }, { once: true });
          });
          out.afterEvent = Array.from(p.getVoices()).map(v => ({ name: v.name, lang: v.lang, localService: v.localService, default: v.default, voiceURI: v.voiceURI }));
        }
        out.voicesChangedFired = changedFired;
        const again = Array.from(p.getVoices());
        out.repeatCount = again.length;
        out.sameFirstObject = initial.length && again.length ? initial[0] === again[0] : null;
        const proto = Object.getOwnPropertyDescriptor(SpeechSynthesis.prototype, "getVoices") || {};
        out.getVoicesDescriptor = proto.value
          ? { source: Function.prototype.toString.call(proto.value), writable: (Object.getOwnPropertyDescriptor(SpeechSynthesis.prototype, "getVoices") || {}).writable }
          : null;
        out.workerVoices = null;
      } catch (e) { out.error = String(e); }
      return JSON.stringify(out);
    })()`;
    const raw = await bidiEvaluateInContext(connection, expression, context, 60000);
    const evidence = JSON.parse(raw);
    evidence.voicesChangedFired = evidence.voicesChangedFired ?? null;
    evidence.afterEvent = evidence.afterEvent ?? null;
    return evidence;
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

async function captureWorker(name, config) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-firefox-speech-worker-${name}-`));
  const port = await freePort();
  let stderr = "";
  let child;
  let connection;
  let context;
  try {
    const prefs = {
      ...identity.nativePrefs,
      "agent.browser.fingerprint.config": encodedConfig(config),
    };
    const userJs = Object.entries(prefs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([pref, value]) => `user_pref(${JSON.stringify(pref)}, ${JSON.stringify(value)});`)
      .join("\n");
    fs.writeFileSync(path.join(profileDir, "user.js"), `${userJs}\n`, { encoding: "utf8", mode: 0o600 });
    child = spawn(binary, [
      "-profile", profileDir,
      `--remote-debugging-port=${port}`,
      "--headless",
      "--agent-browser-native-required",
      "--no-remote",
    ], { env: { ...process.env, TZ: "America/Los_Angeles" }, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (data) => { stderr += String(data); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`${name} exited early (${child.exitCode}): ${stderr.slice(-2000)}`);
      try {
        connection = await connectBidi(`ws://127.0.0.1:${port}/session`, { timeoutMs: 2000 });
        break;
      } catch (error) {
        await sleep(200);
      }
    }
    if (!connection) throw new Error(`${name} did not expose BiDi: ${stderr.slice(-2000)}`);
    context = await bidiCreateContext(connection, 15000);
    await bidiNavigate(connection, `http://127.0.0.1:${pagePort}/`, context, 15000);
    const expression = `(async function(){
      const out = {};
      try {
        const worker = new Worker(URL.createObjectURL(new Blob([\`postMessage(JSON.stringify({
          speech: typeof self.speechSynthesis,
          speechSynth: typeof SpeechSynthesis,
          voice: typeof SpeechSynthesisVoice,
        }));\`], { type: "text/javascript" })));
        out.result = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve("timeout"), 8000);
          worker.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
          worker.onerror = (event) => { clearTimeout(timer); resolve("worker-error"); };
        });
        worker.terminate();
      } catch (e) { out.error = String(e); }
      return JSON.stringify(out);
    })()`;
    const raw = await bidiEvaluateInContext(connection, expression, context, 60000);
    return JSON.parse(raw);
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

console.log(`Speech voices corpus capture on ${binary}`);
const managedA = await captureWorld("managedA", configManaged);
const managedB = await captureWorld("managedB", configManaged);
const multi = await captureWorld("multi", configMulti);
const zh = await captureWorld("zh", configZh);
const disabled = await captureWorld("disabled", configDisabled);
const rfpManaged = await captureWorld("rfpManaged", configManaged, { "privacy.resistFingerprinting": true });
const workerManaged = await captureWorker("managed", configManaged);

function shapeOf(voices) {
  return voices.map((voice) => ({ name: voice.name, lang: voice.lang, localService: voice.localService, default: voice.default }));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`speech-voices assertion failed: ${message}`);
  }
}

assert(managedA.exists === true, `managed window lacks speechSynthesis: ${JSON.stringify(managedA)}`);
assert(managedA.getVoicesDescriptor?.source?.includes("[native code]") === true,
  `managed getVoices not native: ${JSON.stringify(managedA.getVoicesDescriptor)}`);
const expectedManaged = configManaged.speechSynthesis.voices.map((voice) => ({ name: voice.name, lang: voice.lang, localService: voice.localService, default: false }));
assert(managedA.initial.length === expectedManaged.length,
  `managed roster size ${managedA.initial.length} != config ${expectedManaged.length}: ${JSON.stringify(managedA.initial)}`);
assert(JSON.stringify(shapeOf(managedA.initial)) === JSON.stringify(expectedManaged),
  `managed roster mismatch: ${JSON.stringify(shapeOf(managedA.initial))} vs ${JSON.stringify(expectedManaged)}`);
for (const voice of managedA.initial) {
  assert(/^urn:moz-tts:persona:\d+$/.test(voice.voiceURI), `managed voiceURI not persona: ${JSON.stringify(voice)}`);
}
assert(managedA.initial.every((voice) => voice.default === false),
  `persona voices must not claim default: ${JSON.stringify(managedA.initial)}`);
assert(managedA.initial.every((voice) => voice.localService === true),
  `persona voices must mirror configured localService: ${JSON.stringify(managedA.initial)}`);
assert(managedB.initial.length === expectedManaged.length &&
  JSON.stringify(shapeOf(managedB.initial)) === JSON.stringify(expectedManaged),
  `managed roster changed across restarts: ${JSON.stringify(managedB.initial)}`);
assert(JSON.stringify(managedA.initial.map((voice) => voice.voiceURI)) === JSON.stringify(managedB.initial.map((voice) => voice.voiceURI)),
  `managed persona URIs changed across restarts`);
assert(managedA.sameFirstObject === true, `getVoices identity not stable across calls`);
const expectedMulti = configMulti.speechSynthesis.voices.map((voice) => ({ name: voice.name, lang: voice.lang, localService: voice.localService, default: false }));
assert(JSON.stringify(shapeOf(multi.initial)) === JSON.stringify(expectedMulti),
  `multi roster mismatch: ${JSON.stringify(shapeOf(multi.initial))} vs ${JSON.stringify(expectedMulti)}`);
const expectedZh = configZh.speechSynthesis.voices.map((voice) => ({ name: voice.name, lang: voice.lang, localService: voice.localService, default: false }));
assert(JSON.stringify(shapeOf(zh.initial)) === JSON.stringify(expectedZh),
  `zh roster mismatch: ${JSON.stringify(shapeOf(zh.initial))} vs ${JSON.stringify(expectedZh)}`);
assert(disabled.initial.length === 0,
  `disabled speechSynthesis must keep stock empty headless roster: ${JSON.stringify(disabled.initial)}`);
assert(rfpManaged.initial.length === 0,
  `RFP window leaked persona roster: ${JSON.stringify(rfpManaged.initial)}`);
assert(JSON.stringify(rfpManaged.getVoicesDescriptor) === JSON.stringify(managedA.getVoicesDescriptor),
  `RFP changed getVoices descriptor`);
assert(workerManaged.result && JSON.parse(workerManaged.result).speech === "undefined",
  `Worker leaked speechSynthesis: ${JSON.stringify(workerManaged)}`);

const corpus = {
  schemaVersion: 1,
  browser: {
    engine: "firefox",
    version: EXPECTED_VERSION,
    sourceStamp: EXPECTED_SOURCE_STAMP,
    versionOutput,
    platform: process.platform,
    branding: "unofficial",
  },
  capture: {
    mode: "webdriver-bidi-headless-native-speech-voices",
    preloadScript: false,
    nativeRequired: true,
    fingerprintConfig: configManaged,
  },
  capabilities,
  evidence: {
    managed: { initial: managedA.initial, voicesChangedFired: managedA.voicesChangedFired, afterEvent: managedA.afterEvent, repeatCount: managedA.repeatCount, sameFirstObject: managedA.sameFirstObject, getVoicesDescriptor: managedA.getVoicesDescriptor, worker: workerManaged.result ? JSON.parse(workerManaged.result) : null },
    managedRestart: { initial: managedB.initial, voicesChangedFired: managedB.voicesChangedFired, afterEvent: managedB.afterEvent },
    multi: { initial: multi.initial, voicesChangedFired: multi.voicesChangedFired, afterEvent: multi.afterEvent },
    zh: { initial: zh.initial, voicesChangedFired: zh.voicesChangedFired, afterEvent: zh.afterEvent },
    disabled: { initial: disabled.initial, voicesChangedFired: disabled.voicesChangedFired, afterEvent: disabled.afterEvent },
    rfp: { initial: rfpManaged.initial, voicesChangedFired: rfpManaged.voicesChangedFired, afterEvent: rfpManaged.afterEvent, getVoicesDescriptor: rfpManaged.getVoicesDescriptor },
  },
};

const staging = `${outputPath}.staging`;
fs.writeFileSync(staging, JSON.stringify(corpus, null, 2), { encoding: "utf8", mode: 0o600 });
fs.renameSync(staging, outputPath);
const readback = JSON.parse(fs.readFileSync(outputPath, "utf8"));
if (readback.schemaVersion !== 1 || !readback.evidence?.managed?.initial || readback.evidence.managed.initial.length === 0) {
  throw new Error("speech voices corpus readback/search validation failed");
}
server.close();
console.log(`Firefox speech voices corpus written: ${outputPath}`);
console.log(`Managed voices: ${JSON.stringify(managedA.initial.map((voice) => voice.name))}`);
console.log(`Managed roster: ${JSON.stringify(managedA.initial)}`);
