import { ipcMain } from "electron";
import {
  startRestApiServer, stopRestApiServer,
  getRestApiPort, getRestApiToken, isRestApiServerRunning,
} from "../services/rest-api-server.js";

export function registerApiHandlers(): void {
  ipcMain.handle("api:status", async () => {
    return {
      running: isRestApiServerRunning(),
      port: getRestApiPort(),
      url: `http://127.0.0.1:${getRestApiPort()}`,
      baseUrl: `http://127.0.0.1:${getRestApiPort()}`,
      openapiUrl: `http://127.0.0.1:${getRestApiPort()}/openapi.json`,
      hasToken: Boolean(getRestApiToken()),
    };
  });

  ipcMain.handle("api:restart", async () => {
    try {
      await stopRestApiServer();
      const started = startRestApiServer();
      await started.ready;
      return { running: isRestApiServerRunning(), port: getRestApiPort(), hasToken: Boolean(getRestApiToken()) };
    } catch (e: any) {
      return { running: false, port: getRestApiPort(), hasToken: Boolean(getRestApiToken()), error: e.message || String(e) };
    }
  });

  ipcMain.handle("api:reveal-token", async () => {
    const token = getRestApiToken();
    if (!token) return { token: null };
    // Explicit user request (e.g. clicking "Copy API Token") — reveal on demand.
    return { token };
  });
}

