# Agent Browser Studio User Guide

Agent Browser Studio is a local desktop console for managing isolated browser profiles on an independently patched Chromium engine (with optional Firefox), proxies, AI-assisted automation, durable jobs, audit trails, and S3-compatible team sync.

> Use Agent Browser Studio only for lawful and authorized workflows. Do not use it for fraud, spam, credential attacks, unauthorized scraping, platform abuse, ban evasion, or misuse of cookies, credentials, personal data, or confidential information. See [ACCEPTABLE_USE.md](../ACCEPTABLE_USE.md).

## 0. The console at a glance

| Sidebar tab | What it is for |
|---|---|
| 📦 Profiles | Create, launch, stop, organize, and clean up browser profiles |
| 🔌 Proxies | Named proxies, health scoring, rotation, one-click binding, QR export |
| 💾 Storage | Disk usage per profile, cache cleanup, data-safety reminders |
| ☁️ Sync | S3 backup, team workspace (roles, locks), push/pull diff preview |
| 🥷 Browser Engine | Verify the managed engine, DRM, launch safety gates, app updates |
| 🧩 Extensions | Private extension catalog shared across profiles |
| 🔑 Accounts | Platform accounts (usernames, tags, profile binding); secrets never shown in the UI |
| 🤖 Agent | AI chat that can drive profiles, plus skills and platform adapters |
| ⏰ Automation | Scheduled / one-shot / event-triggered tasks with durable jobs |
| 🤖 Runs | Step-by-step traces of every agent task |
| 📜 Activity | Audit timeline: who did what to which asset, and when |
| 📊 Database | The agent's local SQLite database (read + guarded write) |

## 1. Install and run

Requirements today: **macOS on Apple Silicon**, Node.js 22.16+, and an independently built Chromium placed in the managed cache.

```bash
git clone https://github.com/edgora-ai/agent-browser-studio.git
cd agent-browser-studio
npm install
npm start
```

Install the engine from a prebuilt Chromium.app:

```bash
npm run verify:chromium -- /path/to/Chromium.app
npm run install:chromium -- /path/to/Chromium.app
```

Windows / Linux paths exist but are not fully verified end-to-end yet; a headless server mode (`--headless`) and Docker image are available for CI.

**If the engine is missing** the Profiles page shows a banner with **“Select local build…”** and **“Install guide”** buttons, and the first-run wizard offers the same two escape hatches — you never hit a dead end.

## 2. First run

If no engine or no profiles exist, a 4-step wizard appears:

1. **Verify Managed Chromium** — confirm the engine (or pick a local build).
2. **Create your first profile** — only a name is required.
3. **Launch & risk check** — starts the profile and opens a fingerprint check page.
4. **Configure the AI Agent (optional)** — jump to the Agent config view.

“Skip for now” only hides the wizard for this session; “Don't show again” persists. The wizard can be re-run from the Browser Engine tab.

Upgrading from CloakLite? The first launch copies old data and engine builds non-destructively; legacy `cb_` profiles keep working.

## 3. Profiles

### Create

- **+ New Browser Profile** opens a form where **only the name is required** — platform defaults to Windows, identity fields auto-derive from the fingerprint seed, and everything else lives under **⚙️ Advanced configuration** (seed, timezone, locale, WebRTC, geolocation, hardware overrides, DRM, window-title, Web-App URL).
- **🎯 Business Preset** pre-fills a coherent identity (TikTok Shop US, Amazon Seller US, eBay UK, EU commerce DE, crypto SG, and more).
- **⚡ Quick Create** makes a profile in one click, no form.
- **📥 Bulk Import** pastes one profile per line (`name, platform, locale, timezone, seed, webrtcIp`) or CSV with headers.

### Everyday operations

- **▶ Launch / ⏹ Stop** start and stop the profile's browser. Launch runs safety checks first (see *Launch safety gates*).
- Per-profile tools: ✎ Edit, 🍪 Cookies, 🧩 Extensions, 📦 Export backup, ✏️ Rename, 📝 Note, 🔒 Lock to device, 📋 Logs, 🧬 Drift check, 🖥 Env check, 📡 WebRTC diagnostic, 🎬 DRM, 🖥 App mode.
- **Filters & batch console**: filter by status (running/stopped) and tags, select all visible, then batch-launch, batch-stop, batch-assign a proxy, batch-export, or batch-delete. Bulk deletes above 10 items require an acknowledgement tick.

