// J82: REST write endpoints for automation rules, the extension repository,
// and skills (Slice 59 — closes the "REST 其余模块写端点" follow-up).
// POST/PATCH/DELETE over the loopback API with team RBAC (viewer → 403) and
// audit entries for every write. The extension-repository local-install path
// is exercised with a real fixture directory so the test needs no network.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as http from "node:http";
import { setupTestApp, closeApp, TestAppHandle, userDataConfigPath } from "./helpers/app.js";
import { filterKnownConsoleErrors } from "./helpers/diag.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j82");
const LOCAL_EXT_DIR = path.join(USERDATA, "..", "j82-local-extension");

function apiRequest(
  port: number, token: string, method: string, p: string, body?: any, auth = true,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) headers.authorization = `Bearer ${token}`;
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const req = http.request(
      { hostname: "127.0.0.1", port, path: p, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: any = null;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function writeLocalExtensionFixture(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    name: "J82 Local Helper",
    version: "1.0.0",
    description: "Slice 59 local extension fixture",
  }, null, 2));
  fs.writeFileSync(path.join(dir, "background.js"), "console.log('j82 local extension');");
}

function setLocalRole(role: string): void {
  const cfg = JSON.parse(fs.readFileSync(userDataConfigPath(USERDATA), "utf8"));
  const deviceId = cfg.deviceId || "local";
  cfg.team = {
    name: "J82 Workspace",
    ownerDeviceId: deviceId,
    members: [{ deviceId, name: "Local", role, addedAt: Date.now() }],
    enabled: true,
    updatedAt: Date.now(),
  };
  fs.writeFileSync(userDataConfigPath(USERDATA), JSON.stringify(cfg, null, 2));
}

