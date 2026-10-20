/** Execution facts, not a business verification verdict or a model finish reason. */
export interface AgentToolOutcome {
  ok: boolean;
  error?: string;
}

// Only these tools own operational result flags. Data returned by evaluate,
// HTTP, SQL, variables and catalogs lives inside value/body/rows/etc. Never
// recursively interpret those payloads (an ordinary record may contain error).
const OPERATION_TOOLS = new Set([
  "browser_navigate", "browser_snapshot", "browser_click", "browser_type",
  "browser_screenshot", "browser_scroll", "browser_press_key", "browser_hover",
  "browser_select", "browser_wait_for", "browser_wait_for_load", "browser_get_text",
  "browser_get_url", "browser_get_title", "browser_get_cookies", "browser_new_tab",
  "browser_upload_file", "browser_evaluate", "launch_profile", "http_request",
  "read_file", "write_file", "db_query", "db_exec", "set_var", "get_var",
  "delete_automation_rule", "stop_profile", "install_extension", "delete_extension",
  "skill_install", "approval_resolve", "agent_chat", "agent_chat_simple",
]);
const ERROR_ENVELOPE_KEYS = new Set(["error", "code", "message", "runId"]);

/**
 * Shared by local/desktop traces and MCP isError. A bare service error envelope
 * is recognized for any tool (including unknown-tool errors). Other flags are
 * recognized only on known operation contracts, not on arbitrary business
 * objects or nested data. MCP's agent_browser_ aliases share the same contract.
 */
export function classifyAgentToolOutcome(toolName: string, result: unknown): AgentToolOutcome {
  if (!result || typeof result !== "object" || Array.isArray(result)) return { ok: true };
  const record = result as Record<string, unknown>;
  const name = toolName.replace(/^agent_browser_/, "");
  const operation = OPERATION_TOOLS.has(name);
  const own = (key: string) => Object.hasOwn(record, key);
  const message = (key: string, fallback: string) =>
    own(key) && typeof record[key] === "string" && record[key].trim() ? record[key] as string : fallback;
  const errorEnvelope = own("error") && Object.keys(record).every((key) => ERROR_ENVELOPE_KEYS.has(key));
  if ((operation || errorEnvelope) && own("error") && record.error) {
    return { ok: false, error: message("error", "Tool returned an error.") };
  }
  if (!operation) return { ok: true };
  // Engine-specific negative receipts are owned by these exact contracts.
  if (name === "browser_navigate" && own("errorText") && typeof record.errorText === "string" && record.errorText.trim()) {
    return { ok: false, error: record.errorText };
  }
  if (name === "browser_wait_for" && own("found") && record.found === false) {
    return { ok: false, error: "Requested browser element was not found before the wait ended." };
  }
  if (name === "browser_wait_for_load" && own("loaded") && record.loaded === false) {
    return { ok: false, error: "Browser page did not finish loading before the wait ended." };
  }
  if (own("cancelled") && record.cancelled === true) {
    return { ok: false, error: message("reason", "Tool operation was cancelled.") };
  }
  if (own("skipped") && record.skipped === true) {
    return { ok: false, error: message("reason", "Tool operation was skipped.") };
  }
  if ((name === "http_request" || name === "db_exec") && own("decision") && record.decision === "deny") {
    return { ok: false, error: message("reason", "Tool operation was denied.") };
  }
  if ((own("ok") && record.ok === false) || (own("success") && record.success === false)) {
    return { ok: false, error: message("message", "Tool reported an unsuccessful operation.") };
  }
  return { ok: true };
}
