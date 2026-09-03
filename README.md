# Agent Browser Studio

> Local-first browser profile management and AI automation console for an independently patched Chromium engine.

Agent Browser Studio helps authorized teams manage isolated Chromium profiles, proxies, browser state, AI-assisted workflows, durable automation jobs, audit traces, and S3-compatible sync from a self-hosted Electron desktop app.

**Languages:** [English](README.md) | [简体中文](README.zh-CN.md)  
**User Guide:** [English](docs/USER_GUIDE.en.md) | [简体中文](docs/USER_GUIDE.zh-CN.md)

---

## Important Notice

Agent Browser Studio is a dual-use local automation tool. Use it only for lawful, authorized workflows such as QA, localization testing, privacy-preserving personal workflows, authorized business operations, and defensive research.

Do **not** use Agent Browser Studio for fraud, spam, credential attacks, unauthorized scraping, platform abuse, ban evasion, fake identity networks, or misuse of cookies, credentials, personal data, or confidential information. See [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md).

---

## Features

| Area | Capabilities |
|---|---|
| Managed Chromium profiles | Verify/configure independently built Chromium, create/launch/stop profiles, exact installed-version pins and retained rollback builds, profile tags |
| Fingerprint settings | Managed deterministic identity or native-host pass-through; platform, timezone, locale, WebRTC, GPU, screen, CPU, memory, storage quota, fonts |
| Proxy management | Named HTTP/SOCKS proxies, IPv4/IPv6 environment URLs, credentials redaction, per-profile assignment, proxy geo detection |
| Browser state | Cookies, localStorage, preferences, bookmarks, extension state, storage inspection |
| Extension repository | Local ZIP/CRX import, Chrome Web Store package cache, safe extraction, sync hash verification |
| AI Agent | OpenAI-compatible and Claude providers, tool calling, browser control, file/HTTP/DB tools, run traces |
| Skills and templates | Built-in skills, import/exportable recipes, task templates, platform adapters |
| Automation | Scheduled/manual rules, durable jobs, job/run linkage, automation job UI |
| Sync | S3-compatible config/profile artifact sync with preview, bounded reads, restore hardening |
| Audit/export | Activity timeline, run traces, redacted export bundles, cross-object links |
| Security hardening | Renderer sandbox, context isolation, CSP, approval gates, SSRF blocking, redaction boundaries |

---

## Screenshots

| Profiles | Agent |
|---|---|
| ![Profiles](docs/screenshots/profiles.png) | ![Agent Chat](docs/screenshots/agent-chat.png) |
| **Wizard** | **Sync** |
| ![Wizard](docs/screenshots/wizard.png) | ![Sync](docs/screenshots/sync.png) |
| **Automation** | **Activity** |
| ![Automation](docs/screenshots/automation.png) | ![Activity](docs/screenshots/activity.png) |
| **Runs** | **Proxy** |
| ![Runs](docs/screenshots/runs.png) | ![Proxy](docs/screenshots/proxy.png) |

---

## Quick Start

### Requirements

- macOS on Apple Silicon
- Node.js 22.16 or newer
- Go 1.25 or newer (builds the packaged MASQUE/SOCKS helper)
- npm

### Install and run

```bash
git clone https://github.com/edgora-ai/agent-browser-studio.git
cd agent-browser-studio
npm install
npm start
```

### Use the independent Chromium engine

Build Chromium 152 with the independently maintained patch set under
[`patches/chromium`](patches/chromium/README.md), verify it, and install it into
the local OSS engine cache:

```bash
npm run verify:chromium -- /path/to/Chromium.app
npm run install:chromium -- /path/to/Chromium.app
npm start
```

The installer stores versioned builds under `~/.agent-browser-studio/`. Profiles use
the newest installed build by default or can pin any exact retained version for
rollback. The profile editor also offers a pass-through mode that disables all
managed identity consumers and exposes the native host fingerprint for stock
comparison. No external browser wrapper, license key, login, or upstream update
service is used. `AGENT_BROWSER_CHROMIUM_BINARY_PATH` is the explicit binary
override and `AGENT_BROWSER_CHROMIUM_CACHE_DIR` overrides the managed cache root.
When no independent build is installed, profile launch fails closed instead of
downloading or selecting a fallback. GeoIP uses Agent Browser Studio's bounded proxy
detector. Reinstalling a rebuilt binary with the same
Chromium version compares a runtime build hash covering the launcher, Framework,
and key resource payloads, atomically replaces a changed
build, and retains the prior bundle in a hidden recovery directory.

