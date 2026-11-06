package com.ahoo.abs.android;

import com.ahoo.abs.core.ProxySpec;
import com.ahoo.abs.core.ValidationException;

/** Pure-JDK contract tests; run with assertions enabled against the actual core sources. */
public final class ProxyEndpointInputTest {
    private static int checks;

    private ProxyEndpointInputTest() {}

    public static void main(String[] args) {
        boolean assertionsEnabled = false;
        assert assertionsEnabled = true;
        if (!assertionsEnabled) throw new IllegalStateException("Run this test with java -ea");

        validEndpoints();
        invalidStructure();
        invalidSchemesAndModes();
        credentialsAreNeverStripped();
        invalidPorts();
        invalidHostsAndWhitespace();
        System.out.println("ProxyEndpointInputTest: " + checks + " cases passed");
    }

    private static void validEndpoints() {
        accepts("http://Proxy.Example.:8080", ProxySpec.Scheme.SOCKS5, "http://proxy.example:8080");
        accepts("HTTPS://Proxy.Example:443", ProxySpec.Scheme.HTTP, "https://proxy.example:443");
        accepts("socks5://Proxy.Example:1080", ProxySpec.Scheme.HTTPS, "socks5://proxy.example:1080");
        accepts("SoCkS://Proxy.Example:1080", ProxySpec.Scheme.HTTP, "socks5://proxy.example:1080");
        accepts("proxy.example:80", ProxySpec.Scheme.HTTP, "http://proxy.example:80");
        accepts("proxy.example:443", ProxySpec.Scheme.HTTPS, "https://proxy.example:443");
        accepts("proxy.example:1080", ProxySpec.Scheme.SOCKS5, "socks5://proxy.example:1080");
        accepts(" \t https://EXAMPLE.com:00443 \r\n", ProxySpec.Scheme.HTTP, "https://example.com:443");
        accepts("\u2003https://example.com:443\u2003", ProxySpec.Scheme.HTTP, "https://example.com:443");
        accepts("http://localhost:1", null, "http://localhost:1");
        accepts("https://example.com:65535", null, "https://example.com:65535");
        accepts("socks5://127.0.0.1:1080", null, "socks5://127.0.0.1:1080");
        accepts("http://b\u00fccher.example:80", null, "http://xn--bcher-kva.example:80");
        accepts("[::1]:80", ProxySpec.Scheme.HTTP, "http://[::1]:80");
        accepts("https://[2001:0DB8:0000:0000:0000:0000:0000:0001]:443", null,
                "https://[2001:db8::1]:443");
        accepts("socks5://[0:0:0:0:0:0:0:1]:1080", null, "socks5://[::1]:1080");
        accepts("[::]:65535", ProxySpec.Scheme.HTTPS, "https://[::]:65535");
        accepts("[::ffff:192.0.2.128]:80", ProxySpec.Scheme.HTTP, "http://[::ffff:c000:280]:80");
    }

    private static void invalidStructure() {
        for (String raw : new String[] {
                null, "", " \t\r\n", "example.com", "http://example.com", "http://", ":80",
                "[::1]", "http://[::1]", "[::1]junk:80", "http://[::1]junk:80",
                "[::1]]:80", "[::1:80", "::1:80", "2001:db8::1:80", "http://::1:80",
                "example.com:80/", "http://example.com:80/path", "example.com:80?x=1",
                "https://example.com:80#fragment", "example.com:80\\path", "//example.com:80",
                "http://http://example.com:80", "http:/example.com:80",
                "example.com:80,other.example:81",
                "http://example.com:80;http://other.example:81", "http://example.com:80\nother.example:81"
        }) {
            rejects(raw, ProxySpec.Scheme.HTTP, "INVALID_PROXY_ENDPOINT");
        }
    }

    private static void invalidSchemesAndModes() {
        for (String raw : new String[] {
                "ftp://example.com:80", "socks4://example.com:80", "quic://example.com:80",
                "file://example.com:80", "pac://example.com:80", "direct://example.com:80",
                "system://example.com:80", "fallback://example.com:80", "://example.com:80",
                "http ://example.com:80", "ht\ttp://example.com:80"
        }) {
            rejects(raw, ProxySpec.Scheme.HTTP, "INVALID_PROXY_SCHEME");
        }
        for (String raw : new String[] {
                "DIRECT", "direct", "SYSTEM", "system", "PAC", "fallback",
                "PAC https://example.com/proxy.pac", "https://example.com/proxy.pac",
                "http://example.com:80 DIRECT", "HTTP example.com:80; DIRECT"
        }) {
            rejects(raw, ProxySpec.Scheme.HTTP, "INVALID_PROXY_ENDPOINT", "INVALID_PORT", "INVALID_HOST", "INVALID_PROXY_SCHEME");
        }
        rejects("example.com:80", null, "INVALID_PROXY_SCHEME");
    }

