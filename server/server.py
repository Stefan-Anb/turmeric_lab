#!/usr/bin/env python3
"""Optional local backend for TurmericLab (stdlib only, no dependencies).

The app itself stays a purely static site (GitHub Pages); nothing in the
frontend REQUIRES this server. It exists for developers working in a checkout:

  * serves the project as static files with `Cache-Control: no-store`
    (one dev/test server for everybody, edits show up without a hard reload)
  * offers a small JSON API under /api/ that the frontend detects at runtime
    (GET /api/status). On Pages the call 404s and the extra features stay hidden.

API
  GET  /api/status          -> {"backend": true, "librarySave": true, ...}
  POST /api/library/save    -> writes library/<file> and updates library.toml
       body: {"file","name","description","svg"}

Usage:  python server/server.py [port] [--host 127.0.0.1] [--root DIR]
"""
import argparse
import http.server
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit

DEFAULT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_BODY = 20 * 1024 * 1024
LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]")
FILE_RE = re.compile(r'^[^\\/:*?"<>|\x00-\x1f]+\.svg$')


class ApiError(Exception):
    def __init__(self, status, message):
        Exception.__init__(self, message)
        self.status = status
        self.message = message


# ── library.toml editing ──
# Text-level on purpose: the file is hand-maintained and full of comments,
# so it is patched in place instead of being re-serialised.
def toml_str(s):
    # JSON string escapes are valid TOML basic-string escapes.
    return json.dumps(s, ensure_ascii=False)


def bump_patch(v):
    m = re.match(r'^(\d+)\.(\d+)\.(\d+)$', v or '')
    if not m:
        return '1.0.0'
    return '%s.%s.%d' % (m.group(1), m.group(2), int(m.group(3)) + 1)


KV_RE = r'^(\s*%s\s*=\s*)("(?:[^"\\]|\\.)*"|\'[^\']*\')(.*)$'


def get_value(lines, key):
    for ln in lines:
        m = re.match(KV_RE % re.escape(key), ln)
        if m:
            raw = m.group(2)
            return json.loads(raw) if raw[0] == '"' else raw[1:-1]
    return None


def set_value(lines, key, value):
    """Replaces `key = "..."` keeping a trailing comment; appends if missing."""
    for i, ln in enumerate(lines):
        m = re.match(KV_RE % re.escape(key), ln)
        if m:
            lines[i] = m.group(1) + toml_str(value) + m.group(3)
            return
    # insert after the last non-empty line of the block
    j = len(lines)
    while j > 0 and not lines[j - 1].strip():
        j -= 1
    lines.insert(j, '%s = %s' % (key, toml_str(value)))


def update_toml(text, file, name, description):
    """Returns (new_text, entry_version, library_version, replaced)."""
    eol = '\r\n' if '\r\n' in text else '\n'
    lines = text.split(eol)
    # block boundaries: any line starting a table
    starts = [i for i, ln in enumerate(lines) if re.match(r'^\s*\[', ln)]
    starts.append(len(lines))
    blocks = []  # (start, end, header)
    for a, b in zip(starts, starts[1:]):
        blocks.append((a, b, lines[a].strip()))

    # library version
    lib_version = None
    for a, b, head in blocks:
        if head == '[library]':
            sub = lines[a + 1:b]
            lib_version = bump_patch(get_value(sub, 'version'))
            set_value(sub, 'version', lib_version)
            lines[a + 1:b] = sub
            break
    # block lengths may have changed (only if a key was appended): recompute
    starts = [i for i, ln in enumerate(lines) if re.match(r'^\s*\[', ln)]
    starts.append(len(lines))
    blocks = [(a, b, lines[a].strip()) for a, b in zip(starts, starts[1:])]

    for a, b, head in blocks:
        if head != '[[schematic]]':
            continue
        sub = lines[a + 1:b]
        if get_value(sub, 'file') == file:
            version = bump_patch(get_value(sub, 'version'))
            set_value(sub, 'name', name)
            set_value(sub, 'description', description)
            set_value(sub, 'version', version)
            lines[a + 1:b] = sub
            return eol.join(lines), version, lib_version, True

    # new entry, appended at the end
    while lines and not lines[-1].strip():
        lines.pop()
    lines += ['', '[[schematic]]',
              'file = %s' % toml_str(file),
              'name = %s' % toml_str(name),
              'description = %s' % toml_str(description),
              'version = "1.0.0"', '']
    return eol.join(lines), '1.0.0', lib_version, False


def atomic_write(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)


