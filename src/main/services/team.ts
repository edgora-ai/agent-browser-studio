// Team workspace RBAC for persistent profiles.
//
// A workspace is a shared roster of member devices (keyed by the stable per-
// install deviceId) with four roles: owner > admin > member > viewer. The
// manifest travels with the sync snapshot so a second device adopting the
// workspace sees the same roster. Enforcement is local and best-effort,
// mirroring how the existing profile-checkout locks behave: clients that
// respect the workspace (this app) honor the gates; the manifest is not a
// server-side ACL.
import { getConfig, saveConfig } from "./config-manager.js";
import type { TeamConfig, TeamMember, TeamRole } from "../types.js";

export const ROLE_ORDER: Record<TeamRole, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

export type RoleCheck = { ok: true } | { ok: false; error: string };

/** Current team manifest, or null when no workspace is initialized. */
export function getTeam(): TeamConfig | null {
  return getConfig().team || null;
}

/** Stable local device identity used as the member key. */
export function getLocalIdentity(): { deviceId: string; name: string } {
  const cfg = getConfig();
  const deviceId = cfg.deviceId || "local";
  return { deviceId, name: cfg.deviceName || deviceId.slice(0, 8) || "This device" };
}

/**
 * Role of the current device in the workspace. Without a workspace every
 * device is treated as its own owner (full control).
 */
export function localRole(): TeamRole {
  const team = getTeam();
  if (!team) return "owner";
  const me = team.members.find((m) => m.deviceId === getLocalIdentity().deviceId);
  return me ? me.role : "viewer";
}

export function roleAtLeast(role: TeamRole, min: TeamRole): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[min];
}

function teamEnabled(): boolean {
  const team = getTeam();
  return !!team && team.enabled !== false;
}

export function requireRole(min: TeamRole): RoleCheck {
  const role = localRole();
  if (roleAtLeast(role, min)) return { ok: true };
  return { ok: false, error: `requires ${min} role (current: ${role})` };
}

/** Sync push mutates shared state — member+. */
export function requireSyncPush(): RoleCheck {
  if (!teamEnabled()) return { ok: true };
  return requireRole("member");
}

/** Force push overwrites remote state (bypasses checkout locks) — admin+. */
export function requireForcePush(): RoleCheck {
  if (!teamEnabled()) return { ok: true };
  return requireRole("admin");
}

/** Destructive local profile mutation (delete) — member+ when team enabled. */
export function requireProfileMutation(): RoleCheck {
  if (!teamEnabled()) return { ok: true };
  return requireRole("member");
}

/** Reading account secrets (reveal/copy password) — member+ when team enabled. */
export function requireAccountSecret(): RoleCheck {
  if (!teamEnabled()) return { ok: true };
  return requireRole("member");
}

/** Mutating accounts (add/update/delete/bind/bulk import/export) — member+ when team enabled. */
export function requireAccountMutation(): RoleCheck {
  if (!teamEnabled()) return { ok: true };
  return requireRole("member");
}

/** Mutating shared app configuration (automation rules, extension repository,
 *  skills, etc.) — member+ when team enabled. */
export function requireSettingsMutation(): RoleCheck {
  if (!teamEnabled()) return { ok: true };
  return requireRole("member");
}

function saveTeam(team: TeamConfig): void {
  try {
    const { transact } = require("./config/store.js");
    transact((cfg: any) => { cfg.team = team; });
    return;
  } catch {}
  const cfg = getConfig();
  cfg.team = team;
  saveConfig(cfg);
}

/**
 * Bootstrap the workspace with the local device as owner.
 * R15 P0-5: re-init of an existing workspace requires owner — otherwise any
 * viewer can seize ownerDeviceId and take over the roster.
 */
export function initTeam(name: string): TeamConfig {
  const me = getLocalIdentity();
  const existing = getTeam();
  if (existing && existing.members.length > 0) {
    const role = localRole();
    if (role !== "owner") {
      throw new Error("A team workspace already exists — only its owner can re-initialize it");
    }
  }
  const members: TeamMember[] = existing && existing.members.length
    ? existing.members
    : [{ deviceId: me.deviceId, name: me.name, role: "owner", addedAt: Date.now() }];
  const team: TeamConfig = {
    name: String(name || "").trim().slice(0, 60) || (existing?.name || "My Workspace"),
    ownerDeviceId: me.deviceId,
    members,
    enabled: true,
    updatedAt: Date.now(),
  };
  saveTeam(team);
  return team;
}

function normalizeDeviceId(raw: unknown): string | null {
  const id = String(raw || "").trim().slice(0, 64);
  return id ? id : null;
}

/** Add a member. admin+ can add member/viewer; only the owner grants admin. */
export function addMember(deviceIdRaw: string, nameRaw: string, role: TeamRole): RoleCheck & { team?: TeamConfig } {
  const req = requireRole("admin");
  if (!req.ok) return req;
  const team = getTeam();
  if (!team) return { ok: false, error: "No team workspace initialized" };
  const id = normalizeDeviceId(deviceIdRaw);
  if (!id) return { ok: false, error: "deviceId is required" };
  if (id === getLocalIdentity().deviceId) return { ok: false, error: "This device is already a member" };
  if (team.members.some((m) => m.deviceId === id)) return { ok: false, error: "Member already exists" };
  if (role !== "owner" && role !== "admin" && role !== "member" && role !== "viewer") {
    return { ok: false, error: `Invalid role: ${role}` };
  }
  const me = localRole();
  if ((role === "owner" || role === "admin") && me !== "owner") {
    return { ok: false, error: "Only the workspace owner can grant admin/owner roles" };
  }
  team.members.push({ deviceId: id, name: String(nameRaw || "").trim().slice(0, 40) || id, role, addedAt: Date.now() });
  team.updatedAt = Date.now();
  saveTeam(team);
  return { ok: true, team };
}

