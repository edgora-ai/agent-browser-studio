package com.ahoo.abs.core;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Dependency-free executable contract tests; any failed assertion exits nonzero. */
public final class CoreContractTest {
    private static final String ID = "12345678-1234-4234-8234-123456789abc";
    private static final String REV = "22345678-1234-4234-8234-123456789abc";
    private static final String SESSION = "32345678-1234-4234-8234-123456789abc";
    private static final String NONCE = "42345678-1234-4234-8234-123456789abc";
    private static final String OTHER = "52345678-1234-4234-8234-123456789abc";
    private static final long NOW = 1_800_000_000_000L;
    private static int passed;
    private static int failed;

    private CoreContractTest() {}

    public static void main(String[] args) {
        if (args.length == 1 && "--prove-failure-exit".equals(args[0])) {
            test("runner reports a real failed assertion", () -> eq("expected", "actual"));
        } else {
            proxies();
            profiles();
            launches();
            navigation();
            admissions();
            ping0Observations();
            runtime();
            lifecycleControl();
            edgeCases();
        }
        System.out.println("TOTAL " + (passed + failed) + " PASS " + passed + " FAIL " + failed);
        if (failed != 0) throw new AssertionError(failed + " contract test(s) failed");
    }

    private static void proxies() {
        for (ProxySpec.Scheme scheme : ProxySpec.Scheme.values()) {
            test("proxy rule has no credentials: " + scheme, () -> {
                ProxySpec p = new ProxySpec(scheme, "BÜCHER.Example.", 8443, true);
                eq("xn--bcher-kva.example", p.host);
                eq("xn--bcher-kva.example:8443", p.authority());
                eq(scheme.name().toLowerCase(java.util.Locale.ROOT) + "://" + p.authority(), p.proxyRule());
                check(!p.proxyRule().contains("@"), "userinfo leaked");
            });
        }
        test("IPv6 canonical and bracketed authority", () -> {
            ProxySpec p = new ProxySpec(ProxySpec.Scheme.SOCKS5, "[2001:0DB8:0:0:0:0:0:1]", 1080, false);
            eq("2001:db8::1", p.host); eq("[2001:db8::1]:1080", p.authority());
            eq("socks5://[2001:db8::1]:1080", p.proxyRule());
            eq("[::]:1", proxy("::", 1).authority());
            eq("[::ffff:c000:280]:65535", proxy("::ffff:192.0.2.128", 65535).authority());
        });
        for (String host : new String[]{"user:password@example.com", "http://example.com", "example.com/path",
                "example.com?x", "example.com#x", "bad\\host", "bad\nhost", "bad\u0000host", "bad host",
                "[example.com]", "2001:::1", "2001:db8:1", "[::1", "::1%lo0", "127.1", "0127.0.0.1",
                "256.1.1.1", "0x7f000001", "a..example", "-bad.example", "xn--.example", "\ud800.example", ""}) {
            test("reject proxy host " + printable(host), () -> reject(() -> proxy(host, 80)));
        }
        for (int port : new int[]{-1, 0, 65536, Integer.MAX_VALUE}) {
            test("reject proxy port " + port, () -> bad("INVALID_PORT", () -> proxy("example.com", port)));
        }
        test("reject null proxy scheme", () -> reject(() -> new ProxySpec(null, "example.com", 80, false)));
        test("reject null proxy host", () -> reject(() -> proxy(null, 80)));
    }

    private static void profiles() {
        test("profile canonical UUID country locale and independent immutable list", () -> {
            List<String> tags = new ArrayList<>(Arrays.asList("EN-us", "zh-hans-cn"));
            ProfileSpec p = spec(ID.toUpperCase(java.util.Locale.ROOT), REV, "Example", proxy("example.com", 80),
                    "us", "America/New_York", tags, ProfileSpec.DeviceMode.NATIVE, "", "");
            eq(ID, p.id); eq("US", p.countryCode); eq(Arrays.asList("en-US", "zh-Hans-CN"), p.languageTags);
            tags.set(0, "fr"); eq("en-US", p.languageTags.get(0));
            try { p.languageTags.add("de"); throw new AssertionError("mutable languages"); }
            catch (UnsupportedOperationException expected) { eq(2, p.languageTags.size()); }
        });
        test("directory comes only from UUID", () -> {
            ProfileSpec p = profile(); eq("p_" + ID.replace("-", ""), p.dataDirectorySuffix());
            check(p.dataDirectorySuffix().matches("p_[0-9a-f]{32}"), "unsafe suffix");
            eq(p.dataDirectorySuffix(), named("../../not-a-path").dataDirectorySuffix());
        });
        for (String value : new String[]{"../escape", ID + "/../x", "%2f..%2f", "1-1-1-1-1", ID + "\u0000"}) {
            test("reject profile directory injection " + printable(value), () ->
                    reject(() -> spec(value, REV, "Test", profile().proxy, "", "UTC", langs(),
                            ProfileSpec.DeviceMode.NATIVE, "", "")));
        }
        test("reject non UUID revision", () -> reject(() -> spec(ID, "1", "Test", profile().proxy,
                "", "UTC", langs(), ProfileSpec.DeviceMode.NATIVE, "", "")));
        for (String name : new String[]{"", "   ", repeat("a", 81), "bad\rname", "bad\u0085name", "\ud800"}) {
            test("reject profile name " + printable(name), () -> reject(() -> named(name)));
        }
        test("80 Unicode code points are valid", () -> eq(repeat("😀", 80), named(repeat("😀", 80)).name));
        for (String country : new String[]{"ZZ", "USA", "U1", "U\nS"}) {
            test("reject country " + printable(country), () -> reject(() -> variant(country, "UTC", langs(), "")));
        }
        for (String zone : new String[]{"Mars/Olympus", "America/Fake", "UTC\n", ""}) {
            test("reject time zone " + printable(zone), () -> reject(() -> variant("", zone, langs(), "")));
        }
        for (String tag : new String[]{"en_US", "en--US", "a", "en-!", "en\u0000US", ""}) {
            test("reject BCP47 " + printable(tag), () -> reject(() -> variant("", "UTC", Arrays.asList(tag), "")));
        }
        test("reject empty language list", () -> reject(() -> variant("", "UTC", Collections.emptyList(), "")));
        test("reject null language list", () -> reject(() -> variant("", "UTC", null, "")));
        test("reject null language element", () -> reject(() -> variant("", "UTC", Arrays.asList((String) null), "")));
        test("reject duplicate canonical language", () -> reject(() -> variant("", "UTC", Arrays.asList("en-US", "EN-us"), "")));
        for (String model : new String[]{repeat("a", 129), "Model\nX"}) {
            test("reject device model " + printable(model), () -> reject(() -> variant("", "UTC", langs(), model)));
        }
        test("credential revision matches auth presence", () -> {
            ProxySpec auth = new ProxySpec(ProxySpec.Scheme.HTTP, "example.com", 80, true);
            ProfileSpec p = spec(ID, REV, "Test", auth, "", "UTC", langs(), ProfileSpec.DeviceMode.NATIVE, "", OTHER);
            eq(OTHER, p.credentialRevision);
            reject(() -> spec(ID, REV, "Test", auth, "", "UTC", langs(), ProfileSpec.DeviceMode.NATIVE, "", ""));
            reject(() -> spec(ID, REV, "Test", auth, "", "UTC", langs(), ProfileSpec.DeviceMode.NATIVE, "", "sha256:secret"));
            reject(() -> spec(ID, REV, "Test", profile().proxy, "", "UTC", langs(), ProfileSpec.DeviceMode.NATIVE, "", OTHER));
        });
        test("canonical fingerprint is deterministic and covers every field", () -> {
            ProfileSpec p = profile(); String hash = p.fingerprint(); check(hash.matches("[0-9a-f]{64}"), "not SHA256 hex");
            eq(hash, profile().fingerprint());
            List<ProfileSpec> changed = Arrays.asList(
                    spec(OTHER, REV, p.name, p.proxy, "", "UTC", langs(), p.deviceMode, "", ""),
                    spec(ID, OTHER, p.name, p.proxy, "", "UTC", langs(), p.deviceMode, "", ""), named("Changed"),
                    spec(ID, REV, p.name, proxy("other.example", 80), "", "UTC", langs(), p.deviceMode, "", ""),
                    spec(ID, REV, p.name, proxy("example.com", 81), "", "UTC", langs(), p.deviceMode, "", ""),
                    spec(ID, REV, p.name, new ProxySpec(ProxySpec.Scheme.HTTPS, "example.com", 80, false), "", "UTC", langs(), p.deviceMode, "", ""),
                    variant("DE", "UTC", langs(), ""), variant("", "Asia/Tokyo", langs(), ""),
                    variant("", "UTC", Arrays.asList("fr", "en-US"), ""), variant("", "UTC", langs(), "Pixel"),
                    spec(ID, REV, p.name, p.proxy, "", "UTC", langs(), ProfileSpec.DeviceMode.DECLARED_ANDROID, "", ""));
            for (ProfileSpec other : changed) check(!hash.equals(other.fingerprint()), "field omitted from fingerprint");
            ProfileSpec a = authenticated(REV); ProfileSpec b = authenticated(OTHER);
            check(!a.fingerprint().equals(b.fingerprint()), "credential rotation omitted");
            check(!hash.equals(a.fingerprint()), "auth flag omitted");
            eq(proxy("BÜCHER.example", 80).host, proxy("xn--bcher-kva.example", 80).host);
        });
    }

