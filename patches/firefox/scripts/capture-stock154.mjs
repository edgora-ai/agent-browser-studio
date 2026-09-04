#!/usr/bin/env node
// Capture the no-fingerprint-config behavior of the pinned Firefox 154 build.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_VERSION = "154.0";
const EXPECTED_SOURCE_STAMP = "9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc";
const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultOutput = path.join(repoRoot, "patches", "firefox", "corpora-154", "stock-firefox-154.0.json");
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
if (!versionOutput.includes(EXPECTED_VERSION)) {
  throw new Error(`Unexpected Firefox version: ${versionOutput}`);
}
const appRoot = path.resolve(path.dirname(binary), "..", "..");
const applicationIniPath = path.join(appRoot, "Contents", "Resources", "application.ini");
const applicationIni = fs.readFileSync(applicationIniPath, "utf8");
const sourceStamp = applicationIni.match(/^SourceStamp=(.+)$/m)?.[1]?.trim();
if (sourceStamp !== EXPECTED_SOURCE_STAMP) {
  throw new Error(`Unexpected Firefox SourceStamp: ${sourceStamp || "<empty>"}`);
}

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

  function canvasProbe(scope, offscreen) {
    try {
      var canvas = offscreen
        ? new scope.OffscreenCanvas(96, 32)
        : Object.assign(scope.document.createElement("canvas"), { width: 96, height: 32 });
      var ctx = canvas.getContext("2d");
      ctx.textBaseline = "top";
      ctx.font = "14px Arial";
      ctx.fillStyle = "#f60";
      ctx.fillRect(2, 2, 19, 11);
      ctx.fillStyle = "#069";
      ctx.fillText("Firefox 154 stock", 5, 8);
      ctx.strokeStyle = "rgba(20,40,80,.7)";
      ctx.beginPath();
      ctx.arc(72, 18, 9, 0, Math.PI * 1.75);
      ctx.stroke();
      var bytes = ctx.getImageData(0, 0, 96, 32).data;
      return { supported: true, hash: hashBytes(bytes), length: bytes.length };
    } catch (error) {
      return { supported: false, error: String(error && error.name || error) };
    }
  }

  function webglProbe(scope, offscreen) {
    try {
      var canvas = offscreen
        ? new scope.OffscreenCanvas(32, 32)
        : scope.document.createElement("canvas");
      var gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (!gl) return { supported: false };
      var debug = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        supported: true,
        version: gl.getParameter(gl.VERSION),
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        extensions: (gl.getSupportedExtensions() || []).slice().sort(),
      };
    } catch (error) {
      return { supported: false, error: String(error && error.name || error) };
    }
  }

  function getterSource(prototype, name) {
    try {
      var getter = Object.getOwnPropertyDescriptor(prototype, name).get;
      return Function.prototype.toString.call(getter);
    } catch (error) {
      return null;
    }
  }

  function navigatorProbe(scope) {
    var nav = scope.navigator;
    var proto = scope.Navigator && scope.Navigator.prototype;
    return {
      appCodeName: nav.appCodeName,
      appName: nav.appName,
      appVersion: nav.appVersion,
      deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
      hardwareConcurrency: nav.hardwareConcurrency,
      language: nav.language,
      languages: Array.from(nav.languages || []),
      maxTouchPoints: nav.maxTouchPoints,
      onLine: nav.onLine,
      oscpu: nav.oscpu,
      platform: nav.platform,
      product: nav.product,
      productSub: nav.productSub,
      userAgent: nav.userAgent,
      userAgentData: typeof nav.userAgentData === "object" && nav.userAgentData !== null,
      vendor: nav.vendor,
      vendorSub: nav.vendorSub,
      webdriver: nav.webdriver,
      getters: proto ? {
        hardwareConcurrency: getterSource(proto, "hardwareConcurrency"),
        platform: getterSource(proto, "platform"),
        userAgent: getterSource(proto, "userAgent"),
        webdriver: getterSource(proto, "webdriver"),
      } : null,
    };
  }

  function windowProbe(scope) {
    var orientation = scope.screen.orientation;
    return {
      navigator: navigatorProbe(scope),
      screen: {
        availHeight: scope.screen.availHeight,
        availWidth: scope.screen.availWidth,
        colorDepth: scope.screen.colorDepth,
        height: scope.screen.height,
        orientationAngle: orientation ? orientation.angle : null,
        orientationType: orientation ? orientation.type : null,
        pixelDepth: scope.screen.pixelDepth,
        width: scope.screen.width,
        devicePixelRatio: scope.devicePixelRatio,
        innerHeight: scope.innerHeight,
        innerWidth: scope.innerWidth,
        outerHeight: scope.outerHeight,
        outerWidth: scope.outerWidth,
      },
      intl: {
        locale: new scope.Intl.DateTimeFormat().resolvedOptions().locale,
        calendar: new scope.Intl.DateTimeFormat().resolvedOptions().calendar,
        numberingSystem: new scope.Intl.DateTimeFormat().resolvedOptions().numberingSystem,
        timeZone: new scope.Intl.DateTimeFormat().resolvedOptions().timeZone,
        januaryOffsetMinutes: new scope.Date(2026, 0, 1).getTimezoneOffset(),
        julyOffsetMinutes: new scope.Date(2026, 6, 1).getTimezoneOffset(),
      },
      canvas2d: canvasProbe(scope, false),
      offscreenCanvas2d: typeof scope.OffscreenCanvas === "function" ? canvasProbe(scope, true) : { supported: false },
      webgl: webglProbe(scope, false),
      offscreenWebgl: typeof scope.OffscreenCanvas === "function" ? webglProbe(scope, true) : { supported: false },
      webgpu: { supported: Boolean(scope.navigator.gpu) },
      plugins: Array.from(scope.navigator.plugins || [], function (plugin) { return plugin.name; }),
      mimeTypes: Array.from(scope.navigator.mimeTypes || [], function (mime) { return mime.type; }),
      fonts: ["Arial", "Helvetica", "Times New Roman", "Courier New", "Menlo"].map(function (font) {
        return [font, scope.document.fonts.check('16px "' + font + '"')];
      }),
    };
  }

  function workerMain(shared) {
    function hashBytes(bytes) {
      var hash = 2166136261;
      for (var i = 0; i < bytes.length; i++) {
        hash ^= bytes[i] & 255;
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    }
    function getterSource(prototype, name) {
      try {
        var getter = Object.getOwnPropertyDescriptor(prototype, name).get;
        return Function.prototype.toString.call(getter);
      } catch (error) {
        return null;
      }
    }
    function canvasProbe() {
      try {
        var canvas = new OffscreenCanvas(96, 32);
        var ctx = canvas.getContext("2d");
        ctx.textBaseline = "top";
        ctx.font = "14px Arial";
        ctx.fillStyle = "#f60";
        ctx.fillRect(2, 2, 19, 11);
        ctx.fillStyle = "#069";
        ctx.fillText("Firefox 154 stock", 5, 8);
        ctx.strokeStyle = "rgba(20,40,80,.7)";
        ctx.beginPath();
        ctx.arc(72, 18, 9, 0, Math.PI * 1.75);
        ctx.stroke();
        var bytes = ctx.getImageData(0, 0, 96, 32).data;
        return { supported: true, hash: hashBytes(bytes), length: bytes.length };
      } catch (error) {
        return { supported: false, error: String(error && error.name || error) };
      }
    }
    function webglProbe() {
      try {
        var canvas = new OffscreenCanvas(32, 32);
        var gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
        if (!gl) return { supported: false };
        var debug = gl.getExtension("WEBGL_debug_renderer_info");
        return {
          supported: true,
          version: gl.getParameter(gl.VERSION),
          shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
          vendor: gl.getParameter(gl.VENDOR),
          renderer: gl.getParameter(gl.RENDERER),
          unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
          unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
          extensions: (gl.getSupportedExtensions() || []).slice().sort(),
        };
      } catch (error) {
        return { supported: false, error: String(error && error.name || error) };
      }
    }
    function capture() {
      var proto = typeof WorkerNavigator === "function" ? WorkerNavigator.prototype : null;
      var intl = new Intl.DateTimeFormat().resolvedOptions();
      return {
        navigator: {
          appName: navigator.appName,
          appVersion: navigator.appVersion,
          hardwareConcurrency: navigator.hardwareConcurrency,
          language: navigator.language,
          languages: Array.from(navigator.languages || []),
          onLine: navigator.onLine,
          platform: navigator.platform,
          product: navigator.product,
          userAgent: navigator.userAgent,
          webgpu: Boolean(navigator.gpu),
          getters: proto ? {
            hardwareConcurrency: getterSource(proto, "hardwareConcurrency"),
            platform: getterSource(proto, "platform"),
            userAgent: getterSource(proto, "userAgent"),
          } : null,
        },
        intl: {
          locale: intl.locale,
          calendar: intl.calendar,
          numberingSystem: intl.numberingSystem,
          timeZone: intl.timeZone,
          januaryOffsetMinutes: new Date(2026, 0, 1).getTimezoneOffset(),
          julyOffsetMinutes: new Date(2026, 6, 1).getTimezoneOffset(),
        },
        offscreenCanvas2d: typeof OffscreenCanvas === "function" ? canvasProbe() : { supported: false },
        offscreenWebgl: typeof OffscreenCanvas === "function" ? webglProbe() : { supported: false },
      };
    }
    if (shared) {
      self.onconnect = function (event) {
        var port = event.ports[0];
        port.postMessage(capture());
        port.close();
      };
    } else {
      self.postMessage(capture());
      self.close();
    }
  }

  function workerResult(shared) {
    return new Promise(function (resolve) {
      var source = "(" + workerMain.toString() + ")(" + (shared ? "true" : "false") + ");";
      var url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      var timer = setTimeout(function () {
        URL.revokeObjectURL(url);
        resolve({ supported: false, error: "timeout" });
      }, 10000);
      try {
        if (shared) {
          var worker = new SharedWorker(url);
          worker.port.onmessage = function (event) {
            clearTimeout(timer);
            worker.port.close();
            URL.revokeObjectURL(url);
            resolve({ supported: true, value: event.data });
          };
          worker.port.start();
        } else {
          var worker = new Worker(url);
          worker.onmessage = function (event) {
            clearTimeout(timer);
            worker.terminate();
            URL.revokeObjectURL(url);
            resolve({ supported: true, value: event.data });
          };
        }
      } catch (error) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        resolve({ supported: false, error: String(error && error.name || error) });
      }
    });
  }

  var frame = document.createElement("iframe");
  frame.src = "about:blank";
  var frameLoaded = new Promise(function (resolve) {
    frame.onload = resolve;
    setTimeout(resolve, 2000);
  });
  document.body.appendChild(frame);
  await frameLoaded;
  var result = {
    window: windowProbe(window),
    iframe: windowProbe(frame.contentWindow),
    dedicatedWorker: await workerResult(false),
    sharedWorker: await workerResult(true),
  };
  frame.remove();
  return result;
})()`;

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-firefox-stock154-"));
const debugPort = await freePort();
let stderr = "";
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><meta charset=utf-8><title>Firefox 154 stock corpus</title><body></body>");
});
const pagePort = await listen(server);
const child = spawn(binary, [
  "-profile", profileDir,
  `--remote-debugging-port=${debugPort}`,
  "--headless",
  "--no-remote",
], { stdio: ["ignore", "ignore", "pipe"] });
child.stderr.on("data", (data) => { stderr += String(data); });

let connection;
let context;
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`Firefox exited before BiDi became available (${child.exitCode}): ${stderr.slice(-2000)}`);
    }
    try {
      connection = await connectBidi(`ws://127.0.0.1:${debugPort}/session`, { timeoutMs: 2000 });
      break;
    } catch (error) {
      await sleep(250);
    }
  }
  if (!connection) {
    throw new Error(`Firefox did not expose BiDi: ${stderr.slice(-2000)}`);
  }
  context = await bidiCreateContext(connection, 15000);
  await bidiNavigate(connection, `http://127.0.0.1:${pagePort}/`, context, 15000);
  const surfaces = await bidiEvaluateInContext(connection, expression, context, 60000);
  const corpus = {
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
      mode: "webdriver-bidi-headless",
      fingerprintConfig: null,
      preloadScript: false,
      toolchain: {
        clang: "21.1.8",
        lld: "21.1.8",
        rust: "1.94.1",
        cbindgen: "0.29.4",
      },
    },
    surfaces,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const staging = `${outputPath}.staging-${process.pid}`;
  if (fs.existsSync(staging)) {
    throw new Error(`Corpus staging path already exists: ${staging}`);
  }
  fs.writeFileSync(staging, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
  fs.renameSync(staging, outputPath);
  const readback = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  if (readback.browser?.sourceStamp !== EXPECTED_SOURCE_STAMP ||
      readback.surfaces?.dedicatedWorker?.supported !== true ||
      readback.surfaces?.sharedWorker?.supported !== true) {
    throw new Error("Corpus readback validation failed");
  }
  console.log(`Firefox stock corpus written: ${outputPath}`);
  console.log(`Window canvas hash: ${readback.surfaces.window.canvas2d.hash}`);
  console.log(`Dedicated worker: ${readback.surfaces.dedicatedWorker.supported}`);
  console.log(`Shared worker: ${readback.surfaces.sharedWorker.supported}`);
} finally {
  if (context && connection) {
    try { await bidiCloseContext(connection, context, 8000); } catch (error) { console.error(String(error)); }
  }
  if (connection) connection.close();
  await new Promise((resolve) => server.close(resolve));
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(10000).then(() => { if (child.exitCode === null) child.kill("SIGKILL"); }),
  ]);
  fs.rmSync(profileDir, { recursive: true, force: true });
}
