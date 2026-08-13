// Headless server mode detection for the controller application.
//
// When the controller runs with --headless (or --server, or
// AGENT_BROWSER_HEADLESS=1) it skips the GUI window and tray and keeps only
// the headless surfaces: REST API, MCP server, automation scheduler and sync.
// Managed Chromium profiles still launch as separate processes and expose
// CDP, so profile automation works without a desktop window.
export function isHeadlessMode(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  return argv.includes("--headless")
    || argv.includes("--server")
    || env.AGENT_BROWSER_HEADLESS === "1"
    || env.CLOAK_HEADLESS === "1";
}

export interface ServerModeInfo {
  mode: "headless" | "gui";
  flags: string[];
}

export function serverModeInfo(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): ServerModeInfo {
  const flags: string[] = [];
  if (argv.includes("--headless")) flags.push("--headless");
  if (argv.includes("--server")) flags.push("--server");
  if (env.AGENT_BROWSER_HEADLESS === "1") flags.push("AGENT_BROWSER_HEADLESS=1");
  if (env.CLOAK_HEADLESS === "1") flags.push("CLOAK_HEADLESS=1");
  return { mode: isHeadlessMode(argv, env) ? "headless" : "gui", flags };
}
