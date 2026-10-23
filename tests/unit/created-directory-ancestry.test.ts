import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { createdDirectoryAncestry } from "../../src/main/services/browser/created-directory-ancestry.js";

// Windows path semantics only: no local drive, share, link or filesystem access.
describe("recursive mkdir ancestry boundaries", () => {
  it.each([
    ["POSIX", path.posix, "/owned/new/profile", "/owned/new/.", ["/owned/new/profile", "/owned/new"]],
    ["Windows drive namespace", path.win32, "C:\\owned\\new\\profile", "\\\\?\\C:\\owned\\new", ["C:\\owned\\new\\profile", "C:\\owned\\new"]],
    ["Windows UNC namespace", path.win32, "\\\\server\\share\\owned\\new\\profile", "\\\\?\\UNC\\server\\share\\owned\\new", ["\\\\server\\share\\owned\\new\\profile", "\\\\server\\share\\owned\\new"]],
    ["Windows casing", path.win32, "C:\\owned\\new\\profile", "\\\\?\\c:\\OWNED\\NEW", ["C:\\owned\\new\\profile", "C:\\owned\\new"]],
    ["already namespaced target", path.win32, "\\\\?\\C:\\owned\\new\\profile", "C:\\owned\\new", ["\\\\?\\C:\\owned\\new\\profile", "\\\\?\\C:\\owned\\new"]],
    ["single directory", path.posix, "/owned/new", "/owned/new/", ["/owned/new"]],
  ] as const)("recognizes the equivalent %s boundary without walking past it", (_label, paths, directory, first, expected) => {
    expect(createdDirectoryAncestry(directory, first, paths)).toEqual(expected);
  });

  it.each([
    [path.posix, "/owned/new/profile", "/unrelated"],
    [path.posix, "/owned/new-other/profile", "/owned/new"],
    [path.win32, "C:\\owned\\new\\profile", "D:\\owned\\new"],
    [path.win32, "\\\\server\\share\\owned\\profile", "\\\\?\\UNC\\other\\share\\owned"],
    [path.win32, "C:\\owned\\new\\profile", "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\owned"],
  ] as const)("refuses a boundary on an unrelated ancestry or device", (paths, directory, first) => {
    expect(() => createdDirectoryAncestry(directory, first, paths)).toThrow(/not an ancestor/);
  });

  it.each([["relative/profile", "/owned"], ["/owned/profile", "relative"]])("refuses relative boundaries", (directory, first) => {
    expect(() => createdDirectoryAncestry(directory, first, path.posix)).toThrow(/must be absolute/);
  });

  it("rejects a resolver that stops making progress instead of spinning", () => {
    const stalled = { ...path.posix, dirname: (directory: string) => directory };
    expect(() => createdDirectoryAncestry("/owned/new/profile", "/owned/new", stalled)).toThrow(/no progress/);
  });
});
