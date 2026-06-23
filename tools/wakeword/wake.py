#!/usr/bin/env python3
"""Wondry on-device wake-word sidecar.

Listens to the default microphone with openWakeWord. When the configured wake word
is heard, POSTs /api/wake so the kiosk starts listening — exactly like tapping the
avatar's face. Polls /api/wake/config so the parent console can change the word or
turn it off without a restart, and only holds the mic open while enabled.

100% on-device: audio never leaves the Pi. Launched from the kiosk's Openbox
autostart (same session as Chromium) so it shares the mic via PipeWire.
"""
import os
import time
import json
import urllib.request

import numpy as np
import sounddevice as sd
from openwakeword.model import Model

BASE = os.environ.get("WONDRY_URL", "http://localhost:8080").rstrip("/")
SAMPLE_RATE = 16000
CHUNK = 1280                       # 80 ms @ 16 kHz — openWakeWord's frame size
THRESHOLD = float(os.environ.get("WAKE_THRESHOLD", "0.5"))
POLL_SECS = 5                      # how often to re-read config (phrase / on-off)
REFIRE_SECS = 2.0                  # ignore repeats within this window


def get_config():
    try:
        with urllib.request.urlopen(BASE + "/api/wake/config", timeout=3) as r:
            return json.load(r)
    except Exception:
        return None


def post_wake():
    try:
        req = urllib.request.Request(
            BASE + "/api/wake", data=b"{}",
            headers={"content-type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=3).read()
    except Exception:
        pass


def main():
    phrase = None
    model = None
    stream = None
    last_fire = 0.0

    def callback(indata, frames, time_info, status):
        nonlocal last_fire
        if model is None:
            return
        audio = (indata[:, 0] * 32767).astype(np.int16)
        score = model.predict(audio).get(phrase, 0.0)
        now = time.time()
        if score >= THRESHOLD and now - last_fire > REFIRE_SECS:
            last_fire = now
            print(f"wake! ({phrase}={score:.2f})", flush=True)
            post_wake()

    print(f"wake-word sidecar starting (server={BASE})", flush=True)
    while True:
        cfg = get_config()
        if cfg is not None:
            new_phrase = cfg.get("phrase", "hey_jarvis")
            enabled = bool(cfg.get("enabled", False))
            if new_phrase != phrase:
                phrase = new_phrase
                model = Model(wakeword_models=[phrase])
                print(f"wake word set to: {phrase}", flush=True)
            if enabled and stream is None:
                stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1,
                                        blocksize=CHUNK, dtype="float32", callback=callback)
                stream.start()
                print("listening for the wake word", flush=True)
            elif not enabled and stream is not None:
                stream.stop(); stream.close(); stream = None
                print("wake word disabled — mic released", flush=True)
        time.sleep(POLL_SECS)


if __name__ == "__main__":
    main()
