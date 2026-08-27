#!/usr/bin/env bash
# Dry-run the Chromium patch series against an upstream tag without touching
# any real checkout. Extracts only the files our series touches, applies the
# patches in order with --reject, and prints a per-patch status line.
#
# Usage:
#   scripts/upgrade-dry-run.sh <upstream-git-ref>   # e.g. chromium-151-stable
#
# Requirements:
#   - The chromium source repo (partial clone is fine) at $CR_SRC or
#     ~/workspace/chromium-build-150/src must contain <upstream-git-ref>.
#   - Run from anywhere; output is a status list plus .rej paths under $OUT.
set -euo pipefail

REF="${1:?usage: upgrade-dry-run.sh <chromium-ref>}"
CR_SRC="${CR_SRC:-$HOME/workspace/chromium-build-150/src}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"        # app repo root (…/roxy-lite-cloak-oss)
PATCHES="$REPO/patches/chromium/patches"
OUT="${OUT:-/tmp/chromium-upgrade-dryrun}"

mkdir -p "$OUT/files"
cd "$CR_SRC"

# 1. Files touched by the series (a/* side), including files patches create.
grep -h "^diff --git" "$PATCHES"/*.patch | awk '{print $3}' | sed 's|^a/||' \
  | sort -u > "$OUT/touched-files.txt"

# 2. Fresh extract of every touched file at REF (missing = created by a patch).
while IFS= read -r f; do
  mkdir -p "$OUT/files/$(dirname "$f")"
  git show "$REF:$f" > "$OUT/files/$f" 2>/dev/null || rm -f "$OUT/files/$f"
done < "$OUT/touched-files.txt"

# 3. Sequential apply with rejects; keep per-patch verdicts.
: > "$OUT/status.txt"
for p in "$PATCHES"/*.patch; do
  name="$(basename "$p" .patch)"
  find "$OUT/files" -name "*.rej" -delete 2>/dev/null || true
  if git -C "$OUT/files" apply --check "$p" >/dev/null 2>&1; then
    git -C "$OUT/files" apply "$p"
    echo "OK        $name" >> "$OUT/status.txt"
  else
    git -C "$OUT/files" apply --reject "$p" >/dev/null 2>&1 || true
    while IFS= read -r rej; do
      mkdir -p "$OUT/rejects/$name/$(dirname "${rej#"$OUT/files/"}")"
      mv "$rej" "$OUT/rejects/$name/${rej#"$OUT/files/"}"
    done < <(find "$OUT/files" -name '*.rej')
    echo "CONFLICT  $name" >> "$OUT/status.txt"
  fi
done

cat "$OUT/status.txt"
echo "----"
echo "conflicts: $(grep -c CONFLICT "$OUT/status.txt") / $(wc -l < "$OUT/status.txt" | tr -d ' ')"
echo "rejects:   $OUT/rejects/<patch>/…  artifacts: $OUT"
