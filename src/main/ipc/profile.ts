import { ipcMain } from "electron";
import {
  getProfileInfo,
  listCookies,
  setCookie,
  deleteCookie,
} from "../services/profile-manager.js";
import {
  listCloakProfiles,
  createCloakProfile,
  deleteCloakProfile,
} from "../services/cloak-manager.js";
import { setProfileMeta } from "../services/config-manager.js";
import { validateDirId } from "../services/utils.js";
import type { GeolocationMode, ProfileInfo, ProxyMode, WebRtcMode } from "../types.js";

export function registerProfileHandlers(): void {
  ipcMain.handle("profile:list", async (): Promise<ProfileInfo[]> => {
    const cloak = listCloakProfiles();
    const result: ProfileInfo[] = [];
    for (const p of cloak) {
      try {
        result.push(await getProfileInfo(p.dirId));
      } catch (e) {
        // ignore individual failed profiles
      }
    }
    return result.sort((a, b) => b.lastModified - a.lastModified);
  });

  ipcMain.handle("profile:get", async (_event, dirId: string): Promise<ProfileInfo> => {
    validateDirId(dirId);
    return await getProfileInfo(dirId);
  });

  ipcMain.handle("profile:create", async (_event, {
    name,
    fingerprintSeed,
    platform,
    timezone,
    locale,
    webrtcMode,
    webrtcIp,
    geolocationMode,
    geolocationLatitude,
    geolocationLongitude,
    geolocationAccuracy,
    proxyMode,
    proxyName,
  }: {
    name: string;
    fingerprintSeed?: number;
    platform?: "windows" | "macos";
    timezone?: string;
    locale?: string;
    webrtcMode?: WebRtcMode;
    webrtcIp?: string;
    geolocationMode?: GeolocationMode;
    geolocationLatitude?: number | null;
    geolocationLongitude?: number | null;
    geolocationAccuracy?: number | null;
    proxyMode?: ProxyMode;
    proxyName?: string | null;
  }): Promise<ProfileInfo> => {
    const { dirId } = createCloakProfile({
      name,
      fingerprintSeed,
      platform,
      timezone,
      locale,
      webrtcMode,
      webrtcIp,
      geolocationMode,
      geolocationLatitude,
      geolocationLongitude,
      geolocationAccuracy,
      proxyMode,
      proxyName,
    });
    return await getProfileInfo(dirId);
  });

  ipcMain.handle("profile:delete", async (_event, dirId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = deleteCloakProfile(dirId);
      return { success: result };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // Rename a profile
  ipcMain.handle("profile:rename", async (_event, {
    dirId,
    name,
  }: {
    dirId: string;
    name: string;
  }): Promise<{ success: boolean; error?: string }> => {
    try {
      validateDirId(dirId);
      setProfileMeta(dirId, { name });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── Cookie management ──
  ipcMain.handle("profile:cookies", async (_event, {
    dirId,
    filter,
  }: {
    dirId: string;
    filter?: string;
  }) => {
    validateDirId(dirId);
    return await listCookies(dirId, filter);
  });

  ipcMain.handle("profile:set-cookie", async (_event, {
    dirId,
    domain,
    name,
    value,
  }: {
    dirId: string;
    domain: string;
    name: string;
    value: string;
  }): Promise<{ success: boolean; error?: string }> => {
    try {
      validateDirId(dirId);
      const ok = await setCookie(dirId, { domain, name, value });
      return { success: ok };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("profile:delete-cookie", async (_event, {
    dirId,
    domain,
    name,
  }: {
    dirId: string;
    domain: string;
    name: string;
  }): Promise<{ success: boolean; error?: string }> => {
    try {
      validateDirId(dirId);
      const ok = await deleteCookie(dirId, domain, name);
      return { success: ok };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });
}
