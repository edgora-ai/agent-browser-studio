import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { identityForManagedProfile, inspectProfileCredentials, type ProfileCredentialOptions } from "../../src/main/services/sync/profile-credentials.js";

// Exercise the actual staging guard with real owned directories. The VM only
// selects platform semantics; it does not emulate Windows ACLs or a keychain.
const source = fs.readFileSync(new URL("../../src/main/services/sync/profile-credentials.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("profile-credentials.ts", source, ts.ScriptTarget.ES2022, true);
const names = new Set(["CredentialPortabilityError", "fail", "checkIdentity", "checkAbort", "relativeDirectory", "assertDirectories", "assertStaging"]);
const selected = parsed.statements.filter(node =>
  (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && names.has(node.name.text));
if (selected.length !== names.size) throw new Error("Credential staging guard source was not found exactly");
const script = new vm.Script(ts.transpileModule(selected.map(node => node.getText(parsed)).join("\n") + "\nassertStaging;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText);
function guard(platform: "win32" | "darwin" | "linux"): (options: ProfileCredentialOptions) => string {
  return script.runInNewContext({ fs, path, exports: {}, process: { platform, ...(platform !== "win32" && process.getuid ? { getuid: process.getuid } : {}) } }, { timeout: 1000 });
}

const roots: { directory: string; owner: fs.Stats }[] = [];
function staging(): ProfileCredentialOptions {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "credential-staging-guard-"));
  roots.push({ directory, owner: fs.lstatSync(directory) });
  const stagingRoot = path.join(directory, "full-profile");
  fs.mkdirSync(path.join(stagingRoot, "Default"), { recursive: true, mode: 0o700 });
  return { stagingRoot, stagingOwner: fs.lstatSync(stagingRoot), profileRelativePath: "Default", source: identityForManagedProfile("chromium", "linux", "synthetic-staging-source") };
}
afterEach(() => {
  for (const { directory, owner } of roots.splice(0)) {
    const current = fs.lstatSync(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error("Owned staging fixture changed before cleanup");
    fs.rmSync(directory, { recursive: true });
  }
});

describe("credential staging platform and owner guards", () => {
  it("inspects an actual native owned empty staging without changing the caller inventory", async () => {
    const options = staging(), before = fs.readdirSync(options.stagingRoot);
    const report = await inspectProfileCredentials(options);
    expect(report).toMatchObject({ status: "absent", verification: "no-credential-files", sourceFiles: [] });
    expect(fs.readdirSync(options.stagingRoot)).toEqual(before);
    expect(before).toEqual(["Default"]);
  });

  it("does not treat Windows stat permission bits as POSIX permissions or ACL proof", () => {
    const options = staging();
    if (process.platform !== "win32") fs.chmodSync(options.stagingRoot, 0o777);
    expect(fs.lstatSync(options.stagingRoot).mode & 0o077).not.toBe(0);
    expect(guard("win32")(options)).toBe(path.join(options.stagingRoot, "Default"));
  });

  it.each(["darwin", "linux"] as const)("still refuses non-owner mode bits under %s policy", platform => {
    const options = staging();
    if (process.platform !== "win32") fs.chmodSync(options.stagingRoot, 0o770);
    expect(fs.lstatSync(options.stagingRoot).mode & 0o077).not.toBe(0);
    expect(() => guard(platform)(options)).toThrowError(expect.objectContaining({ code: "STAGING_OWNER_MISMATCH" }));
  });

  it.each(["dev", "ino"] as const)("still refuses a changed Windows staging %s owner", field => {
    const options = staging();
    options.stagingOwner = { ...options.stagingOwner, [field]: options.stagingOwner[field] === 0 ? 1 : 0 };
    expect(() => guard("win32")(options)).toThrowError(expect.objectContaining({ code: "STAGING_OWNER_MISMATCH" }));
  });

  it("still refuses a real replacement directory under Windows policy", () => {
    const options = staging();
    fs.renameSync(options.stagingRoot, options.stagingRoot + "-original");
    fs.mkdirSync(options.stagingRoot, { mode: 0o700 });
    expect(() => guard("win32")(options)).toThrowError(expect.objectContaining({ code: "STAGING_OWNER_MISMATCH" }));
  });

  it("refuses a staging symlink without treating a matching target inode as ownership", () => {
    const options = staging(), link = options.stagingRoot + "-link";
    fs.symlinkSync(options.stagingRoot, link, process.platform === "win32" ? "junction" : "dir");
    options.stagingRoot = link;
    expect(() => guard("win32")(options)).toThrowError(expect.objectContaining({ code: "STAGING_DIRECTORY_UNSAFE" }));
  });

  it("keeps canonical absolute paths mandatory under Windows policy", () => {
    const options = staging(); options.stagingRoot += path.sep + ".";
    expect(() => guard("win32")(options)).toThrowError(expect.objectContaining({ code: "STAGING_PATH_INVALID" }));
  });

  it("does not substitute the host platform for explicit source crypto provenance", () => {
    const options = staging(); options.source = { ...options.source, platform: "darwin" };
    expect(() => guard("win32")(options)).toThrowError(expect.objectContaining({ code: "IDENTITY_INVALID" }));
  });

  it("keeps cancellation ahead of staging admission", () => {
    const options = staging(), controller = new AbortController(); controller.abort(); options.signal = controller.signal;
    expect(() => guard("win32")(options)).toThrowError(expect.objectContaining({ code: "CANCELLED" }));
  });
});
