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

interface MigrationScope {
  active: boolean;
  windows: Set<BrowserWindow>;
}

function assertMigrationActive(scope: MigrationScope): void {
  if (!scope.active) throw new Error("Legacy UI storage migration is no longer active");
}

function destroyMigrationWindow(scope: MigrationScope, win: BrowserWindow): void {
  scope.windows.delete(win);
  try { if (!win.isDestroyed()) win.destroy(); } catch { /* best effort, owned window only */ }
}

function createMigrationWindow(scope: MigrationScope, targetSession: Session): BrowserWindow {
  assertMigrationActive(scope);
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      session: targetSession,
    },
  });
  scope.windows.add(win);
  return win;
}

async function readStorageValues(targetSession: Session, scope: MigrationScope): Promise<Record<string, string | null>> {
  const win = createMigrationWindow(scope, targetSession);
  try {
    await win.loadFile(migratePageUrl());
    assertMigrationActive(scope);
    const keys = JSON.stringify(UI_STORAGE_KEYS);
    const script =
      "(() => { const out = {}; for (const k of " + keys +
      ") { try { out[k] = localStorage.getItem(k); } catch (e) { out[k] = null; } } return out; })()";
    const values = await win.webContents.executeJavaScript(script);
    assertMigrationActive(scope);
    return values as Record<string, string | null>;
  } finally {
    destroyMigrationWindow(scope, win);
  }
}

async function writeStorageValues(targetSession: Session, values: Record<string, string | null>, scope: MigrationScope): Promise<void> {
  assertMigrationActive(scope);
  const entries = Object.entries(values).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return;
  const win = createMigrationWindow(scope, targetSession);
  try {
    await win.loadFile(migratePageUrl());
    assertMigrationActive(scope);
    const serialized = JSON.stringify(entries);
    const script =
      "(() => { const entries = " + serialized +
      "; for (const [k, v] of entries) { try { localStorage.setItem(k, v); } catch (e) {} } return true; })()";
    await win.webContents.executeJavaScript(script);
    assertMigrationActive(scope);
  } finally {
    destroyMigrationWindow(scope, win);
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

  const scope: MigrationScope = { active: true, windows: new Set() };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closeScope = () => {
    scope.active = false;
    for (const win of scope.windows) destroyMigrationWindow(scope, win);
  };
  try {
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn("[storage] legacy UI storage migration timed out");
        closeScope();
        resolve();
      }, timeoutMs);
    });
    const migrate = async () => {
      const legacyValues = await readStorageValues(session.defaultSession, scope);
      assertMigrationActive(scope);
      await writeStorageValues(session.fromPartition(UI_STORAGE_PARTITION), legacyValues, scope);
    };
    // A race alone would leave a losing read free to create a writer later.
    // The scope fences new phases and owns cleanup of our hidden windows.
    // Destroy cannot roll back a storage write already dispatched to Electron.
    await Promise.race([migrate(), deadline]);
  } catch (error) {
    console.error("[storage] legacy UI storage migration failed:", error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    closeScope();
  }

  // Marker is written even on timeout/failure so a permanently-broken legacy
  // storage cannot stall every startup; the app stays usable with defaults.
  try { fs.writeFileSync(marker, "1\n", { mode: 0o600 }); } catch { /* best effort */ }
}
