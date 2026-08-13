// Automation rule CRUD service unit tests (Slice 59 — shared by IPC + REST).
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-automation-rules-test");

vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_DATA = path.join(os.tmpdir(), "agent-browser-automation-rules-test");
  return {
    app: {
      getPath: (name: string) => {
        if (name === "userData") return TEST_DATA;
        if (name === "home") return TEST_DATA;
        return "/tmp";
      },
    },
  };
});

import { reloadConfig, getConfig, saveConfig } from "../../src/main/services/config-manager.js";
import {
  createAutomationRule,
  updateAutomationRule,
  deleteAutomationRule,
} from "../../src/main/services/automation-rules.js";

function onceRule(): any {
  return { type: "once", at: Date.now() + 60000 };
}

describe("automation rule CRUD service", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    reloadConfig();
    const cfg = getConfig();
    cfg.automation = [];
    saveConfig(cfg);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  it("creates a rule with defaults and persists it", () => {
    const rule = createAutomationRule({
      name: "nightly sync",
      trigger: { type: "cron", cron: "0 3 * * *" },
      action: { type: "sync-push" },
    } as any);
    expect(rule.id).toMatch(/^rule_/);
    expect(rule.name).toBe("nightly sync");
    expect(rule.enabled).toBe(true);
    expect(rule.createdAt).toBeGreaterThan(0);
    expect(getConfig().automation).toHaveLength(1);
  });

  it("honors enabled=false and keeps runTimeoutMs/maxRetries", () => {
    const rule = createAutomationRule({
      name: "x",
      enabled: false,
      runTimeoutMs: 5000,
      maxRetries: 2,
      trigger: onceRule(),
      action: { type: "launch-profile", profileDirId: "ab_1" },
    } as any);
    expect(rule.enabled).toBe(false);
    expect(rule.runTimeoutMs).toBe(5000);
    expect(rule.maxRetries).toBe(2);
  });

  it("rejects an invalid cron expression", () => {
    expect(() =>
      createAutomationRule({ trigger: { type: "cron", cron: "99 * * * *" }, action: { type: "sync-push" } } as any),
    ).toThrow(/cron/i);
  });

  it("updates an existing rule and reports missing rules", () => {
    const rule = createAutomationRule({ name: "a", trigger: onceRule(), action: { type: "sync-push" } } as any);
    const r = updateAutomationRule({ ...rule, name: "renamed", enabled: false } as any);
    expect(r.success).toBe(true);
    expect(r.rule!.name).toBe("renamed");
    expect(r.rule!.enabled).toBe(false);
    expect(getConfig().automation).toHaveLength(1);

    const missing = updateAutomationRule({ id: "rule_nope", name: "nope" } as any);
    expect(missing.success).toBe(false);
    expect(missing.error).toMatch(/not found/);
  });

  it("deletes a rule and returns false for unknown ids", () => {
    const rule = createAutomationRule({ name: "a", trigger: onceRule(), action: { type: "sync-push" } } as any);
    expect(deleteAutomationRule(rule.id)).toBe(true);
    expect(getConfig().automation).toHaveLength(0);
    expect(deleteAutomationRule(rule.id)).toBe(false);
  });
});
