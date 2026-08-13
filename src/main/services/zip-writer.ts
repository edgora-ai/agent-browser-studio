// Minimal dependency-free ZIP archive writer/reader used for profile backup &
// transfer. Writer emits store-method (0) entries with UTF-8 names; the reader
// accepts store (0) and deflate (8) entries. File payloads are buffered one at
// a time so a large profile tree never needs to be held fully in memory.

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { time, date };
}

export interface ZipFileEntry {
  name: string;
  filePath?: string;
  data?: Buffer;
}

export interface ZipDirEntry {
  name: string;
  isDirectory: true;
}

export async function writeZipArchive(
  destPath: string,
  entries: Array<ZipFileEntry | ZipDirEntry>,
): Promise<{ entries: number; bytes: number }> {
  const out = fs.createWriteStream(destPath, { flags: "w", mode: 0o600 });
  const write = (buf: Buffer): Promise<void> =>
    new Promise((resolve, reject) => out.write(buf, (err: Error | null | undefined) => (err ? reject(err) : resolve())));

  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;

  for (const entry of entries) {
    const isDir = (entry as ZipDirEntry).isDirectory === true;
    const name = entry.name.replace(/\\/g, "/").replace(/^\//, "");
    const nameBuf = Buffer.from(name, "utf8");
    let data: Buffer;
    let mtime = Date.now();
    if (isDir) {
      data = Buffer.alloc(0);
    } else if ((entry as ZipFileEntry).filePath) {
      const filePath = (entry as ZipFileEntry).filePath as string;
      mtime = fs.statSync(filePath).mtimeMs;
      data = fs.readFileSync(filePath);
    } else {
      data = (entry as ZipFileEntry).data ?? Buffer.alloc(0);
    }
    const dt = dosDateTime(mtime);
    const crc = isDir ? 0 : crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    await write(local);
    await write(nameBuf);
    await write(data);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(dt.time, 12);
    c.writeUInt16LE(dt.date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(size, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36);
    c.writeUInt32LE((isDir ? 0x41ed0010 : 0o100644 << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([c, nameBuf]));

    offset += 30 + nameBuf.length + size;
    count++;
  }

  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const cdOffset = offset;
  for (const b of central) await write(b);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  await write(eocd);

  await new Promise<void>((resolve, reject) => out.end((err: Error | null | undefined) => (err ? reject(err) : resolve())));
  return { entries: count, bytes: cdOffset + cdSize + 22 };
}

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const minOffset = Math.max(0, zip.length - 65557);
  for (let i = zip.length - 22; i >= minOffset; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

export function readZipEntries(zip: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(zip);
  if (eocdOffset < 0) throw new Error("ZIP end-of-central-directory not found");
  const count = zip.readUInt16LE(eocdOffset + 10);
  const cdSize = zip.readUInt32LE(eocdOffset + 12);
  const cdOffset = zip.readUInt32LE(eocdOffset + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported");
  }
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory entry");
    }
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      method: zip.readUInt16LE(p + 10),
      crc: zip.readUInt32LE(p + 16),
      compressedSize: zip.readUInt32LE(p + 20),
      uncompressedSize: zip.readUInt32LE(p + 24),
      localHeaderOffset: zip.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function extractZipEntry(zip: Buffer, entry: ZipEntry): Buffer {
  const lho = entry.localHeaderOffset;
  if (lho + 30 > zip.length || zip.readUInt32LE(lho) !== 0x04034b50) {
    throw new Error("Invalid ZIP local header");
  }
  const method = zip.readUInt16LE(lho + 8);
  const nameLen = zip.readUInt16LE(lho + 26);
  const extraLen = zip.readUInt16LE(lho + 28);
  const start = lho + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > zip.length) throw new Error("ZIP entry exceeds archive bounds");
  const raw = zip.subarray(start, end);
  let content: Buffer;
  if (method === 0) content = raw;
  else if (method === 8) content = zlib.inflateRawSync(raw, { maxOutputLength: entry.uncompressedSize });
  else throw new Error("Unsupported ZIP compression method: " + method);
  if (content.length !== entry.uncompressedSize) throw new Error("ZIP entry size mismatch");
  if (crc32(content) !== entry.crc) throw new Error("ZIP entry CRC mismatch");
  return content;
}

export function validateZipEntryName(name: string): void {
  const hasNul = name.indexOf(String.fromCharCode(0)) >= 0;
  if (!name || name.includes("\\") || hasNul || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
    throw new Error("Unsafe ZIP entry name: " + JSON.stringify(name));
  }
  for (const seg of name.split("/")) {
    if (seg === "..") throw new Error("Unsafe ZIP entry name: " + JSON.stringify(name));
  }
}

export function isPathInside(childPath: string, basePath: string): boolean {
  const rel = path.relative(basePath, childPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface ExtractOptions {
  skipNames?: (name: string) => boolean;
  maxTotalBytes?: number;
}

export function extractZipArchive(
  zipPath: string,
  destDir: string,
  opts?: ExtractOptions,
): { files: number; bytes: number } {
  const zip = fs.readFileSync(zipPath);
  const entries = readZipEntries(zip);
  const destRoot = path.resolve(destDir);
  fs.mkdirSync(destRoot, { recursive: true, mode: 0o700 });
  let total = 0;
  let files = 0;
  for (const entry of entries) {
    validateZipEntryName(entry.name);
    if (opts?.skipNames?.(entry.name)) continue;
    const target = path.resolve(destRoot, entry.name);
    if (!isPathInside(target, destRoot)) throw new Error("Unsafe ZIP path: " + entry.name);
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      continue;
    }
    total += entry.uncompressedSize;
    if (opts?.maxTotalBytes && total > opts.maxTotalBytes) {
      throw new Error("Archive exceeds size limit (" + opts.maxTotalBytes + " bytes)");
    }
    const content = extractZipEntry(zip, entry);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, content, { mode: 0o600, flag: "wx" });
    files++;
  }
  return { files, bytes: total };
}
