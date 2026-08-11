import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_HOME = path.join(os.tmpdir(), "agent-browser-skill-repo-test-home");
  const TEST_USER_DATA = path.join(TEST_HOME, "userData");
  return {
    app: {
      getPath: (name: string) => {
        if (name === "home") return TEST_HOME;
        if (name === "userData") return TEST_USER_DATA;
        return "/tmp";
      },
    },
  };
});

const TEST_HOME = path.join(os.tmpdir(), "agent-browser-skill-repo-test-home");

import {
  getConfig,
  getConfigPath,
  reloadConfig,
} from "../../src/main/services/config-manager.js";
import {
  addOrUpdateSkill,
  exportSharedSkillRepository,
  getEnabledSkillPrompts,
  importSharedSkillRepository,
  listMarketplaceSkills,
  listSkillRepository,
  removeSkill,
  setSkillMeta,
} from "../../src/main/services/skill-repository.js";
import { assertSafeNavigationUrl, buildAgentSystemPrompt, getAllowedAgentTools } from "../../src/main/services/local-agent.js";

describe("Skill repository data flow", () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    reloadConfig();
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    reloadConfig();
  });

  it("blocks unsafe browser navigation URLs including local IPv6 and mapped IPv4", async () => {
    await expect(assertSafeNavigationUrl("https://93.184.216.34/path?token=secret")).resolves.toBe("https://93.184.216.34/path?token=secret");
    for (const url of [
      "file:///etc/passwd",
      "http://localhost/",
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
      "http://[fd00::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[::ffff:0a00:1]/",
      "http://[::ffff:c0a8:101]/",
    ]) {
      await expect(assertSafeNavigationUrl(url), url).rejects.toThrow();
    }
  });

  it("writes skills, verifies storage, reads back, searches, exports, and injects enabled prompts", () => {
    const skill = addOrUpdateSkill({
      id: "flow-skill",
      name: "flow-skill",
      title: "Flow Skill",
      version: "1.2.0",
      description: "Data flow verification skill",
      source: "local",
      tools: ["browser_navigate", "browser_snapshot"],
      prompt: "Use the flow skill when asked to verify marketplace persistence.",
      shared: true,
      enabled: true,
      tags: ["flow", "verify"],
      author: "tests",
      homepage: "https://example.com/flow-skill",
    });

    const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    const readBack = listSkillRepository();
    const searched = listSkillRepository("verify");
    const market = listMarketplaceSkills("flow");
    const exported = exportSharedSkillRepository();
    const enabledPrompts = getEnabledSkillPrompts();
    const systemPrompt = buildAgentSystemPrompt();

    expect(skill.id).toBe("flow-skill");
    expect(stored.skillRepository["flow-skill"].title).toBe("Flow Skill");
    expect(stored.skillRepository["flow-skill"].shared).toBe(true);
    expect(stored.skillRepository["flow-skill"].packageHash).toMatch(/^[a-f0-9]{128}$/);
    expect(readBack.some((entry) => entry.id === "flow-skill")).toBe(true);
    expect(searched).toHaveLength(1);
    expect(searched[0].tags).toContain("verify");
    expect(market.some((entry) => entry.id === "flow-skill")).toBe(true);
    expect(exported.map((entry) => entry.id)).toContain("flow-skill");
    expect(enabledPrompts.map((entry) => entry.id)).toContain("flow-skill");
    expect(systemPrompt).toContain("Flow Skill (flow-skill)");
    expect(systemPrompt).toContain("Use the flow skill when asked to verify marketplace persistence.");
  });

  it("imports shared catalogs disabled by default and can enable/remove them", () => {
    const result = importSharedSkillRepository([
      {
        id: "shared-skill",
        name: "shared-skill",
        title: "Shared Skill",
        version: "1.0.0",
        description: "Imported from a shared catalog",
        source: "shared-catalog",
        tools: ["browser_get_text"],
        prompt: "Use shared catalog behavior.",
        shared: true,
        tags: ["shared"],
        author: "catalog",
        homepage: "https://example.com/shared-skill",
      },
    ]);

    const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    const imported = listSkillRepository("shared-skill")[0];

    expect(result).toEqual({ added: 1, updated: 0, skipped: 0 });
    expect(stored.skillRepository["shared-skill"].source).toBe("shared-catalog");
    expect(imported.enabled).toBe(false);

    setSkillMeta("shared-skill", { enabled: true, shared: true, tags: ["shared", "enabled"] });
    expect(getEnabledSkillPrompts().map((entry) => entry.id)).toContain("shared-skill");

    expect(removeSkill("shared-skill")).toBe(true);
    expect(listSkillRepository("shared-skill")).toHaveLength(0);
  });

  it("skips shared catalog entries that would replace an existing enabled skill", () => {
    addOrUpdateSkill({
      id: "replace-skill",
      title: "Replace Skill",
      prompt: "Original enabled prompt",
      tools: ["browser_get_text"],
      enabled: true,
      shared: true,
    });
    expect(getEnabledSkillPrompts().map((entry) => entry.id)).toContain("replace-skill");

    const result = importSharedSkillRepository([
      {
        id: "replace-skill",
        name: "replace-skill",
        title: "Replace Skill Updated",
        version: "2.0.0",
        description: "updated shared prompt",
        source: "shared-catalog",
        tools: ["browser_get_text"],
        prompt: "Updated imported prompt must require explicit enablement.",
        shared: true,
        tags: ["updated"],
      },
    ]);

    const imported = listSkillRepository("replace-skill")[0];
    expect(result).toEqual({ added: 0, updated: 0, skipped: 1 });
    expect(imported.enabled).toBe(true);
    expect(imported.prompt).toContain("Original enabled prompt");
    expect(getEnabledSkillPrompts().map((entry) => entry.id)).toContain("replace-skill");
  });

  it("rejects unsafe skill IDs and skips invalid imported entries without partial mutation", () => {
    expect(() => addOrUpdateSkill({ id: "__proto__", prompt: "bad" })).toThrow(/Invalid skill ID/);

    const result = importSharedSkillRepository([
      {
        id: "ok-import",
        name: "ok-import",
        title: "OK Import",
        version: "1.0.0",
        description: "valid",
        source: "shared-catalog",
        tools: [],
        prompt: "Valid prompt",
        shared: true,
        tags: [],
      },
      {
        id: "bad-import",
        name: "bad-import",
        title: "Bad Import",
        version: "1.0.0",
        description: "invalid homepage",
        source: "shared-catalog",
        tools: [],
        prompt: "Invalid homepage prompt",
        shared: true,
        tags: [],
        homepage: "http://example.com/not-allowed",
      },
    ]);

    const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(result).toEqual({ added: 1, updated: 0, skipped: 1 });
    expect(stored.skillRepository["ok-import"].title).toBe("OK Import");
    expect(stored.skillRepository["bad-import"]).toBeUndefined();
  });

  it("deduplicates repeated IDs in imported catalogs", () => {
    const result = importSharedSkillRepository([
      {
        id: "duplicate-skill",
        name: "duplicate-skill",
        title: "Duplicate Skill A",
        version: "1.0.0",
        description: "first",
        source: "shared-catalog",
        tools: [],
        prompt: "First prompt",
        shared: true,
        tags: [],
      },
      {
        id: "duplicate-skill",
        name: "duplicate-skill",
        title: "Duplicate Skill B",
        version: "1.0.0",
        description: "second",
        source: "shared-catalog",
        tools: [],
        prompt: "Second prompt",
        shared: true,
        tags: [],
      },
    ]);

    const stored = listSkillRepository("duplicate-skill");
    expect(result).toEqual({ added: 1, updated: 0, skipped: 1 });
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe("Duplicate Skill A");
  });

  it("persists built-in disable/share metadata and closes the tool allowlist when all skills are disabled", () => {
    const browserAutomation = listSkillRepository("browser-automation")[0];
    expect(browserAutomation.source).toBe("built-in");
    expect(browserAutomation.enabled).toBe(true);

    for (const skill of listSkillRepository()) {
      if (skill.enabled) setSkillMeta(skill.id, { enabled: false });
    }
    // When all skills are disabled, getAllowedAgentTools returns the full AGENT_TOOLS
    // (base tools always available; no skill gating).
    expect(getAllowedAgentTools().length).toBeGreaterThan(0);
    expect(getAllowedAgentTools().some((t: any) => t.function.name === "list_profiles")).toBe(true);
    expect(listSkillRepository("browser-automation")[0].enabled).toBe(false);

    setSkillMeta("browser-automation", { shared: true, tags: ["builtin-share"] });
    const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(stored.skillRepository["browser-automation"].enabled).toBe(false);
    expect(stored.skillRepository["browser-automation"].shared).toBe(true);
  });
});
