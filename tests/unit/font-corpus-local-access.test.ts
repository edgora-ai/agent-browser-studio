import * as vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFontCorpusInPage, type FontCorpus } from "../../src/tools/font-corpus.js";

type CaptureOptions = { includeLocalAccess?: boolean };
type Invocation = "imported module" | "serialized source";

// The proposed optional parameter is intentionally exercised before the producer
// changes. This is a type-only view of the real function, not a replacement.
const captureWithOptions = captureFontCorpusInPage as (
  options?: CaptureOptions,
) => Promise<FontCorpus>;

function fixture(invocation: Invocation) {
  const queryLocalFonts = vi.fn<() => Promise<Array<{
    postscriptName: string;
    fullName: string;
    family: string;
    style: string;
  }>>>();
  const blobs = new Map<string, Blob>();
  const terminate = vi.fn();
  const workerClose = vi.fn();
  const workerCanvasCreated = vi.fn();
  const fonts = { check: vi.fn(() => true) };
  const url = {
    createObjectURL: vi.fn((blob: Blob) => {
      const value = "blob:font-corpus-local-access-unit";
      blobs.set(value, blob);
      return value;
    }),
    revokeObjectURL: vi.fn((value: string) => { blobs.delete(value); }),
  };

  // These are declared DOM/canvas boundaries, not a font availability oracle.
  // The production measurement, fallback detection and hashing loops all run.
  // A one-pixel synthetic readback keeps the fixture small; no resulting hash
  // is asserted to be a real browser/font fingerprint.
  function canvas(realm: "window" | "worker") {
    const seed = realm === "window" ? 16 : 32;
    const context = {
      fillStyle: "",
      textBaseline: "",
      fontKerning: "",
      font: "",
      fillRect() {},
      fillText() {},
      measureText(text: string) {
        return {
          width: text.length + seed,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: text.length,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 3,
          fontBoundingBoxAscent: 14,
          fontBoundingBoxDescent: 4,
          emHeightAscent: 12,
          emHeightDescent: 3,
          hangingBaseline: 10,
          alphabeticBaseline: 0,
          ideographicBaseline: -3,
        };
      },
      getImageData() { return { data: new Uint8ClampedArray([seed, 0, 0, 255]) }; },
    };
    return {
      width: 0,
      height: 0,
      getContext(kind: string) {
        if (kind !== "2d") throw new Error(`Undeclared canvas context: ${kind}`);
        return context;
      },
    };
  }

  class FixtureWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    terminate = terminate;

    constructor(private readonly workerUrl: string) {
      if (!blobs.has(workerUrl)) throw new Error("Undeclared Worker URL");
    }

    postMessage(data: unknown) {
      void (async () => {
        const blob = blobs.get(this.workerUrl);
        if (!blob) throw new Error("Worker source is missing");
        const source = await blob.text();
        const worker = vm.createContext({
          self: { fonts },
          OffscreenCanvas: class {
            constructor(width: number, height: number) {
              workerCanvasCreated(width, height);
            }
            getContext(kind: string) { return canvas("worker").getContext(kind); }
          },
          postMessage: (value: unknown) => this.onmessage?.({ data: structuredClone(value) }),
          close: workerClose,
          __fixtureMessage: structuredClone(data),
        });
        // Execute the producer's actual Blob and serialized captureCanvasContext
        // in a Worker realm without document or imported production helpers.
        vm.runInContext(source, worker, { timeout: 1000 });
        await vm.runInContext("onmessage({ data: __fixtureMessage })", worker, { timeout: 1000 });
      })().catch((error: unknown) => {
        this.onerror?.({ message: error instanceof Error ? error.message : String(error) });
      });
    }
  }

  const globals = {
    document: {
      fonts,
      documentElement: { appendChild: vi.fn() },
      createElement(tag: string) {
        if (tag === "canvas") return canvas("window");
        if (tag === "span") {
          const span = {
            textContent: "",
            style: { cssText: "" },
            getBoundingClientRect: () => ({ width: span.textContent.length * 5, height: 32 }),
            remove: vi.fn(),
          };
          return span;
        }
        throw new Error(`Undeclared DOM element: ${tag}`);
      },
    },
    queryLocalFonts,
    Worker: FixtureWorker,
    URL: url,
    Blob,
    console: { debug: vi.fn() },
    setTimeout,
    clearTimeout,
  };

  function capture(options?: CaptureOptions): Promise<FontCorpus> {
    if (invocation === "imported module") {
      for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
      return options === undefined ? captureWithOptions() : captureWithOptions(options);
    }
    const argument = options === undefined ? "" : JSON.stringify(options);
    return vm.runInNewContext(
      `(${captureFontCorpusInPage.toString()})(${argument})`,
      globals,
      { timeout: 1000 },
    ) as Promise<FontCorpus>;
  }

  return { capture, queryLocalFonts, terminate, workerClose, workerCanvasCreated, url, blobs };
}

