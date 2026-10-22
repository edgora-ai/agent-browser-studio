import * as fs from "node:fs";
import * as path from "node:path";
import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Worker } from "node:worker_threads";
import { TextDecoder } from "node:util";
import { readPinnedSqliteFile, validateSqliteLocalStorageGroup } from "./sqlite-local-storage.js";

/** This module never opens a live profile or obtains an OS/keychain secret. The
 * caller supplies an immutable full-profile staging, its inode owner, and source
 * provenance authenticated by the enclosing snapshot. Only newly owned copies
 * are opened by SQLite. A successful result is not permission to publish live. */
export type CredentialPlatform = "darwin" | "linux" | "win32";
export interface CredentialIdentity {
  engine: "chromium" | "firefox";
  platform: CredentialPlatform;
  identityId: string;
  backend: "chromium-basic" | "chromium-mock-keychain" | "chromium-provided-key" | "chromium-windows-dpapi" | "chromium-app-bound" | "firefox-nss";
  algorithm: "aes-128-cbc" | "aes-256-gcm" | "nss-sdr";
  keyId: string;
}
export interface CredentialCryptoContext {
  identity: CredentialIdentity;
  relativePath: string;
  table: string;
  column: string;
  rowId: string;
  databaseVersion: number;
  cookieHost?: string;
}
/** Buffers are borrowed for the duration of a call. Adapters must not retain,
 * log, persist, or mutate them; return a newly owned Buffer, or throw. Empty
 * plaintext is a real value, never an error sentinel. No implicit fallback key. */
export interface CredentialCryptoAdapter {
  readonly identity: CredentialIdentity;
  readonly encryptedPrefixes: readonly ("v10" | "v11")[];
  decrypt(ciphertext: Buffer, context: CredentialCryptoContext): Buffer | Promise<Buffer>;
  encrypt(plaintext: Buffer, context: CredentialCryptoContext): Buffer | Promise<Buffer>;
  dispose?(): void;
}
export interface CredentialFile { relativePath: string; sha256: string; bytes: number }
export interface FirefoxCredentialPairBinding {
  version: 1;
  source: CredentialIdentity;
  profileRelativePath: string;
  members: CredentialFile[];
}
export interface ProfileCredentialReport {
  version: 1;
  scope: "chromium-login-cookie-databases" | "firefox-nss-login-pair";
  source: CredentialIdentity;
  receiver?: CredentialIdentity;
  status: "absent" | "source-verified" | "source-codec-required" | "receiver-verified" | "paired-files-preserved";
  verification: "no-credential-files" | "not-verified" | "source-decrypt" | "receiver-sql-decrypt" | "paired-files-only";
  passwordUsability: "no-stored-secrets" | "not-verified" | "verified-with-codec" | "requires-firefox-nss-unlock";
  hardwarePasskeys: "not-portable";
  databases: Array<{ relativePath: string; version: number; fields: number; encryptedFields: number; emptyFields: number; plaintextCookies: number }>;
  sourceFiles: CredentialFile[];
  firefoxPair?: FirefoxCredentialPairBinding;
  warnings: string[];
}
export interface ProfileCredentialOptions {
  stagingRoot: string;
  stagingOwner: { dev: number; ino: number };
  /** Explicit directory inside the full-profile root, e.g. Default or . */
  profileRelativePath: string;
  source: CredentialIdentity;
  sourceAdapter?: CredentialCryptoAdapter;
  /** On restore this must come from the authenticated source manifest, not be
   * synthesized from whatever pair happened to arrive at the receiver. */
  expectedFirefoxPair?: FirefoxCredentialPairBinding;
  guard?: () => void;
  signal?: AbortSignal;
}
export interface ConvertProfileCredentialOptions extends ProfileCredentialOptions {
  receiver: CredentialIdentity;
  receiverAdapter?: CredentialCryptoAdapter;
}
export interface ConvertedProfileCredentials {
  report: ProfileCredentialReport;
  outputDirectory: string;
  outputOwner: { dev: number; ino: number };
  replacements: Array<CredentialFile & { outputPath: string }>;
  /** Only sidecars actually present in the input, and only for converted DBs.
   * Apply together with replacements before reopening the receiver staging. */
  removeRelativePaths: string[];
  preservedSource: true;
}
export class CredentialPortabilityError extends Error {
  constructor(public readonly code: string) { super(`Credential portability failed (${code})`); this.name = "CredentialPortabilityError"; }
}
function fail(code: string): never { throw new CredentialPortabilityError(code); }
const MAX_GROUP = 64 * 1024 * 1024, MAX_TOTAL = 128 * 1024 * 1024, MAX_VALUE = 1024 * 1024;
const MAX_JSON = 8 * 1024 * 1024, MAX_ROWS = 50000, WORKER_TIMEOUT = 8000;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const encodedIdentity = (identity: CredentialIdentity) => JSON.stringify([identity.engine, identity.platform, identity.identityId, identity.backend, identity.algorithm, identity.keyId]);
const sameIdentity = (a: CredentialIdentity, b: CredentialIdentity) => encodedIdentity(a) === encodedIdentity(b);
const overlaps = (a: Buffer, b: Buffer) => a.buffer === b.buffer && a.byteOffset < b.byteOffset + b.byteLength && b.byteOffset < a.byteOffset + a.byteLength;
function checkIdentity(value: CredentialIdentity): void {
  if (!value || !["chromium", "firefox"].includes(value.engine) || !["darwin", "linux", "win32"].includes(value.platform) ||
      ![value.identityId, value.keyId].every(v => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v))) fail("IDENTITY_INVALID");
  if (value.engine === "firefox") {
    if (value.backend !== "firefox-nss" || value.algorithm !== "nss-sdr") fail("IDENTITY_INVALID");
  } else if (!(["chromium-basic", "chromium-mock-keychain", "chromium-provided-key", "chromium-windows-dpapi", "chromium-app-bound"] as string[]).includes(value.backend) ||
      !["aes-128-cbc", "aes-256-gcm"].includes(value.algorithm) ||
      value.backend === "chromium-basic" && (value.platform !== "linux" || value.algorithm !== "aes-128-cbc") ||
      value.backend === "chromium-mock-keychain" && (value.platform !== "darwin" || value.algorithm !== "aes-128-cbc") ||
      value.backend === "chromium-provided-key" && value.algorithm !== (value.platform === "win32" ? "aes-256-gcm" : "aes-128-cbc") ||
      ["chromium-windows-dpapi", "chromium-app-bound"].includes(value.backend) && (value.platform !== "win32" || value.algorithm !== "aes-256-gcm")) fail("IDENTITY_INVALID");
}
/** platform is mandatory SOURCE provenance, never defaulted to process.platform.
 * These mappings describe the existing managed launch policy, not arbitrary
 * imported Chrome profiles. Never use this helper to guess an import's backend. */
