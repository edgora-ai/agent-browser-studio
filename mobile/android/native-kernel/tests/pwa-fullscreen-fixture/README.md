# First-party scoped PWA / fullscreen fixture — HOST ONLY

**No device acceptance or deployment has been performed.** No already-trusted A/B
origins were available on the handset when this fixture was added. This directory
contains five small source/notes files, no APK, runtime, AVD, certificates, keys,
third-party assets or dependencies. It does not change Android/native code.

## Bounded host regressions (no listening sockets)

```sh
python3 -B -m unittest discover -s mobile/android/native-kernel/tests/pwa-fullscreen-fixture -p 'test_*.py' -v
```

Python standard library tests call pure routes and feed HTTP bytes through the
real request handler with in-memory connections. One bounded Node subprocess
executes inline scripts and SW contracts with DOM/media/cache stubs. Missing Node
is an explicit skip, **not** a JS pass. No browser, emulator, ADB, APK, real TLS,
DNS, remote connection or persistent server is started by these tests.

Local host verification for the video-controls probe: Python 3.14.6, Node v26.8.2;
**13 tests passed, zero skips, exit 0**. The added checks cover the shared video
markup, unwired author actions in the probe, and trace retention under stubbed
event input. These are fixture contracts only, not browser/TLS/device results.

## Operator prerequisites — not supplied or authorized here

Use two distinct, explicitly configured, **first-party already-trusted HTTPS
origins** A and B, a fresh run ID R, and separately authorized device access.
DNS/routing and a valid existing TLS chain covering the configured hosts must
already work on that device without an interstitial. Do not add a root, bypass
TLS errors, use third-party hosting, or install a certificate to make this pass.
The CLI cannot verify handset trust: these are mandatory external prerequisites.

Only after those prerequisites and separate server/device permission, the optional
stdlib CLI supports the following shape (placeholders are NOT live/trusted origins):

```sh
python3 -B fixture.py --origin-a https://A.YOUR-OWNED-HOST:8443 \
  --origin-b https://B.YOUR-OWNED-HOST:8443 --run UNIQUE_SAFE_RUN \
  --cert /existing/operator-provisioned-chain.pem --key /existing/private-key.pem
```

It binds loopback by default; an operator must explicitly choose an appropriate
`--bind`/`--port` and trusted routing if needed. The CLI offers no HTTP fallback,
certificate generation, deployment, trust install or TLS-verification bypass.
It checks Host against configured A/B, limits POSTs to 16 KiB, and creates no
persistent log. Stop it using the operator's separately agreed ownership policy;
this task does not start it or grant device/server management authority.

## Paths and independent manual observations

All primary paths use `/r/R/app/` (the trailing slash is intentional). Begin at
A's `/r/R/app/install`. Manifest: explicit per-run `id`, `start_url` with launch
query, `scope`, `display: standalone`, and generated first-party 192/512 PNG icons.
Use the browser's real install/launch UI; the fixture does not simulate a shortcut,
install a WebAPK, assert successful installation, or auto-enter fullscreen.

1. **Entry versus live mode:** the first inline head script freezes entry
   display-mode matches, URL, client-document nonce, server nonce/request ID and
   `document.readyState` before later UI code. Separate live mode/fullscreen state
   changes do not overwrite entry. Compare a normal browser entry with a genuine
   installed launch. Later DOM fullscreen is NOT evidence of standalone launch.
2. **Freshness / Back:** GET `start`/`inner` creates a new server nonce/request ID;
   `pageshow.persisted` is recorded separately, never guessed at first script.
   Client nonce distinguishes a new script execution from a restored document.
   All HTTP responses are no-store. This does **not** prohibit browser BFCache.
   Use real Android Back separately from the clearly labelled DOM history button.
3. **Scope and permanent escape:** from A's installed launch, navigate inside,
   then `/r/R/app-x/out` (same-origin near-prefix), and return inside A's scope.
   Also test the absolute `/app-x/out?run=R`, cross-origin B with the *same* scoped
   path, and controlled 302 `redirect?target=in|out|b`. Unknown redirect destinations
   fail closed. Independently observe native chrome after escape AND return:
   returning must not silently reset a permanent escape latch. The fixture does
   not decide or emulate that native state. Start a fresh launch for each case.
