import { ipcMain } from "electron";
import {
  getProxyList,
  getProxy,
  resolveProfileProxy,
  addProxy,
  deleteProxy,
  updateProxy,
  setDefaultProxyName,
  setProfileProxy,
  renameProxy,
  getProxyRotationInfo,
} from "../services/config-manager.js";
import { clearProxyHealth, listProxyHealth, proxyHealthSummary, recordProxyRotation } from "../services/proxy-health.js";
import { recordAudit } from "../services/audit-log.js";
import type { ProxyConfig, ProxyMode } from "../types.js";

export function registerProxyHandlers(): void {
  // List all named proxies
  ipcMain.handle("proxy:list", async () => {
    return getProxyList();
  });

  // Get a specific proxy by name
  ipcMain.handle("proxy:get", async (_event, name: string): Promise<ProxyConfig | null> => {
    return getProxy(name);
  });

  // Get the explicitly configured proxy for a profile.
  ipcMain.handle("proxy:get-profile", async (_event, dirId: string) => {
    return resolveProfileProxy(dirId);
  });

  // Add a new named proxy
  ipcMain.handle("proxy:add", async (_event, {
    name,
    config,
  }: {
    name: string;
    config: ProxyConfig;
  }): Promise<{ success: boolean; error?: string }> => {
    try {
      addProxy(name, config);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // Delete a named proxy
  ipcMain.handle("proxy:delete", async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = deleteProxy(name);
      return { success: result, error: result ? undefined : "Cannot delete this proxy" };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // Update a proxy's config
  ipcMain.handle("proxy:update", async (_event, {
    name,
    config,
  }: {
    name: string;
    config: ProxyConfig;
  }): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = updateProxy(name, config);
      return { success: result, error: result ? undefined : "Proxy not found" };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // Atomically rename a proxy and update profile references.
  ipcMain.handle("proxy:rename", async (_event, {
    oldName,
    newName,
    config,
  }: {
    oldName: string;
    newName: string;
    config: ProxyConfig;
  }): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = renameProxy(oldName, newName, config);
      return { success: result, error: result ? undefined : "Proxy not found" };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // Set the default proxy
  ipcMain.handle("proxy:set-default", async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = setDefaultProxyName(name);
      return { success: result, error: result ? undefined : "Proxy not found" };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // Set proxy for a specific profile
  ipcMain.handle("proxy:set-profile", async (_event, {
    dirId,
    proxyName,
    mode,
  }: {
    dirId: string;
    proxyName: string | null;
    mode?: ProxyMode;
  }): Promise<{ success: boolean; error?: string }> => {
    try {
      setProfileProxy(dirId, proxyName, mode);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // Rolling health data for all proxies (score / risk / bindings / suggestions)
  ipcMain.handle("proxy:health-get", async () => {
    return {
      entries: listProxyHealth(),
      summary: proxyHealthSummary(),
    };
  });

  // Clear one proxy's health history, or all when name is omitted
  ipcMain.handle("proxy:health-clear", async (_event, name?: string): Promise<{ success: boolean; error?: string; cleared?: number }> => {
    try {
      const cleared = clearProxyHealth(name);
      return { success: true, cleared };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // Rotation: report whether the proxy is currently unhealthy and which healthy
  // fallback would be used; record the rotation event when one is selected.
  ipcMain.handle("proxy:rotate", async (_event, name: string): Promise<{ success: boolean; error?: string; info?: { from: string; to: string | null; reason: string | null; active: boolean } }> => {
    try {
      const info = getProxyRotationInfo(name);
      if (!info) return { success: false, error: "Proxy not found" };
      if (info.to && info.to !== info.from) {
        recordProxyRotation(info.from, info.to);
        recordAudit({
          category: "proxy",
          action: "rotate",
          target: info.from,
          actor: "user",
          detail: `manual rotate to ${info.to} (${info.reason || "unhealthy"})`,
        });
      }
      return { success: true, info };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // Read-only rotation status (no event recorded) for UI badges.
  ipcMain.handle("proxy:rotation-info", async (_event, name: string): Promise<{ success: boolean; error?: string; info?: { from: string; to: string | null; reason: string | null; active: boolean } }> => {
    const info = getProxyRotationInfo(name);
    if (!info) return { success: false, error: "Proxy not found" };
    return { success: true, info };
  });
}
