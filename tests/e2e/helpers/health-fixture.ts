// Test-owned disk/network fixtures only. No product API or transport is mocked.
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as crypto from "node:crypto";
import type { Duplex } from "node:stream";
import { execFileSync } from "node:child_process";

export const HEALTH_STORAGE_ROOT = "/Volumes/DevProjectsSSD-74bf68f9/Temp/roxy-lite-cloak-oss/2026-10-18/sync-state-validation-jaolc2oj";
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
export const sha256 = (value: Buffer | string): string => crypto.createHash("sha256").update(value).digest("hex");
export const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function inside(root: string, file: string): void {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Health acceptance path is not an owned child");
}
export function realDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  for (let at = absolute; ; at = path.dirname(at)) {
    const stat = fs.lstatSync(at);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Health fixture directory/ancestor is not a real directory");
    if (path.dirname(at) === at) break;
  }
  return fs.realpathSync(absolute);
}
export function regularBytes(root: string, file: string, maxBytes = MiB): Buffer {
  inside(root, file);
  realDirectory(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("Evidence is not a bounded regular file");
  inside(fs.realpathSync(root), fs.realpathSync(file));
  return fs.readFileSync(file);
}
export async function until(label: string, condition: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await pause(100);
  }
  throw new Error(`Health acceptance deadline: ${label}`);
}
export function pidExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error: any) { if (error.code === "ESRCH") return true; throw error; }
}
export function ownedPids(directory: string): number[] {
  // No process-name matching or signals. Only this unpredictable owned path.
  const pattern = directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8", stdio: "pipe" })
      .trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (error: any) { if (error.status === 1) return []; throw new Error("Owned process inventory failed"); }
}

export function storageBudget(): { bytes: number; available: number } {
  realDirectory(HEALTH_STORAGE_ROOT);
  let bytes = 0, entries = 0;
  const visit = (directory: string): void => {
    let names: string[];
    try { names = fs.readdirSync(directory); }
    catch (error: any) { if (error.code === "ENOENT") return; throw error; } // live browser removed an owned cache directory
    for (const name of names) {
      const file = path.join(directory, name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(file); }
      catch (error: any) { if (error.code === "ENOENT") continue; throw error; } // live cache entry disappeared between metadata reads
      if (++entries > 40_000) throw new Error("Shared acceptance root exceeds bounded inventory budget");
      // Never follow test/browser lock/cache symlinks into external storage.
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(file);
      else bytes += Math.max(stat.size, Number(stat.blocks || 0) * 512);
    }
  };
  visit(HEALTH_STORAGE_ROOT);
  const stat = fs.statfsSync(HEALTH_STORAGE_ROOT);
  const available = stat.bavail * stat.bsize;
  // Stop admitting work BEFORE the hard 2 GiB / 6 GiB limits, leaving headroom
  // for the normally stopped browser to finish its own writes.
  if (bytes > 1.5 * GiB || available < 6.25 * GiB) throw new Error("Acceptance storage headroom exhausted (hard limits: root <=2 GiB, free >=6 GiB)");
  return { bytes, available };
}
export function createOwnedRoot(supplied: string | undefined): { parent: string; owned: string } {
  if (!supplied || !path.isAbsolute(supplied)) throw new Error("ABS_HEALTH_ACCEPTANCE_ROOT must name a fresh absolute empty directory");
  const parent = realDirectory(supplied);
  inside(realDirectory(HEALTH_STORAGE_ROOT), parent);
  if (fs.readdirSync(parent).length) throw new Error("ABS_HEALTH_ACCEPTANCE_ROOT must be empty; it is never erased by this test");
  try {
    execFileSync("python3", ["/Users/ahoo/.local/share/agent-storage/move_verified_storage.py", "check-mount"], { stdio: "pipe", timeout: 20_000 });
  } catch { throw new Error("Private SSD mount verification failed; fixture writes were not started"); }
  storageBudget();
  return { parent, owned: fs.mkdtempSync(path.join(parent, "health-functional-")) };
}
export function existingNativeBinary(input: string | undefined, engine: "chromium" | "firefox"): string {
  try {
    if (!input || !path.isAbsolute(input)) throw new Error("Supply an explicit existing managed binary; no discovery/download/mock fallback");
    realDirectory(path.dirname(input));
    const stat = fs.lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Selection is not a regular native binary");
    fs.accessSync(input, fs.constants.X_OK);
    const fd = fs.openSync(input, "r"), magic = Buffer.alloc(4);
    try { if (fs.readSync(fd, magic, 0, 4, 0) !== 4) throw new Error("Native binary header unavailable"); }
    finally { fs.closeSync(fd); }
    // This acceptance is explicitly macOS. Reject shebang/fake-BiDi executables.
    if (!["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic.toString("hex"))) {
      throw new Error("Fixture must be a real Mach-O executable, not a protocol emulator");
    }
    return fs.realpathSync(input);
  } catch (error) { throw new Error(`BLOCKED: existing managed ${engine} is unavailable or unsafe: ${String(error)}`); }
}

export async function jsonRequest(port: number, token: string | null, method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  // Literal loopback is intentional: this owned service must never contact a deployment/domain.
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method, headers, agent: false }, res => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MiB) req.destroy(new Error("Health transport reply exceeded 1 MiB"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        try { resolve({ status: res.statusCode || 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { reject(new Error(`Non-JSON health response: ${method} ${route} (${res.statusCode})`)); }
      });
    });
    req.setTimeout(25_000, () => req.destroy(new Error(`Health HTTP deadline: ${method} ${route}`)));
    req.on("error", reject); req.end(payload);
  });
}

