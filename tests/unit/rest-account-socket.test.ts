import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import { startFixture } from "./rest-mcp-socket-helper.js";

let f: Awaited<ReturnType<typeof startFixture>>;
beforeAll(async () => { f = await startFixture("rest"); });
afterAll(async () => { await f?.close(); });
beforeEach(() => {
  f.store.transact((draft: any) => { delete draft.team; });
  f.agent.saveAccounts([
    { platformUrl: "https://synthetic.invalid/a", platformUserName: "fixture-a", platformPassword: "synthetic-account-secret", profileIds: ["ab_fixture"], tags: ["fixture"] },
    { platformUrl: "https://synthetic.invalid/b", platformUserName: "fixture-b", platformPassword: "" },
  ]);
});
const match = (revision: string) => ({ "If-Match": `"${revision}"` });
async function snapshot() { const r = await f.api("/api/accounts"); expect(r.status).toBe(200); return r; }

describe("REST real account store, strong references and safe redaction", () => {
  it("lists an exact opaque ETag and never exposes stored passwords in summaries", async () => {
    const current = await snapshot();
    expect(current.headers.etag).toBe(`"${current.body.revision}"`); expect(current.headers["cache-control"]).toBe("no-store");
    expect(current.headers["access-control-expose-headers"]).toContain("ETag");
    expect(current.body.accounts[0]).toMatchObject({ index: 0, username: "fixture-a", hasPassword: true, ref: { index: 0, revision: current.body.revision } });
    expect(current.text).not.toContain("synthetic-account-secret"); expect(current.body.accounts[0]).not.toHaveProperty("password");
    expect(JSON.stringify(f.disk().accounts)).not.toContain("synthetic-account-secret");
    f.config.reloadConfig(); expect((await snapshot()).body.accounts[0].username).toBe("fixture-a");
  });
  it("requires strong exact If-Match for every index mutation/reveal and has no failed-request effects", async () => {
    const current = await snapshot(); const before = f.bytes();
    for (const [route, method, body] of [
      ["/api/accounts/0/password", "GET", undefined], ["/api/accounts/0", "PATCH", { username: "not-written" }], ["/api/accounts/0", "DELETE", undefined],
    ] as const) {
      const response = await f.api(route, { method, body });
      expect(response.status).toBe(428); expect(response.body.code).toBe("ACCOUNT_REFERENCE_REQUIRED"); expect(response.headers["cache-control"]).toBe("no-store");
      expect(f.bytes()).toEqual(before);
    }
    for (const value of ["*", current.body.revision, `W/"${current.body.revision}"`, `"${current.body.revision}", "${current.body.revision}"`, '"not-a-revision"']) {
      const response = await f.api("/api/accounts/0", { method: "PATCH", body: { username: "not-written" }, headers: { "If-Match": value } });
      expect(response.status).toBe(400); expect(response.body.code).toBe("ACCOUNT_REFERENCE_INVALID"); expect(f.bytes()).toEqual(before);
    }
  });
  it("returns 412 for a stale reference, never refreshes/retries onto a shifted account index", async () => {
    const old = await snapshot();
    await f.api("/api/accounts/0", { method: "DELETE", headers: match(old.body.revision) });
    const before = f.bytes();
    for (const [route, method, body] of [
      ["/api/accounts/0/password", "GET", undefined], ["/api/accounts/0", "PATCH", { password: "must-not-write" }], ["/api/accounts/0", "DELETE", undefined],
    ] as const) {
      const response = await f.api(route, { method, body, headers: match(old.body.revision) });
      expect(response.status).toBe(412); expect(response.body.code).toBe("ACCOUNT_REFERENCE_CONFLICT"); expect(f.bytes()).toEqual(before);
    }
    f.config.reloadConfig(); expect((await snapshot()).body.accounts.map((a: any) => a.username)).toEqual(["fixture-b"]);
  });
  it("distinguishes valid-reference missing targets and missing passwords from stale references", async () => {
    const current = await snapshot();
    const absent = await f.api("/api/accounts/99", { method: "DELETE", headers: match(current.body.revision) });
    expect(absent.status).toBe(404); expect(absent.body.code).toBe("ACCOUNT_NOT_FOUND");
    expect((await f.api("/api/accounts/1/password", { headers: match(current.body.revision) })).status).toBe(404);
    const revealed = await f.api("/api/accounts/0/password", { headers: match(current.body.revision) });
    expect(revealed.status).toBe(200); expect(revealed.body.password).toBe("synthetic-account-secret"); expect(revealed.headers["cache-control"]).toBe("no-store");
  });
  it("creates and patches through disk -> reload -> HTTP lookup, retaining trim/dedupe and secret encryption", async () => {
    expect((await f.api("/api/accounts", { body: { url: "", username: "" } })).status).toBe(400);
    const created = await f.api("/api/accounts", { body: {
      url: " https://synthetic.invalid/new ", username: " created-fixture ", password: "synthetic-new-secret",
      tags: [" fixture ", "fixture", 7, ""], profileIds: ["ab_new", "ab_new", "../escape", 7],
    } });
    expect(created.status).toBe(201); expect(created.text).not.toContain("synthetic-new-secret");
    expect(created.body.account).toMatchObject({ username: "created-fixture", tags: ["fixture"], profileIds: ["ab_new"] });
    expect(f.disk().accounts[2].platformUserName).toBe("created-fixture"); expect(JSON.stringify(f.disk().accounts)).not.toContain("synthetic-new-secret");
    f.config.reloadConfig(); const beforePatch = await snapshot();
    const updated = await f.api("/api/accounts/2", { method: "PATCH", headers: match(beforePatch.body.revision), body: {
      username: "changed-fixture", password: "changed-secret", tags: [" changed ", "changed"], profileIds: ["ab_changed"],
    } });
    expect(updated.status).toBe(200); expect(updated.body.account).toMatchObject({ username: "changed-fixture", tags: ["changed"], profileIds: ["ab_changed"] });
    expect(f.disk().accounts[2].platformUserName).toBe("changed-fixture"); expect(JSON.stringify(f.disk().accounts)).not.toContain("changed-secret");
    f.config.reloadConfig(); const afterPatch = await snapshot();
    expect(afterPatch.body.accounts[2].username).toBe("changed-fixture");
    expect((await f.api("/api/accounts/2/password", { headers: match(afterPatch.body.revision) })).body.password).toBe("changed-secret");
    await f.api("/api/accounts/2", { method: "DELETE", headers: match(afterPatch.body.revision) });
    expect(f.disk().accounts.length).toBe(2); f.config.reloadConfig(); expect((await snapshot()).body.accounts.length).toBe(2);
  });
  it.each([null, [], { unknown: "field" }, { tags: "not-tags" }, { tags: ["x".repeat(41)] }, { tags: ["badtag"] }, { username: 7 }, { profileIds: "not-array" }].map(body => [body]))("rejects malformed patch %j before any store mutation", async body => {
    const current = await snapshot(), before = f.bytes();
    const response = await f.api("/api/accounts/0", { method: "PATCH", headers: match(current.body.revision), body });
    expect(response.status).toBe(400); expect(response.body.code).toBe("ACCOUNT_VALIDATION_FAILED"); expect(f.bytes()).toEqual(before);
  });
  it("bulk import uses the actual parser/store; invalid lines and missing text never fabricate account writes", async () => {
    expect((await f.api("/api/accounts/bulk", { body: {} })).status).toBe(400);
    const result = await f.api("/api/accounts/bulk", { body: { text: "url,username,password,tags\nhttps://synthetic.invalid/bulk,bulk-fixture,bulk-secret,fixture\n" } });
    expect(result.status).toBe(200); expect(result.body.report.added).toBe(1);
    expect(f.disk().accounts.some((a: any) => a.platformUserName === "bulk-fixture")).toBe(true); expect(JSON.stringify(f.disk().accounts)).not.toContain("bulk-secret");
    f.config.reloadConfig(); expect((await snapshot()).body.accounts.some((a: any) => a.username === "bulk-fixture")).toBe(true);
  });
  it("viewer mutation/secret operations are denied before body/reference processing and leave disk unchanged", async () => {
    f.role("viewer"); const current = await snapshot(), before = f.bytes();
    for (const [route, method, body] of [
      ["/api/accounts", "POST", { url: "https://synthetic.invalid/denied", username: "denied" }],
      ["/api/accounts/bulk", "POST", { text: "https://synthetic.invalid,denied" }],
      ["/api/accounts/0", "PATCH", { username: "denied" }], ["/api/accounts/0", "DELETE", undefined], ["/api/accounts/0/password", "GET", undefined],
    ] as const) {
      const response = await f.api(route, { method, body, headers: match(current.body.revision) });
      expect(response.status).toBe(403); expect(response.body.error).toMatch(/member role/); expect(f.bytes()).toEqual(before);
    }
  });
  it("rechecks the actual team gate after a queued body; demotion cannot slip a pending write through", async () => {
    f.role("member"); const current = await snapshot();
    let observed!: () => void; const gateObserved = new Promise<void>(resolve => { observed = resolve; });
    const actualGate = f.team.requireAccountMutation;
    const spy = vi.spyOn(f.team, "requireAccountMutation").mockImplementation(() => { const value = actualGate(); observed(); return value; });
    const raw = JSON.stringify({ username: "never-written-after-demotion" });
    let end!: () => void;
    const pending = new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: f.restPort, path: "/api/accounts/0", method: "PATCH", agent: false,
        headers: { Authorization: `Bearer ${f.rest!.getRestApiToken()}`, ...match(current.body.revision), "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) },
      }, res => { let text = ""; res.on("data", c => { text += c; }); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) })); res.on("error", reject); });
      req.on("error", reject); req.setTimeout(1500, () => req.destroy(new Error("queued-body fixture timeout")));
      req.write(raw.slice(0, 1)); end = () => req.end(raw.slice(1));
    });
    try {
      await gateObserved; f.role("viewer"); const before = f.bytes(); end();
      const response = await pending; expect(response.status).toBe(403); expect(f.bytes()).toEqual(before);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });
});
