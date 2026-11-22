"""Host-only routes / in-memory HTTP / Node VM stubs. No listener, TLS, browser or device."""
from html.parser import HTMLParser
from io import BytesIO
import json
import re
import shutil
import struct
import subprocess
import unittest
from urllib.parse import urlencode, urlsplit
from unittest.mock import patch

from fixture import Config, Fixture, MAX_POST, handler_for, https_origin

A, B, RUN = "https://a.fixture.test:8443", "https://b.fixture.test:8443", "host-R1"


def page_config(result):
    return json.loads(re.search(r"const cfg = (.*);\n", result.body.decode()).group(1))


class Tags(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.tags = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


class FakeConnection:
    def __init__(self, request):
        self.input, self.output = BytesIO(request), bytearray()

    def makefile(self, *_args):
        return self.input

    def sendall(self, data):
        self.output.extend(data)

    def settimeout(self, seconds):
        assert seconds == 10


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.app = Fixture(Config(A, B, RUN))
        self.s = self.app.config.scope

    def get(self, path, origin=A):
        return self.app.handle("GET", path, origin)

    def wire(self, request):
        conn = FakeConnection(request)
        # Exercise the real BaseHTTPRequestHandler parser without binding ANY socket.
        with patch("socket.socket", side_effect=AssertionError("host suite must not bind")):
            handler_for(self.app)(conn, ("127.0.0.1", 0), object())
        head, body = bytes(conn.output).split(b"\r\n\r\n", 1)
        lines = head.decode().split("\r\n")
        return int(lines[0].split()[1]), dict(x.split(": ", 1) for x in lines[1:]), body

    def test_explicit_distinct_https_origins_and_run_validation(self):
        self.assertEqual(https_origin("https://EXAMPLE.test:443/"), "https://example.test")
        self.assertEqual(https_origin("https://[::1]:8443"), "https://[::1]:8443")
        for bad in ("http://a.test", "https://u:p@a.test", "https://a.test/path", "https://a.test?x=1",
                    "https://a.test#f", "https://*.test", "https://a.test:0", "https://a.test:65536", "https://a.test:bad"):
            with self.subTest(origin=bad), self.assertRaises(ValueError):
                Config(bad, B, RUN)
        for run in ("", "../old", "a/b", "a%2fb", "x" * 49, "<script>"):
            with self.subTest(run=run), self.assertRaises(ValueError):
                Config(A, B, run)
        with self.assertRaises(ValueError):
            Config(A, A, RUN)
        with self.assertRaises(ValueError):
            self.app.origin_for_host("unknown.fixture.test:8443")

    def test_per_run_routes_and_scope_boundaries(self):
        for kind in ("install", "start", "inner", "offline", "never-cached"):
            result = self.get(self.s + kind)
            self.assertEqual(result.status, 200)
            self.assertEqual(page_config(result)["kind"], kind)
        cfg = page_config(self.get(self.s + "start"))
        self.assertEqual(cfg["paths"]["outside"], "/r/host-R1/app-x/out")
        self.assertFalse(cfg["paths"]["outside"].startswith(self.s))
        self.assertEqual(self.get(cfg["paths"]["outside"]).status, 200)
        self.assertEqual(self.get("/app-x/out?run=" + RUN).status, 200)
        self.assertEqual(self.get("/app-x/out?run=old").status, 400)
        self.assertEqual(self.get("/r/old/app/start").status, 404)
        self.assertEqual(self.get(self.s + "%69nner").status, 400)
        self.assertEqual(self.get("//unconfigured.test/path").status, 400)
        self.assertEqual(self.get(self.s + "post").status, 404)

    def test_manifest_identity_start_scope_and_first_party_pngs(self):
        result = self.get(self.s + "manifest.webmanifest")
        manifest = json.loads(result.body)
        self.assertEqual(manifest["id"], self.s + "id")
        self.assertEqual(manifest["start_url"], self.s + "start?launch=" + RUN)
        self.assertEqual(manifest["scope"], self.s)
        self.assertEqual(manifest["display"], "standalone")
        for entry, size in zip(manifest["icons"], (192, 512)):
            image = self.get(entry["src"])
            self.assertTrue(entry["src"].startswith(self.s))
            self.assertEqual(image.headers["Content-Type"], "image/png")
            self.assertEqual(image.body[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(struct.unpack(">II", image.body[16:24]), (size, size))
        run192 = Fixture(Config(A, B, "run192"))
        png512 = run192.handle("GET", "/r/run192/app/icon-512.png", A).body
        self.assertEqual(struct.unpack(">II", png512[16:24]), (512, 512))
        for origin, path, count in ((A, self.s + "install", 1), (B, self.s + "inner", 0),
                                    (A, "/r/" + RUN + "/app-x/out", 0)):
            tags = Tags(self.get(path, origin).body.decode()).tags
            self.assertEqual(sum(t == "link" and a.get("rel") == "manifest" for t, a in tags), count)

    def test_fresh_server_nonce_on_repeated_documents_and_b(self):
        one, two = (page_config(self.get(self.s + "inner")) for _ in range(2))
        self.assertNotEqual(one["serverNonce"], two["serverNonce"])
        self.assertNotEqual(one["serverRequestId"], two["serverRequestId"])
        self.assertEqual(one["serverInstance"], two["serverInstance"])
        self.assertEqual(page_config(self.get(self.s + "inner", B))["originB"], B)

    def test_controlled_redirects_no_arbitrary_destination(self):
        for target, dest in (("in", A + self.s + "inner"),
                             ("out", A + "/r/" + RUN + "/app-x/out"), ("b", B + self.s + "inner")):
            result = self.get(self.s + "redirect?target=" + target)
            self.assertEqual(result.status, 302)
            self.assertEqual(result.headers["Location"], dest)
        for target in ("https://third-party.test", "out&target=b", ""):
            self.assertEqual(self.get(self.s + "redirect?target=" + target).status, 400)

    def test_every_fixture_response_is_http_no_store(self):
        for path in (self.s + "start", self.s + "manifest.webmanifest", self.s + "icon-192.png",
                     self.s + "sw.js", self.s + "redirect", "/missing", self.s + "never-cached?fixture_offline=1"):
            with self.subTest(path=path):
                result = self.get(path)
                self.assertIn("no-store", result.headers["Cache-Control"])
                self.assertEqual(result.headers["Pragma"], "no-cache")

    def test_post_is_real_top_level_response_and_identical_replays_distinguishable(self):
        body = urlencode({"run": RUN, "submission": "same-token", "text": "same bytes"}).encode()
        req = (f"POST {self.s}post HTTP/1.0\r\nHost: {urlsplit(A).netloc}\r\n"
               f"Content-Type: application/x-www-form-urlencoded\r\nContent-Length: {len(body)}\r\n\r\n").encode() + body
        configs = []
        for _ in range(2):
            status, headers, html = self.wire(req)
            self.assertEqual(status, 200)
            self.assertNotIn("Location", headers)
            self.assertIn("no-store", headers["Cache-Control"])
            self.assertEqual(int(headers["Content-Length"]), len(html))
            cfg = page_config(type("Result", (), {"body": html})())
            self.assertEqual(cfg["requestMethod"], "POST")
            configs.append(cfg)
        self.assertEqual([x["postReceipt"]["identicalBodyOccurrence"] for x in configs], [1, 2])
        self.assertEqual(configs[0]["postReceipt"]["bodySha256"], configs[1]["postReceipt"]["bodySha256"])
        self.assertNotEqual(configs[0]["serverNonce"], configs[1]["serverNonce"])
        self.assertNotEqual(configs[0]["serverRequestId"], configs[1]["serverRequestId"])

    def test_form_has_no_ajax_substitute_and_user_text_cannot_break_scripts(self):
        value = "</script><script>alert(1)</script>__MANIFEST__ __CONFIG__ &\u2028"
        body = urlencode({"run": RUN, "submission": "s", "text": value}).encode()
        result = self.app.handle("POST", self.s + "post", A, body, "application/x-www-form-urlencoded")
        self.assertEqual(page_config(result)["postReceipt"]["fields"]["text"], [value])
        tags = Tags(result.body.decode()).tags
        scripts = [a for t, a in tags if t == "script"]
        self.assertEqual(scripts, [{}, {}])
        form = [a for t, a in tags if t == "form"][0]
        self.assertEqual((form["method"], form["target"]), ("post", "_self"))
        self.assertNotIn("onsubmit", form)
        self.assertNotIn("preventDefault", result.body.decode())

    def test_post_rejects_invalid_run_type_size_and_duplicate_run(self):
        for body, content_type, status in ((b"run=old", "application/x-www-form-urlencoded", 400),
                (("run=" + RUN + "&run=" + RUN).encode(), "application/x-www-form-urlencoded", 400),
                (b"x", "application/json", 415), (b"x" * (MAX_POST + 1), "application/x-www-form-urlencoded", 413)):
            self.assertEqual(self.app.handle("POST", self.s + "post", A, body, content_type).status, status)
        self.assertEqual(self.app.handle("POST", self.s + "inner", A).status, 405)

    def test_wire_host_body_framing_and_head(self):
        host = f"Host: {urlsplit(A).netloc}\r\n"
        cases = [("", "", 400), ("Host: unknown.test\r\n", "", 400),
                 (host + host, "", 400), (host, "", 411),
                 (host, "Content-Length: -1\r\n", 400),
                 (host, "Content-Length: 1\r\nContent-Length: 1\r\n", 400),
                 (host, "Transfer-Encoding: chunked\r\n", 400),
                 (host, f"Content-Length: {MAX_POST + 1}\r\n", 413),
                 (host, "Content-Length: 1\r\n", 400)]
        for headers, framing, expected in cases:
            raw = (f"POST {self.s}post HTTP/1.0\r\n" + headers + framing + "\r\n").encode()
            self.assertEqual(self.wire(raw)[0], expected)
        status, headers, body = self.wire((f"HEAD {self.s}start HTTP/1.0\r\n" + host + "\r\n").encode())
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertGreater(int(headers["Content-Length"]), 0)
        status, headers, body = self.wire((f"TRACE {self.s}inner HTTP/1.0\r\n" + host + "\r\n").encode())
        self.assertEqual(status, 501)
        self.assertIn("no-store", headers["Cache-Control"])

    def test_sw_exact_scope_unique_cache_and_fail_closed_without_controller(self):
        response = self.get(self.s + "sw.js")
        self.assertEqual(response.headers["Service-Worker-Allowed"], self.s)
        cfg = json.loads(response.body.decode().splitlines()[0].removeprefix("const CFG = ").removesuffix(";"))
        newer = Fixture(Config(A, B, RUN))
        other = newer.handle("GET", self.s + "sw.js", A)
        self.assertNotEqual(response.body, other.body)  # Cache namespace also changes on server restart.
        self.assertEqual(cfg["offline"], self.s + "offline")
        for kind in ("offline", "never-cached"):
            self.assertEqual(self.get(self.s + kind + "?fixture_offline=1").status, 409)

    def test_controls_probe_reuses_the_scoped_video_element(self):
        for suffix in ("inner", "inner?fullscreen=ua-controls"):
            with self.subTest(suffix=suffix):
                result = self.get(self.s + suffix)
                self.assertEqual(result.status, 200)
                self.assertEqual(page_config(result)["kind"], "inner")
                [video] = [attrs for tag, attrs in Tags(result.body.decode()).tags if tag == "video"]
                self.assertEqual(video["id"], "video")
                self.assertTrue({"controls", "muted", "playsinline"} <= video.keys())
                self.assertTrue({"controlslist", "src"}.isdisjoint(video.keys()))

    @unittest.skipUnless(shutil.which("node"), "Node is required for JS contract execution")
    def test_entry_history_fullscreen_trace_and_sw_stub_contracts(self):
        page = self.get(self.s + "inner").body.decode()
        scripts = re.findall(r"<script>(.*?)</script>", page, re.S)
        self.assertEqual(len(scripts), 2)
        body = urlencode({"run": RUN, "submission": "kept-token", "text": "kept form text"}).encode()
        post = self.app.handle("POST", self.s + "post", A, body, "application/x-www-form-urlencoded")
        probe = self.get(self.s + "inner?fullscreen=ua-controls").body.decode()
        payload = {"scripts": scripts, "postScripts": re.findall(r"<script>(.*?)</script>", post.body.decode(), re.S),
                   "probeScripts": re.findall(r"<script>(.*?)</script>", probe, re.S),
                   "worker": self.get(self.s + "sw.js").body.decode(), "origin": A}
        result = subprocess.run([shutil.which("node"), "-e", NODE_CONTRACTS], input=json.dumps(payload),
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("fixture JS and SW stub contracts PASS", result.stdout)


NODE_CONTRACTS = r"""
const assert = require('node:assert/strict'), vm = require('node:vm');
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => input += x);
process.stdin.on('end', async () => {try {
  const p = JSON.parse(input), stream = {synthetic: true};
  let clientSerial = 0;
  function makePage(href) {
    const events = {}, docEvents = {}, media = {}, nodes = {}, fullscreenCalls = [];
    let animationFrames = 0;
    const location = {href, origin: p.origin};
    const document = {readyState: 'loading', fullscreenElement: null, activeElement: null,
      addEventListener: (name, fn) => docEvents[name] = fn,
      exitFullscreen: async () => {fullscreenCalls.push('exit'); document.fullscreenElement = null;}};
    document.getElementById = id => nodes[id] ||= {id, handlers: {},
      addEventListener(name, fn) {this.handlers[name] = fn;},
      requestFullscreen: async () => {fullscreenCalls.push(id); document.fullscreenElement = nodes[id];},
      getContext: () => ({fillRect() {}, fillText() {}}),
      captureStream: fps => {assert.equal(fps, 12); return stream;}, play: async () => {}};
    const sandbox = {console, Date, JSON, Object, Promise, URL, crypto: {randomUUID: () => 'client-' + ++clientSerial},
      location, document, navigator: {}, innerWidth: 360, innerHeight: 720, isSecureContext: true,
      addEventListener: (name, fn) => events[name] = fn,
      matchMedia: query => media[query] = {matches: query.includes('browser'), addEventListener(name, fn) {this.change = fn;}},
      history: {pushState: (_state, _title, path) => location.href = p.origin + path, back() {}},
      requestAnimationFrame: () => animationFrames++, setTimeout, clearTimeout};
    sandbox.window = sandbox; vm.createContext(sandbox);
    return {sandbox, location, document, events, docEvents, media, nodes, fullscreenCalls,
      frames: () => animationFrames, run: script => vm.runInContext(script, sandbox),
      trace: () => JSON.parse(nodes['fullscreen-status'].textContent)};
  }
  const standard = makePage(p.origin + '/r/host-R1/app/inner');
  const {sandbox, location, events, docEvents, media, nodes, fullscreenCalls} = standard;
  standard.run(p.scripts[0]);
  const f = sandbox.fixture;
  assert.equal(f.entry.phase, 'loading'); assert.equal(f.entry.modes.browser, true);
  assert(Object.isFrozen(f.entry)); assert(Object.isFrozen(f.entry.modes));
  events.pageshow({persisted: false}); events.pageshow({persisted: true});
  assert.deepEqual(Array.from(f.pageshows, e => e.persisted), [false, true]);
  media['(display-mode: browser)'].matches = false;
  media['(display-mode: fullscreen)'].matches = true;
  media['(display-mode: fullscreen)'].change();
  assert.equal(f.live().modes.fullscreen, true); assert.equal(f.entry.modes.fullscreen, false);
  standard.run(p.scripts[1]);
  assert.deepEqual(fullscreenCalls, []); assert.equal(standard.frames(), 0); // No implicit work.
  assert.equal(standard.trace().mode, 'standard');
  const probeHref = p.origin + f.cfg.paths.inner + '?fullscreen=ua-controls';
  assert.equal(nodes['link-ua-controls'].href, probeHref);
  const originalServerNonce = f.entry.serverNonce, originalClientNonce = f.entry.clientDocumentNonce;
  for (const [id, path] of [['push-in', f.cfg.paths.inner], ['push-out', f.cfg.paths.outside], ['push-return', f.cfg.paths.inner]]) {
    await nodes[id].handlers.click(); assert.equal(new URL(location.href).pathname, path);
    assert.equal(f.entry.serverNonce, originalServerNonce); assert.equal(f.entry.clientDocumentNonce, originalClientNonce);
  }
  events.popstate(); assert.equal(f.events.at(-1).type, 'popstate');
  await nodes['start-video'].handlers.click();
  assert.equal(nodes.video.srcObject, stream); assert.equal(nodes.video.muted, true); assert.equal(nodes.video.playsInline, true);
  assert.equal(standard.frames(), 1);
  await nodes['dom-fullscreen'].handlers.click(); await nodes['video-fullscreen'].handlers.click();
  assert.equal(standard.trace().events.at(-1).type, 'fullscreen-api-attempt');
  assert.equal(standard.trace().events.at(-1).detail.action, 'video-fullscreen');
  docEvents.fullscreenchange({target: nodes.video, isTrusted: true}); // Stubbed observer data only.
  assert.equal(f.live().fullscreenElement, 'video');
  assert.equal(standard.trace().events.at(-1).detail.isTrusted, true);
  await nodes['exit-fullscreen'].handlers.click(); assert.deepEqual(fullscreenCalls, ['stage', 'video', 'exit']);
  assert.equal(f.events.some(e => e.type === 'ERROR'), false);

  const probe = makePage(probeHref);
  p.probeScripts.forEach(probe.run);
  assert.equal(probe.trace().mode, 'ua-controls');
  assert.equal(probe.nodes['ua-controls-help'].hidden, false);
  assert.equal(probe.nodes['fullscreen-trace'].open, true);
  for (const id of ['dom-fullscreen', 'video-fullscreen', 'exit-fullscreen', 'dom-back', 'push-in', 'push-out', 'push-return']) {
    assert.equal(probe.nodes[id].hidden, true);
    assert.equal(probe.nodes[id].handlers.click, undefined);
  }
  assert.deepEqual(probe.fullscreenCalls, []); assert.equal(probe.frames(), 0);
  const initial = probe.trace();
  probe.events.pageshow({persisted: false});
  await probe.nodes['start-video'].handlers.click();
  assert.equal(probe.nodes.video.srcObject, stream);
  assert.equal(probe.nodes.video.handlers.click, undefined);
  // Supply observer inputs only: this does not exercise a browser, a control tap or Android Back.
  probe.document.fullscreenElement = probe.nodes.video;
  probe.docEvents.fullscreenchange({target: probe.nodes.video, isTrusted: false});
  for (let i = 0; i < 20; i++) probe.events.resize();
  probe.document.fullscreenElement = null;
  probe.docEvents.fullscreenchange({target: probe.nodes.video, isTrusted: false});
  const trace = probe.trace();
  assert.equal(trace.clientDocumentNonce, initial.clientDocumentNonce);
  assert.equal(trace.href, initial.entryHref);
  assert.equal(trace.fullscreenElement, null);
  assert.deepEqual(trace.events.map(e => [e.type, e.fullscreenElement]), [
    ['pageshow', null], ['video-playing', null], ['fullscreenchange', 'video'], ['fullscreenchange', null]
  ]);
  for (const e of trace.events.slice(-2)) {
    assert.equal(e.detail.target, 'video'); assert.equal(e.detail.isTrusted, false); assert.equal(e.href, probeHref);
  }
  assert.deepEqual(probe.fullscreenCalls, []);
  probe.docEvents.fullscreenerror({target: probe.nodes.video, isTrusted: false});
  probe.events.pagehide({persisted: true}); probe.events.popstate();
  assert.deepEqual(probe.trace().events.slice(-3).map(e => e.type), ['fullscreenerror', 'pagehide', 'popstate']);

  const post = makePage(p.origin + f.cfg.paths.scope + 'post');
  p.postScripts.forEach(post.run);
  assert.equal(post.nodes['post-token'].value, 'kept-token'); assert.equal(post.nodes['post-text'].value, 'kept form text');
  assert.notEqual(post.sandbox.fixture.entry.clientDocumentNonce, originalClientNonce);

  const handlers = {}, stores = new Map(); let fetched = 0, ack;
  const worker = {URL, Response, Promise, console,
    self: {location: {origin: p.origin}, addEventListener: (name, fn) => handlers[name] = fn,
      skipWaiting: async () => {}, clients: {claim: async () => {}}},
    caches: {open: async name => {
      if (!stores.has(name)) stores.set(name, new Map()); const store = stores.get(name);
      return {put: async (url, resp) => store.set(url, resp.clone()), match: async url => store.get(url)?.clone()};
    }},
    fetch: async (url, opts) => {fetched++; assert.equal(url, p.origin + f.cfg.paths.offline);
      assert.equal(opts.cache, 'no-store'); return new Response('PRIME_SERVER_NONCE');}};
  vm.createContext(worker); vm.runInContext(p.worker, worker);
  for (const type of ['install', 'activate']) {let pending; handlers[type]({waitUntil: p => pending = p}); await pending;}
  assert.equal(fetched, 0); // Register/activate never prime implicitly.
  const nav = async (path, mode = 'navigate', method = 'GET', origin = p.origin) => {
    let pending; handlers.fetch({request: {url: origin + path, mode, method}, respondWith: p => pending = p});
    return pending === undefined ? undefined : await pending;
  };
  const off = f.cfg.paths.offline + '?fixture_offline=1&attempt=unique', never = f.cfg.paths.never + '?fixture_offline=1';
  assert.equal((await nav(off)).type, 'error'); assert.equal((await nav(never)).type, 'error');
  for (const path of [f.cfg.paths.inner + '?fixture_offline=1', '/r/old/app/offline?fixture_offline=1',
                      f.cfg.paths.outside + '?fixture_offline=1', f.cfg.paths.offline, f.cfg.paths.offline + '?fixture_offline=0']) {
    assert.equal(await nav(path), undefined);
  }
  assert.equal(await nav(off, 'cors'), undefined); assert.equal(await nav(off, 'navigate', 'POST'), undefined);
  assert.equal(await nav(off, 'navigate', 'GET', f.cfg.originB), undefined);
  let prime;
  handlers.message({data: {type: 'FIXTURE_PRIME', run: 'wrong'}, ports: [{postMessage: x => ack = x}], waitUntil: p => prime = p});
  assert.equal(prime, undefined); assert.equal(fetched, 0);
  handlers.message({data: {type: 'FIXTURE_PRIME', run: f.cfg.run}, ports: [{postMessage: x => ack = x}], waitUntil: p => prime = p});
  await prime; assert.equal(ack.ok, true); assert.equal(ack.wholePhoneOffline, false); assert.equal(fetched, 1);
  assert.equal((await nav(off)).status, 200); assert.equal(await (await nav(off)).text(), 'PRIME_SERVER_NONCE');
  assert.equal((await nav(never)).type, 'error'); assert.equal(fetched, 1);
  assert.deepEqual(Array.from(stores.values()).flatMap(store => [...store.keys()]), [p.origin + f.cfg.paths.offline]);
  console.log('fixture JS and SW stub contracts PASS (no browser or Android runtime)');
} catch (e) {console.error(e); process.exitCode = 1;}});
"""


if __name__ == "__main__":
    unittest.main()
