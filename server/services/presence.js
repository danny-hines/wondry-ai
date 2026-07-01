// Presence: "greet on approach". The UI never touches the camera — a native helper
// (on the Pi, a Hailo NPU person-detector sidecar) decides when someone is in front
// of the device and POSTs that state to /api/presence. We debounce it and emit a
// 'presence' event over the WS bus; the kiosk reacts (the avatar says hello).
//
// Hailo sidecar contract: when a person appears/leaves the frame, POST
//   { "state": "present" | "absent" }  to  http://<device>:8080/api/presence
// That's the whole integration — no vision code runs in this app. For dev you can
// fire the same POST by hand to simulate someone walking up.
import { emit } from '../events.js';
import { getConfig } from '../config.js';

let last = { state: 'absent', at: 0 };

export function presenceEnabled() {
  return !!(getConfig().presence && getConfig().presence.enabled);
}
export function getPresence() {
  return { ...last, enabled: presenceEnabled() };
}

// Record a presence state from the detector (or a manual test POST) and broadcast it.
export function setPresence(state, meta = {}) {
  const s = state === 'present' ? 'present' : 'absent';
  const changed = s !== last.state;
  last = { state: s, at: Date.now() };
  emit('presence', { state: s, changed, meta });
  return last;
}
