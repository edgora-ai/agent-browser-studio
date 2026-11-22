"""Synthetic first-party fixture. Importing binds nothing; CLI requires existing TLS."""
import argparse
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
import ssl
import struct
import threading
from urllib.parse import parse_qs, urlsplit
import zlib

ROOT = Path(__file__).resolve().parent
MAX_POST = 16384
HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; "
        "style-src 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'; "
        "worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
}


def https_origin(value):
    """Canonical, explicit origin only: never a URL path, credential or TLS bypass."""
    u = urlsplit(value)
    if (u.scheme != "https" or not u.hostname or u.username is not None or
            u.password is not None or u.path not in ("", "/") or u.query or u.fragment or
            any(c.isspace() for c in value) or not re.fullmatch(r"[A-Za-z0-9.:\[\]-]+", u.netloc)):
        raise ValueError("An explicit HTTPS origin without credentials/path/query is required")
    port = 443 if u.port is None else u.port
    if not 1 <= port <= 65535:
        raise ValueError("Invalid origin port")
    host = u.hostname.lower()
    host = "[" + host + "]" if ":" in host else host
    return "https://" + host + (":" + str(port) if port != 443 else "")


@dataclass(frozen=True)
class Config:
    origin_a: str
    origin_b: str
    run: str

    def __post_init__(self):
        object.__setattr__(self, "origin_a", https_origin(self.origin_a))
        object.__setattr__(self, "origin_b", https_origin(self.origin_b))
        if self.origin_a == self.origin_b or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,47}", self.run):
            raise ValueError("Use two different HTTPS origins and a fresh safe run identifier")

    @property
    def scope(self):
        return "/r/" + self.run + "/app/"


@dataclass
class Response:
    status: int
    headers: dict
    body: bytes


def response(status, body, content_type="text/plain; charset=utf-8", **headers):
    data = body.encode() if isinstance(body, str) else body
    return Response(status, {**HEADERS, "Content-Type": content_type, **headers}, data)


def script_json(value):
    return json.dumps(value, ensure_ascii=True).replace("<", "\\u003c").replace("&", "\\u0026")


@lru_cache(maxsize=2)
def icon(size):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    row = b"\x00" + bytes((28, 74, 156, 255)) * size
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(row * size)) + chunk(b"IEND", b""))


