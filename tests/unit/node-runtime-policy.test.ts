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

  it.each(["checks", "checks-windows"])("prepares the explicit Python SDK fixture runtime in %s", job => {
    const block = source(".github/workflows/ci.yml").split(new RegExp(`^  ${job}:\\n`, "m"))[1]?.split(/^  [\w-]+:/m)[0] ?? "";
    expect(block).toContain([
      "      - uses: actions/setup-python@v5",
      "        with:",
      "          python-version: \"3.13\"",
    ].join("\n"));
    expect(block.indexOf("actions/setup-python@v5")).toBeLessThan(block.indexOf("Unit + smoke tests"));
    expect(block).not.toContain("continue-on-error");
  });

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
    ].join("\n"));
    expect(windows.indexOf("Cold-profile directory ancestry regressions")).toBeLessThan(windows.indexOf("Unit + smoke tests"));
    expect(windows).toContain("run: npx vitest run tests/unit tests/smoke --bail=1 --reporter=default --reporter=hanging-process");
    expect(windows).toContain("run: npx vitest run --coverage tests/unit tests/smoke --bail=1");
  });

  it("bounds native recovery diagnostics without suppressing failures or replacing full gates", () => {
    const windows = source(".github/workflows/ci.yml").split(/^  checks-windows:\n/m)[1]?.split(/^  [\w-]+:/m)[0] ?? "";
    const diagnostic = windows.split("      - name: Native recovery unit diagnostics\n")[1]?.split("\n      - ")[0] ?? "";
    expect(diagnostic).toContain("        timeout-minutes: 15");
    expect(diagnostic).not.toMatch(/continue-on-error|\bif:/);
    const command = diagnostic.split("        run: >-\n")[1]?.trim().split("\n").map((line) => line.trim()).join(" ");
    expect(command).toBe([
      "npx vitest run",
      "tests/unit/profile-archive-sync-recovery.test.ts",
      "tests/unit/sync-full-profile-artifact.test.ts",
      "tests/unit/full-profile-responsiveness.test.ts",
      "tests/unit/sync-tar-lifecycle.test.ts",
      "tests/unit/sync-sqlite-local-storage.test.ts",
      "tests/unit/sync-history-transport.test.ts",
      "tests/unit/sync-restore-safety.test.ts",
      "tests/unit/profile-archive-safety.test.ts",
      "tests/unit/profile-archive.test.ts",
      "tests/unit/full-profile-config-durability.test.ts",
      "tests/unit/cookie-export-snapshot.test.ts",
      "tests/unit/fingerprint-drift-reports.test.ts",
      "tests/unit/profile-credentials.test.ts",
      "tests/unit/profile-credentials-staging.test.ts",
      "tests/unit/full-profile-recovery-lock.test.ts",
      "tests/unit/firefox-cookie-import.test.ts",
      "tests/unit/agent-tool-local.test.ts",
      "tests/unit/ui-goal-account-transport.test.ts",
      "tests/unit/sync-service.test.ts",
      "tests/unit/renderer-profile-trash-f09.test.ts",
      "tests/unit/profile-mutation-restore-lock.test.ts",
      "tests/unit/health-launch-proxy.test.ts",
      "--bail=0 --maxWorkers=1 --reporter=default --reporter=hanging-process",
      "--reporter=json --outputFile=\"$TMPDIR/native-recovery.json\"",
    ].join(" "));
    const summary = windows.split("      - name: Summarize native recovery unit diagnostics\n")[1]?.split("\n      - ")[0] ?? "";
    expect(summary).toContain("        if: always()");
    expect(summary).toContain("        run: node scripts/ci-native-test-summary.mjs \"$TMPDIR/native-recovery.json\" 22");
    expect(summary).not.toMatch(/continue-on-error/);
    const gates = ["Cold-profile directory ancestry regressions", "Native recovery unit diagnostics", "Summarize native recovery unit diagnostics", "Unit + smoke tests", "Coverage (unit + smoke, threshold gated)"];
    for (let index = 1; index < gates.length; index++) {
      expect(windows.indexOf(gates[index - 1])).toBeLessThan(windows.indexOf(gates[index]));
    }
  });

  it("keeps the complete Windows suite separate from bounded recovery receipts", () => {
    const windows = source(".github/workflows/ci.yml").split(/^  checks-windows:\n/m)[1]?.split(/^  [\w-]+:/m)[0] ?? "";
    const unit = windows.split("      - name: Unit + smoke tests\n")[1]?.split("\n      - ")[0] ?? "";
    expect(unit).toContain("        id: unit_smoke");
    expect(unit).toContain("run: npx vitest run tests/unit tests/smoke --bail=1 --reporter=default --reporter=hanging-process --reporter=json --outputFile=\"$TMPDIR/unit-smoke.json\"");
    expect(unit).not.toMatch(/continue-on-error/);
    const summary = windows.split("      - name: Summarize unit + smoke results\n")[1]?.split("\n      - ")[0] ?? "";
    expect(summary).toContain("if: always() && (steps.unit_smoke.outcome == 'success' || steps.unit_smoke.outcome == 'failure')");
    expect(summary).toContain("run: node scripts/ci-native-test-summary.mjs \"$TMPDIR/unit-smoke.json\" all");
    expect(summary).not.toMatch(/continue-on-error/);
    expect(windows.indexOf("Summarize unit + smoke results")).toBeLessThan(windows.indexOf("Coverage (unit + smoke, threshold gated)"));
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
