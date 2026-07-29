#!/usr/bin/env bash
# Re-renders assets/banner-{light,dark}.png from scripts/banner.html.
#
# The banner is a screenshot rather than an inline SVG because it uses Instrument Serif and
# Plus Jakarta Sans (the same faces as comdec.github.io); an SVG served through GitHub's image
# proxy would fall back to whatever the viewer happens to have installed. Rendering at 2x and
# letting GitHub scale it down keeps it sharp on HiDPI displays.
#
# Needs Google Chrome and ImageMagick. Fonts are pulled from Google Fonts, so run it online.
set -euo pipefail

cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SRC="file://$PWD/scripts/banner.html"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for theme in light dark; do
  hash=""
  [ "$theme" = "dark" ] && hash="#dark"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size=1200,340 \
    --screenshot="$TMP/$theme.png" "$SRC$hash" >/dev/null 2>&1
  magick "$TMP/$theme.png" -strip -define png:compression-level=9 "assets/banner-$theme.png"
  echo "wrote assets/banner-$theme.png"
done
