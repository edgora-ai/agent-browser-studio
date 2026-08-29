import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function readBody(req: IncomingMessage, opts: { maxBytes: number; signal?: AbortSignal }): Promise<Buffer> {
  const len = Number(req.headers["content-length"]);
  if (Number.isFinite(len) && len > opts.maxBytes) throw new HttpError(413, "Payload too large");
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onAbort = () => reject(new HttpError(499, "Client closed request"));
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > opts.maxBytes) {
        req.destroy();
        reject(new HttpError(413, "Payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => reject(new HttpError(400, String((e as Error).message || e))));
  });
}

export async function readJson<T>(req: IncomingMessage, opts: { maxBytes: number; validate?: (v: unknown) => T; signal?: AbortSignal }): Promise<T> {
  const buf = await readBody(req, opts);
  if (!buf.length) return {} as T;
  let parsed: unknown;
  try { parsed = JSON.parse(buf.toString("utf-8")); } catch { throw new HttpError(400, "Invalid JSON"); }
  if (opts.validate) return opts.validate(parsed);
  return parsed as T;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
