import { ipcMain } from "electron";
import {
  teamStatus,
  initTeam,
  addMember,
  removeMember,
  setMemberRole,
  renameWorkspace,
  setTeamEnabled,
} from "../services/team.js";
import { recordAudit } from "../services/audit-log.js";
import type { TeamRole } from "../types.js";

function isRole(v: unknown): v is TeamRole {
  return v === "owner" || v === "admin" || v === "member" || v === "viewer";
}

export function registerTeamHandlers(): void {
  ipcMain.handle("team:status", async () => {
    try {
      return { success: true, ...teamStatus() };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("team:init", async (_event, { name }: { name?: string }) => {
    try {
      const team = initTeam(name || "");
      recordAudit({ category: "team", action: "team-init", target: team.ownerDeviceId, actor: "user", detail: team.name });
      return { success: true, team };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("team:add-member", async (_event, { deviceId, name, role }: { deviceId: string; name?: string; role: TeamRole }) => {
    try {
      if (!isRole(role)) return { success: false, error: `Invalid role: ${String(role)}` };
      const r = addMember(deviceId, name || "", role);
      if (!r.ok) return { success: false, error: r.error };
      recordAudit({ category: "team", action: "member-add", target: deviceId, actor: "user", detail: role });
      return { success: true, team: r.team };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("team:remove-member", async (_event, { deviceId }: { deviceId: string }) => {
    try {
      const r = removeMember(deviceId);
      if (!r.ok) return { success: false, error: r.error };
      recordAudit({ category: "team", action: "member-remove", target: deviceId, actor: "user" });
      return { success: true, team: r.team };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("team:set-role", async (_event, { deviceId, role }: { deviceId: string; role: TeamRole }) => {
    try {
      if (!isRole(role)) return { success: false, error: `Invalid role: ${String(role)}` };
      const r = setMemberRole(deviceId, role);
      if (!r.ok) return { success: false, error: r.error };
      recordAudit({ category: "team", action: "member-role", target: deviceId, actor: "user", detail: role });
      return { success: true, team: r.team };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("team:rename", async (_event, { name }: { name: string }) => {
    try {
      const r = renameWorkspace(name);
      if (!r.ok) return { success: false, error: r.error };
      recordAudit({ category: "team", action: "team-rename", target: (r.team as any)?.ownerDeviceId || "", actor: "user", detail: (r.team as any)?.name });
      return { success: true, team: r.team };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("team:set-enabled", async (_event, { enabled }: { enabled: boolean }) => {
    try {
      const r = setTeamEnabled(!!enabled);
      if (!r.ok) return { success: false, error: r.error };
      recordAudit({ category: "team", action: "team-enabled", target: (r.team as any)?.ownerDeviceId || "", actor: "user", detail: String(!!enabled) });
      return { success: true, team: r.team };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  });
}
