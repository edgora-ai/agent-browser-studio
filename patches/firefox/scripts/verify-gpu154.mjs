#!/usr/bin/env node
// Verify Firefox 154 native WebGL/WebGPU identity without changing GPU capability shape.
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
  "screen-v1", "canvas-v1", "webgl-v1", "webgpu-v1",
];
const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultOutput = path.join(repoRoot, "patches", "firefox", "corpora-154", "gpu-firefox-154.0.json");
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] || "") : defaultOutput;
const force = process.argv.includes("--force");
const headed = process.argv.includes("--headed");
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
function identity(seed, platform) {
  return fingerprint.buildFirefoxManagedIdentity({
    fingerprintSeed: seed,
    platform,
    locale: "en-US",
    timezone: "America/New_York",
  }, EXPECTED_VERSION);
}
const identityA = identity(154102, "windows");
let identityB;
for (let seed = 154103; seed < 154200; seed++) {
  const candidate = identity(seed, "windows");
  if (candidate.config.webgl.renderer !== identityA.config.webgl.renderer) {
    identityB = candidate;
    break;
  }
}
if (!identityB) throw new Error("Could not select a different Windows GPU persona");
const identityMac = identity(154103, "macos");
const identityAndroid = identity(154104, "android");

function encodedConfig(config) {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}

