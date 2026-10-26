import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const STORAGE_PATH = "/owned-storage/";
export const STORAGE_LOCAL_KEY = "owned-full-local";
export const STORAGE_DATABASE = "owned-full-idb";
const STORE = "owned-records", RECORD = "owned-record", CACHE = "owned-full-cache", CACHE_ENTRY = STORAGE_PATH + "cache-entry";
export interface StorageValues { local: string; indexed: string; cached: string; }
interface Page { send(method: string, params?: Record<string, unknown>): Promise<Record<string, any>>; }
const ensure = (condition: unknown, code: string) => { if (!condition) throw new Error(code); };
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

// These programs return boolean observations only. Values are synthetic and do
// not enter the receipt. The read program never creates a missing DB or cache.
const SEED = String.raw`async function (p) {
  if (!isSecureContext || location.origin !== p.origin) throw new Error('owned origin');
  if (localStorage.getItem(p.key) !== null || (await indexedDB.databases()).some(d => d.name === p.database) ||
      (await caches.keys()).includes(p.cache) || (await navigator.serviceWorker.getRegistrations()).some(r => r.scope === p.origin + p.scope)) throw new Error('not fresh');
  localStorage.setItem(p.key, p.values.local);
  const db = await new Promise((resolve, reject) => { const q = indexedDB.open(p.database, 1);
    q.onupgradeneeded = () => q.result.createObjectStore(p.store);
    q.onerror = () => reject(new Error('owned idb open')); q.onsuccess = () => resolve(q.result); });
  try { await new Promise((resolve, reject) => { const tx = db.transaction(p.store, 'readwrite');
    tx.objectStore(p.store).put(p.values.indexed, p.record); tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(new Error('owned idb write')); }); } finally { db.close(); }
  const cache = await caches.open(p.cache); await cache.put(p.entry, new Response(p.values.cached, {headers: {'content-type':'text/plain'}}));
  const registration = await navigator.serviceWorker.register(p.scope + 'sw.js', {scope:p.scope});
  const ready = await navigator.serviceWorker.ready;
  if (ready.scope !== p.origin + p.scope || !ready.active || registration.scope !== ready.scope) throw new Error('owned sw ready');
  return {secureContext:true, localStorageWritten:true, indexedDbTransactionComplete:true, cachePutComplete:true, serviceWorkerActivated:true};
}`;
const READ = String.raw`async function (p) {
  const checks = {secureContext:isSecureContext && location.origin === p.origin, localStorage:false, indexedDB:false,
    cacheStorage:false, serviceWorker:false, indexedDbKeySearched:false, cacheKeySearched:false, serviceWorkerScopeSearched:false, readOnly:true}, errors = [];
  if (!checks.secureContext) return {checks,errors:['OWNED_STORAGE_ORIGIN_INVALID']};
  try { checks.localStorage = localStorage.getItem(p.key) === p.values.local; } catch (_) { errors.push('OWNED_LOCAL_STORAGE_READ_FAILED'); }
  try {
    const databases = await indexedDB.databases();
    if (databases.some(d => d.name === p.database)) {
      const db = await new Promise((resolve, reject) => { const q = indexedDB.open(p.database);
        q.onupgradeneeded = () => { q.transaction.abort(); reject(new Error('owned read would create')); };
        q.onerror = () => reject(new Error('owned idb read open')); q.onsuccess = () => resolve(q.result); });
      try { const indexed = await new Promise((resolve, reject) => { const tx = db.transaction(p.store, 'readonly');
        const q = tx.objectStore(p.store).get(p.record); let value;
        q.onsuccess = () => { value = q.result; }; tx.oncomplete = () => resolve(value);
        tx.onabort = tx.onerror = () => reject(new Error('owned idb read')); });
        checks.indexedDbKeySearched = true; checks.indexedDB = indexed === p.values.indexed;
      } finally { db.close(); }
    }
  } catch (_) { errors.push('OWNED_INDEXED_DB_READ_FAILED'); }
  try { const cacheNames = await caches.keys();
    if (cacheNames.includes(p.cache)) { const cache = await caches.open(p.cache), response = await cache.match(p.entry);
      checks.cacheKeySearched = true; checks.cacheStorage = !!response && await response.text() === p.values.cached; }
  } catch (_) { errors.push('OWNED_CACHE_STORAGE_READ_FAILED'); }
  try { const registrations = await navigator.serviceWorker.getRegistrations(), registration = registrations.find(r => r.scope === p.origin + p.scope);
    checks.serviceWorkerScopeSearched = true; checks.serviceWorker = !!registration && !!registration.active && registration.active.scriptURL === p.origin + p.scope + 'sw.js';
  } catch (_) { errors.push('OWNED_SERVICE_WORKER_READ_FAILED'); }
  return {checks,errors};
}`;
function parameters(origin: string, values: StorageValues) {
  return { origin, values, key: STORAGE_LOCAL_KEY, database: STORAGE_DATABASE, store: STORE, record: RECORD,
    cache: CACHE, entry: origin + CACHE_ENTRY, scope: STORAGE_PATH };
}
async function execute(page: Page, program: string, origin: string, values: StorageValues) {
  const result = await page.send("Runtime.evaluate", { expression: "(" + program + ")(" + JSON.stringify(parameters(origin, values)) + ")",
    awaitPromise: true, returnByValue: true, timeout: 8000 });
  ensure(!result.exceptionDetails && result.result?.value && typeof result.result.value === "object", "OWNED_STORAGE_PROGRAM_FAILED");
  return result.result.value as Record<string, any>;
}
export async function seedNativeStorage(page: Page, origin: string, values: StorageValues) {
  const observed = await execute(page, SEED, origin, values);
  ensure(Object.keys(observed).length === 5 && Object.values(observed).every(value => value === true), "OWNED_STORAGE_SEED_UNCONFIRMED");
  return observed;
}
export async function readNativeStorage(page: Page, origin: string, values: StorageValues, strict = true) {
  const observed = await execute(page, READ, origin, values);
  ensure(observed.checks && Object.keys(observed.checks).length === 9 && Object.values(observed.checks).every(value => typeof value === "boolean") &&
    Array.isArray(observed.errors) && observed.errors.length <= 5 && observed.errors.every((code: unknown) => typeof code === "string" && /^OWNED_[A-Z_]+$/.test(code)), "OWNED_STORAGE_READBACK_SHAPE");
  if (strict) ensure(observed.errors.length === 0 && Object.values(observed.checks).every(value => value === true), "OWNED_STORAGE_NATIVE_READBACK_MISMATCH");
  return observed as { checks: Record<string, boolean>; errors: string[] };
}