    private static void launches() {
        test("launch identity config hash and stable profile directory", () -> {
            LaunchSpec a = launch(SESSION, NONCE, NOW, NOW + 120000);
            eq(SESSION, a.sessionId); eq(NONCE, a.nonce); a.validateAt(NOW);
            eq(a.configHash(), launch(SESSION, NONCE, NOW, NOW + 120000).configHash());
            check(a.configHash().matches("[0-9a-f]{64}"), "not SHA256");
            for (LaunchSpec b : Arrays.asList(launch(OTHER, NONCE, NOW, NOW + 120000),
                    launch(SESSION, OTHER, NOW, NOW + 120000), launch(SESSION, NONCE, NOW + 1, NOW + 120000),
                    launch(SESSION, NONCE, NOW, NOW + 119999), new LaunchSpec(named("Changed"), SESSION, NONCE, NOW, NOW + 120000))) {
                check(!a.configHash().equals(b.configHash()), "launch field omitted"); eq(a.directorySuffix(), b.directorySuffix());
            }
            eq(profile().dataDirectorySuffix(), a.directorySuffix());
        });
        for (long ttl : new long[]{0, -1, 120001}) {
            test("reject launch TTL " + ttl, () -> bad("INVALID_TTL", () -> launch(SESSION, NONCE, NOW, NOW + ttl)));
        }
        test("reject invalid launch identifiers", () -> {
            reject(() -> launch("../../session", NONCE, NOW, NOW + 100));
            reject(() -> launch(SESSION, "1-1-1-1-1", NOW, NOW + 100));
            reject(() -> launch(SESSION, NONCE, -1, 100));
            bad("LAUNCH_FROM_FUTURE", () -> launch(SESSION, NONCE, Long.MAX_VALUE - 5, Long.MAX_VALUE).validateAt(NOW));
        });
        test("expiry and unreasonable future fail", () -> {
            LaunchSpec a = launch(SESSION, NONCE, NOW, NOW + 1000); a.validateAt(NOW + 999);
            bad("LAUNCH_EXPIRED", () -> a.validateAt(NOW + 1000));
            bad("LAUNCH_FROM_FUTURE", () -> a.validateAt(NOW - 5001)); reject(() -> a.validateAt(-1));
        });
        test("replay rejects duplicate nonce and duplicate session", () -> {
            LaunchReplayGuard guard = new LaunchReplayGuard(4); guard.consume(launch(SESSION, NONCE, NOW, NOW + 1000), NOW);
            bad("LAUNCH_REPLAY", () -> guard.consume(launch(SESSION, NONCE, NOW, NOW + 1000), NOW));
            bad("LAUNCH_REPLAY", () -> guard.consume(launch(OTHER, NONCE, NOW, NOW + 1000), NOW));
            bad("LAUNCH_REPLAY", () -> guard.consume(launch(SESSION, OTHER, NOW, NOW + 1000), NOW));
        });
        test("replay guard never evicts live entries and rejects clock rollback", () -> {
            LaunchReplayGuard guard = new LaunchReplayGuard(1); guard.consume(launch(SESSION, NONCE, NOW, NOW + 1000), NOW);
            bad("REPLAY_CACHE_FULL", () -> guard.consume(launch(OTHER, OTHER, NOW, NOW + 1000), NOW));
            bad("CLOCK_MOVED_BACKWARDS", () -> guard.consume(launch(OTHER, OTHER, NOW, NOW + 1000), NOW - 1));
            guard.consume(launch(OTHER, OTHER, NOW + 1000, NOW + 2000), NOW + 1000);
            bad("LAUNCH_EXPIRED", () -> guard.consume(launch(SESSION, NONCE, NOW, NOW + 1000), NOW + 1000));
        });
    }

