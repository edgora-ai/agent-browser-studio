import { runningProcesses, type RunningEntry } from "../browser/runtime-table.js";

/**
 * Browser instance selected for one desktop chat run. The public fields are a
 * snapshot for prompts and tool arguments; an internal WeakMap pins the exact
 * runtime-table entry so a stop/restart or port reuse cannot inherit authority.
 */
export type ChatBrowserScope = Readonly<{
  dirId: string;
  port: number;
  pid: number;
}>;

const pinnedEntries = new WeakMap<object, RunningEntry>();

const SCOPED_BROWSER_TOOLS = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_scroll",
  "browser_press_key",
  "browser_hover",
  "browser_select",
  "browser_wait_for",
  "browser_wait_for_load",
  "browser_get_text",
  "browser_get_url",
  "browser_get_title",
  "browser_get_cookies",
  "browser_new_tab",
  "browser_upload_file",
]);

const SCOPED_CATALOG_TOOLS = new Set([
  "list_profiles",
  "list_accounts",
]);

const INDEPENDENT_TOOLS = new Set([
  "http_request",
  "set_var",
  "get_var",
  "read_file",
  "write_file",
  "db_query",
  "db_exec",
]);

const EXPLICIT_GLOBAL_READ_TOOLS = new Set([
  "list_automation_rules",
  "get_automation_logs",
]);

const BLOCKED_IN_SCOPED_CHAT = new Set([
  "browser_evaluate",
  "launch_profile",
  "create_automation_rule",
  "delete_automation_rule",
]);

function isLivePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM still proves that the process exists; only reachability matters.
    return error?.code === "EPERM";
  }
}

function assertValidRuntimeEntry(dirId: string, entry: RunningEntry | undefined): asserts entry is RunningEntry {
  if (!entry) throw new Error(`Selected browser profile is not running: ${dirId}`);
  if (entry.stopping || entry.killTimer) throw new Error(`Selected browser profile is stopping: ${dirId}`);
  if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
    throw new Error(`Selected browser profile has no valid debug port: ${dirId}`);
  }
  if (!isLivePid(entry.pid)) throw new Error(`Selected browser profile process is not live: ${dirId}`);
}

function assertUniqueRuntimePort(dirId: string, entry: RunningEntry): void {
  for (const [otherDirId, otherEntry] of runningProcesses) {
    if (otherEntry.port === entry.port && (otherDirId !== dirId || otherEntry !== entry)) {
      throw new Error(`Selected browser debug port is ambiguous: ${entry.port}`);
    }
  }
}

function pinnedEntryFor(scope: ChatBrowserScope): RunningEntry {
  if (!scope || typeof scope !== "object") throw new Error("Invalid chat browser scope");
  const entry = pinnedEntries.get(scope as object);
  if (!entry) throw new Error("Invalid or forged chat browser scope");
  if (
    typeof scope.dirId !== "string" || !scope.dirId ||
    scope.port !== entry.port || scope.pid !== entry.pid
  ) {
    throw new Error("Chat browser scope no longer matches its pinned instance");
  }
  return entry;
}

/**
 * Resolve and pin the selected managed browser synchronously before an LLM call.
 * Omitted/empty selection deliberately means a no-browser desktop chat scope.
 */
export function captureChatBrowserScope(profileDirId?: string): ChatBrowserScope | null {
  if (profileDirId === undefined || profileDirId === "") return null;
  if (typeof profileDirId !== "string" || !profileDirId.trim()) {
    throw new Error("Invalid selected browser profile ID");
  }

  const entry = runningProcesses.get(profileDirId);
  assertValidRuntimeEntry(profileDirId, entry);
  assertUniqueRuntimePort(profileDirId, entry);

  const scope: ChatBrowserScope = Object.freeze({
    dirId: profileDirId,
    port: entry.port,
    pid: entry.pid,
  });
  pinnedEntries.set(scope, entry);
  return scope;
}

