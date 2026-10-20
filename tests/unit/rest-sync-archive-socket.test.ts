// Actual HTTP routing + shipped receipt classifiers. Cloud/archive IO is a
// controlled boundary: these assertions prove no lost facts, not cloud commits.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { h, startFixture } from "./rest-mcp-socket-helper.js";

let f: Awaited<ReturnType<typeof startFixture>>;
const dirId = "ab_task48_archive";
const token = { targetId: "a".repeat(64), localHash: "b".repeat(64), remoteHash: "c".repeat(64) };
beforeAll(async () => { f = await startFixture("rest"); });
afterAll(async () => { await f?.close(); });
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, mock] of Object.entries({ push: h.sync.push, pull: h.sync.pull, ...h.archive })) {
    mock.mockReset().mockImplementation(() => { h.prohibited.push(name); throw new Error(`Unconfigured external boundary: ${name}`); });
  }
  f.store.transact((draft: any) => { delete draft.team; draft.browserProfiles = { [dirId]: { name: "Synthetic archive target", engine: "chromium", proxyMode: "none" } }; });
});

const receipt = (values: any = {}) => ({ success: false, message: "Synthetic publication fact", outcome: "failed", localCommit: "none", remoteCommit: "none",
  operationId: "synthetic-operation", warnings: ["synthetic-warning"], items: [{ id: dirId, scope: "profile", state: "failed", code: "SYNTHETIC_REFUSAL" }], ...values });
async function post(route: string, body: any = {}) { return f.api(route, { method: "POST", body }); }

describe("REST malformed sync/archive bodies are not approval to perform defaults", () => {
  it("null/array/scalar JSON cannot start default sync or export operations", async () => {
    h.sync.push.mockResolvedValue(receipt({ success: true })); h.sync.pull.mockResolvedValue(receipt({ success: true }));
    h.archive.exportProfileArchive.mockResolvedValue({ filePath: f.dir + "/not-exported.zip", entries: 0, bytes: 0 });
    const before = f.bytes();
    for (const body of [null, [], false, 7, "not-options"]) {
      for (const route of ["/api/sync/push", "/api/sync/pull", `/api/profiles/${dirId}/export`]) expect((await post(route, body)).status).toBe(400);
    }
    expect(h.sync.push).not.toHaveBeenCalled(); expect(h.sync.pull).not.toHaveBeenCalled(); expect(h.archive.exportProfileArchive).not.toHaveBeenCalled(); expect(f.bytes()).toEqual(before);
  });
  it.each(["push", "pull"])("invalid JSON never starts a sync %s", async action => {
    h.sync[action].mockResolvedValueOnce(receipt({ success: true, outcome: "completed" }));
    const before = f.bytes(); const response = await f.api(`/api/sync/${action}`, { raw: "{" });
    expect(response.status).toBe(400); expect(h.sync[action]).not.toHaveBeenCalled(); expect(f.bytes()).toEqual(before);
  });
  it("invalid JSON never falls back to a default single-archive export", async () => {
    h.archive.exportProfileArchive.mockResolvedValueOnce({ filePath: f.dir + "/never-exported.zip", entries: 0, bytes: 0 });
    const before = f.bytes(); const response = await f.api(`/api/profiles/${dirId}/export`, { raw: "{" });
    expect(response.status).toBe(400); expect(h.archive.exportProfileArchive).not.toHaveBeenCalled(); expect(f.bytes()).toEqual(before);
  });
});

