#!/usr/bin/env node
// Verify Firefox 154 native deterministic Canvas/OffscreenCanvas readback noise.
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
  "config-v1",
  "native-required-v1",
  "snapshot-v1",
  "navigator-v1",
  "screen-v1",
  "canvas-v1",
];
const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultOutput = path.join(repoRoot, "patches", "firefox", "corpora-154", "canvas-firefox-154.0.json");
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
configB.canvas.seed = configA.canvas.seed === "0000000000000000" ? "1111111111111111" : "0000000000000000";

function encodedConfig(config) {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}

const invalidCases = [
  ["missing-object", (config) => { delete config.canvas; }],
  ["non-object", (config) => { config.canvas = "invalid"; }],
  ["missing-enabled", (config) => { delete config.canvas.enabled; }],
  ["non-boolean-enabled", (config) => { config.canvas.enabled = "true"; }],
  ["missing-seed", (config) => { delete config.canvas.seed; }],
  ["non-string-seed", (config) => { config.canvas.seed = 1234; }],
  ["short-seed", (config) => { config.canvas.seed = "0123456789abcde"; }],
  ["uppercase-seed", (config) => { config.canvas.seed = "0123456789ABCDE"; }],
  ["non-hex-seed", (config) => { config.canvas.seed = "0123456789abcdeg"; }],
];
for (const [label, mutate] of invalidCases) {
  const invalidProfile = fs.mkdtempSync(path.join(os.tmpdir(), `agent-firefox-canvas154-invalid-${label}-`));
  try {
    const invalidConfig = structuredClone(configA);
    mutate(invalidConfig);
    fs.writeFileSync(
      path.join(invalidProfile, "user.js"),
      `user_pref("agent.browser.fingerprint.config", ${JSON.stringify(encodedConfig(invalidConfig))});\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const invalidLaunch = spawnSync(binary, [
      "-profile", invalidProfile,
      "--headless",
      "--agent-browser-native-required",
      "--no-remote",
    ], { encoding: "utf8", timeout: 15000 });
    if (invalidLaunch.status === 0 ||
        !String(invalidLaunch.stderr).includes("AGENT_BROWSER_NATIVE_CONFIG_ERROR: invalid-field:canvas")) {
      throw new Error(`Invalid Canvas config did not fail closed (${label}): ${JSON.stringify({
        status: invalidLaunch.status,
        signal: invalidLaunch.signal,
        stderr: String(invalidLaunch.stderr).slice(-2000),
      })}`);
    }
  } finally {
    fs.rmSync(invalidProfile, { recursive: true, force: true });
  }
}
console.log(`Invalid Canvas configs rejected: ${invalidCases.length}/${invalidCases.length}`);

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
  function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function draw2d(scope, offscreen) {
    var canvas = offscreen
      ? new scope.OffscreenCanvas(96, 32)
      : Object.assign(scope.document.createElement("canvas"), { width: 96, height: 32 });
    var ctx = canvas.getContext("2d");
    ctx.textBaseline = "top";
    ctx.font = "14px Arial";
    ctx.fillStyle = "#f60";
    ctx.fillRect(2, 2, 19, 11);
    ctx.fillStyle = "#069";
    ctx.fillText("Firefox 154 canvas", 5, 8);
    ctx.strokeStyle = "rgba(20,40,80,.7)";
    ctx.beginPath();
    ctx.arc(72, 18, 9, 0, Math.PI * 1.75);
    ctx.stroke();
    return { canvas: canvas, ctx: ctx };
  }
  function blobBytes(blob) {
    return blob.arrayBuffer().then(function (buffer) { return new Uint8Array(buffer); });
  }
  function htmlBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error("toBlob returned null")); }, "image/png");
    });
  }
  async function capture2d(scope, offscreen) {
    var pair = draw2d(scope, offscreen);
    var replay = draw2d(scope, offscreen);
    var first = pair.ctx.getImageData(0, 0, 96, 32).data;
    var second = pair.ctx.getImageData(0, 0, 96, 32).data;
    var replayPixels = replay.ctx.getImageData(0, 0, 96, 32).data;
    var blob1 = offscreen ? await pair.canvas.convertToBlob({ type: "image/png" }) : await htmlBlob(pair.canvas);
    var blob2 = offscreen ? await pair.canvas.convertToBlob({ type: "image/png" }) : await htmlBlob(pair.canvas);
    var replayBlob = offscreen ? await replay.canvas.convertToBlob({ type: "image/png" }) : await htmlBlob(replay.canvas);
    var blobBytes1 = await blobBytes(blob1);
    var blobBytes2 = await blobBytes(blob2);
    var replayBlobBytes = await blobBytes(replayBlob);
    var result = {
      pixelsHash: hashBytes(first),
      pixelsLength: first.length,
      pixelsStable: equalBytes(first, second),
      pixelsReplayStable: equalBytes(first, replayPixels),
      blobHash: hashBytes(blobBytes1),
      blobLength: blobBytes1.length,
      blobStable: equalBytes(blobBytes1, blobBytes2),
      blobReplayStable: equalBytes(blobBytes1, replayBlobBytes),
    };
    if (!offscreen) {
      var url1 = pair.canvas.toDataURL("image/png");
      var url2 = pair.canvas.toDataURL("image/png");
      var replayUrl = replay.canvas.toDataURL("image/png");
      result.dataUrlHash = hashBytes(new TextEncoder().encode(url1));
      result.dataUrlLength = url1.length;
      result.dataUrlStable = url1 === url2;
      result.dataUrlReplayStable = url1 === replayUrl;
    }
    return result;
  }
  async function captureWebgl(scope, offscreen) {
    try {
      var canvas = offscreen
        ? new scope.OffscreenCanvas(64, 32)
        : Object.assign(scope.document.createElement("canvas"), { width: 64, height: 32 });
      var gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true }) || canvas.getContext("webgl", { preserveDrawingBuffer: true });
      if (!gl) return { supported: false };
      gl.clearColor(0.1, 0.2, 0.3, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, 23, 17);
      gl.clearColor(0.8, 0.15, 0.4, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.SCISSOR_TEST);
      var first = new Uint8Array(64 * 32 * 4);
      var second = new Uint8Array(first.length);
      gl.readPixels(0, 0, 64, 32, gl.RGBA, gl.UNSIGNED_BYTE, first);
      gl.readPixels(0, 0, 64, 32, gl.RGBA, gl.UNSIGNED_BYTE, second);
      var blob1 = offscreen ? await canvas.convertToBlob({ type: "image/png" }) : await htmlBlob(canvas);
      var blob2 = offscreen ? await canvas.convertToBlob({ type: "image/png" }) : await htmlBlob(canvas);
      var bytes1 = await blobBytes(blob1);
      var bytes2 = await blobBytes(blob2);
      var result = {
        supported: true,
        pixelsHash: hashBytes(first),
        pixelsStable: equalBytes(first, second),
        blobHash: hashBytes(bytes1),
        blobStable: equalBytes(bytes1, bytes2),
      };
      if (!offscreen) {
        var url1 = canvas.toDataURL("image/png");
        var url2 = canvas.toDataURL("image/png");
        result.dataUrlHash = hashBytes(new TextEncoder().encode(url1));
        result.dataUrlStable = url1 === url2;
      }
      if (scope.WebGL2RenderingContext && gl instanceof scope.WebGL2RenderingContext && gl.getExtension("EXT_color_buffer_float")) {
        var texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 8, 4, 0, gl.RGBA, gl.FLOAT, null);
        var framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
          gl.viewport(0, 0, 8, 4);
          gl.clearColor(0.125, 0.25, 0.5, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(0, 0, 3, 2);
          gl.clearColor(0.75, 0.375, 0.625, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.disable(gl.SCISSOR_TEST);
          var float1 = new Float32Array(8 * 4 * 4);
          var float2 = new Float32Array(float1.length);
          gl.readPixels(0, 0, 8, 4, gl.RGBA, gl.FLOAT, float1);
          gl.readPixels(0, 0, 8, 4, gl.RGBA, gl.FLOAT, float2);
          result.floatReadPixels = {
            supported: gl.getError() === gl.NO_ERROR,
            hash: hashBytes(new Uint8Array(float1.buffer)),
            stable: equalBytes(new Uint8Array(float1.buffer), new Uint8Array(float2.buffer)),
          };
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      return result;
    } catch (error) {
      return { supported: false, error: String(error && error.stack || error) };
    }
  }
  function workerMain(shared) {
    function hashBytes(bytes) {
      var hash = 2166136261;
      for (var i = 0; i < bytes.length; i++) { hash ^= bytes[i] & 255; hash = Math.imul(hash, 16777619); }
      return (hash >>> 0).toString(16).padStart(8, "0");
    }
    function equalBytes(a, b) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    function draw2d() {
      var canvas = new OffscreenCanvas(96, 32);
      var ctx = canvas.getContext("2d");
      ctx.textBaseline = "top";
      ctx.font = "14px Arial";
      ctx.fillStyle = "#f60";
      ctx.fillRect(2, 2, 19, 11);
      ctx.fillStyle = "#069";
      ctx.fillText("Firefox 154 canvas", 5, 8);
      ctx.strokeStyle = "rgba(20,40,80,.7)";
      ctx.beginPath();
      ctx.arc(72, 18, 9, 0, Math.PI * 1.75);
      ctx.stroke();
      return { canvas: canvas, ctx: ctx };
    }
    async function capture2d() {
      var pair = draw2d();
      var replay = draw2d();
      var first = pair.ctx.getImageData(0, 0, 96, 32).data;
      var second = pair.ctx.getImageData(0, 0, 96, 32).data;
      var replayPixels = replay.ctx.getImageData(0, 0, 96, 32).data;
      var blob1 = new Uint8Array(await (await pair.canvas.convertToBlob({type:"image/png"})).arrayBuffer());
      var blob2 = new Uint8Array(await (await pair.canvas.convertToBlob({type:"image/png"})).arrayBuffer());
      var replayBlob = new Uint8Array(await (await replay.canvas.convertToBlob({type:"image/png"})).arrayBuffer());
      return {
        pixelsHash: hashBytes(first),
        pixelsStable: equalBytes(first, second),
        pixelsReplayStable: equalBytes(first, replayPixels),
        blobHash: hashBytes(blob1),
        blobStable: equalBytes(blob1, blob2),
        blobReplayStable: equalBytes(blob1, replayBlob),
      };
    }
    async function captureWebgl() {
      var canvas = new OffscreenCanvas(64, 32);
      var gl = canvas.getContext("webgl2", {preserveDrawingBuffer:true}) || canvas.getContext("webgl", {preserveDrawingBuffer:true});
      if (!gl) return {supported:false};
      gl.clearColor(0.1, 0.2, 0.3, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, 23, 17);
      gl.clearColor(0.8, 0.15, 0.4, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.SCISSOR_TEST);
      var first = new Uint8Array(64 * 32 * 4);
      var second = new Uint8Array(first.length);
      gl.readPixels(0, 0, 64, 32, gl.RGBA, gl.UNSIGNED_BYTE, first);
      gl.readPixels(0, 0, 64, 32, gl.RGBA, gl.UNSIGNED_BYTE, second);
      var blob1 = new Uint8Array(await (await canvas.convertToBlob({type:"image/png"})).arrayBuffer());
      var blob2 = new Uint8Array(await (await canvas.convertToBlob({type:"image/png"})).arrayBuffer());
      var result = {
        supported: true,
        pixelsHash: hashBytes(first),
        pixelsStable: equalBytes(first, second),
        blobHash: hashBytes(blob1),
        blobStable: equalBytes(blob1, blob2),
      };
      if (typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext && gl.getExtension("EXT_color_buffer_float")) {
        var texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 8, 4, 0, gl.RGBA, gl.FLOAT, null);
        var framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
          gl.viewport(0, 0, 8, 4);
          gl.clearColor(0.125, 0.25, 0.5, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(0, 0, 3, 2);
          gl.clearColor(0.75, 0.375, 0.625, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.disable(gl.SCISSOR_TEST);
          var float1 = new Float32Array(8 * 4 * 4);
          var float2 = new Float32Array(float1.length);
          gl.readPixels(0, 0, 8, 4, gl.RGBA, gl.FLOAT, float1);
          gl.readPixels(0, 0, 8, 4, gl.RGBA, gl.FLOAT, float2);
          result.floatReadPixels = {
            supported: gl.getError() === gl.NO_ERROR,
            hash: hashBytes(new Uint8Array(float1.buffer)),
            stable: equalBytes(new Uint8Array(float1.buffer), new Uint8Array(float2.buffer)),
          };
        }
      }
      return result;
    }
    async function capture() {
      return { canvas2d: await capture2d(), webgl: await captureWebgl() };
    }
    if (shared) {
      self.onconnect = function (event) {
        var port = event.ports[0];
        capture().then(function (value) { port.postMessage({supported:true,value:value}); port.close(); }, function (error) { port.postMessage({supported:false,error:String(error)}); port.close(); });
      };
    } else {
      capture().then(function (value) { self.postMessage({supported:true,value:value}); self.close(); }, function (error) { self.postMessage({supported:false,error:String(error)}); self.close(); });
    }
  }
  function workerResult(shared) {
    return new Promise(function (resolve) {
      var source = "(" + workerMain.toString() + ")(" + (shared ? "true" : "false") + ");";
      var url = URL.createObjectURL(new Blob([source], {type:"text/javascript"}));
      var timer = setTimeout(function () { URL.revokeObjectURL(url); resolve({supported:false,error:"timeout"}); }, 15000);
      if (shared) {
        var worker = new SharedWorker(url);
        worker.port.onmessage = function (event) { clearTimeout(timer); worker.port.close(); URL.revokeObjectURL(url); resolve(event.data); };
        worker.port.start();
      } else {
        var worker = new Worker(url);
        worker.onmessage = function (event) { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); };
      }
    });
  }

  var frame = document.createElement("iframe");
  frame.src = "about:blank";
  var loaded = new Promise(function (resolve) { frame.onload = resolve; setTimeout(resolve, 2000); });
  document.body.appendChild(frame);
  await loaded;
  var result = {
    window: {
      canvas2d: await capture2d(window, false),
      offscreen2d: await capture2d(window, true),
      webgl: await captureWebgl(window, false),
      offscreenWebgl: await captureWebgl(window, true),
    },
    iframe: {
      canvas2d: await capture2d(frame.contentWindow, false),
      offscreen2d: await capture2d(frame.contentWindow, true),
      webgl: await captureWebgl(frame.contentWindow, false),
      offscreenWebgl: await captureWebgl(frame.contentWindow, true),
    },
    dedicatedWorker: await workerResult(false),
    sharedWorker: await workerResult(true),
  };
  frame.remove();
  return result;
})()`;

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><meta charset=utf-8><title>Firefox 154 Canvas Gate</title><body></body>");
});
const pagePort = await listen(server);

async function captureWorld(name, config) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-firefox-canvas154-${name}-`));
  const port = await freePort();
  let stderr = "";
  let connection;
  let context;
  let child;
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
    return await bidiEvaluateInContext(connection, expression, context, 120000);
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

function assertStable(world, label) {
  for (const realm of ["window", "iframe"]) {
    for (const surface of ["canvas2d", "offscreen2d"]) {
      const result = world[realm][surface];
      for (const field of [
        "pixelsStable", "pixelsReplayStable", "blobStable", "blobReplayStable",
        "dataUrlStable", "dataUrlReplayStable",
      ]) {
        if (field in result && result[field] !== true) {
          throw new Error(`${label}.${realm}.${surface}.${field} was not stable`);
        }
      }
    }
    for (const surface of ["webgl", "offscreenWebgl"]) {
      const result = world[realm][surface];
      if (result.supported !== true || result.pixelsStable !== true ||
          result.blobStable !== true || result.floatReadPixels?.supported !== true ||
          result.floatReadPixels.stable !== true ||
          ("dataUrlStable" in result && result.dataUrlStable !== true)) {
        throw new Error(`${label}.${realm}.${surface} lacked stable 8-bit/FLOAT readback: ${JSON.stringify(result)}`);
      }
    }
  }
  for (const realm of ["dedicatedWorker", "sharedWorker"]) {
    const result = world[realm];
    if (result?.supported !== true ||
        result.value.canvas2d.pixelsStable !== true ||
        result.value.canvas2d.pixelsReplayStable !== true ||
        result.value.canvas2d.blobStable !== true ||
        result.value.canvas2d.blobReplayStable !== true ||
        result.value.webgl.supported !== true ||
        result.value.webgl.pixelsStable !== true ||
        result.value.webgl.blobStable !== true ||
        result.value.webgl.floatReadPixels?.supported !== true ||
        result.value.webgl.floatReadPixels.stable !== true) {
      throw new Error(`${label}.${realm} lacked stable 2D/WebGL readback: ${JSON.stringify(result)}`);
    }
  }
}

function identityHashes(world) {
  return {
    window2d: world.window.canvas2d.pixelsHash,
    window2dBlob: world.window.canvas2d.blobHash,
    window2dUrl: world.window.canvas2d.dataUrlHash,
    windowOffscreen: world.window.offscreen2d.pixelsHash,
    windowOffscreenBlob: world.window.offscreen2d.blobHash,
    iframe2d: world.iframe.canvas2d.pixelsHash,
    iframe2dBlob: world.iframe.canvas2d.blobHash,
    iframe2dUrl: world.iframe.canvas2d.dataUrlHash,
    iframeOffscreen: world.iframe.offscreen2d.pixelsHash,
    iframeOffscreenBlob: world.iframe.offscreen2d.blobHash,
    webgl: world.window.webgl.pixelsHash,
    webglBlob: world.window.webgl.blobHash,
    webglUrl: world.window.webgl.dataUrlHash,
    webglFloat: world.window.webgl.floatReadPixels.hash,
    offscreenWebgl: world.window.offscreenWebgl.pixelsHash,
    offscreenWebglBlob: world.window.offscreenWebgl.blobHash,
    offscreenWebglFloat: world.window.offscreenWebgl.floatReadPixels.hash,
    iframeWebgl: world.iframe.webgl.pixelsHash,
    iframeWebglBlob: world.iframe.webgl.blobHash,
    iframeWebglUrl: world.iframe.webgl.dataUrlHash,
    iframeWebglFloat: world.iframe.webgl.floatReadPixels.hash,
    iframeOffscreenWebgl: world.iframe.offscreenWebgl.pixelsHash,
    iframeOffscreenWebglBlob: world.iframe.offscreenWebgl.blobHash,
    iframeOffscreenWebglFloat: world.iframe.offscreenWebgl.floatReadPixels.hash,
    dedicatedWorker: world.dedicatedWorker.value.canvas2d.pixelsHash,
    dedicatedWorkerBlob: world.dedicatedWorker.value.canvas2d.blobHash,
    dedicatedWorkerWebgl: world.dedicatedWorker.value.webgl.pixelsHash,
    dedicatedWorkerWebglBlob: world.dedicatedWorker.value.webgl.blobHash,
    dedicatedWorkerWebglFloat: world.dedicatedWorker.value.webgl.floatReadPixels.hash,
    sharedWorker: world.sharedWorker.value.canvas2d.pixelsHash,
    sharedWorkerBlob: world.sharedWorker.value.canvas2d.blobHash,
    sharedWorkerWebgl: world.sharedWorker.value.webgl.pixelsHash,
    sharedWorkerWebglBlob: world.sharedWorker.value.webgl.blobHash,
    sharedWorkerWebglFloat: world.sharedWorker.value.webgl.floatReadPixels.hash,
  };
}

function assertCrossRealmIdentity(hashes, label) {
  const groups = [
    ["window2d", "windowOffscreen", "iframe2d", "iframeOffscreen", "dedicatedWorker", "sharedWorker"],
    ["window2dBlob", "windowOffscreenBlob", "iframe2dBlob", "iframeOffscreenBlob", "dedicatedWorkerBlob", "sharedWorkerBlob"],
    ["window2dUrl", "iframe2dUrl"],
    ["webgl", "offscreenWebgl", "iframeWebgl", "iframeOffscreenWebgl", "dedicatedWorkerWebgl", "sharedWorkerWebgl"],
    ["webglBlob", "offscreenWebglBlob", "iframeWebglBlob", "iframeOffscreenWebglBlob", "dedicatedWorkerWebglBlob", "sharedWorkerWebglBlob"],
    ["webglUrl", "iframeWebglUrl"],
    ["webglFloat", "offscreenWebglFloat", "iframeWebglFloat", "iframeOffscreenWebglFloat", "dedicatedWorkerWebglFloat", "sharedWorkerWebglFloat"],
  ];
  for (const fields of groups) {
    const values = fields.map((field) => hashes[field]);
    if (new Set(values).size !== 1) {
      throw new Error(`${label} Canvas identity diverged across realms: ${JSON.stringify(
        Object.fromEntries(fields.map((field, index) => [field, values[index]])),
      )}`);
    }
  }
}

try {
  const managedA1 = await captureWorld("managed-a1", configA);
  const managedA2 = await captureWorld("managed-a2", configA);
  const managedB = await captureWorld("managed-b", configB);
  const stock = await captureWorld("stock", null);
  for (const [label, world] of Object.entries({ managedA1, managedA2, managedB, stock })) {
    assertStable(world, label);
  }
  const hashesA1 = identityHashes(managedA1);
  const hashesA2 = identityHashes(managedA2);
  const hashesB = identityHashes(managedB);
  const hashesStock = identityHashes(stock);
  for (const [label, hashes] of Object.entries({ hashesA1, hashesA2, hashesB, hashesStock })) {
    assertCrossRealmIdentity(hashes, label);
  }
  if (JSON.stringify(hashesA1) !== JSON.stringify(hashesA2)) {
    throw new Error(`Same Canvas seed changed across restarts: ${JSON.stringify({ hashesA1, hashesA2 })}`);
  }
  for (const field of Object.keys(hashesA1)) {
    if (hashesA1[field] === hashesStock[field]) {
      throw new Error(`Managed Canvas did not differ from stock: ${field}=${hashesA1[field]}`);
    }
    if (hashesA1[field] === hashesB[field]) {
      throw new Error(`Different Canvas seeds were identical: ${field}=${hashesA1[field]}`);
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
      mode: "webdriver-bidi-headless-native-canvas",
      fingerprintConfig: configA,
      comparisonSeed: configB.canvas.seed,
      preloadScript: false,
      nativeRequired: true,
    },
    capabilities,
    hashes: { managed: hashesA1, differentSeed: hashesB, stock: hashesStock },
    surfaces: managedA1,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const staging = `${outputPath}.staging-${process.pid}`;
  if (fs.existsSync(staging)) throw new Error(`Corpus staging path already exists: ${staging}`);
  fs.writeFileSync(staging, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  fs.renameSync(staging, outputPath);
  const text = fs.readFileSync(outputPath, "utf8");
  const readback = JSON.parse(text);
  if (readback.capabilities?.capabilities?.includes("canvas-v1") !== true ||
      readback.capture?.preloadScript !== false ||
      readback.surfaces?.dedicatedWorker?.supported !== true ||
      readback.surfaces?.sharedWorker?.supported !== true ||
      !text.includes('"nativeRequired": true')) {
    throw new Error("Canvas corpus readback/search validation failed");
  }
  console.log(`Firefox Canvas corpus written: ${outputPath}`);
  console.log(`Same seed restart: ${JSON.stringify(hashesA1) === JSON.stringify(hashesA2)}`);
  console.log(`Managed hashes: ${JSON.stringify(hashesA1)}`);
  console.log(`Different-seed hashes: ${JSON.stringify(hashesB)}`);
  console.log(`Stock hashes: ${JSON.stringify(hashesStock)}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
