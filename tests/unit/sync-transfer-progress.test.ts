// Finite Node-only stream/worker proofs. The one native fetch fixture owns an
// ephemeral loopback listener; it never contacts an installed app or S3 service.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as vm from "node:vm";
import ts from "typescript";
import { forEachSyncSidecar, syncRequestDeadline, syncUploadBody } from "../../src/main/services/sync/transfer-progress.js";

const CHUNK = 256 * 1024;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function reporter() { return { update: vi.fn(), waiting: vi.fn(), finish: vi.fn() }; }
function streamBody(init: RequestInit): ReadableStream<Uint8Array> {
  expect(init.body).toBeInstanceOf(ReadableStream);
  expect(init).toHaveProperty("duplex", "half");
  return init.body as ReadableStream<Uint8Array>;
}

// Match the existing transport-suite convention: compile the ENTIRE unchanged
// service, not an extracted signer. Every dependency except crypto fails closed
// on use. Only its public signer is called, so no config, disk/native or service
// activity is needed merely to sign the test's actual streamed body.
function signingFixture() {
  const file = path.resolve(__dirname, "../../src/main/services/sync-service.ts");
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const forbidden = vi.fn((name: string): never => { throw new Error("Forbidden progress fixture operation: " + name); });
  const module = { exports: {} as Pick<typeof import("../../src/main/services/sync-service.js"), "signS3Request"> };
  const requireFixture = (name: string) => name === "node:crypto" ? crypto : new Proxy({ __esModule: true }, {
    get: (_target, key) => key === "__esModule" ? true : (..._args: unknown[]) => forbidden(name + "." + String(key)),
  });
  vm.runInNewContext(`(function(require,module,exports) { ${compiled}\n})`, {
    Buffer, URL, fetch: () => forbidden("network"), setTimeout: () => forbidden("timer"), setInterval: () => forbidden("interval"),
  }, { filename: file })(requireFixture, module, module.exports);
  return { sign: module.exports.signS3Request, forbidden };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("syncUploadBody buffered compatibility and pull-driven progress", () => {
  it.each([0, 1, CHUNK - 1, CHUNK])("keeps a %i-byte small body as the original Buffer with no stream-only options or callbacks", length => {
    const body = Buffer.alloc(length, 0x53), progress = reporter(), onBytes = vi.fn();
    const init = syncUploadBody(body, progress, new AbortController().signal, onBytes);
    expect(Object.keys(init)).toEqual(["body"]); expect(init.body).toBe(body);
    expect(init).not.toHaveProperty("duplex");
    expect(progress.update).not.toHaveBeenCalled(); expect(progress.waiting).not.toHaveBeenCalled();
    expect(progress.finish).not.toHaveBeenCalled(); expect(onBytes).not.toHaveBeenCalled();
  });

  it("preserves large buffered-body compatibility when neither progress nor activity callbacks are supplied", () => {
    const body = Buffer.alloc(CHUNK + 1, 0x54);
    const init = syncUploadBody(body);
    expect(init.body).toBe(body); expect(init).not.toHaveProperty("duplex");
  });

  it("streams sidecar bodies with activity-only callbacks even without a UI progress reporter", async () => {
    const body = Buffer.alloc(CHUNK + 1, 0x55), onBytes = vi.fn();
    const reader = streamBody(syncUploadBody(body, undefined, undefined, onBytes)).getReader();
    try {
      await tick(); expect(onBytes).not.toHaveBeenCalled();
      expect((await reader.read()).value).toHaveLength(CHUNK);
      expect(onBytes).toHaveBeenCalledTimes(1);
      await tick(); expect(onBytes).toHaveBeenCalledTimes(1);
      expect((await reader.read()).value).toHaveLength(1);
      expect(onBytes).toHaveBeenCalledTimes(2);
      expect(await reader.read()).toEqual({ value: undefined, done: true });
      expect(onBytes).toHaveBeenCalledTimes(2);
    } finally { await reader.cancel(); reader.releaseLock(); }
  });

  it("reports exact cumulative consumed chunks, honors backpressure, and does not duplicate or change the signed bytes", async () => {
    const body = Buffer.alloc(CHUNK * 2 + 17);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    const expectedHash = crypto.createHash("sha256").update(body).digest("hex"), progress = reporter(), onBytes = vi.fn();
    const stream = streamBody(syncUploadBody(body, progress, undefined, onBytes));
    await tick();
    expect(progress.update).not.toHaveBeenCalled(); expect(onBytes).not.toHaveBeenCalled();
    const reader = stream.getReader(), chunks: Uint8Array[] = [];
    try {
      await tick();
      expect(progress.update).not.toHaveBeenCalled();
      for (const [index, size] of [CHUNK, CHUNK, 17].entries()) {
        const next = await reader.read();
        expect(next.done).toBe(false); expect(next.value).toHaveLength(size);
        expect(next.value!.buffer).toBe(body.buffer);
        expect(next.value!.byteOffset).toBe(body.byteOffset + index * CHUNK);
        chunks.push(next.value!);
        expect(progress.update.mock.calls).toEqual([CHUNK, CHUNK * 2, body.length].slice(0, index + 1).map(bytes => [bytes]));
        expect(onBytes).toHaveBeenCalledTimes(index + 1);
        expect(progress.waiting).not.toHaveBeenCalled();
        await tick();
        expect(progress.update).toHaveBeenCalledTimes(index + 1); // No read-ahead while the consumer is paused.
      }
      expect(await reader.read()).toEqual({ value: undefined, done: true });
      expect(progress.waiting).toHaveBeenCalledExactlyOnceWith();
      expect(progress.finish).not.toHaveBeenCalled(); // A consumed body is not a server acknowledgement.
      expect(onBytes).toHaveBeenCalledTimes(3);
      expect(crypto.createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(expectedHash);
      expect(crypto.createHash("sha256").update(body).digest("hex")).toBe(expectedHash);
    } finally { await reader.cancel(); reader.releaseLock(); }
  });

  it.each([false, true])("stops the next pull on cancellation (one chunk already consumed: %s)", async consumeFirst => {
    const controller = new AbortController(), reason = new Error("Synthetic upload cancelled"), progress = reporter(), onBytes = vi.fn();
    const reader = streamBody(syncUploadBody(Buffer.alloc(CHUNK * 3), progress, controller.signal, onBytes)).getReader();
    const closed = reader.closed.catch(error => error);
    try {
      if (consumeFirst) expect((await reader.read()).value).toHaveLength(CHUNK);
      controller.abort(reason);
      await expect(reader.read()).rejects.toBe(reason);
      expect(await closed).toBe(reason);
      await tick();
      expect(progress.update.mock.calls).toEqual(consumeFirst ? [[CHUNK]] : []);
      expect(onBytes).toHaveBeenCalledTimes(consumeFirst ? 1 : 0);
      expect(progress.waiting).not.toHaveBeenCalled(); expect(progress.finish).not.toHaveBeenCalled();
    } finally { reader.releaseLock(); }
  });

  it("does not report bytes, waiting, or completion after its reader cancels", async () => {
    const progress = reporter(), onBytes = vi.fn();
    const reader = streamBody(syncUploadBody(Buffer.alloc(CHUNK * 3), progress, undefined, onBytes)).getReader();
    try {
      await reader.read(); await reader.cancel("Synthetic consumer discarded request");
      expect(await reader.read()).toEqual({ value: undefined, done: true });
      await tick();
      expect(progress.update.mock.calls).toEqual([[CHUNK]]); expect(onBytes).toHaveBeenCalledTimes(1);
      expect(progress.waiting).not.toHaveBeenCalled(); expect(progress.finish).not.toHaveBeenCalled();
    } finally { reader.releaseLock(); }
  });

  it("native loopback fetch consumes a real signed PUT intact and waits for the response after all byte progress", async () => {
    const body = Buffer.alloc(CHUNK * 4 + 71);
    for (let i = 0; i < body.length; i++) body[i] = (i * 17 + 3) % 256;
    const expectedHash = crypto.createHash("sha256").update(body).digest("hex");
    const progress = reporter(), onBytes = vi.fn(), signing = signingFixture(), release = deferred();
    const received = deferred<{ method?: string; url?: string; bytes: Buffer; headers: http.IncomingHttpHeaders }>();
    const server = http.createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > body.length) throw new Error("Loopback PUT exceeded its fixture budget");
          chunks.push(Buffer.from(chunk));
        }
        received.resolve({ method: req.method, url: req.url, bytes: Buffer.concat(chunks), headers: req.headers });
        await release.promise;
        res.writeHead(200, { "content-length": "2" }); res.end("ok");
      } catch (error) { received.reject(error); res.destroy(); }
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Owned loopback listener failed to bind");
    const endpoint = `http://127.0.0.1:${address.port}`, objectPath = "/synthetic/progress-put.bin";
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
    let pending: Promise<Response> | undefined, responseSettled = false;
    try {
      const headers = signing.sign({ method: "PUT", endpoint, objectPath, body, accessKey: "SYNTHETICPROGRESSKEY", secretKey: "synthetic-progress-secret-not-a-real-credential" });
      headers["content-length"] = String(body.length);
      expect(headers["x-amz-content-sha256"]).toBe(expectedHash);
      expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 .*Signature=[a-f0-9]{64}$/);
      pending = fetch(endpoint + objectPath, { method: "PUT", headers, ...syncUploadBody(body, progress, signal, onBytes), signal });
      void pending.then(() => { responseSettled = true; }, () => { responseSettled = true; });
      const request = await Promise.race([received.promise, pending.then(() => { throw new Error("Loopback response arrived before the fixture released it"); })]);
      await tick();
      expect(request.method).toBe("PUT"); expect(request.url).toBe(objectPath);
      expect(request.headers["content-length"]).toBe(String(body.length));
      expect(request.headers.authorization).toBe(headers.Authorization);
      expect(crypto.createHash("sha256").update(request.bytes).digest("hex")).toBe(request.headers["x-amz-content-sha256"]);
      expect(request.bytes.equals(body)).toBe(true);
      expect(progress.update.mock.calls).toEqual([CHUNK, CHUNK * 2, CHUNK * 3, CHUNK * 4, body.length].map(bytes => [bytes]));
      expect(onBytes).toHaveBeenCalledTimes(5);
      expect(progress.waiting).toHaveBeenCalledExactlyOnceWith();
      expect(progress.finish).not.toHaveBeenCalled();
      expect(responseSettled).toBe(false);
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(200); expect(await response.text()).toBe("ok");
      expect(crypto.createHash("sha256").update(body).digest("hex")).toBe(expectedHash);
      expect(signing.forbidden).not.toHaveBeenCalled();
    } finally {
      release.resolve(); controller.abort(); await pending?.catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 10000);
});