const invalidCases = [
  ["missing-webgl", "invalid-field:webgl", (config) => { delete config.webgl; }],
  ["non-object-webgl", "invalid-field:webgl", (config) => { config.webgl = "invalid"; }],
  ["missing-webgl-vendor", "invalid-field:webgl", (config) => { delete config.webgl.vendor; }],
  ["empty-webgl-vendor", "invalid-field:webgl", (config) => { config.webgl.vendor = ""; }],
  ["non-string-webgl-vendor", "invalid-field:webgl", (config) => { config.webgl.vendor = null; }],
  ["missing-webgl-renderer", "invalid-field:webgl", (config) => { delete config.webgl.renderer; }],
  ["empty-webgl-renderer", "invalid-field:webgl", (config) => { config.webgl.renderer = ""; }],
  ["non-string-webgl-renderer", "invalid-field:webgl", (config) => { config.webgl.renderer = 42; }],
  ["missing-webgpu", "invalid-field:webgpu", (config) => { delete config.webgpu; }],
  ["non-object-webgpu", "invalid-field:webgpu", (config) => { config.webgpu = false; }],
  ["missing-webgpu-mode", "invalid-field:webgpu", (config) => { delete config.webgpu.mode; }],
  ["wrong-webgpu-mode", "invalid-field:webgpu", (config) => { config.webgpu.mode = "native"; }],
  ["missing-webgpu-vendor", "invalid-field:webgpu", (config) => { delete config.webgpu.vendor; }],
  ["empty-webgpu-vendor", "invalid-field:webgpu", (config) => { config.webgpu.vendor = ""; }],
  ["non-string-webgpu-vendor", "invalid-field:webgpu", (config) => { config.webgpu.vendor = 12; }],
  ["missing-webgpu-architecture", "invalid-field:webgpu", (config) => { delete config.webgpu.architecture; }],
  ["empty-webgpu-architecture", "invalid-field:webgpu", (config) => { config.webgpu.architecture = ""; }],
  ["non-string-webgpu-architecture", "invalid-field:webgpu", (config) => { config.webgpu.architecture = false; }],
  ["missing-webgpu-device", "invalid-field:webgpu", (config) => { delete config.webgpu.device; }],
  ["empty-webgpu-device", "invalid-field:webgpu", (config) => { config.webgpu.device = ""; }],
  ["non-string-webgpu-device", "invalid-field:webgpu", (config) => { config.webgpu.device = []; }],
  ["missing-webgpu-description", "invalid-field:webgpu", (config) => { delete config.webgpu.description; }],
  ["empty-webgpu-description", "invalid-field:webgpu", (config) => { config.webgpu.description = ""; }],
  ["non-string-webgpu-description", "invalid-field:webgpu", (config) => { config.webgpu.description = {}; }],
  ["missing-subgroup-min", "invalid-field:webgpu", (config) => { delete config.webgpu.subgroupMinSize; }],
  ["invalid-subgroup-min", "invalid-field:webgpu", (config) => { config.webgpu.subgroupMinSize = 0; }],
  ["fractional-subgroup-min", "invalid-field:webgpu", (config) => { config.webgpu.subgroupMinSize = 32.5; }],
  ["missing-subgroup-max", "invalid-field:webgpu", (config) => { delete config.webgpu.subgroupMaxSize; }],
  ["oversized-subgroup-max", "invalid-field:webgpu", (config) => { config.webgpu.subgroupMaxSize = 129; }],
  ["reversed-subgroups", "incoherent-gpu-identity", (config) => {
    config.webgpu.subgroupMinSize = 64;
    config.webgpu.subgroupMaxSize = 32;
  }],
  ["incoherent-vendor", "incoherent-gpu-identity", (config) => { config.webgpu.vendor = "Apple"; }],
  ["incoherent-device", "incoherent-gpu-identity", (config) => { config.webgpu.device = "Imaginary GPU"; }],
  ["incoherent-description", "incoherent-gpu-identity", (config) => { config.webgpu.description += " modified"; }],
];
for (const [label, expectedError, mutate] of invalidCases) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-firefox-gpu154-invalid-${label}-`));
  try {
    const config = structuredClone(identityA.config);
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
        !stderr.includes(`AGENT_BROWSER_NATIVE_CONFIG_ERROR: ${expectedError}`)) {
      throw new Error(`Invalid GPU config did not fail closed (${label}): ${JSON.stringify({
        status: launch.status,
        signal: launch.signal,
        expectedError,
        stderr: stderr.slice(-2000),
      })}`);
    }
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}
console.log(`Invalid GPU configs rejected: ${invalidCases.length}/${invalidCases.length}`);

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
  function serializable(value) {
    return typeof value === "bigint" ? value.toString() : value;
  }
  function nativeMethodSource(object, name) {
    var proto = object;
    while (proto) {
      var descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor && typeof descriptor.value === "function") {
        return Function.prototype.toString.call(descriptor.value);
      }
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }
  function nativeGetterSource(ctor, name) {
    var descriptor = ctor && ctor.prototype
      ? Object.getOwnPropertyDescriptor(ctor.prototype, name)
      : null;
    return descriptor && typeof descriptor.get === "function"
      ? Function.prototype.toString.call(descriptor.get)
      : null;
  }
  function webglProbe(scope, offscreen) {
    var result = {};
    for (var ci = 0; ci < 2; ci++) {
      var kind = ci === 0 ? "webgl" : "webgl2";
      try {
        var canvas = offscreen
          ? new scope.OffscreenCanvas(32, 16)
          : Object.assign(scope.document.createElement("canvas"), {width:32,height:16});
        var gl = canvas.getContext(kind, {preserveDrawingBuffer:true});
        if (!gl) {
          result[kind] = {supported:false};
          continue;
        }
        var debug = gl.getExtension("WEBGL_debug_renderer_info");
        var extensions = (gl.getSupportedExtensions() || []).slice().sort();
        var limitNames = [
          "ALIASED_LINE_WIDTH_RANGE", "ALIASED_POINT_SIZE_RANGE", "ALPHA_BITS",
          "BLUE_BITS", "DEPTH_BITS", "GREEN_BITS", "MAX_3D_TEXTURE_SIZE",
          "MAX_ARRAY_TEXTURE_LAYERS", "MAX_COLOR_ATTACHMENTS",
          "MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS",
          "MAX_COMBINED_TEXTURE_IMAGE_UNITS", "MAX_COMBINED_UNIFORM_BLOCKS",
          "MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS", "MAX_CUBE_MAP_TEXTURE_SIZE",
          "MAX_DRAW_BUFFERS", "MAX_ELEMENT_INDEX", "MAX_ELEMENTS_INDICES",
          "MAX_ELEMENTS_VERTICES", "MAX_FRAGMENT_INPUT_COMPONENTS",
          "MAX_FRAGMENT_UNIFORM_BLOCKS", "MAX_FRAGMENT_UNIFORM_COMPONENTS",
          "MAX_FRAGMENT_UNIFORM_VECTORS", "MAX_PROGRAM_TEXEL_OFFSET",
          "MAX_RENDERBUFFER_SIZE", "MAX_SAMPLES", "MAX_SERVER_WAIT_TIMEOUT",
          "MAX_TEXTURE_IMAGE_UNITS", "MAX_TEXTURE_LOD_BIAS", "MAX_TEXTURE_SIZE",
          "MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS",
          "MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS",
          "MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS", "MAX_UNIFORM_BLOCK_SIZE",
          "MAX_UNIFORM_BUFFER_BINDINGS", "MAX_VARYING_COMPONENTS",
          "MAX_VARYING_VECTORS", "MAX_VERTEX_ATTRIBS",
          "MAX_VERTEX_OUTPUT_COMPONENTS", "MAX_VERTEX_TEXTURE_IMAGE_UNITS",
          "MAX_VERTEX_UNIFORM_BLOCKS", "MAX_VERTEX_UNIFORM_COMPONENTS",
          "MAX_VERTEX_UNIFORM_VECTORS", "MAX_VIEWPORT_DIMS",
          "MIN_PROGRAM_TEXEL_OFFSET", "RED_BITS", "SAMPLE_BUFFERS", "SAMPLES",
          "STENCIL_BITS", "SUBPIXEL_BITS", "UNIFORM_BUFFER_OFFSET_ALIGNMENT",
        ];
        var limits = {};
        for (var li = 0; li < limitNames.length; li++) {
          var name = limitNames[li];
          if (!(name in gl)) continue;
          var value = gl.getParameter(gl[name]);
          limits[name] = ArrayBuffer.isView(value) ? Array.from(value) : serializable(value);
        }
        result[kind] = {
          supported: true,
          maskedVendor: gl.getParameter(gl.VENDOR),
          maskedRenderer: gl.getParameter(gl.RENDERER),
          unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
          unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
          debugExtension: Boolean(debug),
          version: gl.getParameter(gl.VERSION),
          shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
          extensions: extensions,
          limits: limits,
          nativeMethods: {
            canvasGetContext: nativeMethodSource(canvas, "getContext"),
            getParameter: nativeMethodSource(gl, "getParameter"),
            getExtension: nativeMethodSource(gl, "getExtension"),
            getSupportedExtensions: nativeMethodSource(gl, "getSupportedExtensions"),
          },
        };
      } catch (error) {
        result[kind] = {supported:false,error:String(error && error.stack || error)};
      }
    }
    return result;
  }
  async function webgpuProbe(scope) {
    try {
      var gpu = scope.navigator && scope.navigator.gpu;
      if (!gpu || typeof gpu.requestAdapter !== "function") return {supported:false};
      var adapter = await gpu.requestAdapter();
      if (!adapter) return {supported:true,adapter:false};
      var info = adapter.info;
      var infoValue = {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
        subgroupMinSize: info.subgroupMinSize,
        subgroupMaxSize: info.subgroupMaxSize,
        isFallbackAdapter: info.isFallbackAdapter,
      };
      var limitProto = Object.getPrototypeOf(adapter.limits);
      var limits = {};
      for (var name of Object.getOwnPropertyNames(limitProto).sort()) {
        if (name === "constructor") continue;
        var descriptor = Object.getOwnPropertyDescriptor(limitProto, name);
        if (!descriptor || typeof descriptor.get !== "function") continue;
        try { limits[name] = serializable(adapter.limits[name]); } catch (error) {}
      }
      var features = Array.from(adapter.features).sort();
      var wgslLanguageFeatures = Array.from(gpu.wgslLanguageFeatures || []).sort();
      var nativeInfoGetters = {};
      for (var infoField of [
        "vendor", "architecture", "device", "description", "subgroupMinSize",
        "subgroupMaxSize", "isFallbackAdapter",
      ]) {
        nativeInfoGetters[infoField] = nativeGetterSource(scope.GPUAdapterInfo, infoField);
      }
      var nativeAccessors = {
        gpuRequestAdapter: nativeMethodSource(gpu, "requestAdapter"),
        adapterRequestDevice: nativeMethodSource(adapter, "requestDevice"),
        adapterInfo: nativeGetterSource(scope.GPUAdapter, "info"),
        adapterFeatures: nativeGetterSource(scope.GPUAdapter, "features"),
        adapterLimits: nativeGetterSource(scope.GPUAdapter, "limits"),
        gpuWgslLanguageFeatures: nativeGetterSource(scope.GPU, "wgslLanguageFeatures"),
        deviceAdapterInfo: nativeGetterSource(scope.GPUDevice, "adapterInfo"),
      };
      var deviceInfo = null;
      var deviceError = null;
      try {
        var device = await adapter.requestDevice();
        var inner = device.adapterInfo;
        deviceInfo = {
          vendor: inner.vendor,
          architecture: inner.architecture,
          device: inner.device,
          description: inner.description,
          subgroupMinSize: inner.subgroupMinSize,
          subgroupMaxSize: inner.subgroupMaxSize,
          isFallbackAdapter: inner.isFallbackAdapter,
        };
        device.destroy();
      } catch (error) {
        deviceError = String(error && error.stack || error);
      }
      return {
        supported: true,
        adapter: true,
        info: infoValue,
        deviceInfo: deviceInfo,
        deviceError: deviceError,
        features: features,
        limits: limits,
        wgslLanguageFeatures: wgslLanguageFeatures,
        nativeInfoGetters: nativeInfoGetters,
        nativeAccessors: nativeAccessors,
      };
    } catch (error) {
      return {supported:false,error:String(error && error.stack || error)};
    }
  }
  function workerMain(shared) {
    async function capture() {
      return {
        webgl: webglProbe(self, true),
        webgpu: await webgpuProbe(self),
      };
    }
    if (shared) {
      self.onconnect = function(event) {
        var port = event.ports[0];
        capture().then(function(value){port.postMessage({supported:true,value:value});port.close();},
          function(error){port.postMessage({supported:false,error:String(error)});port.close();});
      };
    } else {
      capture().then(function(value){self.postMessage({supported:true,value:value});self.close();},
        function(error){self.postMessage({supported:false,error:String(error)});self.close();});
    }
  }
  function workerResult(shared) {
    return new Promise(function(resolve) {
      var source = serializable.toString() + ";" + nativeMethodSource.toString() +
        ";" + nativeGetterSource.toString() + ";" + webglProbe.toString() + ";" +
        webgpuProbe.toString() + ";(" + workerMain.toString() + ")(" +
        (shared ? "true" : "false") + ");";
      var url = URL.createObjectURL(new Blob([source], {type:"text/javascript"}));
      var timer = setTimeout(function(){URL.revokeObjectURL(url);resolve({supported:false,error:"timeout"});},30000);
      if (shared) {
        var worker = new SharedWorker(url);
        worker.port.onmessage = function(event){clearTimeout(timer);worker.port.close();URL.revokeObjectURL(url);resolve(event.data);};
        worker.port.start();
      } else {
        var worker = new Worker(url);
        worker.onmessage = function(event){clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);resolve(event.data);};
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
      htmlWebgl: webglProbe(window, false),
      offscreenWebgl: webglProbe(window, true),
      webgpu: await webgpuProbe(window),
    },
    iframe: {
      htmlWebgl: webglProbe(frame.contentWindow, false),
      offscreenWebgl: webglProbe(frame.contentWindow, true),
      webgpu: await webgpuProbe(frame.contentWindow),
    },
    dedicatedWorker: await workerResult(false),
    sharedWorker: await workerResult(true),
  };
  frame.remove();
  return result;
})()`;

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><meta charset=utf-8><title>Firefox 154 GPU Gate</title><body></body>");
});
const pagePort = await listen(server);

