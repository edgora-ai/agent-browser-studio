# Firefox 154 patch history

## Immutable upstream anchor

- Product version: `154.0`
- Mozilla repository: `https://hg.mozilla.org/releases/mozilla-release`
- Release tag: `FIREFOX_154_0_RELEASE`
- SourceStamp: `9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc`
- Parent changeset: `23c7b9841903ac50041691eef82540bef0760311`
- Official source archive: `firefox-154.0.source.tar.xz`
- Official SHA-512: `a77cd664982add628681167ef5939bd6bf0c894aa380cca66f9b5fb265947874d1e819d42264f1dd07c843f8a6dc020da268cca9ff1e064fca019de91af9b996`

The SHA-512 value was read from Mozilla's signed `154.0/SHA512SUMS`.
`verify-release-signature.sh` pins the downloaded checksum, signature and KEY
file hashes and requires signing fingerprint
`827E658608679618CD349F93678E455D76767AA3` before any source is extracted.
Source preparation additionally requires `sourcestamp.txt` to contain build ID
`20260812182057` and the exact `mozilla-release/rev/9ce1ee6…` URL; archive metadata to bind the extracted tree
to the exact SourceStamp; version text alone is insufficient.

## Append-only policy

Numbered patches are never rewritten after review. A compatibility or build fix
is added as the next patch. `PATCHSET.sha256` pins every patch and immutable
payload; `PATCHED_SOURCE.sha256` pins the full final contents of every modified
Gecko source file.

## Current state

The clean unofficial-branding stock checkpoint was built and packaged on macOS
arm64 with Clang/LLD `21.1.8`, Rust `1.94.1`, and cbindgen `0.29.4`. The
materialized app reported Firefox `154.0`, exact SourceStamp `9ce1ee6…`, native
arm64 Mach-O, valid deep ad-hoc signing, and live BiDi plus Marionette protocol
3 endpoints. The independently repeated
Window/iframe/DedicatedWorker/SharedWorker/Offscreen corpus is pinned at
`corpora-154/stock-firefox-154.0.json`.

## 0001 — native config channel and capability attestation

`0001-agent-browser-config-capabilities.patch` adds the first Gecko-native
checkpoint without claiming any page-visible fingerprint surface:

- `--agent-browser-capabilities` prints strict single-line JSON and exits before
  profile selection; it advertises only `config-v1`, `native-required-v1`, and
  `snapshot-v1`;
- `--agent-browser-native-required` disables remote-instance forwarding, reads
  `agent.browser.fingerprint.config` after user prefs and JS initialization, and
  fails nonzero on missing, malformed, oversized, or non-v1 config;
- the parent freezes the decoded JSON and passes the encoded snapshot to content
  processes through an internal inherited environment value; content validates
  the JSON again after XPCOM/JS initialization, and Worker threads share that
  immutable process snapshot;
- no required flag means stock pass-through and clears an externally inherited
  snapshot value.

The packaged binary reported the exact SourceStamp and the three capabilities,
and the managed installer read them back after atomic copy and deep ad-hoc
signing. At this checkpoint `fingerprintParity` remained false because no
Navigator/Screen/Canvas surface capability was advertised.

## 0002 — native Navigator, WorkerNavigator and screen Gate A

`0002-agent-browser-navigator-screen.patch` extends the immutable snapshot with
strict typed validation and advertises `navigator-v1` plus `screen-v1`:

- Window Navigator reads platform, Firefox-shaped userAgent/appVersion/oscpu,
  hardware concurrency and max touch points from the process snapshot; WebDriver
  remains visible to system callers but is false to managed page callers;
- Dedicated and Shared WorkerNavigator use the same snapshot for the properties
  Firefox 154 natively exposes. Window-only oscpu/maxTouchPoints/webdriver are
  deliberately not added to WorkerNavigator, preserving stock API exposure;
