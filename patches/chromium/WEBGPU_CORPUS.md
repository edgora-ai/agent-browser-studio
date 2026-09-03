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

## Stock Chrome and OSS Chromium 152

Stock Chrome `152.0.7977.64` exposes 23 adapter features, 36 adapter limits, one
default-device feature, 36 device limits and 10 WGSL language features. The
152 surface includes `subgroup-size-control`; normalized SHA-256 is
`d6f8c588d2270ff32761fa2d512820f27eb932248a492a536696bc60b42c4999`.
The installed independent OSS Chromium `152.0.7977.72` matches that hash exactly
in Window and Worker contexts.

Unlike the observable RoxyChrome Windows reference, OSS adapter and device
identity derive from the same joint hardware persona as WebGL. A Windows RTX
3060 profile reports NVIDIA / Ampere and the configured 32/32 subgroup identity
in Window and Worker adapter/device info while retaining Stock-152 capabilities.

The strict verifier captures the corpus across independent Profiles, a
same-Profile close/reopen, different seeds, Windows/macOS identities,
`el-GR`/`el-CY`, headed/headless and native pass-through modes. Product
fingerprint baselines retain the deep hash for drift detection. Any feature,
limit, device, WGSL, context or identity drift fails the gate.

The verifier deliberately does not pass `--enable-unsafe-webgpu` or
`--ignore-gpu-blocklist`: Chromium 152 exposes extra experimental features and
WGSL extensions under those flags, so using them would change the stock surface
being measured. Native identity patches `0020` and `0031` require no capability
spoofing; only adapter/device identity fields are managed.