async function captureWorld(name, managedIdentity) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-firefox-gpu154-${name}-`));
  const port = await freePort();
  let stderr = "";
  let child;
  let connection;
  let context;
  try {
    if (managedIdentity) {
      const prefs = {
        ...managedIdentity.nativePrefs,
        "agent.browser.fingerprint.config": encodedConfig(managedIdentity.config),
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
      ...(headed ? [] : ["--headless"]),
      ...(managedIdentity ? ["--agent-browser-native-required"] : []),
      "--no-remote",
    ], {
      env: { ...process.env, TZ: managedIdentity?.config.timezone || process.env.TZ },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (data) => { stderr += String(data); });
    for (let attempt = 0; attempt < 100; attempt++) {
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

function webglSurfaces(world) {
  return [
    ["window.html", world.window.htmlWebgl],
    ["window.offscreen", world.window.offscreenWebgl],
    ["iframe.html", world.iframe.htmlWebgl],
    ["iframe.offscreen", world.iframe.offscreenWebgl],
    ["dedicated.offscreen", world.dedicatedWorker.value.webgl],
    ["shared.offscreen", world.sharedWorker.value.webgl],
  ];
}
function webgpuSurfaces(world) {
  return [
    ["window", world.window.webgpu],
    ["iframe", world.iframe.webgpu],
    ["dedicated", world.dedicatedWorker.value.webgpu],
    ["shared", world.sharedWorker.value.webgpu],
  ];
}
function allNative(record) {
  return record && Object.values(record).every(
    (source) => typeof source === "string" && source.includes("[native code]"),
  );
}
function assertWorldSupported(world, label) {
  if (world.dedicatedWorker?.supported !== true || world.sharedWorker?.supported !== true) {
    throw new Error(`${label} Worker capture failed: ${JSON.stringify({dedicated:world.dedicatedWorker,shared:world.sharedWorker})}`);
  }
  for (const [realm, pair] of webglSurfaces(world)) {
    for (const kind of ["webgl", "webgl2"]) {
      const value = pair[kind];
      if (value?.supported !== true || value.debugExtension !== true ||
          !allNative(value.nativeMethods)) {
        throw new Error(`${label}.${realm}.${kind} unavailable/non-native: ${JSON.stringify(value)}`);
      }
    }
  }
  for (const [realm, value] of webgpuSurfaces(world)) {
    if (value?.supported !== true || value.adapter !== true || !value.deviceInfo || value.deviceError ||
        !allNative(value.nativeInfoGetters) || !allNative(value.nativeAccessors)) {
      throw new Error(`${label}.${realm}.webgpu unavailable/non-native: ${JSON.stringify(value)}`);
    }
  }
}
function expectedIdentity(config) {
  return {
    vendor: config.webgpu.vendor,
    architecture: config.webgpu.architecture,
    device: config.webgpu.device,
    description: config.webgpu.description,
  };
}
function assertManagedIdentity(world, config, label) {
  for (const [realm, pair] of webglSurfaces(world)) {
    for (const kind of ["webgl", "webgl2"]) {
      const value = pair[kind];
      if (value.maskedVendor !== "Mozilla" || value.maskedRenderer !== config.webgl.renderer ||
          value.unmaskedVendor !== config.webgl.vendor || value.unmaskedRenderer !== config.webgl.renderer) {
        throw new Error(`${label}.${realm}.${kind} identity mismatch: ${JSON.stringify(value)}`);
      }
    }
  }
  const expected = expectedIdentity(config);
  for (const [realm, value] of webgpuSurfaces(world)) {
    for (const info of [value.info, value.deviceInfo]) {
      const actual = {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
      };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label}.${realm}.webgpu identity mismatch: ${JSON.stringify({actual,expected})}`);
      }
    }
  }
}
function webglCapabilityShape(world) {
  return Object.fromEntries(webglSurfaces(world).map(([realm, pair]) => [realm,
    Object.fromEntries(["webgl", "webgl2"].map((kind) => [kind, {
      supported: pair[kind].supported,
      debugExtension: pair[kind].debugExtension,
      version: pair[kind].version,
      shadingLanguageVersion: pair[kind].shadingLanguageVersion,
      extensions: pair[kind].extensions,
      limits: pair[kind].limits,
    }]))
  ]));
}
function webgpuCapabilityShape(world) {
  return Object.fromEntries(webgpuSurfaces(world).map(([realm, value]) => [realm, {
    supported: value.supported,
    adapter: value.adapter,
    subgroupMinSize: value.info.subgroupMinSize,
    subgroupMaxSize: value.info.subgroupMaxSize,
    isFallbackAdapter: value.info.isFallbackAdapter,
    features: value.features,
    limits: value.limits,
    wgslLanguageFeatures: value.wgslLanguageFeatures,
  }]));
}
function publicIdentity(world) {
  const webgl = world.window.htmlWebgl.webgl2;
  const webgpu = world.window.webgpu.info;
  return {
    webgl: {
      maskedVendor: webgl.maskedVendor,
      maskedRenderer: webgl.maskedRenderer,
      unmaskedVendor: webgl.unmaskedVendor,
      unmaskedRenderer: webgl.unmaskedRenderer,
    },
    webgpu: {
      vendor: webgpu.vendor,
      architecture: webgpu.architecture,
      device: webgpu.device,
      description: webgpu.description,
    },
  };
}

