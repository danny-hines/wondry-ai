#!/usr/bin/env bash
# Wondry one-command installer for Raspberry Pi OS (Bookworm / Wayland).
#
#   curl -fsSL https://raw.githubusercontent.com/danny-hines/wondry-ai/main/install.sh | bash
#
# Installs Node 22, clones + builds the app, walks you through the .env (API key,
# admin password, port), runs it as a systemd service, and launches a full-screen
# kiosk on boot. Re-running updates in place (git pull + rebuild). It is interactive
# but also honours env vars for unattended installs, e.g.:
#   curl -fsSL .../install.sh | ANTHROPIC_API_KEY=sk-... ADMIN_PASSWORD=secret bash
set -euo pipefail

REPO_URL="${WONDRY_REPO:-https://github.com/danny-hines/wondry-ai.git}"
BRANCH="${WONDRY_BRANCH:-main}"
INSTALL_DIR="${WONDRY_DIR:-$HOME/wondry}"
NODE_MAJOR=22
SERVICE="wondry"
WHISPER_DIR="$HOME/whisper.cpp"

# ---- pretty output ---------------------------------------------------------
c() { printf '\033[%sm' "$1"; }
say()  { printf '%s▸ %s%s\n' "$(c '1;36')" "$*" "$(c 0)"; }
ok()   { printf '%s✓ %s%s\n' "$(c '1;32')" "$*" "$(c 0)"; }
warn() { printf '%s! %s%s\n' "$(c '1;33')" "$*" "$(c 0)"; }
die()  { printf '%s✗ %s%s\n' "$(c '1;31')" "$*" "$(c 0)" >&2; exit 1; }

# ---- prompts that work even under `curl | bash` (read from the terminal) ----
have_tty() { [ -e /dev/tty ]; }
# ask VAR "Prompt" "default"  — honours an existing env value, else asks the tty.
ask() {
  local var="$1" msg="$2" def="${3:-}" cur="${!1:-}"
  if [ -n "$cur" ]; then printf -v "$var" '%s' "$cur"; return; fi
  if have_tty; then
    local reply; read -r -p "$msg${def:+ [$def]}: " reply </dev/tty || true
    printf -v "$var" '%s' "${reply:-$def}"
  else printf -v "$var" '%s' "$def"; fi
}
ask_secret() {
  local var="$1" msg="$2" cur="${!1:-}"
  if [ -n "$cur" ]; then printf -v "$var" '%s' "$cur"; return; fi
  if have_tty; then
    local reply; read -rs -p "$msg: " reply </dev/tty || true; echo >/dev/tty
    printf -v "$var" '%s' "$reply"
  else printf -v "$var" '%s' ''; fi
}
# confirm "Question?" default(y/n) -> returns 0 for yes
confirm() {
  local msg="$1" def="${2:-n}" reply
  if ! have_tty; then [ "$def" = y ]; return; fi
  read -r -p "$msg ${def:+($( [ "$def" = y ] && echo Y/n || echo y/N ))} " reply </dev/tty || true
  reply="${reply:-$def}"; [[ "$reply" =~ ^[Yy] ]]
}

need_sudo() { command -v sudo >/dev/null 2>&1 || die "sudo is required"; }

# spin "Message" cmd args…  — run a (possibly silent, slow) command while showing
# a live elapsed-time indicator, so the terminal never looks frozen. Preserves the
# command's exit status; falls back to a plain run when there's no tty.
spin() {
  local msg="$1"; shift
  if ! have_tty; then say "$msg"; "$@"; return; fi
  "$@" & local pid=$! s=0 rc=0
  while kill -0 "$pid" 2>/dev/null; do
    printf '\r%s▸ %s%s … %ds ' "$(c '1;36')" "$msg" "$(c 0)" "$s"
    sleep 1; s=$((s+1))
  done
  wait "$pid" || rc=$?
  if [ "$rc" -eq 0 ]; then printf '\r%s✓ %s%s (%ds)%*s\n' "$(c '1;32')" "$msg" "$(c 0)" "$s" 6 ''
  else printf '\r%s✗ %s%s%*s\n' "$(c '1;31')" "$msg" "$(c 0)" 12 ''; fi
  return $rc
}

# ---- 0. preflight ----------------------------------------------------------
[ "$(id -u)" -ne 0 ] || die "Run as your normal user (e.g. 'pi'), not root — it uses sudo only where needed."
need_sudo
say "Wondry installer → $INSTALL_DIR"
case "$(uname -m)" in aarch64|arm64) ;; *) warn "Not arm64 ($(uname -m)) — should still work, but the Pi/Hailo path expects 64-bit." ;; esac

