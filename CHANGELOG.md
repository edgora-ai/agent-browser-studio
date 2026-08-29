# Changelog

All notable user-facing changes to Agent Browser Studio are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions match
`package.json` (enforced by `tests/smoke/changelog.test.ts`).

## [Unreleased]

### Changed

- Fresh installs launch profiles with a **direct connection** until a proxy is
  added and marked ★ default — the previously built-in `127.0.0.1:7890` proxy
  is gone. Existing configs are unaffected.
- **Error messages are human-readable**: toasts now show one-line actionable
  copy in the UI language (proxy fail-closed, engine missing, drift/env gates,
  network failures, permissions, …) instead of raw exception text; the
  original technical message stays in the developer console.
- Jargon softened in the UI: “Team Workspace (RBAC)” → “Team Workspace” with a
  tooltip, CDM path and proxy-risk gate labels rewritten in plain language.
- Clarified proxy option labels: the profile dialog shows “Direct (no default
  proxy configured)” when no default proxy exists.
- First-run wizard no longer dead-ends when the engine is missing — it offers
  “Select local build…” and “Install guide”.
- A one-time **data-safety reminder** appears on the Profiles page once
  profiles exist (export backup / sync / 7-day trash), dismissible.

### Fixed

- Confirmation dialogs no longer lose their callback when a follow-up dialog
  opens quickly (sync push → lock block → force confirm).
- REST/MCP bearer-token comparison is now constant-time; REST request bodies
  are size-limited while streaming and invalid JSON answers 400.
- Config writes no longer fall back silently: the legacy path also fsyncs and
  the in-memory cache always matches what hit the disk.
- Crash safety: unhandled promise rejections and uncaught exceptions are
  logged through observability instead of being lost.
- Docker: the MCP port (26581) is now exposed alongside the REST API (26582).

### Docs

- User Guide rewritten for the full feature surface (batch console, trash,
  presets, locks, RBAC, DRM, adapter hub, updates) in English and Chinese,
  with a troubleshooting table that matches the new error copy.
- Added this changelog.

## [1.0.0] - 2026-08-29

Initial public release: managed Chromium profiles with deterministic
fingerprints, proxies with health scoring and rotation, AI agent with
tool-calling and approval gates, durable automation jobs, audit trail,
S3 sync with team workspace (RBAC + checkout locks), loopback REST API and
MCP server, Python/JS SDKs, and an independently patched Chromium 150 engine.