    private static void navigation() {
        test("navigation HTTPS default IDN IPv6 and ports", () -> {
            eq("https://xn--bcher-kva.example/", NavigationPolicy.normalize("BÜCHER.example").toASCIIString());
            eq("https://example.com:8443/a?b=c#d", NavigationPolicy.normalize("example.com:8443/a?b=c#d").toASCIIString());
            eq("http://example.com/b", NavigationPolicy.normalize("HTTP://EXAMPLE.COM:80/a/../b").toASCIIString());
            eq("https://[2001:db8::1]/", NavigationPolicy.normalize("https://[2001:0db8::1]:443").toASCIIString());
            eq("https://example.org/", NavigationPolicy.normalize("//example.org").toASCIIString());
            eq("https://example.org/%E4%B8%AD", NavigationPolicy.normalize("example.org/中").toASCIIString());
        });
        for (String input : new String[]{"javascript:alert(1)", "javascript:80", "file:///a", "data:text/html,x", "intent://x",
                "ftp://example.com", "https://user:pass@example.com", "https://example.com@other.example", "https://example.com:",
                "https://example.com:0", "https://example.com:65536", "https://example.com:abc", "https://[::1%25lo0]/",
                "https://2001:db8::1/", "https:///missing", "https://bad host", "https://bad\\host/", "example.org/\n",
                "https://example.org/%0a", "https://example.org/%00", "https://%65xample.org/", "", "http:example.org"}) {
            test("reject unsafe navigation " + printable(input), () -> reject(() -> NavigationPolicy.normalize(input)));
        }
        for (String host : new String[]{"appassets.androidplatform.net", "frames.abs-browser.invalid", "abs-probe.invalid",
                "APPASSETS.ANDROIDPLATFORM.NET.", "child.abs-probe.invalid", "child.frames.abs-browser.invalid",
                "appassets。androidplatform.net"}) {
            test("reserved probe origin rejected " + host, () -> bad("RESERVED_PROBE_ORIGIN", () -> NavigationPolicy.normalize("https://" + host + "/")));
        }
        test("ordinary origins are not overblocked", () -> {
            for (String host : new String[]{"example.com", "appassets.androidplatform.net.example.com", "frames.abs-browser.invalid.example.com"}) {
                URI uri = NavigationPolicy.normalize(host); eq(host, uri.getHost());
            }
        });
    }

    private static void admissions() {
        for (int mask = 0; mask < 16; mask++) {
            final int bits = mask;
            test("admission missing-evidence matrix " + bits, () -> {
                AdmissionGate.Decision d = AdmissionGate.evaluate(profile(), new AdmissionGate.Evidence(
                        (bits & 1) != 0, false, (bits & 2) != 0, (bits & 4) != 0, (bits & 8) != 0));
                eq(bits == 15 ? AdmissionGate.Status.VERIFIED : AdmissionGate.Status.UNVERIFIED, d.status);
                eq(bits == 15, d.reasons.isEmpty());
            });
        }
        for (ProxySpec.Scheme scheme : ProxySpec.Scheme.values()) {
            test("proxy authentication must be proved " + scheme, () -> {
                ProfileSpec p = spec(ID, REV, "Test", new ProxySpec(scheme, "example.com", 80, true), "", "UTC", langs(), ProfileSpec.DeviceMode.NATIVE, "", OTHER);
                AdmissionGate.Decision d = AdmissionGate.evaluate(p, new AdmissionGate.Evidence(true, false, true, true, true));
                eq(AdmissionGate.Status.BLOCKED, d.status); check(d.reasons.contains("UNSUPPORTED_PROXY_AUTH"), "auth not blocked");
                eq(AdmissionGate.Status.VERIFIED, AdmissionGate.evaluate(p, evidence()).status);
            });
        }
        test("declared Android is retained and blocked without actual capability", () -> {
            ProfileSpec p = spec(ID, REV, "Test", profile().proxy, "", "UTC", langs(), ProfileSpec.DeviceMode.DECLARED_ANDROID, "Pixel", "");
            eq(ProfileSpec.DeviceMode.DECLARED_ANDROID, p.deviceMode);
            AdmissionGate.Decision d = AdmissionGate.evaluate(p, evidence()); eq(AdmissionGate.Status.BLOCKED, d.status);
            check(d.reasons.contains("UNSUPPORTED_DEVICE_EMULATION"), "fake emulation pass");
        });
        test("decision reasons are immutable", () -> {
            AdmissionGate.Decision d = AdmissionGate.evaluate(profile(), new AdmissionGate.Evidence(true, false, false, false, false));
            eq(AdmissionGate.Status.UNVERIFIED, d.status);
            try { d.reasons.clear(); throw new AssertionError("mutable reasons"); }
            catch (UnsupportedOperationException expected) { check(!d.reasons.isEmpty(), "missing reasons"); }
        });
    }