describe("forEachSyncSidecar bounded concurrency and owner-safe settlement", () => {
  it("starts at most three default workers, reuses a free slot, and processes each original item/index exactly once", async () => {
    const items = Array.from({ length: 8 }, (_, index) => ({ id: `synthetic-${index}` }));
    const gates = items.map(() => deferred()), started: number[] = [];
    let active = 0, peak = 0;
    const action = vi.fn(async (_item: typeof items[number], index: number) => {
      active++; peak = Math.max(peak, active); started.push(index);
      try { await gates[index].promise; } finally { active--; }
    });
    const pending = forEachSyncSidecar(items, action);
    try {
      expect(started).toEqual([0, 1, 2]); expect(active).toBe(3);
      gates[1].resolve(); await tick();
      expect(started).toEqual([0, 1, 2, 3]); expect(active).toBe(3);
      gates[0].resolve(); gates[2].resolve(); await tick();
      expect(started).toEqual([0, 1, 2, 3, 4, 5]); expect(active).toBe(3);
      gates.forEach(gate => gate.resolve());
      await expect(pending).resolves.toBeUndefined();
      expect(started).toEqual(items.map((_, index) => index));
      expect(action.mock.calls).toEqual(items.map((item, index) => [item, index]));
      expect(peak).toBe(3); expect(active).toBe(0);
    } finally { gates.forEach(gate => gate.resolve()); await pending; }
  });

  it.each([
    { requested: 1, expected: 1 }, { requested: 2, expected: 2 }, { requested: 3, expected: 3 }, { requested: 20, expected: 3 },
    { requested: 0, expected: 1 }, { requested: -2, expected: 1 }, { requested: 1.5, expected: 1 }, { requested: Infinity, expected: 1 },
  ])("bounds explicit concurrency $requested to $expected", async ({ requested, expected }) => {
    const release = deferred(); let active = 0, peak = 0;
    const action = vi.fn(async () => { active++; peak = Math.max(peak, active); await release.promise; active--; });
    const pending = forEachSyncSidecar([0, 1, 2, 3, 4, 5], action, requested);
    try { expect(action).toHaveBeenCalledTimes(expected); expect(active).toBe(expected); }
    finally { release.resolve(); await pending; }
    expect(peak).toBe(expected); expect(active).toBe(0); expect(action).toHaveBeenCalledTimes(6);
  });

  it("does no work for an empty inventory", async () => {
    const action = vi.fn();
    await expect(forEachSyncSidecar([], action)).resolves.toBeUndefined();
    expect(action).not.toHaveBeenCalled();
  });

  it.each([new Error("Synthetic first failure"), null, undefined])("stops scheduling on failure but awaits all running workers before rejecting with the first reason (%s)", async firstFailure => {
    const gates = [deferred(), deferred(), deferred()], started: number[] = [];
    let active = 0, settled = false;
    const pending = forEachSyncSidecar([0, 1, 2, 3, 4, 5], async (_item, index) => {
      started.push(index); active++;
      try { await gates[index].promise; } finally { active--; }
    }).then(() => { settled = true; return { success: true as const }; }, error => { settled = true; return { success: false as const, error }; });
    try {
      expect(started).toEqual([0, 1, 2]);
      gates[0].reject(firstFailure); await tick();
      expect(settled).toBe(false); expect(active).toBe(2); expect(started).toEqual([0, 1, 2]);
      gates[1].resolve(); await tick();
      expect(settled).toBe(false); expect(active).toBe(1); expect(started).toEqual([0, 1, 2]);
      gates[2].reject(new Error("Synthetic later failure"));
      const result = await pending;
      expect(result).toEqual({ success: false, error: firstFailure });
      expect(active).toBe(0); expect(started).toEqual([0, 1, 2]);
    } finally { gates.forEach(gate => gate.resolve()); await pending; }
  });

  it("handles a synchronous action throw without starting additional items", async () => {
    const failure = new Error("Synthetic synchronous failure"), action = vi.fn(() => { throw failure; });
    await expect(forEachSyncSidecar([0, 1, 2], action)).rejects.toBe(failure);
    expect(action).toHaveBeenCalledExactlyOnceWith(0, 0);
  });
});

