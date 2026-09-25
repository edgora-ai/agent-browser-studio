# Changelog

All notable user-facing changes to Agent Browser Studio are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions match
`package.json` (enforced by `tests/smoke/changelog.test.ts`).

## [Unreleased]

## [1.0.1] - 2026-09-26

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

- **The Chinese UI no longer leaks English**: ~50 static labels in the renderer
  had no `data-i18n` key, so they stayed English when the interface was
  switched to 中文 — every `Loading…` placeholder, dialog **Close** buttons,
  *Import Existing Profiles*, *Recent Activity*, *Batch result*, the whole
  Agent skill editor, the LLM provider row and the shared-catalog import
  dialog. All of them now have keys in both locales.
- `scripts/check-i18n.mjs` guards this direction as well: it fails the build
  when an element's English text carries no `data-i18n`, matched **per
  element** rather than per line (previously only hard-coded Chinese was
  caught, which is why this class of leak went unnoticed).
- Inline icons sat 1.3–1.6px above their label's optical centre at 11–13px —
  `vertical-align: middle` aligns the x-height half, not the ascent/descent
  midpoint. Icon + text pairs now sit in a flex `.icon-text` host, which also
  lets a long label ellipsis instead of pushing the icon off.
- Proxy cards had a ragged value column: each meta row sized itself
  independently, so “Endpoint”, “Latency” and “Last checked” started at three
  different x positions. The meta block is now one shared grid.
- Team roster role badges (**Owner / Admin / Member**) were painted with the
  bright *fill* colours instead of the text-safe ones — 2.75:1, 4.33:1 and
  2.26:1 against their own tint behind 11px text. All four roles now clear
  WCAG AA in light and dark.
- The Sync page printed a literal `undefined · Owner` device badge whenever the
  sync status payload carried no device name.
- Other labels using fill colours as text — automation “last run” and job error
  lines, cron validation hints, environment-risk severity headers — moved to
  the text-safe palette so they meet AA contrast.
- Confirmation dialogs no longer lose their callback when a follow-up dialog
  opens quickly (sync push → lock block → force confirm).
- REST/MCP bearer-token comparison is now constant-time; REST request bodies
  are size-limited while streaming and invalid JSON answers 400.
- Config writes no longer fall back silently: the legacy path also fsyncs and
  the in-memory cache always matches what hit the disk.
- Crash safety: unhandled promise rejections and uncaught exceptions are
  logged through observability instead of being lost.
- Docker: the MCP port (26581) is now exposed alongside the REST API (26582).
- **Team-role parity on write paths** (R0925 review batch): the in-app
  database SQL box (`agent-db:exec`) and the launch safety gates now enforce
  the same member+ check as their REST counterparts — a viewer can no longer
  write the agent SQLite store or weaken startup safety policy when a team
  workspace is enabled.
- **Run history no longer lies about failed chats**: REST/MCP chats that hit
  the tool-call round limit or returned an empty reply were persisted as
  `done`; they are now recorded as `error` with the real end reason
  (`round_limit` / `execution_error`).
- **Truncated results can no longer come back as "passed"**: when a run's
  evidence snapshot had to be cut to fit the storage budget, the verdict is
  now committed as `manual_review` at the source (manifest and run history
  always agree), restart recovery never overwrites a finalized run, and
  legacy manifests claiming a pass over truncated evidence are downgraded on
  read.
- Cross-platform E2E launchers resolve the Electron binary per platform
  instead of a hard-coded macOS path.

### Docs

- User Guide rewritten for the full feature surface (batch console, trash,
  presets, locks, RBAC, DRM, adapter hub, updates) in English and Chinese,
  with a troubleshooting table that matches the new error copy.
- Product screenshots refreshed (`docs/screenshots/`) from the real renderer in
  the current theme.
- Added this changelog.

## [1.0.0] - 2026-08-29

Initial public release: managed Chromium profiles with deterministic
fingerprints, proxies with health scoring and rotation, AI agent with
tool-calling and approval gates, durable automation jobs, audit trail,
S3 sync with team workspace (RBAC + checkout locks), loopback REST API and
MCP server, Python/JS SDKs, and an independently patched Chromium 150 engine.
