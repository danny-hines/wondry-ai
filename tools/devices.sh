#!/usr/bin/env bash
# Wondry audio/camera device selection.
#   devices.sh select   pick mic / speaker / camera; saved by stable node name
#   devices.sh apply     pin the saved devices as PipeWire defaults (run at boot)
#
# Pi OS Lite often enumerates phantom inputs (e.g. an "AB13X Headset Adapter") and
# may pick the wrong default source, so the browser's getUserMedia grabs a dead
# mic. This lets the operator lock in the right devices once, by name, so the
# choice survives reboots and PipeWire node-id reshuffles.
set -uo pipefail
DIR="${WONDRY_DIR:-$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)}"
PREF="$DIR/.kiosk-devices"

# Populate parallel arrays NAMES[]/DESCS[] for a pactl kind (sources|sinks),
# skipping sink-monitor sources.
list_audio() {
  NAMES=(); DESCS=()
  local name desc
  while IFS=$'\t' read -r name desc; do
    [[ "$name" == *.monitor ]] && continue
    NAMES+=("$name"); DESCS+=("$desc")
  done < <(pactl list "$1" 2>/dev/null | awk '
    /^[[:space:]]*Name:/ {name=$2}
    /^[[:space:]]*Description:/ {d=$0; sub(/^[[:space:]]*Description: /,"",d); print name "\t" d}
  ')
}

id_for() { pactl list short "$1" 2>/dev/null | awk -F'\t' -v N="$2" '$2==N{print $1; exit}'; }

# choose <sources|sinks> <label>  -> echoes the chosen stable NAME (empty = keep)
choose() {
  list_audio "$1"
  if [ "${#NAMES[@]}" -eq 0 ]; then echo "  (no $2 devices found)" >&2; echo ""; return; fi
  echo "Select the $2:" >&2
  local i
  for i in "${!NAMES[@]}"; do printf '  %d) %s\n' "$((i + 1))" "${DESCS[$i]:-${NAMES[$i]}}" >&2; done
  printf '  0) leave unchanged\n' >&2
  local sel; read -r -p "  choice: " sel </dev/tty || true
  [[ "$sel" =~ ^[0-9]+$ ]] && [ "$sel" -ge 1 ] && [ "$sel" -le "${#NAMES[@]}" ] && { echo "${NAMES[$((sel - 1))]}"; return; }
  echo ""
}

# echoes the chosen /dev/videoN (empty = keep)
choose_cam() {
  local devs=() labels=() d n
  for d in /dev/video*; do
    [ -e "$d" ] || continue
    n="$(cat "/sys/class/video4linux/$(basename "$d")/name" 2>/dev/null || echo "$d")"
    devs+=("$d"); labels+=("$n  ($d)")
  done
  [ "${#devs[@]}" -eq 0 ] && { echo ""; return; }
  echo "Select the CAMERA (saved for the presence/vision pipeline; the kiosk itself uses only the mic):" >&2
  local i
  for i in "${!devs[@]}"; do printf '  %d) %s\n' "$((i + 1))" "${labels[$i]}" >&2; done
  printf '  0) leave unchanged\n' >&2
  local sel; read -r -p "  choice: " sel </dev/tty || true
  [[ "$sel" =~ ^[0-9]+$ ]] && [ "$sel" -ge 1 ] && [ "$sel" -le "${#devs[@]}" ] && { echo "${devs[$((sel - 1))]}"; return; }
  echo ""
}

cmd_select() {
  command -v pactl >/dev/null 2>&1 || { echo "pactl not found — install pipewire-pulse, then retry." >&2; exit 1; }
  pactl info >/dev/null 2>&1 || { echo "PipeWire isn't reachable here. Run this on the Pi after boot:  wondry audio" >&2; exit 1; }
  local src sink cam
  src="$(choose sources microphone)"
  sink="$(choose sinks speaker)"
  cam="$(choose_cam)"
  # merge over any existing prefs (blank/0 keeps the previous value)
  [ -f "$PREF" ] && . "$PREF"
  [ -n "$src" ]  && AUDIO_SOURCE="$src"
  [ -n "$sink" ] && AUDIO_SINK="$sink"
  [ -n "$cam" ]  && VIDEO_DEVICE="$cam"
  {
    echo "# Wondry device prefs — stable names, re-applied each boot by 'devices.sh apply'."
    [ -n "${AUDIO_SOURCE:-}" ] && echo "AUDIO_SOURCE=$AUDIO_SOURCE"
    [ -n "${AUDIO_SINK:-}" ]   && echo "AUDIO_SINK=$AUDIO_SINK"
    [ -n "${VIDEO_DEVICE:-}" ] && echo "VIDEO_DEVICE=$VIDEO_DEVICE"
  } > "$PREF"
  echo; echo "Saved to $PREF:"; sed 's/^/  /' "$PREF"
  cmd_apply
  echo "Done — the kiosk will use these on every boot."
}

cmd_apply() {
  [ -f "$PREF" ] || exit 0
  . "$PREF"
  # wait briefly for PipeWire to come up (boot ordering)
  local i; for i in $(seq 1 10); do pactl info >/dev/null 2>&1 && break; sleep 1; done
  local id
  if [ -n "${AUDIO_SOURCE:-}" ]; then id="$(id_for sources "$AUDIO_SOURCE")"; [ -n "$id" ] && wpctl set-default "$id" 2>/dev/null || true; fi
  if [ -n "${AUDIO_SINK:-}" ];   then id="$(id_for sinks   "$AUDIO_SINK")";   [ -n "$id" ] && wpctl set-default "$id" 2>/dev/null || true; fi
  # sane levels: unmute, and tame mic gain so a close/loud speaker doesn't clip
  wpctl set-mute   @DEFAULT_AUDIO_SOURCE@ 0    2>/dev/null || true
  wpctl set-volume @DEFAULT_AUDIO_SOURCE@ 0.85 2>/dev/null || true
  wpctl set-mute   @DEFAULT_AUDIO_SINK@   0    2>/dev/null || true
}

case "${1:-}" in
  select) cmd_select ;;
  apply)  cmd_apply ;;
  *) echo "usage: devices.sh {select|apply}" >&2; exit 2 ;;
esac