### Trash (accident protection)

Deleted profiles go to a **trash area for 7 days** — the success toast has an **Undo** button, and trash can be inspected/restored from the Profiles header. Permanent purge happens automatically after the retention window.

### Locks (team checkout)

🔒 **Lock to device** marks a profile as checked out by this machine. Other devices' pushes are refused (force-push still possible after confirmation). The lock syncs with the profile.

### Fingerprint trust loop

- **🧬 Drift** compares the live fingerprint against the stored baseline; risky drift can block launch (toggle in Browser Engine → Launch safety gates).
- **🖥 Env** checks host-level leaks: DNS resolvers, Chinese system fonts (measured inside the profile, not guessed), proxy DNS behavior, and rAF timing, each with a suggested fix.
- **📡 WebRTC** runs a real ICE probe inside the profile and shows whether host IPs leak.
- **📋 Logs** shows the profile's recent audit activity plus the browser launch log tail.

## 4. Proxies

- **+ Add Proxy** (HTTP / SOCKS5 / SOCKS5H, optional credentials and bypass list). You can also paste a list via **📥 Import** (`type://user:pass@host:port`, `host:port`, or CSV) and **📤 Export** to CSV.
- **No proxy is forced on you**: fresh installs launch profiles with a **direct connection** until you add a proxy and mark it ★ default. The profile dialog says “Direct (no default proxy configured)” so it is never a surprise.
- **🔍 Detect** measures latency, exit IP, country, timezone, and flags **🏭 datacenter (IDC) / public-proxy** exits — the most common account-risk source.
- **Health scoring**: every detection updates a rolling health score, history timeline, and suggestions (e.g. “switch to a residential exit”).
- **Rotation & fallbacks**: configure fallback proxies per proxy; when the primary degrades, profiles automatically rotate to the first healthy fallback and rotate back on recovery. 🔄 Rotate forces it manually.
- **📎 Bind** binds the proxy to many profiles in one dialog; **📱 QR** exports the full proxy URI (including credentials — treat the QR like a password) for phone setup.

## 5. Browser engine tab

- **Independent Browser Engine**: shows installed builds; pin an exact version per profile for rollback; **Verify** runs the strict check.
- **🎬 Widevine / DRM**: detect the host CDM, stage a managed copy, and enable DRM per profile for streaming sites.
- **🛡 Launch safety gates** (each toggle saves immediately):
  - block on consistency conflict (timezone/locale/WebRTC vs proxy)
  - block on datacenter/public-proxy exits
  - block on fingerprint drift
  - block on environment risk
  Gates refuse the launch before a browser opens — protecting the account, not just warning.
- **🔄 App Updates**: check the update manifest, stage, activate, and roll back releases; crash-loop auto-rollback is built in.

## 6. Extensions

A private catalog shared by all profiles: import local CRX/ZIP or unpacked dirs, add from the Chrome Web Store, tag, and mark entries as shared. Profiles simply pick which catalog entries to enable. Extraction is hardened (path traversal / symlink rejection, hash checks).

## 7. Accounts

Store platform accounts (URL, username, tags) and bind them to profiles. Passwords are encrypted at rest and **never displayed**; “copy password” decrypts in the main process and writes the clipboard. **📥 Bulk Import** can also create one bound profile per account, and **⬇ Export CSV** contains metadata only. When a Team Workspace is enabled, viewer roles cannot read or mutate account secrets.

## 8. Agent (AI)

- **Config**: pick OpenAI-compatible or Claude, set URL/key/model (keys are encrypted at rest, redacted everywhere). File access modes: sandbox dir / allowlist / open (high risk).
- **Chat**: streaming chat with tool calling — the agent can navigate, click, fill forms, screenshot, read cookies, and run HTTP/DB/file tools on the profile you point it at. Sensitive HTTP writes and destructive DB operations trigger an **approval dialog** (allow once / always / deny).
- **Skills**: reusable prompt/tool recipes; import/export shared catalogs.
- **🔌 Adapter Hub**: versioned selector recipes for 15 platforms (Amazon, Shopee, TikTok Shop, Instagram, Google Ads, X, LinkedIn, YouTube, crypto exchanges, EU marketplaces, …) the agent loads for login checks and data collection.
- **Runs tab** records every run as a step timeline (tools, variables, durations) for auditing.