function fixtureHtml(mode: string, gate: string): string {
  const script = mode === "native" ? "" : mode === "unavailable"
    ? 'Object.defineProperty(window,"RTCPeerConnection",{configurable:true,value:undefined});'
    : `Object.defineProperty(window,"RTCPeerConnection",{configurable:true,value:function HealthAcceptanceRtcConstructorFault(){
        document.documentElement.dataset.constructorCalls=String(Number(document.documentElement.dataset.constructorCalls||0)+1);
        ${mode === "held-failure" ? `var xhr=new XMLHttpRequest();xhr.open("GET",${JSON.stringify("/gate/" + gate)},false);xhr.send();` : ""}
        throw new Error("Owned health acceptance fixture: deliberate constructor failure");
      }});`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Owned health fixture — ${mode}</title>
<style>body{font:18px system-ui;color:#1f2937;background:#f6f7fa;margin:42px;max-width:960px}button{font:inherit;padding:12px 20px}pre{padding:18px;background:white;white-space:pre-wrap}</style>
<h1>Owned local health acceptance fixture</h1><p id="fixture-mode">${mode}</p>
<p>Native environment/baseline checks are not rewritten. RTC faults below are negative fixtures, NOT native health passes. No external STUN/peer is created.</p>
<button id="fixture-read">Read real page identity</button><pre id="fixture-values"></pre>
<script>document.documentElement.dataset.nativeRtc=typeof window.RTCPeerConnection;${script}
document.documentElement.dataset.rtcFault=${JSON.stringify(mode === "native" ? "none" : mode === "unavailable" ? "unavailable" : "constructor-failure")};
var clicks=0;document.getElementById("fixture-read").addEventListener("click",function(){clicks++;document.documentElement.dataset.clicks=String(clicks);document.getElementById("fixture-values").textContent=JSON.stringify({url:location.href,userAgent:navigator.userAgent,platform:navigator.platform,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,rtc:typeof window.RTCPeerConnection,rtcName:typeof window.RTCPeerConnection==="function"?window.RTCPeerConnection.name:null,rtcFault:document.documentElement.dataset.rtcFault,clicks:clicks},null,2)});</script></html>`;
}

export async function localHealthFixture() {
  let origin = "", closing = false, requests = 0, denied = 0, deniedPing0 = 0, deniedSocketResets = 0;
  const failures: string[] = [], tunnels = new Set<Duplex>();
  const gates = new Map<string, { response?: http.ServerResponse; timer?: ReturnType<typeof setTimeout>; reached: boolean; released: boolean }>();
  const server = http.createServer((req, res) => {
    try {
      if (++requests > 250) throw new Error("Owned HTTP fixture request budget exceeded");
      const url = new URL(req.url || "/", origin);
      if (url.origin !== origin) { denied++; if (/(^|\.)ping0\.cc$/i.test(url.hostname)) deniedPing0++; res.writeHead(403); res.end("External requests are disabled"); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (url.pathname.startsWith("/gate/")) {
        const gate = gates.get(url.pathname.slice(6));
        if (!gate || gate.reached) throw new Error("Unknown/reused owned gate");
        gate.reached = true; gate.response = res;
        // Native synchronous XHR holds the page constructor, not a mocked API
        // promise. The product's actual CDP evaluation/lease must remain pending.
        gate.timer = setTimeout(() => {
          failures.push("Owned constructor gate timed out before explicit release");
          gate.released = true; res.writeHead(504); res.end("Fixture deadline");
        }, 15_000);
        return;
      }
      const mode = url.pathname.slice(1) || "native";
      if (!["native", "unavailable", "failure", "held-failure"].includes(mode)) { res.writeHead(404); res.end(); return; }
      const gate = url.searchParams.get("gate") || "";
      if (mode === "held-failure" && !gates.has(gate)) throw new Error("Held page requires its own gate");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; worker-src blob:; img-src data:; font-src 'self'" });
      res.end(fixtureHtml(mode, gate));
    } catch (error) {
      failures.push(String(error)); if (!res.headersSent) res.writeHead(500); res.end("Owned fixture failure");
    }
  });
  server.on("connect", (req, socket) => {
    denied++; if (/^([^:]+\.)?ping0\.cc:/i.test(req.url || "")) deniedPing0++;
    tunnels.add(socket); socket.once("close", () => tunnels.delete(socket));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      // Account only resets from these deliberately denied CONNECT sockets.
      if (error.code === "ECONNRESET" || error.code === "EPIPE") deniedSocketResets++;
      else failures.push(`Denied CONNECT socket: ${error.message}`);
    });
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  server.on("clientError", (error, socket) => {
    if (!closing) failures.push(`Owned HTTP client error: ${error.message}`);
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  server.on("error", error => failures.push(`Owned HTTP server error: ${error.message}`));
  const port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  const release = (id: string): void => {
    const gate = gates.get(id);
    if (!gate?.reached || !gate.response || gate.released) throw new Error("No pending owned constructor gate");
    gate.released = true; clearTimeout(gate.timer); gate.response.writeHead(200); gate.response.end("Explicitly released");
  };
  return {
    origin, port, failures,
    arm() { const id = crypto.randomBytes(8).toString("hex"); gates.set(id, { reached: false, released: false }); return { id, url: `${origin}/held-failure?gate=${id}` }; },
    reached(id: string) { return gates.get(id)?.reached === true; }, release,
    releaseAll() { for (const [id, gate] of gates) if (gate.reached && !gate.released) release(id); },
    stats() { return { requests, denied, deniedPing0, deniedSocketResets, gates: [...gates.values()].map(g => ({ reached: g.reached, released: g.released })), failures: [...failures] }; },
    async close() {
      closing = true;
      for (const [id, gate] of gates) { clearTimeout(gate.timer); if (gate.reached && !gate.released) release(id); }
      for (const socket of tunnels) socket.destroy();
      server.closeIdleConnections(); server.closeAllConnections(); // owned HTTP sockets only; no process signalling
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