/** Remove a member. The owner is never removable; admins cannot remove admins. */
export function removeMember(deviceIdRaw: string): RoleCheck & { team?: TeamConfig } {
  const req = requireRole("admin");
  if (!req.ok) return req;
  const team = getTeam();
  if (!team) return { ok: false, error: "No team workspace initialized" };
  const id = normalizeDeviceId(deviceIdRaw);
  const idx = team.members.findIndex((m) => m.deviceId === id);
  if (idx < 0) return { ok: false, error: "Member not found" };
  const target = team.members[idx];
  if (target.role === "owner") return { ok: false, error: "Cannot remove the workspace owner" };
  const me = localRole();
  if (me !== "owner" && target.role === "admin") {
    return { ok: false, error: "Only the workspace owner can remove an admin" };
  }
  team.members.splice(idx, 1);
  team.updatedAt = Date.now();
  saveTeam(team);
  return { ok: true, team };
}

/** Change a member's role. Owner can set any role; admins only flip member<->viewer. */
export function setMemberRole(deviceIdRaw: string, role: TeamRole): RoleCheck & { team?: TeamConfig } {
  const req = requireRole("admin");
  if (!req.ok) return req;
  const team = getTeam();
  if (!team) return { ok: false, error: "No team workspace initialized" };
  const id = normalizeDeviceId(deviceIdRaw);
  const target = team.members.find((m) => m.deviceId === id);
  if (!target) return { ok: false, error: "Member not found" };
  if (role !== "owner" && role !== "admin" && role !== "member" && role !== "viewer") {
    return { ok: false, error: `Invalid role: ${role}` };
  }
  const me = localRole();
  if (me !== "owner") {
    if (role === "owner" || role === "admin") return { ok: false, error: "Only the workspace owner can grant admin/owner roles" };
    if (target.role === "admin" || target.role === "owner") return { ok: false, error: "Only the workspace owner can change an admin/owner role" };
  }
  target.role = role;
  team.updatedAt = Date.now();
  saveTeam(team);
  return { ok: true, team };
}

/** Rename the workspace — owner only. */
export function renameWorkspace(name: string): RoleCheck & { team?: TeamConfig } {
  const req = requireRole("owner");
  if (!req.ok) return req;
  const team = getTeam();
  if (!team) return { ok: false, error: "No team workspace initialized" };
  team.name = String(name || "").trim().slice(0, 60) || team.name;
  team.updatedAt = Date.now();
  saveTeam(team);
  return { ok: true, team };
}

/** Toggle enforcement — admin+. */
export function setTeamEnabled(enabled: boolean): RoleCheck & { team?: TeamConfig } {
  const req = requireRole("admin");
  if (!req.ok) return req;
  const team = getTeam();
  if (!team) return { ok: false, error: "No team workspace initialized" };
  team.enabled = !!enabled;
  team.updatedAt = Date.now();
  saveTeam(team);
  return { ok: true, team };
}

export function teamStatus() {
  const team = getTeam();
  const me = getLocalIdentity();
  return {
    team: team ? { ...team } : null,
    local: { deviceId: me.deviceId, name: me.name, role: localRole() },
    enforcement: teamEnabled(),
  };
}

/** Pure, sync-safe serialization of a team manifest (no secrets).
 * R10 P1-3: field contract mirrors config-manager normalizeTeamManifest
 * (trim deviceId, drop blanks, cap lengths, cap 50 members). Keep them in
 * lockstep — see the comment there. */
export function sanitizeTeam(team: TeamConfig | null | undefined): TeamConfig | null {
  if (!team || typeof team !== "object") return null;
  const members = Array.isArray(team.members)
    ? team.members
        .filter((m) => m && typeof m.deviceId === "string" && String(m.deviceId).trim())
        .map((m) => {
          const deviceId = String(m.deviceId).trim().slice(0, 64);
          return {
            deviceId,
            name: String(m.name || "").slice(0, 40) || deviceId.slice(0, 8),
            role: ROLE_ORDER[m.role] ? m.role : "viewer",
            addedAt: Number.isFinite(m.addedAt) ? m.addedAt : 0,
          };
        })
        .slice(0, 50)
    : [];
  if (!members.length) return null;
  return {
    name: String(team.name || "").slice(0, 60) || "Workspace",
    ownerDeviceId: String(team.ownerDeviceId || members[0].deviceId).slice(0, 64),
    members,
    enabled: team.enabled !== false,
    updatedAt: Number.isFinite(team.updatedAt) ? team.updatedAt : 0,
  };
}

/** Sync-safe team manifest of the local workspace. */
export function syncSafeTeam(): TeamConfig | null {
  return sanitizeTeam(getTeam());
}

/** Adopt the newer workspace manifest (source of truth) after a pull. */
export function mergeTeam(local: TeamConfig | null, remote: TeamConfig | null): TeamConfig | null {
  if (!local) return remote ? { ...remote } : null;
  if (!remote) return { ...local };
  return (remote.updatedAt || 0) >= (local.updatedAt || 0) ? { ...remote } : { ...local };
}