- Screen and available geometry, top-level inner/outer/window position, DPR and
  orientation use one coherent tuple. Iframes share screen/outer identity while
  retaining their own layout viewport;
- RDM and privileged system/browser-chrome callers retain their stock behavior,
  and no-config mode takes the original Gecko paths unchanged;
- the immutable snapshot is published to Worker threads through a release/acquire
  atomic pointer after parsing completes.

The real Gate A verifier writes a product-generated private pref, reads it back,
launches with `--agent-browser-native-required`, and verifies Window, iframe,
DedicatedWorker and SharedWorker through BiDi without registering a preload. It
runs Windows, macOS and Android personas and rejects missing, malformed, wrong-
schema, incoherent-UA and incoherent-geometry configs before a window opens. Its
pinned default corpus is
`corpora-154/gate-a-firefox-154.0.json`; the post-patch no-config capture is
byte-identical to `stock-firefox-154.0.json` (SHA-256
`60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`). Full
`fingerprintParity` remains false until Gates B and C complete.

## 0003 — deterministic Canvas and OffscreenCanvas readback noise

`0003-agent-browser-canvas-noise.patch` adds strict typed parsing for
`canvas.enabled` and a 16-character lowercase hexadecimal `canvas.seed`, derives
an immutable 32-byte key, and advertises `canvas-v1`:

- Gecko's existing Canvas extraction policy selects deterministic randomization
  for managed content only after privileged-caller, taint and extraction checks;
- the central RFP randomizer consumes the managed key without requiring cookie-
  jar settings, while the no-config path retains the original per-site RFP key
  and permission behavior;
- the existing readback pipeline covers Canvas 2D `getImageData`, `toDataURL`
  and `toBlob`, OffscreenCanvas `convertToBlob`, WebGL `readPixels` and supported
  high-precision element sizes without modifying visible backing buffers;
- Window, iframe, DedicatedWorker and SharedWorker use the same immutable
  process snapshot. System/browser-chrome callers remain unrestricted.

The real Canvas verifier rejects nine malformed Canvas config shapes, launches
without a preload, and compares four worlds: two independent same-seed profiles,
a different-seed profile, and no-config stock behavior. It proves repeated and
fresh-context idempotence across Window/iframe/Offscreen/DedicatedWorker/
SharedWorker, PNG serialization, WebGL 8-bit readback and supported RGBA32F
FLOAT readback. The pinned evidence is
`corpora-154/canvas-firefox-154.0.json` (SHA-256
`809c23162fc2ec833127410ebeecee51d0e86571bb3d63599d654580da95f139`). A
post-0003 no-config capture remains byte-identical to the stock corpus (SHA-256
`60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`).
`canvas-v1` is accepted, but Gate B and full parity remain incomplete until
`webgl-v1`, `webgpu-v1`, and `audio-v1` pass their independent gates.

## 0004 — native WebGL and WebGPU identity

`0004-agent-browser-webgl-webgpu-identity.patch` extends the immutable snapshot
with strictly validated, coherent WebGL/WebGPU identity and advertises
`webgl-v1` plus `webgpu-v1`:

- WebGL 1/2 keep Firefox's masked vendor `Mozilla`, return the configured
  Firefox-shaped renderer, and expose the configured vendor/renderer through
  `WEBGL_debug_renderer_info` only when that extension is actually enabled;
- the single client-side path covers HTMLCanvasElement, OffscreenCanvas,
  DedicatedWorker and SharedWorker while privileged/system/resource/add-on
  principals and Gecko's internal debug path retain stock values;
- `GPUAdapter.info` and `GPUDevice.adapterInfo` expose only vendor,
  architecture, device and description from the snapshot. Features, limits,
  WGSL language features, subgroup sizes, fallback-adapter state and Chrome-only
  diagnostics remain native;
- no-config behavior falls through to the original RFP/sanitization paths.

