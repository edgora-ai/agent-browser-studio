import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { findManagedChromiumBinaryAsync, listManagedChromiumBinariesAsync } from "../../src/main/services/native-chromium-manager.js";

const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chromium-async-discovery-")));
  const identity = fs.lstatSync(root);
  const marker = path.join(root, ".fixture-owner");
  const bytes = JSON.stringify({ role: "chromium-async-discovery", root, dev: identity.dev, ino: identity.ino });
  fs.writeFileSync(marker, bytes, { flag: "wx", mode: 0o600 });
  const markerIdentity = fs.lstatSync(marker);
  const managed = path.join(root, "managed");
  const resources = path.join(root, "resources");
  function assertTree(file: string): void {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1 || (st.mode & 0o111) !== 0))) {
      throw new Error("Unexpected executable/linked fixture: " + file);
    }
    if (st.isDirectory()) for (const name of fs.readdirSync(file)) assertTree(path.join(file, name));
  }
  function clear(): void {
    const st = fs.lstatSync(root);
    const mark = fs.lstatSync(marker);
    if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== identity.dev || st.ino !== identity.ino ||
        !mark.isFile() || mark.isSymbolicLink() || mark.nlink !== 1 || mark.dev !== markerIdentity.dev ||
        mark.ino !== markerIdentity.ino || fs.readFileSync(marker, "utf8") !== bytes) throw new Error("Fixture ownership changed");
    const names = fs.readdirSync(root).filter(name => name !== ".fixture-owner");
    for (const name of names) {
      if (!["managed", "resources", "cache"].includes(name)) throw new Error("Unexpected fixture role: " + name);
      assertTree(path.join(root, name));
    }
    for (const name of names) fs.rmSync(path.join(root, name), { recursive: true });
  }
  return { root, managed, resources, clear, dispose: () => { clear(); fs.unlinkSync(marker); fs.rmdirSync(root); } };
});

const probes = vi.hoisted(() => ({
  output: new Map<string, string>(),
  hold: false,
  callbacks: [] as Array<() => void>,
  execFile: vi.fn(),
  spawn: vi.fn(() => { throw new Error("No archive/native spawn allowed in this suite"); }),
  spawnSync: vi.fn(() => { throw new Error("No synchronous browser probe allowed in this suite"); }),
}));
vi.mock("node:child_process", () => ({ execFile: probes.execFile, spawn: probes.spawn, spawnSync: probes.spawnSync }));

function localBuild(version: string): string {
  const binary = path.join(fixture.managed, "chromium-" + version, "Chromium.app", "Contents", "MacOS", "Chromium");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "non-executable local inventory fixture", { mode: 0o600 });
  return binary;
}
function bundledBuild(actual = "152.0.7977.72"): string {
  const root = path.join(fixture.resources, "native-browsers");
  const binary = path.join(root, "Chromium.app", "Contents", "MacOS", "Chromium");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "non-executable bundled inventory fixture", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "browsers-manifest.json"), JSON.stringify({ chromiumVersion: "151.0.1.2" }));
  probes.output.set(binary, "Chromium " + actual);
  return binary;
}

beforeEach(() => {
  fixture.clear();
  fs.mkdirSync(fixture.managed);
  fs.mkdirSync(path.join(fixture.resources, "native-browsers"), { recursive: true });
  vi.stubEnv("AGENT_BROWSER_BUNDLED_RESOURCES", fixture.resources);
  vi.stubEnv("AGENT_BROWSER_BUNDLED_CACHE_DIR", path.join(fixture.root, "cache"));
  probes.output.clear(); probes.callbacks = []; probes.hold = false;
  probes.execFile.mockReset(); probes.spawn.mockClear(); probes.spawnSync.mockClear();
  probes.execFile.mockImplementation((binary: string, args: string[], options: any, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    expect(binary.startsWith(fixture.resources + path.sep)).toBe(true);
    expect(fs.statSync(binary).isFile()).toBe(true);
    expect(fs.statSync(binary).mode & 0o111).toBe(0);
    expect(args).toEqual(["--version"]);
    expect(options).toMatchObject({ timeout: 5000, shell: false, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    const finish = () => callback(null, probes.output.get(binary) || "", "");
    if (probes.hold) probes.callbacks.push(finish); else queueMicrotask(finish);
    return {};
  });
});
afterEach(() => {
  expect(probes.spawn).not.toHaveBeenCalled();
  expect(probes.spawnSync).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  fixture.clear();
});
afterAll(() => fixture.dispose());

describe("async native Chromium inventory with actual manifest/filesystem discovery", () => {
  it("lists newest first and finds an exact retained owned build", async () => {
    const older = localBuild("149.0.7827.22");
    const newer = localBuild("150.0.7871.114");
    expect((await listManagedChromiumBinariesAsync(fixture.managed, "darwin")).map(item => item.version)).toEqual(["150.0.7871.114", "149.0.7827.22"]);
    expect((await findManagedChromiumBinaryAsync(null, fixture.managed, "darwin"))?.binaryPath).toBe(newer);
    expect((await findManagedChromiumBinaryAsync("149.0.7827.22", fixture.managed, "darwin"))?.binaryPath).toBe(older);
    expect(await findManagedChromiumBinaryAsync("148.0.1.2", fixture.managed, "darwin")).toBeNull();
    expect(probes.execFile).not.toHaveBeenCalled();
  });

  it("ignores incomplete/non-file installs and rejects a non-exact pin", async () => {
    fs.mkdirSync(path.join(fixture.managed, "chromium-151.0.1.2"));
    fs.mkdirSync(path.join(fixture.managed, "chromium-150.0.1.2", "Chromium.app", "Contents", "MacOS", "Chromium"), { recursive: true });
    fs.mkdirSync(path.join(fixture.managed, "unrelated"));
    expect(await listManagedChromiumBinariesAsync(fixture.managed, "darwin")).toEqual([]);
    await expect(findManagedChromiumBinaryAsync("150", fixture.managed, "darwin")).rejects.toThrow(/Invalid Chromium version/);
    expect(probes.execFile).not.toHaveBeenCalled();
  });

  it("uses actual bundled version output rather than a conflicting manifest hint", async () => {
    const bundled = bundledBuild();
    const local = localBuild("150.0.7871.114");
    expect(await listManagedChromiumBinariesAsync(fixture.managed, "darwin")).toMatchObject([
      { binaryPath: bundled, version: "152.0.7977.72" }, { binaryPath: local, version: "150.0.7871.114" },
    ]);
    expect((await findManagedChromiumBinaryAsync("152.0.7977.72", fixture.managed, "darwin"))?.binaryPath).toBe(bundled);
    expect(probes.execFile).toHaveBeenCalledTimes(1);
  });

  it("keeps timers responsive while a real discovered bundled path's mocked probe is pending", async () => {
    const bundled = bundledBuild(); probes.hold = true;
    const pending = listManagedChromiumBinariesAsync(fixture.managed, "darwin");
    await vi.waitFor(() => expect(probes.callbacks).toHaveLength(1));
    let timer = false;
    await new Promise<void>(resolve => setTimeout(() => { timer = true; resolve(); }, 0));
    expect(timer).toBe(true);
    probes.callbacks.shift()!();
    expect(await pending).toMatchObject([{ binaryPath: bundled, version: "152.0.7977.72" }]);
  });
});