# Prime sudo up front (clear prompt, not a mid-run surprise) and keep the
# session warm so long steps don't re-prompt. Reads the password from the tty
# even under `curl | bash`.
if ! sudo -n true 2>/dev/null; then
  say "This needs administrator rights for a few steps. Enter your password for '$USER':"
  sudo -v </dev/tty || die "Could not get sudo — re-run and enter your password."
fi
( while kill -0 "$$" 2>/dev/null; do sudo -n true 2>/dev/null; sleep 50; done ) &
SUDO_KEEPALIVE=$!
trap 'kill "$SUDO_KEEPALIVE" 2>/dev/null || true' EXIT
ok "Administrator access granted"

# ---- 1. system packages ----------------------------------------------------
# These apt steps are silent and can run for minutes on a Pi — show live progress.
spin "Updating package lists (apt)" sudo apt-get update -qq
spin "Installing base packages" sudo apt-get install -y -qq git curl ca-certificates unclutter
# chromium is 'chromium-browser' on Pi OS, 'chromium' elsewhere
spin "Installing Chromium" bash -c \
  'sudo apt-get install -y -qq chromium-browser >/dev/null 2>&1 || sudo apt-get install -y -qq chromium >/dev/null 2>&1' \
  || warn "Could not install chromium automatically."
ok "Base packages ready"

# ---- 2. Node 22.5+ ---------------------------------------------------------
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v; v="$(node -p 'process.versions.node')"
  local maj="${v%%.*}" min; min="${v#*.}"; min="${min%%.*}"
  [ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 5 ]; }
}
if node_ok; then ok "Node $(node -v) already present"; else
  say "Installing Node ${NODE_MAJOR}.x (the app needs Node 22.5+ for built-in SQLite)…"
  spin "Adding NodeSource repository" bash -c \
    "curl -fsSL 'https://deb.nodesource.com/setup_${NODE_MAJOR}.x' | sudo -E bash - >/dev/null"
  spin "Installing Node.js" sudo apt-get install -y -qq nodejs
  node_ok || die "Node is still older than 22.5 after install ($(node -v 2>/dev/null)). Install it manually and re-run."
  ok "Node $(node -v) installed"
fi
NODE_BIN="$(command -v node)"

# ---- 3. clone or update ----------------------------------------------------
# If this script is already running from inside a clone, use that; else clone.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || echo '')"
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/package.json" ] && grep -q '"name": *"wondry"' "$SELF_DIR/package.json" 2>/dev/null; then
  INSTALL_DIR="$SELF_DIR"; ok "Using existing checkout at $INSTALL_DIR"
