#!/usr/bin/env python3
"""
Local speech-to-text for the humanoid control UI.

Runs faster-whisper behind a tiny HTTP server so the model is loaded **once**,
at startup, instead of on every button press. Loading `base.en` takes a few
seconds; doing that per request would put five seconds of dead air between
releasing the mic button and seeing any text, which makes the whole thing feel
broken. Held in memory, a two-second command transcribes in well under a second.

Nothing leaves the machine. There is no API key and no network call — the model
files are pulled from Hugging Face on first run and cached in ~/.cache, after
which this works with the WiFi off.

    python3 tools/stt-server.py                 # base.en on :8123
    STT_MODEL=small.en python3 tools/stt-server.py
    STT_PORT=9000 python3 tools/stt-server.py

POST /transcribe   raw audio bytes (webm/opus, wav, m4a — anything ffmpeg reads)
                -> {"ok": true, "text": "...", "ms": 412}
GET  /health       -> {"ok": true, "model": "base.en", "ready": true}
"""

import io
import json
import os
import sys
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_NAME = os.environ.get("STT_MODEL", "base.en")
PORT = int(os.environ.get("STT_PORT", "8123"))
# int8 keeps this comfortable on a laptop CPU and costs almost nothing in
# accuracy for short, close-mic command phrases.
COMPUTE = os.environ.get("STT_COMPUTE", "int8")
MAX_BYTES = 25 * 1024 * 1024

model = None
model_lock = threading.Lock()   # faster-whisper is not safe to call concurrently
ready = False


def load_model():
    global model, ready
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("\n  faster-whisper is not installed for this interpreter.\n"
              f"  {sys.executable} -m pip install faster-whisper\n", file=sys.stderr)
        raise SystemExit(1)

    print(f"  loading whisper model '{MODEL_NAME}' ({COMPUTE}) …", flush=True)
    started = time.time()
    model = WhisperModel(MODEL_NAME, device="cpu", compute_type=COMPUTE)
    ready = True
    print(f"  model ready in {time.time() - started:.1f}s — listening on :{PORT}", flush=True)


def transcribe(audio_bytes):
    with model_lock:
        segments, _info = model.transcribe(
            io.BytesIO(audio_bytes),
            language="en",
            beam_size=1,              # commands are short; greedy is faster and just as good
            vad_filter=True,          # drops the silence around the button press
            vad_parameters={"min_silence_duration_ms": 300},
        )
        return " ".join(s.text.strip() for s in segments).strip()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, {"ok": True, "model": MODEL_NAME, "ready": ready})
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/transcribe"):
            return self._send(404, {"ok": False, "error": "not found"})
        if not ready:
            return self._send(503, {"ok": False, "error": "model still loading"})

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self._send(400, {"ok": False, "error": "empty body"})
        if length > MAX_BYTES:
            return self._send(413, {"ok": False, "error": "audio too large"})

        audio = self.rfile.read(length)
        started = time.time()
        try:
            text = transcribe(audio)
        except Exception as err:                                  # noqa: BLE001
            return self._send(500, {"ok": False, "error": str(err)})

        ms = int((time.time() - started) * 1000)
        print(f"  [stt] {ms:>5} ms  \"{text}\"", flush=True)
        self._send(200, {"ok": True, "text": text, "ms": ms})

    def log_message(self, *_args):
        pass          # the transcript line above is the only log worth having


if __name__ == "__main__":
    print("\n  Humanoid · local speech-to-text (faster-whisper)")
    load_model()
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped")
