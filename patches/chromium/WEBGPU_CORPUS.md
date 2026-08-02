# WebGPU comparative capability corpus

This corpus uses public WebGPU APIs only. Valid RoxyChrome Profiles were copied
to temporary directories before launch and queried on a controlled secure
origin fulfilled inside the browser; their original data and encrypted
configuration files were not read or changed.

## RoxyChrome 149 observable reference — 2026-08-03

Six Profiles spanning Windows/macOS and Apple/AMD WebGL identities were
captured in Window and Dedicated Worker contexts. Every Profile exposed:

- 23 adapter features and 36 adapter limits;
- 1 default-device feature and 36 device limits;
- 10 WGSL language features;
- `bgra8unorm` as the preferred canvas format;
- exact Window/Worker and adapter/device-info parity;
- normalized capability SHA-256
  `e1b2202d87a5e6c8b89b06c212c55f7bb3f05be03bc68417aeea0c52e76e6a2a`.

Normalization retains availability, adapter/device features and limits,
preferred canvas format, WGSL language features and error state. It excludes
only adapter identity fields so distinct declared GPUs can share the same
version-level capability corpus.

The observable RoxyChrome Windows Profiles still reported `metal-3` WebGPU
architecture and AMD adapter identity, including when their Window platform
and WebGL renderer declared a Windows D3D GPU. That mixed identity is not used
as the OSS acceptance target.

## Stock Chrome and OSS Chromium 150

Stock Chrome `150.0.7871.114` exposes the same feature/limit/device corpus plus
the version-added `immediate_address_space` WGSL language feature, producing
SHA-256 `ad30297f9dce978014dd2ab257051036bc2a0a551f9b594478c5000e3eb88ebc`.
The independent OSS Chromium `150.0.7871.114` matches that hash exactly.

Unlike the observable RoxyChrome Windows reference, the OSS adapter and device
identity are derived from the same joint hardware persona as WebGL. For
example, the Windows RTX 3060 corpus reports NVIDIA / Ampere in both Window and
Worker adapter/device info while preserving the Stock 150 capabilities.

The strict verifier captures the corpus across independent Profiles, a
same-Profile close/reopen, different seeds, Windows/macOS identities,
`el-GR`/`el-CY`, and headed/headless modes. Product fingerprint baselines also
retain a deep WebGPU hash for drift detection. Any feature, limit, device,
WGSL, context or identity drift fails the gate.

No new Chromium patch was required: patches `0020` and `0031` already provide
native adapter/device identity coherence, and the underlying Chromium 150
capability surface is exact Stock. Patch `0039` only aligns legacy Storage
quota callbacks and does not alter WebGPU; patch `0038` and all earlier patch
bytes remain unchanged.