class Fixture:
    def __init__(self, config):
        self.config = config
        self.instance = secrets.token_hex(8)
        self.serial = 0
        self.duplicates = Counter()
        self.lock = threading.Lock()
        self.page = (ROOT / "page.html").read_text()
        self.worker = (ROOT / "sw.js").read_text()

    def origin_for_host(self, host):
        candidate = https_origin("https://" + host)
        if candidate not in (self.config.origin_a, self.config.origin_b):
            raise ValueError("Unconfigured Host")
        return candidate

    def handle(self, method, target, origin, body=b"", content_type=""):
        c = self.config
        if origin not in (c.origin_a, c.origin_b):
            return response(421, "Unconfigured origin")
        u = urlsplit(target)
        if u.scheme or u.netloc or u.fragment or "%" in u.path or "\\" in u.path:
            return response(400, "Use exact fixture paths")
        p, s, query = u.path, c.scope, parse_qs(u.query, keep_blank_values=True)
        pages = {s + kind: kind for kind in ("install", "start", "inner", "offline", "never-cached")}
        pages[s.removesuffix("app/") + "app-x/out"] = "outside-prefix"
        pages["/app-x/out"] = "outside-absolute"
        if method == "POST":
            if p != s + "post":
                return response(405, "POST only at app/post", Allow="GET, HEAD")
            if content_type.split(";", 1)[0].strip().lower() != "application/x-www-form-urlencoded":
                return response(415, "Use the top-level URL-encoded form")
            if len(body) > MAX_POST:
                return response(413, "Synthetic form too large")
            try:
                fields = parse_qs(body.decode("utf-8", errors="strict"), keep_blank_values=True)
            except (ValueError, UnicodeError):
                return response(400, "Invalid UTF-8 form")
            if fields.get("run") != [c.run]:
                return response(400, "Wrong form run")
            return self.document("post", origin, method, fields, body, content_type)
        if method not in ("GET", "HEAD"):
            return response(405, "Unsupported method", Allow="GET, HEAD, POST")
        if p == s + "manifest.webmanifest":
            manifest = {"id": s + "id", "start_url": s + "start?launch=" + c.run,
                        "scope": s, "display": "standalone", "name": "PWA fixture " + c.run,
                        "short_name": "QA " + c.run, "background_color": "#102030", "theme_color": "#102030",
                        "icons": [{"src": s + "icon-" + str(n) + ".png", "sizes": str(n) + "x" + str(n),
                                   "type": "image/png", "purpose": "any"} for n in (192, 512)]}
            return response(200, json.dumps(manifest), "application/manifest+json")
        if p in (s + "icon-192.png", s + "icon-512.png"):
            return response(200, icon(192 if p.endswith("icon-192.png") else 512), "image/png")
        if p == s + "sw.js":
            cfg = {"run": c.run, "scope": s, "offline": s + "offline", "never": s + "never-cached",
                   "cache": "pwa-fixture-" + c.run + "-" + self.instance}
            return response(200, "const CFG = " + script_json(cfg) + ";\n" + self.worker,
                            "application/javascript", **{"Service-Worker-Allowed": s})
        if p == s + "redirect":
            choices = {"in": origin + s + "inner", "out": origin + s.removesuffix("app/") + "app-x/out",
                       "b": c.origin_b + s + "inner"}
            dest = query.get("target", ["in"])
            if len(dest) != 1 or dest[0] not in choices:
                return response(400, "Use redirect target in, out or b")
            return response(302, "Controlled fixture redirect", Location=choices[dest[0]])
        if p == "/app-x/out" and query.get("run") != [c.run]:
            return response(400, "Absolute escape requires this run query")
        if p not in pages:
            return response(404, "Not a route for this run")
        if pages[p] in ("offline", "never-cached") and "fixture_offline" in query:
            return response(409, "OFFLINE_BRANCH_REQUIRES_ACTIVE_SW; network was not disabled")
        return self.document(pages[p], origin, method)

    def document(self, kind, origin, method, fields=None, body=b"", content_type=""):
        c, s = self.config, self.config.scope
        nonce, digest = secrets.token_hex(12), hashlib.sha256(body).hexdigest()
        with self.lock:
            self.serial += 1
            request_id = c.run + ":" + self.instance + ":" + str(self.serial)
            if method == "POST":
                self.duplicates[(origin, digest)] += 1
            duplicate = self.duplicates[(origin, digest)] if method == "POST" else None
        outside = s.removesuffix("app/") + "app-x/out"
        paths = {"scope": s, "inner": s + "inner", "outside": outside, "offline": s + "offline", "never": s + "never-cached"}
        urls = {k: origin + s + k for k in ("install", "start", "inner")}
        urls.update({"outside": origin + outside, "absolute": origin + "/app-x/out?run=" + c.run,
                     "cross": c.origin_b + s + "inner", "returnA": c.origin_a + s + "inner",
                     "redirectIn": origin + s + "redirect?target=in", "redirectOut": origin + s + "redirect?target=out",
                     "redirectB": origin + s + "redirect?target=b", "sw": origin + s + "sw.js", "post": origin + s + "post"})
        cfg = {"run": c.run, "kind": kind, "originA": c.origin_a, "originB": c.origin_b,
               "serverInstance": self.instance, "serverRequestId": request_id, "serverNonce": nonce,
               "requestMethod": method, "paths": paths, "urls": urls,
               "postReceipt": None if method != "POST" else {"fields": fields, "bodySha256": digest,
                   "byteCount": len(body), "contentType": content_type, "identicalBodyOccurrence": duplicate}}
        manifest = ('<link rel="manifest" href="' + s + 'manifest.webmanifest">') if origin == c.origin_a and kind not in ("outside-prefix", "outside-absolute") else ""
        html = self.page.replace("__MANIFEST__", manifest, 1).replace("__CONFIG__", script_json(cfg), 1)
        return response(200, html, "text/html; charset=utf-8", **{"X-Fixture-Request-Id": request_id, "X-Fixture-Server-Nonce": nonce})


def handler_for(app):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"
        timeout = 10

        def log_message(self, *_args):
            pass  # No persistent log or synthetic body collection.

        def dispatch(self):
            try:
                hosts = self.headers.get_all("Host", [])
                if len(hosts) != 1:
                    raise ValueError("Exactly one Host required")
                origin = app.origin_for_host(hosts[0])
                sizes = self.headers.get_all("Content-Length", [])
                if self.headers.get("Transfer-Encoding") or len(sizes) > 1:
                    raise ValueError("Ambiguous body framing")
                if self.command == "POST" and not sizes:
                    self.emit(response(411, "Content-Length required")); return
                if sizes and not re.fullmatch(r"[0-9]+", sizes[0]):
                    raise ValueError("Invalid Content-Length")
                size = int(sizes[0]) if sizes else 0
                if size > MAX_POST:
                    self.emit(response(413, "Synthetic form too large")); return
                body = self.rfile.read(size)
                if len(body) != size:
                    raise ValueError("Incomplete body")
                self.emit(app.handle(self.command, self.path, origin, body, self.headers.get("Content-Type", "")))
            except ValueError as e:
                self.emit(response(400, str(e)))

        def send_error(self, code, message=None, explain=None):
            self.emit(response(code, message or self.responses.get(code, ("HTTP error",))[0]))

        def emit(self, result):
            self.send_response(result.status)
            for name, value in result.headers.items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(result.body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(result.body)

        do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = dispatch
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("origin-a", "origin-b", "run", "cert", "key"):
        parser.add_argument("--" + arg, required=True)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8443)
    args = parser.parse_args()
    app = Fixture(Config(args.origin_a, args.origin_b, args.run))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(args.cert, args.key)  # Existing operator-provisioned trust only.
    with ThreadingHTTPServer((args.bind, args.port), handler_for(app)) as server:
        server.socket = context.wrap_socket(server.socket, server_side=True)
        print("Manual HTTPS fixture only; already-trusted A/B origins and separate device GO required.", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
