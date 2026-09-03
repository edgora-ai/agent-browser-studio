// LLM config service unit tests (Slice 60 — get/redact/save extracted from
// the IPC layer so REST + IPC share one implementation).
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-llm-config-test");

vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_DATA = path.join(os.tmpdir(), "agent-browser-llm-config-test");
  return {
    app: {
      getPath: (name: string) => {
        if (name === "userData") return TEST_DATA;
        if (name === "home") return TEST_DATA;
        return "/tmp";
      },
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from(plain, "utf8"),
      decryptString: (encrypted: Buffer) => Buffer.from(encrypted).toString("utf8"),
    },
  };
});

import { reloadConfig, getConfig, saveConfig } from "../../src/main/services/config-manager.js";
import {
  getLlmConfig,
  redactLlmConfig,
  saveLlmConfig,
  getOrDetectLlmConfig,
} from "../../src/main/services/local-agent.js";
import { resetSecretStorageForTests, initializeSecretStorage, planSecretStorage, decryptSecretOr } from "../../src/main/services/secrets.js";

function freshConfig(): void {
  const cfg = getConfig();
  delete cfg.llm;
  saveConfig(cfg);
}

describe("LLM config service", () => {
  beforeEach(() => {
    resetSecretStorageForTests();
    initializeSecretStorage(planSecretStorage({
      userDataDir: TEST_USER_DATA,
      platform: "darwin",
      trustedMacSignature: false,
      environment: {},
    }));
    reloadConfig();
    freshConfig();
  });

  afterEach(() => {
    resetSecretStorageForTests();
  });

  it("getLlmConfig returns null when nothing is saved", () => {
    expect(getLlmConfig()).toBeNull();
  });

  it("redactLlmConfig strips the apiKey and exposes hasApiKey", () => {
    expect(redactLlmConfig(null)).toBeNull();
    const redacted = redactLlmConfig({ provider: "openai", apiKey: "sk-secret", model: "gpt-5.5" });
    expect(redacted).toEqual({ provider: "openai", model: "gpt-5.5", hasApiKey: true });
    expect((redacted as any).apiKey).toBeUndefined();
    expect(redactLlmConfig({ provider: "custom", apiKey: "" }).hasApiKey).toBe(false);
  });

  it("saveLlmConfig persists provider/model/apiUrl and the key", () => {
    saveLlmConfig({ provider: "openai", apiKey: "sk-abc", model: "gpt-5.5", apiUrl: "https://api.example.com/v1/chat/completions" });
    const cfg = getConfig();
    expect(cfg.llm?.provider).toBe("openai");
    expect(cfg.llm?.model).toBe("gpt-5.5");
    expect(cfg.llm?.apiUrl).toBe("https://api.example.com/v1/chat/completions");
    expect(cfg.llm?.apiKey).toBeTruthy();
    expect(getLlmConfig()?.apiKey).toBeTruthy();
    // Consumers decrypt for use (local-agent call sites use decryptSecretOr).
    expect(decryptSecretOr(cfg.llm?.apiKey || "")).toBe("sk-abc");
  });

  it("encrypts the LLM apiKey at rest (no cleartext in config.json)", () => {
    saveLlmConfig({ provider: "openai", apiKey: "sk-live-secret-xyz", model: "gpt-5.5" });
    const raw = fs.readFileSync(path.join(TEST_USER_DATA, "config.json"), "utf8");
    expect(raw).not.toContain("sk-live-secret-xyz");
    // …and the stored value still decrypts for use.
    expect(decryptSecretOr(getConfig().llm?.apiKey || "")).toBe("sk-live-secret-xyz");
  });

  it("keeps the previously-saved key when a redacted/empty key is submitted", () => {
    saveLlmConfig({ provider: "claude", apiKey: "sk-original", model: "sonnet" });
    const stored = getConfig().llm?.apiKey;
    saveLlmConfig({ provider: "claude", apiKey: "", model: "opus" });
    const cfg = getConfig();
    expect(cfg.llm?.apiKey).toBe(stored);
    expect(cfg.llm?.model).toBe("opus");
  });

  it("throws when no key exists and none is submitted", () => {
    expect(() => saveLlmConfig({ provider: "openai", apiKey: "" })).toThrow("LLM API key is required");
    expect(getConfig().llm).toBeUndefined();
  });

  it("getOrDetectLlmConfig returns the saved config first", () => {
    saveLlmConfig({ provider: "custom", apiKey: "sk-detect", apiUrl: "http://127.0.0.1:9999/v1/chat/completions" });
    const cfg = getOrDetectLlmConfig();
    // Stored encrypted at rest; decrypts for use.
    expect(decryptSecretOr(cfg?.apiKey || "")).toBe("sk-detect");
    expect(cfg?.provider).toBe("custom");
  });
});
