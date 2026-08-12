/// <reference lib="dom" />

import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  AGENT_BROWSER_FINGERPRINT_SWITCH,
  MANAGED_SECURE_DNS_TEMPLATES,
  buildBrowserFingerprintArg,
} from "../main/services/browser-fingerprint-config.js";

interface Options {
  browser: string;
  mode: "http" | "socks5";
  upstreamHost: string;
  upstreamPort: number;
  target: string;
  samples: number;
  keepNetLog: boolean;
}

interface ConnectRecord {
  target: string;
  ok: boolean;
}

interface SampleResult {
  index: number;
  pageState: "loaded" | "error" | "timeout";
  title: string;
  proxyTargets: string[];
  dohHost: string;
  dohConnectCount: number;
  dohConnectOk: number;
  netLog: {
    dohUrlRequests: number;
    hostResolverJobs: string[];
    directConnects: string[];
  } | null;
}

function resolveExecutable(input: string): string {
  const resolved = path.resolve(input);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  if (process.platform === "darwin" && resolved.endsWith(".app")) {
    const name = path.basename(resolved, ".app");
    const candidate = path.join(resolved, "Contents", "MacOS", name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`browser executable not found: ${input}`);
}

function parseOptions(argv: string[]): Options {
  let browser = "";
  let mode: Options["mode"] = "http";
  let upstreamHost = "127.0.0.1";
  let upstreamPort = 7890;
  let target = "https://www.google.com/";
  let samples = 1;
  let keepNetLog = false;
  for (const arg of argv) {
    if (arg.startsWith("--browser=")) browser = arg.slice("--browser=".length);
    else if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (value !== "http" && value !== "socks5") throw new Error("--mode must be http or socks5");
      mode = value;
    }
    else if (arg.startsWith("--upstream=")) {
      const spec = arg.slice("--upstream=".length);
      const separator = spec.lastIndexOf(":");
      if (separator <= 0) throw new Error(`invalid --upstream=${spec}`);
      upstreamHost = spec.slice(0, separator);
      upstreamPort = Number(spec.slice(separator + 1));
      if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
        throw new Error(`invalid --upstream=${spec}`);
      }
    } else if (arg.startsWith("--target=")) target = arg.slice("--target=".length);
    else if (arg.startsWith("--samples=")) {
      samples = Number(arg.slice("--samples=".length));
      if (!Number.isInteger(samples) || samples < 1 || samples > 3) {
        throw new Error("--samples must be an integer from 1 to 3");
      }
    } else if (arg === "--keep-net-log") keepNetLog = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else browser = arg;
  }
  if (!browser) throw new Error("usage: verify-managed-doh --browser=/path/to/Chromium.app [--upstream=host:port] [--target=url] [--samples=n] [--keep-net-log]");
  return {
    browser: resolveExecutable(browser),
    mode,
    upstreamHost,
    upstreamPort,
    target,
    samples,
    keepNetLog,
  };
}

