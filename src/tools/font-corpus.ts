/// <reference lib="dom" />

export interface FontMetricIdentity {
  width: number;
  actualBoundingBoxLeft: number | null;
  actualBoundingBoxRight: number | null;
  actualBoundingBoxAscent: number | null;
  actualBoundingBoxDescent: number | null;
  fontBoundingBoxAscent: number | null;
  fontBoundingBoxDescent: number | null;
  emHeightAscent: number | null;
  emHeightDescent: number | null;
  hangingBaseline: number | null;
  alphabeticBaseline: number | null;
  ideographicBaseline: number | null;
}

export interface FontRasterIdentity {
  maskHash: string;
  colorHash: string;
  inkPixels: number;
  bounds: [number, number, number, number] | null;
}

export interface FontCanvasCorpus {
  fontSetAvailable: boolean;
  availability: Record<string, boolean>;
  genericMetrics: Record<string, FontMetricIdentity>;
  namedMetrics: Record<string, FontMetricIdentity>;
  raster: Record<string, FontRasterIdentity>;
}

export interface FontLocalAccessCorpus {
  available: boolean;
  entries: Array<{
    postscriptName: string;
    fullName: string;
    family: string;
    style: string;
  }>;
  error: string | null;
}

export interface FontCorpus {
  window: FontCanvasCorpus & {
    domGenericMetrics: Record<string, { width: number; height: number }>;
    domNamedMetrics: Record<string, { width: number; height: number }>;
  };
  worker: FontCanvasCorpus;
  localAccess: FontLocalAccessCorpus;
}

/**
 * Capture font availability, fallback metrics and quantized glyph rasters.
 * Quantizing colors to four bits removes the managed one-bit Canvas noise
 * while retaining glyph shape, antialiasing and color-emoji differences.
 * The function is self-contained so it can run unchanged in Stock Chrome,
 * RoxyChrome and the independent managed build.
 */
