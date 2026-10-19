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

- **+ New Browser Profile** opens a form where **only the name is required** — on supported hosts, platform defaults to the host OS (macOS on a Mac, Windows on Windows), identity fields auto-derive from the fingerprint seed, and everything else lives under **⚙️ Advanced configuration** (seed, timezone, locale, WebRTC, geolocation, hardware overrides, DRM, window-title, Web-App URL).
- **🎯 Business Preset** pre-fills a coherent identity (TikTok Shop US, Amazon Seller US, eBay UK, EU commerce DE, crypto SG, and more).
- **⚡ Quick Create** makes a profile in one click, no form.
- **📥 Bulk Import** pastes one profile per line (`name, platform, locale, timezone, seed, webrtcIp`) or CSV with headers.

### Everyday operations

- **▶ Launch / ⏹ Stop** start and stop the profile's browser. Launch runs safety checks first (see *Launch safety gates*). A successful stop response means the request was accepted, not that the browser has already exited or that every write is durable. Wait for the actual stopped status before relaunching, importing, or backing up. Known Chromium instances are asked to close normally first; if that fails, bounded signal escalation remains a recovery path, not a persistence guarantee.
- Per-profile tools: ✎ Edit, 🍪 Cookies, 🧩 Extensions, 📦 Export backup, ✏️ Rename, 📝 Note, 🔒 Lock to device, 📋 Logs, 🧬 Drift check, 🖥 Env check, 📡 WebRTC diagnostic, 🎬 DRM, 🖥 App mode.
- **Filters & batch console**: filter by status (running/stopped) and tags, select all visible, then batch-launch, batch-stop, batch-assign a proxy, batch-export, or batch-delete. Bulk deletes above 10 items require an acknowledgement tick.

> **Known data-integrity issue under investigation (2026-10-18):** In isolated acceptance with Chromium 152.0.7977.72, a newly written LocalStorage value was sometimes missing or stale after immediate Stop and relaunch, despite an observed exit code of 0 with no exit signal and a `Browser.close` acknowledgement. An experimental close-pages-before-exit sequence also reproduced the loss and was withdrawn; it is not a verified fix. Waiting for Stopped is necessary, but is not a persistence guarantee. Keep an independently verified copy of important data; a green test suite, a Synced badge or a successful export request does not prove that the latest browser write was saved. Do not overwrite the only known-good backup while this remains unresolved. See the [functional audit](review/ipc-api-health-functional-audit-2026-10-18.md) for the exact tested scope and failures.

### Trash (accident protection)

Deleted profiles go to a **trash area for 7 days** — the success toast has an **Undo** button, and trash can be inspected/restored from the Profiles header. Permanent purge happens automatically after the retention window.

### Locks (team checkout)

🔒 **Lock to device** marks a profile as checked out by this machine. Other devices' pushes are refused (force-push still possible after confirmation). The lock syncs with the profile.

### WebGL personas, native GPU capabilities and proxy DNS

These are configuration and launch rules, not proof of Ping0 live-site or packaged-release acceptance.

