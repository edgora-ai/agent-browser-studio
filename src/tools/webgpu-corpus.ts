/// <reference lib="dom" />

export interface WebGpuContextCorpus {
  available: boolean;
  adapter: {
    info: Record<string, string | number | boolean | null>;
    features: string[];
    limits: Record<string, number | string>;
  } | null;
  device: {
    adapterInfo: Record<string, string | number | boolean | null> | null;
    features: string[];
    limits: Record<string, number | string>;
  } | null;
  preferredCanvasFormat: string | null;
  wgslLanguageFeatures: string[];
  error: string | null;
}

export interface WebGpuCorpus {
  window: WebGpuContextCorpus;
  worker: WebGpuContextCorpus;
}

/** Self-contained WebGPU adapter/device capability capture for page/Worker use. */
export async function captureWebGpuCorpusInPage(): Promise<WebGpuCorpus> {
  async function captureContext(): Promise<WebGpuContextCorpus> {
    const gpu = (navigator as Navigator & {
      gpu?: {
        requestAdapter(options?: Record<string, unknown>): Promise<any>;
        getPreferredCanvasFormat?(): string;
        wgslLanguageFeatures?: Iterable<string>;
      };
    }).gpu;
    if (!gpu) {
      return {
        available: false,
        adapter: null,
        device: null,
        preferredCanvasFormat: null,
        wgslLanguageFeatures: [],
        error: null,
      };
    }

    const readInfo = (info: any): Record<string, string | number | boolean | null> => {
      const result: Record<string, string | number | boolean | null> = {};
      for (const name of [
        "vendor", "architecture", "device", "description",
        "subgroupMinSize", "subgroupMaxSize", "isFallbackAdapter",
      ]) {
        try {
          const value = info?.[name];
          result[name] = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
            ? value
            : null;
        } catch {
          result[name] = null;
        }
      }
      return result;
    };
    const readLimits = (limits: any): Record<string, number | string> => {
      const names = new Set<string>();
      let cursor = limits;
      while (cursor && cursor !== Object.prototype) {
        for (const name of Object.getOwnPropertyNames(cursor)) {
          if (name !== "constructor") names.add(name);
        }
        cursor = Object.getPrototypeOf(cursor);
      }
      const result: Record<string, number | string> = {};
      for (const name of [...names].sort()) {
        try {
          const value = limits[name];
          if (typeof value === "number") result[name] = Number.isFinite(value) ? value : String(value);
          else if (typeof value === "bigint") result[name] = value.toString();
        } catch { /* omit inaccessible prototype properties */ }
      }
      return result;
    };
    const readFeatures = (features: Iterable<string> | undefined): string[] => {
      try { return [...(features || [])].map(String).sort(); }
      catch { return []; }
    };

    let device: any = null;
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) {
        return {
          available: true,
          adapter: null,
          device: null,
          preferredCanvasFormat: gpu.getPreferredCanvasFormat?.() || null,
          wgslLanguageFeatures: readFeatures(gpu.wgslLanguageFeatures),
          error: "requestAdapter returned null",
        };
      }
      device = await adapter.requestDevice();
      return {
        available: true,
        adapter: {
          info: readInfo(adapter.info),
          features: readFeatures(adapter.features),
          limits: readLimits(adapter.limits),
        },
        device: {
          adapterInfo: device.adapterInfo ? readInfo(device.adapterInfo) : null,
          features: readFeatures(device.features),
          limits: readLimits(device.limits),
        },
        preferredCanvasFormat: gpu.getPreferredCanvasFormat?.() || null,
        wgslLanguageFeatures: readFeatures(gpu.wgslLanguageFeatures),
        error: null,
      };
    } catch (error) {
      return {
        available: true,
        adapter: null,
        device: null,
        preferredCanvasFormat: gpu.getPreferredCanvasFormat?.() || null,
        wgslLanguageFeatures: readFeatures(gpu.wgslLanguageFeatures),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      try { device?.destroy?.(); } catch { /* best effort */ }
    }
  }

  const windowCorpus = await captureContext();
  const workerSource = [
    `const captureContext=${captureContext.toString()};`,
    "onmessage=async function(){try{postMessage(await captureContext());}",
    "catch(error){postMessage({available:false,adapter:null,device:null,preferredCanvasFormat:null,wgslLanguageFeatures:[],error:String(error)});}",
    "finally{close();}};",
  ].join("");
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  try {
    const workerCorpus = await new Promise<WebGpuContextCorpus>((resolve, reject) => {
      const worker = new Worker(workerUrl);
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("WebGPU Worker corpus timed out"));
      }, 15_000);
      worker.onmessage = (event: MessageEvent<WebGpuContextCorpus>) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message || "WebGPU Worker corpus failed"));
      };
      worker.postMessage(1);
    });
    return { window: windowCorpus, worker: workerCorpus };
  } finally {
    URL.revokeObjectURL(workerUrl);
  }
}
