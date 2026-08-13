// J69: Version-aware updates (Slice 43). Launches the controller headless with
// a local update manifest + payload dir, then drives the full release-store
// lifecycle over REST: status → check → install (staged) → activate (pin +
// previous) → rollback, and verifies the payload lands under userData.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as http from "node:http";
import { launchHeadlessApp, HeadlessAppHandle } from "./helpers/app.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j69");
const UPDATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ab-j69-updates-"));
const PAYLOAD_DIR = path.join(UPDATE_ROOT, "payload");
const MANIFEST = path.join(UPDATE_ROOT, "update.json");
const NEW_VERSION = "1.1.0";

function apiRequest(port: number, token: string, method: string, p: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json", authorization: "Bearer " + token };
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const req = http.request({ hostname: "127.0.0.1", port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("J69 — version-aware updates with rollback", () => {
  let h: HeadlessAppHandle;

  beforeAll(async () => {
    fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(PAYLOAD_DIR, "version.txt"), NEW_VERSION);
    fs.writeFileSync(path.join(PAYLOAD_DIR, "marker.json"), JSON.stringify({ slice: 43, version: NEW_VERSION }));
    fs.writeFileSync(MANIFEST, JSON.stringify({
      product: "agent-browser-studio",
      channel: "stable",
      releases: [{ version: NEW_VERSION, url: PAYLOAD_DIR, notes: "Slice 43 release-store e2e" }],
    }, null, 2));
    h = await launchHeadlessApp({
      userDataDir: USERDATA,
      token: "j69-updates-token",
      env: { AGENT_BROWSER_UPDATE_MANIFEST: MANIFEST },
    });
  }, 60000);

  afterAll(async () => {
    if (h) await h.close();
    fs.rmSync(UPDATE_ROOT, { recursive: true, force: true });
  }, 90000);

  it("exposes update status over REST", async () => {
    const r = await apiRequest(h.port, h.token, "GET", "/api/updates/status");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.currentVersion).toBeTruthy();
    expect(r.body.state.activeVersion).toBe(r.body.currentVersion);
    expect(Array.isArray(r.body.state.installed)).toBe(true);
  }, 20000);

  it("checks the manifest and finds a newer release", async () => {
    const r = await apiRequest(h.port, h.token, "POST", "/api/updates/check", {});
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.error).toBeNull();
    expect(r.body.available.some((x: any) => x.version === NEW_VERSION)).toBe(true);
  }, 20000);

  it("installs (stages) the release payload into userData", async () => {
    const r = await apiRequest(h.port, h.token, "POST", "/api/updates/install", { version: NEW_VERSION });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const entry = r.body.state.installed.find((i: any) => i.version === NEW_VERSION);
    expect(entry).toBeTruthy();
    expect(entry.status).toBe("staged");
    const payloadPath = path.join(USERDATA, "updates", "releases", NEW_VERSION, "payload", "version.txt");
    expect(fs.readFileSync(payloadPath, "utf8")).toBe(NEW_VERSION);
  }, 20000);

  it("activates the staged release and pins the previous known-good", async () => {
    const r = await apiRequest(h.port, h.token, "POST", "/api/updates/activate", { version: NEW_VERSION });
    expect(r.status).toBe(200);
    expect(r.body.state.activeVersion).toBe(NEW_VERSION);
    expect(r.body.state.previousVersion).toBe(r.body.state.currentVersion || "1.0.0");
    expect(r.body.state.installed.find((i: any) => i.version === NEW_VERSION).status).toBe("active");
  }, 20000);

  it("rolls back to the previous known-good release", async () => {
    const r = await apiRequest(h.port, h.token, "POST", "/api/updates/rollback", {});
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.state.activeVersion).toBe("1.0.0");
    expect(r.body.state.previousVersion).toBe(NEW_VERSION);
  }, 20000);

  it("records the lifecycle in the update history", async () => {
    const r = await apiRequest(h.port, h.token, "GET", "/api/updates/status");
    const actions = (r.body.state.history || []).map((x: any) => x.action);
    expect(actions).toContain("install");
    expect(actions).toContain("activate");
    expect(actions).toContain("rollback");
  }, 20000);
});
