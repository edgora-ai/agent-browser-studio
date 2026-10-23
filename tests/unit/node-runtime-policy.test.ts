import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
// Older Windows Node builds can disagree on the same file's path/fd volume identity.
const TESTED_NODE_FLOOR = "22.23.4";
const source = (file: string) => readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");

describe("source-build Node runtime policy", () => {
  it("declares the tested patch floor in the package and root lock entry", () => {
    const pkg = JSON.parse(source("package.json"));
    const lock = JSON.parse(source("package-lock.json"));
    expect(pkg.engines.node).toBe(`>=${TESTED_NODE_FLOOR}`);
    expect(lock.packages[""].engines.node).toBe(`>=${TESTED_NODE_FLOOR}`);
  });

  it.each(["ci.yml", "studio-package.yml", "engine-verify.yml"])(
    "pins every setup-node runtime in %s to the tested floor",
    (file) => {
      const workflow = source(`.github/workflows/${file}`);
      const setups = [...workflow.matchAll(/^\s+(?:-\s+)?uses:\s*actions\/setup-node@/gm)];
      const pins = [...workflow.matchAll(/^\s+node-version:\s*["']?([^"'\s]+)["']?\s*$/gm)]
        .map((match) => match[1]);
      expect(setups.length).toBeGreaterThan(0);
      expect(pins).toHaveLength(setups.length);
      expect(pins).toEqual(Array(setups.length).fill(TESTED_NODE_FLOOR));
    },
  );

  it("keeps one owned metadata probe and an extra Windows ancestry gate before the full suite", () => {
    const ci = source(".github/workflows/ci.yml");
    const windows = ci.split(/^  checks-windows:\n/m)[1]?.split(/^  [\w-]+:/m)[0] ?? "";
    expect(ci.match(/run: node scripts\/ci-filesystem-probe\.mjs/g)).toHaveLength(1);
    expect(windows).toContain("run: node scripts/ci-filesystem-probe.mjs");
    expect(windows.match(/actions\/setup-node@/g)).toHaveLength(1);
    expect(windows.indexOf("actions/setup-node@")).toBeLessThan(windows.indexOf("node scripts/ci-filesystem-probe.mjs"));
    expect(windows).toContain([
      "      - name: Cold-profile directory ancestry regressions",
      "        timeout-minutes: 5",
      "        run: npx vitest run tests/unit/created-directory-ancestry.test.ts tests/unit/webrtc-preferences.test.ts --bail=1 --maxWorkers=1 --reporter=default",
      "      - name: Unit + smoke tests",
    ].join("\n"));
    expect(windows).toContain("run: npx vitest run tests/unit tests/smoke --bail=1 --reporter=default --reporter=hanging-process");
    expect(windows).toContain("run: npx vitest run --coverage tests/unit tests/smoke --bail=1");
  });

  it.each([
    ["README.md", `- Node.js ${TESTED_NODE_FLOOR} or newer`],
    ["README.zh-CN.md", `- Node.js ${TESTED_NODE_FLOOR} 或更高版本`],
    ["docs/USER_GUIDE.en.md", `Node.js ${TESTED_NODE_FLOOR}+`],
    ["docs/USER_GUIDE.zh-CN.md", `Node.js ${TESTED_NODE_FLOOR}+`],
  ])("documents the same build prerequisite in %s", (file, prerequisite) => {
    const requirement = source(file).match(/^(?:- Node\.js |Requirements today:|当前要求：).*$/m)?.[0];
    expect(requirement).toContain(prerequisite);
  });
});
