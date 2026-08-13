// ── Renderer persistent storage partition ──
//
// The main window used to run on Electron's default session, whose storage
// lives directly under <userData>/Local Storage. Chromium's storage service
// performs a discovery pass over the whole user-data tree when that storage
// area is first opened; when managed browser profiles are running inside
// <userData>/profiles, that discovery blocks on their LevelDB locks and the
// renderer's very first localStorage access stalls for seconds (measured
// ~3.5-4s), delaying DOMContentLoaded and the window's first paint.
//
// Moving the UI to its own persistent session partition
// (persist:app -> <userData>/Partitions/app) scopes the storage service to a
// small directory that never contains running profile data, so the first
// localStorage access completes in milliseconds. The one-time migration below
// copies the few renderer settings that used to live in the default session so
// existing users keep their theme / language / first-run wizard state.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, session, type Session } from "electron";

export const UI_STORAGE_PARTITION = "persist:app";

// ── ESM dirname equivalent (this module is compiled to ESM) ──
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIGRATION_MARKER = ".ui-storage-migrated-v1";

// Every persistent key the renderer writes to localStorage. Keep in sync with
// src/renderer/js (i18n.js, init.js, wizard.js).
const UI_STORAGE_KEYS = [
  "agent-browser-studio-theme",
  "cloak-theme",
  "agent-browser-studio-language",
  "cloak-lite-language",
  "agent-browser-studio-wizard-dismissed",
  "cloak-wizard-dismissed",
] as const;

function migrationMarkerPath(userDataDir: string): string {
  return path.join(userDataDir, MIGRATION_MARKER);
}

function hasLegacyUiStorage(userDataDir: string): boolean {
  // Cheap gate: if the default-session LevelDB was never created there is
  // nothing to migrate and we can skip the (slow) hidden-window read.
  const legacyDb = path.join(userDataDir, "Local Storage", "leveldb");
  try {
    return fs.readdirSync(legacyDb).some((entry) => entry !== "LOCK");
  } catch {
    return false;
  }
}

function migratePageUrl(): string {
  // This module compiles to dist/main/services/, so it needs two levels up to
  // reach the renderer assets copied to dist/renderer/.
  return path.join(__dirname, "..", "..", "renderer", "storage-migrate.html");
}

async function readStorageValues(targetSession: Session): Promise<Record<string, string | null>> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      session: targetSession,
    },
  });
  try {
    await win.loadFile(migratePageUrl());
    const keys = JSON.stringify(UI_STORAGE_KEYS);
    const script =
      "(() => { const out = {}; for (const k of " + keys +
      ") { try { out[k] = localStorage.getItem(k); } catch (e) { out[k] = null; } } return out; })()";
    const values = await win.webContents.executeJavaScript(script);
    return values as Record<string, string | null>;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function writeStorageValues(targetSession: Session, values: Record<string, string | null>): Promise<void> {
  const entries = Object.entries(values).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return;
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      session: targetSession,
    },
  });
  try {
    await win.loadFile(migratePageUrl());
    const serialized = JSON.stringify(entries);
    const script =
      "(() => { const entries = " + serialized +
      "; for (const [k, v] of entries) { try { localStorage.setItem(k, v); } catch (e) {} } return true; })()";
    await win.webContents.executeJavaScript(script);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * One-time copy of renderer settings from the legacy default session into the
 * UI partition. Runs before the main window is created so the visible renderer
 * reads already-migrated values. No-op once the marker file exists.
 */
export async function migrateLegacyRendererStorage(timeoutMs = 10_000): Promise<void> {
  const userDataDir = app.getPath("userData");
  const marker = migrationMarkerPath(userDataDir);
  if (fs.existsSync(marker)) return;

  if (!hasLegacyUiStorage(userDataDir)) {
    try { fs.writeFileSync(marker, "1\n", { mode: 0o600 }); } catch { /* best effort */ }
    return;
  }

  let completed = false;
  try {
    const timer = setTimeout(() => {
      if (!completed) console.warn("[storage] legacy UI storage migration timed out");
    }, timeoutMs);
    try {
      const legacyValues = await readStorageValues(session.defaultSession);
      await writeStorageValues(session.fromPartition(UI_STORAGE_PARTITION), legacyValues);
      completed = true;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error("[storage] legacy UI storage migration failed:", error);
  }

  // Marker is written even on timeout/failure so a permanently-broken legacy
  // storage cannot stall every startup; the app stays usable with defaults.
  try { fs.writeFileSync(marker, "1\n", { mode: 0o600 }); } catch { /* best effort */ }
}
