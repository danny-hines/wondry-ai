#!/usr/bin/env bash
# Launch the Wondry kiosk full-screen in Chromium on the Raspberry Pi.
# Assumes the Node server is already running (see the systemd unit in the README).
#
#   WONDRY_URL   the app URL to open      (default http://localhost:8080/)
#
# Flags of note: --kiosk hides all browser chrome (no URL bar); --use-fake-ui-for-
# media-stream auto-grants the microphone (server STT capture) with no prompt;
# --autoplay-policy lets the avatar's TTS audio play without a user gesture.
set -euo pipefail
URL="${WONDRY_URL:-http://localhost:8080/}"

# Wait for the server's health endpoint before opening the browser (handles boot order).
echo "Waiting for ${URL%/}/api/health …"
until curl -sf "${URL%/}/api/health" >/dev/null 2>&1; do sleep 1; done

# Raspberry Pi OS ships chromium-browser; newer images use chromium.
CHROME="$(command -v chromium-browser || command -v chromium || echo chromium)"

# Hide the mouse cursor when idle, if unclutter is installed.
command -v unclutter >/dev/null 2>&1 && unclutter -idle 0.5 -root &

exec "$CHROME" \
  --kiosk "$URL" \
  --start-fullscreen \
  --ozone-platform-hint=auto \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-translate \
  --disable-features=TranslateUI \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required \
  --use-fake-ui-for-media-stream \
  --check-for-update-interval=31536000 \
  --password-store=basic
