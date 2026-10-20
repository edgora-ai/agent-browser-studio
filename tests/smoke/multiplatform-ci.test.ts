/// <reference path="./js-yaml.d.ts" />
// Smoke tests — multi-platform production verification (Slice 52):
// Windows engine build path + the CI workflows that close the last
// alignment row (signed multi-platform distribution).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";

const ROOT = path.resolve(__dirname, "../..");

describe("Smoke — Windows engine build path", () => {
  it("args.gn.win exists and mirrors the release surface", () => {
    const gn = fs.readFileSync(path.join(ROOT, "patches/chromium/args.gn.win"), "utf8");
    expect(gn).toContain('target_os = "win"');
    expect(gn).toContain("is_official_build = true");
    expect(gn).toContain('ffmpeg_branding = "Chrome"');
    expect(gn).toContain("proprietary_codecs = true");
    expect(gn).toContain("enable_widevine = true");
    expect(gn).toContain("enable_widevine_cdm_component = false");
    for (const line of gn.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      expect(t, "unparseable gn line: " + t).toMatch(/^[\w]+ = /);
    }
  });

  it("build-windows.sh is present, executable, shell-valid and self-contained", () => {
    const p = path.join(ROOT, "patches/chromium/build-windows.sh");
    expect(fs.existsSync(p)).toBe(true);
    const mode = fs.statSync(p).mode;
    if (process.platform !== "win32") {
    expect(mode & 0o111, "build-windows.sh must be executable").not.toBe(0);
    }
    expect(() => execFileSync("bash", ["-n", p], { stdio: "pipe" })).not.toThrow();
    const src = fs.readFileSync(p, "utf8");
    expect(src).toContain("args.gn.win");
    expect(src).toContain("apply.sh");
    expect(src).toContain("autoninja -C");
    expect(src).toContain("DEPOT_TOOLS_WIN_TOOLCHAIN");
  });
});

describe("Smoke — Multi-platform CI workflows", () => {
  interface WorkflowStep {
    name?: string;
    uses?: string;
    run?: string;
  }
  interface WorkflowJob {
    "runs-on": string;
    steps: WorkflowStep[];
  }
  interface Workflow { jobs: Record<string, WorkflowJob> }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  // Validate the consumed workflow contract at the YAML/unknown boundary.
  // Additional GitHub Actions fields remain untouched; missing/malformed jobs
  // or steps must fail rather than being converted to an empty fixture.
  function assertWorkflow(value: unknown, name: string): asserts value is Workflow {
    if (!isRecord(value) || !isRecord(value.jobs)) throw new Error(name + ": expected jobs mapping");
    for (const [id, job] of Object.entries(value.jobs)) {
      if (!isRecord(job) || typeof job["runs-on"] !== "string" || !Array.isArray(job.steps)) {
        throw new Error(name + ": invalid job " + id);
      }
      for (const step of job.steps) {
        if (!isRecord(step)) throw new Error(name + ": invalid step in " + id);
        for (const key of ["name", "uses", "run"]) {
          if (key in step && typeof step[key] !== "string") throw new Error(name + ": invalid " + key + " in " + id);
        }
      }
    }
  }
  function loadWorkflow(name: string): Workflow {
    const file = path.join(ROOT, ".github", "workflows", name);
    expect(fs.existsSync(file), name + " must exist").toBe(true);
    const value: unknown = yaml.load(fs.readFileSync(file, "utf8"));
    assertWorkflow(value, name);
    return value;
  }
  function stepNames(job: WorkflowJob): string[] {
    return job.steps.map((s) => s.name || "");
  }

  it("ci.yml gates on Linux and Windows; macOS e2e requires an engine", () => {
    const doc = loadWorkflow("ci.yml");
    expect(doc.jobs.checks).toBeTruthy();
    expect(doc.jobs["checks-windows"]).toBeTruthy();
    expect(doc.jobs["checks-windows"]["runs-on"]).toBe("windows-latest");
    expect(doc.jobs["e2e-macos"]).toBeTruthy();
    const steps = stepNames(doc.jobs["checks-windows"]);
    expect(steps).toContain("Type-check");
    expect(steps.some((n) => /Build/.test(n))).toBe(true);
  });

  it("engine-verify.yml builds, verifies, e2e-tests, packages and checksums on Linux and Windows", () => {
    const doc = loadWorkflow("engine-verify.yml");
    expect(doc.jobs["linux-x64"]).toBeTruthy();
    expect(doc.jobs["windows-x64"]).toBeTruthy();
    for (const job of [doc.jobs["linux-x64"], doc.jobs["windows-x64"]]) {
      const steps = stepNames(job);
      expect(steps).toContain("Build independent engine");
      expect(steps).toContain("Strict native verifier (53 surfaces)");
      expect(steps.some((n) => /^E2E suite/.test(n))).toBe(true);
      expect(steps.some((n) => /Package/.test(n))).toBe(true);
      expect(job.steps.some((s) => s.uses === "actions/upload-artifact@v4")).toBe(true);
    }
  });
});