## 9. Automation

Rules combine triggers (cron, one-shot, profile launch/exit events) with actions (launch/stop profile, run an agent task, sync push/pull, sandboxed JS). Executions are **durable jobs**: queued, concurrency-limited, timeout-guarded, retried with backoff, and visible in the Jobs list with cancel support. A 24.8-day cron overflow bug class is covered by regression tests.

## 10. Sync & team workspace

1. **Configuration**: endpoint, bucket, access key, secret key (encrypted at rest).
2. **Pre-flight preview** shows what a push/pull will touch; **Team Diff** compares local vs remote and warns before a push would *remove* remote data.
3. **Team Workspace (RBAC)**: owner / admin / member / viewer roles propagate with sync. Viewers are read-only; admins manage members; the manifest is enforced on push.
4. **Checkout locks** (see Profiles) prevent two devices from overwriting each other.

Treat the S3 bucket as sensitive storage: secrets are stripped from sync payloads, but cookies and profile state are real account data.

## 11. Data & backups — please read once

- Everything lives on **this machine**: `<user-data>/profiles/…` (cookies, localStorage), plus the encrypted credential vault and audit logs.
- **Disk failure = account loss.** Use at least one of: **📦 Export backup** per profile, **☁️ Sync** to an S3 bucket, or the **trash window** (7 days) for accidental deletes.
- The Storage tab shows per-profile disk usage and keeps data-safety reminders visible.

## 12. Integration surfaces (for developers)

- **REST API** on `127.0.0.1:26582` — OpenAPI 3.0 at `/openapi.json`, bearer-token auth (`AGENT_BROWSER_API_TOKEN`). Covers profiles, proxies, accounts, automation, jobs, agent, DRM, team, updates.
- **MCP server** on `127.0.0.1:26581` for Claude Code / Cursor & other MCP clients.
- **Python & JS SDKs** (`sdk/python`, `sdk/js`) — including `connectPlaywright` / `connectPuppeteer` one-call adapters that return a real Playwright/Puppeteer browser bound to a managed profile.

## 13. Recommended operating checklist

- Confirm authorization for every account, site, and dataset you touch.
- One workflow per profile; never share cookies across unrelated accounts.
- Run **Detect** on proxies and resolve 🏭 IDC warnings before serious accounts.
- Run 🧬 Drift / 🖥 Env after any engine update or host change.
- Keep API keys and sync credentials private; exports are metadata-safe but still sensitive.
- Review 📜 Activity when something looks off — every sensitive action is recorded.

## 14. Troubleshooting

Errors in the app are written in plain language with a suggested next step; the original technical text is always available in the developer console. Common cases:

| Message (paraphrased) | Meaning | Fix |
|---|---|---|
| “This profile needs a working proxy … Launch was refused” | Fail-closed proxy protection | Check the proxy process/port and health; re-assign or relax the profile's proxy |
| “Managed browser engine is missing” | No usable engine build | Browser Engine tab → install guide / select local build |
| “Launch blocked: fingerprint drift …” | Live fingerprint ≠ stored baseline | Open 🧬 Drift, review, clear baseline if the change was intended |
| “Launch blocked by the environment risk gate” | DNS / fonts / proxy-DNS finding | Open 🖥 Env for findings and fixes |
| “Connection refused” | Local proxy down or wrong port | Start the proxy or fix the port |
| “Permission denied: … (viewer)” | Team role is read-only | Ask an admin to change your role |
| Pull skipped some localStorage | Running profiles are protected | Stop those profiles and pull again |

### App does not start (source runs)

```bash
rm -rf node_modules && npm install && npm run build && npm start
```

### E2E leftovers

`tests/e2e/userdata/`, `tests/e2e/screenshots/`, and `dist/` are local runtime artifacts and can be deleted safely.
