import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildBrowserFingerprintConfig, type BrowserFingerprintConfig } from "../../src/main/services/browser-fingerprint-config.js";
import { buildFirefoxFingerprintPreloadScript, buildFirefoxManagedIdentity } from "../../src/main/services/firefox-fingerprint.js";

const bootstrap = `
class Navigator {}
class Window {}
class Screen {}
class CanvasBase {
  font = "14px Arial";
  calls = [];
  measureText(text) { return { width: String(text).length * 8 }; }
  fillRect() {}
  strokeRect() {}
  arc() {}
  fillText(text, x, y, maxWidth) {
    if (arguments.length < 3) throw new TypeError("fillText requires text, x, y");
    this.calls.push({ method: "fillText", args: Array.from(arguments), font: this.font });
  }
  strokeText(text, x, y, maxWidth) {
    if (arguments.length < 3) throw new TypeError("strokeText requires text, x, y");
    this.calls.push({ method: "strokeText", args: Array.from(arguments), font: this.font });
  }
}
class CanvasRenderingContext2D extends CanvasBase {}
class OffscreenCanvasRenderingContext2D extends CanvasBase {}
class HTMLCanvasElement { getContext() { return new CanvasRenderingContext2D(); } }
class AudioBuffer {
  #channels;
  constructor({ numberOfChannels, length }) {
    this.#channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get numberOfChannels() { return this.#channels.length; }
  getChannelData(channel) {
    if (!arguments.length) throw new TypeError("Missing channel");
    const index = +channel >>> 0;
    if (!this.#channels[index]) throw new RangeError("Invalid channel");
    return this.#channels[index];
  }
  copyToChannel(source, channel, offset = 0) {
    if (!ArrayBuffer.isView(source) || Object.prototype.toString.call(source) !== "[object Float32Array]") throw new TypeError("Float32Array required");
    this.#channels[channel].set(source, offset);
  }
  copyFromChannel(destination, channel, offset = 0) { destination.set(this.#channels[channel].subarray(offset, offset + destination.length)); }
}
class AnalyserNode {
  get frequencyBinCount() { return 64; }
  get fftSize() { return 128; }
  getFloatFrequencyData(array) { array.fill(0.25, 0, Math.min(array.length, 64)); }
  getFloatTimeDomainData(array) { array.fill(0.25, 0, Math.min(array.length, 128)); }
  getByteFrequencyData(array) { array.fill(128, 0, Math.min(array.length, 64)); }
  getByteTimeDomainData(array) { array.fill(128, 0, Math.min(array.length, 128)); }
}
class MediaDevices {
  devices = [];
  async enumerateDevices() { return this.devices; }
}
class StorageManager {
  async estimate() { return { usage: 4, quota: 10737418240, usageDetails: { fileSystem: 4 } }; }
}
class Blob { constructor(parts) { this.parts = parts; } }
class XMLHttpRequest { status = 200; responseText = "/* owned worker test */"; open() {} send() {} }
class Worker { constructor(url) { workerUrls.push(url); } }
class SharedWorker { constructor(url) { workerUrls.push(url); } }
const workerUrls = [];
const workerSources = new Map();
const URL = { createObjectURL(blob) { const id = "blob:owned-" + workerSources.size; workerSources.set(id, blob.parts.join("")); return id; } };
const navigator = new Navigator();
navigator.mediaDevices = new MediaDevices();
navigator.storage = new StorageManager();
const window = globalThis;
const self = globalThis;
const screen = new Screen();
screen.orientation = {};
const document = { addEventListener() {}, createElement() { return new HTMLCanvasElement(); } };
const nativeEnumerateDevices = MediaDevices.prototype.enumerateDevices;
const nativeAudioGet = AudioBuffer.prototype.getChannelData;
const nativeAudioCopy = AudioBuffer.prototype.copyToChannel;
`;