On the first normal launch, existing data is copied non-destructively from
`~/Library/Application Support/CloakLite` to
`~/Library/Application Support/AgentBrowserStudio`, and valid managed Chromium
versions are copied from `~/.roxy-lite-cloak` to `~/.agent-browser-studio`.
The old app, data, and cache remain untouched. Legacy `cloakBin`,
`cloakProfiles`, `cloak-profiles/`, and `cb_` values remain readable only as a
compatibility boundary; new data uses `chromiumBin`, `browserProfiles`,
`profiles/`, and `ab_`. No CloakBrowser or RoxyBrowser component is selected,
downloaded, licensed, or invoked.

Sensitive config fields use Electron's OS credential storage in a verified
team-signed build. Local/ad-hoc macOS builds instead use an AES-256-GCM vault
with a random mode-0600 key beside `config.json`; Electron and managed Chromium
also use the mock Keychain backend in that local mode, so rebuilding does not
cause repeated macOS authorization prompts. Existing `CloakLite Safe Storage`
values are converted once and atomically, without deleting the legacy
Keychain item or writing plaintext to the config file.

The current Apple Silicon build is verified at Chromium `152.0.7977.72`
(commit `026bb13a93d60e7adfefa2bbf58d6f57c2d335cc`). The managed-cache bundle
passes the Stock-152 WebGL/WebGPU/font/OPFS gate (8/8), the strict native harness
(`ok: true`, 53 checked surfaces), 61 system-theme checks, persistent restart,
headed/headless and native-host pass-through comparisons. The full application
suite explicitly bound to the 152 executable passes 95 E2E files / 470 tests
(with 4 files / 12 tests intentionally skipped), while 149/150 remain available
for exact pin and rollback coverage. A real proxy/Ping0 run completed with zero
browser-identity failures; its remaining findings were external proxy/site
network-boundary signals. Patchsets `0041`–`0050` retain SOCKS5 TCP/UDP and
HTTP/3 routing, the public `agent-browser-*` protocol, managed Google-key infobar
suppression, proxy-bound secure DNS, native locale/font/refresh behavior,
Widevine registration and append-only Chromium-152 compilation/resume fixes.
RoxyChrome/CloakBrowser remain historical comparison targets, not runtime
dependencies. The controlled HTTP/HTTPS/WSS and Stock-150 TLS/HTTP2/HTTP3 wire
corpora remain the latest recorded network references; the 152 native
capability evidence is documented in
[`UPGRADE_152.md`](patches/chromium/UPGRADE_152.md) and
[`ALIGNMENT_MATRIX.md`](patches/chromium/ALIGNMENT_MATRIX.md).

### Development checks

```bash
npm run build
npm test
```

Targeted E2E examples:

```bash
npm run build
npx vitest run -c vitest.config.e2e.ts tests/e2e/j34-credential-vault.test.ts
npx vitest run -c vitest.config.e2e.ts tests/e2e/j45-version-pin-pass-through.test.ts
npx vitest run -c vitest.config.e2e.ts tests/e2e/j50-nested-frame-humanization.test.ts
```

> E2E runs generate local browser data under `tests/e2e/userdata/`; this directory is ignored and must not be committed.

---

## First-Run Workflow

1. Install or configure the independently built Chromium 152 binary (149/150 can remain installed for rollback).
2. Open **Profiles** and create a profile.
3. Optional: open **Proxies**, add a proxy, and assign it to the profile.
4. Launch the profile and run **Check Risk** / consistency checks.
5. Optional: open **Agent**, configure an LLM provider, and run an authorized browser automation task.
6. Optional: open **Automation** to create scheduled or manual rules.
7. Optional: configure **Sync** only after reviewing the privacy and security notes.

See the full [English User Guide](docs/USER_GUIDE.en.md) or [中文使用手册](docs/USER_GUIDE.zh-CN.md).

---

## Project Structure

```text
src/
  main/
    index.ts              Electron entry, window, tray, MCP bootstrap
    preload.cjs           contextBridge API
    ipc/                  IPC handler modules
    services/             business logic and persistence
    types.ts              shared interfaces
  renderer/
    index.html            UI shell
    css/                  renderer styles
    js/                   modular renderer application
tests/
  unit/                   service and hardening tests
  e2e/                    Playwright Electron journeys
  smoke/                  structural checks
docs/                     user guides and roadmap
patches/chromium/         independent Chromium source patches and acceptance matrices
resources/                app icons
```