    private static void ping0Observations() {
        final String config = launch(SESSION, NONCE, NOW, NOW + 120000).configHash();
        final long elapsed = 1000;
        test("Ping0 observation has one fixed target and a ten-minute elapsed-time deadline", () -> {
            Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
            eq("https://ping0.cc/env", Ping0ObservationPolicy.TARGET);
            eq(elapsed + 600000, g.expiresAtMillis);
            check(g.isActive(SESSION, config, OTHER, elapsed), "fresh grant rejected");
            check(g.isActive(SESSION, config, OTHER, g.expiresAtMillis - 1), "early expiry");
            check(!g.isActive(SESSION, config, OTHER, g.expiresAtMillis), "late grant accepted");
            check(!g.isActive(SESSION, config, OTHER, elapsed - 1), "clock rollback accepted");
        });
        test("Ping0 extended wait remains active after two and five minutes but still rejects elapsed overflow", () -> {
            Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
            check(g.isActive(SESSION, config, OTHER, elapsed + 120000), "old two-minute cutoff retained");
            check(g.isActive(SESSION, config, OTHER, elapsed + 300000), "five-minute wait cut short");
            long lastIssueTime = Long.MAX_VALUE - Ping0ObservationPolicy.DURATION_MILLIS;
            eq(Long.MAX_VALUE, Ping0ObservationPolicy.issue(SESSION, config, OTHER, lastIssueTime).expiresAtMillis);
            bad("INVALID_DIAGNOSTIC_GRANT", () -> Ping0ObservationPolicy.issue(SESSION, config, OTHER, lastIssueTime + 1));
        });
        test("Ping0 observation is bound to session config and incarnation", () -> {
            Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
            for (String[] binding : new String[][]{{NONCE, config, OTHER}, {SESSION, profile().fingerprint(), OTHER},
                    {SESSION, config, NONCE}, {null, config, OTHER}, {SESSION, null, OTHER}, {SESSION, config, null}}) {
                check(!g.allowsRequest(binding[0], binding[1], binding[2], elapsed,
                        Ping0ObservationPolicy.TARGET, true, "GET"), "foreign binding accepted");
            }
        });
        test("Ping0 top-level navigation only permits the fixed GET endpoint", () -> {
            Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
            for (String url : new String[]{Ping0ObservationPolicy.TARGET, "HTTPS://PING0.CC:443/env"}) {
                check(g.allowsRequest(SESSION, config, OTHER, elapsed, url, true, "GET"), "fixed target rejected");
            }
            for (String url : new String[]{"https://ping0.cc/", "https://ping0.cc/env/", "https://ping0.cc/%65nv",
                    "https://ping0.cc/x/../env", "https://ping0.cc/env?report=x", "https://ping0.cc/env#x"}) {
                check(!g.allowsRequest(SESSION, config, OTHER, elapsed, url, true, "GET"), "top-level scope expanded");
            }
            for (String method : new String[]{"POST", "HEAD", "get", "", null}) {
                check(!g.allowsRequest(SESSION, config, OTHER, elapsed,
                        Ping0ObservationPolicy.TARGET, true, method), "top-level method expanded");
            }
        });
        test("Ping0 WEB and SW resource policy preserves the exact page HTTPS origin", () -> {
            Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
            check(g.allowsRequest(SESSION, config, OTHER, elapsed,
                    "https://ping0.cc/assets/app.js?v=1", false, "GET"), "same-origin script rejected");
            check(g.allowsRequest(SESSION, config, OTHER, elapsed,
                    "https://ping0.cc:443/api/submit", false, "POST"), "natural same-origin POST rejected");
            check(!g.allowsRequest(SESSION, config, OTHER, g.expiresAtMillis,
                    Ping0ObservationPolicy.TARGET, false, "GET"), "expired resource accepted");
        });
        test("Ping0 permits only observed CDN scripts and their static module tree", () -> {
            Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
            for (String path : new String[]{"/js/vue.min.js", "/js/axios.min.js", "/js/head.js",
                    "/js/envdetect/browser-detect.client.js", "/js/envdetect/probes/index.js",
                    "/js/envdetect/probes/engine/feature-map.js"}) {
                String url = "https://cdn.ping0.cc" + path;
                check(g.allowsRequest(SESSION, config, OTHER, elapsed, url, false, "GET"), "observed CDN script rejected");
                check(!g.allowsRequest(SESSION, config, OTHER, elapsed, url, true, "GET"), "CDN top navigation accepted");
                check(!g.allowsRequest(SESSION, config, OTHER, elapsed, url, false, "POST"), "CDN write accepted");
                check(!g.allowsRequest(SESSION, config, OTHER, g.expiresAtMillis, url, false, "GET"), "expired CDN request accepted");
            }
            g.revoke();
            check(!g.allowsRequest(SESSION, config, OTHER, elapsed,
                    "https://cdn.ping0.cc/js/vue.min.js", false, "GET"), "revoked CDN request accepted");
        });
        test("Ping0 rejects unverified CDN paths query traversal and authority variants", () -> {
            Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
            for (String url : new String[]{"http://cdn.ping0.cc/js/vue.min.js", "https://cdn.ping0.cc:8443/js/vue.min.js",
                    "https://cdn.ping0.cc/lib.js", "https://cdn.ping0.cc/js/envdetect/../outside.js",
                    "https://cdn.ping0.cc/js/envdetect/%2e%2e/outside.js", "https://cdn.ping0.cc/js/envdetect/a.json",
                    "https://cdn.ping0.cc/js/envdetect/a.js?q=sentinel", "https://cdn.ping0.cc/js/envdetect/a.js#x",
                    "https://cdn.ping0.cc.evil.example/js/vue.min.js", "https://user:secret@cdn.ping0.cc/js/vue.min.js",
                    "https://cdn.ping0.cc/js/envdetect//a.js"}) {
                check(!g.allowsRequest(SESSION, config, OTHER, elapsed, url, false, "GET"), "unverified CDN request accepted");
            }
        });
        test("Ping0 admits only the two reviewed CSS image paths", () -> {
            Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
            for (String path : new String[]{"/images/light.png", "/images/yanhua.png"}) {
                String url = "https://cdn.ping0.cc" + path;
                check(g.allowsRequest(SESSION, config, OTHER, elapsed, url, false, "GET"), "reviewed CSS image rejected");
                check(!g.allowsRequest(SESSION, config, OTHER, elapsed, url, true, "GET"), "image top navigation accepted");
                check(!g.allowsRequest(SESSION, config, OTHER, elapsed, url + "?x=1", false, "GET"), "image query accepted");
            }
            check(!g.allowsRequest(SESSION, config, OTHER, elapsed,
                    "https://cdn.ping0.cc/images/other.png", false, "GET"), "image wildcard expanded");
        });
        test("Ping0 baseline dual-stack fetch requires the exact empty-token query", () -> {
            Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
            for (String host : new String[]{"ipv4.ping0.cc", "ipv6.ping0.cc"}) {
                String base = "https://" + host + "/envdetect/ipinfo-cors";
                check(g.allowsRequest(SESSION, config, OTHER, elapsed, base + "?token=", false, "GET"), "baseline fetch rejected");
                check(!g.allowsRequest(SESSION, config, OTHER, elapsed, base + "?token=", true, "GET"), "probe top navigation accepted");
                check(!g.allowsRequest(SESSION, config, OTHER, elapsed, base + "?token=", false, "POST"), "probe write accepted");
                check(!g.allowsRequest(SESSION, config, OTHER, g.expiresAtMillis, base + "?token=", false, "GET"), "expired probe accepted");
                for (String suffix : new String[]{"", "?token", "?token=x", "?token=&extra=x", "?token=%0a", "?token=#x", "/?token="}) {
                    check(!g.allowsRequest(SESSION, config, OTHER, elapsed, base + suffix, false, "GET"), "unreviewed probe query accepted");
                }
            }
        });
        test("Ping0 DNS challenge follows the reviewed hostname path and bare random-number query", () -> {
            Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
            for (String nonce : new String[]{"0", "1", "9007199254740990"}) {
                String base = "https://r-1792591158731-" + nonce + ".d.ping0.cc/probe";
                for (String query : new String[]{"", "?0", "?0.1234567890123456", "?1e-7", "?2.22e-16"}) {
                    check(g.allowsRequest(SESSION, config, OTHER, elapsed, base + query, false, "GET"), "reviewed DNS probe rejected");
                    check(!g.allowsRequest(SESSION, config, OTHER, elapsed, base + query, true, "GET"), "DNS top navigation accepted");
                    check(!g.allowsRequest(SESSION, config, OTHER, g.expiresAtMillis, base + query, false, "GET"), "expired DNS probe accepted");
                }
            }
            g.revoke();
            check(!g.allowsRequest(SESSION, config, OTHER, elapsed,
                    "https://r-1792591158731-1.d.ping0.cc/probe", false, "GET"), "revoked DNS probe accepted");
        });
        test("Ping0 DNS permission never becomes a subdomain or arbitrary-query wildcard", () -> {
            Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
            for (String host : new String[]{"d.ping0.cc", "other.d.ping0.cc", "r-1792591158731-01.d.ping0.cc",
                    "r-1792591158731-9007199254740991.d.ping0.cc", "r-179259115873-1.d.ping0.cc",
                    "r-1792591158731-1.d.ping0.cc.evil.example", "r-1792591158731-1.d.ping0.cc:8443"}) {
                check(!g.allowsRequest(SESSION, config, OTHER, elapsed,
                        "https://" + host + "/probe", false, "GET"), "unreviewed DNS host accepted");
            }
            String base = "https://r-1792591158731-1.d.ping0.cc/probe";
            for (String suffix : new String[]{"?", "?1", "?-0.1", "?NaN", "?Infinity", "?0.5&x=1", "?token=x", "?%30.5", "?0.5#x", "/"}) {
                check(!g.allowsRequest(SESSION, config, OTHER, elapsed, base + suffix, false, "GET"), "unreviewed DNS query accepted");
            }
            check(!g.allowsRequest(SESSION, config, OTHER, elapsed, base, false, "POST"), "DNS write accepted");
        });
        test("Ping0 DNS challenge observations redact ephemeral labels without broadening permission", () -> {
            String origin = Ping0ObservationPolicy.redactedOrigin("https://r-1792591158731-123.d.ping0.cc/probe?0.5");
            eq("https://<dns-challenge>.d.ping0.cc", origin);
            Ping0ObservationPolicy.BlockedDependencies blocked = new Ping0ObservationPolicy.BlockedDependencies();
            blocked.record("https://r-1792591158731-1.d.ping0.cc/private?token=secret");
            blocked.record("https://r-1792591158731-2.d.ping0.cc/private?token=secret");
            eq(2, blocked.snapshot().blockedRequests);
            eq(Arrays.asList("https://<dns-challenge>.d.ping0.cc"), blocked.snapshot().origins);
        });
        for (String url : new String[]{"http://ping0.cc/env", "https://d.ping0.cc/probe", "https://cdn.example/app.js",
                "https://ping0.cc.evil.example/env", "https://evil.example/ping0.cc", "https://ping0.cc./env",
                "https://user:secret@ping0.cc/env", "https://ping0.cc@evil.example/env", "https://ping0.cc:8443/env",
                "https://ping0.cc:/env", "https://ping0.cc:00443/env", "https://%70ing0.cc/env",
                "https://ping0.cc/\\evil", "https://ping0.cc/%0a", "https://ping0.cc/\n", "/env", "//ping0.cc/env",
                "intent://ping0.cc/env", "file:///env", "javascript:alert(1)", "blob:https://ping0.cc/id",
                "wss://ping0.cc/socket", "", null}) {
            test("Ping0 diagnostic rejects off-scope or unsafe resource " + (url == null ? "null" : printable(url)), () -> {
                Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
                check(!g.allowsRequest(SESSION, config, OTHER, elapsed, url, false, "GET"), "off-scope resource accepted");
            });
        }
        test("Ping0 revocation is permanent for every holder of a grant", () -> {
            Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
            g.revoke(); g.revoke();
            check(!g.isActive(SESSION, config, OTHER, elapsed), "revoked grant active");
            check(!g.allowsRequest(SESSION, config, OTHER, elapsed,
                    Ping0ObservationPolicy.TARGET, true, "GET"), "revoked navigation accepted");
        });
        test("Ping0 dependency reporting strips secrets and never broadens permission", () -> {
            Ping0ObservationPolicy.BlockedDependencies blocked = new Ping0ObservationPolicy.BlockedDependencies();
            blocked.record("https://user:password@cdn.example:8443/path?token=secret#private");
            Ping0ObservationPolicy.Snapshot first = blocked.snapshot();
            eq(1, first.blockedRequests); eq(Arrays.asList("https://cdn.example:8443"), first.origins);
            for (int i = 0; i < 20; i++) blocked.record("https://cdn" + i + ".example/a?token=secret");
            Ping0ObservationPolicy.Snapshot latest = blocked.snapshot();
            eq(21, latest.blockedRequests); eq(Ping0ObservationPolicy.MAX_REPORTED_ORIGINS, latest.origins.size());
            eq(1, first.blockedRequests); eq(1, first.origins.size());
            try { latest.origins.clear(); throw new AssertionError("mutable origins"); }
            catch (UnsupportedOperationException expected) { eq(8, latest.origins.size()); }
            Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
            check(!g.allowsRequest(SESSION, config, OTHER, elapsed,
                    "https://cdn.example:8443/app.js", false, "GET"), "observed dependency was auto-allowed");
            eq("https://example.com", Ping0ObservationPolicy.redactedOrigin("https://example.com:443/p?q#f"));
            eq("<invalid-origin>", Ping0ObservationPolicy.redactedOrigin("not a URI"));
            eq("<non-http-origin>", Ping0ObservationPolicy.redactedOrigin("wss://example.com/socket?secret=x"));
        });
        test("Ping0 observation does not promote ordinary admission", () -> {
            AdmissionGate.Evidence incomplete = new AdmissionGate.Evidence(true, false, true, false, false);
            eq(AdmissionGate.Status.UNVERIFIED, AdmissionGate.evaluate(profile(), incomplete).status);
            Ping0ObservationPolicy.Grant g = Ping0ObservationPolicy.issue(SESSION, config, OTHER, elapsed);
            check(g.allowsRequest(SESSION, config, OTHER, elapsed,
                    Ping0ObservationPolicy.TARGET, true, "GET"), "diagnostic not allowed");
            eq(AdmissionGate.Status.UNVERIFIED, AdmissionGate.evaluate(profile(), incomplete).status);
            g.revoke(); eq(AdmissionGate.Status.UNVERIFIED, AdmissionGate.evaluate(profile(), incomplete).status);
        });
        test("Ping0 invalid grants and elapsed overflow are rejected", () -> {
            bad("INVALID_DIAGNOSTIC_GRANT", () -> Ping0ObservationPolicy.issue("1-1-1-1-1", config, OTHER, elapsed));
            bad("INVALID_DIAGNOSTIC_GRANT", () -> Ping0ObservationPolicy.issue(SESSION, "secret", OTHER, elapsed));
            bad("INVALID_DIAGNOSTIC_GRANT", () -> Ping0ObservationPolicy.issue(SESSION, config, "bad", elapsed));
            bad("INVALID_DIAGNOSTIC_GRANT", () -> Ping0ObservationPolicy.issue(SESSION, config, OTHER, -1));
            bad("INVALID_DIAGNOSTIC_GRANT", () -> Ping0ObservationPolicy.issue(SESSION, config, OTHER, Long.MAX_VALUE));
        });
    }

