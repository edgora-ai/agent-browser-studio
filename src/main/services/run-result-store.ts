// Run result store (M2) — durable, run-scoped artifact storage under
// <userData>/agent-results/<runId>/. The config.json only carries bounded
// AgentRunArtifactRef metadata; this store owns the actual payload bytes.
//
// Write protocol (per payload file):
//   serialize in memory → open tmp (O_EXCL, 0600) → write → fsync → rename
//   → fsync the directory → re-open and verify (lstat rejects symlinks,
//   size + SHA-256 must match, dataset payloads are re-parsed and checked
//   against the claimed runId/columns/rows).
// manifest.json is written LAST with the same protocol and is the only
// public "this run result is complete" marker: readers trust a run
// directory only when its manifest validates AND every referenced payload
// verifies. A crash between payload and manifest leaves an anonymous
// directory that reconcile sweeps; a config write that fails after a
// manifest commit is replayed from the manifest on next startup.
//
// Quotas: per-run / global byte caps and dataset shape caps. The store never
// evicts old results to make room — when space runs out the commit fails
// honestly (or truncates at a row boundary, marking the artifact partial).
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentRunArtifactRef, AgentRunVerification } from "../types.js";
import type { DatasetSnapshot } from "./run-verifiers.js";

export interface RunResultCaps {
  maxRunBytes: number;        // per-run payload budget
  maxGlobalBytes: number;     // whole-store budget
  maxArtifactsPerRun: number;
  maxManifestBytes: number;
  maxDatasetRows: number;
  maxDatasetColumns: number;
  maxCellBytes: number;
  previewPageLimit: number;
}

export const DEFAULT_RUN_RESULT_CAPS: RunResultCaps = {
  maxRunBytes: 8 * 1024 * 1024,
  maxGlobalBytes: 512 * 1024 * 1024,
  maxArtifactsPerRun: 16,
  maxManifestBytes: 256 * 1024,
  maxDatasetRows: 1000,
  maxDatasetColumns: 64,
  maxCellBytes: 64 * 1024,
  previewPageLimit: 100,
};

const RUN_ID_RE = /^run_[a-zA-Z0-9_-]{1,80}$/;
const ARTIFACT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const MANIFEST_NAME = "manifest.json";
const ARTIFACTS_DIR = "artifacts";
const TMP_PREFIX = ".tmp-";

export interface RunTerminalState {
  status: "done" | "error";
  endReason: string;
  finishedAt: number;
  error?: string;
}

export interface CommitArgs {
  runId: string;
  runStartedAt: number;
  templateId: string;
  templateVersion: number;
  verification: AgentRunVerification;
  terminal: RunTerminalState;
  dataset?: DatasetSnapshot;
}

export type CommitResult =
  | { ok: true; artifacts: AgentRunArtifactRef[]; reused: boolean; verification: AgentRunVerification }
  | { ok: false; reasonCode: "artifact_limit" | "integrity_conflict" | "artifact_invalid" | "write_failed"; detail: string };

/**
 * R0925-03: the verdict persisted in the manifest is decided HERE, where the
 * actual truncation outcome is known — never upstream from pre-commit hopes.
 * A truncated snapshot is partial evidence, so any automated verdict is
 * honestly downgraded to manual_review before it touches disk.
 */
function effectiveVerification(v: AgentRunVerification, truncated: boolean, now: number): AgentRunVerification {
  if (!truncated || v.status === "manual_review") return v;
  return {
    status: "manual_review",
    checkedAt: now,
    reasonCode: "artifact_limit",
    ...(v.status !== "unverified"
      ? { verifierId: v.verifierId, verifierVersion: v.verifierVersion }
      : {}),
    issues: [{ code: "artifact_limit", detail: "snapshot truncated to fit the result budget" }],
  };
}

export interface DatasetEnvelope {
  schemaVersion: 1;
  kind: "dataset";
  runId: string;
  artifactId: string;
  name: string;
  columns: string[];
  /** Row-major: each row aligns with columns. */
  rows: string[][];
  sourceRowCount: number;
  rejectedRowCount: number;
  truncated: boolean;
  truncationReason?: string;
}

export interface RunResultManifest {
  schemaVersion: 1;
  runId: string;
  runStartedAt: number;
  templateId: string;
  templateVersion: number;
  verification: AgentRunVerification;
  terminal: RunTerminalState;
  artifacts: AgentRunArtifactRef[];
  createdAt: number;
}

