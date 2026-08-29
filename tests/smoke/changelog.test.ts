// CHANGELOG hygiene (A3): the package version must always have a matching
// changelog section, so users upgrading can read what changed for exactly the
// version they downloaded.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(__dirname, "..", "..");

describe("CHANGELOG hygiene", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  const changelog = fs.readFileSync(path.join(REPO, "CHANGELOG.md"), "utf8");

  it(`has a section for the current package version (${pkg.version})`, () => {
    expect(changelog).toMatch(new RegExp(`^## \\[${pkg.version}\\]`, "m"));
  });

  it("keeps an Unreleased section at the top of the version list", () => {
    expect(changelog).toMatch(/^## \[Unreleased\]/m);
    const unreleasedIdx = changelog.indexOf("## [Unreleased]");
    const versionedIdx = changelog.search(/^## \[\d+\.\d+\.\d+\]/m);
    expect(unreleasedIdx).toBeGreaterThanOrEqual(0);
    expect(versionedIdx).toBeGreaterThan(unreleasedIdx);
  });

  it("links every documented version to package history (no typos in headings)", () => {
    const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
    for (const h of headings) {
      if (h === "Unreleased") continue;
      expect(h, `heading ${h} must be dot-separated numerics`).toMatch(/^\d+(\.\d+)*$/);
    }
  });
});