- Managed Chromium requires a supported, matching host OS: macOS on a Mac and Windows on Windows. New profiles, presets and omitted bulk-import platforms use that host default. Explicit foreign-OS profiles remain portable storage; they are not silently rewritten, but incompatible local launches are refused. A WebGL persona does not turn Metal hardware into a Windows D3D GPU.
- **Only a native ARM64 macOS main process + selected ARM64 Chromium + managed mode** uses Apple WebGL personas. The four existing Apple personas all report vendor `Google Inc. (Apple)` and bare renderer strings `Apple M1`, `Apple M2`, `Apple M3` or `Apple M2 Pro`. This is a simulated identity, not proof of a physical GPU model. **WebGPU, actual GPU capabilities and drawing remain native**.
- The existing **Advanced hardware fingerprint** fields in create/edit accept `gpuVendor` / `gpuRenderer`; leave them empty for seed selection. Explicit values are partial constraints on a platform persona and must jointly match the same supported tuple with CPU, memory, screen and other constraints, not arbitrary combinations. Supported exact legacy ANGLE/model aliases remain compatible and normalize to the identities above; fuzzy model guessing is not supported.
- **Intel, Rosetta, unknown architectures and other Chromium platforms retain native GPU identity**. Unsupported explicit GPU requests are refused at launch, not silently ignored or deleted. Correct the tuple or explicitly clear both fields. Editable metadata does not certify host or selected-kernel capability: the main process validates at launch, without guessing from a page UA. Firefox keeps its existing tuple-selection constraints but uses a Gecko-specific presentation: Apple WebGL personas report `Apple` / `Apple M1, or similar`, Gecko's coarse privacy bucket rather than a physical model or Chromium ANGLE label. The default prefs + BiDi route uses engine preferences for WebGL and leaves WebGPU native; a page-only GPU shim is not used. Media-device enumeration also remains native so permission-policy denial, pre-permission label hiding and usable device IDs are preserved; this fallback does not promise a synthetic media-device roster.
- For an old Windows profile on a Mac, explicitly edit the platform to **macOS**, then **stop that browser in Studio and launch it again**. Changing a seed does not change the OS. Refreshing a page or restarting Studio can reuse an existing browser; startup identity, mode or DNS changes require an explicit restart. Unverified or changed startup evidence produces `restart-required` without automatically killing or replacing the browser.
- Fingerprint-off (pass-through / `off`) keeps native GPU identity and ignores inactive stored identity fields while retaining proxy DNS privacy. Native GPU preservation or host OS-family agreement does not establish that every high-entropy CPU or OS-version value is physically native; those values are recorded and checked for cross-surface agreement separately.
- Fixed HTTP/SOCKS proxies resolve origin hostnames at egress by default, including when fingerprint identity is off. A validated HTTPS `managedSecureDnsUrl` explicitly selects strict proxy DoH; this engine requires managed identity mode for that option. Proxy-side DNS uses TCP transport; native QUIC/MASQUE is only selected with explicit strict DoH. No direct fallback is added when the proxy fails.
- DNS-only hints and real resource requests differ, as do the pre-resolution policies for default proxy-side DNS and explicit strict DoH. Denying local resolution does not imply that egress cannot resolve. Ping0 uses DNS-prefetch, CSS, Image and STUN probes; prefetch alone cannot explain the count.
- A launch log saying **configured** is not proof of a completed DNS transaction. A third-party `resolver_count=0` alone proves neither fake-IP nor total DNS failure. Successful proxied navigation also does not validate a detector probe or strict DoH transaction; correlate actual resolver/route evidence. No fixed third-party score is guaranteed. See [Ping0 detection mechanism](PING0_DETECTION.md) for the algorithm, response fields and layered troubleshooting (Chinese).
- Old GPU baselines can change after this repair. Review the actual drift; the application does not automatically delete baselines, reset licensing, or rewrite existing profiles.

### Reported quota and site storage errors

- **Reported quota (MiB)** is identity metadata, not a writable-capacity setting. In managed Chromium, `storageQuota` changes the quota reported by storage estimate/legacy quota APIs; MiB means 1,048,576 bytes. Empty/auto currently reports 120,000 MiB, not the host's free disk space. It does not reserve disk space, increase actual browser storage limits, or expand LocalStorage.
- A `QuotaExceededError` from `localStorage.setItem()` is a failed write. LocalStorage has a separate per-storage-area limit that counts all keys and values, including other caches. One oversized cache entry or aggregate occupancy can exhaust it; increasing the reported quota does not fix this. This is distinct from a successful write later lost during shutdown. Do not clear login-bearing site data as an automatic workaround.
- A CSP inline-script violation needs its affected frame and script initiator to identify whether site code, an extension or explicit automation attempted it. `unsafe-eval` does not authorize arbitrary inline scripts. The iframe `allow-scripts` + `allow-same-origin` warning describes that document's sandbox configuration, not an observed escape. Neither warning justifies disabling CSP or browser sandbox protections.

### Fingerprint trust loop

