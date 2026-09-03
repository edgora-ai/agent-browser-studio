# Firefox 154 native capability matrix

This matrix is Firefox-specific. It does not copy Chromium's surface count, and a
capability is advertised only after the exact patched binary passes its native
corpus. Production sets `fingerprintParity: true` only when every **Required for
parity** capability below is present in the binary-attested report.

| Capability | Required for parity | Current state | Native scope / acceptance |
| --- | --- | --- | --- |
| `config-v1` | yes | complete | Base64url `BrowserFingerprintConfig schemaVersion=1`, 64 KiB decoded limit, strict typed validation |
| `native-required-v1` | yes | complete | Missing or malformed config exits nonzero before a window opens; remote forwarding disabled |
| `snapshot-v1` | yes | complete | Parent/content immutable snapshot; release/acquire publication to Worker threads |
| `navigator-v1` | yes | complete | Firefox-shaped UA/appVersion/oscpu, platform, hardware concurrency, max touch points and WebDriver; Window/iframe/DedicatedWorker/SharedWorker native descriptors; stock WorkerNavigator exposure preserved |
| `screen-v1` | yes | complete | Screen/work area, top-level inner/outer geometry, screen position, DPR and primary orientation; RDM and privileged callers retain stock behavior |
| `canvas-v1` | yes | complete | Canvas/OffscreenCanvas deterministic, idempotent readback noise across Window/iframe/Workers and supported 8-bit/RGBA32F readback formats |
| `webgl-v1` | yes | complete | WebGL 1/2 masked and unmasked identity without changing extensions/capability hash |
| `webgpu-v1` | yes | complete | Adapter identity only; stock features, limits, subgroup state and WGSL exposure unchanged |
| `audio-v1` | yes | complete | Deterministic readback-only noise for AudioBuffer/Analyser/OfflineAudio Window surfaces; Worker API exposure remains stock |
| `fonts-v1` | yes | pending Gate C | Native font-selection allowlist shared by CSS, FontFaceSet, Canvas and Workers |
| `geolocation-v1` | yes | complete | Custom/disable values only after site and OS permission gates; real provider, system callers and Worker API shape remain stock |
| `media-devices-v1` | yes | complete | Caller-gated enumerateDevices persona roster mirroring stock pre-permission caps, legacy labels, setsinkid and RFP pass-through |
| `speech-voices-v1` | yes | complete | Caller-gated speechSynthesis.getVoices persona roster; native descriptors, RFP/disabled/Worker pass-through, speak falls back by persona language |
| `storage-quota-v1` | yes | complete | DOM-visible `max(real quota, usage, configured quota)` across Window/iframe/Workers; accounting and usage remain real |

## Gate A evidence

- Patched macOS arm64 Firefox: `154.0`
- SourceStamp: `9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc`
- Advertised capabilities:
  `config-v1`, `native-required-v1`, `snapshot-v1`, `navigator-v1`,
  `screen-v1`
- Native corpus: `corpora-154/gate-a-firefox-154.0.json`
- Stock no-config corpus: `corpora-154/stock-firefox-154.0.json`
- Stock corpus SHA-256:
  `60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`
- Gate A verifier covers Windows, macOS and Android platform personas, eleven
  malformed-config cases, Window/iframe/DedicatedWorker/SharedWorker, native
  getter descriptors, timezone consistency, API-exposure preservation and zero
  BiDi fingerprint preload.

## Gate B Canvas evidence

- Advertised capability: `canvas-v1`
- Native corpus: `corpora-154/canvas-firefox-154.0.json`
- Native corpus SHA-256:
  `809c23162fc2ec833127410ebeecee51d0e86571bb3d63599d654580da95f139`
- Nine malformed Canvas config variants fail closed before a window opens.
- Two independent same-seed launches, a different seed and stock no-config are
  compared without a preload.
- Repeated and fresh-context Canvas 2D pixels/PNG serialization are stable across
  Window, iframe, OffscreenCanvas, DedicatedWorker and SharedWorker.
- WebGL 8-bit and supported RGBA32F FLOAT readbacks are stable and seed-specific
  across the same realms.
- The post-`0003` no-config corpus remains byte-identical to the stock corpus at
  SHA-256 `60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`.

## Gate B GPU identity evidence

- Advertised capabilities: `webgl-v1`, `webgpu-v1`
- Native corpus: `corpora-154/gpu-firefox-154.0.json`
- Native corpus SHA-256:
  `a64235db8e5716e6963bb96e295af07b5f47eda0f9b538000d533cf35ca76de1`
