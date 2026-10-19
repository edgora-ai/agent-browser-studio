import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { startSyncAcceptanceFixture } from "../e2e/helpers/sync-fixture.js";

type Fixture = Awaited<ReturnType<typeof startSyncAcceptanceFixture>>;
let fixture: Fixture | undefined;
afterEach(async () => { if (fixture) await fixture.close(); fixture = undefined; });

async function request(port: number, method: string, route: string, data?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method, path: route }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(5_000, () => req.destroy(new Error("Owned fixture request deadline")));
    req.on("error", reject);
    req.end(data);
  });
}
function start() {
  return startSyncAcceptanceFixture({ bucket: "acceptance", configKey: "config.json", businessPage: "<title>Owned sentinel</title>",
    cookieName: "synthetic_session", cookieValue: "synthetic_value", maxObjectBytes: 1024 });
}

describe("shared real-app acceptance transport fixture", () => {
  it("retains actual object bytes and holds config publication until explicitly released", async () => {
    fixture = await start();
    expect(fixture.rejectedTunnelErrors.ECONNRESET + fixture.rejectedTunnelErrors.EPIPE).toBeGreaterThan(0);
    expect(await request(fixture.port, "PUT", "/acceptance/history.zip", "actual artifact bytes")).toMatchObject({ status: 200 });
    expect(await request(fixture.port, "GET", "/acceptance/history.zip")).toEqual({ status: 200, body: "actual artifact bytes" });
    const reached = fixture.holdConfigPut();
    const pending = request(fixture.port, "PUT", "/acceptance/config.json", '{"snapshotId":"owned"}');
    await reached;
    expect(fixture.objects.has("config.json")).toBe(false);
    fixture.releaseConfigPut();
    expect(await pending).toMatchObject({ status: 200 });
    expect(fixture.config()).toEqual({ snapshotId: "owned" });
    expect(fixture.journal.map(({ method, key }) => `${method} ${key}`)).toEqual([
      "PUT history.zip", "GET history.zip", "PUT config.json",
    ]);
    expect(fixture.failures).toEqual([]);
  });

  it("counts receiver business requests without visiting a history marker or retaining credentials", async () => {
    fixture = await start();
    const observation = fixture.beginBusinessCookieObservation();
    expect(observation.count).toBe(0);
    expect(await request(fixture.port, "GET", "/business?marker=synthetic")).toEqual({ status: 200, body: "<title>Owned sentinel</title>" });
    expect(observation).toMatchObject({ count: 1, first: { path: "/business", syntheticCookieMatches: false } });
    expect(Object.keys(observation.first!)).toEqual(["host", "path", "syntheticCookieMatches"]);
    fixture.endBusinessCookieObservation();
    await request(fixture.port, "GET", "/business");
    expect(observation.count).toBe(1);
    expect(await request(fixture.port, "GET", "http://blocked.synthetic.invalid/business")).toMatchObject({ status: 403 });
    expect(fixture.failures).toEqual([]);
  });
});