- **🧬 Drift** compares the live fingerprint against the stored baseline without changing it; risky drift can block launch when enabled in Browser Engine → Launch safety gates.
- **Lock baseline** is a separate write. Establishing a baseline is not a health pass. A risky capture preserves the old baseline until you explicitly confirm the reviewed snapshot; a changed or expired confirmation requires a new review.
- **🖥 Env** reports host DNS configuration, font inventory and, when the browser is running, measured font exposure and rAF timing. Failed or incomplete probes remain unverified. A local DNS stub/router does not establish upstream country, and a saved or launch-time proxy configuration is not proof of a completed browser DNS transaction. A running process without launch evidence stays unknown until restarted normally.
- **📡 WebRTC** checks the current page's ICE candidates for exposed addresses, including related addresses. It does not establish a remote peer or certify a connection's latency; absent RTT is not a healthy latency measurement. Constructor/offer errors, unavailable WebRTC and empty/incomplete evidence are not passes. Starting a stopped profile requires confirmation and the normal launch permissions.
- **Consistency** compares saved fields and cached proxy information, not a fresh exit measurement. No cached conflict means unverified, not a live health pass. **External risk check** opens an external detector after consent; opening its page does not import a score or prove health.
- **History and cards** use the main process's saved outcome: pass, warning, risk, error, unavailable, unverified, cancelled or baseline established. Legacy records without completion evidence are not upgraded to pass. Clearing history removes both details and summaries; cancelled or cleared in-flight results cannot restore them. Cancellation is a request: the slot remains occupied until the underlying probe actually settles, and cancelling does not stop the browser.
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
3. **Team Workspace (RBAC)**: owner / admin / member / viewer roles propagate with sync. Viewers cannot push, pull, or change sync settings; force push requires admin or owner.
4. **Checkout locks** (see Profiles) block cooperative clients from overwriting another device's checkout. They are not a cross-device atomic transaction or compare-and-swap guarantee.

**Understand the result before retrying:**
- A profile's **Synced** badge proves only its portable configuration and `Preferences` match the published baseline for the selected endpoint/bucket. It does not prove Cookie, SQLite/WAL, LevelDB, or every profile file is unchanged. **Local changes** means saved locally but not in that baseline; **Unknown** includes legacy/unverifiable markers and changed targets. Reading a list does not upgrade old markers.
- Compare checks configuration and covered Preferences, and lists unverified/uncompared data. If local or remote content changes after comparison, compare again before applying saved decisions. Only one push/pull runs in this application process; a busy response is not a queued request.
- Cookie export distinguishes available-empty from unavailable. An unavailable source may preserve an older cloud copy with a warning. Pull merges Cookie imports: an empty snapshot does not clear existing Cookies, and **queued** means not yet imported by a browser. Running profiles skip on-disk Preferences and LocalStorage restore; Push does not capture their live LocalStorage database and may preserve a previous remote copy with a warning.
- Stopped-profile LocalStorage sync supports Chromium's `Default/LocalStorage` with its optional `LocalStorage-wal`, or the legacy `Default/Local Storage/leveldb` layout. SQLite main/WAL files are captured as a group; SHM is not transferred. The SQLite group has a 64 MiB limit plus page, frame, schema and validation-time limits. Unsupported schemas, damaged groups, nonempty rollback journals, mixed layouts and cross-format replacement are rejected without treating the data as absent. This is not a SQLite format/browser-version migration tool, a SessionStorage sync feature, or a full Firefox DOM-storage backup. SQLite restore fails closed when required directory durability is unsupported, including the explicitly unsupported Windows directory-fsync path.
- **Partial**, **commit unknown**, and **recovery required** are not rollbacks. Inspect item results and the last operation status; do not repeatedly retry or delete retained recovery copies. Successful LocalStorage replacement also retains the old database for separate runtime verification; it is not automatically deleted. Automation retries only a failed attempt with positive proof of no local or remote commit.
- **History is a separate opt-in scope.** Ordinary data-custody consent does not include it. In Sync settings, separately consent to **History / Firefox Places (including bookmarks, URLs and titles)**, then select whether future push/pull and automatic sync include it, and save. Existing settings remain unselected; consenting alone does not enable automatic history uploads. Revoking the scope stops future history capture but does not delete previously stored objects.
- Envelope **v3** references digest-addressed history artifact **v1** objects. The actual ZIP bytes are PUT and GET-verified before the envelope references them. Descriptors bind snapshot ID, the same profile `dirId`, engine, schema/version, allowed relative paths and each member's SHA-256/size. Chromium uses `Default/History`; Firefox uses profile-root `places.sqlite`. Main and optional WAL travel together; SHM does not. Limits include 64 MiB per main/WAL group, 256 MiB aggregate, and bounded schema/row/page/frame/time checks. Nonempty rollback journals, changing files, links, over-limit data, corruption, incompatible schemas or unconfirmed stopped ownership reject a new capture. A previously verified object may be preserved, explicitly **not freshly captured**; otherwise history is reported failed, never empty/absent.
- History validation opens only owned copies with their WAL, checks structural integrity, ordinary schema, exact typed values and key relations, and never checkpoints/repairs the source or ignores WAL with `immutable`. Unsupported CHECK/generated/expression-index/virtual-table schemas are refused instead of executing their SQL. Source-known schema admission is Chromium History versions 15–70 with compatible version at most 16, and Firefox Places 52–86; that is not proof that every requested/installed browser version can use the restored database. Existing target schemas must match; a different engine/schema is not silently migrated.
- Pull validates selected history objects before profile writes and restores to the **same `dirId`**, not the ZIP-import new-ID path. It retains the old full DB/WAL/SHM/empty-journal group under `.history-backup-*`, removes stale sidecars from the live group, and rechecks config/runtime ownership. Multi-file publication is **not atomic**: failures/cancellation before config commit are compensated when ownership allows. `HISTORY_RECOVERY_REQUIRED` means compensation is unconfirmed; inspect retained old/new groups and receipts before retrying, and never delete the only recovery copy.
- **Legacy not covered**, **not selected**, **source confirmed absent**, **complete empty snapshot**, **preserved old snapshot**, and **failed** are different. Legacy/config-only backups cannot reconstruct visits they never uploaded. Confirmed source absence does not erase receiver history; an explicitly selected complete empty database does replace the old group. History's independent semantic baseline compares typed rows/relations, not physical WAL/main hashes: checkpoint, SQLite statistics and known maintenance bookkeeping do not immediately mark a just-pushed profile dirty. Use **Recheck stopped profiles’ history** (or the history-state API); the status panel's recorded coverage alone is not a fresh local read or a browser History-UI acceptance test.
- New snapshots publish content-addressed extension/history objects before the main manifest. New clients read legacy envelopes; older clients are not guaranteed to understand v3, history artifact v1, version-2 extension addressing or SQLite LocalStorage artifacts. Upgrade team clients together before sharing new-format snapshots.
- Sync/import receipts separately report **configuration identity retained / changed / not verifiable / missing legacy seed** and **runtime fingerprint not re-verified**. An existing seed is retained, not re-randomized by pull/import. A retained `fingerprintBaseline` is only reference data, never proof of a live comparison. Local fonts, missing extension packages, actual kernel/version, OS and native GPU/engine policies may still change runtime results; perform a separate same-host/kernel live comparison.