describe("REST sync receipts retain operation, per-item, warnings and commit/recovery facts", () => {
  it.each([
    [receipt({ success: true, outcome: "completed", remoteCommit: "committed" }), 200],
    [receipt({ code: "TEAM_ROLE_DENIED" }), 403], [receipt({ code: "SYNC_BUSY" }), 409], [receipt({ code: "SYNC_PREVIEW_STALE" }), 409],
    [receipt({ outcome: "partial", localCommit: "partial" }), 409], [receipt({ outcome: "unknown", remoteCommit: "unknown" }), 409],
    [receipt({ outcome: "recovery-required", recovery: [{ resource: "profiles", id: dirId, paths: ["synthetic-tail"], receiptPath: "synthetic-recovery-receipt" }] }), 409],
    [receipt({ code: "SYNC_INVALID_INPUT" }), 400],
  ])("preserves push facts %j with HTTP %i", async (facts, status) => {
    h.sync.push.mockResolvedValueOnce(facts);
    const response = await post("/api/sync/push", { force: true, comparisonToken: token });
    expect(response.status).toBe(status); expect(response.body).toEqual(facts);
    expect(h.sync.push).toHaveBeenCalledTimes(1); expect(h.sync.push).toHaveBeenCalledWith(undefined, true, token);
  });
  it("pull passes opaque comparison token and allowed decisions; exceptional receipts survive without synthetic success", async () => {
    const facts = receipt({ outcome: "partial", localCommit: "committed", code: "RESTORE_PARTIAL" });
    h.sync.pull.mockResolvedValueOnce(facts);
    const response = await post("/api/sync/pull", { strategy: "remote", resolutions: { ["profiles:" + dirId]: "local", invalid: "ignored" }, comparisonToken: token });
    expect(response.status).toBe(409); expect(response.body).toEqual({ ...facts, strategy: "remote" });
    expect(h.sync.pull).toHaveBeenCalledWith(undefined, { strategy: "remote", resolutions: { ["profiles:" + dirId]: "local" }, comparisonToken: token });
    h.sync.pull.mockRejectedValueOnce(Object.assign(new Error("synthetic restore interruption"), { syncResult: facts }));
    const interrupted = await post("/api/sync/pull", { strategy: "newest" });
    expect(interrupted.status).toBe(409); expect(interrupted.body).toEqual(facts);
    h.sync.push.mockRejectedValueOnce(Object.assign(new Error("synthetic publish interruption"), { syncResult: facts }));
    expect((await post("/api/sync/push")).body).toEqual(facts);
  });
  it("keeps non-publication failures as failures, and exposes read-only status/preview without mutation", async () => {
    h.sync.getStatus.mockReturnValueOnce({ operation: { last: receipt({ outcome: "unknown" }) } });
    expect((await f.api("/api/sync/status")).body.operation.last.outcome).toBe("unknown");
    expect((await f.api("/api/sync/preview")).status).toBe(200);
    h.sync.previewDiff.mockResolvedValueOnce({ ok: true, comparisonToken: token }); expect((await f.api("/api/sync/preview-diff")).body.comparisonToken).toEqual(token);
    h.sync.previewDiff.mockResolvedValueOnce({ ok: false, error: "no remote source" }); expect((await f.api("/api/sync/preview-diff")).status).toBe(400);
    for (const action of ["push", "pull"] as const) {
      h.sync[action].mockRejectedValueOnce(new Error("synthetic IO unavailable"));
      const failed = await post(`/api/sync/${action}`); expect(failed.status).toBe(500); expect(failed.body.success).toBe(false);
    }
  });
});

