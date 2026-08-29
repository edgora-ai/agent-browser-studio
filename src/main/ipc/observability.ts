import { ipcMain } from "electron";
import {
  log,
  newTraceId,
  getMetricsSnapshot,
  getRecentEvents,
  recordTiming,
  recordCounter,
  setGauge,
  exportDiagnosticBundle,
  redactSensitive,
  type LogLevel,
} from "../services/observability.js";

/**
 * Observability IPC surface (review item TE-01).
 *
 * Everything here is loopback + local-only: the renderer can append events and
 * read metrics, but there is no path that transmits anything off-device.
 * Payloads are redacted server-side so a hostile renderer still cannot write a
 * plaintext secret into the log file.
 */
export function registerObservabilityHandlers(): void {
  ipcMain.handle("obs:event", async (_event, params: { level?: LogLevel; event: string; fields?: Record<string, unknown> }) => {
    const p = params || ({} as { event: string });
    const entry = log(p.level || "info", String(p.event || "renderer.event"), redactSensitive(p.fields || {}));
    return { ok: true, ts: entry.ts };
  });

  ipcMain.handle("obs:trace", async () => ({ traceId: newTraceId() }));

  ipcMain.handle("obs:timing", async (_event, params: { name: string; ms: number }) => {
    recordTiming(String(params?.name || "unnamed"), Number(params?.ms) || 0);
    return { ok: true };
  });

  ipcMain.handle("obs:counter", async (_event, params: { name: string; delta?: number }) => {
    recordCounter(String(params?.name || "unnamed"), Number(params?.delta ?? 1));
    return { ok: true };
  });

  ipcMain.handle("obs:gauge", async (_event, params: { name: string; value: number }) => {
    setGauge(String(params?.name || "unnamed"), Number(params?.value) || 0);
    return { ok: true };
  });

  ipcMain.handle("obs:metrics", async () => getMetricsSnapshot());

  ipcMain.handle("obs:events", async (_event, params: { limit?: number; level?: LogLevel; event?: string }) => {
    const p = params || {};
    return { events: getRecentEvents(Number(p.limit) || 200, { level: p.level, event: p.event }) };
  });

  ipcMain.handle("obs:export", async () => exportDiagnosticBundle());

  ipcMain.handle("obs:status", async () => {
    const metrics = getMetricsSnapshot();
    return {
      enabled: true,
      generatedAt: metrics.generatedAt,
      counters: metrics.counters,
      timings: metrics.timings,
      gauges: metrics.gauges,
    };
  });
}