/** Verify that an object really came from captureChatBrowserScope. */
export function assertCapturedChatBrowserScope(scope: ChatBrowserScope): void {
  pinnedEntryFor(scope);
}

/**
 * Re-check the exact pinned runtime instance and the model-provided protocol
 * port. This is intentionally stricter than the legacy REST/MCP port fallback.
 */
export function assertChatBrowserScopePort(scope: ChatBrowserScope, actualPort: number): void {
  const pinned = pinnedEntryFor(scope);
  if (!Number.isInteger(actualPort) || actualPort !== scope.port) {
    throw new Error(`Browser port ${actualPort} is outside the selected chat browser scope`);
  }

  const current = runningProcesses.get(scope.dirId);
  if (current !== pinned) throw new Error("Selected browser instance stopped or was replaced");
  assertValidRuntimeEntry(scope.dirId, current);
  assertUniqueRuntimePort(scope.dirId, current);
  if (current.pid !== scope.pid || current.port !== scope.port) {
    throw new Error("Selected browser instance PID or port changed");
  }
}

/** Assert that the captured instance itself is still current. */
export function assertChatBrowserScopeCurrent(scope: ChatBrowserScope): void {
  assertChatBrowserScopePort(scope, scope.port);
}

/** Compare two captures by their private runtime-entry identity. */
export function isSameChatBrowserInstance(left: ChatBrowserScope, right: ChatBrowserScope): boolean {
  try {
    return pinnedEntryFor(left) === pinnedEntryFor(right);
  } catch {
    return false;
  }
}

/** Ensure a scoped Firefox hook/cache returned the pinned entry's own session. */
export function assertChatBrowserScopeBidiSession(scope: ChatBrowserScope, session: unknown): void {
  assertChatBrowserScopeCurrent(scope);
  const pinned = pinnedEntryFor(scope);
  if (!pinned.bidiConn || pinned.bidiConn !== session) {
    throw new Error("Firefox BiDi session does not belong to the selected browser instance");
  }
}

type ChatToolDisposition = "browser" | "catalog" | "independent" | "global-read" | "blocked" | "unknown";

function classifyChatTool(name: string): ChatToolDisposition {
  if (SCOPED_BROWSER_TOOLS.has(name)) return "browser";
  if (SCOPED_CATALOG_TOOLS.has(name)) return "catalog";
  if (INDEPENDENT_TOOLS.has(name)) return "independent";
  if (EXPLICIT_GLOBAL_READ_TOOLS.has(name)) return "global-read";
  if (BLOCKED_IN_SCOPED_CHAT.has(name)) return "blocked";
  return "unknown";
}

/** Backend authorization check; it applies even when allowedToolNames is absent. */
export function assertChatToolAllowed(name: string, scope: ChatBrowserScope | null | undefined): void {
  if (scope === undefined) return;
  if (scope !== null) assertCapturedChatBrowserScope(scope);

  const disposition = classifyChatTool(name);
  if (disposition === "browser") {
    if (scope === null) throw new Error(`Browser tool requires a selected browser environment: ${name}`);
    return;
  }
  if (disposition === "catalog" || disposition === "independent" || disposition === "global-read") return;
  if (disposition === "blocked") throw new Error(`Tool is unavailable in scoped desktop chat: ${name}`);
  throw new Error(`Unclassified tool is unavailable in scoped desktop chat: ${name}`);
}

/**
 * Filter the post-skill tool list for desktop chat. An explicit allowlist keeps
 * newly added global tools from silently becoming available in scoped runs.
 */
export function filterChatTools<T extends { function: { name: string } }>(
  tools: T[],
  scope: ChatBrowserScope | null | undefined,
): T[] {
  if (scope === undefined) return tools;
  if (scope !== null) assertCapturedChatBrowserScope(scope);

  return tools.filter((tool) => {
    const disposition = classifyChatTool(tool.function.name);
    if (disposition === "browser") return scope !== null;
    return disposition === "catalog" || disposition === "independent" || disposition === "global-read";
  });
}
