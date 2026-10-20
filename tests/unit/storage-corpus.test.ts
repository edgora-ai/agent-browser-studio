import { afterEach, describe, expect, it, vi } from "vitest";
import { captureStorageCorpusInPage, type StorageContextCorpus } from "../../src/tools/storage-corpus.js";

const LEGACY_FILE = "agent-browser-storage-corpus.bin";
const LEGACY_BUCKET = "agent-browser-storage-corpus";
const UUID = "00000000-0000-4000-8000-000000000001";
const NEW_FILE = `agent-browser-storage-corpus-${UUID}.bin`;
const NEW_BUCKET = `agent-browser-storage-corpus-${UUID}`;

function emptyWorkerCorpus(): StorageContextCorpus {
  const quota = { available: false, quota: null, grantedQuota: null, usageDetailKeys: [], error: null };
  return {
    modern: { ...quota, persisted: null },
    bucket: { ...quota, persisted: null, durability: null, directoryAvailable: false },
    legacyTemporary: { ...quota }, legacyPersistent: { ...quota },
    opfs: { available: false, roundTrip: false, error: null },
    webkitFileSystem: { available: false, opened: false, error: null },
  };
}

function fixture(options: { corruptRead?: boolean; failWrite?: boolean; failRemove?: boolean; failBucketDelete?: boolean; collision?: boolean } = {}) {
  const original = new Uint8Array([9, 8, 7, 6]);
  const files = new Map<string, Uint8Array>([[LEGACY_FILE, original.slice()]]);
  const buckets = new Set([LEGACY_BUCKET]);
  if (options.collision) { files.set(NEW_FILE, original.slice()); buckets.add(NEW_BUCKET); }
  const events: Array<{ kind: string; name: string }> = [];
  const root = {
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      events.push({ kind: opts?.create ? "create" : "lookup", name });
      if (!files.has(name)) {
        if (!opts?.create) throw new DOMException("Missing owned file", "NotFoundError");
        files.set(name, new Uint8Array());
      }
      return {
        async createWritable() {
          return {
            async write(bytes: Uint8Array) {
              events.push({ kind: "write", name });
              if (options.failWrite) throw new Error("controlled write failure");
              files.set(name, new Uint8Array(bytes));
            },
            async close() { events.push({ kind: "close-writer", name }); },
            async abort() { events.push({ kind: "abort-writer", name }); },
          };
        },
        async getFile() {
          const bytes = options.corruptRead ? new Uint8Array([0, 0, 0, 0]) : files.get(name)!.slice();
          events.push({ kind: "read", name });
          return { size: bytes.length, async arrayBuffer() { return bytes.buffer; } };
        },
      };
    },
    async *keys() { for (const name of files.keys()) { events.push({ kind: "list", name }); yield name; } },
    async removeEntry(name: string) {
      events.push({ kind: "remove", name });
      if (options.failRemove) throw new Error("controlled cleanup failure");
      files.delete(name);
    },
  };
  const storageBuckets = {
    async keys() { return [...buckets]; },
    async open(name: string) {
      events.push({ kind: "open-bucket", name }); buckets.add(name);
      return { async estimate() { return { quota: 4096 }; }, async persisted() { return false; }, async durability() { return "relaxed"; }, async getDirectory() { return root; } };
    },
    async delete(name: string) {
      events.push({ kind: "delete-bucket", name });
      if (options.failBucketDelete) throw new Error("controlled bucket cleanup failure");
      buckets.delete(name);
    },
  };
  const terminate = vi.fn();
  class FakeWorker {
    onmessage: ((event: { data: StorageContextCorpus }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    postMessage() { queueMicrotask(() => this.onmessage?.({ data: emptyWorkerCorpus() })); }
    terminate = terminate;
  }
  vi.stubGlobal("navigator", { storage: { async estimate() { return { quota: 4096 }; }, async persisted() { return false; }, async getDirectory() { return root; } }, storageBuckets });
  vi.stubGlobal("crypto", { randomUUID: () => UUID });
  vi.stubGlobal("Worker", FakeWorker);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:owned-storage-unit");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  return { files, buckets, events, original, terminate, revoke };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("owned storage corpus readback", () => {
  it("writes four bytes, finds the entry, reopens it and compares actual bytes", async () => {
    const f = fixture();
    const result = await captureStorageCorpusInPage(8192);
    expect(result.window.opfs).toEqual({ available: true, roundTrip: true, error: null });
    expect(f.events).toContainEqual({ kind: "list", name: NEW_FILE });
    expect(f.events.filter(event => event.kind === "lookup" && event.name === NEW_FILE).length).toBeGreaterThanOrEqual(2);
    expect(f.files.has(NEW_FILE)).toBe(false);
    expect(f.buckets.has(NEW_BUCKET)).toBe(false);
    expect(f.terminate).toHaveBeenCalledOnce();
    expect(f.revoke).toHaveBeenCalledWith("blob:owned-storage-unit");
  });

  it("rejects different data even when the size is still four bytes", async () => {
    const f = fixture({ corruptRead: true });
    const result = await captureStorageCorpusInPage(8192);
    expect(result.window.opfs.roundTrip).toBe(false);
    expect(result.window.opfs.error).toMatch(/byte|readback/i);
    expect(f.files.has(NEW_FILE)).toBe(false);
  });

  it("does not overwrite or delete earlier files and buckets with the old fixed names", async () => {
    const f = fixture();
    await captureStorageCorpusInPage(8192);
    expect(f.files.get(LEGACY_FILE)).toEqual(f.original);
    expect(f.buckets.has(LEGACY_BUCKET)).toBe(true);
    expect(f.events.some(event => ["write", "remove", "open-bucket", "delete-bucket"].includes(event.kind) && [LEGACY_FILE, LEGACY_BUCKET].includes(event.name))).toBe(false);
  });

  it("refuses a generated-name collision without opening, writing or removing it", async () => {
    const f = fixture({ collision: true });
    const result = await captureStorageCorpusInPage(8192);
    expect(result.window.opfs.roundTrip).toBe(false);
    expect(result.window.opfs.error).toMatch(/exist|collision/i);
    expect(result.window.bucket.error).toMatch(/exist|collision/i);
    expect(f.files.get(NEW_FILE)).toEqual(f.original);
    expect(f.buckets.has(NEW_BUCKET)).toBe(true);
    expect(f.events.some(event => ["create", "write", "remove", "open-bucket", "delete-bucket"].includes(event.kind) && [NEW_FILE, NEW_BUCKET].includes(event.name))).toBe(false);
  });

  it("cleans its own partially written file while retaining the write failure", async () => {
    const f = fixture({ failWrite: true });
    const result = await captureStorageCorpusInPage(8192);
    expect(result.window.opfs.roundTrip).toBe(false);
    expect(result.window.opfs.error).toMatch(/controlled write failure/);
    expect(f.events).toContainEqual({ kind: "abort-writer", name: NEW_FILE });
    expect(f.events).toContainEqual({ kind: "remove", name: NEW_FILE });
    expect(f.files.has(NEW_FILE)).toBe(false);
    expect(f.files.get(LEGACY_FILE)).toEqual(f.original);
  });

  it("does not report a successful round trip when its own cleanup fails", async () => {
    const f = fixture({ failRemove: true });
    const result = await captureStorageCorpusInPage(8192);
    expect(result.window.opfs.roundTrip).toBe(false);
    expect(result.window.opfs.error).toMatch(/cleanup failure/);
    expect(f.files.has(NEW_FILE)).toBe(true);
    expect(f.files.get(LEGACY_FILE)).toEqual(f.original);
  });

  it("records bucket cleanup failure rather than swallowing it", async () => {
    const f = fixture({ failBucketDelete: true });
    const result = await captureStorageCorpusInPage(8192);
    expect(result.window.bucket.error).toMatch(/bucket cleanup failure/);
    expect(f.buckets.has(NEW_BUCKET)).toBe(true);
    expect(f.buckets.has(LEGACY_BUCKET)).toBe(true);
  });
});