Treat the S3 bucket as sensitive storage: infrastructure/account credential fields are omitted, but exported Cookies and profile state are real account data, not anonymized or end-to-end-encrypted backups.

## 11. Data & backups — please read once

- The working profile data lives **locally** at `<user-data>/profiles/…` (cookies, localStorage), alongside the encrypted credential vault and audit logs. Separately configured Sync or exports may also hold copies; the application does not infer independent backup coverage merely from those settings.
- **Disk failure can destroy local profile data.** Keep a **profile export backup on a separate disk or separately stored cloud backup**, or use **Sync to an independently stored S3 bucket**. An export left on the same disk does not protect against that disk failing. Check that your backup exists and rehearse restoration using a non-critical profile.
- **The 7-day trash window protects against accidental deletion, not disk failure.** Trash stays in the local storage area on the same disk; it is not an independent backup and disappears on permanent purge or after its retention window.
- Backups contain sensitive account data. Browser-encrypted cookies and sessions may be tied to the original OS/device; an export or sync does **not** guarantee that a logged-in session will work on another machine. Keep recovery credentials separately and be prepared to sign in again.
- Stop a profile before exporting its ZIP. A verified archive is published only after integrity readback; an existing destination is replaced only with explicit permission. Waiting in the native file dialog is not a failed export. Cancelled, skipped, partial, and completed-with-warnings are distinct outcomes.
- Backups refuse unresolved or unverifiable LocalStorage rescue transactions (`ARCHIVE_RECOVERY_REQUIRED`); keep their original material and resolve the reported recovery first. When a ZIP with completed SQLite rescue history is imported under a new ID, all rescue bytes and original receipts are retained under `.profile-archive-recovery/<original-ID>/Default/…` with a warning. This inactive history is not the new profile's commit proof or an automatically restored database; it is not silently deleted. Legacy rescue copies remain alongside the live LevelDB database where safe, without inventing a completion proof missing from an older ZIP.
- **Configuration import, profile ZIP and cloud sync have different scopes.** Importing configuration JSON alone does not copy browser databases or recover visits. A standalone stopped-profile ZIP carries its collected browser files (including History/Places and WAL when present) and imports under a new profile ID; it is not the cloud transport. Cloud history uses the explicit v3/v1 scope and restores the same ID. Check actual archive contents and per-item receipts rather than assuming one path proves another.
- A profile ZIP is not an application-wide backup of the agent database, credential vault, audit history, or all settings. A backup reminder is advice, not proof that a backup file exists.
- The Storage tab shows per-profile disk usage and keeps data-safety reminders visible.

