#!/usr/bin/env bash
#
# Derive every shipped icon asset from the four 1024x1024 masters in images/.
#
# The masters are the only hand-made (AI-generated) artwork. Everything below
# is deterministic resampling, so all sizes stay pixel-consistent with each
# other. Never regenerate an individual size with an image model: the geometry
# drifts between generations and the set stops reading as one identity.
#
# Requires ImageMagick 7 (magick) and python3.
#
# Usage: ./scripts/build-icons.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ICON_LIGHT=images/counterpoise-icon-light.png
ICON_DARK=images/counterpoise-icon-dark.png
MARK_LIGHT=images/counterpoise-mark-light.png
MARK_DARK=images/counterpoise-mark-dark.png

for f in "$ICON_LIGHT" "$ICON_DARK" "$MARK_LIGHT" "$MARK_DARK"; do
  [ -f "$f" ] || { echo "missing master: $f" >&2; exit 1; }
done

command -v magick >/dev/null || { echo "ImageMagick 7 (magick) is required" >&2; exit 1; }

# Maximum lossless zlib compression with adaptive filtering, plus metadata
# stripping. Worth ~25% on the smooth-gradient artwork here, and these bytes
# both ship in the Docker image and live in git history forever. Verified
# pixel-identical against the uncompressed output (magick compare -metric AE).
PNGOPT=(-strip -define png:compression-level=9 -define png:compression-filter=5)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> favicons (from the simplified marks)"
# The full icon is unreadable below ~64px, so the tab-strip sizes use the
# stripped-back mark instead. Both are full-bleed, so neither needs a plate.
for sz in 16 32 48 64; do
  magick "$MARK_LIGHT" -resize ${sz}x${sz} "${PNGOPT[@]}" "public/favicon-${sz}x${sz}.png"
  magick "$MARK_DARK"  -resize ${sz}x${sz} "${PNGOPT[@]}" "public/favicon-dark-${sz}x${sz}.png"
done

echo "==> multi-resolution .ico (16/32/48)"
magick "$MARK_LIGHT" \
  \( -clone 0 -resize 16x16 \) \( -clone 0 -resize 32x32 \) \( -clone 0 -resize 48x48 \) \
  -delete 0 -strip app/favicon.ico
magick "$MARK_DARK" \
  \( -clone 0 -resize 16x16 \) \( -clone 0 -resize 32x32 \) \( -clone 0 -resize 48x48 \) \
  -delete 0 -strip public/favicon-dark.ico

echo "==> manifest and apple-touch icons (from the full icons)"
magick "$ICON_LIGHT" -resize 192x192 "${PNGOPT[@]}" public/android-chrome-192x192.png
magick "$ICON_LIGHT" -resize 512x512 "${PNGOPT[@]}" public/android-chrome-512x512.png
magick "$ICON_DARK"  -resize 192x192 "${PNGOPT[@]}" public/android-chrome-dark-192x192.png
magick "$ICON_DARK"  -resize 512x512 "${PNGOPT[@]}" public/android-chrome-dark-512x512.png
magick "$ICON_LIGHT" -resize 180x180 "${PNGOPT[@]}" app/apple-icon.png
magick "$ICON_DARK"  -resize 180x180 "${PNGOPT[@]}" public/apple-touch-icon-dark.png
magick "$ICON_LIGHT" -resize 1024x1024 "${PNGOPT[@]}" public/icon-1024.png

echo "==> maskable icons (Android adaptive launchers)"
# An Android launcher may crop a maskable icon to any shape that fits inside a
# circle of 80% the icon's diameter, so only content within that circle is
# guaranteed to survive. The full-bleed art reaches 463px of the 512px radius
# (measured, not estimated: the right pan's outer edge), well outside the 410px
# safe radius, which is why the shipped icons above stay purpose "any" and get
# a separate maskable variant here rather than simply being relabelled.
#
# The artwork is inset to 84% and the surrounding gradient is extended by edge
# replication, so the illustration itself is unchanged -- only its margin grows.
# Replication is seamless here because the icon's border is pure background.
MASK_INSET=860
MASK_PAD=$(( (1024 - MASK_INSET) / 2 ))
magick "$ICON_LIGHT" -resize ${MASK_INSET}x${MASK_INSET} -virtual-pixel edge \
  -define distort:viewport=1024x1024-${MASK_PAD}-${MASK_PAD} \
  -distort SRT 0 "$TMP/maskable.png"
magick "$TMP/maskable.png" -resize 512x512 "${PNGOPT[@]}" public/icon-maskable-512.png
magick "$TMP/maskable.png" -resize 192x192 "${PNGOPT[@]}" public/icon-maskable-192.png

echo "==> macOS dock squircle"
# macOS composes app icons on a 1024 canvas holding an 824 continuous-corner
# rounded square. That corner is a superellipse (|x|^n + |y|^n = 1, n ~ 5), not
# a circular-arc rounded rect, so it is drawn here as a dense polygon rather
# than approximated with -draw roundrectangle. Rendered at 4x and downsampled
# for clean antialiasing.
CANVAS=1024
TILE=824
SS=4

squircle_points() {
  python3 -c '
import math, sys
size = float(sys.argv[1])
n = 5.0
r = size / 2.0
steps = 2048
pts = []
for k in range(steps):
    t = 2.0 * math.pi * k / steps
    c, s = math.cos(t), math.sin(t)
    x = r * math.copysign(abs(c) ** (2.0 / n), c)
    y = r * math.copysign(abs(s) ** (2.0 / n), s)
    pts.append("%.3f,%.3f" % (r + x, r + y))
print(" ".join(pts))
' "$1"
}

PTS="$(squircle_points $((TILE * SS)))"
magick -size $((TILE * SS))x$((TILE * SS)) xc:black -fill white \
  -draw "polygon $PTS" -resize ${TILE}x${TILE} -alpha off "$TMP/mask.png"

for variant in light dark; do
  case "$variant" in
    light) SRC="$ICON_LIGHT"; OUT=public/icon-macos-1024.png ;;
    dark)  SRC="$ICON_DARK";  OUT=public/icon-macos-dark-1024.png ;;
  esac
  magick "$SRC" -resize ${TILE}x${TILE} "$TMP/tile.png"
  magick "$TMP/tile.png" "$TMP/mask.png" -compose CopyOpacity -composite "$TMP/shaped.png"
  magick -size ${CANVAS}x${CANVAS} xc:none "$TMP/shaped.png" \
    -gravity center -compose over -composite "${PNGOPT[@]}" "$OUT"
done

echo
echo "done. generated:"
ls -1 public/*.png public/*.ico app/favicon.ico app/apple-icon.png | sed 's/^/  /'
