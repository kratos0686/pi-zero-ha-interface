#!/bin/sh
# Launch Chromium full-screen under the cage Wayland compositor.
# Flags are tuned for the Pi Zero 2W's 512 MB of RAM.
set -eu

URL="${HA_DASH_URL:-http://127.0.0.1:8080/}"
BROWSER="$(command -v chromium || command -v chromium-browser)"

# Wait for the local dashboard server so the first paint isn't an error page
# (Chromium would never retry it on its own).
until python3 -c "import urllib.request,sys; urllib.request.urlopen(sys.argv[1], timeout=1)" "$URL" 2>/dev/null; do
  sleep 1
done

exec cage -d -- "$BROWSER" \
  --kiosk "$URL" \
  --ozone-platform=wayland \
  --incognito \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-translate \
  --disable-features=Translate,MediaRouter,OptimizationHints \
  --disable-background-networking \
  --disable-component-update \
  --disable-sync \
  --check-for-update-interval=31536000 \
  --renderer-process-limit=1 \
  --disk-cache-size=1 \
  --overscroll-history-navigation=0 \
  --disable-pinch
