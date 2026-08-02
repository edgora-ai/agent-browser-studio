import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findManagedChromiumBinary,
  listManagedChromiumBinaries,
  normalizeManagedChromiumVersion,
} from "../../src/main/services/native-chromium-manager.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloak-chromium-selection-"));
  roots.push(root);
  return root;
}

function installFakeMacBuild(root: string, version: string): string {
  const binary = path.join(root, `chromium-${version}`, "Chromium.app", "Contents", "MacOS", "Chromium");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "fake");
  return binary;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("managed independent Chromium selection", () => {
  it("selects the newest build by default and an exact retained build on request", () => {
    const root = makeRoot();
    const v149 = installFakeMacBuild(root, "149.0.7827.22");
    const v150 = installFakeMacBuild(root, "150.0.7871.114");

    expect(listManagedChromiumBinaries(root, "darwin").map((entry) => entry.version))
      .toEqual(["150.0.7871.114", "149.0.7827.22"]);
    expect(findManagedChromiumBinary(null, root, "darwin")?.binaryPath).toBe(v150);
    expect(findManagedChromiumBinary("149.0.7827.22", root, "darwin")?.binaryPath).toBe(v149);
    expect(findManagedChromiumBinary("148.0.7778.56", root, "darwin")).toBeNull();
  });

  it("ignores incomplete installs and rejects non-exact version pins", () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "chromium-151.0.1.2"), { recursive: true });
    expect(listManagedChromiumBinaries(root, "darwin")).toEqual([]);
    expect(normalizeManagedChromiumVersion("auto")).toBeNull();
    expect(() => normalizeManagedChromiumVersion("150")).toThrow(/Invalid Chromium version/);
    expect(() => normalizeManagedChromiumVersion("../150.0.0.0")).toThrow(/Invalid Chromium version/);
  });
});
