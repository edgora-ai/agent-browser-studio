// Team workspace RBAC unit tests — real service imports with an electron mock.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_USER_DATA = path.join(os.tmpdir(), "agent-browser-team-test");

vi.mock("electron", () => {
  const path = require("node:path");
  const os = require("node:os");
  const TEST_DATA = path.join(os.tmpdir(), "agent-browser-team-test");
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
  ROLE_ORDER,
  roleAtLeast,
  getTeam,
  initTeam,
  addMember,
  removeMember,
  setMemberRole,
  renameWorkspace,
  setTeamEnabled,
  localRole,
  requireSyncPush,
  requireForcePush,
  requireProfileMutation,
  syncSafeTeam,
  mergeTeam,
  teamStatus,
} from "../../src/main/services/team.js";
import type { TeamConfig } from "../../src/main/types.js";

function freshConfig(): void {
  const cfg = getConfig();
  cfg.deviceId = "device-owner-001";
  cfg.deviceName = "Owner Mac";
  delete cfg.team;
  saveConfig(cfg);
}

function setLocalDevice(deviceId: string, name: string): void {
  const cfg = getConfig();
  cfg.deviceId = deviceId;
  cfg.deviceName = name;
  saveConfig(cfg);
}

/** Force the current device's role by editing the roster. */
function setLocalRole(role: "owner" | "admin" | "member" | "viewer"): void {
  const team = getTeam()!;
  const me = getConfig().deviceId!;
  const existing = team.members.find((m) => m.deviceId === me);
  if (existing) existing.role = role;
  else team.members.push({ deviceId: me, name: getConfig().deviceName || me, role, addedAt: Date.now() });
  saveConfig(getConfig());
}

function makeTeam(owner: string): TeamConfig {
  return {
    name: "Ops Team",
    ownerDeviceId: owner,
    members: [{ deviceId: owner, name: "Owner", role: "owner", addedAt: 1 }],
    enabled: true,
    updatedAt: 100,
  };
}

describe("team service (real config)", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    reloadConfig();
    freshConfig();
  });

  afterEach(() => {
    if (fs.existsSync(TEST_USER_DATA)) fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  it("role order is owner > admin > member > viewer", () => {
    expect(ROLE_ORDER.owner).toBeGreaterThan(ROLE_ORDER.admin);
    expect(ROLE_ORDER.admin).toBeGreaterThan(ROLE_ORDER.member);
    expect(ROLE_ORDER.member).toBeGreaterThan(ROLE_ORDER.viewer);
    expect(roleAtLeast("admin", "member")).toBe(true);
    expect(roleAtLeast("viewer", "member")).toBe(false);
  });

  it("without a team the local device is treated as owner (full control)", () => {
    expect(getTeam()).toBeNull();
    expect(localRole()).toBe("owner");
    expect(requireSyncPush().ok).toBe(true);
    expect(requireForcePush().ok).toBe(true);
    expect(requireProfileMutation().ok).toBe(true);
  });

  it("initTeam bootstraps the workspace with the local device as owner", () => {
    const team = initTeam("Alpha Workspace");
    expect(team.name).toBe("Alpha Workspace");
    expect(team.ownerDeviceId).toBe("device-owner-001");
    expect(team.members).toHaveLength(1);
    expect(team.members[0].role).toBe("owner");
    expect(team.enabled).toBe(true);
    expect(getConfig().team).toBeDefined();
    expect(teamStatus().local.role).toBe("owner");
  });

  it("owner can add an admin; an admin cannot grant admin roles", () => {
    initTeam("Ops");
    expect(addMember("device-admin-002", "Admin 2", "admin").ok).toBe(true);

    // Demote the local device to admin, then try to add another admin -> blocked.
    setLocalRole("admin");
    const r = addMember("device-admin-003", "Admin 3", "admin");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("owner");
    // Admin can still add a plain member.
    expect(addMember("device-member-004", "M", "member").ok).toBe(true);
  });

  it("duplicate members are rejected", () => {
    initTeam("Ops");
    addMember("device-member-004", "M", "member");
    const r = addMember("device-member-004", "M2", "viewer");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("already");
  });

  it("the owner can never be removed", () => {
    initTeam("Ops");
    const r = removeMember("device-owner-001");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("owner");
  });

  it("admins cannot remove or re-role other admins; owner can", () => {
    initTeam("Ops");
    addMember("device-admin-002", "Admin 2", "admin");
    addMember("device-member-004", "M", "member");

    setLocalRole("admin");
    expect(removeMember("device-admin-002").ok).toBe(false);
    expect(setMemberRole("device-admin-002", "member").ok).toBe(false);
    // Admin can manage a plain member.
    expect(setMemberRole("device-member-004", "viewer").ok).toBe(true);

    setLocalRole("owner");
    expect(removeMember("device-admin-002").ok).toBe(true);
  });

  it("rename is owner-only", () => {
    initTeam("Ops");
    setLocalRole("admin");
    expect(renameWorkspace("X").ok).toBe(false);
    setLocalRole("owner");
    const r = renameWorkspace("Renamed");
    expect(r.ok).toBe(true);
    expect((r.team as TeamConfig).name).toBe("Renamed");
  });

  it("enforcement can be toggled by admins and gates sync push", () => {
    initTeam("Ops");
    addMember("device-viewer-009", "Viewer", "viewer");

    // Local device as viewer -> push/delete/force-push all blocked.
    setLocalRole("viewer");
    expect(requireSyncPush().ok).toBe(false);
    expect(requireForcePush().ok).toBe(false);
    expect(requireProfileMutation().ok).toBe(false);

    // Member can push but not force push.
    setLocalRole("member");
    expect(requireSyncPush().ok).toBe(true);
    expect(requireForcePush().ok).toBe(false);
    expect(requireProfileMutation().ok).toBe(true);

    // Disabling enforcement lifts the gates.
    setLocalRole("admin");
    expect(setTeamEnabled(false).ok).toBe(true);
    setLocalRole("viewer");
    expect(requireSyncPush().ok).toBe(true);
    expect(requireForcePush().ok).toBe(true);
  });

  it("syncSafeTeam strips nothing sensitive and keeps the roster", () => {
    initTeam("Ops");
    addMember("device-viewer-009", "Viewer", "viewer");
    const safe = syncSafeTeam()!;
    expect(safe.ownerDeviceId).toBe("device-owner-001");
    expect(safe.members.map((m) => m.deviceId).sort()).toEqual(["device-owner-001", "device-viewer-009"].sort());
    expect(safe.enabled).toBe(true);
  });

  it("mergeTeam adopts the newer manifest and keeps the only one when the other is absent", () => {
    const local = makeTeam("dev-a");
    const remote = { ...makeTeam("dev-a"), updatedAt: 200, name: "Newer" };
    expect(mergeTeam(local, remote)!.name).toBe("Newer");
    expect(mergeTeam(local, null)!.name).toBe("Ops Team");
    expect(mergeTeam(null, remote)!.name).toBe("Newer");
    expect(mergeTeam(null, null)).toBeNull();
    // Local newer wins.
    const localNewer = { ...local, updatedAt: 999, name: "Local Newer" };
    expect(mergeTeam(localNewer, remote)!.name).toBe("Local Newer");
  });

  it("an unlisted local device is treated as viewer while the team is enabled", () => {
    initTeam("Ops");
    setLocalDevice("device-rogue-777", "Rogue");
    expect(localRole()).toBe("viewer");
    expect(requireSyncPush().ok).toBe(false);
  });

  it("teamStatus exposes the roster, local identity and enforcement state", () => {
    initTeam("Ops");
    const st = teamStatus();
    expect(st.team!.name).toBe("Ops");
    expect(st.local.deviceId).toBe("device-owner-001");
    expect(st.local.role).toBe("owner");
    expect(st.enforcement).toBe(true);
  });
});