def save_library(root, payload):
    file = payload.get('file')
    name = (payload.get('name') or '').strip()
    description = (payload.get('description') or '').strip()
    svg = payload.get('svg')
    if not isinstance(file, str) or not FILE_RE.match(file) or file.startswith('.'):
        raise ApiError(400, 'Invalid file name')
    if not name or not isinstance(svg, str):
        raise ApiError(400, 'name and svg are required')
    try:
        doc = ET.fromstring(svg)
    except ET.ParseError as e:
        raise ApiError(400, 'SVG is not well-formed XML: %s' % e)
    if not any(el.get('id') == 'schematic-data' for el in doc.iter()):
        raise ApiError(400, 'SVG has no embedded schematic data')

    lib_dir = os.path.realpath(os.path.join(root, 'library'))
    toml_path = os.path.join(lib_dir, 'library.toml')
    svg_path = os.path.realpath(os.path.join(lib_dir, file))
    if os.path.dirname(svg_path) != lib_dir:
        raise ApiError(400, 'Invalid file name')
    if not os.path.isfile(toml_path):
        raise ApiError(500, 'library/library.toml not found')

    with open(toml_path, 'rb') as f:
        old_toml = f.read().decode('utf-8-sig')
    new_toml, version, lib_version, replaced = update_toml(old_toml, file, name, description)
    # svg first: if the toml write fails, the index still points at a valid file
    atomic_write(svg_path, svg.encode('utf-8'))
    atomic_write(toml_path, new_toml.encode('utf-8'))
    return {'ok': True, 'file': file, 'version': version,
            'libraryVersion': lib_version, 'replaced': replaced}


class Handler(http.server.SimpleHTTPRequestHandler):
    root = DEFAULT_ROOT

    def __init__(self, *args, **kwargs):
        http.server.SimpleHTTPRequestHandler.__init__(self, *args, directory=self.root, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        http.server.SimpleHTTPRequestHandler.end_headers(self)

    def log_message(self, fmt, *args):
        if not self.path.startswith('/api/') and not os.environ.get('TL_VERBOSE'):
            return
        http.server.SimpleHTTPRequestHandler.log_message(self, fmt, *args)

    # ── API ──
    def reply(self, status, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def check_local(self):
        """Writes must come from a page on this very server (CSRF / DNS rebinding)."""
        hostport = self.headers.get('Host') or ''
        host = hostport[:hostport.rfind(']') + 1] if hostport.startswith('[') else hostport.split(':')[0]
        if host not in LOCAL_HOSTS:
            raise ApiError(403, 'Forbidden host')
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc != hostport:
            raise ApiError(403, 'Forbidden origin')

    def handle_api(self, method):
        try:
            path = urlsplit(self.path).path
            if method == 'GET' and path == '/api/status':
                return self.reply(200, {'backend': True, 'librarySave': True})
            if method == 'POST' and path == '/api/library/save':
                self.check_local()
                n = int(self.headers.get('Content-Length') or 0)
                if n <= 0 or n > MAX_BODY:
                    raise ApiError(400, 'Bad request size')
                try:
                    payload = json.loads(self.rfile.read(n).decode('utf-8'))
                except ValueError:
                    raise ApiError(400, 'Invalid JSON')
                if not isinstance(payload, dict):
                    raise ApiError(400, 'Invalid JSON')
                return self.reply(200, save_library(self.root, payload))
            raise ApiError(404, 'Unknown endpoint')
        except ApiError as e:
            self.reply(e.status, {'ok': False, 'error': e.message})
        except Exception as e:  # keep the server alive, report to the client
            self.reply(500, {'ok': False, 'error': 'Server error: %s' % e})

    def do_GET(self):
        if self.path.startswith('/api/'):
            return self.handle_api('GET')
        http.server.SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        if self.path.startswith('/api/'):
            return self.handle_api('POST')
        self.send_error(405)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('port', nargs='?', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1',
                    help='bind address (default: loopback only; the API can write into library/)')
    ap.add_argument('--root', default=DEFAULT_ROOT, help='project root to serve')
    args = ap.parse_args()
    Handler.root = os.path.abspath(args.root)
    # ThreadingHTTPServer so concurrent requests (page + many assets + fetch)
    # don't block each other on a single thread.
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer((args.host, args.port), Handler) as httpd:
        print('Serving %s (no-cache) on http://%s:%d' % (Handler.root, 'localhost' if args.host == '127.0.0.1' else args.host, args.port))
        sys.stdout.flush()
        httpd.serve_forever()


if __name__ == '__main__':
    main()
