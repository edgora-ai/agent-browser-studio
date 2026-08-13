// Account service + RBAC unit tests (Slice 53 — RoxyBrowser 3.8.9 alignment).
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-accounts-test");

vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_DATA = path.join(os.tmpdir(), "agent-browser-accounts-test");
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
  getAccounts,
  getAccountPassword,
  setAccountProfileIds,
  parseAccountsBulkText,
  bulkAddAccounts,
  bulkCreateProfilesWithAccounts,
} from "../../src/main/services/local-agent.js";
import { requireAccountSecret, requireAccountMutation, initTeam } from "../../src/main/services/team.js";
import { listBrowserProfiles } from "../../src/main/services/browser-manager.js";
import { isEncrypted, initializeSecretStorage, planSecretStorage, resetSecretStorageForTests } from "../../src/main/services/secrets.js";

function freshConfig(): void {
  const cfg = getConfig();
  cfg.deviceId = "device-owner-001";
  cfg.deviceName = "Owner Mac";
  delete cfg.team;
  cfg.accounts = [];
  saveConfig(cfg);
}

function setLocalRole(role: "owner" | "admin" | "member" | "viewer"): void {
  const team = getConfig().team;
  const me = getConfig().deviceId!;
  const existing = team!.members.find((m: any) => m.deviceId === me);
  if (existing) existing.role = role;
  else team!.members.push({ deviceId: me, name: getConfig().deviceName || me, role, addedAt: Date.now() });
  saveConfig(getConfig());
}

describe("account bulk text parser", () => {
  it("returns [] for empty or blank input", () => {
    expect(parseAccountsBulkText("")).toEqual([]);
    expect(parseAccountsBulkText("   \n\n  ")).toEqual([]);
  });

  it("parses positional lines (url, username, password, tags)", () => {
    const out = parseAccountsBulkText(
      "https://twitter.com, alice, s3cret, social;twitter\nhttps://amazon.com, bob, hunter2, shopping|prime"
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ url: "https://twitter.com", username: "alice", password: "s3cret", tags: ["social", "twitter"] });
    expect(out[1]).toEqual({ url: "https://amazon.com", username: "bob", password: "hunter2", tags: ["shopping", "prime"] });
  });

  it("supports an optional header row and skips malformed lines", () => {
    const out = parseAccountsBulkText(
      "url, username, password, tags\nhttps://x.com, carol, pass1, social\n, noName, pass2\nhttps://y.com, dave"
    );
    expect(out).toHaveLength(2);
    expect(out[0].url).toBe("https://x.com");
    expect(out[0].username).toBe("carol");
    expect(out[1].password).toBeUndefined();
  });

  it("dedupes and caps tags", () => {
    const out = parseAccountsBulkText("https://z.com, eve, pw, a;b;a");
    expect(out[0].tags).toEqual(["a", "b"]);
  });
});


