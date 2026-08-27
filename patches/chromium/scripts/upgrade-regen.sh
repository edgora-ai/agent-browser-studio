#!/usr/bin/env bash
# Regenerate one patch <name> from:
#   base = pristine upstream ref + all predecessor patches applied cleanly
#   work = base, with <name>'s touched files replaced by the hand-resolved
#          versions found in $WORK/files (the upgrade-drive.sh applied tree).
# This yields a diff containing ONLY <name>'s hunks, correctly rebased.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
CR_SRC="${CR_SRC:-$HOME/workspace/chromium-build-150/src}"
PATCHES="$REPO/patches/chromium/patches"
NAME="${1:?patch basename required}"
REF="${REF:-chromium-151-stable}"
WORK="${WORK:-/tmp/opencode/drive}"   # upgrade-drive.sh output (resolved tree)
OUT="${OUT:-/tmp/opencode/regen}"
cd "$CR_SRC"
rm -rf "$OUT"; mkdir -p "$OUT/base" "$OUT/work"
# Extract every file touched by the WHOLE series (so predecessors + this patch apply).
grep -h "^diff --git" "$PATCHES"/*.patch | awk '{print $3}' | sed 's|^a/||' \
  | sort -u > "$OUT/touched.txt"
while IFS= read -r f; do
  mkdir -p "$OUT/base/$(dirname "$f")"
  git show "$REF:$f" > "$OUT/base/$f" 2>/dev/null || rm -f "$OUT/base/$f"
done < "$OUT/touched.txt"
cp -R "$OUT/base"/. "$OUT/work"/
# Apply all predecessors (everything before NAME) cleanly.
for p in "$PATCHES"/*.patch; do
  b="$(basename "$p" .patch)"
  [ "$b" = "$NAME" ] && break
  git -C "$OUT/work" apply "$p" || { echo "predecessor failed: $b"; exit 1; }
done
# Snapshot base BEFORE overlaying edits.
git -C "$OUT/work" init -q && git -C "$OUT/work" add -A >/dev/null 2>&1
git -C "$OUT/work" -c user.email=a@b -c user.name=r commit -qm base >/dev/null 2>&1
# Overlay this patch's resolved files from the drive tree.
# Read the file list from the committed original (the working-tree patch may
# already be regenerated/empty).
git -C "$REPO" show ":${PATCHES#"$REPO"/}/$NAME.patch" | grep "^diff --git" | awk '{print $3}' | sed 's|^a/||' | while IFS= read -r f; do
  if [ -f "$WORK/files/$f" ]; then
    mkdir -p "$OUT/work/$(dirname "$f")"
    cp "$WORK/files/$f" "$OUT/work/$f"
  fi
done
# Diff -> patch (excluding any lingering .rej).
git -C "$OUT/work" add -A >/dev/null 2>&1
git -C "$OUT/work" diff --cached --no-ext-diff --no-color > "$PATCHES/$NAME.patch"
echo "regenerated $NAME.patch ($(grep -c '^diff --git' "$PATCHES/$NAME.patch") files)"