## 12. Integration surfaces (for developers)

- **REST API** on `127.0.0.1:26582` — OpenAPI 3.0 at `/openapi.json`, bearer-token auth (`AGENT_BROWSER_API_TOKEN`). Covers profiles, proxies, accounts, automation, jobs, agent, DRM, team, updates.
- **MCP server** on `127.0.0.1:26581` for Claude Code / Cursor & other MCP clients. Sync tools are `agent_browser_sync_status`, `agent_browser_sync_configure`, `agent_browser_sync_push`, `agent_browser_sync_pull` and `agent_browser_sync_history_state`; explicit consent must come from the user's intent, not an agent inferring it from ordinary sync enablement.
- **History scope API**: authenticated `POST /api/sync/config` with `{ "historyConsent": true, "includeHistory": true }` separately records consent and selects future automatic scope (member+). Push/pull accept optional `history: true/false`; omission inherits the saved selection, never silently enables history on an old config. `GET /api/sync/history/{dirId}` returns independent semantic state/coverage/freshness, not a full-restore or runtime identity certificate. JS SDK methods are `configureSync`, `syncPush`, `syncPull`, `syncHistoryState`; Python uses `configure_sync`, `sync_push`, `sync_pull`, `sync_history_state`. Read incomplete/recovery receipts from HTTP errors before deciding to retry.
- **Python & JS SDKs** (`sdk/python`, `sdk/js`) — including `connectPlaywright` / `connectPuppeteer` one-call adapters that return a real Playwright/Puppeteer browser bound to a managed profile. Profile responses retain synchronization status/scope/reason. HTTP errors preserve `.status` and a bounded `.body`; inspect commit/outcome/recovery fields rather than parsing the message. Error bodies above 2 MiB are explicitly marked `bodyTruncated` (JS) / `body_truncated` (Python), with no complete body returned. A missing/truncated body or transport timeout does not prove that no write happened and must not trigger a blind retry.

## 13. Recommended operating checklist

- Confirm authorization for every account, site, and dataset you touch.
- One workflow per profile; never share cookies across unrelated accounts.
- Run **Detect** on proxies and resolve 🏭 IDC warnings before serious accounts.
- Run 🧬 Drift / 🖥 Env after any engine update or host change.
- Keep API keys and sync credentials private; exports are metadata-safe but still sensitive.
- Review 📜 Activity when something looks off — every sensitive action is recorded.

## 14. 7-day account warm-up SOP (#94: warm up before real work)

> Half of all "it doesn't work" reports are usage errors. Anti-detection is
> NOT anti-ban: new account + new IP + aggressive actions = dead account.
> Ramp up gradually — one account, one IP, one environment.

| Day | Do | Don't |
|---|---|---|
| Day 1 | Create env → 4-field alignment check → run 🩺 check (target ≥90) → likes/saves/comments only | No posting, no friending, no profile edits |
| Day 2–3 | 10–20 min browsing + interaction daily; ≥24h gap between new accounts on the same device | No bulk actions, no IP changes |
| Day 4–5 | Light posting (1–2/day), reply to comments | No scripts, no 24h online |
| Day 6–7 | Ramp up gradually; re-run 🧬 Drift + 🖥 Env to confirm no drift | Stop if IP/timezone/locale changes |

### 4-field alignment checklist (every new environment)

1. **IP**: proxy Detect passes, no 🏭 hosting/IDC warning (switch to residential first).
2. **Timezone**: profile timezone = IP geolocation timezone (the 🩺 check flags mismatch in red).
3. **Locale**: locale = geo language (e.g. en-US for a US IP).
4. **ASN/geo**: IP-database geo matches the three above; keep a screenshot (support-dispute evidence).
5. Click **🔒 Lock baseline** to review and save a fingerprint reference. A risky replacement requires explicit confirmation. Enable the corresponding launch gate if you want high-risk drift to block later launches; saving a baseline alone neither enables the gate nor guarantees account safety.

## 15. Troubleshooting

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
