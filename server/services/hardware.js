// Hardware behind interfaces, with MOCK backends as the default so the whole
// app boots and runs in a normal browser on a PC — the anti-"Pi-only" rule.
// On the Pi, swap these for real adapters (whisper.cpp / Piper / Hailo).
//
// NOTE on the chosen architecture: audio CAPTURE lives in the browser
// (getUserMedia + AudioWorklet) and posts PCM here; presence is an EVENT SOURCE
// (a native helper emits person-present/gone over the websocket). These mocks
// document the contract each real adapter must satisfy.

// STT is now implemented in services/stt.js (whisper.cpp via WHISPER_HTTP_URL or
// WHISPER_CMD+WHISPER_MODEL), served at POST /api/stt with a browser fallback.
export const STT = {
  backend: 'mock',
  async transcribe(/* pcmBuffer */) {
    return {
      text: '',
      backend: 'mock',
      note: 'Real adapter lives in services/stt.js; this stub is unused.',
    };
  },
};

export const TTS = {
  backend: 'mock',
  // Real Pi adapter: POST text to a local Piper server, return a WAV buffer.
  // In dev the kiosk shell falls back to the browser SpeechSynthesis API.
  async synthesize(text) {
    return { wav: null, text, backend: 'mock' };
  },
};

// Presence is now implemented in services/presence.js: a Hailo (or any) detector
// POSTs person present/absent to /api/presence, which emits a WS event the kiosk
// greets on. The UI only ever reacts to events; it never touches the camera.
export const Presence = {
  backend: 'mock',
  start(/* emit */) {
    /* real adapter lives in services/presence.js + routes/presence.js */
  },
};