- Thirty-three malformed WebGL/WebGPU configs fail closed before a window opens.
- WebGL 1/2 masked/unmasked identity is native and coherent across Window,
  iframe, HTMLCanvasElement, OffscreenCanvas, DedicatedWorker and SharedWorker.
- WebGPU adapter and device info match the persona across Window/iframe/Workers;
  features, limits, WGSL language features, subgroup sizes and fallback state
  remain byte-for-byte equal to stock.
- Same-persona restarts are stable; different Windows, macOS and Android GPU
  personas are distinct. No preload is registered.
- WebGPU adapter creation requires the headed macOS path; Firefox's headless mode
  exposes the API but returns no adapter. Canvas and stock headless gates remain
  separate.
- The post-`0004` no-config corpus remains byte-identical to stock at SHA-256
  `60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`.

## Gate B Audio evidence

- Advertised capability: `audio-v1`
- Native corpus: `corpora-154/audio-firefox-154.0.json`
- Native corpus SHA-256:
  `c3adb17ccb019f0c3c89b1cf43a226ed45e10af273d947983e53c9f01ac31d14`
- Thirty-seven malformed Audio config variants fail closed before a window opens.
- Two independent same-seed profiles, a different seed and stock are pairwise
  distinct for AudioBuffer/OfflineAudio and all four Analyser readbacks.
- AudioBuffer shadow views are stable and bounded; `copyFromChannel`,
  `copyToChannel`, page writes, graph transfer and Firefox detachment semantics
  are verified while the original copy source remains stock-clean.
- Window and iframe match. Dedicated/Shared Worker keep Firefox 154's stock
  Window-only WebAudio exposure (`undefined`). No preload is registered.
- The post-`0005` no-config corpus remains byte-identical to stock at SHA-256
  `60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`.

Gate B is complete. Full native parity remains false until Gate C passes.

## Gate C geolocation and storage evidence

- Advertised capabilities: `geolocation-v1`, `storage-quota-v1`
- Native corpus: `corpora-154/geo-storage-firefox-154.0.json`
- Native corpus SHA-256:
  `216d00b229db48467030325721dca3c59d06c3cf1f654904cf5b4bacc44d3458`
  (reproduced byte-identically by two independent verifier runs).
- Sixteen malformed geolocation/storage config variants fail closed before a
  window opens.
- Custom coordinates are exact and restart-stable for Window/iframe
  `getCurrentPosition` and `watchPosition`; 1,510 consecutive one-shot requests
  all complete without synchronous request-limit failures.
- Site denial still wins over custom coordinates, `disable` returns
  `PERMISSION_DENIED`, and `real` matches the no-config stock provider outcome.
  Eligibility is captured at the caller boundary so privileged callers stay stock.
- IndexedDB writes use unique incompressible per-realm keys with transactional
  readback verification, and usage is polled until QuotaManager accounting
  settles, proving a strict real usage increase. Configured quota is exactly
  `max(real quota, usage, configured quota)` across Window, iframe,
  DedicatedWorker and SharedWorker; a quota below the real value leaves both quota
  and usage equal to stock and does not change QuotaManager enforcement.
- Firefox 154 does not expose geolocation on WorkerNavigator; both Worker types
  remain `undefined`. Native method descriptors and zero preload are verified.
- The post-`0006` no-config corpus remains byte-identical to stock at SHA-256
  `60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`.
- Third-round source review verdict: ACCEPT (no HIGH/MEDIUM correctness
  defect). Residual verifier coverage is documented, not hidden: the
  1510-request stress catches the harmful one-shot registration leak;
  provider-liveness/high-accuracy skip and privileged-caller bypass are not
  observable from content-side BiDi and are pinned statically in
  `tests/unit/firefox-build-scripts.test.ts`
  (`!request->IsAgentCustomWatch()`, `aCallerType == CallerType::System`,
  `ShouldApplyContentOverrides(window->AsGlobal())`).

These two Gate C capabilities are complete. Fonts, MediaDevices and speech voices
remain pending, so production parity remains false.

## Gate C media devices evidence

- Advertised capability: `media-devices-v1`
- Native corpus: `corpora-154/media-devices-firefox-154.0.json`
- Native corpus SHA-256:
  `81ecdbf06e0874232d13512983493f2bcec0d72af585f0379c2049664956d43c`
  (reproduced byte-identically by two independent verifier runs).
- Twelve malformed mediaDevices config variants fail closed before a window
  opens.
