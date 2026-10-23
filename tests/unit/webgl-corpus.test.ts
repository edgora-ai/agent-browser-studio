import * as vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { captureWebGlCorpusInPage, type WebGlCorpus } from "../../src/tools/webgl-corpus.js";

type Realm = "window" | "windowOffscreen" | "worker";
type Kind = "webgl" | "webgl2";

function fixture(options: {
  windowOffscreenAvailable?: boolean;
  nullContext?: { realm: Realm; kind: Kind };
  failContext?: Realm;
} = {}) {
  const calls: Array<{ realm: Realm; kind: Kind }> = [];
  const offscreenCanvases: Array<{ realm: Realm; width: number; height: number }> = [];
  const blobs = new Map<string, Blob>();
  const terminate = vi.fn();
  const workerClose = vi.fn();
  const url = {
    createObjectURL: vi.fn((blob: Blob) => { blobs.set("blob:webgl-unit", blob); return "blob:webgl-unit"; }),
    revokeObjectURL: vi.fn((value: string) => { blobs.delete(value); }),
  };
  const contextFor = (realm: Realm, kind: Kind) => {
    calls.push({ realm, kind });
    if (options.failContext === realm) throw new Error(`controlled ${realm} capture failure`);
    if (options.nullContext?.realm === realm && options.nullContext.kind === kind) return null;
    const gl = {
      VENDOR: 1, RENDERER: 2, MAX_TEXTURE_SIZE: 3, ALIASED_LINE_WIDTH_RANGE: 4,
      VERTEX_SHADER: 5, FRAGMENT_SHADER: 6,
      LOW_FLOAT: 7, MEDIUM_FLOAT: 8, HIGH_FLOAT: 9, LOW_INT: 10, MEDIUM_INT: 11, HIGH_INT: 12,
      getSupportedExtensions: () => ["WEBGL_debug_renderer_info", "EXT_texture_filter_anisotropic"],
      getExtension(name: string) {
        if (name === "WEBGL_debug_renderer_info") return { UNMASKED_VENDOR_WEBGL: 13, UNMASKED_RENDERER_WEBGL: 14 };
        if (name === "EXT_texture_filter_anisotropic") return { MAX_TEXTURE_MAX_ANISOTROPY_EXT: 15 };
        return null;
      },
      getParameter(parameter: number) {
        if (parameter === 1) return `${realm} masked vendor`;
        if (parameter === 2) return `${realm} masked renderer`;
        if (parameter === 3) return 16384;
        if (parameter === 4) return new Float32Array([1, 1]);
        if (parameter === 13) return `${realm} unmasked vendor`;
        if (parameter === 14) return `${realm} ${kind} unmasked renderer`;
        if (parameter === 15) return 16;
        throw new Error(`unexpected mock parameter ${parameter}`);
      },
      getContextAttributes: () => ({ alpha: true, antialias: true, depth: true, desynchronized: false, failIfMajorPerformanceCaveat: false, premultipliedAlpha: true, preserveDrawingBuffer: false, stencil: false }),
      getShaderPrecisionFormat: (shader: number, precision: number) => ({ rangeMin: shader, rangeMax: precision, precision: 23 }),
    };
    return gl;
  };
  const offscreenClass = (realm: Realm) => class {
    constructor(width: number, height: number) { offscreenCanvases.push({ realm, width, height }); }
    getContext(kind: Kind) { return contextFor(realm, kind); }
  };
  class FakeWorker {
    onmessage: ((event: { data: WebGlCorpus["worker"] & { error?: string } }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    constructor(private readonly url: string) {}
    terminate = terminate;
    postMessage() {
      void (async () => {
        try {
          const source = await blobs.get(this.url)!.text();
          const worker = vm.createContext({
            OffscreenCanvas: offscreenClass("worker"),
            postMessage: (data: WebGlCorpus["worker"] & { error?: string }) => this.onmessage?.({ data: structuredClone(data) }),
            close: workerClose,
          });
          // Execute the actual serialized captureContext in an isolated Worker
          // global: no document, imported helpers, browser, or native executable.
          vm.runInContext(source, worker, { timeout: 1000 });
          vm.runInContext("onmessage()", worker, { timeout: 1000 });
        } catch (error) {
          this.onerror?.({ message: error instanceof Error ? error.message : String(error) });
        }
      })();
    }
  }
  const globals = {
    document: { createElement: vi.fn(() => ({ getContext: (kind: Kind) => contextFor("window", kind) })) },
    OffscreenCanvas: options.windowOffscreenAvailable === false ? undefined : offscreenClass("windowOffscreen"),
    Worker: FakeWorker,
    URL: url,
    Blob,
    setTimeout,
    clearTimeout,
  };
  const capture = () => vm.runInNewContext(`(${captureWebGlCorpusInPage.toString()})()`, globals, { timeout: 1000 }) as Promise<WebGlCorpus>;
  return { capture, calls, offscreenCanvases, terminate, workerClose, url };
}

describe("WebGL Window/Offscreen/Worker corpus capture (no browser)", () => {
  it("independently captures WebGL1/2 from all three surfaces using the serialized shared capture logic", async () => {
    const f = fixture();
    const result = await f.capture();
    expect(Object.keys(result).sort()).toEqual(["window", "windowOffscreen", "worker"]);
    for (const realm of ["window", "windowOffscreen", "worker"] as const) {
      for (const [kind, key, version] of [["webgl", "webgl1", 1], ["webgl2", "webgl2", 2]] as const) {
        expect(f.calls).toContainEqual({ realm, kind });
        const context = result[realm][key]!;
        expect(context.version).toBe(version);
        expect(context.vendor).toBe(`${realm} masked vendor`);
        expect(context.renderer).toBe(`${realm} masked renderer`);
        expect(context.unmaskedVendor).toBe(`${realm} unmasked vendor`);
        expect(context.unmaskedRenderer).toBe(`${realm} ${kind} unmasked renderer`);
        expect(context.extensions).toEqual(["EXT_texture_filter_anisotropic", "WEBGL_debug_renderer_info"]);
        expect(context.parameters).toEqual({ ALIASED_LINE_WIDTH_RANGE: [1, 1], MAX_TEXTURE_SIZE: 16384, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 16 });
        expect(Object.keys(context.shaderPrecision)).toHaveLength(12);
        expect(context.shaderPrecision.VERTEX_HIGH_FLOAT).toEqual({ rangeMin: 5, rangeMax: 9, precision: 23 });
        expect(context.contextAttributes.antialias).toBe(true);
      }
    }
    expect(f.calls).toHaveLength(6);
    expect(f.offscreenCanvases).toEqual([
      { realm: "windowOffscreen", width: 16, height: 16 },
      { realm: "windowOffscreen", width: 16, height: 16 },
      { realm: "worker", width: 16, height: 16 },
      { realm: "worker", width: 16, height: 16 },
    ]);
    expect(f.terminate).toHaveBeenCalledOnce();
    expect(f.workerClose).toHaveBeenCalledOnce();
    expect(f.url.revokeObjectURL).toHaveBeenCalledWith("blob:webgl-unit");
  });

  it.each(["webgl", "webgl2"] as const)("retains an unavailable Window Offscreen %s instead of substituting Window/Worker evidence", async kind => {
    const f = fixture({ nullContext: { realm: "windowOffscreen", kind } });
    const result = await f.capture();
    const key = kind === "webgl" ? "webgl1" : "webgl2";
    expect(result.windowOffscreen[key]).toBeNull();
    expect(result.window[key]).not.toBeNull();
    expect(result.worker[key]).not.toBeNull();
    expect(f.calls).toContainEqual({ realm: "windowOffscreen", kind });
  });

  it("records absent Window OffscreenCanvas as missing evidence, not a duplicate Window corpus", async () => {
    const f = fixture({ windowOffscreenAvailable: false });
    const result = await f.capture();
    expect(result.windowOffscreen).toEqual({ webgl1: null, webgl2: null });
    expect(result.window.webgl1).not.toBeNull();
    expect(result.worker.webgl2).not.toBeNull();
  });

  it("propagates a Window Offscreen capture exception instead of silently omitting the arm", async () => {
    const f = fixture({ failContext: "windowOffscreen" });
    await expect(f.capture()).rejects.toThrow("controlled windowOffscreen capture failure");
  });

  it("retains Worker errors and releases its Worker and blob URL", async () => {
    const f = fixture({ failContext: "worker" });
    await expect(f.capture()).rejects.toThrow("controlled worker capture failure");
    expect(f.terminate).toHaveBeenCalledOnce();
    expect(f.workerClose).toHaveBeenCalledOnce();
    expect(f.url.revokeObjectURL).toHaveBeenCalledWith("blob:webgl-unit");
  });
});
