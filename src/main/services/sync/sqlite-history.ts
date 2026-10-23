import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { BrowserEngine, HistoryArtifact, HistoryCoverage, HistorySchema, ProfileHistoryBaseline } from "../../types.js";
import { parseHistoryCoverage, parseProfileHistoryBaseline } from "../profile-portability.js";
import { ensureArchiveDirectory, writeZipArchive, readZipEntries, extractZipEntry } from "../zip-writer.js";
import { sqliteGroupWitnesses, assertSqliteGroupUnchanged, readPinnedSqliteFile, writeOwnedSqliteFile,
  validateSqliteLocalStorageGroup, runSqliteChecker, MAX_SQLITE_LOCAL_STORAGE_BYTES } from "./sqlite-local-storage.js";

export const MAX_HISTORY_BYTES = MAX_SQLITE_LOCAL_STORAGE_BYTES;
export const MAX_HISTORY_OBJECT_BYTES = MAX_HISTORY_BYTES + 1024 * 1024;
export const MAX_SYNC_HISTORY_BYTES = 256 * 1024 * 1024;
export const historyPath = (engine: BrowserEngine): "Default/History" | "places.sqlite" => {
  if (engine !== "chromium" && engine !== "firefox") throw new Error("Unsupported history engine");
  return engine === "firefox" ? "places.sqlite" : "Default/History";
};
export const historyBasename = (engine: BrowserEngine) => path.posix.basename(historyPath(engine));
export const historySidecars = (engine: BrowserEngine) => { const main = historyBasename(engine); return [main, main + "-wal", main + "-shm", main + "-journal"]; };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
}
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("Sync operation cancelled"); };
export interface HistorySummary {
  schema: HistorySchema;
  semanticHash: string;
  counts: { urls: string; visits: string; bookmarks: string };
}
export interface PreparedHistory {
  stagingDir: string;
  owner: { dev: number; ino: number };
  files: number;
  bytesWritten: number;
  format: "sqlite";
  inventory: Array<{ name: string; hash: string }>;
  summary: HistorySummary;
}

