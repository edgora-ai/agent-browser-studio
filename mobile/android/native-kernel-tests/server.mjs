import http from 'node:http';
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURE_ROOT, REALMS, TOKEN_PATTERN } from './model.mjs';

// This server is optional source, NOT a command that has been executed.
// Loopback is intentional. There is no configurable public bind address.
const BIND_ADDRESS = '127.0.0.1';
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
export const MODULE_TRAILER = '\nglobalThis.NativeTimezoneFixtureModuleExecuted = true;\nexport {};\n';
const FILES = Object.freeze({
  'index.html': 'text/html; charset=utf-8',
  'frame.html': 'text/html; charset=utf-8',
  'fixture.css': 'text/css; charset=utf-8',
  'realm-probe.js': 'application/javascript; charset=utf-8',
  'model.mjs': 'application/javascript; charset=utf-8',
  'runner.mjs': 'application/javascript; charset=utf-8',
  'app.mjs': 'application/javascript; charset=utf-8',
  'frame.mjs': 'application/javascript; charset=utf-8',
});

function boundedInteger(value, minimum, maximum, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error(`Invalid ${label}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Invalid ${label}.`);
  return parsed;
}

export function parseArguments(args) {
  const supplied = new Map();
  const allowed = new Set(['--primary-port', '--cross-port', '--max-seconds', '--max-requests']);
  if (args.length % 2) throw new Error('Every option requires a value.');
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]) || supplied.has(args[index])) throw new Error('Unknown or duplicate option.');
    supplied.set(args[index], args[index + 1]);
  }
  const primaryPort = boundedInteger(supplied.get('--primary-port'), 1024, 65535, 'primary port');
  const crossPort = boundedInteger(supplied.get('--cross-port'), 1024, 65535, 'cross port');
  if (primaryPort === crossPort) throw new Error('Two distinct explicit ports are required.');
  return Object.freeze({
    primaryPort, crossPort,
    maxSeconds: boundedInteger(supplied.get('--max-seconds') ?? '900', 1, 900, 'time bound'),
    maxRequests: boundedInteger(supplied.get('--max-requests') ?? '512', 1, 2048, 'request bound'),
  });
}

function assertOptions(options) {
  return parseArguments([
    '--primary-port', String(options.primaryPort), '--cross-port', String(options.crossPort),
    '--max-seconds', String(options.maxSeconds), '--max-requests', String(options.maxRequests),
  ]);
}

export function serverOrigins(options) {
  return [options.primaryPort, options.crossPort].map((port) => `http://${BIND_ADDRESS}:${port}`);
}

export function planRequest(request, options, listenerPort) {
  if (!['GET', 'HEAD'].includes(request.method)) return { status: 405, text: 'Only GET and HEAD are allowed.' };
  if (![options.primaryPort, options.crossPort].includes(listenerPort)
      || request.host !== `${BIND_ADDRESS}:${listenerPort}`) return { status: 421, text: 'Unexpected loopback authority.' };
  if (request.origin !== undefined && !serverOrigins(options).includes(request.origin)) return { status: 403, text: 'Origin is outside the two supplied loopback origins.' };
  const target = request.target;
  if (typeof target !== 'string' || target.length > 512 || !target.startsWith('/') || target.startsWith('//')
      || /[%\\#]/.test(target) || [...target].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return { status: 400, text: 'Invalid fixed fixture target.' };
  const question = target.indexOf('?');
  const pathname = question === -1 ? target : target.slice(0, question);
  const query = question === -1 ? null : target.slice(question + 1);
  const isProbe = pathname === `${FIXTURE_ROOT}realm-probe.js` || pathname === `${FIXTURE_ROOT}realm-module.mjs`;
  if (query !== null) {
    if (!isProbe) return { status: 400, text: 'Queries are not accepted on this route.' };
    const parameters = new URLSearchParams(query);
    if ([...parameters].length !== 2 || parameters.getAll('runId').length !== 1 || parameters.getAll('realmId').length !== 1
        || !TOKEN_PATTERN.test(parameters.get('runId')) || !REALMS.includes(parameters.get('realmId'))) return { status: 400, text: 'Invalid synthetic worker identifiers.' };
  }
  if (pathname === FIXTURE_ROOT) return { status: 200, file: 'index.html', mime: FILES['index.html'], module: false };
  for (const [file, mime] of Object.entries(FILES)) {
    if (pathname === `${FIXTURE_ROOT}${file}`) return { status: 200, file, mime, module: false };
  }
  if (pathname === `${FIXTURE_ROOT}realm-module.mjs`) return { status: 200, file: 'realm-probe.js', mime: FILES['realm-probe.js'], module: true };
  const scope = /^\/native-timezone-fixture\/sw\/([a-f0-9]{32})\/(main|same|cross)\/(classic|module)\/entry\.js$/.exec(pathname);
  if (scope) return { status: 200, file: 'realm-probe.js', mime: FILES['realm-probe.js'], module: scope[3] === 'module' };
  return { status: 404, text: 'Not a whitelisted fixture route.' };
}

function sameIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

async function directoryIdentities(directory) {
  const root = path.parse(directory).root;
  let current = root;
  const chain = [];
  for (const component of ['', ...path.relative(root, directory).split(path.sep)]) {
    if (component) current = path.join(current, component);
    const stat = await lstat(current, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Fixture ancestor must be an ordinary non-symlink directory.');
    chain.push({ name: current, stat });
  }
  return chain;
}

async function verifyDirectories(chain) {
  for (const entry of chain) {
    const current = await lstat(entry.name, { bigint: true });
    if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(entry.stat, current)) throw new Error('Fixture ancestor changed during preload.');
  }
}

async function preloadAssets() {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') throw new Error('Required no-follow file flags are unavailable; no unsafe fallback is allowed.');
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const chain = await directoryIdentities(directory);
  const assets = new Map();
  let total = 0;
  for (const file of Object.keys(FILES)) {
    await verifyDirectories(chain);
    const filename = path.join(directory, file); // file is a constant allowlist key, never request data.
    const before = await lstat(filename, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_FILE_BYTES)) throw new Error('Fixture asset must be a bounded ordinary single-link file.');
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const pinned = await handle.stat({ bigint: true });
      if (!pinned.isFile() || pinned.nlink !== 1n || !sameIdentity(before, pinned) || pinned.size > BigInt(MAX_FILE_BYTES)) throw new Error('Fixture asset identity changed before read.');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const namedAfter = await lstat(filename, { bigint: true });
      if (length > MAX_FILE_BYTES || BigInt(length) !== pinned.size || pinned.size !== after.size
          || pinned.mtimeNs !== after.mtimeNs || pinned.ctimeNs !== after.ctimeNs
          || namedAfter.isSymbolicLink() || !sameIdentity(pinned, namedAfter)) throw new Error('Fixture asset changed or exceeded its read bound.');
      total += length;
      if (total > MAX_TOTAL_BYTES) throw new Error('Fixture preload exceeded its total byte bound.');
      assets.set(file, Buffer.from(buffer.subarray(0, length)));
    } finally {
      await handle.close();
    }
  }
  await verifyDirectories(chain);
  assets.set('module-body', Buffer.concat([assets.get('realm-probe.js'), Buffer.from(MODULE_TRAILER)]));
  return assets;
}