export interface StorageFileFact { path: string; bytes: number; sha256: string; }
export interface StorageFilesFact {
  localStorage: { format: "sqlite" | "leveldb"; files: StorageFileFact[]; directKeyAndValueSearch: boolean; sqliteRowsSearched?: number };
  indexedDB: { files: StorageFileFact[] };
  cacheStorage: { files: StorageFileFact[] };
  serviceWorker: { files: StorageFileFact[] };
  fileCount: number;
  bytes: number;
}
// Only quiescent, test-created profiles are inventoried. No arbitrary symlink is
// followed. SQLite is queried on a tiny private copy so read-only WAL/SHM setup
// cannot mutate the original profile before its migration capture.
export function inspectNativeStorageFiles(options: {
  root: string; profile: string; label: string; origin: string; values: StorageValues;
  read: (file: string, maximum: number) => Buffer;
}): StorageFilesFact {
  const { root, profile, origin, values, read } = options;
  const base = path.join(profile, "Default"), all: StorageFileFact[] = [];
  let total = 0;
  function files(relative: string, optional = false): StorageFileFact[] {
    const at = path.join(base, relative), initial = fs.lstatSync(at, { throwIfNoEntry: false });
    if (!initial && optional) return [];
    ensure(initial && !initial.isSymbolicLink(), "OWNED_STORAGE_MEMBER_MISSING");
    const result: StorageFileFact[] = [];
    const visit = (file: string, depth: number) => {
      ensure(depth <= 12 && all.length < 256, "OWNED_STORAGE_INVENTORY_BUDGET");
      const stat = fs.lstatSync(file); ensure(!stat.isSymbolicLink(), "OWNED_STORAGE_LINK_REFUSED");
      if (stat.isDirectory()) { for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), depth + 1); return; }
      ensure(stat.isFile() && stat.nlink === 1 && stat.size <= 8 * 1024 ** 2, "OWNED_STORAGE_FILE_UNSAFE");
      if (path.basename(file) === "LOCK") return; // Same temporary lock exclusion as the full-profile format, not persistent state.
      const bytes = read(file, 8 * 1024 ** 2); total += bytes.length;
      ensure(total <= 32 * 1024 ** 2, "OWNED_STORAGE_INVENTORY_BUDGET");
      const fact = { path: path.relative(base, file).split(path.sep).join("/"), bytes: bytes.length, sha256: sha(bytes) };
      all.push(fact); result.push(fact);
    };
    visit(at, 0); return result;
  }
  const sqlite = fs.lstatSync(path.join(base, "LocalStorage"), { throwIfNoEntry: false });
  const localFiles = sqlite ? [files("LocalStorage"), files("LocalStorage-wal", true)].flat() : files("Local Storage/leveldb");
  let located = false, sqliteRowsSearched: number | undefined;
  const contains = (value: unknown, expected: string): boolean => {
    if (typeof value === "string") return value.includes(expected);
    if (!(value instanceof Uint8Array)) return false;
    const bytes = Buffer.from(value);
    return bytes.includes(Buffer.from(expected)) || bytes.includes(Buffer.from(expected, "utf16le"));
  };
  if (sqlite) {
    const scratch = path.join(root, "storage-sql-" + options.label + "-" + randomUUID()); fs.mkdirSync(scratch, { mode: 0o700 });
    for (const member of localFiles) {
      const bytes = read(path.join(base, member.path), 8 * 1024 ** 2), copy = path.join(scratch, path.basename(member.path));
      const fd = fs.openSync(copy, "wx", 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      ensure(sha(read(copy, 8 * 1024 ** 2)) === member.sha256, "OWNED_STORAGE_SQL_COPY_READBACK");
    }
    const db = new DatabaseSync(path.join(scratch, "LocalStorage"), { readOnly: true });
    try {
      ensure(db.prepare("PRAGMA integrity_check(1)").get()?.integrity_check === "ok", "OWNED_STORAGE_SQL_INTEGRITY");
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 33").all();
      ensure(tables.length > 0 && tables.length <= 32, "OWNED_STORAGE_SQL_SCHEMA_BUDGET");
      let originFound = false; sqliteRowsSearched = 0;
      for (const table of tables) {
        ensure(typeof table.name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(table.name), "OWNED_STORAGE_SQL_TABLE_UNSUPPORTED");
        const query = db.prepare('SELECT * FROM "' + table.name + '" LIMIT 257');
        // Chromium timestamps may exceed JS's safe integer range. Preserve them
        // as BigInts even though this query only searches text/blob key values.
        query.setReadBigInts(true);
        const rows = query.all();
        ensure(rows.length <= 256, "OWNED_STORAGE_SQL_ROW_BUDGET"); sqliteRowsSearched += rows.length;
        for (const row of rows) {
          const cells = Object.values(row);
          if (cells.some(value => contains(value, origin))) originFound = true;
          if (cells.some(value => contains(value, STORAGE_LOCAL_KEY)) && cells.some(value => contains(value, values.local))) located = true;
        }
      }
      ensure(originFound && located, "OWNED_STORAGE_SQL_KEY_VALUE_NOT_FOUND");
    } finally { db.close(); }
  } else {
    let key = false, value = false;
    for (const member of localFiles) {
      const bytes = read(path.join(base, member.path), 8 * 1024 ** 2);
      key ||= contains(bytes, STORAGE_LOCAL_KEY); value ||= contains(bytes, values.local);
    }
    located = key && value;
    ensure(located, "OWNED_STORAGE_LEVELDB_KEY_VALUE_NOT_FOUND");
  }
  const indexed = files("IndexedDB"), cached = files("Service Worker/CacheStorage");
  const worker = [...files("Service Worker/Database"), ...files("Service Worker/ScriptCache")];
  ensure(localFiles.length > 0 && indexed.length > 0 && cached.length > 0 && worker.length > 0, "OWNED_STORAGE_CATEGORY_EMPTY");
  for (const member of all) ensure(sha(read(path.join(base, member.path), 8 * 1024 ** 2)) === member.sha256, "OWNED_STORAGE_ORIGINAL_CHANGED_DURING_QUERY");
  return { localStorage: { format: sqlite ? "sqlite" : "leveldb", files: localFiles, directKeyAndValueSearch: located, ...(sqliteRowsSearched === undefined ? {} : { sqliteRowsSearched }) },
    indexedDB: { files: indexed }, cacheStorage: { files: cached }, serviceWorker: { files: worker }, fileCount: all.length, bytes: total };
}
