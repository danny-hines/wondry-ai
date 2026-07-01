#!/usr/bin/env python3
"""Minimal Kokoro TTS sidecar for Wondry.

Exposes the OpenAI-compatible endpoint Wondry's TTS adapter already speaks
(POST /v1/audio/speech -> audio/wav), backed by kokoro-onnx on onnxruntime — the
same runtime Piper runs fast on the Pi, and NO torch. Uses the quantized (int8)
model by default for speed. Deliberately dependency-light: stdlib http.server only.

  KOKORO_MODEL   path to the .onnx model   (default: <repo>/kokoro/kokoro-v1.0.int8.onnx)
  KOKORO_VOICES  path to voices .bin        (default: <repo>/kokoro/voices-v1.0.bin)
  KOKORO_PORT    listen port                (default: 8880)
  KOKORO_DEFAULT_VOICE  fallback voice      (default: af_bella)
  OMP_NUM_THREADS       onnxruntime threads (default: all cores)
"""
import io
import json
import os
import wave

# Set thread count BEFORE onnxruntime is imported (via kokoro_onnx below).
os.environ.setdefault("OMP_NUM_THREADS", str(os.cpu_count() or 4))

import numpy as np  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402
from kokoro_onnx import Kokoro  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
MODEL = os.environ.get("KOKORO_MODEL") or os.path.join(REPO, "kokoro", "kokoro-v1.0.int8.onnx")
VOICES = os.environ.get("KOKORO_VOICES") or os.path.join(REPO, "kokoro", "voices-v1.0.bin")
PORT = int(os.environ.get("KOKORO_PORT", "8880"))
DEFAULT_VOICE = os.environ.get("KOKORO_DEFAULT_VOICE", "af_bella")

for p in (MODEL, VOICES):
    if not os.path.exists(p):
        raise SystemExit(f"missing {p} — run: npm run setup-kokoro")

kokoro = Kokoro(MODEL, VOICES)


def to_wav(samples, rate):
    """float32 [-1,1] mono -> 16-bit PCM WAV bytes (Web Audio decodes this directly)."""
    pcm = (np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(rate))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            self._send(200, b'{"ok":true}', "application/json")
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/audio/speech":
            self.send_error(404)
            return
        try:
            n = int(self.headers.get("content-length", 0) or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            text = (body.get("input") or "").strip()
            if not text:
                self.send_error(400, "no input")
                return
            voice = body.get("voice") or DEFAULT_VOICE
            speed = float(body.get("speed") or 1.0)
            # American voices (a*) are en-us; British (b*) are en-gb.
            lang = "en-gb" if str(voice)[:1] == "b" else "en-us"
            samples, rate = kokoro.create(text, voice=voice, speed=speed, lang=lang)
            self._send(200, to_wav(samples, rate), "audio/wav")
        except Exception as e:  # noqa: BLE001
            self.send_error(500, str(e))

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"Kokoro sidecar on http://127.0.0.1:{PORT}  model={os.path.basename(MODEL)}  "
          f"threads={os.environ.get('OMP_NUM_THREADS')}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