export function responseHeaders(options, mime, length) {
  const sources = serverOrigins(options).join(' ');
  return {
    'Content-Type': mime,
    'Content-Length': length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Connection': 'close',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'; frame-src ${sources}; frame-ancestors ${sources}; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`,
    // No CORS wildcard, cookies, directory listing or broad Service-Worker-Allowed.
  };
}

export async function startFixtureServers(inputOptions) {
  const options = assertOptions(inputOptions);
  const assets = await preloadAssets(); // No request causes any filesystem access.
  const sockets = new Set();
  const servers = [];
  let requestCount = 0;
  let stopped = false;
  let ready = false;
  let timer;
  const stop = (reason = 'explicit close') => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    for (const server of servers) if (server.listening) server.close();
    for (const socket of sockets) socket.destroy();
    console.log(`[fixture] stopped: ${reason}; requests=${requestCount}. No browser storage cleanup is implied.`);
  };
  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    for (const port of [options.primaryPort, options.crossPort]) {
      const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, (request, response) => {
        request.on('error', () => response.destroy());
        response.on('error', () => response.destroy());
        requestCount += 1;
        const overBudget = requestCount > options.maxRequests || stopped;
        let plan = overBudget ? { status: 503, text: 'Fixture request budget exhausted.' } : planRequest({
          method: request.method, target: request.url,
          host: request.headers.host, origin: request.headers.origin,
        }, options, port);
        if (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) plan = { status: 400, text: 'Request bodies are not accepted.' };
        const buffer = plan.status === 200 ? assets.get(plan.module ? 'module-body' : plan.file) : Buffer.from(plan.text);
        response.writeHead(plan.status, responseHeaders(options, plan.mime ?? 'text/plain; charset=utf-8', buffer.length));
        if (requestCount >= options.maxRequests) response.once('finish', () => stop('request bound'));
        response.end(request.method === 'HEAD' ? undefined : buffer);
      });
      servers.push(server);
      server.maxConnections = 16;
      server.maxRequestsPerSocket = 1;
      server.maxHeadersCount = 32;
      server.on('connection', (socket) => {
        if (stopped || sockets.size >= 16) { socket.destroy(); return; }
        sockets.add(socket);
        socket.setTimeout(5000, () => socket.destroy());
        socket.once('close', () => sockets.delete(socket));
      });
      server.on('clientError', (_error, socket) => socket.destroy());
      server.on('error', () => { if (ready) stop('listener failure'); });
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
        const onListening = () => {
          server.removeListener('error', onError);
          if (stopped) { server.close(); reject(new Error('Server stopped during listener startup.')); return; }
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host: BIND_ADDRESS, port, exclusive: true });
      });
    }
    if (stopped) throw new Error('Server stopped during startup.');
    ready = true;
    timer = setTimeout(() => stop('time bound'), options.maxSeconds * 1000);
    timer.unref();
    const origins = serverOrigins(options);
    console.log(`[fixture] primary ${origins[0]}${FIXTURE_ROOT}index.html`);
    console.log(`[fixture] cross   ${origins[1]}${FIXTURE_ROOT}frame.html`);
    console.log(`[fixture] bound to IPv4 loopback only; max ${options.maxSeconds}s / ${options.maxRequests} requests; no request/header/body logging.`);
    return { origins, close: () => stop('explicit close') };
  } catch (error) {
    stop('startup failure');
    throw error;
  }
}

// Importing this module (including from node:test) never binds sockets or reads assets.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await startFixtureServers(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(`Fixture server did not start (${String(error?.code ?? error?.name ?? 'Error')}). Supply distinct --primary-port PORT_A --cross-port PORT_B; only the bounded fixed fixture is served.`);
    process.exitCode = 1;
  }
}
