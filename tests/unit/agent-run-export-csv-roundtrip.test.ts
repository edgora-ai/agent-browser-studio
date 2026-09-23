// Independent RFC 4180 parser: proves the formula prefix survives parsing,
// not just that it appears in the raw string.
import { describe, it, expect } from "vitest";
import { datasetToCsv } from "../../src/main/services/agent-run-export.js";

function parseRfc4180(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let i = 0; let inQ = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } inQ = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i += 2; continue; }
    cell += ch; i++;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

describe("csv round trip", () => {
  it("no parsed cell can start a formula", () => {
    const env: any = {
      schemaVersion: 1, kind: "dataset", runId: "run_x", artifactId: "dataset", name: "dataset",
      columns: ["title", "url", "source", "published_at"],
      rows: [
        ["=1+1", "https://e.com/a", "S", "2026-09-19"],
        ["+SUM(A1:A9)", "https://e.com/b", "S", "2026-09-19"],
        ["-2+3", "https://e.com/c", "S", "2026-09-19"],
        ["@SUM(A1)", "https://e.com/d", "S", "2026-09-19"],
        ["\t=cmd", "https://e.com/e", "S", "2026-09-19"],
        [" =HYPERLINK(1)", "https://e.com/f", "S", "2026-09-19"],
        ["=cmd|',calc'!A0", "https://e.com/g", "S", "2026-09-19"],
        ["plain, with comma", "https://e.com/h", "S", "2026-09-19"],
      ],
      sourceRowCount: 8, rejectedRowCount: 0, truncated: false,
    };
    const { csv } = datasetToCsv(env);
    const parsed = parseRfc4180(csv);
    // Header + 8 data rows. parsed[0] is the header, so data row N is parsed[N].
    expect(parsed.length).toBe(9);
    const FORMULA = /^[\s]*[=+\-@]/;
    const stillFormulas = parsed.slice(1).map((r) => r[0]).filter((c) => FORMULA.test(c));
    expect(stillFormulas).toEqual([]);
    // Everything after the guard prefix is preserved verbatim.
    expect(parsed[1][0]).toBe("'=1+1");
    expect(parsed[6][0]).toBe("' =HYPERLINK(1)");
    expect(parsed[7][0]).toBe("'=cmd|',calc'!A0");
    expect(parsed[8][0]).toBe("plain, with comma");
    // Column alignment survives quoting.
    expect(parsed[8][1]).toBe("https://e.com/h");
    expect(parsed[8][3]).toBe("2026-09-19");
  });
});
