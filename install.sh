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
  say "Setting up Piper…"; npm run setup-piper || warn "Piper setup hit an issue — you can re-run 'npm run setup-piper' later."
fi

# ---- 8. optional: whisper.cpp STT (compiles on the Pi — slow) --------------
# The kiosk always runs in server-STT mode: kiosk Chromium has no working Web
# Speech API, so the mic must capture audio and POST to /api/stt. Without whisper
# below, /api/stt returns empty ("didn't catch that") — install it to transcribe.
KIOSK_URL="http://localhost:${PORT}/?stt=server"
if confirm "Install whisper.cpp for on-device speech-to-text? (compiles — several minutes)" n; then
  sudo apt-get install -y -qq build-essential cmake >/dev/null
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

# ---- 9. kiosk autostart -----------------------------------------------------
# Pi OS Desktop already runs a Wayland compositor (labwc on Pi 5, wayfire on Pi 4)
# — hook its autostart. Pi OS Lite has no desktop, so install `cage` (a one-app
# Wayland kiosk compositor) and boot straight into it on the console (tty1).
say "Setting up the full-screen kiosk on boot…"
KIOSK_CMD="env WONDRY_URL='${KIOSK_URL}' bash '${INSTALL_DIR}/tools/kiosk.sh'"
compositor=""
if pgrep -x labwc >/dev/null 2>&1 || command -v labwc >/dev/null 2>&1; then compositor=labwc
elif pgrep -x wayfire >/dev/null 2>&1 || command -v wayfire >/dev/null 2>&1; then compositor=wayfire; fi
case "$compositor" in
  labwc)
    mkdir -p "$HOME/.config/labwc"; AF="$HOME/.config/labwc/autostart"; touch "$AF"
    grep -qF "$INSTALL_DIR/tools/kiosk.sh" "$AF" || echo "$KIOSK_CMD &" >> "$AF"
    ok "Kiosk autostart added (labwc)";;
  wayfire)
    INI="$HOME/.config/wayfire.ini"; mkdir -p "$HOME/.config"; touch "$INI"
    grep -q '^\[autostart\]' "$INI" || printf '\n[autostart]\n' >> "$INI"
    grep -qF "$INSTALL_DIR/tools/kiosk.sh" "$INI" || sed -i "/^\[autostart\]/a wondry = ${KIOSK_CMD}" "$INI"
    ok "Kiosk autostart added (wayfire)";;
  *)
    # --- Pi OS Lite: no desktop. Build a minimal cage kiosk on tty1. ---
    say "No desktop found — setting up a minimal kiosk (cage) for Pi OS Lite…"
    # cage = single-app Wayland kiosk; pipewire/wireplumber = the audio server
    # Chromium needs to reach the mic (getUserMedia) and play TTS. Pi OS Lite
    # ships neither, so the USB mic is invisible to the browser without these.
    spin "Installing kiosk + audio (cage, pipewire)" \
      sudo apt-get install -y -qq cage pipewire pipewire-pulse wireplumber
    # cage needs DRM/input access; the default Pi user usually has these already.
    sudo usermod -aG video,render,input,audio "$USER" 2>/dev/null || true
    # PipeWire runs as the logged-in user; make sure its services come up in the
    # tty1 session (the packages enable these by default, but be explicit).
    systemctl --user enable pipewire pipewire-pulse wireplumber >/dev/null 2>&1 || true

    # Auto-login the console so a session exists to launch the kiosk from
    # (identical to raspi-config's "Console Autologin").
    sudo mkdir -p /etc/systemd/system/getty@tty1.service.d
    sudo tee /etc/systemd/system/getty@tty1.service.d/autologin.conf >/dev/null <<UNIT
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${USER} --noclear %I \$TERM
UNIT
    sudo systemctl daemon-reload

    # Launch cage from the tty1 login shell — only on the physical console, and
    # only when no graphical session is already running. cage exiting (browser
    # closed/crashed) ends the login, getty respawns, and it relaunches.
    PROFILE="$HOME/.bash_profile"
    [ -f "$PROFILE" ] || printf '[ -f ~/.profile ] && . ~/.profile\n' > "$PROFILE"
    if ! grep -qF 'WONDRY KIOSK' "$PROFILE"; then
      cat >> "$PROFILE" <<KIOSK
# --- WONDRY KIOSK (added by install.sh) ---
if [ "\$(tty)" = "/dev/tty1" ] && [ -z "\${WAYLAND_DISPLAY:-}" ] && [ -z "\${DISPLAY:-}" ]; then
  exec env WONDRY_URL='${KIOSK_URL}' cage -- bash '${INSTALL_DIR}/tools/kiosk.sh'
fi
# --- end WONDRY KIOSK ---
KIOSK
    fi
    ok "Kiosk set up (cage on tty1) — starts on next boot.";;
esac

# ---- done ------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
ok "Wondry is installed and running."
echo "   Kiosk (this device):   http://localhost:${PORT}/        (full-screen on next reboot)"
echo "   Parent console:        http://${IP:-<pi-ip>}:${PORT}/admin/   (open from your phone/laptop)"
echo "   Manage it:             wondry update · wondry logs · wondry status · wondry url"
echo
confirm "Reboot now to launch the kiosk?" n && sudo reboot