The headed real-GPU verifier rejects 33 malformed GPU config variants, compares
two independent same-persona launches, a different Windows GPU persona, macOS,
Android and stock worlds, and covers WebGL 1/2 across Window/iframe/HTML/
Offscreen/DedicatedWorker/SharedWorker. It proves all relevant getters/methods
are native, and that WebGL extensions/limits plus WebGPU features/limits/WGSL
and subgroup values are byte-for-byte equal to stock. The evidence is
`corpora-154/gpu-firefox-154.0.json` (SHA-256
`a64235db8e5716e6963bb96e295af07b5f47eda0f9b538000d533cf35ca76de1`).
WebGPU adapter creation is unavailable in Firefox's macOS headless mode, so this
gate is intentionally headed; headless remains separately covered by the Canvas
and stock gates. The post-0004 no-config corpus remains byte-identical to stock
at SHA-256 `60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`.
Gate B and parity remain incomplete until `audio-v1` passes.

## 0005 — deterministic WebAudio readback noise

`0005-agent-browser-audio-readback.patch` adds strict typed parsing for
`audio.enabled`, a 16-character lowercase hexadecimal seed and finite amplitude
`1e-12..1e-3`, then advertises `audio-v1`:

- `AudioBuffer.getChannelData` returns one stable deterministic shadow view per
  channel; `copyFromChannel` sees the same values and `copyToChannel` keeps an
  existing view live;
- untouched noise never enters the backing channel. Before Gecko gives data to
  the audio graph, only page-authored shadow changes are merged, returned views
  are detached per Firefox's existing lifecycle, and the clean backing is
  transferred. System/chrome/resource/add-on callers bypass noise;
- AnalyserNode float/byte frequency and time-domain getters apply deterministic
  noise only to caller-owned output arrays. Float noise follows amplitude;
  byte APIs scale deterministic one-LSB change density because sub-LSB values
  cannot be represented;
- OfflineAudioContext reuses the AudioBuffer readback path. Firefox 154 exposes
  these WebAudio interfaces only on Window, so Dedicated/Shared Worker API shape
  remains stock (`undefined`).

The real verifier rejects 37 malformed Audio config variants and compares two
same-seed launches, a different seed and stock across Window/iframe. It proves
stable native descriptors, all four Analyser readbacks, bounded noise density,
page-write semantics, Firefox detachment behavior and graph transfer with an
unchanged clean source. The pinned evidence is
`corpora-154/audio-firefox-154.0.json` (SHA-256
`c3adb17ccb019f0c3c89b1cf43a226ed45e10af273d947983e53c9f01ac31d14`). The
post-0005 no-config corpus remains byte-identical to stock at SHA-256
`60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`.
Gate B is complete. Full native parity remains false until Gate C passes.

## 0006 — permission-preserving geolocation and DOM-visible storage quota

`0006-agent-browser-geolocation-storage.patch` extends the immutable snapshot with
strict geolocation mode/coherence validation and a safe-integer storage quota,
then advertises `geolocation-v1` plus `storage-quota-v1`:

- `real` geolocation falls through to Firefox's cache/provider path; `custom` and
  `disable` are applied only after Firefox's site and OS permission gates complete,
  so a denied permission still returns `PERMISSION_DENIED` without revealing the
  configured position;
- the request captures content-versus-system caller eligibility synchronously at
  the WebIDL boundary. Delayed permission callbacks cannot convert a page request
  into a privileged one, while system/chrome/resource/add-on callers retain stock
  behavior;
- custom one-shot requests dispatch without entering Firefox's callback arrays.
  A custom watch is retained in a marked watcher entry so `clearWatch` and the
  normal lifecycle work, but real-provider updates/errors, provider liveness and
  accuracy calculations skip it. Disable dispatches one asynchronous denial after
  shutting down without registration. This prevents one-shot retention and stops
  disabled/custom watches from later receiving real provider data;