elif [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating existing install…"; git -C "$INSTALL_DIR" pull --ff-only; ok "Updated"
else
  say "Cloning $REPO_URL → $INSTALL_DIR…"; git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"; ok "Cloned"
fi
cd "$INSTALL_DIR"

# ---- 4. build + seed -------------------------------------------------------
say "Installing dependencies and building (a few minutes on a Pi)…"
npm install --no-fund --no-audit
npm run build
if [ ! -f data/wondry.db ]; then npm run seed && ok "Seeded sample kids"; else ok "Existing database kept"; fi

# ---- 5. .env ---------------------------------------------------------------
WROTE_ENV=0
if [ -f .env ] && ! confirm "An .env already exists — reconfigure it?" n; then
  ok "Keeping existing .env"
else
  say "Configuring .env"
  ask_secret ANTHROPIC_API_KEY "Anthropic API key (blank = run on the free keyless mock)"
  ask ADMIN_PASSWORD "Parent-console password" "wondry"
  ask PORT "Port to serve on" "8080"
  umask 177   # .env is 600
  cat > .env <<ENV
# Generated by install.sh — keep this file private.
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
PORT=${PORT}
ENV
  umask 022
  WROTE_ENV=1
  ok ".env written (chmod 600)$([ -z "$ANTHROPIC_API_KEY" ] && echo ' — no key, using mock generation')"
fi
PORT="$(grep -E '^PORT=' .env | cut -d= -f2)"; PORT="${PORT:-8080}"

# ---- 6. systemd service ----------------------------------------------------
say "Installing the server as a systemd service…"
sudo tee "/etc/systemd/system/${SERVICE}.service" >/dev/null <<UNIT
[Unit]
Description=Wondry server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${NODE_BIN} --experimental-sqlite server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null 2>&1 || true
sudo systemctl restart "$SERVICE"
ok "Service '${SERVICE}' enabled and started"

# Management CLI: `wondry update`, `wondry logs`, … (symlinked so it tracks the repo).
chmod +x "$INSTALL_DIR/tools/wondry" 2>/dev/null || true
sudo ln -sf "$INSTALL_DIR/tools/wondry" /usr/local/bin/wondry
ok "Installed the 'wondry' command (try: wondry update)"

# ---- 7. optional: Piper TTS ------------------------------------------------
if confirm "Install Piper TTS now (natural offline voice; recommended)?" y; then
  # python3-venv: setup-piper installs the engine into a venv (Bookworm blocks a
  # system `pip install` via PEP 668). ffmpeg/libstdc++ come via other steps.
  spin "Installing Piper prerequisites (python3-venv)" sudo apt-get install -y -qq python3-venv
  say "Setting up Piper…"; npm run setup-piper || warn "Piper setup hit an issue — you can re-run 'npm run setup-piper' later."
fi

# ---- 8. optional: whisper.cpp STT (compiles on the Pi — slow) --------------
# The kiosk always runs in server-STT mode: kiosk Chromium has no working Web
# Speech API, so the mic must capture audio and POST to /api/stt. Without whisper
# below, /api/stt returns empty ("didn't catch that") — install it to transcribe.
KIOSK_URL="http://localhost:${PORT}/?stt=server"
if confirm "Install whisper.cpp for on-device speech-to-text? (compiles — several minutes)" n; then
  # ffmpeg transcodes the browser's audio (webm/opus) to 16 kHz mono WAV for
  # whisper — whisper.cpp's built-in decoder only handles WAV/FLAC/MP3.
  sudo apt-get install -y -qq build-essential cmake ffmpeg >/dev/null
  if [ ! -x "$WHISPER_DIR/build/bin/whisper-cli" ]; then
    say "Building whisper.cpp in $WHISPER_DIR…"
    [ -d "$WHISPER_DIR/.git" ] || git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$WHISPER_DIR"
    cmake -S "$WHISPER_DIR" -B "$WHISPER_DIR/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
    cmake --build "$WHISPER_DIR/build" -j"$(nproc)" >/dev/null
  fi
  bash "$WHISPER_DIR/models/download-ggml-model.sh" base.en >/dev/null 2>&1 || warn "Model download failed — fetch ggml-base.en.bin manually."
  # point the server at whisper (the kiosk already runs in server-STT mode)
  grep -q '^WHISPER_CMD=' .env || cat >> .env <<ENV
WHISPER_CMD=${WHISPER_DIR}/build/bin/whisper-cli
WHISPER_MODEL=${WHISPER_DIR}/models/ggml-base.en.bin
ENV
  sudo systemctl restart "$SERVICE"
  ok "whisper.cpp wired up (kiosk will use on-device STT)"
fi

# ---- 9. kiosk autostart (X11: autologin → startx -nocursor → Openbox → Chromium)
# Pi OS Lite has no display server. Install a minimal X11 kiosk stack and boot
# straight into full-screen Chromium on tty1. `startx -- -nocursor` disables the
# mouse pointer at the X-server level (cage/Wayland has no equivalent), and
# unclutter hides it after any movement. Targets Pi OS Lite (64-bit).
say "Setting up the full-screen kiosk on boot…"
# X11 kiosk stack + the audio server Chromium needs for the mic (getUserMedia)
# and TTS playback. Pi OS Lite ships none of these.
spin "Installing kiosk stack (Xorg, Openbox, audio)" \
  sudo apt-get install -y --no-install-recommends \
    xserver-xorg xinit x11-xserver-utils openbox unclutter \
    pipewire pipewire-pulse wireplumber pulseaudio-utils
sudo usermod -aG video,render,input,audio,tty "$USER" 2>/dev/null || true
# PipeWire runs as the logged-in user; ensure its services come up in the session.
systemctl --user enable pipewire pipewire-pulse wireplumber >/dev/null 2>&1 || true

# Fonts: Pi OS Lite ships almost none, so emoji icons (🎤, ✨) render as tofu boxes
# and the UI + generated pages fall back to one default font. Install a color-emoji
# font, a rounded UI font, a Comic-Sans-alike, and broad symbol coverage…
spin "Installing fonts (emoji, rounded UI, symbols)" \
  sudo apt-get install -y --no-install-recommends \
    fonts-noto-color-emoji fonts-noto-core fonts-nunito fonts-comic-neue
# …then alias the Apple/Windows family names the app + already-generated artifacts
# request to the installed fonts, so they render instead of falling back. This is
# retroactive — no app/code change or artifact regeneration needed.
sudo tee /etc/fonts/local.conf >/dev/null <<'FONTS'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <alias binding="strong"><family>ui-rounded</family><prefer><family>Nunito</family></prefer></alias>
  <alias binding="strong"><family>Segoe UI</family><prefer><family>Nunito</family></prefer></alias>
  <alias binding="strong"><family>Comic Sans MS</family><prefer><family>Comic Neue</family></prefer></alias>
</fontconfig>
FONTS
fc-cache -f >/dev/null 2>&1 || true

# Force Xorg to use the vc4 KMS display via the `modesetting` driver as primary.
# A Pi exposes two DRM nodes (v3d render + vc4 display); without this, Xorg also
# autoconfigures the legacy `fbdev` driver, which fails fatally with
# "Cannot run in framebuffer mode … specify busIDs" and X never starts.
sudo mkdir -p /etc/X11/xorg.conf.d
sudo tee /etc/X11/xorg.conf.d/99-vc4-kms.conf >/dev/null <<'XORG'
Section "OutputClass"
  Identifier "vc4"
  MatchDriver "vc4"
  Driver "modesetting"
  Option "PrimaryGPU" "true"
EndSection
XORG

# Console autologin on tty1 so a session exists to start X from
# (identical to raspi-config's "Console Autologin").
sudo mkdir -p /etc/systemd/system/getty@tty1.service.d
sudo tee /etc/systemd/system/getty@tty1.service.d/autologin.conf >/dev/null <<UNIT
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${USER} --noclear %I \$TERM
UNIT
sudo systemctl daemon-reload

# Start X on the physical console (tty1) only; -nocursor kills the pointer.
PROFILE="$HOME/.bash_profile"
[ -f "$PROFILE" ] || printf '[ -f ~/.profile ] && . ~/.profile\n' > "$PROFILE"
# Strip any previous kiosk block first so upgrades (e.g. cage → X11) replace it.
sed -i '/# --- WONDRY KIOSK/,/# --- end WONDRY KIOSK ---/d' "$PROFILE"
cat >> "$PROFILE" <<'KIOSK'
# --- WONDRY KIOSK (added by install.sh) ---
if [ -z "${DISPLAY:-}" ] && [ "${XDG_VTNR:-0}" -eq 1 ]; then
  exec startx -- -nocursor
fi
# --- end WONDRY KIOSK ---
KIOSK

# .xinitrc → Openbox; Openbox autostart → screen-blanking off + a Chromium kiosk
# relaunch loop (kiosk.sh waits for the server's health endpoint, then execs it).
printf 'exec openbox-session\n' > "$HOME/.xinitrc"
mkdir -p "$HOME/.config/openbox"
cat > "$HOME/.config/openbox/autostart" <<AUTO
# never blank/sleep the kiosk screen
xset s off -dpms s noblank &

# pin the chosen mic/speaker as PipeWire defaults + sane levels (see: wondry audio)
( bash '${INSTALL_DIR}/tools/devices.sh' apply ) &

# run the Chromium kiosk forever — relaunch if it ever crashes
(
  while true; do
    env WONDRY_URL='${KIOSK_URL}' bash '${INSTALL_DIR}/tools/kiosk.sh'
    sleep 2
  done
) &
AUTO
ok "Kiosk set up (X11/Openbox on tty1) — starts on next boot."

# Offer to pick the mic/speaker/camera now. Needs a live PipeWire session, which
# a headless `curl | bash` install may not have — if so, just point at the
# `wondry audio` command to run after boot. The choice is saved by device name
# and re-pinned on every boot (handles phantom/extra inputs stealing the default).
if confirm "Pick the microphone/speaker now? (else run 'wondry audio' on the Pi later)" y; then
  bash "$INSTALL_DIR/tools/devices.sh" select || warn "Couldn't select devices now — run 'wondry audio' on the Pi after it boots."
fi

# ---- done ------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
ok "Wondry is installed and running."
echo "   Kiosk (this device):   http://localhost:${PORT}/        (full-screen on next reboot)"
echo "   Parent console:        http://${IP:-<pi-ip>}:${PORT}/admin/   (open from your phone/laptop)"
echo "   Manage it:             wondry update · wondry logs · wondry status · wondry url"
echo
confirm "Reboot now to launch the kiosk?" n && sudo reboot
