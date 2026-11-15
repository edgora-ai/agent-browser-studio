# Offline QA ownership contracts

Run on the host, with Python standard library only:

```sh
python3 -B -m unittest discover -s mobile/android/native-kernel/tests/device-qa -p 'test_*.py' -v
```

`ownership_contract.py` is pure parsing/counting code: no ADB, subprocess, socket,
fixture, screenshot, file access or import-time device work. Synthetic controls
cover exact Activity/user identity; duplicate/conflicting overlay metadata;
complete-window frame aliases; the recorded bounded OnePlus Android 16 bars;
explicit original task binding with repeated references deduplicated; and
count-only label classification that does not return unknown titles.

The OEM edge-bar package has not been independently pinned in this new profile;
it is deliberately **not** whitelisted by UID/title alone. Unknown Task envelope
shapes also pause. Synthetic inputs are not proof that real captures on this phone
will pass this stricter module; there has been no device compatibility run.

## Not runtime acceptance or input authorization

- This module is **not connected** to the installed APK, historical QA helper or
  lifecycle runners. Preserve those historical inputs/receipts unchanged.
- Passing the window/task checks proves only the supplied metadata shape. It does
  not prove capture completeness/freshness, idle-call/awake state, document/PID
  ownership, safe shared proxy scope, or current human permission. Real captures
  are non-atomic. The strict profile may pause on a changed Android build/layout;
  never weaken it to resume automatically.
- Card aliases and a `新标签页` title are only *labels*, not URL/native-origin proof.
  `matches_candidate_set` is deliberately not an authorization API. Do not select
  an unknown card to resolve ownership, infer why one disappeared, ignore extra
  cards, or treat familiar titles as safe pages for shared-proxy fault tests.
- The latest known physical scope has A1/B0/startup-labelled1/unrecognized1. No
  missing-B creation/fault was performed; hidden-tab/Home remain **NOT COMPLETE**.
  This host suite cannot change that status. Device use needs a fresh verifiable
  QA-only handoff and all existing guards; no automatic acquisition is authorized.
