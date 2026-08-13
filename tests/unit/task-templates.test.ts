import { describe, it, expect } from "vitest";
import { TASK_TEMPLATES, getTemplate, renderTemplateCatalog } from "../../src/main/services/task-templates.js";

describe("task templates", () => {
  it("ships a non-empty catalog covering the core scenarios", () => {
    const ids = TASK_TEMPLATES.map((t) => t.id);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    expect(ids).toContain("price-scrape");
    expect(ids).toContain("news-collect");
    expect(ids).toContain("account-check");
  });

  it("every template has the required structure", () => {
    for (const t of TASK_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.title).toBeTruthy();
      expect(t.prompt).toBeTruthy();
      expect(t.steps.length).toBeGreaterThan(0);
      expect(["low", "medium", "high"]).toContain(t.riskLevel);
      expect(t.requiredInputs.length).toBeGreaterThan(0);
      expect(t.requiredInputs.some((input) => input.required)).toBe(true);
      expect(t.tools.length).toBeGreaterThan(0);
      expect(t.successCriteria.length).toBeGreaterThan(0);
      expect(t.examplePrompt).toContain(t.id);
      expect(t.prompt).toBeTruthy();
      expect(t.steps.length).toBeGreaterThan(0);
      expect(["ecommerce", "social", "ads", "data", "ops"]).toContain(t.category);
      if (t.outputTable) {
        expect(t.outputTable.name).toBeTruthy();
        expect(t.outputTable.columns.length).toBeGreaterThan(0);
      }
    }
  });

  it("template ids are unique", () => {
    const ids = TASK_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getTemplate looks up by id", () => {
    expect(getTemplate("price-scrape")?.title).toBe("竞品价格采集");
    expect(getTemplate("nope")).toBeUndefined();
  });

  it("covers the production template library (17 templates across all categories)", () => {
    const ids = TASK_TEMPLATES.map((x) => x.id);
    expect(ids.length).toBe(17);
    for (const id of ["product-inventory", "order-sync", "review-monitor", "keyword-rank", "follower-growth", "comment-watch", "social-publish", "ad-campaign-health", "competitor-track", "session-check", "screenshot-archive", "table-extract"]) {
      expect(ids).toContain(id);
    }
    const cat = new Set(TASK_TEMPLATES.map((x) => x.category));
    expect(cat.has("ecommerce")).toBe(true);
    expect(cat.has("social")).toBe(true);
    expect(cat.has("ads")).toBe(true);
    expect(cat.has("data")).toBe(true);
    expect(cat.has("ops")).toBe(true);
    const catText = renderTemplateCatalog();
    expect(catText).toContain("session-check");
    expect(catText).toContain("social-publish");
  });

  it("renderTemplateCatalog mentions each template + its output table", () => {
    const text = renderTemplateCatalog();
    expect(text).toContain("price-scrape");
    expect(text).toContain("prices");
    expect(text).toContain("news-collect");
    expect(text).toContain("risk:");
    expect(text).toContain("successCriteria");
    expect(text).toContain("建表");
    expect(text).toContain("http_request POST/PUT/PATCH/DELETE 会触发用户审批");
  });
});