export function identityForManagedProfile(engine: CredentialIdentity["engine"], platform: CredentialPlatform, identityId: string): CredentialIdentity {
  const value: CredentialIdentity = engine === "firefox" ? { engine, platform, identityId, backend: "firefox-nss", algorithm: "nss-sdr", keyId: "profile-nss-key4" }
    : platform === "linux" ? { engine, platform, identityId, backend: "chromium-basic", algorithm: "aes-128-cbc", keyId: "chromium-posix-basic-v10" }
    : platform === "darwin" ? { engine, platform, identityId, backend: "chromium-mock-keychain", algorithm: "aes-128-cbc", keyId: "chromium-mac-mock-v10" }
    : { engine, platform, identityId, backend: "chromium-windows-dpapi", algorithm: "aes-256-gcm", keyId: "chromium-windows-os-key" };
  checkIdentity(value); return Object.freeze(value);
}
function prefixOf(bytes: Buffer): string { return bytes.subarray(0, 3).toString("ascii"); }
function assertContext(adapter: CredentialCryptoAdapter, context: CredentialCryptoContext): void {
  if (!sameIdentity(adapter.identity, context.identity)) fail("ADAPTER_IDENTITY_MISMATCH");
}
/** Usable native OSCrypt codecs with an explicitly supplied, already authorized
 * data key. This is NOT a DPAPI/keychain reader or an AppBound bypass. Windows
 * DPAPI-only blobs and v20 remain unsupported, including with a custom adapter. */
export function createChromiumKeyCredentialAdapter(options: { identity: CredentialIdentity; key: Buffer; prefix?: "v10" | "v11" }): CredentialCryptoAdapter {
  checkIdentity(options.identity);
  const identity = Object.freeze({ ...options.identity }), prefix = options.prefix ?? "v10";
  if (identity.engine !== "chromium" || identity.backend !== "chromium-provided-key" ||
      !Buffer.isBuffer(options.key) || options.key.length !== (identity.algorithm === "aes-128-cbc" ? 16 : 32) ||
      !["v10", "v11"].includes(prefix) || prefix === "v11" && identity.platform !== "linux") fail("UNSUPPORTED_BACKEND");
  const key = Buffer.from(options.key); let disposed = false;
  const adapter: CredentialCryptoAdapter = {
    identity, encryptedPrefixes: Object.freeze([prefix]),
    decrypt(bytes, context) {
      assertContext(adapter, context); if (disposed) fail("ADAPTER_DISPOSED");
      if (prefixOf(bytes) === "v20") fail("APP_BOUND_UNSUPPORTED");
      if (prefixOf(bytes) !== prefix) fail("CRYPTO_FORMAT_UNSUPPORTED");
      const body = bytes.subarray(3);
      try {
        if (identity.algorithm === "aes-128-cbc") {
          if (!body.length || body.length % 16) fail("CRYPTO_FORMAT_UNSUPPORTED");
          const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
          const first = decipher.update(body);
          try { return Buffer.concat([first, decipher.final()]); } finally { first.fill(0); }
        }
        if (body.length < 28) fail("CRYPTO_FORMAT_UNSUPPORTED");
        const decipher = createDecipheriv("aes-256-gcm", key, body.subarray(0, 12));
        decipher.setAuthTag(body.subarray(-16));
        const first = decipher.update(body.subarray(12, -16));
        try { return Buffer.concat([first, decipher.final()]); } finally { first.fill(0); }
      } catch (error) { if (error instanceof CredentialPortabilityError) throw error; fail("DECRYPT_FAILED"); }
    },
    encrypt(clear, context) {
      assertContext(adapter, context); if (disposed) fail("ADAPTER_DISPOSED");
      try {
        if (identity.algorithm === "aes-128-cbc") {
          const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
          return Buffer.concat([Buffer.from(prefix), cipher.update(clear), cipher.final()]);
        }
        const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
        return Buffer.concat([Buffer.from(prefix), nonce, cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
      } catch { fail("ENCRYPT_FAILED"); }
    },
    dispose() { key.fill(0); disposed = true; },
  };
  return Object.freeze(adapter);
}
/** Public Chromium152 posix_key_provider.cc, keychain_key_provider.mm and
 * encryptor.cc specify v10/AES128CBC/16-space IV. Linux basic derives peanuts /
 * saltysalt / 1; the existing Mac --use-mock-keychain derives mock_password /
 * saltysalt / 1003 (also pinned by Chromium's known-answer test). We neither
 * change launch switches nor query the real keychain. CBC has no authentication. */
export function createBasicChromiumAdapter(identity: CredentialIdentity): CredentialCryptoAdapter {
  checkIdentity(identity);
  const expected = identityForManagedProfile("chromium", identity.platform, identity.identityId);
  if (!sameIdentity(identity, expected) || !["linux", "darwin"].includes(identity.platform)) fail("UNSUPPORTED_BACKEND");
  const key = pbkdf2Sync(identity.platform === "darwin" ? "mock_password" : "peanuts", "saltysalt", identity.platform === "darwin" ? 1003 : 1, 16, "sha1");
  const inner = createChromiumKeyCredentialAdapter({ identity: { ...identity, backend: "chromium-provided-key" }, key }); key.fill(0);
  const adapter: CredentialCryptoAdapter = { identity: Object.freeze({ ...identity }), encryptedPrefixes: inner.encryptedPrefixes,
    decrypt(bytes, context) { assertContext(adapter, context); return inner.decrypt(bytes, { ...context, identity: inner.identity }); },
    encrypt(bytes, context) { assertContext(adapter, context); return inner.encrypt(bytes, { ...context, identity: inner.identity }); }, dispose: () => inner.dispose!() };
  return Object.freeze(adapter);
}
export const createChromiumBasicCredentialAdapter = createBasicChromiumAdapter;

export interface CredentialCapsuleBinding { snapshotId: string; profileId: string }
function capsuleAad(identity: CredentialIdentity, prefix: string, binding: CredentialCapsuleBinding): Buffer {
  checkIdentity(identity);
  if (!binding || ![binding.snapshotId, binding.profileId].every(v => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v))) fail("CAPSULE_BINDING_INVALID");
  return Buffer.from(JSON.stringify({ version: 1, identity: JSON.parse(encodedIdentity(identity)), prefix, snapshotId: binding.snapshotId, profileId: binding.profileId }));
}
function capsuleKey(password: Buffer, salt: Buffer): Buffer {
  if (!Buffer.isBuffer(password) || password.length < 12 || password.length > 4096) fail("MIGRATION_PASSWORD_INVALID");
  return scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
}
/** A separate encrypted extraEntry for the full snapshot. Only the small public
 * identity header is JSON; the raw native key is binary AEAD ciphertext. The
 * independent migration password and clear key never leave memory here. */
export function sealCredentialKeyCapsule(options: { identity: CredentialIdentity; key: Buffer; prefix?: "v10" | "v11"; binding: CredentialCapsuleBinding; migrationPassword: Buffer }): Buffer {
  const probe = createChromiumKeyCredentialAdapter(options); probe.dispose!();
  const aad = capsuleAad(options.identity, options.prefix ?? "v10", options.binding), salt = randomBytes(16), nonce = randomBytes(12);
  const key = capsuleKey(options.migrationPassword, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad);
    const header = Buffer.alloc(8); header.write("PCC1"); header.writeUInt32BE(aad.length, 4);
    return Buffer.concat([header, aad, salt, nonce, cipher.update(options.key), cipher.final(), cipher.getAuthTag()]);
  } finally { key.fill(0); }
}
export function openCredentialKeyCapsule(options: { capsule: Buffer; expectedSource: CredentialIdentity; prefix?: "v10" | "v11"; binding: CredentialCapsuleBinding; migrationPassword: Buffer }): CredentialCryptoAdapter {
  const aad = capsuleAad(options.expectedSource, options.prefix ?? "v10", options.binding), bytes = options.capsule;
  if (!Buffer.isBuffer(bytes) || bytes.length < 68 || bytes.length > 4096 || bytes.subarray(0, 4).toString() !== "PCC1" ||
      bytes.readUInt32BE(4) !== aad.length || !bytes.subarray(8, 8 + aad.length).equals(aad)) fail("CAPSULE_BINDING_MISMATCH");
  const start = 8 + aad.length, key = capsuleKey(options.migrationPassword, bytes.subarray(start, start + 16));
  let clear: Buffer | undefined, first: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(start + 16, start + 28));
    decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(-16));
    first = decipher.update(bytes.subarray(start + 28, -16)); clear = Buffer.concat([first, decipher.final()]);
    return createChromiumKeyCredentialAdapter({ identity: options.expectedSource, key: clear, prefix: options.prefix });
  } catch (error) { if (error instanceof CredentialPortabilityError) throw error; throw new CredentialPortabilityError("CAPSULE_AUTHENTICATION_FAILED"); }
  finally { key.fill(0); first?.fill(0); clear?.fill(0); }
}

