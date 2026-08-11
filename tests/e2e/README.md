# E2E test suite

Drives the **real CloakLite Electron app** via [Playwright's Electron API]
(`playwright._electron`). Each journey launches the app with an isolated
`--user-data-dir`, exercises a full user path, and tears down all spawned
Chromium processes.

## Layout

```
tests/e2e/
  journey.test.ts            # fast smoke (10 steps, ~10s) — runs in `npm test`
  j1-profile-launch.test.ts  # J1: create → launch → CDP fingerprint verify → stop
  j2-batch-profiles.test.ts  # J2: bulk-import 3 → Start All → distinct ports/dirs/fp → Stop All
  j3-extensions.test.ts      # J3: add Chrome ext → enable → launch → --load-extension (network-gated)
  j4-agent-stream.test.ts    # J4: mock LLM → config → chat → stream → persist after restart
  j5-*.test.ts … j43-*.test.ts # agent, security, jobs, sync, UI and native verification journeys
  j44-humanized-input.test.ts # trusted native mouse/keyboard/wheel + exact scroll completion
  j45-*.test.ts … j49-*.test.ts # version/cookie/proxy/HTTP3 release gates
  j50-nested-frame-humanization.test.ts # cross-origin OOPIF actionability + key timing
  helpers/
    app.ts                   # setupTestApp / closeApp / wizard-dismiss / stopAllProfiles
    cdp.ts                   # CDP client (ws) — Browser.getVersion, Runtime.evaluate, target polling
    mock-llm.ts              # OpenAI-compatible SSE mock server on a free port
    diag.ts                  # screenshots, closeAllDialogs, console-error filtering
    find.ts                  # language-agnostic locators (data-tab, data-cmd)
  screenshots/               # PNG evidence per step
  userdata/                  # per-journey isolated Electron userData
```

## Run

```bash
# Fast suite: unit + smoke + core journey (~10s)
npm test

# All deep journeys (network/platform-specific cases auto-skip without prerequisites)
npm run test:e2e

# One journey at a time
npm run test:e2e:j1
npm run test:e2e:j2
npm run test:e2e:j3   # needs Chrome Web Store network → set E2E_EXTENSION_NETWORK=1
npm run test:e2e:j4

# README images are protected by default; update them only with explicit intent
UPDATE_README_SCREENSHOTS=1 npx vitest run -c vitest.config.e2e.ts tests/e2e/j-screenshots.test.ts
```

## What each journey verifies

| Journey | Asserts |
|---------|---------|
| **J1** | `Browser.getVersion` UA contains `Windows NT 10.0`; `navigator.platform === "Win32"`; CDP port closes after stop |
| **J2** | 3 distinct CDP ports; 3 isolated `--user-data-dir`; 3 distinct `--fingerprint=<seed>`; all ports refuse connections after Stop All |
| **J3** | `manifest.json` on disk; `--load-extension=` + `--disable-extensions-except=` in `ps aux`; path references the extension id |
| **J4** | ≥3 `agent:stream-chunk` events; full text rendered; mock received exactly 1 request with `"hi"`; conversation + assistant reply persist after app restart |
| **J44** | trusted curved mouse/keyboard/wheel events and exact occluded-window scroll completion |
| **J45–J48** | exact version pin/rollback, pass-through, third-party cookies and authenticated HTTP/SOCKS routing |
| **J49** | real Profile H3 over RFC 9298 CONNECT-UDP and SOCKS5 UDP ASSOCIATE; helper lifecycle and credential isolation |
| **J50** | trusted type/click/key events through two cross-origin OOPIF levels, post-layout re-targeting, covered-target rejection and explicit key-hold timing |

## Prerequisites

- **Chromium binary** installed under `~/.roxy-lite-cloak/chromium-<ver>/`,
  cached at the legacy `~/.cloakbrowser/chromium-<ver>/`, or selected with
  `CLOAKBROWSER_BINARY_PATH`. `setupTestApp` prefers the independent cache and
  chooses its newest version without a network lookup.
- **J3 only**: needs to reach `clients2.google.com`. Either:
  - `E2E_EXTENSION_NETWORK=1` — host has direct internet, OR
  - `E2E_TEST_PROXY=http://host:port` (or `socks5://...`) — host can't reach
    Google directly but a proxy can. The app's default proxy is configured via
    IPC so the CRX download routes through it (the real product path).
  - Otherwise J3 is skipped.
- **J49 only**: set `ROXY_E2E_SOCKS5_UDP_URL` to an authorized UDP-capable
  `socks5://` or `socks5h://` endpoint. It is skipped when no endpoint is set.
- Runs **serially** (no file parallelism) — only one test Electron app at a
  time. MCP prefers port 26581 and falls back to an ephemeral loopback port if
  another installed instance already owns it.

## Troubleshooting

- **`launch success: false`**: an orphaned browser may still own a profile or
  CDP port. Stop the matching test app/profile and rerun.
- **J2 `launched.length === 0`**: same cause — orphaned Chromium holds the CDP
  ports. Clean and rerun.
- Flaky failures usually mean a process leaked; `closeApp` SIGKILLs orphans via
  `pkill -f` on the userData dir + `.cloakbrowser`.