- `navigator.storage.estimate()` preserves real usage and reports
  `max(real quota, usage, configured quota)` only at the DOM-visible resolver. It
  does not alter QuotaManager accounting, eviction or allocation enforcement, and
  the same resolver covers Window, iframe, DedicatedWorker and SharedWorker.

The real verifier rejects 16 malformed geolocation/storage configs, compares two
custom launches, permission-denied, disabled, real, low-quota and no-config stock
worlds, and launches without a preload. It proves exact custom coordinates for
`getCurrentPosition` and `watchPosition`, a 1,510-request one-shot stress run with
no retained-request limit failure, real/stock provider parity, native descriptors,
and permission-preserving denials. It writes IndexedDB data in every supported
realm, reads usage back, and proves configured quota inflation while low quota and
usage remain byte-for-byte equal to stock. The pinned evidence is
`corpora-154/geo-storage-firefox-154.0.json` (SHA-256
`216d00b229db48467030325721dca3c59d06c3cf1f654904cf5b4bacc44d3458`, reproduced
byte-identically by two independent verifier runs). The
post-0006 no-config corpus remains byte-identical to stock at SHA-256
`60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`.
These two Gate C capabilities are accepted; Fonts, MediaDevices and speech voices
remain incomplete, so full native parity stays false.

## 0007 — caller-gated media device persona roster

`0007-agent-browser-media-devices.patch` extends the immutable snapshot with a
strict `mediaDevices` config (`enabled` plus required `audioInputs`,
`videoInputs`, `audioOutputs` counts, each 0–16) and advertises
`media-devices-v1`. `MediaDevices::EnumerateDevices` captures content-versus-
system caller eligibility synchronously at the WebIDL boundary into
`mPendingEnumerateDevicesAgentOverrides`, an array kept perfectly parallel to
`mPendingEnumerateDevicesPromises`; `ResumeEnumerateDevices` then dispatches
each captured promise to `ResolveAgentEnumerateDevicesPromise` or the stock
resolver. Because the resolution callback runs on the event loop where the
subject principal is the system principal, caller eligibility is authoritative
only at the boundary; resolution re-checks just the
`ShouldResistFingerprinting(RFPTarget::MediaDevices)` gate so an RFP flip
between capture and resolve still resolves the stock roster.

The persona roster mirrors stock `FilterExposedDevices` gating exactly:

- before permission, non-legacy callers see at most one microphone and one
  camera with every field empty, regardless of the configured counts;
- speakers appear only when microphone info can be exposed or the page holds an
  explicit `selectAudioOutput()` grant (stock's per-device `Contains(rawId)`
  collapses to the existential `!mExplicitlyGrantedAudioOutputRawIds.IsEmpty()`
  for synthetic persona ids — an intentional, documented mapping that exposes
  the configured roster once any grant exists without leaking physical ids);
- legacy enumeration mode exposes anonymized ids and gates labels on
  `IsActivelyCapturingOrHasAPermission`, per kind, exactly like stock;
- `media.setsinkid.enabled=false` and Permissions-Policy `camera`,
  `microphone` and `speaker-selection` denials drop the same kinds stock drops;
- device and group ids are anonymized with `nsContentUtils::AnonymizeId` keyed
  by `agent-browser-media-devices-v1`, the origin, the OriginAttributes suffix
  (container and private-browsing isolation), a per-window salt for
  null-principal documents, and the persona canvas key. `AnonymizeId` failure
  fails closed to empty ids. Group ids additionally mix the window id, matching
  stock's group salting.