export type ReadResult<T> = { ok: true; value: T } | { ok: false; reasonCode: string; detail: string };

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function fail<T>(reasonCode: string, detail: string): ReadResult<T> {
  return { ok: false, reasonCode, detail };
}

export class RunResultStore {
  private readonly rootProvider: () => string;
  readonly caps: RunResultCaps;
  private readonly now: () => number;

  constructor(deps: { rootProvider: () => string; caps?: Partial<RunResultCaps>; now?: () => number }) {
    this.rootProvider = deps.rootProvider;
    this.caps = { ...DEFAULT_RUN_RESULT_CAPS, ...(deps.caps || {}) };
    this.now = deps.now || (() => Date.now());
  }

  rootDir(): string {
    return path.join(this.rootProvider(), "agent-results");
  }

  private runDir(runId: string): string {
    if (!RUN_ID_RE.test(runId)) throw new Error(`invalid run id: ${runId}`);
    return path.join(this.rootDir(), runId);
  }

  // ── Low-level atomic write + verify ──

  /** Atomic write: unique O_EXCL tmp in the SAME directory, 0600, fsync,
   *  rename, directory fsync. Tmp is always cleaned up. */
  private atomicWrite(targetPath: string, data: Buffer): void {
    const dir = path.dirname(targetPath);
    const tmp = path.join(dir, `${TMP_PREFIX}${process.pid}-${randomUUID()}`);
    let fd: number | null = null;
    try {
      fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, targetPath);
      let dfd: number | null = null;
      try {
        dfd = fs.openSync(dir, fs.constants.O_RDONLY);
        fs.fsyncSync(dfd);
      } finally {
        if (dfd !== null) try { fs.closeSync(dfd); } catch { /* best effort */ }
      }
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* best effort */ }
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  }

  /** Re-open a written file and verify kind/size/hash. Rejects symlinks. */
  private verifyFile(filePath: string, expectedBytes: number, expectedSha256: string): boolean {
    try {
      const st = fs.lstatSync(filePath);
      if (st.isSymbolicLink() || !st.isFile()) return false;
      if (st.size !== expectedBytes) return false;
      const data = fs.readFileSync(filePath);
      return sha256Hex(data) === expectedSha256;
    } catch {
      return false;
    }
  }

  /** Resolve a path inside a run directory, refusing symlink escapes. */
  private resolveInsideRun(runId: string, ...segments: string[]): string | null {
    let runDirReal: string;
    try {
      runDirReal = fs.realpathSync(this.runDir(runId));
    } catch {
      return null;
    }
    const rootReal = fs.realpathSync(this.rootDir());
    if (!runDirReal.startsWith(rootReal + path.sep)) return null;
    const target = path.join(runDirReal, ...segments);
    const resolved = path.resolve(target);
    if (resolved !== runDirReal && !resolved.startsWith(runDirReal + path.sep)) return null;
    // Every existing ancestor must not be a symlink (paranoia: realpath above
    // already collapses them; lstat the leaf when it exists).
    try {
      const st = fs.lstatSync(resolved);
      if (st.isSymbolicLink()) return null;
    } catch { /* leaf may not exist yet */ }
    return resolved;
  }

  private dirBytes(dir: string): number {
    let total = 0;
    const walk = (d: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) {
          try { total += fs.lstatSync(p).size; } catch { /* ignore */ }
        }
      }
    };
    walk(dir);
    return total;
  }

  private totalStoreBytes(): number {
    const root = this.rootDir();
    if (!fs.existsSync(root)) return 0;
    return this.dirBytes(root);
  }

  // ── Dataset serialization ──

  private serializeDataset(runId: string, artifactId: string, snapshot: DatasetSnapshot, rowLimit: number):
    | { payload: Buffer; rowCount: number; truncated: boolean; truncationReason?: string }
    | { error: string; code: "artifact_invalid" | "artifact_limit" } {
    if (!Array.isArray(snapshot.columns) || snapshot.columns.length === 0) return { error: "dataset has no columns", code: "artifact_invalid" };
    if (snapshot.columns.length > this.caps.maxDatasetColumns) return { error: "dataset exceeds column cap", code: "artifact_invalid" };
    for (const c of snapshot.columns) {
      if (typeof c !== "string" || !c || c.length > 64) return { error: "dataset column name invalid", code: "artifact_invalid" };
    }
    if (!Array.isArray(snapshot.rows)) return { error: "dataset rows invalid", code: "artifact_invalid" };
    if (snapshot.rows.length > this.caps.maxDatasetRows) return { error: "dataset exceeds row cap", code: "artifact_invalid" };
    const taken = snapshot.rows.slice(0, Math.max(0, Math.min(rowLimit, snapshot.rows.length)));
    // Row-major conversion: each object row aligns to the declared columns.
    const rows: string[][] = [];
    for (const row of taken) {
      if (!row || typeof row !== "object" || Array.isArray(row)) return { error: "dataset row must be an object", code: "artifact_invalid" };
      const cells: string[] = [];
      for (const col of snapshot.columns) {
        const cell = (row as Record<string, unknown>)[col];
        if (cell === undefined || cell === null) { cells.push(""); continue; }
        if (typeof cell !== "string") return { error: "dataset cell must be a string", code: "artifact_invalid" };
        if (Buffer.byteLength(cell, "utf8") > this.caps.maxCellBytes) return { error: "dataset cell exceeds 64 KiB", code: "artifact_invalid" };
        cells.push(cell);
      }
      rows.push(cells);
    }
    const truncatedByRows = rows.length < snapshot.rows.length || snapshot.truncated;
    const envelope: DatasetEnvelope = {
      schemaVersion: 1,
      kind: "dataset",
      runId,
      artifactId,
      name: "dataset",
      columns: snapshot.columns,
      rows,
      sourceRowCount: snapshot.sourceRowCount,
      rejectedRowCount: snapshot.rejectedRowCount,
      truncated: truncatedByRows,
      ...(truncatedByRows ? { truncationReason: snapshot.truncationReason || (rows.length < snapshot.rows.length ? "row_quota" : undefined) } : {}),
    };
    return {
      payload: Buffer.from(JSON.stringify(envelope), "utf8"),
      rowCount: rows.length,
      truncated: truncatedByRows,
      truncationReason: envelope.truncationReason,
    };
  }

  /** Find how many leading rows fit the byte budget (row-boundary truncation). */
  private fitDatasetRows(runId: string, artifactId: string, snapshot: DatasetSnapshot, budget: number):
    | { payload: Buffer; rowCount: number; truncated: boolean; truncationReason?: string }
    | { error: string; code: "artifact_invalid" | "artifact_limit" } {
    const full = this.serializeDataset(runId, artifactId, snapshot, snapshot.rows.length);
    if ("error" in full) return full;
    if (full.payload.length <= budget) return full;
    // Binary search the largest row prefix that fits.
    let lo = 0;
    let hi = snapshot.rows.length - 1;
    let best: typeof full | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const attempt = this.serializeDataset(runId, artifactId, { ...snapshot, truncated: true, truncationReason: snapshot.truncationReason || "run_quota" }, mid);
      if ("error" in attempt) return attempt;
      if (attempt.payload.length <= budget) {
        best = attempt;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) return best;
    const empty = this.serializeDataset(runId, artifactId, { ...snapshot, truncated: true, truncationReason: "run_quota" }, 0);
    if ("error" in empty) return empty;
    if (empty.payload.length > budget) return { error: "dataset does not fit the per-run byte budget", code: "artifact_limit" };
    return empty;
  }

  // ── Commit ──

  commitRunResult(args: CommitArgs): CommitResult {
    if (!RUN_ID_RE.test(args.runId)) return { ok: false, reasonCode: "artifact_invalid", detail: "invalid run id" };
    if (!args.dataset) {
      // Nothing to materialize (e.g. manual_review without a snapshot).
      return { ok: true, artifacts: [], reused: false, verification: args.verification };
    }

    const runDir = this.runDir(args.runId);
    const manifestPath = path.join(runDir, MANIFEST_NAME);

    // Idempotency: a valid manifest for the same run + template version whose
    // artifacts match what we would write → reuse, never rewrite.
    const existing = this.readManifest(args.runId);
    if (existing.ok) {
      const m = existing.value;
      const sameIdentity = m.runId === args.runId && m.templateId === args.templateId && m.templateVersion === args.templateVersion;
      if (!sameIdentity) {
        return { ok: false, reasonCode: "integrity_conflict", detail: "existing manifest belongs to a different template/version" };
      }
      if (args.dataset) {
        const expected = this.fitDatasetRows(args.runId, "dataset", args.dataset, this.caps.maxRunBytes);
        if ("error" in expected) return { ok: false, reasonCode: expected.code, detail: expected.error };
        const ref = m.artifacts.find((a) => a.id === "dataset");
        if (!ref || ref.sha256 !== sha256Hex(expected.payload)) {
          return { ok: false, reasonCode: "integrity_conflict", detail: "existing manifest payload hash differs; refusing to overwrite" };
        }
      }
      return { ok: true, artifacts: m.artifacts, reused: true, verification: m.verification };
    }
    if (existing.reasonCode !== "not_found") {
      // A corrupt/unverifiable manifest is an integrity conflict — never
      // overwrite it silently.
      return { ok: false, reasonCode: "integrity_conflict", detail: `existing manifest unreadable: ${existing.detail}` };
    }

    // Quotas (global first, then per-run budget for this commit).
    const globalBytes = this.totalStoreBytes();
    if (globalBytes >= this.caps.maxGlobalBytes) {
      return { ok: false, reasonCode: "artifact_limit", detail: `global result store budget exhausted (${this.caps.maxGlobalBytes} bytes)` };
    }
    const artifactsDir = path.join(runDir, ARTIFACTS_DIR);
    const staleRunBytes = fs.existsSync(runDir) ? this.dirBytes(runDir) : 0;
    const runBudget = Math.max(0, Math.min(this.caps.maxRunBytes - staleRunBytes, this.caps.maxGlobalBytes - globalBytes));

    const dataset = this.fitDatasetRows(args.runId, "dataset", args.dataset, runBudget);
    if ("error" in dataset) {
      return { ok: false, reasonCode: dataset.code, detail: dataset.error };
    }

    const datasetSha = sha256Hex(dataset.payload);
    const datasetPath = path.join(artifactsDir, "dataset.json");

    try {
      fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(runDir, 0o700); } catch { /* best effort */ }
      try { fs.chmodSync(artifactsDir, 0o700); } catch { /* best effort */ }

      // A leftover payload from a crashed commit (no manifest): reuse when
      // identical, otherwise remove and rewrite — nothing references it yet.
      if (fs.existsSync(datasetPath)) {
        if (!this.verifyFile(datasetPath, dataset.payload.length, datasetSha)) {
          fs.rmSync(datasetPath, { force: true });
          this.atomicWrite(datasetPath, dataset.payload);
        }
      } else {
        this.atomicWrite(datasetPath, dataset.payload);
      }
      if (!this.verifyFile(datasetPath, dataset.payload.length, datasetSha)) {
        return { ok: false, reasonCode: "write_failed", detail: "dataset payload failed post-write verification" };
      }
      // Re-parse the persisted bytes and check the self-describing envelope.
      try {
        const parsed = JSON.parse(fs.readFileSync(datasetPath, "utf8")) as DatasetEnvelope;
        if (parsed.schemaVersion !== 1 || parsed.kind !== "dataset" || parsed.runId !== args.runId) {
          return { ok: false, reasonCode: "write_failed", detail: "dataset envelope mismatch after write" };
        }
        if (parsed.rows.length !== dataset.rowCount || parsed.columns.length !== args.dataset.columns.length) {
          return { ok: false, reasonCode: "write_failed", detail: "dataset shape mismatch after write" };
        }
      } catch {
        return { ok: false, reasonCode: "write_failed", detail: "dataset payload is unparseable after write" };
      }
    } catch (e: any) {
      return { ok: false, reasonCode: e?.code === "ENOSPC" ? "artifact_limit" : "write_failed", detail: String(e?.message || e).slice(0, 300) };
    }

    const createdAt = this.now();
    const verification = effectiveVerification(args.verification, dataset.truncated, createdAt);
    const artifact: AgentRunArtifactRef = {
      id: "dataset",
      kind: "dataset",
      name: "dataset.json",
      mediaType: "application/json",
      createdAt,
      bytes: dataset.payload.length,
      sha256: datasetSha,
      completeness: dataset.truncated ? "partial" : "complete",
      truncated: dataset.truncated,
      ...(dataset.truncationReason ? { truncationReason: dataset.truncationReason } : {}),
      rowCount: dataset.rowCount,
      sourceRowCount: args.dataset.sourceRowCount,
      rejectedRowCount: args.dataset.rejectedRowCount,
      columns: args.dataset.columns,
      exportPolicy: "csv",
    };

    const manifest: RunResultManifest = {
      schemaVersion: 1,
      runId: args.runId,
      runStartedAt: args.runStartedAt,
      templateId: args.templateId,
      templateVersion: args.templateVersion,
      verification,
      terminal: args.terminal,
      artifacts: [artifact],
      createdAt,
    };
    const manifestPayload = Buffer.from(JSON.stringify(manifest), "utf8");
    if (manifestPayload.length > this.caps.maxManifestBytes) {
      return { ok: false, reasonCode: "artifact_limit", detail: "manifest exceeds 256 KiB" };
    }
    const manifestSha = sha256Hex(manifestPayload);
    try {
      this.atomicWrite(manifestPath, manifestPayload);
      if (!this.verifyFile(manifestPath, manifestPayload.length, manifestSha)) {
        return { ok: false, reasonCode: "write_failed", detail: "manifest failed post-write verification" };
      }
      // Manifest is the commit point: re-read it and validate references.
      const reread = this.readManifest(args.runId);
      if (!reread.ok) return { ok: false, reasonCode: "write_failed", detail: `manifest re-read failed: ${reread.detail}` };
      if (reread.value.artifacts.length !== 1 || reread.value.artifacts[0].sha256 !== datasetSha) {
        return { ok: false, reasonCode: "write_failed", detail: "manifest references do not match the committed payload" };
      }
    } catch (e: any) {
      return { ok: false, reasonCode: e?.code === "ENOSPC" ? "artifact_limit" : "write_failed", detail: String(e?.message || e).slice(0, 300) };
    }
    return { ok: true, artifacts: [artifact], reused: false, verification };
  }

  // ── Read path ──

  /** Parse + fully verify a run's manifest and every referenced payload. */
  readManifest(runId: string): ReadResult<RunResultManifest> {
    let manifestPath: string | null;
    try {
      manifestPath = this.resolveInsideRun(runId, MANIFEST_NAME);
    } catch {
      return fail("invalid_run", "invalid run id");
    }
    if (!manifestPath || !fs.existsSync(manifestPath)) return fail("not_found", "no manifest");
    let manifest: RunResultManifest;
    try {
      const st = fs.lstatSync(manifestPath);
      if (st.size > this.caps.maxManifestBytes) return fail("integrity_error", "manifest exceeds size cap");
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as RunResultManifest;
    } catch (e: any) {
      return fail("integrity_error", `manifest unreadable: ${String(e?.message || e).slice(0, 200)}`);
    }
    if (manifest.schemaVersion !== 1 || manifest.runId !== runId || !Array.isArray(manifest.artifacts)) {
      return fail("integrity_error", "manifest shape mismatch");
    }
    if (manifest.artifacts.length > this.caps.maxArtifactsPerRun) return fail("integrity_error", "too many artifacts");
    for (const ref of manifest.artifacts) {
      if (!ARTIFACT_ID_RE.test(ref.id)) return fail("integrity_error", `invalid artifact id ${ref.id}`);
      const filePath = this.resolveInsideRun(runId, ARTIFACTS_DIR, ref.name);
      if (!filePath || path.basename(filePath) !== ref.name) return fail("integrity_error", `artifact path escape for ${ref.id}`);
      if (!this.verifyFile(filePath, ref.bytes, ref.sha256)) {
        return fail("integrity_error", `artifact ${ref.id} failed size/hash verification`);
      }
    }
    return { ok: true, value: manifest };
  }

  listRunArtifacts(runId: string): ReadResult<AgentRunArtifactRef[]> {
    const m = this.readManifest(runId);
    if (!m.ok) return m as ReadResult<AgentRunArtifactRef[]>;
    return { ok: true, value: m.value.artifacts };
  }

  /** Read + verify a dataset payload. Hash is re-checked before parsing. */
  readDataset(runId: string, artifactId: string): ReadResult<DatasetEnvelope> {
    const m = this.readManifest(runId);
    if (!m.ok) return m as ReadResult<DatasetEnvelope>;
    const ref = m.value.artifacts.find((a) => a.id === artifactId && a.kind === "dataset");
    if (!ref) return fail("not_found", `no dataset artifact ${artifactId}`);
    const filePath = this.resolveInsideRun(runId, ARTIFACTS_DIR, ref.name);
    if (!filePath) return fail("integrity_error", "dataset path escape");
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as DatasetEnvelope;
      if (parsed.schemaVersion !== 1 || parsed.kind !== "dataset" || parsed.runId !== runId) {
        return fail("integrity_error", "dataset envelope mismatch");
      }
      return { ok: true, value: parsed };
    } catch (e: any) {
      return fail("integrity_error", `dataset unreadable: ${String(e?.message || e).slice(0, 200)}`);
    }
  }

  /** Read a `kind: "file"` artifact's bytes, re-verifying size + SHA-256
   *  against the manifest reference first. A payload that changed on disk
   *  since the commit is refused, never exported. */
  readArtifactFile(runId: string, artifactId: string): ReadResult<Buffer> {
    const m = this.readManifest(runId);
    if (!m.ok) return m as ReadResult<Buffer>;
    const ref = m.value.artifacts.find((a) => a.id === artifactId);
    if (!ref) return fail("not_found", `no artifact ${artifactId}`);
    if (ref.kind !== "file") return fail("artifact_invalid", `${artifactId} is not a file artifact`);
    const filePath = this.resolveInsideRun(runId, ARTIFACTS_DIR, ref.name);
    if (!filePath) return fail("integrity_error", "artifact path escape");
    if (!this.verifyFile(filePath, ref.bytes, ref.sha256)) {
      return fail("integrity_error", `artifact ${artifactId} failed size/hash verification`);
    }
    try {
      return { ok: true, value: fs.readFileSync(filePath) };
    } catch (e: any) {
      return fail("integrity_error", `artifact unreadable: ${String(e?.message || e).slice(0, 200)}`);
    }
  }

  readDatasetPreview(runId: string, artifactId: string, offset: number, limit: number): ReadResult<{ columns: string[]; rows: string[][]; total: number; truncated: boolean; sourceRowCount: number; rejectedRowCount: number }> {
    const d = this.readDataset(runId, artifactId);
    if (!d.ok) return d as ReadResult<never>;
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit) || 1), this.caps.previewPageLimit);
    return {
      ok: true,
      value: {
        columns: d.value.columns,
        rows: d.value.rows.slice(safeOffset, safeOffset + safeLimit),
        total: d.value.rows.length,
        truncated: d.value.truncated,
        sourceRowCount: d.value.sourceRowCount,
        rejectedRowCount: d.value.rejectedRowCount,
      },
    };
  }

  // ── Deletion / reconcile support ──

  /** Remove a run's whole result directory. Config state must already have
   *  been committed without the references (config-first). */
  deleteRunResults(runId: string): { ok: boolean; error?: string } {
    let dir: string;
    try {
      dir = this.runDir(runId);
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  /** Run ids with a directory in the store (valid + invalid names alike are
   *  filtered to the run id shape). */
  listStoredRunIds(): string[] {
    const root = this.rootDir();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name)).map((e) => e.name);
  }

  /** Remove stray tmp files left by crashed commits. Returns files removed. */
  sweepTempFiles(): number {
    let removed = 0;
    for (const runId of this.listStoredRunIds()) {
      const artifactsDir = path.join(this.rootDir(), runId, ARTIFACTS_DIR);
      for (const dir of [path.join(this.rootDir(), runId), artifactsDir]) {
        let names: string[] = [];
        try {
          names = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.startsWith(TMP_PREFIX)) continue;
          try {
            fs.rmSync(path.join(dir, name), { force: true });
            removed++;
          } catch { /* ignore */ }
        }
      }
    }
    return removed;
  }

  /** Directory exists but has no manifest (crashed/abandoned commit). */
  hasManifest(runId: string): boolean {
    try {
      return fs.existsSync(path.join(this.runDir(runId), MANIFEST_NAME));
    } catch {
      return false;
    }
  }
}

import { getAppDataDir } from "./config-manager.js";

/** Production singleton — root resolved lazily (app.setName timing). */
export const runResultStore = new RunResultStore({ rootProvider: () => getAppDataDir() });
