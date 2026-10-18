import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import {
  crc32, writeZipArchive, readZipEntries, extractZipEntry, extractZipArchive, validateZipEntryName,
} from "../../src/main/services/zip-writer.js";

const tempDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "abs-zip-test-"));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// Independent standard deflate fixture, including the optional data descriptor.
// Do not use the store-only writer to prove reader format compatibility.
function deflatedZip(name: string, content: Buffer, descriptor: boolean): Buffer {
  const nameBytes = Buffer.from(name, "utf8"), compressed = deflateRawSync(content), crc = crc32(content);
  const flags = 0x0800 | (descriptor ? 8 : 0);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(nameBytes.length, 26);
  if (!descriptor) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22); }
  const trailer = Buffer.alloc(descriptor ? 16 : 0);
  if (descriptor) {
    trailer.writeUInt32LE(0x08074b50, 0); trailer.writeUInt32LE(crc, 4);
    trailer.writeUInt32LE(compressed.length, 8); trailer.writeUInt32LE(content.length, 12);
  }
  const body = Buffer.concat([local, nameBytes, compressed, trailer]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(nameBytes.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, central, nameBytes, end]);
}

describe("zip-writer", () => {
  it("computes the standard CRC32 check value", () => {
    expect(crc32(Buffer.from("123456789", "ascii"))).toBe(0xcbf43926);
  });

  it("round-trips store entries with UTF-8 names and directories", async () => {
    const dir = tmpDir();
    const zipPath = path.join(dir, "out.zip");
    const srcDir = path.join(dir, "src");
    fs.mkdirSync(path.join(srcDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(srcDir, "a.txt"), "hello");
    fs.writeFileSync(path.join(srcDir, "nested", "数据.bin"), Buffer.from([1, 2, 3, 4]));

    const res = await writeZipArchive(zipPath, [
      { name: "a.txt", filePath: path.join(srcDir, "a.txt") },
      { name: "nested/", isDirectory: true },
      { name: "nested/数据.bin", filePath: path.join(srcDir, "nested", "数据.bin") },
      { name: "inline.txt", data: Buffer.from("inline payload") },
    ]);
    expect(res.entries).toBe(4);
    expect(res.bytes).toBe(fs.statSync(zipPath).size);

    const zip = fs.readFileSync(zipPath);
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "nested/", "nested/数据.bin", "inline.txt"]);
    expect(entries[1].isDirectory).toBe(true);

    const outDir = path.join(dir, "out");
    const extracted = extractZipArchive(zipPath, outDir);
    expect(extracted.files).toBe(3);
    expect(fs.readFileSync(path.join(outDir, "a.txt"), "utf8")).toBe("hello");
    expect(fs.readFileSync(path.join(outDir, "nested", "数据.bin"))).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(fs.readFileSync(path.join(outDir, "inline.txt"), "utf8")).toBe("inline payload");

    // Per-entry extraction works too.
    const inline = entries.find((e) => e.name === "inline.txt");
    expect(inline).toBeTruthy();
    expect(extractZipEntry(zip, inline!).toString("utf8")).toBe("inline payload");
  });

  it("rejects unsafe entry names", () => {
    expect(() => validateZipEntryName("a/b.txt")).not.toThrow();
    expect(() => validateZipEntryName("../escape.txt")).toThrow();
    expect(() => validateZipEntryName("a/../escape.txt")).toThrow();
    expect(() => validateZipEntryName("/absolute.txt")).toThrow();
    expect(() => validateZipEntryName("C:\\win.txt")).toThrow();
  });

  it("rejects an oversized central-directory entry count (R7 #35)", async () => {
    const { readZipEntries, MAX_ZIP_ENTRIES } = await import("../../src/main/services/zip-writer.js");
    // Header count above the cap throws before allocating entries.
    const fake = Buffer.alloc(100);
    fake.writeUInt32LE(0x06054b50, 78); // EOCD at offset 78
    fake.writeUInt16LE(MAX_ZIP_ENTRIES + 1, 88); // count field
    expect(() => readZipEntries(fake)).toThrow(/entry count too large/i);
  });

  it("rejects a crafted archive that tries to escape the destination", async () => {
    const dir = tmpDir();
    const zipPath = path.join(dir, "evil.zip");
    await writeZipArchive(zipPath, [{ name: "ok/evil.txt", data: Buffer.from("x") }]);
    // Craft a hostile archive independently of the writer's input validation.
    const zip = fs.readFileSync(zipPath);
    const safeName = Buffer.from("ok/evil.txt");
    for (let at = zip.indexOf(safeName); at >= 0; at = zip.indexOf(safeName, at + safeName.length)) {
      zip.write("../evil.txt", at, "utf8");
    }
    fs.writeFileSync(zipPath, zip);
    expect(() => extractZipArchive(zipPath, path.join(dir, "dest"))).toThrow();
  });

  it.each([false, true])("retains standard UTF-8 deflate compatibility (data descriptor=%s)", (descriptor) => {
    const dir = tmpDir(), zipPath = path.join(dir, "deflate.zip");
    const content = Buffer.from("portable UTF-8 data 数据\n".repeat(2000));
    const zip = deflatedZip("nested/数据.txt", content, descriptor);
    fs.writeFileSync(zipPath, zip);
    const entry = readZipEntries(zip)[0];
    expect(entry.method).toBe(8);
    expect(extractZipEntry(zip, entry)).toEqual(content);
    expect(extractZipArchive(zipPath, path.join(dir, "out"))).toEqual({ files: 1, bytes: content.length });
    expect(fs.readFileSync(path.join(dir, "out", "nested", "数据.txt"))).toEqual(content);
  });

  it("rejects duplicate paths from independently tampered ZIP headers before creating output", async () => {
    const dir = tmpDir(), zipPath = path.join(dir, "duplicates.zip");
    await writeZipArchive(zipPath, [{ name: "left.txt", data: Buffer.from("a") }, { name: "rite.txt", data: Buffer.from("b") }]);
    const zip = fs.readFileSync(zipPath), previous = Buffer.from("rite.txt");
    for (let at = zip.indexOf(previous); at >= 0; at = zip.indexOf(previous, at + previous.length)) zip.write("left.txt", at, "utf8");
    fs.writeFileSync(zipPath, zip);
    const dest = path.join(dir, "out");
    expect(() => extractZipArchive(zipPath, dest)).toThrow(/duplicate|conflict/i);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("validates local/central flags and central bounds instead of accepting inconsistent headers", async () => {
    const dir = tmpDir(), zipPath = path.join(dir, "headers.zip");
    await writeZipArchive(zipPath, [{ name: "data", data: Buffer.from("value") }]);
    const zip = fs.readFileSync(zipPath);
    const flags = Buffer.from(zip); flags.writeUInt16LE(0x0808, 6);
    expect(() => readZipEntries(flags)).toThrow(/flags|header/i);
    const bounds = Buffer.from(zip); bounds.writeUInt32LE(0, bounds.length - 22 + 16);
    expect(() => readZipEntries(bounds)).toThrow(/bounds|directory/i);
  });

  it("applies tighter extraction budgets before touching the destination", async () => {
    const dir = tmpDir(), zipPath = path.join(dir, "budget.zip");
    await writeZipArchive(zipPath, [{ name: "a", data: Buffer.alloc(8) }, { name: "b", data: Buffer.alloc(8) }]);
    for (const options of [{ maxEntryBytes: 7 }, { maxTotalBytes: 15 }]) {
      const dest = path.join(dir, "out");
      expect(() => extractZipArchive(zipPath, dest, options)).toThrow(/too large|size limit/i);
      expect(fs.existsSync(dest)).toBe(false);
    }
  });

  it("produces archives that the system unzip can list and verify (CRC ok)", async () => {
    const dir = tmpDir();
    const zipPath = path.join(dir, "out.zip");
    fs.writeFileSync(path.join(dir, "hello.txt"), "hello zip payload");
    await writeZipArchive(zipPath, [
      { name: "hello.txt", filePath: path.join(dir, "hello.txt") },
      { name: "dir/", isDirectory: true },
      { name: "dir/data.json", data: Buffer.from('{"ok":true}', "utf8") },
    ]);
    const list = spawnSync("unzip", ["-l", zipPath], { encoding: "utf8" });
    expect(list.status, list.stderr || list.stdout).toBe(0);
    expect(list.stdout).toContain("hello.txt");
    expect(list.stdout).toContain("data.json");
    const test = spawnSync("unzip", ["-t", zipPath], { encoding: "utf8" });
    expect(test.status, test.stderr || test.stdout).toBe(0);
    expect(test.stdout).toMatch(/No errors detected|OK/i);
  });
});
