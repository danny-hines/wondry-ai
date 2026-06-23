// Wake word: hands-free "tap to talk". An on-device sidecar (tools/wakeword/wake.py,
// openWakeWord) listens for the configured phrase and POSTs /api/wake; we broadcast a
// 'wake' event over the WS bus and the kiosk reacts exactly like a face tap — it
// starts listening. Mirrors the presence pattern. Enable/choose the phrase from the
// parent console; off by default. 100% on-device — audio never leaves the Pi.
import { emit } from '../events.js';
import { getKV, setKV } from '../db.js';

// openWakeWord pretrained models we expose (key = model name it loads).
export const WAKE_PHRASES = [
  { key: 'hey_jarvis', label: 'Hey Jarvis' },
  { key: 'alexa', label: 'Alexa' },
  { key: 'hey_mycroft', label: 'Hey Mycroft' },
];
const DEFAULT_PHRASE = 'hey_jarvis';

export function getWakeConfig() {
  const phrase = getKV('wake_phrase', DEFAULT_PHRASE);
  return {
    enabled: getKV('wake_enabled', '0') === '1',
    phrase: WAKE_PHRASES.some((p) => p.key === phrase) ? phrase : DEFAULT_PHRASE,
    phrases: WAKE_PHRASES,
  };
}

export function setWakeConfig({ enabled, phrase } = {}) {
  if (enabled !== undefined) setKV('wake_enabled', enabled ? '1' : '0');
  if (phrase && WAKE_PHRASES.some((p) => p.key === phrase)) setKV('wake_phrase', phrase);
  return getWakeConfig();
}

// The sidecar fires this when it hears the word. Gate on enabled and de-dupe rapid
// double-fires so one utterance can't trigger two listens.
let lastWake = 0;
export function triggerWake(meta = {}) {
  if (!getWakeConfig().enabled) return { ok: false, reason: 'disabled' };
  const t = Date.now();
  if (t - lastWake < 1500) return { ok: false, reason: 'throttled' };
  lastWake = t;
  emit('wake', { meta });
  return { ok: true, at: t };
}
