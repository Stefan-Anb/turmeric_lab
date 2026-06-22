#!/usr/bin/env python3
"""Tiny static dev server that disables caching.

The stock `python -m http.server` lets browsers cache JS/CSS, so edits don't
show up without a hard reload. This sends `Cache-Control: no-store` so the
preview always serves the current files.
"""
import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


# ThreadingHTTPServer so concurrent requests (page + many assets + fetch) don't
# block each other on a single thread.
http.server.ThreadingHTTPServer.allow_reuse_address = True
with http.server.ThreadingHTTPServer(("", PORT), NoCacheHandler) as httpd:
    print(f"Serving (no-cache) on http://localhost:{PORT}")
    httpd.serve_forever()