function expectRetainedHashMaterial(result: FontCorpus): void {
  expect(Object.keys(result.window).sort()).toEqual([
    "availability", "domGenericMetrics", "domNamedMetrics", "fontSetAvailable",
    "genericMetrics", "namedMetrics", "raster",
  ]);
  expect(Object.keys(result.worker).sort()).toEqual([
    "availability", "fontSetAvailable", "genericMetrics", "namedMetrics", "raster",
  ]);
  for (const arm of [result.window, result.worker]) {
    expect(arm.fontSetAvailable).toBe(true);
    expect(Object.keys(arm.availability).length).toBeGreaterThan(0);
    expect(Object.values(arm.availability).every((value) => typeof value === "boolean")).toBe(true);
    expect(arm.genericMetrics["sans-serif|normal|latin"]).toEqual({
      width: expect.any(Number),
      actualBoundingBoxLeft: expect.any(Number),
      actualBoundingBoxRight: expect.any(Number),
      actualBoundingBoxAscent: expect.any(Number),
      actualBoundingBoxDescent: expect.any(Number),
      fontBoundingBoxAscent: expect.any(Number),
      fontBoundingBoxDescent: expect.any(Number),
      emHeightAscent: expect.any(Number),
      emHeightDescent: expect.any(Number),
      hangingBaseline: expect.any(Number),
      alphabeticBaseline: expect.any(Number),
      ideographicBaseline: expect.any(Number),
    });
    expect(arm.namedMetrics["Arial|normal|latin"].width).toBeGreaterThan(0);
    expect(Object.keys(arm.raster).length).toBeGreaterThan(0);
    for (const raster of Object.values(arm.raster)) {
      expect(raster.maskHash).toMatch(/^[0-9a-f]{8}$/);
      expect(raster.colorHash).toMatch(/^[0-9a-f]{8}$/);
      expect(raster.inkPixels).toBeGreaterThan(0);
      expect(raster.bounds).toHaveLength(4);
    }
  }
  expect(result.window.domGenericMetrics["sans-serif|latin"].width).toBeGreaterThan(0);
  expect(result.window.domNamedMetrics["Arial|latin"].height).toBeGreaterThan(0);
  // Distinct boundary inputs must actually reach both original capture arms.
  expect(result.worker.genericMetrics["sans-serif|normal|latin"].width)
    .not.toBe(result.window.genericMetrics["sans-serif|normal|latin"].width);
  expect(JSON.stringify({ window: result.window, worker: result.worker }).length).toBeGreaterThan(100);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(["imported module", "serialized source"] as const)("font local-access boundary: %s", (invocation) => {
  it("explicit false makes zero local-font queries while retaining window/Worker hash material", async () => {
    const f = fixture(invocation);
    f.queryLocalFonts.mockRejectedValue(new Error("Local Font Access must not be requested by this capture"));
    const result = await f.capture({ includeLocalAccess: false });

    expect(f.queryLocalFonts).not.toHaveBeenCalled();
    expect(result.localAccess.available).toBe(true);
    expect(result.localAccess.entries).toEqual([]);
    expect(result.localAccess.error).toMatch(/not requested/i);
    expectRetainedHashMaterial(result);
    expect(f.workerCanvasCreated).toHaveBeenCalled();
    expect(f.terminate).toHaveBeenCalledOnce();
    expect(f.workerClose).toHaveBeenCalledOnce();
    expect(f.url.revokeObjectURL).toHaveBeenCalledWith("blob:font-corpus-local-access-unit");
    expect(f.blobs.size).toBe(0);
  });

  it("default capture still queries local fonts and preserves returned metadata", async () => {
    const f = fixture(invocation);
    const first = { postscriptName: "Fixture-A", fullName: "Fixture A", family: "Fixture", style: "Regular" };
    const second = { postscriptName: "Fixture-B", fullName: "Fixture B", family: "Fixture", style: "Bold" };
    f.queryLocalFonts.mockResolvedValue([second, first]);
    const result = await f.capture();

    expect(f.queryLocalFonts).toHaveBeenCalledOnce();
    expect(result.localAccess).toEqual({ available: true, entries: [first, second], error: null });
    expectRetainedHashMaterial(result);
    expect(f.terminate).toHaveBeenCalledOnce();
    expect(f.blobs.size).toBe(0);
  });

  it("default capture retains the original local-font rejection instead of reporting empty success", async () => {
    const f = fixture(invocation);
    const denied = Object.assign(new Error("fixture local-font permission denied"), { name: "NotAllowedError" });
    f.queryLocalFonts.mockRejectedValue(denied);
    const result = await f.capture();

    expect(f.queryLocalFonts).toHaveBeenCalledOnce();
    expect(result.localAccess).toEqual({
      available: true,
      entries: [],
      error: "NotAllowedError: fixture local-font permission denied",
    });
    expectRetainedHashMaterial(result);
    expect(f.terminate).toHaveBeenCalledOnce();
    expect(f.blobs.size).toBe(0);
  });
});