    private static void runtime() {
        test("only profile-bound verified admission can become ready", () -> {
            RuntimeStateMachine m = machine(); eq(RuntimeStateMachine.State.STARTING, m.state());
            m.bootstrapped(SESSION); m.beginProbing(SESSION);
            m.applyAdmission(SESSION, AdmissionGate.evaluate(profile(), new AdmissionGate.Evidence(true, false, false, false, false)));
            eq(RuntimeStateMachine.State.PROBING, m.state());
            bad("PROFILE_MISMATCH", () -> m.applyAdmission(SESSION, AdmissionGate.evaluate(named("Different"), evidence())));
            m.applyAdmission(SESSION, AdmissionGate.evaluate(profile(), evidence())); eq(RuntimeStateMachine.State.READY, m.state());
            m.applyAdmission(SESSION, AdmissionGate.evaluate(profile(), new AdmissionGate.Evidence(true, false, true, false, true)));
            eq(RuntimeStateMachine.State.PROBING, m.state());
        });
        test("wrong-session messages cannot mutate runtime", () -> {
            RuntimeStateMachine m = machine();
            List<Runnable> messages = Arrays.asList(() -> m.recordPid(OTHER, 123), () -> m.bootstrapped(OTHER),
                    () -> m.beginProbing(OTHER), () -> m.applyAdmission(OTHER, AdmissionGate.evaluate(profile(), evidence())),
                    () -> m.requestDrain(OTHER), () -> m.drainComplete(OTHER), () -> m.finishReported(OTHER),
                    () -> m.exitTimedOut(OTHER), () -> m.observeBinderDeath(OTHER, true, true), () -> m.observePidCheck(OTHER, 123, 3, true));
            for (Runnable message : messages) { bad("SESSION_MISMATCH", message); eq(RuntimeStateMachine.State.STARTING, m.state()); }
        });
        test("bootstrap replay and illegal ready transition rejected", () -> {
            RuntimeStateMachine m = machine(); bad("INVALID_TRANSITION", () -> m.applyAdmission(SESSION, AdmissionGate.evaluate(profile(), evidence())));
            m.bootstrapped(SESSION); bad("INVALID_TRANSITION", () -> m.bootstrapped(SESSION));
            LaunchReplayGuard guard = new LaunchReplayGuard(2); LaunchSpec launch = launch(SESSION, NONCE, NOW, NOW + 1000);
            new RuntimeStateMachine(launch, guard, NOW); bad("LAUNCH_REPLAY", () -> new RuntimeStateMachine(launch, guard, NOW));
        });
        test("drain finish and timeout are not process exit", () -> {
            RuntimeStateMachine m = machine(); m.requestDrain(SESSION); eq(RuntimeStateMachine.State.DRAINING, m.state());
            m.drainComplete(SESSION); eq(RuntimeStateMachine.State.EXIT_WAIT, m.state());
            m.exitTimedOut(SESSION); eq(RuntimeStateMachine.State.EXIT_UNKNOWN, m.state());
            RuntimeStateMachine n = machine(); n.finishReported(SESSION); eq(RuntimeStateMachine.State.EXIT_WAIT, n.state());
        });
        test("binder death needs trusted source and free lifecycle lock", () -> {
            RuntimeStateMachine m = machine(); bad("UNTRUSTED_EXIT_EVIDENCE", () -> m.observeBinderDeath(SESSION, false, true));
            eq(RuntimeStateMachine.State.STARTING, m.state()); m.observeBinderDeath(SESSION, true, false);
            eq(RuntimeStateMachine.State.EXIT_UNKNOWN, m.state()); m.observeBinderDeath(SESSION, true, true);
            eq(RuntimeStateMachine.State.EXIT_CONFIRMED, m.state()); bad("INVALID_TRANSITION", () -> m.finishReported(SESSION));
        });
        test("PID exit requires recorded exact PID ESRCH and free lock", () -> {
            RuntimeStateMachine m = machine(); bad("PID_MISMATCH", () -> m.observePidCheck(SESSION, 123, 3, true));
            m.recordPid(SESSION, 123); bad("PID_MISMATCH", () -> m.observePidCheck(SESSION, 124, 3, true));
            bad("INVALID_TRANSITION", () -> m.recordPid(SESSION, 124));
            m.observePidCheck(SESSION, 123, 1, true); eq(RuntimeStateMachine.State.EXIT_UNKNOWN, m.state());
            m.observePidCheck(SESSION, 123, 3, false); eq(RuntimeStateMachine.State.EXIT_UNKNOWN, m.state());
            m.observePidCheck(SESSION, 123, 3, true); eq(RuntimeStateMachine.State.EXIT_CONFIRMED, m.state());
        });
    }