const LOGIN_COLUMNS = "origin_url action_url username_element username_value password_element password_value submit_element signon_realm date_created blacklisted_by_user scheme password_type times_used form_data date_synced display_name icon_url federation_url skip_zero_click generation_upload_status possible_username_pairs id date_last_used moving_blocked_for date_password_modified sender_email sender_name date_received sharing_notification_displayed keychain_identifier sender_profile_image_url date_last_filled actor_login_approved".split(" ");
const COOKIE_COLUMNS = "creation_utc host_key top_frame_site_key name value encrypted_value path expires_utc is_secure is_httponly last_access_utc has_expires is_persistent priority samesite source_scheme source_port last_update_utc source_type has_cross_site_ancestor".split(" ");
const SCHEMAS: Record<string, Record<string, string[]>> = {
  logins: { meta: ["key", "value"], logins: LOGIN_COLUMNS, password_notes: ["id", "parent_id", "key", "value", "date_created", "confidential"],
    sync_entities_metadata: ["storage_key", "metadata"], sync_model_metadata: ["id", "model_metadata"],
    insecure_credentials: ["parent_id", "insecurity_type", "create_time", "is_muted", "trigger_notification_from_backend"],
    stats: ["origin_domain", "username_value", "dismissal_count", "update_time"], sqlite_sequence: ["name", "seq"] },
  cookies: { meta: ["key", "value"], cookies: COOKIE_COLUMNS, sqlite_sequence: ["name", "seq"] },
  nss: { nssPrivate: ["id"], metaData: ["id", "item1", "item2"] },
};
type Field = { table: string; column: string; rowId: string; storage: string; encrypted: Uint8Array | null; host?: string; plainCookie?: Uint8Array };
type SqlResult = { version: number; fields: Field[]; logicalHash: string; keyIds?: string[] };
type Change = { table: string; column: string; rowId: string; encrypted: Buffer; storage: string };
// Fixed SELECT/UPDATEs against admitted ordinary tables. Schema SQL is examined
// as DATA only, never replayed. Triggers, views, virtual/generated/check/index
// expressions, partial indexes, unknown tables/columns, and OS references fail.
const SQLITE_WORKER = String.raw`
const { parentPort, workerData:d }=require('node:worker_threads');
const { DatabaseSync }=require('node:sqlite'); const { createHash }=require('node:crypto');
let db, result, failure; const fail=code=>{const e=new Error();e.credentialCode=code;throw e;};
const q=n=>'"'+n.replace(/"/g,'""')+'"';
try {
  db=new DatabaseSync(d.file,{readOnly:d.mode!=='write',allowExtension:false,enableDoubleQuotedStringLiterals:false,timeout:100});
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA ignore_check_constraints=ON; PRAGMA foreign_keys=OFF; PRAGMA mmap_size=0; PRAGMA cache_size=-2048; PRAGMA temp_store=MEMORY;');
  if(d.mode!=='write') db.exec('PRAGMA query_only=ON;');
  const schema=db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY type,name LIMIT 129').all(), tables=new Map(); let schemaBytes=0;
  if(schema.length>128)fail('SCHEMA_LIMIT');
  for(const r of schema){
    if(!['table','index'].includes(r.type)||typeof r.name!=='string'||r.name.length>128||typeof r.tbl_name!=='string'||!Object.hasOwn(d.schema,r.tbl_name)||!Number.isSafeInteger(r.rootpage)||r.rootpage<1||r.rootpage>16384||r.sql!==null&&typeof r.sql!=='string')fail('SCHEMA_UNSUPPORTED');
    schemaBytes+=r.sql?Buffer.byteLength(r.sql):0;
    if(schemaBytes>262144||r.sql&&/\b(?:CHECK|VIRTUAL|WITHOUT\s+ROWID)\b/i.test(r.sql))fail('SCHEMA_UNSUPPORTED');
    if(r.type==='table'){
      const columns=db.prepare('SELECT name,hidden FROM pragma_table_xinfo(?) LIMIT 257').all(r.name);
      if(!columns.length||columns.length>256||columns.some(c=>c.hidden!==0||typeof c.name!=='string'||(!d.schema[r.name].includes(c.name)&&!(d.kind==='nss'&&r.name==='nssPrivate'&&/^a[0-9a-f]{1,8}$/.test(c.name)))))fail('SCHEMA_UNSUPPORTED');
      if(db.prepare('SELECT partial FROM pragma_index_list(?)').all(r.name).some(i=>i.partial!==0))fail('SCHEMA_UNSUPPORTED');
      tables.set(r.name,columns.map(c=>c.name));
    }else{
      const columns=db.prepare('SELECT cid,coll FROM pragma_index_xinfo(?) LIMIT 257').all(r.name);
      if(columns.length>256||columns.some(c=>c.cid===-2||c.coll!==null&&!['BINARY','NOCASE','RTRIM'].includes(c.coll)))fail('SCHEMA_UNSUPPORTED');
    }
  }
  const pages=db.prepare('PRAGMA page_count').get().page_count;
  if(!Number.isSafeInteger(pages)||pages<1||pages>16384)fail('SQLITE_LIMIT');
  const need=(table,cols)=>{if(!tables.has(table)||cols.some(c=>!tables.get(table).includes(c)))fail('SCHEMA_UNSUPPORTED');};
  let version=0;
  if(d.kind==='nss'){
    need('nssPrivate',['a102','a11']);need('metaData',['id','item1','item2']);
  }else{
    need('meta',['key','value']);
    const versions=db.prepare("SELECT key,CAST(value AS TEXT) AS value FROM meta WHERE key IN ('version','last_compatible_version') LIMIT 3").all();
    if(versions.length!==2||versions.some(r=>typeof r.value!=='string'||!/^[1-9][0-9]{0,3}$/.test(r.value)))fail('DATABASE_VERSION_UNSUPPORTED');
    version=Number(versions.find(r=>r.key==='version')?.value);const compatible=Number(versions.find(r=>r.key==='last_compatible_version')?.value);
    if(!Number.isInteger(version)||!Number.isInteger(compatible)||compatible>version||(d.kind==='cookies'?version<23||version>24||compatible>24:version<40||version>43||compatible>43))fail('DATABASE_VERSION_UNSUPPORTED');
    need(d.kind==='cookies'?'cookies':'logins',d.kind==='cookies'?['host_key','value','encrypted_value']:['password_value']);
    if(tables.has('password_notes'))need('password_notes',['value']);
    if(tables.has('sync_entities_metadata'))need('sync_entities_metadata',['metadata']);
    if(tables.get('logins')?.includes('keychain_identifier')&&db.prepare('SELECT 1 FROM logins WHERE length(keychain_identifier)>0 LIMIT 1').get())fail('OS_CREDENTIAL_REFERENCE_UNSUPPORTED');
  }
  if(db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check!=='ok')fail('DATABASE_CORRUPT');
  let rows=0,cells=0,bytes=0;const logical=createHash('sha256');
  for(const [table,cols]of tables){
    const excluded=d.kind==='cookies'&&table==='cookies'?['encrypted_value','value']:d.kind==='logins'&&table==='logins'?['password_value']:d.kind==='logins'&&table==='password_notes'?['value']:d.kind==='logins'&&table==='sync_entities_metadata'?['metadata']:[];
    const selected=cols.filter(c=>!excluded.includes(c)), st=db.prepare('SELECT rowid AS _credential_rowid'+selected.map(c=>','+q(c)).join('')+' FROM '+q(table)+' ORDER BY rowid');st.setReadBigInts(true);
    logical.update(JSON.stringify([table,cols])+'\n');
    for(const row of st.iterate()){
      if(++rows>50000)fail('ROW_LIMIT');const typed=[];
      for(const v of Object.values(row)){
        if(++cells>2000000)fail('SQLITE_LIMIT');
        if(v===null)typed.push(['null']);else if(typeof v==='bigint')typed.push(['int',v.toString()]);else if(typeof v==='number')typed.push(['real',String(v)]);
        else if(typeof v==='string'){bytes+=Buffer.byteLength(v);typed.push(['text',v]);}else{bytes+=v.length;typed.push(['blob',Buffer.from(v).toString('base64')]);}
        if(bytes>33554432)fail('SQLITE_LIMIT');
      }
      logical.update(JSON.stringify(typed)+'\n');
    }
  }
  const fields=[];let fieldBytes=0;
  const add=(table,column,cookie)=>{
    const sql='SELECT rowid AS rid,typeof('+q(column)+') AS storage,CAST('+q(column)+' AS BLOB) AS encrypted'+(cookie?',host_key AS host,CAST(value AS BLOB) AS plainCookie':'')+' FROM '+q(table)+' ORDER BY rowid';
    const s=db.prepare(sql);s.setReadBigInts(true);
    for(const r of s.iterate()){
      if(fields.length>=50000||!['blob','text','null'].includes(r.storage)||r.encrypted!==null&&r.encrypted.length>1048576)fail('FIELD_INVALID');
      fieldBytes+=(r.encrypted?.length||0)+(r.plainCookie?.length||0);
      if(fieldBytes>16777216||cookie&&(typeof r.host!=='string'||Buffer.byteLength(r.host)>4096||!(r.plainCookie instanceof Uint8Array)||r.plainCookie.length>1048576))fail('FIELD_INVALID');
      fields.push({table,column,rowId:r.rid.toString(),storage:r.storage,encrypted:r.encrypted,...(cookie?{host:r.host,plainCookie:r.plainCookie}:{})});
    }
  };
  let keyIds;
  if(d.kind==='cookies')add('cookies','encrypted_value',true);
  else if(d.kind==='logins'){
    add('logins','password_value',false);if(tables.has('password_notes'))add('password_notes','value',false);if(tables.has('sync_entities_metadata'))add('sync_entities_metadata','metadata',false);
  }else{
    const pass=db.prepare("SELECT length(item1) AS salt,length(item2) AS checkBytes FROM metaData WHERE id='password' LIMIT 2").all();
    if(pass.length!==1||pass[0].salt<1||pass[0].salt>1024||pass[0].checkBytes<1||pass[0].checkBytes>1048576)fail('NSS_DATABASE_INVALID');
    keyIds=[];for(const r of db.prepare('SELECT CAST(a102 AS BLOB) AS id,length(a11) AS size FROM nssPrivate WHERE a102 IS NOT NULL AND a11 IS NOT NULL LIMIT 50001').iterate()){
      if(keyIds.length>=50000||!(r.id instanceof Uint8Array)||!r.id.length||r.id.length>128||r.size<1||r.size>1048576)fail('NSS_DATABASE_INVALID');keyIds.push(Buffer.from(r.id).toString('hex'));
    }
  }
  if(d.mode==='write'){
    if(d.kind==='nss'||!Array.isArray(d.changes)||d.changes.length>50000)fail('WRITE_PLAN_INVALID');
    const available=new Map(fields.map(f=>[[f.table,f.column,f.rowId].join(':'),f]));const seen=new Set();
    db.exec('BEGIN IMMEDIATE;');
    for(const c of d.changes){
      const id=[c.table,c.column,c.rowId].join(':'),before=available.get(id);
      if(!before||seen.has(id)||!['text','blob'].includes(c.storage)||!(c.encrypted instanceof Uint8Array)||!c.encrypted.length||c.encrypted.length>1048576)fail('WRITE_PLAN_INVALID');seen.add(id);
      const text=c.storage==='text';const statement=db.prepare('UPDATE '+q(c.table)+' SET '+q(c.column)+'='+(text?'CAST(? AS TEXT)':'?')+(d.kind==='cookies'?',value=\'\'':'')+' WHERE rowid=?');
      const changed=statement.run(c.encrypted,BigInt(c.rowId));if(Number(changed.changes)!==1)fail('WRITE_VERIFICATION_FAILED');
    }
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
    if(db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode!=='delete')fail('CHECKPOINT_FAILED');
  }
  result={version,fields,logicalHash:logical.digest('hex'),...(keyIds?{keyIds}:{})};
}catch(error){failure=error.credentialCode||'SQLITE_VALIDATION_FAILED';}
finally{if(db){try{db.close();}catch{failure='SQLITE_CLOSE_FAILED';}}}
parentPort.postMessage(failure?{ok:false,code:failure}:{ok:true,value:result});parentPort.close();
`;
function runSqlite(file: string, kind: string, options: ProfileCredentialOptions, changes?: Change[]): Promise<SqlResult> {
  checkAbort(options);
  return new Promise((resolve, reject) => {
    const worker = new Worker(SQLITE_WORKER, { eval: true, workerData: { file, kind, schema: SCHEMAS[kind], mode: changes ? "write" : "read", changes },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
    let result: SqlResult | undefined, failure: CredentialPortabilityError | undefined, terminating = false;
    const stop = (code: string) => {
      failure ??= new CredentialPortabilityError(code);
      if (!terminating) { terminating = true; void worker.terminate().catch(() => { failure = new CredentialPortabilityError("SQLITE_TERMINATION_FAILED"); }); }
    };
    const timer = setTimeout(() => stop("SQLITE_TIMEOUT"), WORKER_TIMEOUT), onAbort = () => stop("CANCELLED");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", message => {
      if (message?.ok === true) result = message.value;
      else failure ??= new CredentialPortabilityError(typeof message?.code === "string" && /^[A-Z_]{1,64}$/.test(message.code) ? message.code : "SQLITE_VALIDATION_FAILED");
    });
    worker.on("error", () => { failure ??= new CredentialPortabilityError("SQLITE_WORKER_FAILED"); });
    worker.once("exit", code => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure); else if (code || !result) reject(new CredentialPortabilityError("SQLITE_WORKER_FAILED")); else resolve(result);
    });
    if (options.signal?.aborted) onAbort();
  });
}
function checkAbort(options: ProfileCredentialOptions): void { if (options.signal?.aborted) fail("CANCELLED"); options.guard?.(); }
function relativeDirectory(value: string): string {
  if (value === ".") return value;
  if (typeof value !== "string" || !value || value.length > 256 || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value) || value.split("/").some(p => !p || p === "." || p === ".." || !/^[a-zA-Z0-9_. -]+$/.test(p))) fail("STAGING_PATH_INVALID");
  return value;
}
function sameStat(a: fs.Stats, b: fs.Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function assertDirectories(directory: string, allowMissing = false): void {
  const absolute = path.resolve(directory), root = path.parse(absolute).root, parts = absolute.slice(root.length).split(path.sep).filter(Boolean); let current = root;
  for (const part of parts) {
    current = path.join(current, part); const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat && allowMissing) return; // Confirmed absence below checked real parents.
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail("STAGING_DIRECTORY_UNSAFE");
  }
}
function assertStaging(options: ProfileCredentialOptions): string {
  checkAbort(options); checkIdentity(options.source); relativeDirectory(options.profileRelativePath);
  if (!path.isAbsolute(options.stagingRoot) || path.resolve(options.stagingRoot) !== options.stagingRoot) fail("STAGING_PATH_INVALID");
  assertDirectories(options.stagingRoot); const stat = fs.lstatSync(options.stagingRoot);
  if (!options.stagingOwner || stat.dev !== options.stagingOwner.dev || stat.ino !== options.stagingOwner.ino || (stat.mode & 0o077) !== 0 ||
      typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("STAGING_OWNER_MISMATCH");
  const profile = path.join(options.stagingRoot, options.profileRelativePath); assertDirectories(profile, true); return profile;
}
type Input = { relativePath: string; stat: fs.Stats; digest: string; bytes: Buffer };
type Group = { relativePath: string; kind: "logins" | "cookies" | "nss"; members: Input[] };
function captureFile(root: string, relativePath: string, max: number): Input | undefined {
  const file = path.join(root, relativePath); assertDirectories(path.dirname(file), true);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max || stat.size < 0) fail("STAGING_FILE_UNSAFE");
  let bytes: Buffer;
  if (!stat.size) bytes = Buffer.alloc(0);
  else bytes = readPinnedSqliteFile(file, stat, undefined, max);
  if (!sameStat(stat, fs.lstatSync(file))) fail("STAGING_CHANGED");
  return { relativePath, stat, digest: sha(bytes), bytes };
}
function sourceInventory(inputs: Input[]): CredentialFile[] { return inputs.map(i => ({ relativePath: i.relativePath, sha256: i.digest, bytes: i.bytes.length })).sort((a, b) => a.relativePath < b.relativePath ? -1 : 1); }
function recheckInputs(options: ProfileCredentialOptions, inputs: Input[]): void {
  // Re-enumerate ABSENCES as well: a late main/WAL/Network directory must not
  // turn an inspected empty/old snapshot into a different credential set.
  const actual = collect(options).inputs;
  if (JSON.stringify(sourceInventory(inputs)) !== JSON.stringify(sourceInventory(actual))) fail("STAGING_CHANGED");
  for (const input of inputs) {
    const now = actual.find(i => i.relativePath === input.relativePath);
    if (!now || !sameStat(input.stat, now.stat)) fail("STAGING_CHANGED");
  }
}
function collect(options: ProfileCredentialOptions): { groups: Group[]; inputs: Input[]; logins?: Input } {
  assertStaging(options); const groups: Group[] = [], inputs: Input[] = [];
  const relative = (name: string) => options.profileRelativePath === "." ? name : path.posix.join(options.profileRelativePath, name);
  const descriptions = options.source.engine === "firefox" ? [["key4.db", "nss"]] : [["Login Data", "logins"], ["Login Data For Account", "logins"], ["Cookies", "cookies"], ["Network/Cookies", "cookies"]];
  for (const [name, kind] of descriptions) {
    const base = relative(name), parent = path.dirname(path.join(options.stagingRoot, base));
    // A genuinely absent optional Network directory is not an I/O failure.
    const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
    if (!parentStat) { assertDirectories(path.dirname(parent), true); continue; }
    assertDirectories(parent);
    const members = ["", "-wal", "-shm", "-journal"].flatMap(suffix => { const file = captureFile(options.stagingRoot, base + suffix, MAX_GROUP); return file ? [file] : []; });
    if (!members.some(i => i.relativePath === base)) { if (members.length) fail("ORPHAN_DATABASE_SIDECAR"); continue; }
    if (members.some(i => i.relativePath.endsWith("-journal") && i.bytes.length)) fail("ROLLBACK_JOURNAL_UNSUPPORTED");
    if (members.reduce((n, i) => n + i.bytes.length, 0) > MAX_GROUP) fail("DATABASE_SIZE_LIMIT");
    const main = members.find(i => i.relativePath === base)!, wal = members.find(i => i.relativePath === base + "-wal");
    try { validateSqliteLocalStorageGroup(main.bytes, wal?.bytes, options.signal); } catch { fail("DATABASE_OR_WAL_INVALID"); }
    groups.push({ relativePath: base, kind: kind as Group["kind"], members }); inputs.push(...members);
  }
  const logins = options.source.engine === "firefox" ? captureFile(options.stagingRoot, relative("logins.json"), MAX_JSON) : undefined;
  if (logins) inputs.push(logins);
  if (inputs.reduce((n, i) => n + i.bytes.length, 0) > MAX_TOTAL) fail("PROFILE_CREDENTIAL_SIZE_LIMIT");
  return { groups, inputs, logins };
}
function ownedWrite(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); assertDirectories(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const actual = captureFile(path.dirname(file), path.basename(file), MAX_GROUP);
  if (!actual || !actual.bytes.equals(bytes)) fail("STAGING_WRITE_READBACK_FAILED");
}
function copyGroup(group: Group, directory: string): string {
  const main = path.join(directory, group.relativePath);
  for (const member of group.members) if (member.relativePath === group.relativePath || member.relativePath === group.relativePath + "-wal") ownedWrite(path.join(directory, member.relativePath), member.bytes);
  return main;
}
function removeOwned(directory: string, owner: { dev: number; ino: number }): void {
  const actual = fs.lstatSync(directory);
  if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== owner.dev || actual.ino !== owner.ino) fail("OUTPUT_OWNER_CHANGED");
  fs.rmSync(directory, { recursive: true });
}
const convertedOutputs = new WeakMap<ConvertedProfileCredentials, { directory: string; owner: { dev: number; ino: number }; root: string; rootOwner: { dev: number; ino: number } }>();
/** Call after copying successful replacements, BEFORE full-profile publication.
 * The opaque object handle, not caller-editable path fields, owns cleanup. */