---

## Local REST API (loopback)

Agent Browser Studio ships a loopback-only JSON REST API for tooling, CI and
automation, alongside the MCP server. It reuses the same service layer, so
everything you can do in the UI you can script.

- **Port**: `26582` by default (override with `AGENT_BROWSER_API_PORT` or
  `CLOAK_API_PORT`); falls back to an ephemeral loopback port when busy.
- **Auth**: every endpoint except `GET /health` and `GET /openapi.json`
  requires the bearer token from `AGENT_BROWSER_API_TOKEN` (or `CLOAK_API_TOKEN`).
  When unset, a random token is generated and can be revealed from the app's
  developer surface. Send it as `Authorization: Bearer <token>` or
  `X-Agent-Browser-Token: <token>`.
- **Discoverability**: `GET /openapi.json` serves an OpenAPI 3.0 document you
  can feed to Swagger UI, Postman, or an SDK generator.

Main resources:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/profiles` | List managed Chromium profiles |
| POST | `/api/profiles` | Create a profile |
| GET/DELETE | `/api/profiles/{dirId}` | Profile detail / delete (stopped only) |
| POST | `/api/profiles/{dirId}/launch` | `/stop` | Start / stop the profile's Chromium (body `{"headless": true}` launches headless) |
| GET | `/api/profiles/{dirId}/status` | Running state + CDP port |
| GET | `/api/profiles/{dirId}/drift` | Read-only fingerprint drift check vs stored baseline |
| GET | `/api/profiles/{dirId}/env-risk` | Host environment risk report (DNS / CN fonts / proxy DNS / rAF) |
| GET/POST | `/api/proxies` | List / add proxies |
| PATCH/DELETE | `/api/proxies/{name}` | Update / delete a proxy |
| GET | `/api/proxies/health` | Health score / risk / bindings / suggestions |
| POST | `/api/proxies/{name}/rotate` | Manually rotate to the first healthy fallback |
| GET | `/api/accounts` | Stored account usernames + platform URLs |
| GET | `/api/automation/rules` | Automation rules |
| GET | `/api/runs` | `/api/jobs` | Agent runs / automation jobs |
| GET/DELETE | `/api/audit` | Audit trail |
| GET/POST | `/api/drm/status` `/api/drm/cdm-path` `/api/drm/ensure` | Widevine/DRM discovery + managed CDM staging |
| GET | `/api/team` | Team workspace RBAC status (members, roles, enforcement) |
| POST/DELETE/PUT | `/api/team/members{/deviceId}[/role]` | Add / remove / re-role workspace members |
| GET | `/api/updates/status` | Release store status (active / pinned / installed / history) |
| POST | `/api/updates/check` `/install` `/activate` `/rollback` | Check manifest, stage, pin, or roll back a release |

Example:

```bash
TOKEN="$(export AGENT_BROWSER_API_TOKEN=my-token; echo my-token)"
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:26582/api/profiles
```

The MCP server remains available on `26581` for AI tools (Claude Code,
Cursor, etc.) and exposes the same browser/db/http capabilities.

---

## Server Mode & Docker

Agent Browser Studio can run as a headless server (no window, no tray) for
Linux VMs, containers and CI runners. The scheduler, MCP and REST API stay
active, so automation keeps working without a desktop session.

- **Start**: `npx electron . --headless` (or `--server`), or set
  `AGENT_BROWSER_HEADLESS=1` / `CLOAK_HEADLESS=1`.
- **Health**: `GET /health` reports `mode: "headless"`, version, profile
  count and uptime - use it as the orchestration readiness probe.
- **Docker**: the included `Dockerfile` and `docker-compose.yml` build a
  controller image with the masque bridge and Node 22 runtime, run in
  headless mode and expose the REST API on `26582`.

```bash
docker compose up --build -d
curl -s http://127.0.0.1:26582/health
```

## Python SDK

`sdk/python/agent_browser_client.py` is a zero-dependency (stdlib-only) REST
client for the control API - profiles, proxies, DRM, team RBAC, runs and
jobs. It works identically against the desktop app and headless server mode.

```bash
export AGENT_BROWSER_API_TOKEN=my-token
python3 sdk/python/example.py --base-url http://127.0.0.1:26582 --token "$AGENT_BROWSER_API_TOKEN"
```

JavaScript/.NET consumers can generate clients from `GET /openapi.json`. See
[sdk/python/README.md](sdk/python/README.md) for the full walkthrough.

## JavaScript SDK

`sdk/js/agent-browser.mjs` is a zero-dependency JS client with one-call
Playwright / Puppeteer adapters: `connectPlaywright` / `connectPuppeteer`
create and launch a managed profile, wait for its CDP endpoint, and return a
real Playwright `Browser` (or Puppeteer `Browser`) — swap the import and keep
your existing automation code. Profiles launch headless by default so rAF and
actionability checks stay unthrottled; pass `headless: false` for a visible
window. The fingerprint (UA / screen / languages / timezone / webdriver)
comes from the C++-level profile config, verified by the `j73` e2e suite.

```bash
export AGENT_BROWSER_API_TOKEN=my-token
node sdk/js/example.mjs
```

See [sdk/js/README.md](sdk/js/README.md) for the full walkthrough.

---

## Security, Privacy, and Compliance

Agent Browser Studio handles sensitive local data, including browser profile state, cookies, localStorage, proxy credentials, LLM API keys, sync credentials, audit logs, screenshots, and agent traces.

Security controls include:

- Electron renderer sandbox, context isolation, and no Node integration in the renderer
- CSP with self-hosted scripts
- local config permissions and atomic writes
- secret redaction in IPC, UI, export, sync-safe config, and run trace views
- approval gates for HTTP write methods and destructive DB operations
- local/private/link-local/CGNAT blocking for agent HTTP requests
- bounded HTTP/LLM response handling
- safe ZIP/CRX extraction and extension package hash verification
- loopback-only MCP server and REST API with bearer-token authentication

Read before use:

- [SECURITY.md](SECURITY.md)
- [PRIVACY.md](PRIVACY.md)
- [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md)
- [NOTICE.md](NOTICE.md)

---

## Known Limitations

| Area | Current state |
|---|---|
| Platform support | macOS on Apple Silicon is supported out of the box. Windows/Linux cross-platform code paths exist but are not yet fully verified end-to-end. |
| i18n | zh-CN and en-US are supported with runtime switching. The core UI, sidebar, wizard, tray, and Automation/Runs/Activity/DB/Approval/Sync/Agent-config/Extensions modules are translated; a few long-form template prompts retain Chinese fallbacks. |
| Agent chat streaming | Live token streaming is supported for OpenAI-compatible and Claude providers. Tool-call metadata is emitted after each tool-call block completes; tool execution blocks the next streaming round. |
| Onboarding wizard | A 4-step first-run wizard (install binary → create profile → launch + risk check → optional AI config) appears when no binary or profiles exist. |
| Renderer architecture | The renderer is modular vanilla JS loaded by script tags; it is not bundled. Some modules remain large and rely on a shared global namespace. |
| E2E tests | Unit/smoke tests run in CI. E2E (Playwright Electron) journeys require a real Electron environment and an independent Chromium binary, so they are not all run in CI yet. |

---

## Testing and Release Checklist

Before publishing or sharing a build:

```bash
npm run build
npm test
npm audit --json
```

Recommended repository hygiene checks:

```bash
rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!.git/**' 'sk-|AKIA|BEGIN .*PRIVATE KEY|github_pat_|ghp_' . || true
git status --short --ignored
```

Do not commit:

- `.env` or local config files
- sqlite/db files
- Cookies, Local Storage, Session Storage
- audit logs, screenshots, exported bundles
- `dist/`, `node_modules/`, E2E userdata

---

## Documentation

- [User Guide — English](docs/USER_GUIDE.en.md)
- [使用手册 — 简体中文](docs/USER_GUIDE.zh-CN.md)
- [Improvement Roadmap](docs/improvement-roadmap.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Privacy Notice](PRIVACY.md)
- [Acceptable Use Policy](ACCEPTABLE_USE.md)

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and include tests for security-sensitive or persistence-related changes.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Trademarks and Non-Affiliation

Agent Browser Studio is not affiliated with, endorsed by, sponsored by, or officially connected to Google, Chrome, Chromium, Meta, Facebook, Instagram, TikTok, Amazon, Shopee, OpenAI, Anthropic, AWS, S3-compatible storage providers, CloakBrowser, or RoxyBrowser unless explicitly stated by those parties.
