/// <reference lib="dom" />

export type WebGlParameterValue = string | number | boolean | null | number[] | string[];

export interface WebGlShaderPrecisionIdentity {
  rangeMin: number;
  rangeMax: number;
  precision: number;
}

export interface WebGlContextCorpus {
  version: 1 | 2;
  vendor: string | null;
  renderer: string | null;
  unmaskedVendor: string | null;
  unmaskedRenderer: string | null;
  contextAttributes: Record<string, boolean | null>;
  extensions: string[];
  parameters: Record<string, WebGlParameterValue>;
  shaderPrecision: Record<string, WebGlShaderPrecisionIdentity | null>;
}

export interface WebGlCorpus {
  window: {
    webgl1: WebGlContextCorpus | null;
    webgl2: WebGlContextCorpus | null;
  };
  worker: {
    webgl1: WebGlContextCorpus | null;
    webgl2: WebGlContextCorpus | null;
  };
}

/**
 * Capture the stable WebGL 1/2 capability surface used for GPU-coherence
 * acceptance. The function is self-contained so Playwright can serialize it
 * into both stock and managed browser pages without installing page scripts.
 */
export async function captureWebGlCorpusInPage(): Promise<WebGlCorpus> {
  function captureContext(
    gl: WebGLRenderingContext | WebGL2RenderingContext | null,
    version: 1 | 2,
  ): WebGlContextCorpus | null {
    if (!gl) return null;

    const normalize = (value: unknown): WebGlParameterValue => {
      if (value === null || value === undefined) return null;
      if (typeof value === "string" || typeof value === "boolean") return value;
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
      if (ArrayBuffer.isView(value)) {
        return Array.from(value as unknown as ArrayLike<number>).map((item) => Number(item));
      }
      if (Array.isArray(value)) {
        return value.map((item) => typeof item === "number" ? item : String(item)) as number[] | string[];
      }
      return String(value);
    };

    const extensions = [...(gl.getSupportedExtensions() || [])].sort();
    // Enabling supported extensions makes extension-owned capability enums,
    // including COMPRESSED_TEXTURE_FORMATS, observable in their stock shape.
    for (const name of extensions) {
      try { gl.getExtension(name); } catch { /* keep capturing the remaining corpus */ }
    }

    const debug = gl.getExtension("WEBGL_debug_renderer_info") as {
      UNMASKED_VENDOR_WEBGL: number;
      UNMASKED_RENDERER_WEBGL: number;
    } | null;
    const parameterNames = [
      "ALIASED_LINE_WIDTH_RANGE",
      "ALIASED_POINT_SIZE_RANGE",
      "ALPHA_BITS",
      "BLUE_BITS",
      "COMPRESSED_TEXTURE_FORMATS",
      "DEPTH_BITS",
      "GREEN_BITS",
      "MAX_COMBINED_TEXTURE_IMAGE_UNITS",
      "MAX_CUBE_MAP_TEXTURE_SIZE",
      "MAX_FRAGMENT_UNIFORM_VECTORS",
      "MAX_RENDERBUFFER_SIZE",
      "MAX_TEXTURE_IMAGE_UNITS",
      "MAX_TEXTURE_SIZE",
      "MAX_VARYING_VECTORS",
      "MAX_VERTEX_ATTRIBS",
      "MAX_VERTEX_TEXTURE_IMAGE_UNITS",
      "MAX_VERTEX_UNIFORM_VECTORS",
      "MAX_VIEWPORT_DIMS",
      "RED_BITS",
      "SAMPLE_BUFFERS",
      "SAMPLES",
      "STENCIL_BITS",
      "SUBPIXEL_BITS",
    ];
    if (version === 2) {
      parameterNames.push(
        "MAX_3D_TEXTURE_SIZE",
        "MAX_ARRAY_TEXTURE_LAYERS",
        "MAX_CLIENT_WAIT_TIMEOUT_WEBGL",
        "MAX_COLOR_ATTACHMENTS",
        "MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS",
        "MAX_COMBINED_UNIFORM_BLOCKS",
        "MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS",
        "MAX_DRAW_BUFFERS",
        "MAX_ELEMENT_INDEX",
        "MAX_ELEMENTS_INDICES",
        "MAX_ELEMENTS_VERTICES",
        "MAX_FRAGMENT_INPUT_COMPONENTS",
        "MAX_FRAGMENT_UNIFORM_BLOCKS",
        "MAX_FRAGMENT_UNIFORM_COMPONENTS",
        "MAX_PROGRAM_TEXEL_OFFSET",
        "MAX_SAMPLES",
        "MAX_SERVER_WAIT_TIMEOUT",
        "MAX_TEXTURE_LOD_BIAS",
        "MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS",
        "MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS",
        "MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS",
        "MAX_UNIFORM_BLOCK_SIZE",
        "MAX_UNIFORM_BUFFER_BINDINGS",
        "MAX_VARYING_COMPONENTS",
        "MAX_VERTEX_OUTPUT_COMPONENTS",
        "MAX_VERTEX_UNIFORM_BLOCKS",
        "MAX_VERTEX_UNIFORM_COMPONENTS",
        "MIN_PROGRAM_TEXEL_OFFSET",
        "UNIFORM_BUFFER_OFFSET_ALIGNMENT",
      );
    }

    const parameters: Record<string, WebGlParameterValue> = {};
    for (const name of parameterNames) {
      const constant = (gl as unknown as Record<string, unknown>)[name];
      if (typeof constant !== "number") continue;
      try {
        parameters[name] = normalize(gl.getParameter(constant));
      } catch {
        parameters[name] = null;
      }
    }
    const anisotropy = gl.getExtension("EXT_texture_filter_anisotropic") as {
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: number;
    } | null;
    if (anisotropy) {
      parameters.MAX_TEXTURE_MAX_ANISOTROPY_EXT = normalize(
        gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT),
      );
    }
    if (version === 1) {
      const drawBuffers = gl.getExtension("WEBGL_draw_buffers") as {
        MAX_DRAW_BUFFERS_WEBGL: number;
        MAX_COLOR_ATTACHMENTS_WEBGL: number;
      } | null;
      if (drawBuffers) {
        parameters.MAX_DRAW_BUFFERS_WEBGL = normalize(gl.getParameter(drawBuffers.MAX_DRAW_BUFFERS_WEBGL));
        parameters.MAX_COLOR_ATTACHMENTS_WEBGL = normalize(
          gl.getParameter(drawBuffers.MAX_COLOR_ATTACHMENTS_WEBGL),
        );
      }
    }

    const shaderPrecision: Record<string, WebGlShaderPrecisionIdentity | null> = {};
    for (const [shaderName, shaderType] of [
      ["VERTEX", gl.VERTEX_SHADER],
      ["FRAGMENT", gl.FRAGMENT_SHADER],
    ] as const) {
      for (const [precisionName, precisionType] of [
        ["LOW_FLOAT", gl.LOW_FLOAT],
        ["MEDIUM_FLOAT", gl.MEDIUM_FLOAT],
        ["HIGH_FLOAT", gl.HIGH_FLOAT],
        ["LOW_INT", gl.LOW_INT],
        ["MEDIUM_INT", gl.MEDIUM_INT],
        ["HIGH_INT", gl.HIGH_INT],
      ] as const) {
        const format = gl.getShaderPrecisionFormat(shaderType, precisionType);
        shaderPrecision[`${shaderName}_${precisionName}`] = format ? {
          rangeMin: format.rangeMin,
          rangeMax: format.rangeMax,
          precision: format.precision,
        } : null;
      }
    }

    const attributes = gl.getContextAttributes();
    return {
      version,
      vendor: String(gl.getParameter(gl.VENDOR) ?? "") || null,
      renderer: String(gl.getParameter(gl.RENDERER) ?? "") || null,
      unmaskedVendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) ?? "") || null : null,
      unmaskedRenderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? "") || null : null,
      contextAttributes: {
        alpha: attributes?.alpha ?? null,
        antialias: attributes?.antialias ?? null,
        depth: attributes?.depth ?? null,
        desynchronized: attributes?.desynchronized ?? null,
        failIfMajorPerformanceCaveat: attributes?.failIfMajorPerformanceCaveat ?? null,
        premultipliedAlpha: attributes?.premultipliedAlpha ?? null,
        preserveDrawingBuffer: attributes?.preserveDrawingBuffer ?? null,
        stencil: attributes?.stencil ?? null,
      },
      extensions,
      parameters,
      shaderPrecision,
    };
  }

  const windowCorpus = {
    webgl1: captureContext(document.createElement("canvas").getContext("webgl"), 1),
    webgl2: captureContext(document.createElement("canvas").getContext("webgl2"), 2),
  };

  const workerSource = [
    `const captureContext=${captureContext.toString()};`,
    "onmessage=function(){try{postMessage({",
    "webgl1:captureContext(new OffscreenCanvas(16,16).getContext('webgl'),1),",
    "webgl2:captureContext(new OffscreenCanvas(16,16).getContext('webgl2'),2)",
    "});}catch(error){postMessage({error:String(error)});}finally{close();}};",
  ].join("");
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  try {
    const workerCorpus = await new Promise<WebGlCorpus["worker"]>((resolve, reject) => {
      const worker = new Worker(workerUrl);
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("WebGL Worker corpus timed out"));
      }, 10_000);
      worker.onmessage = (event: MessageEvent<WebGlCorpus["worker"] & { error?: string }>) => {
        clearTimeout(timer);
        worker.terminate();
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message || "WebGL Worker corpus failed"));
      };
      worker.postMessage(1);
    });
    return { window: windowCorpus, worker: workerCorpus };
  } finally {
    URL.revokeObjectURL(workerUrl);
  }
}