- Caller eligibility is captured synchronously at the WebIDL boundary into an
  array parallel to the pending promise queue; promise resolution re-checks only
  the RFP gate because the event-loop subject principal is always the system
  principal. The static pins live in
  `tests/unit/firefox-build-scripts.test.ts`
  (`mPendingEnumerateDevicesAgentOverrides`, `system principal`,
  `mExplicitlyGrantedAudioOutputRawIds.IsEmpty()`, `CreateSuffix`,
  `window-%llu`).
- Pre-permission rosters are capped at one microphone and one camera with every
  field empty — including the multi-persona config — exactly like stock
  `FilterExposedDevices`; a zero-count persona keeps only the configured kinds.
- Speakers follow the stock rule (microphone info exposure or an explicit
  `selectAudioOutput()` grant); the per-device stock grant collapses to the
  existential check for synthetic persona ids, an intentional mapping with no
  physical id/count leak. Decomposed Permissions-Policy iframes are verified:
  `camera 'none'` leaves only the microphone, `speaker-selection 'none'` leaves
  microphone plus camera, all fields empty.
- Legacy enumeration mode exposes anonymized ids with per-kind label visibility
  mirrored from stock and never exposes speakers pre-permission; persona ids
  never alias stock ids.
- `media.setsinkid.enabled=false` removes speakers from managed and stock
  rosters alike; RFP windows resolve the stock RFP roster with kind+label shapes
  identical to stock and no persona labels.
- Persona rosters are restart-stable and origin-isolated (same labels, distinct
  anonymized ids per origin, OriginAttributes suffix and null-principal window
  salt). Workers never expose `mediaDevices`; `enumerateDevices` stays a native
  `MediaDevices` method with stock descriptor flags.
- The post-`0007` no-config corpus remains byte-identical to stock at SHA-256
  `60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`.
- Review history: round one REJECTED four blocking findings (speaker explicit-
  grant gating, legacy speaker label gating, OriginAttributes isolation, RFP
  resolve re-check) plus one LOW (null-principal collision); all were fixed and
  covered by new runtime worlds. Round two verdict: ACCEPT.

This Gate C capability is complete. Fonts and speech voices were the remaining Gate C
surfaces.

## Gate C speech voices evidence

- Advertised capability: `speech-voices-v1`
- Native corpus: `corpora-154/speech-voices-firefox-154.0.json`
- Native corpus SHA-256:
  `250eeb7579fb8375025008c398a605b3f2e09d1db8fc49d54b1c7b9d02871fe3`
  (reproduced byte-identically by two independent verifier runs).
- Twenty-two malformed speechSynthesis configs fail closed before a window
  opens.
- Persona rosters mirror the configured voices exactly (name, lang,
  localService, default=false) with deterministic `urn:moz-tts:persona:<i>`
  URIs that are stable across restarts; repeated `getVoices()` calls return the
  same wrapper objects. The `getVoices` descriptor stays a native prototype
  method.
- Persona voice attribute getters are short-circuited off the registry
  (mIsAgentVoice) so persona URIs never trigger unknown-URI registry lookups;
  persona voices never claim `default`. Caller eligibility requires a live
  window and sits after the stock RFP early return.
- Disabled (`speechSynthesis.enabled=false`) and RFP windows return the empty
  stock headless roster; the verifier also proves multi-voice and zh personas
  and that Workers expose neither `speechSynthesis` nor the voice constructors.
- Speaking with a persona voiceURI falls back by the persona's language onto a
  real macOS voice in the parent process (persona URIs are never registered
  there); page-pinned utterance languages and document languages keep stock
  precedence.
- The post-`0008` no-config corpus remains byte-identical to stock at SHA-256
  `60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`.
- Review history: round one REJECTED one HIGH (null-window GetVoices deref
  after inner-window-destroyed) and one MEDIUM (GetName/GetLang gated on
  payload emptiness instead of the persona flag); both fixed, rebuilt and
  re-verified. Round two verdict: ACCEPT (no HIGH/MEDIUM regression in the
  delta; the stale-HasVoices speak-queue gap is documented as inherited, not
  blocking).

This Gate C capability is complete. Fonts remains pending, so production parity
remains false.

## Deliberate limitations

- The current unofficial build packages en-US only. Non-en-US `Intl` locale
  availability is not claimed by `navigator-v1` or `screen-v1` and remains on
  the production prefs/BiDi fallback until a later native capability closes it.
- The current screen config represents primary portrait or landscape orientation
  with angle `0`; secondary orientation personas are not represented.
- Partial native binaries remain `fingerprintParity: false`. Production continues
  using `prefs+bidi-preload`; `AGENT_BROWSER_FIREFOX_NATIVE=1` is explicit
  native-only A/B mode and never upgrades parity by itself.
