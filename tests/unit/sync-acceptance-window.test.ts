import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

// This source guard does not establish native durability. It prevents history
// acceptance from adding a wait/flush or changing the original four-cycle gate.
describe("original immediate-stop acceptance window", () => {
  it("retains the pinned 2333-byte write/stop/restart window inside its actual phase", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../e2e/sync-state-acceptance.test.ts"), "utf8");
    const marker = 'await phase("immediate write then real Studio stop and same-profile relaunch"';
    const start = source.indexOf(marker), end = source.indexOf("\n      await phase(", start + marker.length);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const phase = Buffer.from(source.slice(start, end));
    const expected = "0d1099d564189e4961c955dd7d8123730a4c4b0cb4c0d315fa82afe60c63d79a";
    let matches = 0;
    for (let offset = 0; offset + 2333 <= phase.length; offset++) {
      if (createHash("sha256").update(phase.subarray(offset, offset + 2333)).digest("hex") === expected) matches++;
    }
    expect(matches).toBe(1);
    expect(phase.toString()).toContain("for (let cycle = 1; cycle <= 4; cycle++)");
    expect(phase.toString()).not.toMatch(/waitForTimeout|\.send\(["'](?:DOMStorage|Storage)\.|enableAggressiveDomStorageFlushing/);
  });
});