    private static void lifecycleControl() {
        test("controller waits for HELLO before sending drain or changing runtime", () -> {
            RuntimeStateMachine m = machine();
            eq(LifecycleControlPolicy.DrainAction.WAIT_FOR_HELLO,
                    LifecycleControlPolicy.requestDrain(m, SESSION, false));
            eq(RuntimeStateMachine.State.STARTING, m.state());
            eq(LifecycleControlPolicy.DrainAction.SEND_DRAIN,
                    LifecycleControlPolicy.requestDrain(m, SESSION, true));
            eq(RuntimeStateMachine.State.DRAINING, m.state());
        });
        test("controller retries DRAINING after failed transport and revalidated HELLO", () -> {
            RuntimeStateMachine m = machine();
            eq(LifecycleControlPolicy.DrainAction.SEND_DRAIN,
                    LifecycleControlPolicy.requestDrain(m, SESSION, true));
            eq(LifecycleControlPolicy.DrainAction.SEND_DRAIN,
                    LifecycleControlPolicy.requestDrain(m, SESSION, true));
            eq(RuntimeStateMachine.State.DRAINING, m.state());
        });
        for (boolean timeout : new boolean[]{false, true}) {
            test("controller repeated stop keeps exit evidence state: timeout=" + timeout, () -> {
                RuntimeStateMachine m = machine(); m.requestDrain(SESSION); m.drainComplete(SESSION);
                if (timeout) m.exitTimedOut(SESSION);
                RuntimeStateMachine.State before = m.state();
                eq(LifecycleControlPolicy.DrainAction.SEND_DRAIN,
                        LifecycleControlPolicy.requestDrain(m, SESSION, true));
                eq(before, m.state());
                LifecycleControlPolicy.drainReported(m, SESSION);
                LifecycleControlPolicy.drainReported(m, SESSION);
                eq(before, m.state());
            });
        }
        test("recovered controller without in-memory machine still requires validated HELLO", () -> {
            eq(LifecycleControlPolicy.DrainAction.WAIT_FOR_HELLO,
                    LifecycleControlPolicy.requestDrain(null, SESSION, false));
            eq(LifecycleControlPolicy.DrainAction.SEND_DRAIN,
                    LifecycleControlPolicy.requestDrain(null, SESSION, true));
            LifecycleControlPolicy.drainReported(null, SESSION);
        });
        test("already-drained HELLO enters exit wait without claiming process death", () -> {
            RuntimeStateMachine m = machine(); m.recordPid(SESSION, 123); m.bootstrapped(SESSION); m.beginProbing(SESSION);
            LifecycleControlPolicy.drainReported(m, SESSION);
            eq(RuntimeStateMachine.State.EXIT_WAIT, m.state());
            LifecycleControlPolicy.drainReported(m, SESSION);
            eq(RuntimeStateMachine.State.EXIT_WAIT, m.state());
            m.exitTimedOut(SESSION);
            LifecycleControlPolicy.drainReported(m, SESSION);
            eq(RuntimeStateMachine.State.EXIT_UNKNOWN, m.state());
            m.observePidCheck(SESSION, 123, RuntimeStateMachine.ESRCH, false);
            eq(RuntimeStateMachine.State.EXIT_UNKNOWN, m.state());
            m.observePidCheck(SESSION, 123, 1, true);
            eq(RuntimeStateMachine.State.EXIT_UNKNOWN, m.state());
            m.observePidCheck(SESSION, 123, RuntimeStateMachine.ESRCH, true);
            eq(RuntimeStateMachine.State.EXIT_CONFIRMED, m.state());
        });
        test("controller duplicate drain receipts are idempotent and retain strict requestDrain", () -> {
            RuntimeStateMachine m = machine(); m.requestDrain(SESSION);
            bad("INVALID_TRANSITION", () -> m.requestDrain(SESSION));
            LifecycleControlPolicy.drainReported(m, SESSION);
            LifecycleControlPolicy.drainReported(m, SESSION);
            eq(RuntimeStateMachine.State.EXIT_WAIT, m.state());
            bad("INVALID_TRANSITION", () -> m.requestDrain(SESSION));
            m.exitTimedOut(SESSION);
            bad("INVALID_TRANSITION", () -> m.requestDrain(SESSION));
            LifecycleControlPolicy.drainReported(m, SESSION);
            eq(RuntimeStateMachine.State.EXIT_UNKNOWN, m.state());
        });
        test("controller cannot restart drain or regress confirmed exit", () -> {
            RuntimeStateMachine m = machine(); m.observeBinderDeath(SESSION, true, true);
            eq(LifecycleControlPolicy.DrainAction.WAIT_FOR_EXIT,
                    LifecycleControlPolicy.requestDrain(m, SESSION, true));
            LifecycleControlPolicy.drainReported(m, SESSION);
            eq(RuntimeStateMachine.State.EXIT_CONFIRMED, m.state());
            bad("INVALID_TRANSITION", () -> m.requestDrain(SESSION));
        });
        test("controller drain decisions and receipts reject another session", () -> {
            RuntimeStateMachine m = machine();
            bad("SESSION_MISMATCH", () -> LifecycleControlPolicy.requestDrain(m, OTHER, true));
            bad("SESSION_MISMATCH", () -> LifecycleControlPolicy.requestDrain(m, OTHER, false));
            bad("SESSION_MISMATCH", () -> LifecycleControlPolicy.drainReported(m, OTHER));
            eq(RuntimeStateMachine.State.STARTING, m.state());
        });
    }

