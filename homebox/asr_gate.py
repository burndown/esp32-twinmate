#!/usr/bin/env python3
"""Token gate in front of the home speech-recognition service (esp32-stt, SenseVoice).

The gateway Worker runs in the cloud and reaches this machine only through a Cloudflare Tunnel; the tunnel points at this
gate (127.0.0.1:5016), never at the speech server itself. The gate checks a bearer token, caps the body size, forwards the
audio (WAV or raw 16 kHz PCM) to the LAN speech server and returns its JSON. It logs only status codes, never audio or text.

  POST /stt   Authorization: Bearer <token>   body: audio     ->  {"text": ..., "ms": ...}
  GET  /health                                                ->  {"ok": true}
"""
import hmac, logging, os, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOME = Path(os.environ.get("ASR_GATE_HOME", Path.home() / "asr-gate"))
BIND = os.environ.get("ASR_GATE_BIND", "127.0.0.1")
PORT = int(os.environ.get("ASR_GATE_PORT", "5016"))
UPSTREAM = os.environ.get("ASR_UPSTREAM", "http://127.0.0.1:5006/stt")   # your speech server (SenseVoice via sherpa-onnx, POST /stt)
MAX_BODY = 8 * 1024 * 1024
log = logging.getLogger("asr-gate")


def token():
    return (HOME / "token").read_text().strip()


class Handler(BaseHTTPRequestHandler):
    server_version = "asr-gate"

    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, b'{"ok": true}')
        self._send(404, b'{"error": "not found"}')

    def do_POST(self):
        if self.path != "/stt":
            return self._send(404, b'{"error": "not found"}')
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer ") or not hmac.compare_digest(auth[7:].encode(), token().encode()):
            return self._send(403, b'{"error": "forbidden"}')
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self._send(413, b'{"error": "bad size"}')
        body = self.rfile.read(n)
        req = urllib.request.Request(UPSTREAM, body, {
            "Content-Type": self.headers.get("Content-Type", "application/octet-stream"),
            "X-Sample-Rate": self.headers.get("X-Sample-Rate", "16000")})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return self._send(r.status, r.read())
        except urllib.error.HTTPError as e:
            log.warning("upstream http %s", e.code)
            return self._send(502, b'{"error": "upstream"}')
        except Exception as e:  # noqa: BLE001
            log.warning("upstream failed: %s", type(e).__name__)
            return self._send(502, b'{"error": "upstream"}')


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    if not (HOME / "token").exists():
        raise SystemExit(f"missing {HOME / 'token'}")
    log.info("asr-gate on %s:%s -> %s", BIND, PORT, UPSTREAM)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
