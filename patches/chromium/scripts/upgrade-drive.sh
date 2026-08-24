#!/usr/bin/env bash
# Sequential rebase driver: applies every Chromium patch in series order onto a
# pristine upstream ref with --reject, attributing each .rej to its originating
# patch. Produces:
#   $OUT/files      final (best-effort) tree
#   $OUT/rej/<name> .rej files produced when applying <name>
# Usage: OUT=/tmp/opencode/drive CR_SRC=... REF=chromium-151-stable \
#        scripts/upgrade-drive.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
CR_SRC="${CR_SRC:-$HOME/workspace/chromium-build-150/src}"
PATCHES="$REPO/patches/chromium/patches"
OUT="${OUT:-/tmp/opencode/drive}"
REF="${REF:-chromium-151-stable}"
rm -rf "$OUT"; mkdir -p "$OUT/files" "$OUT/rej"
cd "$CR_SRC"
grep -h "^diff --git" "$PATCHES"/*.patch | awk '{print $3}' | sed 's|^a/||' \
  | sort -u > "$OUT/touched.txt"
while IFS= read -r f; do
  mkdir -p "$OUT/files/$(dirname "$f")"
  git show "$REF:$f" > "$OUT/files/$f" 2>/dev/null || rm -f "$OUT/files/$f"
done < "$OUT/touched.txt"
for p in "$PATCHES"/*.patch; do
  b="$(basename "$p" .patch)"
  before="$(find "$OUT/files" -name '*.rej' | sort)"
  if git -C "$OUT/files" apply --check "$p" >/dev/null 2>&1; then
    git -C "$OUT/files" apply "$p"
    echo "OK    $b"
  else
    git -C "$OUT/files" apply --reject "$p" >/dev/null 2>&1 || true
    after="$(find "$OUT/files" -name '*.rej' | sort)"
    new="$(comm -13 <(echo "$before") <(echo "$after"))"
    if [ -n "$new" ]; then
      mkdir -p "$OUT/rej/$b"
      while IFS= read -r rej; do
        mv "$rej" "$OUT/rej/$b/" 2>/dev/null
      done <<< "$new"
      echo "REJ   $b : $(echo "$new" | sed "s|$OUT/files/||" | tr '\n' ' ')"
    else
      echo "OK*   $b (applied with --reject, no new rejects)"
    fi
  fi
done
echo "=== summary ==="
ls "$OUT/rej" 2>/dev/null