function config(): BrowserFingerprintConfig {
  return buildBrowserFingerprintConfig({ fingerprintSeed: 25516, platform: "macos", locale: "en-US", timezone: "America/Los_Angeles" }, "154.0", null, "firefox");
}

function world(settings = config()) {
  const context = vm.createContext({ setTimeout: () => 0, console });
  vm.runInContext(bootstrap, context);
  vm.runInContext("window.Worker = Worker; window.SharedWorker = SharedWorker;", context);
  vm.runInContext(buildFirefoxFingerprintPreloadScript(settings), context);
  return context;
}

function worker(settings = config()) {
  const page = world(settings);
  const source = vm.runInContext('new window.Worker("owned-worker.js"); workerSources.get(workerUrls[0])', page);
  expect(typeof source).toBe("string");
  const context = vm.createContext({ setTimeout: () => 0, console });
  vm.runInContext(bootstrap, context);
  vm.runInContext(source, context);
  return context;
}

function values(context: vm.Context, expression: string) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));
}

describe("Firefox default surface regressions from production r6", () => {
  for (const [realm, create] of [["Window", world], ["Worker", worker]] as const) {
    for (const method of ["fillText", "strokeText"]) {
      it(`${realm} ${method} retains all three required arguments and optional maxWidth`, () => {
        const context = create();
        const ctor = realm === "Window" ? "CanvasRenderingContext2D" : "OffscreenCanvasRenderingContext2D";
        const observed = values(context, `(() => {
          const ctx = new ${ctor}();
          ctx.${method}("owned text", 12, 34, 56);
          return { calls: ctx.calls, font: ctx.font };
        })()`);
        expect(observed.calls).toHaveLength(1);
        expect(observed.calls[0].args).toHaveLength(4);
        expect(observed.calls[0].args[0]).toBe("owned text");
        expect(observed.calls[0].args[2]).toBe(34);
        expect(observed.calls[0].args[3]).toBe(56);
        expect(observed.font).toBe("14px Arial");
      });
    }
  }

  it("does not mutate a Float32Array supplied by another realm to copyToChannel", () => {
    const context = world();
    const source = vm.runInNewContext("new Float32Array([0.25, 0.5, -0.25, -0.5, 0.125, 0.75])");
    const before = Array.from(source);
    context.foreignSource = source;
    vm.runInContext("new AudioBuffer({ numberOfChannels: 1, length: foreignSource.length }).copyToChannel(foreignSource, 0)", context);
    expect(Array.from(source)).toEqual(before);
  });

  it("does not mutate unsupported caller data before the native type error", () => {
    const context = world();
    const result = values(context, `(() => {
      const source = [0.25, 0.5, 0.75]; const before = source.slice(); let error;
      try { new AudioBuffer({ numberOfChannels: 1, length: 3 }).copyToChannel(source, 0); }
      catch (e) { error = e.name; }
      return { before, source, error };
    })()`);
    expect(result.error).toBe("TypeError");
    expect(result.source).toEqual(result.before);
  });

  for (const method of ["getFloatFrequencyData", "getFloatTimeDomainData"]) {
    it(`${method} remains deterministic when native code refills the same output array`, () => {
      const context = world();
      const result = values(context, `(() => {
        const analyser = new AnalyserNode(), data = new Float32Array(128);
        analyser.${method}(data); const first = Array.from(data);
        analyser.${method}(data); return { first, second: Array.from(data) };
      })()`);
      expect(result.second).toEqual(result.first);
    });

    it(`${method} treats cross-realm arrays like same-realm arrays`, () => {
      const context = world();
      context.foreignOutput = vm.runInNewContext("new Float32Array(128)");
      const result = values(context, `(() => {
        const analyser = new AnalyserNode(), local = new Float32Array(128);
        analyser.${method}(local); analyser.${method}(foreignOutput);
        return { local: Array.from(local), foreign: Array.from(foreignOutput) };
      })()`);
      expect(result.foreign).toEqual(result.local);
    });
  }

  for (const method of ["getByteFrequencyData", "getByteTimeDomainData"]) {
    it(`${method} does not truncate sub-byte noise into whole-byte decrements`, () => {
      const context = world();
      const result = values(context, `(() => { const data = new Uint8Array(64); new AnalyserNode().${method}(data); return Array.from(data); })()`);
      expect(result).toEqual(Array(64).fill(128));
    });
  }

  for (const method of ["getFloatFrequencyData", "getFloatTimeDomainData"]) {
    it(`${method} leaves output elements beyond the native sample count untouched`, () => {
      const context = world();
      const result = values(context, `(() => {
        const analyser = new AnalyserNode(), data = new Float32Array(256).fill(0.125);
        analyser.${method}(data);
        return Array.from(data).slice(${method.includes("Frequency") ? 64 : 128});
      })()`);
      expect(result).toEqual(Array(method.includes("Frequency") ? 192 : 128).fill(0.125));
    });
  }

  it("AudioBuffer noise is stable per channel rather than depending on channel read order", () => {
    const context = world();
    const result = values(context, `(() => {
      const a = new AudioBuffer({ numberOfChannels: 2, length: 128 });
      const b = new AudioBuffer({ numberOfChannels: 2, length: 128 });
      const a0 = Array.from(a.getChannelData(0)); const a1 = Array.from(a.getChannelData(1));
      const b1 = Array.from(b.getChannelData(1)); const b0 = Array.from(b.getChannelData(0));
      return { a0, a1, b0, b1, repeated: Array.from(a.getChannelData(0)) };
    })()`);
    expect(result.a0).toEqual(result.b0);
    expect(result.a1).toEqual(result.b1);
    expect(result.repeated).toEqual(result.a0);
  });

  it("keeps native AudioBuffer validation and only coerces a channel argument once", () => {
    const context = world();
    const result = values(context, `(() => {
      const buffer = new AudioBuffer({ numberOfChannels: 1, length: 4 }); let conversions = 0;
      buffer.getChannelData({ valueOf() { conversions++; return 0; } });
      const errors = [];
      for (const fn of [() => buffer.getChannelData(), () => buffer.getChannelData(1n), () => buffer.getChannelData(Symbol()), () => buffer.getChannelData(-1), () => AudioBuffer.prototype.getChannelData.call({}, 0)]) {
        try { fn(); errors.push(null); } catch (e) { errors.push(e.name); }
      }
      return { conversions, errors };
    })()`);
    expect(result.conversions).toBe(1);
    expect(result.errors).toEqual(["TypeError", "TypeError", "TypeError", "RangeError", "TypeError"]);
  });

  it("does not fabricate MediaDeviceInfo entries when native policy returns none", async () => {
    const context = world();
    expect(vm.runInContext("MediaDevices.prototype.enumerateDevices === nativeEnumerateDevices", context)).toBe(true);
    const devices = await vm.runInContext("navigator.mediaDevices.enumerateDevices()", context);
    expect(Array.from(devices)).toEqual([]);
  });

  it("keeps native media intent separate from the default fallback", () => {
    const bundle = buildFirefoxManagedIdentity({ fingerprintSeed: 25516, platform: "macos" }, "154.0");
    expect(bundle.config.mediaDevices.enabled).toBe(false);
    expect(bundle.nativeConfig.mediaDevices.enabled).toBe(true);
  });

  for (const [realm, create] of [["Window", world], ["Worker", worker]] as const) {
    it(`${realm} reports the configured quota while retaining native estimate fields`, async () => {
      const settings = config();
      const context = create(settings);
      const value = await vm.runInContext("navigator.storage.estimate()", context);
      expect(value.quota).toBe(settings.storageQuotaBytes);
      expect(value.usage).toBe(4);
      expect(JSON.parse(JSON.stringify(value.usageDetails))).toEqual({ fileSystem: 4 });
    });
  }
});
