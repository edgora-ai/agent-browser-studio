// Unit tests for the offline hosting/IDC classification heuristic used by the
// proxy detector (Slice 73 — proxy exit risk detection).
import { describe, it, expect } from "vitest";
import { classifyHosting } from "../../src/main/services/proxy-detector.js";

describe("classifyHosting", () => {
  it("flags known cloud ASNs as hosting", () => {
    expect(classifyHosting({ as: "AS31898", org: "Oracle Corporation", isp: "Oracle Corporation" }).hosting).toBe(true);
    expect(classifyHosting({ as: "AS16509", org: "Amazon.com, Inc.", isp: "Amazon" }).hosting).toBe(true);
    expect(classifyHosting({ as: "AS8075", org: "Microsoft Corporation", isp: "Microsoft" }).hosting).toBe(true);
    expect(classifyHosting({ as: "AS14061", org: "DigitalOcean, LLC", isp: "DigitalOcean" }).hosting).toBe(true);
    expect(classifyHosting({ as: "AS37963", org: "Hangzhou Alibaba Advertising Co.,Ltd.", isp: "Aliyun" }).hosting).toBe(true);
    expect(classifyHosting({ as: "AS20473", org: "Choopa, LLC", isp: "Vultr" }).hosting).toBe(true);
  });

  it("flags hosting/IDC org names even without a known ASN", () => {
    expect(classifyHosting({ as: "AS999999", org: "Example Cloud Hosting Ltd", isp: "Example" }).hosting).toBe(true);
    expect(classifyHosting({ as: null, org: "IDC Shanghai", isp: null }).hosting).toBe(true);
    expect(classifyHosting({ as: null, org: "Some Data Center Co", isp: null }).hosting).toBe(true);
    expect(classifyHosting({ as: null, org: "Colocation Provider", isp: null }).hosting).toBe(true);
  });

  it("does not flag residential ISPs or unknown orgs", () => {
    expect(classifyHosting({ as: "AS701", org: "MCI Communications Services", isp: "Verizon" }).hosting).toBe(false);
    expect(classifyHosting({ as: "AS3320", org: "Deutsche Telekom AG", isp: "DTAG" }).hosting).toBe(false);
    expect(classifyHosting({ as: null, org: null, isp: null }).hosting).toBe(false);
    expect(classifyHosting({ as: null, org: "Random ISP", isp: "Random ISP" }).hosting).toBe(false);
  });

  it("treats explicit public-proxy flags separately from hosting", () => {
    const r = classifyHosting({ as: "AS701", org: "Verizon", isp: "Verizon" });
    expect(r.hosting).toBe(false);
    expect(r.isProxy).toBe(false);
    // ASN matches win over org hints — a cloud ASN is hosting, not a proxy.
    const cloud = classifyHosting({ as: "AS14061", org: "DigitalOcean, LLC", isp: "DigitalOcean" });
    expect(cloud.hosting).toBe(true);
    expect(cloud.isProxy).toBe(false);
  });
});
