#!/usr/bin/env node
// Verify Firefox 154's native Navigator/WorkerNavigator and screen Gate A.
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
];
const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultOutput = path.join(repoRoot, "patches", "firefox", "corpora-154", "gate-a-firefox-154.0.json");
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] || "") : defaultOutput;
const force = process.argv.includes("--force");
const personaIndex = process.argv.indexOf("--persona");
const persona = personaIndex >= 0 ? process.argv[personaIndex + 1] : "windows";
const binary = process.env.AGENT_BROWSER_FIREFOX_BINARY_PATH;

if (!(["windows", "macos", "android"].includes(persona))) {
  throw new Error(`--persona must be windows, macos, or android: ${JSON.stringify(persona)}`);
}
if (persona !== "windows" && outputIndex < 0) {
  throw new Error("--output is required for non-default Gate A personas");
}
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
const capabilities = JSON.parse(execFileSync(binary, ["--agent-browser-capabilities"], { encoding: "utf8" }));
if (capabilities.product !== "agent-browser-firefox" ||
    capabilities.browserVersion !== EXPECTED_VERSION ||
    capabilities.sourceStamp !== EXPECTED_SOURCE_STAMP ||
    !REQUIRED_CAPABILITIES.every((capability) => capabilities.capabilities?.includes(capability))) {
  throw new Error(`Unexpected Firefox capability report: ${JSON.stringify(capabilities)}`);
}
const appRoot = path.resolve(path.dirname(binary), "..", "..");
const applicationIni = fs.readFileSync(path.join(appRoot, "Contents", "Resources", "application.ini"), "utf8");
const sourceStamp = applicationIni.match(/^SourceStamp=(.+)$/m)?.[1]?.trim();
if (sourceStamp !== EXPECTED_SOURCE_STAMP) {
  throw new Error(`Unexpected Firefox SourceStamp: ${sourceStamp || "<empty>"}`);
}

const fingerprint = await import(pathToFileURL(path.join(repoRoot, "dist", "main", "services", "firefox-fingerprint.js")).href);
const personaMeta = {
  windows: { fingerprintSeed: 154002, platform: "windows", locale: "en-US", timezone: "America/New_York" },
  macos: { fingerprintSeed: 154003, platform: "macos", locale: "en-US", timezone: "Asia/Shanghai" },
  android: { fingerprintSeed: 154004, platform: "android", locale: "en-US", timezone: "Asia/Shanghai" },
}[persona];
const identity = fingerprint.buildFirefoxManagedIdentity(personaMeta, EXPECTED_VERSION);
const expected = identity.config;

const invalidCases = [
  { label: "missing config", encoded: null, error: "missing-config" },
  { label: "invalid base64url", encoded: "***", error: "invalid-base64url" },
  { label: "schema version", mutate: (config) => { config.schemaVersion = 2; }, error: "unsupported-schema-version" },
  { label: "platform", mutate: (config) => { config.platform = "Linux x86_64"; }, error: "invalid-field:platform" },
  { label: "platformVersion", mutate: (config) => { config.platformVersion = "99.0.0"; }, error: "incoherent-platform-version" },
  { label: "appVersion", mutate: (config) => { config.appVersion += " broken"; }, error: "incoherent-app-version" },
  { label: "userAgent", mutate: (config) => { config.userAgent += " broken"; }, error: "incoherent-user-agent" },
  { label: "hardwareConcurrency", mutate: (config) => { config.hardwareConcurrency = 0; }, error: "invalid-field:hardwareConcurrency" },
  { label: "devicePixelRatio", mutate: (config) => { config.screen.devicePixelRatio = 0; }, error: "invalid-field:devicePixelRatio" },
  { label: "screen geometry", mutate: (config) => { config.screen.availLeft = 1000; }, error: "incoherent-screen-geometry" },
  { label: "pixel depth", mutate: (config) => { config.screen.pixelDepth = 30; }, error: "incoherent-screen-geometry" },
];
for (const invalidCase of invalidCases) {
  const invalidProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-firefox-gate-a154-invalid-"));
  try {
    let encoded = invalidCase.encoded;
    if (invalidCase.mutate) {
      const invalidConfig = structuredClone(expected);
      invalidCase.mutate(invalidConfig);
      encoded = Buffer.from(JSON.stringify(invalidConfig), "utf8").toString("base64url");
    }
    const userJs = encoded === null
      ? ""
      : `user_pref("agent.browser.fingerprint.config", ${JSON.stringify(encoded)});\n`;
    fs.writeFileSync(path.join(invalidProfileDir, "user.js"), userJs, { encoding: "utf8", mode: 0o600 });
    const invalidLaunch = spawnSync(binary, [
      "-profile", invalidProfileDir,
      "--headless",
      "--agent-browser-native-required",
      "--no-remote",
    ], { encoding: "utf8", timeout: 15000 });
    const expectedError = `AGENT_BROWSER_NATIVE_CONFIG_ERROR: ${invalidCase.error}`;
    if (invalidLaunch.status === 0 || !String(invalidLaunch.stderr).includes(expectedError)) {
      throw new Error(`Invalid native config did not fail closed (${invalidCase.label}): ${JSON.stringify({
        status: invalidLaunch.status,
        signal: invalidLaunch.signal,
        expectedError,
        stderr: String(invalidLaunch.stderr).slice(-2000),
      })}`);
    }
  } finally {
    fs.rmSync(invalidProfileDir, { recursive: true, force: true });
  }
}
console.log(`Invalid Gate A configs rejected: ${invalidCases.length}/${invalidCases.length}`);

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