The verifier rejects 12 malformed mediaDevices configs before a window opens and
compares fourteen worlds across two byte-identical runs: managed, denied-policy,
disabled, stock, multi-persona, zero-count, legacy with and without capture,
setsinkid-disabled and RFP (each managed/stock pair). It proves the
pre-permission one-per-kind cap, decomposed policy iframes, legacy per-kind
label-visibility parity with stock, setsinkid and RFP pass-through, restart
stability, cross-origin id isolation with identical labels, and that Workers
never expose `mediaDevices`. The pinned evidence is
`corpora-154/media-devices-firefox-154.0.json` (SHA-256
`81ecdbf06e0874232d13512983493f2bcec0d72af585f0379c2049664956d43c`). The
post-0007 no-config corpus remains byte-identical to stock at SHA-256
`60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`. Two
adversarial review rounds ran: round one REJECTED (speaker grant gating, legacy
speaker labels, OriginAttributes isolation, RFP resolve re-check) and every
finding was fixed and runtime-verified; round two returned ACCEPT. Fonts and
speech voices remained incomplete at that point, so full native parity stayed
false.

## 0008 — caller-gated speech synthesis voice roster

`0008-agent-browser-speech-voices.patch` extends the immutable snapshot with a
strict `speechSynthesis` config (`enabled` plus a required `voices` array of
1–64 entries, each with a non-empty `name` ≤128 chars, `lang` ≤64 chars and a
boolean `localService`) and advertises `speech-voices-v1`. The patch touches
`SpeechSynthesis::GetVoices` plus `SpeechSynthesisVoice` attribute getters and
the `nsSynthVoiceRegistry::SpeakUtterance` voice-lang mapping.

`SpeechSynthesis::GetVoices` keeps the stock RFP early-return first, then for
managed content windows (`GetSpeechVoicesOverrides()` plus
`ShouldApplyContentOverrides`, and only while the window is live) builds the
persona roster synchronously from the immutable config: deterministic URIs
`urn:moz-tts:persona:<index>` and wrapper objects flagged `mIsAgentVoice` with
immutable persona payload. Because `SpeechSynthesisVoice` attribute getters
resolve lazily through `nsSynthVoiceRegistry` in stock Firefox, the persona
flag short-circuits `GetName`/`GetLang`/`LocalService`/`Default` so a persona
URI never reaches the registry (an unknown-URI registry lookup would leave
`name`/`lang` unset and `localService`/`default` uninitialized — and the
content process faulted before the short-circuit existed). Persona voices
never report `default`; the registry and its real macOS voice population are
untouched, so `voiceschanged` semantics, physical speak fallback and RFP
pass-through stay stock.

`nsSynthVoiceRegistry::SpeakUtterance` keeps stock behavior for non-persona
voices; for a persona `voiceURI` it substitutes the persona voice's configured
language only when the utterance has no language of its own (a page-pinned
`utterance.lang` and the document language keep stock precedence). The parent
process never contains persona URIs, so `FindBestMatch` falls back by language
to a real macOS voice and audio still plays.

The verifier rejects 22 malformed speechSynthesis configs before a window
opens and captures managed, restart, multi-voice, zh, disabled and RFP worlds
plus a Worker probe. It proves the persona roster mirrors the configured
voices exactly (name/lang/localService/default), URIs are stable across
restarts, repeated `getVoices()` calls return the same wrapper objects, the
`getVoices` descriptor stays native, disabled and RFP windows return the empty
stock headless roster, and Workers expose neither `speechSynthesis` nor the
voice constructors. Two adversarial review rounds ran: round one REJECTED one
HIGH (null-window `GetVoices` deref after inner-window-destroyed) and one
MEDIUM (GetName/GetLang gated on payload emptiness instead of the persona
flag); both were fixed, rebuilt and re-verified. Round two returned ACCEPT
with no HIGH/MEDIUM regression in the delta (the stale-HasVoices speak-queue
gap is inherited from stock and documented, not blocking). The pinned evidence is
`corpora-154/speech-voices-firefox-154.0.json` (SHA-256
`250eeb7579fb8375025008c398a605b3f2e09d1db8fc49d54b1c7b9d02871fe3`,
reproduced byte-identically by two independent verifier runs). The
post-0008 no-config corpus remains byte-identical to stock at SHA-256
`60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`.