describe("REST archive item/outcome facts and overwrite boundaries", () => {
  it("retains successful import/export warnings and exact overwrite confirmation", async () => {
    const imported = { dirId, name: "Imported fixture", files: 2, bytes: 30, warnings: ["post-commit warning"] };
    h.archive.importProfileArchive.mockReturnValueOnce(imported);
    expect((await post("/api/profiles/import", { zipPath: f.dir + "/synthetic.zip" })).body).toEqual({ success: true, outcome: "completed", ...imported });
    const exported = { filePath: f.dir + "/synthetic-export.zip", entries: 2, bytes: 30, warnings: ["destination committed, cleanup warning"] };
    h.archive.exportProfileArchive.mockResolvedValueOnce(exported);
    expect((await post(`/api/profiles/${dirId}/export`, { destPath: exported.filePath, overwrite: true })).body).toEqual({ success: true, outcome: "completed", ...exported });
    expect(h.archive.exportProfileArchive).toHaveBeenCalledWith(dirId, exported.filePath, { overwrite: true });
    h.archive.exportProfileArchive.mockResolvedValueOnce(exported); await post(`/api/profiles/${dirId}/export`);
    expect(h.archive.exportProfileArchive.mock.calls[1][2]).toEqual({ overwrite: false });
  });
  it.each(["ARCHIVE_DESTINATION_EXISTS", "ARCHIVE_DESTINATION_CHANGED"])("maps %s to a conflict without retry", async code => {
    h.archive.exportProfileArchive.mockRejectedValueOnce(Object.assign(new Error("Synthetic explicit reconfirmation required"), { code }));
    const failed = await post(`/api/profiles/${dirId}/export`, { destPath: f.dir + "/existing.zip" });
    expect(failed.status).toBe(409); expect(failed.body).toMatchObject({ success: false, outcome: "failed", code }); expect(h.archive.exportProfileArchive).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ exported: [{ dirId, filePath: "synthetic.zip", warnings: ["committed warning"] }], skipped: [], failed: [] }, "completed", true],
    [{ exported: [{ dirId, filePath: "synthetic.zip" }], skipped: [{ dirId: "ab_running", reason: "running" }], failed: [{ dirId: "ab_failed", error: "synthetic", code: "ARCHIVE_RECOVERY_REQUIRED" }] }, "partial", false],
    [{ exported: [], skipped: [{ dirId, reason: "running" }], failed: [] }, "skipped", false],
    [{ exported: [], skipped: [], failed: [{ dirId, error: "synthetic", code: "ARCHIVE_RECOVERY_REQUIRED" }] }, "failed", false],
  ])("does not turn batch export %s into unconditional success", async (report, outcome, success) => {
    h.archive.exportProfileArchives.mockResolvedValueOnce(report);
    const response = await post("/api/profiles/export", { dirIds: [dirId], destDir: f.dir });
    expect(response.status).toBe(200); expect(response.body).toEqual({ success, outcome, destDir: f.dir, report });
  });
  it("retains partial batch import reports and rejects mixed/empty batch items without filtering or effects", async () => {
    const report = { imported: [{ dirId, zipPath: "one.zip", warnings: ["warning"] }], failed: [{ zipPath: "two.zip", error: "synthetic", code: "ARCHIVE_RECOVERY_REQUIRED" }] };
    h.archive.importProfileArchives.mockReturnValueOnce(report);
    const imported = await post("/api/profiles/import-batch", { zipPaths: [f.dir + "/one.zip", f.dir + "/two.zip"] });
    expect(imported.body).toEqual({ success: false, outcome: "partial", report });
    h.archive.importProfileArchives.mockClear();
    for (const zipPaths of [[], ["one.zip", null], [" "]]) {
      const bad = await post("/api/profiles/import-batch", { zipPaths }); expect(bad.status).toBe(400); expect(bad.body.code).toBe("ARCHIVE_INVALID_INPUT");
    }
    expect(h.archive.importProfileArchives).not.toHaveBeenCalled();
    for (const body of [{ dirIds: [] }, { dirIds: [dirId, null] }, { dirIds: [dirId], overwrite: "true" }]) {
      expect((await post("/api/profiles/export", body)).status).toBe(400);
    }
    expect(h.archive.exportProfileArchives).not.toHaveBeenCalled();
    expect((await post(`/api/profiles/${dirId}/export`, { overwrite: "true" })).status).toBe(400);
    expect((await post("/api/profiles/import", {})).status).toBe(400);
  });
  it("preserves archive path/recovery failures and viewer import denial before IO", async () => {
    h.paths.assertSafeArchiveImportPath.mockImplementationOnce(() => { throw new Error("unsafe synthetic archive path"); });
    expect((await post("/api/profiles/import", { zipPath: "synthetic" })).status).toBe(400); expect(h.archive.importProfileArchive).not.toHaveBeenCalled();
    h.archive.importProfileArchive.mockImplementationOnce(() => { throw Object.assign(new Error("synthetic recovery required"), { code: "ARCHIVE_RECOVERY_REQUIRED" }); });
    expect((await post("/api/profiles/import", { zipPath: f.dir + "/synthetic.zip" })).body.code).toBe("ARCHIVE_RECOVERY_REQUIRED");
    f.role("viewer"); const before = f.bytes();
    expect((await post("/api/profiles/import", { zipPath: f.dir + "/synthetic.zip" })).status).toBe(403);
    expect((await post("/api/profiles/import-batch", { zipPaths: [f.dir + "/synthetic.zip"] })).status).toBe(403); expect(f.bytes()).toEqual(before);
  });
});