export function disposeConvertedProfileCredentials(result: ConvertedProfileCredentials): void {
  const saved = convertedOutputs.get(result); if (!saved) fail("OUTPUT_HANDLE_INVALID");
  assertDirectories(saved.root); const root = fs.lstatSync(saved.root);
  if (root.dev !== saved.rootOwner.dev || root.ino !== saved.rootOwner.ino) fail("STAGING_OWNER_MISMATCH");
  removeOwned(saved.directory, saved.owner); convertedOutputs.delete(result);
}
function adapterFor(identity: CredentialIdentity, adapter?: CredentialCryptoAdapter): CredentialCryptoAdapter | undefined {
  if (identity.backend === "chromium-app-bound") fail("APP_BOUND_UNSUPPORTED");
  if (!adapter) return undefined;
  if (!sameIdentity(identity, adapter.identity) || !Array.isArray(adapter.encryptedPrefixes) || !adapter.encryptedPrefixes.length ||
      adapter.encryptedPrefixes.some(p => !["v10", "v11"].includes(p))) fail("ADAPTER_IDENTITY_MISMATCH");
  return adapter;
}
function contextFor(group: Group, field: Field, result: SqlResult, identity: CredentialIdentity): CredentialCryptoContext {
  return { identity, relativePath: group.relativePath, table: field.table, column: field.column, rowId: field.rowId, databaseVersion: result.version, ...(field.host !== undefined ? { cookieHost: field.host } : {}) };
}
function checkEncrypted(bytes: Buffer, adapter?: CredentialCryptoAdapter): void {
  if (prefixOf(bytes) === "v20") fail("APP_BOUND_UNSUPPORTED");
  if (bytes.length >= 20 && bytes.subarray(0, 20).toString("hex") === "01000000d08c9ddf0115d1118c7a00c04fc297eb") fail("WINDOWS_DPAPI_UNSUPPORTED");
  if (!["v10", "v11"].includes(prefixOf(bytes)) || adapter && !adapter.encryptedPrefixes.includes(prefixOf(bytes) as "v10" | "v11")) fail("CRYPTO_FORMAT_UNSUPPORTED");
}
async function decrypt(adapter: CredentialCryptoAdapter, bytes: Buffer, context: CredentialCryptoContext): Promise<Buffer> {
  checkEncrypted(bytes, adapter); let result: Buffer;
  try { result = await adapter.decrypt(bytes, context); } catch (error) { if (error instanceof CredentialPortabilityError) throw error; fail("DECRYPT_FAILED"); }
  if (!Buffer.isBuffer(result) || result.length > MAX_VALUE || overlaps(result, bytes)) fail("ADAPTER_RESULT_INVALID");
  return result;
}
function validateClear(clear: Buffer, field: Field, version: number): void {
  if (field.host !== undefined && version >= 24) {
    const digest = createHash("sha256").update(field.host, "utf8").digest();
    if (clear.length < 32 || !timingSafeEqual(clear.subarray(0, 32), digest)) fail("COOKIE_HOST_BINDING_MISMATCH");
  }
  if (["logins", "password_notes"].includes(field.table)) {
    // Chromium152 Encryptor::EncryptString16 first calls UTF16ToUTF8. The
    // OSCrypt payload is UTF-8, NOT UTF-16LE. Reject invalid UTF-8 rather than
    // treating successful CBC padding as sufficient password evidence.
    try { new TextDecoder("utf-8", { fatal: true }).decode(clear); } catch { fail("PASSWORD_ENCODING_INVALID"); }
  }
}
async function clearField(field: Field, result: SqlResult, group: Group, identity: CredentialIdentity, adapter: CredentialCryptoAdapter): Promise<Buffer | undefined> {
  const encrypted = field.encrypted === null ? Buffer.alloc(0) : Buffer.from(field.encrypted);
  if (field.host !== undefined) {
    const plain = Buffer.from(field.plainCookie!);
    if (encrypted.length && plain.length) fail("COOKIE_VALUES_CONFLICT");
    if (!encrypted.length) return result.version >= 24 ? Buffer.concat([createHash("sha256").update(field.host).digest(), plain]) : Buffer.from(plain);
  } else if (!encrypted.length) return undefined; // Retain genuinely empty/null database fields unchanged.
  const clear = await decrypt(adapter, encrypted, contextFor(group, field, result, identity));
  try { validateClear(clear, field, result.version); return clear; } catch (error) { clear.fill(0); throw error; }
}
function newReport(options: ProfileCredentialOptions, inputs: Input[]): ProfileCredentialReport {
  return { version: 1, scope: options.source.engine === "firefox" ? "firefox-nss-login-pair" : "chromium-login-cookie-databases", source: { ...options.source },
    status: "absent", verification: "no-credential-files", passwordUsability: "no-stored-secrets", hardwarePasskeys: "not-portable", databases: [], sourceFiles: sourceInventory(inputs),
    warnings: ["Hardware-backed passkeys and external OS credentials are not portable."] };
}
function summarize(group: Group, result: SqlResult): ProfileCredentialReport["databases"][number] {
  return { relativePath: group.relativePath, version: result.version, fields: result.fields.length,
    encryptedFields: result.fields.filter(f => f.encrypted?.length).length, emptyFields: result.fields.filter(f => !f.encrypted?.length && !f.plainCookie?.length).length,
    plaintextCookies: result.fields.filter(f => f.host !== undefined && !f.encrypted?.length && f.plainCookie?.length).length };
}
// Strict, bounded DER reader for the public SDR envelope (key-id, algorithm,
// ciphertext). It does not decrypt an NSS private key or test Primary Password.
function sdrKeyId(encoded: unknown): string {
  if (typeof encoded !== "string" || !encoded.length || encoded.length > MAX_VALUE * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail("FIREFOX_LOGIN_INVALID");
  const data = Buffer.from(encoded, "base64"); if (data.toString("base64") !== encoded || data.length > MAX_VALUE) fail("FIREFOX_LOGIN_INVALID");
  const tlv = (start: number, end: number): { tag: number; body: number; end: number } => {
    if (start + 2 > end) fail("FIREFOX_LOGIN_INVALID"); const tag = data[start++]; let len = data[start++];
    if (len & 128) { const count = len & 127; if (!count || count > 3 || start + count > end || !data[start]) fail("FIREFOX_LOGIN_INVALID"); len = 0; for (let n = 0; n < count; n++) len = len * 256 + data[start++]; if (len < 128) fail("FIREFOX_LOGIN_INVALID"); }
    if (start + len > end) fail("FIREFOX_LOGIN_INVALID"); return { tag, body: start, end: start + len };
  };
  const outer = tlv(0, data.length); if (outer.tag !== 0x30 || outer.end !== data.length) fail("FIREFOX_LOGIN_INVALID");
  const id = tlv(outer.body, outer.end), alg = tlv(id.end, outer.end), cipher = tlv(alg.end, outer.end);
  if (id.tag !== 4 || id.end - id.body < 1 || id.end - id.body > 128 || alg.tag !== 0x30 || cipher.tag !== 4 || cipher.end !== outer.end || cipher.end === cipher.body) fail("FIREFOX_LOGIN_INVALID");
  const oid = tlv(alg.body, alg.end), iv = tlv(oid.end, alg.end), oidHex = data.subarray(oid.body, oid.end).toString("hex");
  const block = oidHex === "2a864886f70d0307" ? 8 : ["608648016503040102", "60864801650304012a"].includes(oidHex) ? 16 : 0;
  if (oid.tag !== 6 || !block || iv.tag !== 4 || iv.end !== alg.end || iv.end - iv.body !== block || (cipher.end - cipher.body) % block) fail("FIREFOX_LOGIN_ALGORITHM_UNSUPPORTED");
  return data.subarray(id.body, id.end).toString("hex");
}
async function inspectFirefox(options: ProfileCredentialOptions, captured: ReturnType<typeof collect>, scratch: string, report: ProfileCredentialReport): Promise<void> {
  if (!captured.groups.length && !captured.logins) return;
  if (captured.groups.length !== 1 || !captured.logins) fail("FIREFOX_PAIR_INCOMPLETE");
  let document: { version?: unknown; logins?: unknown };
  try { document = JSON.parse(captured.logins.bytes.toString("utf8")); } catch { fail("FIREFOX_LOGIN_INVALID"); }
  if (!document || ![1, 2, 3].includes(document.version as number) || !Array.isArray(document.logins) || document.logins.length > MAX_ROWS) fail("FIREFOX_LOGIN_INVALID");
  const group = captured.groups[0], result = await runSqlite(copyGroup(group, scratch), "nss", options), ids = new Set(result.keyIds);
  for (const login of document.logins) {
    if (!login || typeof login !== "object" || login.encType !== 1 || !ids.has(sdrKeyId(login.encryptedUsername)) || !ids.has(sdrKeyId(login.encryptedPassword))) fail("FIREFOX_NSS_KEY_MISMATCH");
  }
  const pair: FirefoxCredentialPairBinding = { version: 1, source: { ...options.source }, profileRelativePath: options.profileRelativePath, members: sourceInventory(captured.inputs) };
  if (options.expectedFirefoxPair) {
    const expected = options.expectedFirefoxPair;
    if (expected.version !== 1 || !expected.source || !sameIdentity(expected.source, pair.source) || expected.profileRelativePath !== pair.profileRelativePath || !Array.isArray(expected.members) || expected.members.length !== pair.members.length ||
        expected.members.some(m => !m || typeof m.relativePath !== "string" || !Number.isSafeInteger(m.bytes) || m.bytes < 0 || typeof m.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(m.sha256))) fail("FIREFOX_PAIR_BINDING_MISMATCH");
    const members = expected.members.map(m => ({ relativePath: m.relativePath, sha256: m.sha256, bytes: m.bytes })).sort((a, b) => a.relativePath < b.relativePath ? -1 : 1);
    if (JSON.stringify(members) !== JSON.stringify(pair.members)) fail("FIREFOX_PAIR_BINDING_MISMATCH");
  }
  report.firefoxPair = pair; report.status = "paired-files-preserved"; report.verification = "paired-files-only"; report.passwordUsability = "requires-firefox-nss-unlock";
  report.databases.push({ relativePath: group.relativePath, version: result.version, fields: document.logins.length * 2, encryptedFields: document.logins.length * 2, emptyFields: 0, plaintextCookies: 0 });
  report.warnings.push("SDR key IDs and authenticated snapshot file digests bind the preserved pair; key IDs alone do not prove key equality. NSS/Primary Password unlocking has not been attempted or verified.");
}

/** Source-only readback. With no adapter, encrypted Chromium files are reported
 * source-codec-required, never portable/empty. Corrupt/unsupported data throws. */
export async function inspectProfileCredentials(options: ProfileCredentialOptions): Promise<ProfileCredentialReport> {
  const captured = collect(options), report = newReport(options, captured.inputs), scratch = fs.mkdtempSync(path.join(options.stagingRoot, ".credentials-inspect-")), owner = fs.lstatSync(scratch);
  try {
    if (options.source.engine === "firefox") await inspectFirefox(options, captured, scratch, report);
    else {
      const adapter = adapterFor(options.source, options.sourceAdapter); let needsCodec = false;
      for (const group of captured.groups) {
        const result = await runSqlite(copyGroup(group, scratch), group.kind, options); report.databases.push(summarize(group, result));
        for (const field of result.fields) {
          checkAbort(options); if (field.encrypted?.length) checkEncrypted(Buffer.from(field.encrypted), adapter);
          if (field.host !== undefined && field.encrypted?.length && field.plainCookie?.length) fail("COOKIE_VALUES_CONFLICT");
          if (!adapter) { if (field.encrypted?.length || field.host !== undefined) needsCodec = true; continue; }
          const clear = await clearField(field, result, group, options.source, adapter); clear?.fill(0);
        }
      }
      if (captured.groups.length) {
        report.status = needsCodec ? "source-codec-required" : "source-verified"; report.verification = needsCodec ? "not-verified" : "source-decrypt";
        report.passwordUsability = needsCodec ? "not-verified" : report.databases.some(d => d.encryptedFields || d.plaintextCookies) ? "verified-with-codec" : "no-stored-secrets";
        if (options.source.algorithm === "aes-128-cbc") report.warnings.push("Native CBC is unauthenticated: successful decryption is not independent source-authenticity proof. Preserve the authenticated snapshot and explicit backend provenance.");
      }
    }
    recheckInputs(options, captured.inputs); return report;
  } finally { removeOwned(scratch, owner); }
}

/** Immutable source -> new owned credential files. All native writes contain
 * only RECEIVER ciphertext. Reopen SQL and decrypt every converted cell with
 * the receiver adapter, comparing an ephemeral keyed plaintext MAC. No clear
 * password/cookie/key is written to CSV, JSON, SQLite, temporary files or logs. */
export async function convertProfileCredentials(options: ConvertProfileCredentialOptions): Promise<ConvertedProfileCredentials> {
  checkIdentity(options.receiver); if (options.receiver.engine !== options.source.engine) fail("ENGINE_CONVERSION_UNSUPPORTED");
  const captured = collect(options), report = newReport(options, captured.inputs), output = fs.mkdtempSync(path.join(options.stagingRoot, ".credentials-converted-")), owner = fs.lstatSync(output);
  const replacements: ConvertedProfileCredentials["replacements"] = [], removeRelativePaths: string[] = [], macKey = randomBytes(32); let complete = false;
  try {
    report.receiver = { ...options.receiver };
    if (options.source.engine === "firefox") {
      if (captured.inputs.length && !options.expectedFirefoxPair) fail("FIREFOX_SOURCE_PAIR_BINDING_REQUIRED");
      await inspectFirefox(options, captured, output, report);
      // No NSS unlock/re-encryption is claimed. Preserve original main + WAL
      // (not SQLite's derived SHM) and the exact paired logins file.
      for (const input of captured.inputs) {
        if (input.relativePath.endsWith("-shm") || input.relativePath.endsWith("-journal")) continue;
        const target = path.join(output, input.relativePath);
        if (fs.lstatSync(target, { throwIfNoEntry: false })) {
          // Read-only SQLite can create an owned SHM, but must not change main/WAL.
          const actual = captureFile(output, input.relativePath, MAX_GROUP); if (!actual || actual.digest !== input.digest) fail("FIREFOX_PAIR_CHANGED");
        } else ownedWrite(target, input.bytes);
        replacements.push({ relativePath: input.relativePath, outputPath: target, sha256: input.digest, bytes: input.bytes.length });
      }
    } else {
      const source = adapterFor(options.source, options.sourceAdapter), receiver = adapterFor(options.receiver, options.receiverAdapter);
      // Unsupported OS protection fails even for a presently empty database;
      // absence cannot manufacture a working target encryption backend.
      if (!source || !receiver) fail("CRYPTO_ADAPTER_REQUIRED");
      for (const group of captured.groups) {
        checkAbort(options); const file = copyGroup(group, output), before = await runSqlite(file, group.kind, options), changes: Change[] = [], expected = new Map<string, Buffer>();
        report.databases.push(summarize(group, before));
        for (const field of before.fields) {
          checkAbort(options); const clear = await clearField(field, before, group, options.source, source); if (clear === undefined) continue;
          let encrypted: Buffer | undefined;
          try {
            try { encrypted = await receiver.encrypt(clear, contextFor(group, field, before, options.receiver)); } catch (error) { if (error instanceof CredentialPortabilityError) throw error; fail("ENCRYPT_FAILED"); }
            if (!Buffer.isBuffer(encrypted) || overlaps(encrypted, clear) || !encrypted.length || encrypted.length > MAX_VALUE) fail("ADAPTER_RESULT_INVALID");
            checkEncrypted(encrypted, receiver);
            const id = [field.table, field.column, field.rowId].join(":"); expected.set(id, createHmac("sha256", macKey).update(clear).digest());
            changes.push({ table: field.table, column: field.column, rowId: field.rowId, encrypted: Buffer.from(encrypted), storage: field.storage === "text" ? "text" : "blob" });
          } finally { clear.fill(0); }
        }
        await runSqlite(file, group.kind, options, changes);
        const after = await runSqlite(file, group.kind, options);
        if (after.version !== before.version || after.logicalHash !== before.logicalHash || after.fields.length !== before.fields.length) fail("DATABASE_READBACK_MISMATCH");
        for (const [index, field] of after.fields.entries()) {
          const original = before.fields[index], id = [field.table, field.column, field.rowId].join(":"), expectedMac = expected.get(id);
          if (field.table !== original.table || field.column !== original.column || field.rowId !== original.rowId || field.host !== original.host) fail("DATABASE_READBACK_MISMATCH");
          if (!expectedMac) {
            if (field.storage !== original.storage || !Buffer.from(field.encrypted ?? []).equals(Buffer.from(original.encrypted ?? []))) fail("DATABASE_READBACK_MISMATCH");
            continue;
          }
          checkAbort(options); const clear = await clearField(field, after, group, options.receiver, receiver);
          if (clear === undefined) fail("DATABASE_READBACK_MISMATCH");
          try { if (!timingSafeEqual(createHmac("sha256", macKey).update(clear).digest(), expectedMac) || field.host !== undefined && field.plainCookie?.length) fail("RECEIVER_DECRYPT_MISMATCH"); }
          finally { clear.fill(0); }
        }
        const member = captureFile(output, group.relativePath, MAX_GROUP); if (!member) fail("DATABASE_READBACK_MISMATCH");
        replacements.push({ relativePath: group.relativePath, outputPath: file, sha256: member.digest, bytes: member.bytes.length });
        for (const input of group.members) if (input.relativePath !== group.relativePath) removeRelativePaths.push(input.relativePath);
      }
      report.status = captured.groups.length ? "receiver-verified" : "absent"; report.verification = captured.groups.length ? "receiver-sql-decrypt" : "no-credential-files";
      report.passwordUsability = report.databases.some(d => d.encryptedFields || d.plaintextCookies) ? "verified-with-codec" : "no-stored-secrets";
      if (options.source.algorithm === "aes-128-cbc" || options.receiver.algorithm === "aes-128-cbc") report.warnings.push("Native CBC is unauthenticated; snapshot authentication and explicit source/receiver backend provenance remain mandatory.");
    }
    recheckInputs(options, captured.inputs); checkAbort(options);
    const value: ConvertedProfileCredentials = { report, outputDirectory: output, outputOwner: { dev: owner.dev, ino: owner.ino }, replacements, removeRelativePaths, preservedSource: true };
    convertedOutputs.set(value, { directory: output, owner: value.outputOwner, root: options.stagingRoot, rootOwner: { ...options.stagingOwner } }); complete = true;
    return value;
  } finally { macKey.fill(0); if (!complete) removeOwned(output, owner); }
}
