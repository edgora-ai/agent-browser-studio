# Agent Browser Studio User Guide

Agent Browser Studio is a local desktop console for managing isolated profiles on its independently patched Chromium engine, proxies, AI-assisted browser automation, automation jobs, audit traces, and S3-compatible sync.

> Use Agent Browser Studio only for lawful and authorized workflows. Do not use it for fraud, spam, credential attacks, unauthorized scraping, platform abuse, ban evasion, or misuse of cookies, credentials, personal data, or confidential information.

## 1. Installation

### Requirements

- macOS on Apple Silicon
- Node.js 22.16 or newer
- An independently built Chromium patchset installed with `npm run install:chromium -- /path/to/Chromium.app`, or selected through `AGENT_BROWSER_CHROMIUM_BINARY_PATH`

### Start from source

```bash
git clone https://github.com/edgora-ai/browser-manger.git
cd browser-manger
npm install
npm start
```

For development checks:

```bash
npm run build
npm test
```

## 2. First Run

On first launch, if no managed Chromium binary and no profiles exist, a 4-step wizard appears:

1. **Verify Managed Chromium** — confirm the independently built engine is installed.
2. **Create your first profile** — set name, platform, timezone, locale, hardware, WebRTC.
3. **Launch & check fingerprint** — start the profile and open a risk-check page.
4. **Configure AI Agent (optional)** — jump to the Agent config view to wire up an LLM provider.

"Skip for now" hides the wizard only for this session; "Don't show again" persists dismissal. You can also run these steps manually from the tabs at any time.

When upgrading from CloakLite, the first normal launch copies the old user data
and valid managed Chromium versions into the Agent Browser Studio directories.
It verifies the copied Profile tree and leaves the old app, data, and cache
untouched. New Profiles use `ab_` identifiers; migrated `cb_` Profiles remain
fully supported.

## 3. Profile Management

Profiles hold browser state and fingerprint configuration.

Common actions:

- **Launch / Stop**: start or stop a managed Chromium profile.
- **Edit**: update profile metadata and fingerprint fields.
- **Chromium build**: use the newest installed independent build or pin an exact retained version for rollback.
- **Pass-through**: disable managed UA/platform/locale/timezone/WebRTC/GPU/screen/noise consumers for a native-host comparison.
- **Clone / Batch create**: create multiple profiles with deterministic seeds.
- **Consistency check**: compare profile timezone, locale, WebRTC, and proxy detection data.
- **Tags**: organize profiles for batch operations and exports.

Best practices:

- Keep profile naming consistent, for example `market-region-purpose-01`.
- Use tags such as `amazon`, `qa`, `us`, `operator-a`.
- Do not reuse cookies or account data across unrelated workflows.
- Stop profiles before restoring synced localStorage/preferences.

## 4. Proxy Management

Open **Proxies** to add named HTTP, SOCKS5, or SOCKS5H proxies.

Recommended flow:

1. Add proxy host, port, type, and optional credentials.
2. Use **Detect** to test connectivity and collect exit geo information.
3. Assign the proxy to a profile.
4. Run **Consistency Check** before operating a profile.

Notes:

- Proxy credentials are redacted in IPC/UI/export paths.
- The verified Chromium build handles HTTP 407 credentials in the browser
  process; authenticated SOCKS5 TCP uses an ephemeral loopback bridge and
  keeps target DNS resolution at the upstream proxy.
- Managed proxies disable QUIC until a UDP-capable authenticated transport is
  available, so traffic fails closed instead of bypassing the proxy.
- Proxy geo detection results are cached and used for consistency warnings.
- Avoid hard-coding local/private endpoints for production use.

## 5. Cookie, Storage, and Extension Tools

Agent Browser Studio can inspect and manage browser state through CDP or local files when profiles are stopped.

Sensitive data includes:

- Cookies
- localStorage
- preferences
- bookmarks
- extension state
- screenshots
- exported audit bundles

Treat these artifacts as sensitive and do not commit them to Git.

### Extension repository

The extension repository can import local ZIP/CRX packages and cache Chrome Web Store packages.

Safety controls include:

- safe ZIP extraction
- symlink/path traversal rejection
- package and manifest hash checks during sync restore
- extension count and byte limits during pull

## 6. AI Agent

Open **Agent** to configure an LLM provider and run tool-calling browser automation.

### Configure LLM

1. Open **Agent → Config**.
2. Select OpenAI-compatible or Claude provider.
3. Enter API URL, API key, and model.
4. Save configuration.

### Common agent tools

- Browser: navigate, click, type, screenshot, get text, get URL/title, cookies
- Files: sandboxed read/write depending on configured mode
- HTTP: external API requests with approval for write methods
- DB: local agent database query/exec with destructive-operation approval
- Variables: short-lived in-run variables

Security notes:

- Responses stream token-by-token into the chat view (OpenAI-compatible and Claude providers).
- Each send is correlated by a stream id, so concurrent or stale sends do not overwrite the wrong assistant bubble.
- HTTP requests block local/private/link-local/CGNAT targets.
- HTTP write methods require approval.
- Tool traces redact request/response bodies and variable values.
- LLM streaming has byte, event, text, tool-argument, and timeout limits.

## 7. Automation

Automation rules can run actions on schedules or manual triggers.

Supported patterns include:

- opening profiles
- running AI agent tasks
- executing sandboxed JavaScript
- exporting data
- checking profile/proxy consistency
- tracking durable jobs

Use **Automation Jobs** to inspect queued, running, completed, failed, skipped, and cancelled jobs. Agent-task jobs link to their Agent Run traces.

## 8. Sync

Agent Browser Studio supports S3-compatible sync for selected config and profile artifacts.

Before pushing or pulling:

1. Configure endpoint, bucket, access key, and secret key.
2. Use **Preview** to review affected profiles and remote state.
3. Stop running profiles before pull if you need localStorage/preferences restored.
4. Treat remote sync buckets as sensitive storage.

Sync hardening includes:

- secret stripping from sync-safe config
- bounded remote reads
- safe localStorage/preferences restore
- extension package hash verification
- aggregate extension byte limits

## 9. Export and Audit

Data export is intended for debugging, evaluation, and governance.

Export redaction includes:

- proxy credentials removed
- LLM/API secret-like fields removed
- agent run variables represented as keys/metadata, not values
- database export limited to table metadata for sensitive agent DB scopes
- HTTP bodies redacted in traces

Still treat exports as sensitive because they may contain operational metadata, profile names, tags, URLs, timings, and non-secret identifiers.

## 10. Recommended Operating Checklist

Before using Agent Browser Studio in a business workflow:

- Confirm you have authorization for all accounts, websites, and data.
- Review platform terms and applicable laws.
- Use separate profiles for unrelated accounts/workflows.
- Verify proxy geo consistency before operating profiles.
- Keep API keys and sync credentials private.
- Review audit/export files before sharing.
- Run updates and tests before modifying security-sensitive code.

## 11. Troubleshooting

### Electron app does not start

```bash
npm install
npm run build
npm start
```

If Electron was not downloaded correctly, reinstall dependencies:

```bash
rm -rf node_modules
npm install
```

### Tests fail after E2E runs

E2E tests generate local runtime data under `tests/e2e/userdata/`. This directory is ignored and can be removed safely:

```bash
rm -rf tests/e2e/userdata tests/e2e/screenshots dist
```

### LLM tool calling fails

Check:

- provider type
- API URL format
- API key validity
- model name
- tool approval prompts
- network connectivity

### Sync pull skips profile data

Running profiles may skip localStorage/preferences restore to prevent corruption. Stop profiles and retry pull.
