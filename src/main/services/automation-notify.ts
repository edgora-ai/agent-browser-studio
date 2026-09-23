// Terminal-execution notifications (M3).
//
// Two delivery paths, deliberately asymmetric:
//
//   in-app  — ALWAYS written to the durable log and broadcast. This is the
//             record the user can act on, and it must survive permission
//             denial, a missing window, and a restart.
//   system  — opt-in, main process, best-effort. Wrapped in try/catch and never
//             awaited by the caller, so a refused or unsupported OS
//             notification cannot affect execution.
//
// Why the main process: the renderer's Notification API is permanently denied
// by the UI session's permission handlers (index.ts, installed before any
// window exists, on the same partition). That posture is a security property
// and is NOT weakened here — Electron's main-process Notification bypasses
// session permission handlers entirely, so it is the only viable OS path.
//
// Dedup lives in the store, not here: INSERT OR IGNORE on a stable key, and
// `created === false` means "already alerted". That single mechanism delivers
// all three requirements at once — one alert per FINAL logical execution, no
// repeat on intermediate retries, no re-alert after a restart.
import { Notification, BrowserWindow } from "electron";
import { recordNotification, type NotificationKind } from "./job-store.js";
import { tMain } from "./main-i18n.js";

export interface NotifyDeps {
  /** Whether the user opted into OS notifications. Injected so tests need no
   *  config store. */
  systemEnabled: () => boolean;
  /** Sound flag for the OS notification. */
  soundEnabled: () => boolean;
  /** In-app broadcast. Injected for the same reason. */
  broadcast: (channel: string, payload: unknown) => void;
  /** The main window, if one exists. */
  getWindow: () => BrowserWindow | null;
  /** Creates the window when a click arrives with none open. */
  ensureWindow: () => void;
  now: () => number;
}

let deps: NotifyDeps | null = null;

/** Injected once at startup (index.ts). Absent in unit tests that only want
 *  the store behaviour. */
export function configureNotifier(d: NotifyDeps): void {
  deps = d;
}

export interface TerminalNotification {
  ruleId: string;
  ruleName: string;
  planId: string | null;
  /** Present for an execution; absent for a missed-once alert. */
  jobId?: string | null;
  runId?: string | null;
  kind: NotificationKind;
  /**
   * Dedup identity. For an execution this is the job id (unique, stable across
   * restarts, and — since M3 — exactly one per logical execution). For a missed
   * once it is rule + plan, so a RESCHEDULE (which mints a new planId) can
   * legitimately alert again while a mere reload cannot.
   */
  dedupKey: string;
}

/**
 * Body text for the OS notification.
 *
 * Deliberately generic: no result text, no error text, no prompt, no URL, no
 * profile id, no runId. A system notification appears on a lock screen and in
 * notification history, so it must not leak business content. The rule name is
 * the one specific field — without it a notification from a multi-rule setup
 * is unusable — and it is truncated. Treating the rule name as sensitive too
 * would be a one-line change; this is a deliberate choice, recorded in the M3
 * acceptance doc.
 */
export function systemNotificationBody(kind: NotificationKind): string {
  // Through tMain so the EN UI does not show Chinese on a lock screen — the
  // same class of leak R146 fixed for proxy-health.
  return tMain(`notify.${kind}`);
}

function truncateRuleName(name: string): string {
  const trimmed = String(name || "").trim() || tMain("notify.default-rule-name");
  return trimmed.length > 80 ? trimmed.slice(0, 79) + "…" : trimmed;
}

/**
 * Record a terminal-execution notification and deliver it.
 *
 * Ordering is the contract: the durable row is written FIRST, before any OS
 * call. If the OS notification throws, is unsupported, or is denied at the
 * system level, the in-app record already exists — which is what makes
 * "permission denial keeps the in-app record and does not affect execution"
 * structurally true rather than lucky.
 *
 * Returns whether this call was the first for the key (i.e. whether it
 * alerted).
 */
export function notifyTerminal(n: TerminalNotification): boolean {
  if (!deps) return false;
  let created = false;
  try {
    const res = recordNotification({
      dedupKey: n.dedupKey,
      jobId: n.jobId ?? null,
      ruleId: n.ruleId,
      planId: n.planId,
      kind: n.kind,
      now: deps.now(),
      delivered: false, // set below only if the OS actually accepted it
    });
    created = res.created;
  } catch {
    // A failed log write must not break the run that produced it.
    return false;
  }
  if (!created) return false; // already alerted for this execution

  // In-app first: it is the path that always works.
  try {
    deps.broadcast("automation:run-finished", {
      ruleId: n.ruleId,
      ruleName: n.ruleName,
      planId: n.planId,
      jobId: n.jobId ?? null,
      runId: n.runId ?? null,
      kind: n.kind,
    });
  } catch { /* no windows in tests / during shutdown */ }

  try {
    if (deps.systemEnabled()) maybeShowSystem(n);
  } catch { /* never let the OS path break the caller */ }

  return true;
}

function maybeShowSystem(n: TerminalNotification): void {
  if (typeof Notification?.isSupported === "function" && !Notification.isSupported()) return;
  // Only when the user cannot already see the app: in the foreground the
  // in-app toast is strictly better (it can carry an action).
  try {
    const win = deps!.getWindow();
    const visible = Boolean(win && !win.isDestroyed() && win.isVisible() && win.isFocused());
    if (visible) return;
  } catch { /* treat an unreadable window as not visible */ }

  const notification = new Notification({
    title: truncateRuleName(n.ruleName),
    body: systemNotificationBody(n.kind),
    silent: !deps!.soundEnabled(),
  });
  notification.on("click", () => {
    // Clicking must land the user on the run, not just the app. Two real
    // failure modes are handled: no window (closed to tray) and a window that
    // is still loading (the click arrives before ready-to-show).
    try {
      let win = deps!.getWindow();
      if (!win || win.isDestroyed()) {
        deps!.ensureWindow();
        win = deps!.getWindow();
      }
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (n.runId) {
        const send = () => { try { win!.webContents.send("automation:open-run", { runId: n.runId }); } catch { /* destroyed mid-send */ } };
        if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
        else send();
      }
    } catch { /* a failed focus must not throw out of an event handler */ }
  });
  notification.show();
}