function assertEqual(actual, expectedValue, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expectedValue)) {
    throw new Error(`${label}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actual)}`);
  }
}

const expression = String.raw`(async function () {
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
      appVersion: nav.appVersion,
      hardwareConcurrency: nav.hardwareConcurrency,
      language: nav.language,
      languages: Array.from(nav.languages || []),
      maxTouchPoints: nav.maxTouchPoints,
      oscpu: nav.oscpu,
      platform: nav.platform,
      userAgent: nav.userAgent,
      webdriver: nav.webdriver,
      getters: proto ? {
        appVersion: getterSource(proto, "appVersion"),
        hardwareConcurrency: getterSource(proto, "hardwareConcurrency"),
        language: getterSource(proto, "language"),
        languages: getterSource(proto, "languages"),
        maxTouchPoints: getterSource(proto, "maxTouchPoints"),
        oscpu: getterSource(proto, "oscpu"),
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
        availLeft: scope.screen.availLeft,
        availTop: scope.screen.availTop,
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
        screenX: scope.screenX,
        screenY: scope.screenY,
      },
      intl: {
        locale: new scope.Intl.DateTimeFormat().resolvedOptions().locale,
        timeZone: new scope.Intl.DateTimeFormat().resolvedOptions().timeZone,
        januaryOffsetMinutes: new scope.Date(2026, 0, 1).getTimezoneOffset(),
        julyOffsetMinutes: new scope.Date(2026, 6, 1).getTimezoneOffset(),
      },
    };
  }
  function workerMain(shared) {
    function getterSource(prototype, name) {
      try {
        var getter = Object.getOwnPropertyDescriptor(prototype, name).get;
        return Function.prototype.toString.call(getter);
      } catch (error) {
        return null;
      }
    }
    function capture() {
      var proto = typeof WorkerNavigator === "function" ? WorkerNavigator.prototype : null;
      return {
        navigator: {
          appVersion: navigator.appVersion,
          hardwareConcurrency: navigator.hardwareConcurrency,
          language: navigator.language,
          languages: Array.from(navigator.languages || []),
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          hasMaxTouchPoints: "maxTouchPoints" in navigator,
          hasOscpu: "oscpu" in navigator,
          hasWebdriver: "webdriver" in navigator,
          getters: proto ? {
            appVersion: getterSource(proto, "appVersion"),
            hardwareConcurrency: getterSource(proto, "hardwareConcurrency"),
            language: getterSource(proto, "language"),
            languages: getterSource(proto, "languages"),
            platform: getterSource(proto, "platform"),
            userAgent: getterSource(proto, "userAgent"),
          } : null,
        },
        intl: {
          locale: new Intl.DateTimeFormat().resolvedOptions().locale,
          timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
          januaryOffsetMinutes: new Date(2026, 0, 1).getTimezoneOffset(),
          julyOffsetMinutes: new Date(2026, 6, 1).getTimezoneOffset(),
        },
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
  var loaded = new Promise(function (resolve) {
    frame.onload = resolve;
    setTimeout(resolve, 2000);
  });
  document.body.appendChild(frame);
  await loaded;
  var result = {
    window: windowProbe(window),
    iframe: windowProbe(frame.contentWindow),
    dedicatedWorker: await workerResult(false),
    sharedWorker: await workerResult(true),
  };
  frame.remove();
  return result;
})()`;

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-firefox-gate-a154-"));
const userJs = Object.entries(identity.nativePrefs)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`)
  .join("\n");
fs.writeFileSync(path.join(profileDir, "user.js"), `${userJs}\n`, { encoding: "utf8", mode: 0o600 });
const userJsReadback = fs.readFileSync(path.join(profileDir, "user.js"), "utf8");
if (!userJsReadback.includes("agent.browser.fingerprint.config") ||
    !userJsReadback.includes(identity.userAgent)) {
  throw new Error("Managed profile preference readback validation failed");
}

const debugPort = await freePort();
let stderr = "";
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><meta charset=utf-8><title>Firefox 154 Gate A</title><body></body>");
});
const pagePort = await listen(server);
const child = spawn(binary, [
  "-profile", profileDir,
  `--remote-debugging-port=${debugPort}`,
  "--headless",
  "--agent-browser-native-required",
  "--no-remote",
], {
  env: { ...process.env, TZ: expected.timezone },
  stdio: ["ignore", "ignore", "pipe"],
});
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

  const expectedOscpu = expected.platform === "MacIntel"
    ? "Intel Mac OS X 10.15"
    : expected.platform === "Linux armv81"
      ? "Linux armv8l"
      : "Windows NT 10.0; Win64; x64";
  const expectedNavigator = {
    appVersion: expected.appVersion,
    hardwareConcurrency: expected.hardwareConcurrency,
    language: expected.languages[0],
    languages: expected.languages,
    maxTouchPoints: expected.maxTouchPoints,
    oscpu: expectedOscpu,
    platform: expected.platform,
    userAgent: expected.userAgent,
    webdriver: false,
  };
  for (const realm of ["window", "iframe"]) {
    const actualNavigator = surfaces[realm].navigator;
    for (const [name, value] of Object.entries(expectedNavigator)) {
      assertEqual(actualNavigator[name], value, `${realm}.navigator.${name}`);
    }
    for (const [name, source] of Object.entries(actualNavigator.getters)) {
      if (!source?.includes("[native code]")) {
        throw new Error(`${realm}.navigator.${name} getter is not native: ${source}`);
      }
    }
    const screen = surfaces[realm].screen;
    for (const name of ["width", "height", "availLeft", "availTop", "availWidth", "availHeight", "colorDepth", "pixelDepth", "devicePixelRatio", "outerWidth", "outerHeight"]) {
      assertEqual(screen[name], expected.screen[name], `${realm}.screen.${name}`);
    }
    assertEqual(screen.screenX, expected.screen.windowX, `${realm}.screen.screenX`);
    assertEqual(screen.screenY, expected.screen.windowY, `${realm}.screen.screenY`);
    const expectedOrientation = expected.screen.height > expected.screen.width
      ? "portrait-primary"
      : "landscape-primary";
    assertEqual(screen.orientationType, expectedOrientation, `${realm}.screen.orientationType`);
    assertEqual(screen.orientationAngle, 0, `${realm}.screen.orientationAngle`);
    if (typeof surfaces[realm].intl.locale !== "string" || !surfaces[realm].intl.locale) {
      throw new Error(`${realm}.intl.locale was empty`);
    }
    if (realm === "iframe") {
      assertEqual(surfaces[realm].intl.locale, surfaces.window.intl.locale, "iframe.intl.locale");
    }
    assertEqual(surfaces[realm].intl.timeZone, expected.timezone, `${realm}.intl.timeZone`);
  }
  assertEqual(surfaces.iframe.intl.januaryOffsetMinutes, surfaces.window.intl.januaryOffsetMinutes, "iframe.intl.januaryOffsetMinutes");
  assertEqual(surfaces.iframe.intl.julyOffsetMinutes, surfaces.window.intl.julyOffsetMinutes, "iframe.intl.julyOffsetMinutes");
  assertEqual(surfaces.window.screen.innerWidth, expected.screen.outerWidth, "window.screen.innerWidth");
  assertEqual(surfaces.window.screen.innerHeight, expected.screen.outerHeight, "window.screen.innerHeight");
  if (surfaces.iframe.screen.innerWidth === surfaces.window.screen.innerWidth ||
      surfaces.iframe.screen.innerHeight === surfaces.window.screen.innerHeight) {
    throw new Error("iframe inner geometry was incorrectly replaced with top-level geometry");
  }

  for (const realm of ["dedicatedWorker", "sharedWorker"]) {
    if (surfaces[realm]?.supported !== true) {
      throw new Error(`${realm} capture failed: ${JSON.stringify(surfaces[realm])}`);
    }
    const worker = surfaces[realm].value;
    assertEqual(worker.navigator.appVersion, expectedNavigator.appVersion, `${realm}.navigator.appVersion`);
    assertEqual(worker.navigator.hardwareConcurrency, expectedNavigator.hardwareConcurrency, `${realm}.navigator.hardwareConcurrency`);
    assertEqual(worker.navigator.language, expectedNavigator.language, `${realm}.navigator.language`);
    assertEqual(worker.navigator.languages, expectedNavigator.languages, `${realm}.navigator.languages`);
    assertEqual(worker.navigator.platform, expectedNavigator.platform, `${realm}.navigator.platform`);
    assertEqual(worker.navigator.userAgent, expectedNavigator.userAgent, `${realm}.navigator.userAgent`);
    assertEqual(worker.navigator.hasMaxTouchPoints, false, `${realm}.navigator.hasMaxTouchPoints`);
    assertEqual(worker.navigator.hasOscpu, false, `${realm}.navigator.hasOscpu`);
    assertEqual(worker.navigator.hasWebdriver, false, `${realm}.navigator.hasWebdriver`);
    assertEqual(worker.intl.locale, surfaces.window.intl.locale, `${realm}.intl.locale`);
    assertEqual(worker.intl.timeZone, expected.timezone, `${realm}.intl.timeZone`);
    assertEqual(worker.intl.januaryOffsetMinutes, surfaces.window.intl.januaryOffsetMinutes, `${realm}.intl.januaryOffsetMinutes`);
    assertEqual(worker.intl.julyOffsetMinutes, surfaces.window.intl.julyOffsetMinutes, `${realm}.intl.julyOffsetMinutes`);
    for (const [name, source] of Object.entries(worker.navigator.getters)) {
      if (!source?.includes("[native code]")) {
        throw new Error(`${realm}.navigator.${name} getter is not native: ${source}`);
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
      mode: "webdriver-bidi-headless-native",
      persona,
      fingerprintConfig: expected,
      preloadScript: false,
      nativeRequired: true,
    },
    capabilities,
    surfaces,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const staging = `${outputPath}.staging-${process.pid}`;
  if (fs.existsSync(staging)) {
    throw new Error(`Corpus staging path already exists: ${staging}`);
  }
  fs.writeFileSync(staging, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  fs.renameSync(staging, outputPath);

  const resultText = fs.readFileSync(outputPath, "utf8");
  const readback = JSON.parse(resultText);
  if (readback.capabilities?.capabilities?.includes("navigator-v1") !== true ||
      readback.capabilities?.capabilities?.includes("screen-v1") !== true ||
      readback.surfaces?.window?.navigator?.webdriver !== false ||
      !resultText.includes('"preloadScript": false')) {
    throw new Error("Gate A corpus readback/search validation failed");
  }
  console.log(`Firefox Gate A corpus written: ${outputPath}`);
  console.log(`Window Navigator: ${readback.surfaces.window.navigator.platform} / webdriver=${readback.surfaces.window.navigator.webdriver}`);
  console.log(`Window screen: ${readback.surfaces.window.screen.width}x${readback.surfaces.window.screen.height} @ ${readback.surfaces.window.screen.devicePixelRatio}`);
  console.log(`Dedicated Worker: ${readback.surfaces.dedicatedWorker.value.navigator.platform}`);
  console.log(`Shared Worker: ${readback.surfaces.sharedWorker.value.navigator.platform}`);
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