    private static void edgeCases() {
        for (String[] pair : new String[][]{{"2001:0:0:1:0:0:1:1", "2001::1:0:0:1:1"},
                {"2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"}, {"0:0:0:0:0:0:0:0", "::"},
                {"::ffff:0:192.0.2.1", "::ffff:0:c000:201"}}) {
            test("RFC5952 IPv6 vector " + pair[0], () -> eq(pair[1], proxy(pair[0], 80).host));
        }
        for (String host : new String[]{"1:2:3:4:5:6:7:8:9", "::1::2", "1:2:3:4:5:6:7::8", "::ffff:127.1"}) {
            test("reject malformed IPv6 " + host, () -> reject(() -> proxy(host, 80)));
        }
        test("DNS label boundary and Unicode case expansion rejected", () -> {
            eq(repeat("a", 63) + ".example", proxy(repeat("a", 63) + ".example", 80).host);
            reject(() -> proxy(repeat("a", 64) + ".example", 80)); reject(() -> variant("ß", "UTC", langs(), ""));
        });
        for (String tag : new String[]{"sl-rozaj-rozaj", "en-a-foo-a-bar"}) {
            test("reject repeated BCP47 subtags " + tag, () -> reject(() -> variant("", "UTC", Arrays.asList(tag), "")));
        }
        test("valid BCP47 extensions private-use and grandfathered tags", () -> {
            eq(Arrays.asList("de-DE-u-co-phonebk", "x-abs-test", "tlh"),
                    variant("", "UTC", Arrays.asList("de-DE-u-co-phonebk", "x-abs-test", "i-klingon"), "").languageTags);
        });
        test("hash matches independently calculated length-prefixed SHA256 vectors", () -> {
            eq("a9e9848d4fcb61fb2910cfdaebafc06f29c2463398d163180ab0ad59d4a20c6b", profile().fingerprint());
            eq("b02a5fdd20b2ee3dc60862c98a9e17587d32eed3cc7e333fe87966e16db8d84f", launch(SESSION, NONCE, NOW, NOW + 120000).configHash());
            check(!profile().fingerprint().equals(variant("", "UTC", Arrays.asList("de", "en-US"), "").fingerprint()), "language order omitted");
            eq(named("Café").fingerprint(), named("Café").fingerprint());
        });
        test("navigation leading-zero ports and encoded Unicode controls", () -> {
            eq("https://example.org/", NavigationPolicy.normalize("https://example.org:00443/").toASCIIString());
            reject(() -> NavigationPolicy.normalize("https://example.org/%C2%85"));
            reject(() -> NavigationPolicy.normalize("https://example.org/%7f"));
            reject(() -> NavigationPolicy.normalize(null));
        });
        test("invalid runtime launch does not consume a valid launch", () -> {
            LaunchReplayGuard guard = new LaunchReplayGuard(1);
            bad("LAUNCH_EXPIRED", () -> new RuntimeStateMachine(launch(SESSION, NONCE, NOW - 2000, NOW - 1000), guard, NOW));
            RuntimeStateMachine m = new RuntimeStateMachine(launch(SESSION, NONCE, NOW, NOW + 1000), guard, NOW);
            eq(RuntimeStateMachine.State.STARTING, m.state());
        });
        test("blocked runtime never silently resumes as native or ready", () -> {
            ProfileSpec p = spec(ID, REV, "Test", profile().proxy, "", "UTC", langs(), ProfileSpec.DeviceMode.DECLARED_ANDROID, "Pixel", "");
            RuntimeStateMachine m = new RuntimeStateMachine(new LaunchSpec(p, SESSION, NONCE, NOW, NOW + 1000), new LaunchReplayGuard(2), NOW);
            m.bootstrapped(SESSION); m.beginProbing(SESSION); m.applyAdmission(SESSION, AdmissionGate.evaluate(p, evidence()));
            eq(RuntimeStateMachine.State.BLOCKED, m.state());
            bad("INVALID_TRANSITION", () -> m.applyAdmission(SESSION, AdmissionGate.evaluate(profile(), evidence())));
            m.requestDrain(SESSION); eq(RuntimeStateMachine.State.DRAINING, m.state());
        });
        test("concurrent replay consumption is atomic", CoreContractTest::concurrentReplay);
    }