// Trusted SELECTs against ordinary tables only. Schema SQL is hashed as data,
// never executed/interpolated. No immutable=1: the owned copy's WAL participates.
// Integer values are read as bigint and hashed with decimal/type tags, not Number.
const CHECKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
let db, closing=false;
const fail = (message) => { throw new Error(message); };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = (name) => '"' + name.replace(/"/g, '""') + '"';
const integer = (sql) => { const s=db.prepare(sql); s.setReadBigInts(true); return Object.values(s.get())[0]; };
try {
  db = new DatabaseSync(workerData.file, { readOnly:true, allowExtension:false, enableDoubleQuotedStringLiterals:false, timeout:100 });
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA ignore_check_constraints=ON; PRAGMA mmap_size=0; PRAGMA cache_size=-2048;');
  const query=db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY type,name LIMIT 257'); query.setReadBigInts(true);
  const schema=query.all(), tables=new Map();
  if (schema.length>256) fail('schema limit');
  let schemaBytes=0;
  for (const row of schema) {
    if (!['table','index','trigger'].includes(row.type) || typeof row.name!=='string' || row.name.length>256 || /\x00/.test(row.name) ||
        typeof row.tbl_name!=='string' || row.tbl_name.length>256 || row.sql!==null && typeof row.sql!=='string' ||
        row.type!=='trigger' && (row.rootpage<1n || row.rootpage>16384n)) fail('unsupported schema');
    schemaBytes+=row.sql ? Buffer.byteLength(row.sql) : 0;
    if (schemaBytes>524288 || row.type==='table' && /\b(?:CHECK|VIRTUAL\s+TABLE)\b/i.test(row.sql || '')) fail('unsupported/oversized schema expression');
    if (row.type==='table') {
      const columns=db.prepare('SELECT name,hidden FROM pragma_table_xinfo(?) LIMIT 257').all(row.name);
      if (!columns.length || columns.length>256 || columns.some(c => c.hidden!==0 || typeof c.name!=='string' || c.name.length>256)) fail('unsupported generated columns');
      tables.set(row.name, columns.map(c=>c.name));
    } else if (row.type==='index') {
      if (db.prepare('SELECT cid FROM pragma_index_xinfo(?) LIMIT 257').all(row.name).some(c=>c.cid===-2)) fail('unsupported expression index');
    }
  }
  const pages=integer('PRAGMA page_count'); if (pages<1n || pages>16384n) fail('page limit');
  const userVersion=integer('PRAGMA user_version'), applicationId=integer('PRAGMA application_id');
  if (userVersion<0n || applicationId<0n) fail('unsupported schema version');
  const required = workerData.engine==='firefox' ? {moz_places:['id','url','title'],moz_historyvisits:['id','place_id','visit_date'],moz_bookmarks:['id','fk','parent','type']}
    : {urls:['id','url','title'],visits:['id','url','visit_time'],meta:['key','value']};
  for (const [table, columns] of Object.entries(required)) if (!tables.has(table) || columns.some(c=>!tables.get(table).includes(c))) fail('incompatible history engine/schema');
  let metaVersion=null, compatibleVersion=null;
  if (workerData.engine==='chromium') {
    const versions=db.prepare("SELECT key,CAST(value AS TEXT) AS value FROM meta WHERE key IN ('version','last_compatible_version')").all();
    metaVersion=versions.find(r=>r.key==='version')?.value; compatibleVersion=versions.find(r=>r.key==='last_compatible_version')?.value;
    // Shipped post-0055 Chromium152 history_database.cc: current70,
    // compatible16, supported migration floor15. Unknown future writers fail.
    if (![metaVersion,compatibleVersion].every(v=>typeof v==='string' && /^[1-9][0-9]{0,3}$/.test(v)) || BigInt(metaVersion)<15n || BigInt(metaVersion)>70n ||
        BigInt(compatibleVersion)>BigInt(metaVersion) || BigInt(compatibleVersion)>16n) fail('unsupported Chromium history schema version');
  // Firefox154 nsINavHistoryService.idl/Database.cpp: current86, migration
  // floor52. This is source-bound admission, not a live Firefox UI proof.
  } else if (userVersion<52n || userVersion>86n) fail('unsupported Firefox Places schema version');
  if (db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check!=='ok') fail('integrity_check failed');
  if (db.prepare('PRAGMA foreign_key_check').get()) fail('foreign key relations failed');
  const dangling=workerData.engine==='firefox'
    ? 'SELECT 1 FROM moz_historyvisits v LEFT JOIN moz_places p ON p.id=v.place_id WHERE p.id IS NULL LIMIT 1'
    : 'SELECT 1 FROM visits v LEFT JOIN urls u ON u.id=v.url WHERE u.id IS NULL LIMIT 1';
  if (db.prepare(dangling).get()) fail('history relation missing');
  if (workerData.engine==='firefox' && db.prepare('SELECT 1 FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id=b.fk WHERE b.fk IS NOT NULL AND p.id IS NULL LIMIT 1').get()) fail('bookmark relation missing');
  let cells=0, bytes=0, rows=0;
  const typed=(v)=> {
    cells++; if (cells>2000000) fail('cell limit');
    if (v===null) return ['null'];
    if (typeof v==='bigint') return ['integer',v.toString(10)];
    if (typeof v==='number') { const b=Buffer.alloc(8); b.writeDoubleBE(v); return ['real',b.toString('hex')]; }
    if (typeof v==='string') { bytes+=Buffer.byteLength(v); if (bytes>67108864) fail('value byte limit'); return ['text',v]; }
    if (v instanceof Uint8Array) { bytes+=v.byteLength; if (bytes>67108864) fail('value byte limit'); return ['blob',Buffer.from(v).toString('base64')]; }
    fail('unsupported value type');
  };
  const logical=createHash('sha256');
  for (const [name, allColumns] of [...tables].sort(([a],[b])=>a<b?-1:a>b?1:0)) {
    // These are SQLite/browser maintenance metadata, not visits/bookmarks.
    // They remain fully transported and covered by the physical member digests.
    if (name.startsWith('sqlite_') || ['meta','moz_meta'].includes(name)) continue;
    const maintenance = name==='moz_places' || name==='moz_origins' ? ['frecency','alt_frecency','recalc_frecency','recalc_alt_frecency','frecency_score','frecency_last_updated'] : [];
    const columns=allColumns.filter(c=>!maintenance.includes(c));
    const statement=db.prepare('SELECT '+columns.map(quote).join(',')+' FROM '+quote(name)); statement.setReadBigInts(true);
    const rowHashes=[];
    for (const row of statement.iterate()) { if (++rows>200000) fail('row limit'); rowHashes.push(hash(columns.map(c=>typed(row[c])))); }
    rowHashes.sort(); logical.update(JSON.stringify([name,columns])+'\n'); for (const rowHash of rowHashes) logical.update(rowHash+'\n');
  }
  // Exclude physical rootpage offsets and internal statistics from schema identity.
  const schemaHash=hash(schema.filter(r=>!r.name.startsWith('sqlite_')).map(r=>[r.type,r.name,r.tbl_name,r.sql]));
  const counts={ urls:integer(workerData.engine==='firefox'?'SELECT count(*) FROM moz_places':'SELECT count(*) FROM urls').toString(),
    visits:integer(workerData.engine==='firefox'?'SELECT count(*) FROM moz_historyvisits':'SELECT count(*) FROM visits').toString(),
    bookmarks:workerData.engine==='firefox'?integer('SELECT count(*) FROM moz_bookmarks').toString():'0' };
  const value={schema:{version:1,sha256:schemaHash,userVersion:userVersion.toString(),applicationId:applicationId.toString(),metaVersion,compatibleVersion},
    semanticHash:hash({version:1,engine:workerData.engine,schemaHash,logical:logical.digest('hex')}),counts};
  closing=true; db.close(); db=undefined; closing=false; parentPort.postMessage({ok:true,value});
} catch (error) {
  let closeFailed=closing;
  if (db) { try { db.close(); } catch (closeError) { closeFailed=true; } }
  // Only controlled diagnostics cross the worker; never URL/title/body data.
  const reason=closeFailed?'SQLite close failed':/^(unsupported|incompatible|schema|page|integrity_check|foreign key|history relation|bookmark relation|cell|value byte|row)/.test(error.message)?error.message:'SQLite read failed';
  parentPort.postMessage({ok:false,reason,code:/^(unsupported|incompatible)/.test(reason)?'HISTORY_SCHEMA_UNSUPPORTED':'HISTORY_VALIDATION_FAILED'});
} finally { parentPort.close(); }
`;

function preparedInventory(directory: string, engine: BrowserEngine, signal?: AbortSignal) {
  const name = historyBasename(engine), group = sqliteGroupWitnesses(directory, name);
  if (!group[0].stat || group[2].stat || group[3].stat) throw new Error("Invalid history staging group");
  let bytesWritten = 0;
  const inventory = group.slice(0, 2).flatMap((item) => {
    if (!item.stat) return [];
    bytesWritten += item.stat.size;
    if (bytesWritten > MAX_HISTORY_BYTES) throw new Error("History group byte limit exceeded");
    return [{ name: item.name, hash: sha(readPinnedSqliteFile(path.join(directory, item.name), item.stat, signal)) }];
  });
  return { group, inventory, bytesWritten };
}
export async function validateHistoryDirectory(directory: string, engine: BrowserEngine, signal?: AbortSignal): Promise<PreparedHistory> {
  abort(signal); ensureArchiveDirectory(directory);
  const owner = fs.lstatSync(directory), before = preparedInventory(directory, engine, signal), name = historyBasename(engine);
  const main = readPinnedSqliteFile(path.join(directory, name), before.group[0].stat!, signal);
  const wal = before.group[1].stat ? readPinnedSqliteFile(path.join(directory, name + "-wal"), before.group[1].stat, signal) : undefined;
  validateSqliteLocalStorageGroup(main, wal, signal);
  const scratch = fs.mkdtempSync(path.join(directory, ".history-check-")), scratchOwner = fs.lstatSync(scratch);
  try {
    writeOwnedSqliteFile(path.join(scratch, name), main);
    if (wal !== undefined) writeOwnedSqliteFile(path.join(scratch, name + "-wal"), wal);
    const summary = await runSqliteChecker<HistorySummary>(CHECKER, { file: path.join(scratch, name), engine }, "SQLite history", signal);
    abort(signal); assertSqliteGroupUnchanged(directory, before.group, name);
    if (JSON.stringify(preparedInventory(directory, engine, signal).inventory) !== JSON.stringify(before.inventory)) throw new Error("History staging bytes changed during validation");
    const now = fs.lstatSync(directory); if (now.dev !== owner.dev || now.ino !== owner.ino || now.isSymbolicLink()) throw new Error("History staging owner changed");
    return { stagingDir: directory, owner, files: before.inventory.length, bytesWritten: before.bytesWritten, format: "sqlite", inventory: before.inventory, summary };
  } finally {
    const current = fs.lstatSync(scratch);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== scratchOwner.dev || current.ino !== scratchOwner.ino) throw new Error("History checker scratch owner changed; retained for recovery");
    fs.rmSync(scratch, { recursive: true });
  }
}

/** Capture main+WAL together; never open, checkpoint, repair or write the source. */
export async function captureHistory(profileDirectory: string, engine: BrowserEngine, stageRoot: string, guard: () => void, signal?: AbortSignal, byteBudget = MAX_HISTORY_BYTES): Promise<PreparedHistory | null> {
  abort(signal); guard();
  const relative = historyPath(engine), name = historyBasename(engine), source = path.dirname(path.join(profileDirectory, relative));
  const expected = sqliteGroupWitnesses(source, name);
  if (expected.some((item) => item.stat && item.stat.size > MAX_HISTORY_BYTES)) throw new Error("History source exceeds byte limit");
  if (!expected[0].stat) {
    if (expected.some((item) => item.stat)) throw new Error("Orphan history WAL/SHM without main database");
    assertSqliteGroupUnchanged(source, expected, name); guard(); return null;
  }
  const total = expected.slice(0, 2).reduce((n, item) => n + (item.stat?.size || 0), 0);
  if (!Number.isSafeInteger(byteBudget) || byteBudget < 0 || total > Math.min(MAX_HISTORY_BYTES, byteBudget)) throw new Error("History group/remaining aggregate byte limit exceeded");
  const directory = fs.mkdtempSync(path.join(stageRoot, "history-")), owner = fs.lstatSync(directory);
  let complete = false;
  try {
    for (const item of expected.slice(0, 2)) {
      if (!item.stat) continue;
      writeOwnedSqliteFile(path.join(directory, item.name), readPinnedSqliteFile(path.join(source, item.name), item.stat, signal));
    }
    const prepared = await validateHistoryDirectory(directory, engine, signal);
    assertSqliteGroupUnchanged(source, expected, name);
    for (const item of expected.slice(0, 2)) if (item.stat && sha(readPinnedSqliteFile(path.join(source, item.name), item.stat, signal)) !== prepared.inventory.find((entry) => entry.name === item.name)?.hash) throw new Error("History source bytes changed during capture");
    assertSqliteGroupUnchanged(source, expected, name); guard(); abort(signal); complete = true; return prepared;
  } finally {
    if (!complete) {
      const current = fs.lstatSync(directory);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error("Failed history capture owner changed; retained for recovery");
      // Native checker completion is awaited before failed owned bytes are removed.
      fs.rmSync(directory, { recursive: true });
    }
  }
}
export async function makeHistoryArtifact(prepared: PreparedHistory, engine: BrowserEngine, dirId: string, snapshotId: string, capturedAt: number, stageRoot: string, signal?: AbortSignal): Promise<{ artifact: HistoryArtifact; body: Buffer }> {
  abort(signal);
  const relative = historyPath(engine), archive = path.join(stageRoot, `history-object-${dirId}.zip`);
  await writeZipArchive(archive, prepared.inventory.map((member) => ({ name: relative + (member.name.endsWith("-wal") ? "-wal" : ""), filePath: path.join(prepared.stagingDir, member.name) })));
  const body = readPinnedSqliteFile(archive, fs.lstatSync(archive), signal, MAX_HISTORY_OBJECT_BYTES);
  const digest = sha(body);
  const artifact: HistoryArtifact = { version: 1, snapshotId, dirId, engine, path: relative, capturedAt, ...prepared.summary,
    members: prepared.inventory.map((member) => ({ path: relative + (member.name.endsWith("-wal") ? "-wal" : ""), bytes: fs.lstatSync(path.join(prepared.stagingDir, member.name)).size, sha256: member.hash })),
    object: { key: `history-v1-${digest}.zip`, bytes: body.length, sha256: digest } };
  if (!parseHistoryCoverage({ version: 1, snapshotId, dirId, engine, state: Object.values(artifact.counts).every((n) => n === "0") ? "empty" : "complete", freshness: "captured", artifact })) throw new Error("Invalid captured history descriptor");
  return { artifact, body };
}
export async function prepareHistoryArtifact(body: Buffer, artifact: HistoryArtifact, stageRoot: string, signal?: AbortSignal): Promise<PreparedHistory> {
  abort(signal);
  if (body.length > MAX_HISTORY_OBJECT_BYTES || body.length !== artifact.object.bytes || sha(body) !== artifact.object.sha256) throw new Error("History object digest/size mismatch");
  const entries = readZipEntries(body);
  if (entries.length !== artifact.members.length || entries.some((entry, i) => entry.isDirectory || entry.name !== artifact.members[i].path || entry.uncompressedSize !== artifact.members[i].bytes)) throw new Error("History ZIP member/path mismatch");
  const directory = fs.mkdtempSync(path.join(stageRoot, "history-incoming-"));
  let total = 0;
  for (const [index, entry] of entries.entries()) {
    total += entry.uncompressedSize; if (total > MAX_HISTORY_BYTES) throw new Error("History members exceed byte limit");
    const bytes = extractZipEntry(body, entry);
    if (sha(bytes) !== artifact.members[index].sha256) throw new Error("History member digest mismatch");
    writeOwnedSqliteFile(path.join(directory, path.posix.basename(entry.name)), bytes);
  }
  const prepared = await validateHistoryDirectory(directory, artifact.engine, signal);
  if (JSON.stringify(canonical(prepared.summary)) !== JSON.stringify(canonical({ schema: artifact.schema, semanticHash: artifact.semanticHash, counts: artifact.counts }))) throw new Error("History schema/semantic descriptor mismatch");
  return prepared;
}
export function historyBaseline(coverage: HistoryCoverage, targetId: string): ProfileHistoryBaseline | null {
  if (coverage.state === "absent") return parseProfileHistoryBaseline({ version: 1, targetId, snapshotId: coverage.snapshotId, engine: coverage.engine,
    state: "absent", semanticHash: null, schemaHash: null, timestamp: coverage.capturedAt });
  if (!coverage.artifact) return null;
  return parseProfileHistoryBaseline({ version: 1, targetId, snapshotId: coverage.artifact.snapshotId, engine: coverage.engine, state: "present",
    semanticHash: coverage.artifact.semanticHash, schemaHash: coverage.artifact.schema.sha256, timestamp: coverage.artifact.capturedAt });
}
