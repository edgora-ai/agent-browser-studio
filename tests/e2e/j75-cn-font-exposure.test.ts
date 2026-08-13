// J75: host Chinese-font exposure guard (Slice 50 probe).
// Environment scanners (ping0.cc etc.) flag has_cn_fonts=true when a
// non-Chinese profile can load fonts that only exist on a Chinese OS. This
// test drives a Windows-declared profile over CDP and proves the host's
// Chinese fonts are NOT reachable through FontFaceSet.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { launchHeadlessApp, HeadlessAppHandle } from "./helpers/app.js";
import { evaluateInPage, waitForCdpPort } from "./helpers/cdp.js";

const REPO = path.resolve(__dirname, "..", "..");
const USERDATA = path.join(REPO, "tests", "e2e", "userdata", "j75");

const WINDOWS_CN_FONTS = ["SimSun", "SimHei", "Microsoft YaHei", "KaiTi", "FangSong", "DengXian"];
const MAC_UNIVERSAL_CN_FONTS = ["STHeiti", "PingFang SC", "Songti SC"];

describe("J75 — Windows profile does not expose host Chinese fonts", () => {
  let h: HeadlessAppHandle;

  beforeAll(async () => {
    h = await launchHeadlessApp({ userDataDir: USERDATA, token: "j75-font-token" });
  }, 60000);

  afterAll(async () => {
    if (h) await h.close();
  }, 90000);

  const api = (method: string, pathname: string, body?: any) =>
    fetch("http://127.0.0.1:" + h.port + pathname, {
      method,
      headers: {
        authorization: "Bearer " + h.token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));

  it("Windows-declared profile cannot load Windows-Chinese fonts", async () => {
    const created = await api("POST", "/api/profiles", {
      name: "j75-win",
      platform: "windows",
      locale: "en-US",
      timezone: "America/New_York",
      fingerprintSeed: 75001,
    });
    expect(created.status).toBe(201);
    const dirId = created.body.dirId;

    const launched = await api("POST", "/api/profiles/" + encodeURIComponent(dirId) + "/launch", { headless: true });
    expect(launched.status).toBe(200);
    expect(launched.body.cdpPort).toBeGreaterThan(0);
    await waitForCdpPort(launched.body.cdpPort, 20000);

    const allFonts = WINDOWS_CN_FONTS.concat(MAC_UNIVERSAL_CN_FONTS);
    // Availability = FontFaceSet.check() AND rendered width differs from every
    // generic fallback (sans-serif/serif/monospace). A bare check() returns
    // true for a missing family that merely falls back, so width evidence is
    // required — this mirrors the FONT_CORPUS acceptance method.
    const expression =
      "(async () => { const list = " + JSON.stringify(allFonts) +
      "; const out = {}; const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d');" +
      " const text = 'CHINESE\u4E2D\u6587\u5B57\u4F53 test'; const base = '16px';" +
      " const measure = (fam) => { ctx.font = base + ' ' + JSON.stringify(fam); return ctx.measureText(text).width; };" +
      " for (const fam of list) { try { const w = measure(fam); const generics = ['sans-serif','serif','monospace']; const widths = generics.map(measure);" +
      " const check = document.fonts.check(base + ' ' + JSON.stringify(fam));" +
      " out[fam] = check && widths.every((g) => Math.abs(w - g) > 0.5); } catch (e) { out[fam] = null; } } return out; })()";
    const result = await evaluateInPage<Record<string, boolean>>(launched.body.cdpPort, expression);

    // Windows-Chinese fonts must never be loadable from a Windows-declared profile
    // on a host that happens to have them installed.
    for (const fam of WINDOWS_CN_FONTS) {
      expect(result[fam], fam + " must be unavailable").toBe(false);
    }
    // macOS-universal fonts are not part of a Windows profile's declared font set.
    for (const fam of MAC_UNIVERSAL_CN_FONTS) {
      expect(result[fam], fam + " must be unavailable on a Windows profile").toBe(false);
    }

    // The user-facing env-risk report must agree: runtime font exposure over CDP
    // clears the host-scan false positive, so no high cn-fonts-exposed finding.
    const risk = await api("GET", "/api/profiles/" + encodeURIComponent(dirId) + "/env-risk");
    expect(risk.status).toBe(200);
    const fontFindings = (risk.body.findings || []).filter((f: any) => f.code === "cn-fonts-exposed" && f.severity === "high");
    expect(fontFindings, "no high cn-fonts-exposed in the runtime report").toEqual([]);
  }, 60000);
});