    private static void concurrentReplay() {
        LaunchReplayGuard guard = new LaunchReplayGuard(4); java.util.concurrent.CountDownLatch start = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicInteger accepted = new java.util.concurrent.atomic.AtomicInteger();
        java.util.concurrent.atomic.AtomicInteger replayed = new java.util.concurrent.atomic.AtomicInteger();
        java.util.concurrent.atomic.AtomicReference<Throwable> error = new java.util.concurrent.atomic.AtomicReference<>();
        Runnable attempt = () -> { try { start.await(); guard.consume(launch(SESSION, NONCE, NOW, NOW + 1000), NOW); accepted.incrementAndGet(); }
            catch (ValidationException e) { if ("LAUNCH_REPLAY".equals(e.code)) replayed.incrementAndGet(); else error.set(e); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); error.set(e); } };
        Thread a = new Thread(attempt); Thread b = new Thread(attempt); a.start(); b.start(); start.countDown();
        try { a.join(5000); b.join(5000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new AssertionError(e); }
        check(!a.isAlive() && !b.isAlive(), "concurrent replay check timed out"); eq(null, error.get()); eq(1, accepted.get()); eq(1, replayed.get());
    }

    private static ProfileSpec spec(String id, String rev, String name, ProxySpec proxy, String country, String zone,
            List<String> languages, ProfileSpec.DeviceMode mode, String model, String credentials) {
        return new ProfileSpec(id, rev, name, proxy, country, zone, languages, mode, model, credentials);
    }
    private static ProxySpec proxy(String host, int port) { return new ProxySpec(ProxySpec.Scheme.HTTP, host, port, false); }
    private static List<String> langs() { return Arrays.asList("en-US", "de"); }
    private static ProfileSpec profile() { return named("Test"); }
    private static ProfileSpec named(String name) { return spec(ID, REV, name, proxy("example.com", 80), "", "UTC", langs(), ProfileSpec.DeviceMode.NATIVE, "", ""); }
    private static ProfileSpec variant(String country, String zone, List<String> langs, String model) { return spec(ID, REV, "Test", profile().proxy, country, zone, langs, ProfileSpec.DeviceMode.NATIVE, model, ""); }
    private static ProfileSpec authenticated(String cred) { return spec(ID, REV, "Test", new ProxySpec(ProxySpec.Scheme.HTTP, "example.com", 80, true), "", "UTC", langs(), ProfileSpec.DeviceMode.NATIVE, "", cred); }
    private static LaunchSpec launch(String session, String nonce, long issued, long expires) { return new LaunchSpec(profile(), session, nonce, issued, expires); }
    private static RuntimeStateMachine machine() { return new RuntimeStateMachine(launch(SESSION, NONCE, NOW, NOW + 1000), new LaunchReplayGuard(8), NOW); }
    private static AdmissionGate.Evidence evidence() { return new AdmissionGate.Evidence(true, true, true, true, true); }
    private static void bad(String code, Runnable action) { try { action.run(); } catch (ValidationException e) { eq(code, e.code); return; } throw new AssertionError("expected " + code); }
    private static void reject(Runnable action) { try { action.run(); } catch (ValidationException e) { check(e.code != null && e.code.matches("[A-Z][A-Z0-9_]+"), "unstable error code"); return; } throw new AssertionError("invalid input accepted"); }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static void eq(Object expected, Object actual) { if (!java.util.Objects.equals(expected, actual)) throw new AssertionError("expected=" + expected + " actual=" + actual); }
    private static String repeat(String text, int n) { StringBuilder b = new StringBuilder(); for (int i = 0; i < n; i++) b.append(text); return b.toString(); }
    private static String printable(String value) { return value.replace("\n", "\\n").replace("\r", "\\r").replace("\u0000", "\\0"); }
    private static void test(String name, Runnable body) { int number = passed + failed + 1; try { body.run(); passed++; System.out.println(number + " PASS " + name); } catch (Throwable e) { failed++; System.out.println(number + " FAIL " + name); e.printStackTrace(System.out); } }
}
