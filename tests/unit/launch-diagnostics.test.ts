import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareChromiumDiagnosticNetLogArgs } from "../../src/main/services/browser/launch-diagnostics.js";

// Transparent real-filesystem calls, with only owned-descriptor fault injection overridden below.
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), fstatSync: vi.fn(actual.fstatSync) };
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

// Small disposable fixtures only. All link targets are inside this owned tree.
let fixture: string;
let appData: string;
let output: string;

beforeEach(() => {
  vi.mocked(fs.openSync).mockReset().mockImplementation(actualFs.openSync);
  vi.mocked(fs.fstatSync).mockReset().mockImplementation(actualFs.fstatSync);
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "abs-netlog-unit-"));
  appData = path.join(fixture, "userData");
  fs.mkdirSync(appData, { mode: 0o700 });
  output = path.join(appData, "diagnostics", "site-run.netlog.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe.each([undefined, "direct-fd-20s", "direct-fd-90s"])("scoped Chromium diagnostic NetLog (%s)", mode => {
  function prepare(filePath = output, scope = appData) {
    return prepareChromiumDiagnosticNetLogArgs(appData, { appDataDir: scope, filePath, ...(mode === undefined ? {} : { mode }) });
  }
  it("is disabled without both explicit settings and performs no filesystem work", () => {
    expect(prepareChromiumDiagnosticNetLogArgs(path.join(fixture, "nonexistent"), {})).toEqual([]);
    expect(fs.readdirSync(appData)).toEqual([]);
  });

  it("reserves a new empty private file and only fixed redacted timed JSON switches", () => {
    const open = vi.mocked(fs.openSync);
    const args = prepare();
    expect(open).toHaveBeenCalledExactlyOnceWith(fs.realpathSync(output),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    expect(args).toEqual([
      `--log-net-log=${fs.realpathSync(output)}`,
      "--net-log-capture-mode=Default",
      "--net-log-file-format=json",
      ...(mode === undefined ? ["--net-log-max-size-mb=64", "--net-log-duration=180"] : [mode === "direct-fd-20s" ? "--net-log-duration=20" : "--net-log-duration=90"]),
    ]);
    expect(fs.readFileSync(output)).toEqual(Buffer.alloc(0));
    expect(fs.lstatSync(output).isFile()).toBe(true);
    expect(fs.lstatSync(output).nlink).toBe(1);
    if (process.platform !== "win32") {
      expect(fs.statSync(output).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(output)).mode & 0o777).toBe(0o700);
    }
    expect(args).toHaveLength(mode === undefined ? 5 : 4);
    expect(args.some(arg => /IncludeSensitive|Everything|disable-infobars|test-type|ignore-certificate/.test(arg))).toBe(false);
  });

  it.each(["", "default", "direct-fd", "direct-fd-180s", "direct-fd-90s --disable-infobars"])(
    "rejects an unknown mode before any output reservation: %j", unknownMode => {
      expect(() => prepareChromiumDiagnosticNetLogArgs(appData, { appDataDir: appData, filePath: output, mode: unknownMode }))
        .toThrow(/Invalid Chromium diagnostic NetLog:.*mode/);
      expect(fs.readdirSync(appData)).toEqual([]);
    },
  );

  it.each([
    { mode: "direct-fd-90s" },
    { mode: "direct-fd-90s", appDataDir: "" },
  ])("does not silently ignore a mode-only request: %j", request => {
    expect(() => prepareChromiumDiagnosticNetLogArgs(appData, request)).toThrow(/explicit absolute filesystem path/);
    expect(fs.readdirSync(appData)).toEqual([]);
  });

  it("requires both scope and path for the explicit mode before creating output", () => {
    for (const request of [
      { mode: "direct-fd-90s", appDataDir: appData },
      { mode: "direct-fd-90s", filePath: output },
    ]) expect(() => prepareChromiumDiagnosticNetLogArgs(appData, request)).toThrow(/explicit absolute filesystem path/);
    expect(fs.readdirSync(appData)).toEqual([]);
  });

  it.each([
    { filePath: "placeholder" },
    { appDataDir: "placeholder" },
    { appDataDir: "", filePath: "" },
  ])("rejects a partial or empty request instead of silently enabling defaults: %j", request => {
    expect(() => prepareChromiumDiagnosticNetLogArgs(appData, { ...request, ...(mode === undefined ? {} : { mode }) })).toThrow(/Invalid Chromium diagnostic NetLog/);
    expect(fs.readdirSync(appData)).toEqual([]);
  });

  it("rejects another userData scope before creating output", () => {
    const other = path.join(fixture, "other-userData");
    fs.mkdirSync(other, { mode: 0o700 });
    expect(() => prepare(output, other)).toThrow(/scope does not match/);
    expect(fs.readdirSync(appData)).toEqual([]);
    expect(fs.readdirSync(other)).toEqual([]);
  });

  it.each([
    "relative.netlog.json", "https://example.test/capture.netlog.json",
    "file:///capture.netlog.json", " /capture.netlog.json", "/capture.netlog.json ",
    "/capture\n.netlog.json", "/capture\0.netlog.json",
  ])("rejects non-filesystem, relative or control-character paths: %j", filePath => {
    expect(() => prepare(filePath)).toThrow(/Invalid Chromium diagnostic NetLog/);
    expect(fs.readdirSync(appData)).toEqual([]);
  });

  it("rejects traversal and any output outside the direct scoped diagnostic directory", () => {
    for (const filePath of [
      path.join(fixture, "outside.netlog.json"),
      path.join(appData, "capture.netlog.json"),
      path.join(appData, "diagnostics", "..", "capture.netlog.json"),
      path.join(appData, "diagnostics", "nested", "capture.netlog.json"),
    ]) expect(() => prepare(filePath)).toThrow(/output must be directly inside/);
    expect(fs.readdirSync(appData)).toEqual([]);
  });

  it.each([".netlog.json", "capture.json", "capture.netlog.json--flag", "x".repeat(97) + ".netlog.json"])(
    "rejects malformed or unbounded output names: %s", basename => {
      expect(() => prepare(path.join(appData, "diagnostics", basename))).toThrow(/bounded diagnostic/);
      expect(fs.readdirSync(appData)).toEqual([]);
    },
  );

  it("does not truncate a prior log or reuse a reservation", () => {
    prepare();
    fs.writeFileSync(output, "retained previous log\n");
    expect(() => prepare()).toThrow(/EEXIST/);
    expect(fs.readFileSync(output, "utf8")).toBe("retained previous log\n");
  });

  it("rejects an output path already occupied by a directory", () => {
    fs.mkdirSync(path.dirname(output), { mode: 0o700 });
    fs.mkdirSync(output, { mode: 0o700 });
    expect(() => prepare()).toThrow(/EEXIST/);
    expect(fs.lstatSync(output).isDirectory()).toBe(true);
  });

  it("preserves another file occupying the diagnostic directory", () => {
    fs.writeFileSync(path.dirname(output), "retained fixture file");
    expect(() => prepare()).toThrow(/must not be a link or file/);
    expect(fs.readFileSync(path.dirname(output), "utf8")).toBe("retained fixture file");
  });

  if (process.platform !== "win32") {
    it.each(["mode", "owner"])("checks the actual reserved descriptor's %s without fixing permissions or deleting the reservation", changed => {
      vi.mocked(fs.fstatSync).mockImplementation(fd => {
        const stat = actualFs.fstatSync(fd);
        if (changed === "mode") stat.mode = (stat.mode & ~0o777) | 0o400;
        else stat.uid = process.getuid!() + 1;
        return stat;
      });
      expect(() => prepare()).toThrow(/owned by this user with mode 0600/);
      expect(fs.lstatSync(output).isFile()).toBe(true);
      expect(fs.lstatSync(output).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(output)).toEqual(Buffer.alloc(0));
    });

    it("rejects a private userData beneath a writable non-sticky ancestor", () => {
      const shared = path.join(fixture, "owned-shared-parent");
      fs.mkdirSync(shared, { mode: 0o700 });
      fs.chmodSync(shared, 0o777);
      const scoped = path.join(shared, "private-userData");
      fs.mkdirSync(scoped, { mode: 0o700 });
      expect(() => prepareChromiumDiagnosticNetLogArgs(scoped, {
        appDataDir: scoped, filePath: path.join(scoped, "diagnostics", "capture.netlog.json"), ...(mode === undefined ? {} : { mode }),
      })).toThrow(/unsafe writable ancestor/);
      expect(fs.readdirSync(scoped)).toEqual([]);
    });

    it("allows an owner-protected entry below a trusted sticky directory", () => {
      const shared = path.join(fixture, "owned-sticky-parent");
      fs.mkdirSync(shared, { mode: 0o700 });
      fs.chmodSync(shared, 0o1777);
      const scoped = path.join(shared, "private-userData");
      fs.mkdirSync(scoped, { mode: 0o700 });
      const filePath = path.join(scoped, "diagnostics", "capture.netlog.json");
      expect(prepareChromiumDiagnosticNetLogArgs(scoped, { appDataDir: scoped, filePath, ...(mode === undefined ? {} : { mode }) }))
        .toContain(`--log-net-log=${fs.realpathSync(filePath)}`);
    });

    it("rejects a linked diagnostic directory without reading or changing its target", () => {
      const target = path.join(fixture, "owned-link-target");
      fs.mkdirSync(target, { mode: 0o700 });
      fs.symlinkSync(target, path.dirname(output));
      expect(() => prepare()).toThrow(/must not be a link or file/);
      expect(fs.readdirSync(target)).toEqual([]);
    });

    it("rejects a linked output without following or modifying it", () => {
      const target = path.join(fixture, "owned-prior-log");
      fs.writeFileSync(target, "retained target");
      fs.mkdirSync(path.dirname(output), { mode: 0o700 });
      fs.symlinkSync(target, output);
      expect(() => prepare()).toThrow(/EEXIST/);
      expect(fs.lstatSync(output).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("retained target");
    });

    it("rejects a diagnostic directory writable by others without changing permissions", () => {
      fs.mkdirSync(path.dirname(output), { mode: 0o700 });
      fs.chmodSync(path.dirname(output), 0o777);
      expect(() => prepare()).toThrow(/not writable by others/);
      expect(fs.statSync(path.dirname(output)).mode & 0o777).toBe(0o777);
      expect(fs.existsSync(output)).toBe(false);
    });

    it("rejects userData writable by others before making a diagnostic directory", () => {
      fs.chmodSync(appData, 0o777);
      expect(() => prepare()).toThrow(/not writable by others/);
      expect(fs.readdirSync(appData)).toEqual([]);
    });
  }
});