describe("J82 — REST write endpoints (automation / extension repo / skills)", () => {
  let h: TestAppHandle;
  let port = 0;
  let token = "";

  beforeAll(async () => {
    writeLocalExtensionFixture(LOCAL_EXT_DIR);
    h = await setupTestApp({
      userDataDir: USERDATA,
      env: { AGENT_BROWSER_API_PORT: "0" },
    });
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const st = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.status());
      if (st && st.running && st.port > 0) { port = st.port; break; }
      await h.page.waitForTimeout(300);
    }
    expect(port, "REST API server must be running").toBeGreaterThan(0);
    const tok = await h.page.evaluate(() => (window as any).agentBrowser.api.apiRpc.revealToken());
    token = tok.token;
    expect(token, "REST API token must be available").toBeTruthy();
  }, 60000);

  afterAll(async () => { if (h) await closeApp(h); }, 90000);

  it("registers the new write endpoints in OpenAPI", async () => {
    const spec = await apiRequest(port, token, "GET", "/openapi.json");
    expect(spec.status).toBe(200);
    const paths = spec.body.paths;
    expect(paths["/api/automation/rules"].post).toBeTruthy();
    expect(paths["/api/automation/rules/{ruleId}"].patch).toBeTruthy();
    expect(paths["/api/automation/rules/{ruleId}"].delete).toBeTruthy();
    expect(paths["/api/automation/rules/{ruleId}/test-run"].post).toBeTruthy();
    expect(paths["/api/jobs/{jobId}/cancel"].post).toBeTruthy();
    expect(paths["/api/extension-repository"].post).toBeTruthy();
    expect(paths["/api/extension-repository/local"].post).toBeTruthy();
    expect(paths["/api/extension-repository/{extId}"].patch).toBeTruthy();
    expect(paths["/api/extension-repository/{extId}"].delete).toBeTruthy();
    expect(paths["/api/extension-repository/{extId}/update"].post).toBeTruthy();
    expect(paths["/api/skills"].post).toBeTruthy();
    expect(paths["/api/skills/{id}"].patch).toBeTruthy();
    expect(paths["/api/skills/{id}"].delete).toBeTruthy();
    expect(paths["/api/skills/{id}/install"].post).toBeTruthy();
  }, 20000);

  it("creates, lists, patches and deletes an automation rule via REST", async () => {
    const created = await apiRequest(port, token, "POST", "/api/automation/rules", {
      name: "J82 nightly",
      trigger: { type: "cron", cron: "0 3 * * *" },
      action: { type: "sync-push" },
      runTimeoutMs: 5000,
      maxRetries: 1,
    });
    expect(created.status).toBe(201);
    expect(created.body.success).toBe(true);
    const ruleId = created.body.rule.id;
    expect(ruleId).toMatch(/^rule_/);
    expect(created.body.rule.enabled).toBe(true);
    expect(created.body.rule.runTimeoutMs).toBe(5000);

    const list = await apiRequest(port, token, "GET", "/api/automation/rules");
    expect(list.body.rules.some((r: any) => r.id === ruleId)).toBe(true);

    const patched = await apiRequest(port, token, "PATCH", "/api/automation/rules/" + ruleId, {
      name: "J82 renamed",
      enabled: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.rule.name).toBe("J82 renamed");
    expect(patched.body.rule.enabled).toBe(false);

    const del = await apiRequest(port, token, "DELETE", "/api/automation/rules/" + ruleId);
    expect(del.status).toBe(200);
    const again = await apiRequest(port, token, "DELETE", "/api/automation/rules/" + ruleId);
    expect(again.status).toBe(404);
  }, 20000);

  it("validates automation rule payloads and reports not-found ids", async () => {
    const noAction = await apiRequest(port, token, "POST", "/api/automation/rules", { trigger: { type: "once", at: Date.now() + 60000 } });
    expect(noAction.status).toBe(400);
    const badCron = await apiRequest(port, token, "POST", "/api/automation/rules", {
      trigger: { type: "cron", cron: "99 * * * *" },
      action: { type: "sync-push" },
    });
    expect(badCron.status).toBe(400);
    const missing = await apiRequest(port, token, "PATCH", "/api/automation/rules/rule_missing", { name: "x" });
    expect(missing.status).toBe(404);
    const cancel = await apiRequest(port, token, "POST", "/api/jobs/job_missing/cancel");
    expect(cancel.status).toBe(404);
  }, 20000);

  it("adds, meta-patches, installs and deletes a skill via REST", async () => {
    const added = await apiRequest(port, token, "POST", "/api/skills", {
      id: "j82-helper",
      name: "J82 Helper",
      title: "J82 Helper Skill",
      description: "Slice 59 fixture skill",
      prompt: "You are a J82 test helper.",
      tools: ["browser_navigate"],
      tags: ["test"],
    });
    expect(added.status).toBe(201);
    expect(added.body.skill.id).toBe("j82-helper");

    const list = await apiRequest(port, token, "GET", "/api/skills?filter=j82");
    expect(list.body.skills.some((s: any) => s.id === "j82-helper")).toBe(true);

    const patched = await apiRequest(port, token, "PATCH", "/api/skills/j82-helper", {
      enabled: false,
      tags: ["test", "api"],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.skill.enabled).toBe(false);
    expect(patched.body.skill.tags).toContain("api");

    const installed = await apiRequest(port, token, "POST", "/api/skills/j82-helper/install");
    expect(installed.status).toBe(200);
    expect(installed.body.skill.enabled).toBe(true);

    const del = await apiRequest(port, token, "DELETE", "/api/skills/j82-helper");
    expect(del.status).toBe(200);
    const again = await apiRequest(port, token, "DELETE", "/api/skills/j82-helper");
    expect(again.status).toBe(404);

    const bad = await apiRequest(port, token, "POST", "/api/skills", { id: "no-prompt" });
    expect(bad.status).toBe(400);
  }, 20000);

  it("installs, meta-patches and deletes a local extension via REST (no network)", async () => {
    const list0 = await apiRequest(port, token, "GET", "/api/extension-repository");
    expect(list0.status).toBe(200);
    expect(Array.isArray(list0.body.extensions)).toBe(true);

    const installed = await apiRequest(port, token, "POST", "/api/extension-repository/local", {
      path: LOCAL_EXT_DIR,
      tags: ["j82"],
    });
    expect(installed.status).toBe(201);
    const extId = installed.body.extension.id;
    expect(extId).toMatch(/^local_/);
    expect(installed.body.extension.tags).toEqual(["j82"]);

    const patched = await apiRequest(port, token, "PATCH", "/api/extension-repository/" + extId, {
      shared: true,
      tags: ["j82", "shared"],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.extension.shared).toBe(true);
    expect(patched.body.extension.tags).toContain("shared");

    // Local extensions cannot auto-update → 400, not 500.
    const update = await apiRequest(port, token, "POST", "/api/extension-repository/" + extId + "/update");
    expect(update.status).toBe(400);

    const del = await apiRequest(port, token, "DELETE", "/api/extension-repository/" + extId);
    expect(del.status).toBe(200);
    const again = await apiRequest(port, token, "DELETE", "/api/extension-repository/" + extId);
    expect(again.status).toBe(404);

    const invalidStore = await apiRequest(port, token, "POST", "/api/extension-repository", { extId: "not-an-extension-id" });
    expect(invalidStore.status).toBe(400);
  }, 30000);

  it("denies a viewer settings writes over REST with 403", async () => {
    setLocalRole("viewer");
    await h.page.evaluate(() => (window as any).agentBrowser.api.app.reloadConfig());

    const rule = await apiRequest(port, token, "POST", "/api/automation/rules", {
      trigger: { type: "once", at: Date.now() + 60000 },
      action: { type: "sync-push" },
    });
    expect(rule.status).toBe(403);
    const skill = await apiRequest(port, token, "POST", "/api/skills", { id: "v", prompt: "p" });
    expect(skill.status).toBe(403);
    const ext = await apiRequest(port, token, "POST", "/api/extension-repository/local", { path: LOCAL_EXT_DIR });
    expect(ext.status).toBe(403);
    const cancel = await apiRequest(port, token, "POST", "/api/jobs/job_missing/cancel");
    expect(cancel.status).toBe(403);

    // Reads stay open to viewers.
    const list = await apiRequest(port, token, "GET", "/api/automation/rules");
    expect(list.status).toBe(200);
    const skills = await apiRequest(port, token, "GET", "/api/skills");
    expect(skills.status).toBe(200);
  }, 20000);

  it("no unexpected console errors", () => {
    const c = filterKnownConsoleErrors(h.consoleErrors).filter((e: string) =>
      !/file is not a database|connect to 127.0.0.1 port 1|ECONNREFUSED/i.test(e));
    expect(c.length, c.join("\n")).toBe(0);
  });
});
