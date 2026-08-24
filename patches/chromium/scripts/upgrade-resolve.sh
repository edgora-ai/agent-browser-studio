#!/usr/bin/env bash
# Resolve one Chromium patch against an upstream ref, in series order.
#
#   scripts/upgrade-resolve.sh prepare <patch-basename> <chromium-ref>
#     Builds the post-predecessor state (all earlier patches applied), copies
#     it to $OUT/work, applies <patch-basename> with --reject, and prints the
#     rejected hunks to resolve BY HAND in $OUT/work.
#
#   scripts/upgrade-resolve.sh regen <patch-basename>
#     Regenerates patches/<patch-basename>.patch from the diff between the
#     saved predecessor snapshot ($OUT/base) and $OUT/work, then re-verifies
#     that the whole series replays one step further than before.
#
# Environment: OUT (default /tmp/chromium-upgrade-resolve), CR_SRC.
set -euo pipefail

CMD="${1:?usage: upgrade-resolve.sh prepare|regen …}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
CR_SRC="${CR_SRC:-$HOME/workspace/chromium-build-150/src}"
PATCHES="$REPO/patches/chromium/patches"
OUT="${OUT:-/tmp/chromium-upgrade-resolve}"

case "$CMD" in
prepare)
  NAME="${2:?patch basename required}"; REF="${3:?chromium ref required}"
  rm -rf "$OUT"; mkdir -p "$OUT/files" "$OUT/rejects"
  cd "$CR_SRC"
  grep -h "^diff --git" "$PATCHES"/*.patch | awk '{print $3}' | sed 's|^a/||' \
    | sort -u > "$OUT/touched.txt"
  while IFS= read -r f; do
    mkdir -p "$OUT/files/$(dirname "$f")"
    git show "$REF:$f" > "$OUT/files/$f" 2>/dev/null || rm -f "$OUT/files/$f"
  done < "$OUT/touched.txt"

  for p in "$PATCHES"/*.patch; do
    b="$(basename "$p" .patch)"
    if [ "$b" = "$NAME" ]; then
      # Best-effort tree so far (predecessors applied with --reject) is the base.
      cp -R "$OUT/files" "$OUT/base"
      if git -C "$OUT/files" apply --check "$p" >/dev/null 2>&1; then
        echo "unexpected: $b applies cleanly; nothing to resolve"; exit 1
      fi
      git -C "$OUT/files" apply --reject "$p" >/dev/null 2>&1 || true
      find "$OUT/files" -name '*.rej' | while IFS= read -r rej; do
        echo "REJECT: ${rej#"$OUT/files/"}"
      done
      echo "work dir: $OUT/files   (edit these files, then run: $0 regen $b)"
      exit 0
    fi
    # Apply predecessors best-effort (some may have their own conflicts);
    # discard their rejects so only the target patch's rejects are reported.
    git -C "$OUT/files" apply --reject "$p" >/dev/null 2>&1 || true
    find "$OUT/files" -name '*.rej' -delete
  done
  echo "patch not found: $NAME"; exit 1
  ;;
regen)
  NAME="${2:?patch basename required}"
  [ -d "$OUT/base" ] || { echo "run prepare first"; exit 1; }
  # Temp repo so git emits proper a/ b/ diff headers.
  rm -rf "$OUT/gitrepo"; cp -R "$OUT/base" "$OUT/gitrepo"
  git -C "$OUT/gitrepo" init -q && git -C "$OUT/gitrepo" add -A
  git -C "$OUT/gitrepo" -c user.email=a@b -c user.name=r commit -qm base
  # Copy hand-resolved changes, excluding any residual rejects.
  find "$OUT/files" -name '*.rej' -delete
  tar -C "$OUT/files" -cf - . | tar -C "$OUT/gitrepo" -xf -
  git -C "$OUT/gitrepo" add -A
  git -C "$OUT/gitrepo" diff --cached --no-ext-diff > "$PATCHES/$NAME.patch"
  echo "regenerated $PATCHES/$NAME.patch ($(grep -c '^diff --git' "$PATCHES/$NAME.patch") files)"
  ;;
*)
  echo "unknown cmd: $CMD"; exit 1;;
esac
