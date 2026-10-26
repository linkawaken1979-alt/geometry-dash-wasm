#!/usr/bin/env python3
"""Local server for the game: serves this folder like `python -m http.server`,
and adds the /__proxy?url=... endpoint the game uses for Geometry Dash server requests.
Run:  python3 server.py [port]     (default 8000)   then open http://localhost:8000/index.html
"""
import os, sys, urllib.request, urllib.error, urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ALLOWED = {'www.boomlings.com', 'boomlings.com'} | set(filter(None, os.environ.get('GD_PROXY_EXTRA_HOSTS', '').split(',')))

class Handler(SimpleHTTPRequestHandler):
    def _proxy(self):
        q = urllib.parse.urlparse(self.path)
        target = (urllib.parse.parse_qs(q.query).get('url') or [''])[0]
        t = urllib.parse.urlparse(target)
        if t.scheme not in ('http', 'https') or t.hostname not in ALLOWED:
            return self._send(403, b'host not allowed')
        body = None
        if self.command == 'POST':
            body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        req = urllib.request.Request(target, data=body, method=self.command)
        req.add_header('User-Agent', '')  # the GD servers reject requests that send a User-Agent
        if body is not None:
            req.add_header('Content-Type', 'application/x-www-form-urlencoded')
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return self._send(r.status, r.read(), r.headers.get('Content-Type'))
        except urllib.error.HTTPError as e:
            return self._send(e.code, e.read(), e.headers.get('Content-Type'))
        except Exception as e:
            return self._send(502, ('upstream error: %s' % e).encode())

    def _send(self, code, data, ctype=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype or 'text/plain')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/__proxy'): return self._proxy()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/__proxy'): return self._proxy()
        self.send_error(501, "Unsupported method ('POST')")

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print('Serving on http://localhost:%d/index.html' % port)
    ThreadingHTTPServer(('', port), Handler).serve_forever()
