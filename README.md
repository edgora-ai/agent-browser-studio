# CloakLite

> Local-first browser profile management and AI automation console for CloakBrowser.

CloakLite helps authorized teams manage CloakBrowser profiles, proxies, browser state, AI-assisted workflows, durable automation jobs, audit traces, and S3-compatible sync from a self-hosted Electron desktop app.

**Languages:** [English](README.md) | [简体中文](README.zh-CN.md)  
**User Guide:** [English](docs/USER_GUIDE.en.md) | [简体中文](docs/USER_GUIDE.zh-CN.md)

---

## Important Notice

CloakLite is a dual-use local automation tool. Use it only for lawful, authorized workflows such as QA, localization testing, privacy-preserving personal workflows, authorized business operations, and defensive research.

Do **not** use CloakLite for fraud, spam, credential attacks, unauthorized scraping, platform abuse, ban evasion, fake identity networks, or misuse of cookies, credentials, personal data, or confidential information. See [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md).

---

## Features

| Area | Capabilities |
|---|---|
| CloakBrowser profiles | Install/configure Chromium, create/launch/stop profiles, exact installed-version pins and retained rollback builds, profile tags |
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
git clone https://github.com/edgora-ai/browser-manger.git
cd browser-manger
npm install
npm start
```

### Use the independent Chromium 150 engine

Build Chromium 150 with the independently maintained patch set under
[`patches/chromium`](patches/chromium/README.md), verify it, and install it into
the local OSS engine cache:

```bash
npm run verify:chromium -- /path/to/Chromium.app
npm run install:chromium -- /path/to/Chromium.app
npm start
```

The installer stores versioned builds under `~/.roxy-lite-cloak/`. Profiles use
the newest installed build by default or can pin any exact retained version for
rollback. The profile editor also offers a pass-through mode that disables all
managed identity consumers and exposes the native host fingerprint for stock
comparison. No CloakBrowser license key or login is used.
`CLOAKBROWSER_BINARY_PATH` remains an explicit override, and
the pinned license-free community wrapper is retained only as a legacy fallback
when no independent build is installed. GeoIP defaults to CloakLite's bounded
proxy detector; set `CLOAKBROWSER_GEOIP_AUTO_DOWNLOAD=true` only to opt into the
wrapper-managed GeoIP database. Reinstalling a rebuilt binary with the same
Chromium version compares the executable SHA-256, atomically replaces a changed
build, and retains the prior bundle in a hidden recovery directory.

The current Apple Silicon build is verified at Chromium `150.0.7871.114`:
the strict native harness passes all 53 checked surfaces, the modern/legacy
Storage corpus, 61 system-theme checks and the deep Window/Worker/DOM/Local
Access font corpus, including full WebGL 1/2 and WebGPU adapter/device
capability corpora, same-Profile restart and headed/headless comparison, and
the installed version/input/cookie/proxy journeys pass with Chromium 149
retained for rollback. Patchset `0041` also verifies authenticated SOCKS5 TCP
and UDP, proxy-side DNS and real Profile HTTP/3 through a profile-owned MASQUE
bridge. The app-layer input gate additionally verifies trusted actions through
two nested cross-origin frames, post-layout re-targeting, occlusion rejection
and explicit key-hold timing. This is not a claim of complete
RoxyChrome/CloakBrowser parity. Of 36
engine/network/lifecycle gates, 35 are verified, none remains partial, and 1 is
missing: signed multi-platform distribution. The controlled HTTP/HTTPS/WSS
proxy timing/cache/header corpus and the Stock-150-exact direct
TLS/HTTP2/HTTP3 fingerprint corpus are verified; see
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

1. Install or configure the independently built Chromium 150 binary (149 can remain installed for rollback).
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

## Security, Privacy, and Compliance

CloakLite handles sensitive local data, including browser profile state, cookies, localStorage, proxy credentials, LLM API keys, sync credentials, audit logs, screenshots, and agent traces.

Security controls include:

- Electron renderer sandbox, context isolation, and no Node integration in the renderer
- CSP with self-hosted scripts
- local config permissions and atomic writes
- secret redaction in IPC, UI, export, sync-safe config, and run trace views
- approval gates for HTTP write methods and destructive DB operations
- local/private/link-local/CGNAT blocking for agent HTTP requests
- bounded HTTP/LLM response handling
- safe ZIP/CRX extraction and extension package hash verification
- loopback-only MCP server with bearer-token authentication

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

CloakLite is not affiliated with, endorsed by, sponsored by, or officially connected to Google, Chrome, Chromium, Meta, Facebook, Instagram, TikTok, Amazon, Shopee, OpenAI, Anthropic, AWS, S3-compatible storage providers, or CloakBrowser unless explicitly stated by those parties.