try {
  const managedA1 = await captureWorld("managed-a1", identityA);
  const managedA2 = await captureWorld("managed-a2", identityA);
  const managedB = await captureWorld("managed-b", identityB);
  const managedMac = await captureWorld("managed-mac", identityMac);
  const managedAndroid = await captureWorld("managed-android", identityAndroid);
  const stock = await captureWorld("stock", null);
  const worlds = { managedA1, managedA2, managedB, managedMac, managedAndroid, stock };
  for (const [label, world] of Object.entries(worlds)) assertWorldSupported(world, label);
  assertManagedIdentity(managedA1, identityA.config, "managedA1");
  assertManagedIdentity(managedA2, identityA.config, "managedA2");
  assertManagedIdentity(managedB, identityB.config, "managedB");
  assertManagedIdentity(managedMac, identityMac.config, "managedMac");
  assertManagedIdentity(managedAndroid, identityAndroid.config, "managedAndroid");

  const identityA1 = publicIdentity(managedA1);
  const identityA2 = publicIdentity(managedA2);
  const identityOther = publicIdentity(managedB);
  if (JSON.stringify(identityA1) !== JSON.stringify(identityA2)) {
    throw new Error(`Same GPU config changed across restarts: ${JSON.stringify({identityA1,identityA2})}`);
  }
  if (JSON.stringify(identityA1) === JSON.stringify(identityOther)) {
    throw new Error(`Different GPU personas were identical: ${JSON.stringify(identityA1)}`);
  }

  const stockWebglShape = webglCapabilityShape(stock);
  const stockWebgpuShape = webgpuCapabilityShape(stock);
  for (const [label, world] of Object.entries({ managedA1, managedA2, managedB, managedMac, managedAndroid })) {
    const webglShape = webglCapabilityShape(world);
    const webgpuShape = webgpuCapabilityShape(world);
    if (JSON.stringify(webglShape) !== JSON.stringify(stockWebglShape)) {
      throw new Error(`${label} changed WebGL extensions/limits: ${JSON.stringify({webglShape,stockWebglShape})}`);
    }
    if (JSON.stringify(webgpuShape) !== JSON.stringify(stockWebgpuShape)) {
      throw new Error(`${label} changed WebGPU features/limits/WGSL: ${JSON.stringify({webgpuShape,stockWebgpuShape})}`);
    }
  }
  for (const [realm, value] of webgpuSurfaces(stock)) {
    const info = value.info;
    if (info.vendor !== "" || info.architecture !== "" || info.device !== "" || info.description !== "") {
      throw new Error(`Stock WebGPU identity was not empty (${realm}): ${JSON.stringify(info)}`);
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
      mode: headed ? "webdriver-bidi-headed-native-gpu" : "webdriver-bidi-headless-native-gpu",
      fingerprintConfig: identityA.config,
      preloadScript: false,
      nativeRequired: true,
      comparisonPersonas: {
        windows: identityB.config,
        macos: identityMac.config,
        android: identityAndroid.config,
      },
    },
    capabilities,
    identities: {
      managed: identityA1,
      differentWindows: publicIdentity(managedB),
      macos: publicIdentity(managedMac),
      android: publicIdentity(managedAndroid),
      stock: publicIdentity(stock),
    },
    capabilityShape: {
      webgl: stockWebglShape,
      webgpu: stockWebgpuShape,
    },
    surfaces: managedA1,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const staging = `${outputPath}.staging-${process.pid}`;
  if (fs.existsSync(staging)) throw new Error(`GPU corpus staging path already exists: ${staging}`);
  fs.writeFileSync(staging, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  fs.renameSync(staging, outputPath);
  const text = fs.readFileSync(outputPath, "utf8");
  const readback = JSON.parse(text);
  assertWorldSupported(readback.surfaces, "readback");
  assertManagedIdentity(readback.surfaces, readback.capture.fingerprintConfig, "readback");
  if (!readback.capabilities?.capabilities?.includes("webgl-v1") ||
      !readback.capabilities?.capabilities?.includes("webgpu-v1") ||
      readback.capture?.preloadScript !== false ||
      readback.surfaces?.dedicatedWorker?.value?.webgpu?.adapter !== true ||
      readback.surfaces?.sharedWorker?.value?.webgpu?.adapter !== true ||
      !text.includes('"nativeRequired": true')) {
    throw new Error("GPU corpus readback/search validation failed");
  }
  console.log(`Firefox GPU corpus written: ${outputPath}`);
  console.log(`Same persona restart: ${JSON.stringify(identityA1) === JSON.stringify(identityA2)}`);
  console.log(`Managed GPU: ${JSON.stringify(identityA1)}`);
  console.log(`Different GPU: ${JSON.stringify(identityOther)}`);
  console.log(`Stock GPU: ${JSON.stringify(publicIdentity(stock))}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