describe("account service (real config)", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    initializeSecretStorage(planSecretStorage({ userDataDir: TEST_USER_DATA, platform: "darwin", environment: {} }));
    reloadConfig();
    freshConfig();
  });

  afterEach(() => {
    resetSecretStorageForTests();
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  it("bulkAddAccounts adds and encrypts passwords at rest", () => {
    const items = parseAccountsBulkText("https://twitter.com, alice, s3cret, social\nhttps://amazon.com, bob, hunter2");
    const result = bulkAddAccounts(items);
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);
    const accounts = getAccounts();
    expect(accounts).toHaveLength(2);
    expect(isEncrypted(accounts[0].platformPassword)).toBe(true);
    expect(getAccountPassword(0)).toBe("s3cret");
    expect(getAccountPassword(1)).toBe("hunter2");
    // The stored config never holds plaintext.
    const raw = JSON.stringify(accounts);
    expect(raw).not.toContain("s3cret");
  });

  it("bulkAddAccounts reports skipped malformed lines without persisting them", () => {
    const result = bulkAddAccounts([{ url: "", username: "x" }, { url: "https://ok.com", username: "y" }]);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(getAccounts()).toHaveLength(1);
  });

  it("setAccountProfileIds binds, dedupes, validates, and clears", () => {
    bulkAddAccounts([{ url: "https://x.com", username: "alice" }]);
    const updated = setAccountProfileIds(0, ["prof_abc", "prof_abc", "bad id!", "prof_zzz"]);
    expect(updated!.profileIds).toEqual(["prof_abc", "prof_zzz"]);
    const cleared = setAccountProfileIds(0, []);
    expect(cleared!.profileIds).toBeUndefined();
  });

  it("getAccountPassword returns null out of range / missing", () => {
    expect(getAccountPassword(0)).toBeNull();
    bulkAddAccounts([{ url: "https://x.com", username: "alice" }]);
    expect(getAccountPassword(0)).toBeNull();
    expect(getAccountPassword(5)).toBeNull();
  });

  describe("account RBAC", () => {
    it("passes when no workspace exists (single-user full control)", () => {
      expect(requireAccountSecret().ok).toBe(true);
      expect(requireAccountMutation().ok).toBe(true);
    });

    it("denies viewers account secrets and mutations, allows member+", () => {
      initTeam("Ops");
      setLocalRole("viewer");
      expect(requireAccountSecret().ok).toBe(false);
      expect(requireAccountMutation().ok).toBe(false);
      setLocalRole("member");
      expect(requireAccountSecret().ok).toBe(true);
      expect(requireAccountMutation().ok).toBe(true);
      setLocalRole("admin");
      expect(requireAccountSecret().ok).toBe(true);
      setLocalRole("owner");
      expect(requireAccountSecret().ok).toBe(true);
    });

    it("dormant workspace (enabled=false) does not gate", () => {
      const team = initTeam("Ops");
      team.enabled = false;
      getConfig().team = team;
      saveConfig(getConfig());
      setLocalRole("viewer");
      expect(requireAccountSecret().ok).toBe(true);
      expect(requireAccountMutation().ok).toBe(true);
    });
  });
});

describe("bulk create profiles + accounts (RoxyBrowser 3.8.9 workflow)", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    initializeSecretStorage(planSecretStorage({ userDataDir: TEST_USER_DATA, platform: "darwin", environment: {} }));
    reloadConfig();
    freshConfig();
  });

  afterEach(() => {
    resetSecretStorageForTests();
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  it("creates a bound profile + account pair per valid line", () => {
    const items = parseAccountsBulkText("https://twitter.com, alice, s3cret, social\nhttps://amazon.com, bob, hunter2");
    const r = bulkCreateProfilesWithAccounts(items, { platform: "windows" });
    expect(r.added).toBe(2);
    expect(r.created).toBe(2);
    expect(r.skipped).toBe(0);
    const accounts = getAccounts();
    expect(accounts).toHaveLength(2);
    const profiles = listBrowserProfiles();
    expect(profiles.some((p: any) => p.name === "twitter.com · alice")).toBe(true);
    expect(profiles.some((p: any) => p.name === "amazon.com · bob")).toBe(true);
    // Each account is bound to its own created profile.
    const prof = profiles.find((p: any) => p.name === "twitter.com · alice");
    const acc = accounts[0];
    expect(acc.profileIds).toEqual([prof.dirId]);
    expect(isEncrypted(acc.platformPassword)).toBe(true);
  });

  it("reports malformed lines and never creates a half pair", () => {
    const r = bulkCreateProfilesWithAccounts([{ url: "", username: "x" }, { url: "https://ok.com", username: "y" }]);
    expect(r.added).toBe(1);
    expect(r.created).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.errors.length).toBe(1);
    expect(getAccounts()).toHaveLength(1);
    expect(listBrowserProfiles().length).toBe(1);
  });

  it("dedupes profile names with a numeric suffix", () => {
    const items = parseAccountsBulkText("https://x.com, alice\nhttps://y.com, alice");
    const r = bulkCreateProfilesWithAccounts(items, {});
    expect(r.created).toBe(2);
    const names = listBrowserProfiles().map((p: any) => p.name);
    expect(names.filter((n: string) => n.startsWith("x.com · alice") || n.startsWith("y.com · alice"))).toHaveLength(2);
    expect(new Set(names)).toHaveProperty("size", 2);
  });
});