    private static void credentialsAreNeverStripped() {
        for (String raw : new String[] {
                "user:secret@example.com:80", "http://user:secret@example.com:80",
                "https://user@example.com:443", "socks5://user:secret@[::1]:1080",
                "@example.com:80", "example.com:80@other.example:81", "ftp://user:secret@example.com:80"
        }) {
            rejects(raw, ProxySpec.Scheme.HTTP, "PROXY_AUTH_UNSUPPORTED");
        }
        // Encoded user information must not be decoded into, or silently removed from, a host.
        rejects("user%40example.com:80", ProxySpec.Scheme.HTTP, "INVALID_HOST");
    }

    private static void invalidPorts() {
        for (String raw : new String[] {
                "example.com:", "new.example:BAD", "http://new.example:BAD", "[::1]:BAD",
                "example.com:+80", "example.com:-1", "example.com:8.0", "example.com:0x50",
                "example.com:1e2", "example.com: 80", "example.com:8 0", "example.com:\u0668\u0660",
                "example.com:0", "example.com:00000", "example.com:65536", "example.com:2147483647",
                "example.com:2147483648", "example.com:4294967296",
                "example.com:999999999999999999999999999999999999999999999999999999999999",
                "[::1]:", "[::1]:65536", "[::1]:80junk", "[::1]:80:90", "[::1]:80]",
                "example.com:80,other.example", "example.com:80;DIRECT", "example.com:8\n0", "example.com:80\u0000"
        }) {
            rejects(raw, ProxySpec.Scheme.HTTP, "INVALID_PORT");
        }
    }

    private static void invalidHostsAndWhitespace() {
        for (String raw : new String[] {
                "bad host:80", "bad\u00a0host:80", "example.com :80", "http:// example.com:80",
                "bad_host:80", "-bad.example:80", "bad..example:80", "127.1:80", "0127.0.0.1:80",
                "256.0.0.1:80", "0x7f000001:80", "[example.com]:80", "[]:80", "[:::1]:80",
                "[::1%25eth0]:80", "[1:2:3:4:5:6:7:8:9]:80", "bad,other.example:80"
        }) {
            rejects(raw, ProxySpec.Scheme.HTTP, "INVALID_HOST");
        }
        for (String raw : new String[] {"bad\thost:80", "bad\nhost:80", "bad\rhost:80", "bad\u0000host:80", "bad\u007fhost:80", "\u0000example.com:80"}) {
            rejects(raw, ProxySpec.Scheme.HTTP, "CONTROL_CHARACTER");
        }
        rejects("bad\ud800host:80", ProxySpec.Scheme.HTTP, "INVALID_UNICODE");
        rejects("bad\udc00host:80", ProxySpec.Scheme.HTTP, "INVALID_UNICODE");
    }

    private static void accepts(String raw, ProxySpec.Scheme defaultScheme, String canonical) {
        ProxySpec spec = ProxyEndpointInput.parse(raw, defaultScheme);
        assert canonical.equals(spec.proxyRule()) : "Unexpected canonical endpoint: " + spec.proxyRule();
        assert !spec.hasCredentials : "Parsed endpoint must never have credentials";
        assert spec.port >= 1 && spec.port <= 65535;
        assert canonical.endsWith(spec.authority()) : "Canonical authority mismatch";
        checks++;
    }

    private static void rejects(String raw, ProxySpec.Scheme defaultScheme, String... codes) {
        try {
            ProxyEndpointInput.parse(raw, defaultScheme);
            throw new AssertionError("Accepted an invalid endpoint");
        } catch (ValidationException e) {
            boolean expectedCode = false;
            for (String code : codes) {
                if (code.equals(e.code)) expectedCode = true;
            }
            assert expectedCode : "Unexpected validation code " + e.code;
            assert e.getMessage() != null && !e.getMessage().isEmpty() : "Validation message required";
            assert !e.getMessage().contains("secret") : "Validation messages must not disclose credentials";
        }
        checks++;
    }
}