export async function captureFontCorpusInPage(): Promise<FontCorpus> {
  const progress = (stage: string): void => {
    try { console.debug(`[font-corpus:page] ${stage}`); } catch { /* ignore */ }
  };
  const candidateFonts = [
    "Arial", "Arial Unicode MS", "Avenir", "Calibri", "Cambria",
    "Comic Sans MS", "Consolas", "Courier New", "Georgia", "Helvetica",
    "Helvetica Neue", "Hiragino Kaku Gothic ProN", "Hoefler Text", "Impact",
    "Liberation Sans", "Malgun Gothic", "Meiryo", "Menlo", "Microsoft YaHei",
    "Monaco", "Noto Color Emoji", "Noto Sans", "Optima", "Palatino",
    "PingFang SC", "PingFang TC", "San Francisco", "Segoe UI",
    "Segoe UI Emoji", "SimSun", "Tahoma", "Times", "Times New Roman",
    "Trebuchet MS", "Ubuntu", "Verdana", "Yu Gothic", "Apple Color Emoji",
    "Roxy Definitely Missing Font",
  ];
  const genericFamilies = [
    "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
    "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji",
    "math", "fangsong",
  ];
  const texts = [
    ["latin", "RoxyFont 0123456789 AWilgm fi ffi"],
    ["greek", "Ελληνικά Ωμέγα 123"],
    ["cyrillic", "Русский шрифт 123"],
    ["arabic", "الخط العربي ١٢٣"],
    ["devanagari", "देवनागरी लिपि १२३"],
    ["thai", "ภาษาไทย ๑๒๓"],
    ["cjk", "中文字体測試かなカナ"],
    ["hangul", "한글 글꼴 테스트 123"],
    ["emoji", "😀 🧑🏽‍💻 👨‍👩‍👧‍👦 🇨🇳 ⚙️"],
    ["math", "∫₀∞ x² dx ≠ √π ℵ₀"],
  ] as const;
  const styleCases = [
    ["normal", "normal 400"],
    ["bold", "normal 700"],
    ["italic", "italic 400"],
  ] as const;

  async function captureCanvasContext(
    createCanvas: (width: number, height: number) => HTMLCanvasElement | OffscreenCanvas,
    fontSet: { check(font: string, text?: string): boolean } | null,
    candidates: string[],
    generics: string[],
    samples: ReadonlyArray<readonly [string, string]>,
    styles: ReadonlyArray<readonly [string, string]>,
  ): Promise<FontCanvasCorpus> {
    const round = (value: unknown): number | null => {
      return typeof value === "number" && Number.isFinite(value)
        ? Math.round(value * 10000) / 10000
        : null;
    };
    const familyCss = (family: string, generic: boolean): string => {
      return generic ? family : `"${family.replace(/["\\]/g, "")}"`;
    };
    const fontCss = (family: string, generic: boolean, style: string, size: number): string => {
      return `${style} ${size}px ${familyCss(family, generic)}`;
    };
    const measure = (
      context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
      text: string,
    ): FontMetricIdentity => {
      const metric = context.measureText(text) as TextMetrics & Record<string, unknown>;
      return {
        width: round(metric.width) || 0,
        actualBoundingBoxLeft: round(metric.actualBoundingBoxLeft),
        actualBoundingBoxRight: round(metric.actualBoundingBoxRight),
        actualBoundingBoxAscent: round(metric.actualBoundingBoxAscent),
        actualBoundingBoxDescent: round(metric.actualBoundingBoxDescent),
        fontBoundingBoxAscent: round(metric.fontBoundingBoxAscent),
        fontBoundingBoxDescent: round(metric.fontBoundingBoxDescent),
        emHeightAscent: round(metric.emHeightAscent),
        emHeightDescent: round(metric.emHeightDescent),
        hangingBaseline: round(metric.hangingBaseline),
        alphabeticBaseline: round(metric.alphabeticBaseline),
        ideographicBaseline: round(metric.ideographicBaseline),
      };
    };
    const fnvUpdate = (state: number, value: number): number => {
      state ^= value & 0xff;
      return Math.imul(state, 16777619) >>> 0;
    };
    const rasterize = (family: string, generic: boolean, text: string): FontRasterIdentity => {
      const canvas = createCanvas(384, 112);
      const context = canvas.getContext("2d", { willReadFrequently: true }) as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (!context) throw new Error("2D font raster context unavailable");
      context.fillStyle = "rgb(255,255,255)";
      context.fillRect(0, 0, 384, 112);
      context.fillStyle = "rgb(0,0,0)";
      context.textBaseline = "alphabetic";
      context.fontKerning = "normal";
      context.font = fontCss(family, generic, "normal 400", 48);
      context.fillText(text, 8, 78, 368);
      const pixels = context.getImageData(0, 0, 384, 112).data;
      let maskHash = 2166136261;
      let colorHash = 2166136261;
      let inkPixels = 0;
      let minX = 384;
      let minY = 112;
      let maxX = -1;
      let maxY = -1;
      for (let index = 0, pixel = 0; index < pixels.length; index += 4, pixel++) {
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        const alpha = pixels[index + 3];
        const ink = Math.max(255 - red, 255 - green, 255 - blue) >= 32 ? 1 : 0;
        maskHash = fnvUpdate(maskHash, ink);
        colorHash = fnvUpdate(colorHash, red >>> 4);
        colorHash = fnvUpdate(colorHash, green >>> 4);
        colorHash = fnvUpdate(colorHash, blue >>> 4);
        colorHash = fnvUpdate(colorHash, alpha >>> 4);
        if (ink) {
          inkPixels++;
          const x = pixel % 384;
          const y = Math.floor(pixel / 384);
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      return {
        maskHash: (maskHash >>> 0).toString(16).padStart(8, "0"),
        colorHash: (colorHash >>> 0).toString(16).padStart(8, "0"),
        inkPixels,
        bounds: inkPixels ? [minX, minY, maxX, maxY] : null,
      };
    };

    const metricCanvas = createCanvas(32, 32);
    const context = metricCanvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!context) throw new Error("2D font metric context unavailable");
    context.textBaseline = "alphabetic";
    context.fontKerning = "normal";
    const availability: Record<string, boolean> = {};
    const availabilityText = "mmmmmmmmmmlliWW123";
    const availabilityFallbacks = ["serif", "sans-serif", "monospace"];
    const fallbackWidths = new Map<string, number>();
    for (const fallback of availabilityFallbacks) {
      context.font = fontCss(fallback, true, "normal 400", 72);
      fallbackWidths.set(fallback, context.measureText(availabilityText).width);
    }
    for (const family of candidates) {
      let detected = false;
      for (const fallback of availabilityFallbacks) {
        context.font = `normal 400 72px ${familyCss(family, false)}, ${fallback}`;
        if (Math.abs(context.measureText(availabilityText).width - (fallbackWidths.get(fallback) || 0)) > 0.01) {
          detected = true;
          break;
        }
      }
      try {
        availability[family] = detected && Boolean(
          fontSet?.check(`16px ${familyCss(family, false)}`, availabilityText),
        );
      } catch {
        availability[family] = detected;
      }
    }
    const genericMetrics: Record<string, FontMetricIdentity> = {};
    for (const family of generics) {
      for (const [styleName, style] of styles) {
        context.font = fontCss(family, true, style, 32);
        for (const [textName, text] of samples) {
          genericMetrics[`${family}|${styleName}|${textName}`] = measure(context, text);
        }
      }
    }
    const namedMetrics: Record<string, FontMetricIdentity> = {};
    for (const family of candidates) {
      context.font = fontCss(family, false, "normal 400", 32);
      for (const [textName, text] of samples) {
        namedMetrics[`${family}|normal|${textName}`] = measure(context, text);
      }
      for (const [styleName, style] of styles.slice(1)) {
        context.font = fontCss(family, false, style, 32);
        namedMetrics[`${family}|${styleName}|latin`] = measure(context, samples[0][1]);
      }
    }

    const raster: Record<string, FontRasterIdentity> = {};
    for (const family of generics) {
      for (const [textName, text] of samples) {
        raster[`${family}|${textName}`] = rasterize(family, true, text);
      }
    }
    for (const family of candidates) {
      for (const textName of ["latin", "cjk", "emoji"] as const) {
        const text = samples.find(([name]) => name === textName)?.[1] || samples[0][1];
        raster[`${family}|${textName}`] = rasterize(family, false, text);
      }
    }
    return {
      fontSetAvailable: Boolean(fontSet),
      availability,
      genericMetrics,
      namedMetrics,
      raster,
    };
  }

  progress("window canvas begin");
  const windowCanvas = await captureCanvasContext(
    (width, height) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    document.fonts,
    candidateFonts,
    genericFamilies,
    texts,
    styleCases,
  );
  progress("window canvas complete");

  const roundDom = (value: number): number => Math.round(value * 10000) / 10000;
  const captureDom = (family: string, generic: boolean, text: string): { width: number; height: number } => {
    const span = document.createElement("span");
    span.textContent = text;
    span.style.cssText = [
      "position:fixed", "left:-10000px", "top:-10000px", "white-space:pre",
      "font-size:32px", "font-style:normal", "font-weight:400", "font-kerning:normal",
      `font-family:${generic ? family : `"${family.replace(/["\\]/g, "")}"`}`,
    ].join(";");
    document.documentElement.appendChild(span);
    const rect = span.getBoundingClientRect();
    span.remove();
    return { width: roundDom(rect.width), height: roundDom(rect.height) };
  };
  const domGenericMetrics: Record<string, { width: number; height: number }> = {};
  for (const family of genericFamilies) {
    for (const [textName, text] of texts) {
      domGenericMetrics[`${family}|${textName}`] = captureDom(family, true, text);
    }
  }
  const domNamedMetrics: Record<string, { width: number; height: number }> = {};
  for (const family of candidateFonts) {
    domNamedMetrics[`${family}|latin`] = captureDom(family, false, texts[0][1]);
  }
  progress("DOM metrics complete");

  const localAccess: FontLocalAccessCorpus = { available: false, entries: [], error: null };
  const queryLocalFonts = (globalThis as typeof globalThis & {
    queryLocalFonts?: () => Promise<Array<{
      postscriptName?: string;
      fullName?: string;
      family?: string;
      style?: string;
    }>>;
  }).queryLocalFonts;
  if (typeof queryLocalFonts === "function") {
    localAccess.available = true;
    try {
      const entries = await queryLocalFonts();
      localAccess.entries = entries.map((entry) => ({
        postscriptName: String(entry.postscriptName || ""),
        fullName: String(entry.fullName || ""),
        family: String(entry.family || ""),
        style: String(entry.style || ""),
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    } catch (error) {
      localAccess.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }
  progress("Local Font Access complete");

  const workerSource = [
    `const captureCanvasContext=${captureCanvasContext.toString()};`,
    "onmessage=async function(event){try{",
    "const d=event.data;const result=await captureCanvasContext(",
    "(w,h)=>new OffscreenCanvas(w,h),self.fonts||null,d.candidates,d.generics,d.samples,d.styles);",
    "postMessage(result);}catch(error){postMessage({fatalError:String(error)});}finally{close();}};",
  ].join("");
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  try {
    progress("worker canvas begin");
    const worker = new Worker(workerUrl);
    const workerCanvas = await new Promise<FontCanvasCorpus>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("Font Worker corpus timed out"));
      }, 30_000);
      worker.onmessage = (event: MessageEvent<FontCanvasCorpus & { fatalError?: string }>) => {
        clearTimeout(timer);
        worker.terminate();
        if (event.data.fatalError) reject(new Error(event.data.fatalError));
        else resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message || "Font Worker corpus failed"));
      };
      worker.postMessage({
        candidates: candidateFonts,
        generics: genericFamilies,
        samples: texts,
        styles: styleCases,
      });
    });
    progress("worker canvas complete");
    return {
      window: { ...windowCanvas, domGenericMetrics, domNamedMetrics },
      worker: workerCanvas,
      localAccess,
    };
  } finally {
    URL.revokeObjectURL(workerUrl);
  }
}
