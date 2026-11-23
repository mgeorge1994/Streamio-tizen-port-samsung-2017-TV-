#!/usr/bin/env python3
"""Small receiver for live diagnostics sent by the native Tizen widget."""
import json
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG = os.environ.get(
    "TV_LOG_FILE",
    "/private/var/folders/38/1wf8qrc966b70tt8gk33qfk00000gn/T/opencode/tv-live.log",
)
PORT = int(os.environ.get("TV_LOG_PORT", "8877"))


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"ok\n")
            return
        try:
            with open(LOG, "r", encoding="utf-8", errors="replace") as f:
                body = f.read()
        except FileNotFoundError:
            body = ""
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode("utf-8", errors="replace"))

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            obj = json.loads(raw.decode("utf-8", errors="replace"))
        except Exception:
            obj = {"kind": "raw", "body": raw.decode("utf-8", errors="replace")}
        obj["received"] = datetime.now(timezone.utc).isoformat()
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj, sort_keys=True) + "\n")
            f.flush()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}\n')

    def log_message(self, fmt, *args):
        sys.stderr.write("[tv-log] " + (fmt % args) + "\n")


if __name__ == "__main__":
    print("listening on 0.0.0.0:%d -> %s" % (PORT, LOG), flush=True)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
