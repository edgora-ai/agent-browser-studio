/// <reference lib="dom" />

export interface StorageQuotaIdentity {
  available: boolean;
  quota: number | null;
  grantedQuota: number | null;
  usageDetailKeys: string[];
  error: string | null;
}

export interface StorageContextCorpus {
  modern: StorageQuotaIdentity & { persisted: boolean | null };
  bucket: StorageQuotaIdentity & {
    persisted: boolean | null;
    durability: string | null;
    directoryAvailable: boolean;
  };
  legacyTemporary: StorageQuotaIdentity;
  legacyPersistent: StorageQuotaIdentity;
  opfs: { available: boolean; roundTrip: boolean; error: string | null };
  webkitFileSystem: { available: boolean; opened: boolean; error: string | null };
}

export interface StorageCorpus {
  window: StorageContextCorpus;
  worker: StorageContextCorpus;
}

/** Capture modern, bucket, legacy and filesystem storage identity surfaces. */
export async function captureStorageCorpusInPage(requestedQuotaBytes: number): Promise<StorageCorpus> {
  async function captureContext(requestedQuota: number): Promise<StorageContextCorpus> {
    const nav = navigator as Navigator & {
      storage: StorageManager & { getDirectory?: () => Promise<any> };
      storageBuckets?: {
        open(name: string): Promise<any>;
        delete(name: string): Promise<void>;
      };
      webkitTemporaryStorage?: any;
      webkitPersistentStorage?: any;
    };
    const queryLegacy = async (storage: any): Promise<StorageQuotaIdentity> => {
      if (!storage?.queryUsageAndQuota) {
        return { available: false, quota: null, grantedQuota: null, usageDetailKeys: [], error: null };
      }
      const queried = await new Promise<{ quota: number | null; error: string | null }>((resolve) => {
        const timer = setTimeout(() => resolve({ quota: null, error: "queryUsageAndQuota timed out" }), 5000);
        storage.queryUsageAndQuota(
          (_usage: number, quota: number) => {
            clearTimeout(timer);
            resolve({ quota, error: null });
          },
          (error: unknown) => {
            clearTimeout(timer);
            resolve({ quota: null, error: String(error) });
          },
        );
      });
      let grantedQuota: number | null = null;
      let requestError: string | null = null;
      if (storage.requestQuota) {
        const requested = await new Promise<{ quota: number | null; error: string | null }>((resolve) => {
          const timer = setTimeout(() => resolve({ quota: null, error: "requestQuota timed out" }), 5000);
          storage.requestQuota(
            requestedQuota,
            (quota: number) => {
              clearTimeout(timer);
              resolve({ quota, error: null });
            },
            (error: unknown) => {
              clearTimeout(timer);
              resolve({ quota: null, error: String(error) });
            },
          );
        });
        grantedQuota = requested.quota;
        requestError = requested.error;
      }
      return {
        available: true,
        quota: queried.quota,
        grantedQuota,
        usageDetailKeys: [],
        error: queried.error || requestError,
      };
    };

    const modern: StorageContextCorpus["modern"] = {
      available: Boolean(nav.storage?.estimate),
      quota: null,
      grantedQuota: null,
      usageDetailKeys: [],
      persisted: null,
      error: null,
    };
    try {
      const estimate = await nav.storage.estimate() as StorageEstimate & {
        usageDetails?: Record<string, unknown>;
      };
      modern.quota = estimate.quota ?? null;
      modern.usageDetailKeys = Object.keys(estimate.usageDetails || {}).sort();
      modern.persisted = nav.storage.persisted ? await nav.storage.persisted() : null;
    } catch (error) {
      modern.error = error instanceof Error ? error.message : String(error);
    }

    const bucket: StorageContextCorpus["bucket"] = {
      available: Boolean(nav.storageBuckets),
      quota: null,
      grantedQuota: null,
      usageDetailKeys: [],
      persisted: null,
      durability: null,
      directoryAvailable: false,
      error: null,
    };
    if (nav.storageBuckets) {
      const bucketName = "roxy-storage-corpus";
      try {
        const handle = await nav.storageBuckets.open(bucketName);
        const estimate = await handle.estimate();
        bucket.quota = estimate.quota ?? null;
        bucket.usageDetailKeys = Object.keys(estimate.usageDetails || {}).sort();
        bucket.persisted = handle.persisted ? await handle.persisted() : null;
        bucket.durability = handle.durability ? await handle.durability() : null;
        bucket.directoryAvailable = Boolean(handle.getDirectory && await handle.getDirectory());
      } catch (error) {
        bucket.error = error instanceof Error ? error.message : String(error);
      } finally {
        try { await nav.storageBuckets.delete(bucketName); } catch { /* best effort */ }
      }
    }

    const opfs: StorageContextCorpus["opfs"] = { available: false, roundTrip: false, error: null };
    if (nav.storage?.getDirectory) {
      opfs.available = true;
      const fileName = "roxy-storage-corpus.bin";
      try {
        const root = await nav.storage.getDirectory();
        const handle = await root.getFileHandle(fileName, { create: true });
        const writable = await handle.createWritable();
        await writable.write(new Uint8Array([82, 79, 88, 89]));
        await writable.close();
        const file = await handle.getFile();
        opfs.roundTrip = file.size === 4;
        await root.removeEntry(fileName);
      } catch (error) {
        opfs.error = error instanceof Error ? error.message : String(error);
      }
    }

    const fileSystem: StorageContextCorpus["webkitFileSystem"] = {
      available: false,
      opened: false,
      error: null,
    };
    const requestFileSystem = (globalThis as any).webkitRequestFileSystem;
    if (typeof requestFileSystem === "function") {
      fileSystem.available = true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          fileSystem.error = "webkitRequestFileSystem timed out";
          resolve();
        }, 5000);
        requestFileSystem(
          0,
          0,
          () => { clearTimeout(timer); fileSystem.opened = true; resolve(); },
          (error: unknown) => { clearTimeout(timer); fileSystem.error = String(error); resolve(); },
        );
      });
    }

    return {
      modern,
      bucket,
      legacyTemporary: await queryLegacy(nav.webkitTemporaryStorage),
      legacyPersistent: await queryLegacy(nav.webkitPersistentStorage),
      opfs,
      webkitFileSystem: fileSystem,
    };
  }

  const windowCorpus = await captureContext(requestedQuotaBytes);
  const workerSource = [
    `const captureContext=${captureContext.toString()};`,
    "onmessage=async function(event){try{postMessage(await captureContext(event.data));}",
    "catch(error){postMessage({fatalError:String(error)});}finally{close();}};",
  ].join("");
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  try {
    const workerCorpus = await new Promise<StorageContextCorpus>((resolve, reject) => {
      const worker = new Worker(workerUrl);
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("Storage Worker corpus timed out"));
      }, 20_000);
      worker.onmessage = (event: MessageEvent<StorageContextCorpus | { fatalError: string }>) => {
        clearTimeout(timer);
        worker.terminate();
        if ("fatalError" in event.data) reject(new Error(event.data.fatalError));
        else resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message || "Storage Worker corpus failed"));
      };
      worker.postMessage(requestedQuotaBytes);
    });
    return { window: windowCorpus, worker: workerCorpus };
  } finally {
    URL.revokeObjectURL(workerUrl);
  }
}