4. **Same-document escape:** click scoped pushState, escaping pushState, then
   return pushState. URL changes but client/server document nonces do not. Observe
   popstate/Android Back and native chrome independently; no document reload or
   web CSS pretends to be a native scope decision.
5. **POST:** the actual `_self` HTML form performs URL-encoded top-level POST with
   no fetch substitute or redirect-to-GET. Its no-store HTML receipt includes
   server method, raw-body SHA, fields, request ID/nonce and identical-body
   occurrence. Receipt forms retain the submitted token/text so repeated clicks
   can preserve the same body; compare raw SHA rather than assuming sameness. Refresh/
   Android Back/resubmission behavior and native replay decisions remain device
   tests; a server receipt is not proof that a native tab restored correctly.
6. **Scoped offline control:** explicitly register SW on trusted A, wait for its
   controller (reload once if necessary), then explicitly prime ONLY `offline`.
   Cache API deliberately stores that no-store response. The two marked
   navigation links use `fixture_offline=1` plus a fresh attempt query. Cached path
   returns the primed body (old server nonce, NEW client nonce on fresh execution);
   never-cached path returns genuine `Response.error()`, not old DOM/200 fallback.
   Unprimed cached path also errors. All other paths, origins, fetches and POSTs
   are untouched; no phone-wide offline toggle is needed. Without this run's SW,
   marked routes return HTTP 409, NOT a false offline pass. Server restart changes
   cache namespace; do not reuse R or infer persistence acceptance from this test.
7. **Media / fullscreen / IME:** user-click starts a local moving frame-counter
   canvas stream into a muted `playsinline` video. Separate buttons call genuine
   DOM-element or VIDEO `requestFullscreen()` and report unsupported/errors,
   with no CSS fake fullscreen fallback. Manual action promises report an 8-second
   timeout (not cancellation of underlying browser work). Edge markers/text support
   native bars, cutout, keyboard, rotation and Android Back observations. Stubs
   cannot prove video rendering, activation, fullscreen callbacks, launcher/task
   integration, IME or system-bar behavior. Those all remain **NOT RUN**.

### Chromium video controls + Android Back — manual, not run

1. On A, open `/r/R/app/start` and follow **Chromium video controls + Android
   Back** to `/r/R/app/inner?fullscreen=ua-controls` so there is a previous page
   to distinguish from fullscreen exit. For an installed-PWA run, use that link
   from the real installed launch instead (under the prerequisites above). This
   view hides and does not wire the fixture's JS fullscreen, exit, and history
   buttons. Note the client document nonce and URL in the open trace before
   entering fullscreen.
2. Tap **Start moving muted inline video** and confirm the frame counter moves
   in the video, not just in the source canvas. Tap the playing video if needed
   to reveal **Chromium’s own** controls. Physically tap the fullscreen/expand
   icon inside that player (check its overflow menu if applicable). If the
   control is absent or the video cannot play, record the blocker; don't
   substitute the JS fullscreen button or dispatch a click to UA controls.
3. Wait until the video is visibly fullscreen. Use the **Android system Back**
   gesture or navigation button once, not a toolbar Back or the player's exit
   icon. Verify that the video returns inline on the same page instead of the
   tab navigating or the app closing. Record the visible fullscreen and Back
   behavior; the page cannot identify what Android input caused an exit.
4. In **Fullscreen / Back trace (this document)**, expect `mode: "ua-controls"`,
   `video-playing`, then two `fullscreenchange` events with `detail.isTrusted: true`:
   first `fullscreenElement: "video"`, then `fullscreenElement: null`. Confirm
   the URL and client document nonce are unchanged, and that Back caused no
   `pagehide`, additional `pageshow`, or `popstate`. There should be no
   `fullscreen-api-attempt` or `fullscreenerror`. The trace keeps the event-time
   fullscreen state even after resize/display-mode events. `isTrusted` describes
   the fullscreen event, not the gesture; the actual tap and system Back are
   independent manual evidence. If the required event evidence is missing,
   report the visible behavior separately rather than marking the probe passed.
5. For the JS comparison, use a fresh document at plain `/r/R/app/inner`,
   start the same video and tap the page's **VIDEO fullscreen** button. Its
   `fullscreen-api-attempt` (`action: "video-fullscreen"`) distinguishes this
   author API case even if Chromium fires the same `fullscreenchange` events.

Host results establish fixture route/script contracts only; they are not Android,
PWA installation, fullscreen, TLS-trust, or performance acceptance.
