import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

  it("rejects a crafted archive that tries to escape the destination", async () => {
    const dir = tmpDir();
    const zipPath = path.join(dir, "evil.zip");
    await writeZipArchive(zipPath, [{ name: "../evil.txt", data: Buffer.from("x") }]);
    expect(() => extractZipArchive(zipPath, path.join(dir, "dest"))).toThrow();
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