function startLoggingProxy(
  upstreamHost: string,
  upstreamPort: number,
): Promise<{ port: number; records: ConnectRecord[]; close: () => Promise<void> }> {
  const records: ConnectRecord[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_request, response) => {
    response.writeHead(502);
    response.end();
  });
  server.on("connect", (request, clientSocket, head) => {
    const target = request.url || "invalid";
    const upstream = net.createConnection({ host: upstreamHost, port: upstreamPort });
    sockets.add(upstream);
    sockets.add(clientSocket as net.Socket);
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      try {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } catch {
        // ignore
      }
      try {
        clientSocket.end();
      } catch {
        // ignore
      }
      upstream.destroy();
    };
    upstream.on("connect", () => {
      upstream.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: keep-alive\r\n\r\n`,
      );
    });
    let responseBuffer = Buffer.alloc(0);
    upstream.on("data", (chunk: Buffer) => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      const headerEnd = responseBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const statusLine = responseBuffer.slice(0, headerEnd).toString("latin1").split("\r\n")[0] || "";
      const ok = /^HTTP\/1\.[01] 200\b/.test(statusLine);
      records.push({ target, ok });
      if (settled) return;
      settled = true;
      if (ok) {
        try {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        } catch {
          // ignore
        }
        const rest = responseBuffer.subarray(headerEnd + 4);
        if (head.length) upstream.write(head);
        if (rest.length) {
          try {
            clientSocket.write(rest);
          } catch {
            // ignore
          }
        }
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      } else {
        try {
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        } catch {
          // ignore
        }
        try {
          clientSocket.end();
        } catch {
          // ignore
        }
        upstream.destroy();
      }
    });
    upstream.on("error", fail);
    clientSocket.on("error", () => upstream.destroy());
    upstream.on("close", () => sockets.delete(upstream));
    clientSocket.on("close", () => sockets.delete(clientSocket as net.Socket));
  });
  const serverSockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    serverSockets.add(socket as net.Socket);
    socket.on("close", () => serverSockets.delete(socket));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      resolvePromise({
        port: address.port,
        records,
        close: async () => {
          for (const socket of sockets) socket.destroy();
          for (const socket of serverSockets) socket.destroy();
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        },
      });
    });
  });
}

function scanNetLog(
  file: string,
): { dohUrlRequests: number; hostResolverJobs: string[]; directConnects: string[] } {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      constants?: { logEventTypes?: Record<string, number> };
      events?: Array<{ type?: number; phase?: number; params?: Record<string, unknown> }>;
    };
    const typeNameById = new Map<number, string>();
    for (const [name, id] of Object.entries(raw.constants?.logEventTypes || {})) {
      typeNameById.set(id, name);
    }
    const events = raw.events || [];
    const dohUrlRequests = events.filter(
      (event) =>
        typeNameById.get(event.type ?? -1) === "DNS_OVER_HTTPS_URL_REQUEST" ||
        typeNameById.get(event.type ?? -1) === "DOH_URL_REQUEST",
    ).length;
    const hostResolverJobs = events
      .filter(
        (event) =>
          typeNameById.get(event.type ?? -1) === "HOST_RESOLVER_MANAGER_JOB" ||
          typeNameById.get(event.type ?? -1) === "HOST_RESOLVER_IMPL_JOB",
      )
      .map((event) => String(event.params?.host || event.params?.hostname || "?"))
      .filter((host, index, all) => all.indexOf(host) === index)
      .slice(0, 20);
    const directConnects = events
      .filter((event) => typeNameById.get(event.type ?? -1) === "TCP_CONNECT" && event.phase === 1)
      .flatMap((event) => {
        const addresses = Array.isArray(event.params?.address_list)
          ? (event.params?.address_list as string[])
          : [];
        return addresses.filter(
          (address) => !address.startsWith("127.") && !address.startsWith("::1") && address !== "0.0.0.0",
        );
      })
      .filter((address, index, all) => all.indexOf(address) === index)
      .slice(0, 20);
    return { dohUrlRequests, hostResolverJobs, directConnects };
  } catch {
    return { dohUrlRequests: -1, hostResolverJobs: [], directConnects: [] };
  }
}

async function runSample(
  opts: Options,
  proxy: { port: number; records: ConnectRecord[] } | null,
  index: number,
  temporaryRoot: string,
): Promise<SampleResult> {
  const temporaryProfile = fs.mkdtempSync(path.join(temporaryRoot, `profile-${index}-`));
  const netLogPath = opts.keepNetLog ? path.join(temporaryRoot, `netlog-${index}.json`) : path.join(temporaryProfile, "netlog.json");
  const fingerprintArg = buildBrowserFingerprintArg(
    {
      fingerprintSeed: 40000 + index,
      platform: "windows",
      locale: "en-US",
      timezone: "America/New_York",
    },
    "150.0.7871.114",
    AGENT_BROWSER_FINGERPRINT_SWITCH,
    { enabled: true, templates: [...MANAGED_SECURE_DNS_TEMPLATES] },
  );
  const start = proxy?.records.length ?? 0;
  let browser: Browser | null = null;
  let page: Page | null = null;
  let pageState: SampleResult["pageState"] = "error";
  let title = "";
  try {
    browser = await chromium.launch({
      executablePath: opts.browser,
      headless: true,
      timeout: 20_000,
      args: [
        opts.mode === "http" && proxy
          ? `--proxy-server=http://127.0.0.1:${proxy.port}`
          : `--proxy-server=socks5://${opts.upstreamHost}:${opts.upstreamPort}`,
        opts.mode === "http" ? "--disable-quic" : "--enable-quic",
        fingerprintArg,
        "--use-mock-keychain",
        "--no-first-run",
        "--no-default-browser-check",
        `--log-net-log=${netLogPath}`,
        "--net-log-capture-mode=Everything",
      ],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();
    try {
      await page.goto(opts.target, { waitUntil: "domcontentloaded", timeout: 20_000 });
      pageState = "loaded";
    } catch (caught) {
      pageState = caught instanceof Error && /timeout/i.test(caught.message) ? "timeout" : "error";
    }
    try {
      title = await page.title();
    } catch {
      // ignore
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 3000));
  } catch (caught) {
    pageState = "error";
    process.stderr.write(`[verify-managed-doh] sample ${index} launch error: ${caught instanceof Error ? caught.message : String(caught)}\n`);
  } finally {
    await browser?.close().catch(() => undefined);
    if (temporaryProfile.startsWith(temporaryRoot) && !opts.keepNetLog) {
      fs.rmSync(temporaryProfile, { recursive: true, force: true });
    }
  }
  const records = (proxy?.records ?? []).slice(start);
  const targets = [...new Set(records.map((record) => record.target))];
  const dohHost = new URL(MANAGED_SECURE_DNS_TEMPLATES[0]).host;
  const dohConnects = records.filter((record) => record.target === `${dohHost}:443`);
  return {
    index,
    pageState,
    title,
    proxyTargets: targets,
    dohHost,
    dohConnectCount: dohConnects.length,
    dohConnectOk: dohConnects.filter((record) => record.ok).length,
    netLog: scanNetLog(netLogPath),
  };
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-doh-"));
  const proxy = opts.mode === "http"
    ? await startLoggingProxy(opts.upstreamHost, opts.upstreamPort)
    : null;
  const samples: SampleResult[] = [];
  try {
    for (let index = 0; index < opts.samples; index++) {
      samples.push(await runSample(opts, proxy, index, temporaryRoot));
    }
  } finally {
    await proxy?.close();
    if (!opts.keepNetLog) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } else {
      process.stderr.write(`[verify-managed-doh] net logs kept under ${temporaryRoot}\n`);
    }
  }
  const dohHost = samples[0]?.dohHost || new URL(MANAGED_SECURE_DNS_TEMPLATES[0]).host;
  const allDohConnects = samples.reduce((sum, sample) => sum + sample.dohConnectCount, 0);
  const allDohOk = samples.reduce((sum, sample) => sum + sample.dohConnectOk, 0);
  const allResolverJobs = samples.reduce((sum, sample) => sum + (sample.netLog?.hostResolverJobs.length ?? 0), 0);
  const allDohRequests = samples.reduce((sum, sample) => sum + Math.max(sample.netLog?.dohUrlRequests ?? 0, 0), 0);
  const allDirectConnects = samples.reduce(
    (sum, sample) => sum + (sample.netLog?.directConnects.length ?? 0),
    0,
  );
  const directConnectHosts = Array.from(
    new Set(samples.flatMap((sample) => sample.netLog?.directConnects ?? [])),
  );
  const result = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    browser: opts.browser,
    mode: opts.mode,
    upstream: `${opts.upstreamHost}:${opts.upstreamPort}`,
    target: opts.target,
    dohHost,
    dohConnectCount: allDohConnects,
    dohConnectOk: allDohOk,
    localResolverJobHosts: allResolverJobs,
    dohUrlRequests: allDohRequests,
    samples,
    directConnectHosts,
    verdict: computeVerdict(allDirectConnects, allResolverJobs, allDohRequests, allDohConnects),
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (allDirectConnects > 0) {
    throw new Error("direct connections outside the proxy detected: " + directConnectHosts.join(", "));
  }
  if (opts.mode === "http" && allResolverJobs > 0 && allDohRequests > 0 && allDohConnects === 0) {
    throw new Error("no DoH CONNECT recorded for " + dohHost + ":443 through the proxy");
  }
}

function computeVerdict(
  directConnects: number,
  resolverJobs: number,
  dohRequests: number,
  dohConnects: number,
): string {
  if (directConnects > 0) return "direct-connect-leak";
  if (resolverJobs === 0) return "proxy-resolves-all";
  if (dohRequests > 0) return dohConnects > 0 ? "doh-via-proxy" : "doh-not-via-proxy";
  return "local-resolve-no-doh";
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