describe("syncRequestDeadline progress-sensitive cancellation", () => {
  beforeEach(() => vi.useFakeTimers());

  it("lets activity reset the 60-second idle deadline beyond the old 30-second wall limit", () => {
    const deadline = syncRequestDeadline();
    try {
      expect(vi.getTimerCount()).toBe(2);
      vi.advanceTimersByTime(35000); expect(deadline.signal.aborted).toBe(false); deadline.touch();
      vi.advanceTimersByTime(35000); expect(deadline.signal.aborted).toBe(false); deadline.touch();
      expect(vi.getTimerCount()).toBe(2); // Activity replaces rather than accumulates idle timers.
      vi.advanceTimersByTime(59999); expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1); expect(deadline.signal.aborted).toBe(true);
      expect(deadline.signal.reason).toBeInstanceOf(Error);
      expect(deadline.signal.reason.message).toMatch(/stalled.*60 seconds/i);
      expect(vi.getTimerCount()).toBe(0); // Abort itself disposes both deadlines.
      deadline.touch(); expect(vi.getTimerCount()).toBe(0);
    } finally { deadline.dispose(); }
  });

  it("aborts an entirely stalled request at the idle boundary and cleans up the overall timer", () => {
    const deadline = syncRequestDeadline(undefined, 1000, 10000);
    try {
      vi.advanceTimersByTime(999); expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1); expect(deadline.signal.aborted).toBe(true);
      expect(deadline.signal.reason.message).toMatch(/no data for 1 seconds/);
      expect(vi.getTimerCount()).toBe(0);
    } finally { deadline.dispose(); }
  });

  it.each([false, true])("preserves parent cancellation and automatically clears both timers (already aborted: %s)", alreadyAborted => {
    const parent = new AbortController(), reason = new Error("Synthetic parent cancellation");
    if (alreadyAborted) parent.abort(reason);
    const deadline = syncRequestDeadline(parent.signal, 1000);
    try {
      expect(vi.getTimerCount()).toBe(alreadyAborted ? 0 : 2);
      if (!alreadyAborted) { vi.advanceTimersByTime(500); parent.abort(reason); }
      expect(deadline.signal.aborted).toBe(true); expect(deadline.signal.reason).toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
      deadline.touch(); expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(30 * 60 * 1000); expect(deadline.signal.reason).toBe(reason);
    } finally { deadline.dispose(); }
  });

  it("disposes both idle and overall timers idempotently and cannot rearm either after settlement", () => {
    const deadline = syncRequestDeadline(undefined, 1000, 2500);
    expect(vi.getTimerCount()).toBe(2);
    deadline.dispose(); deadline.dispose(); deadline.touch();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10000);
    expect(deadline.signal.aborted).toBe(false);
  });

  it("still obeys the overall time budget even while byte activity keeps the idle deadline fresh", () => {
    const deadline = syncRequestDeadline(undefined, 1000, 2500);
    try {
      vi.advanceTimersByTime(900); deadline.touch();
      vi.advanceTimersByTime(900); deadline.touch();
      vi.advanceTimersByTime(699); expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1); expect(deadline.signal.aborted).toBe(true);
      expect(deadline.signal.reason.message).toMatch(/exceeded.*maximum duration/i);
      expect(vi.getTimerCount()).toBe(0);
    } finally { deadline.dispose(); }
  });

  it("keeps the default overall budget fixed at 30 minutes despite continuing activity", () => {
    const deadline = syncRequestDeadline();
    try {
      for (let minute = 0; minute < 59; minute++) {
        vi.advanceTimersByTime(30000); deadline.touch();
        expect(deadline.signal.aborted).toBe(false);
      }
      vi.advanceTimersByTime(29999); expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1); expect(deadline.signal.aborted).toBe(true);
      expect(deadline.signal.reason.message).toMatch(/maximum duration/i);
      expect(vi.getTimerCount()).toBe(0);
    } finally { deadline.dispose(); }
  });
});
