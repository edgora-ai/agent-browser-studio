package com.ahoo.abs.android;

import com.ahoo.abs.core.ProxySpec;
import com.ahoo.abs.core.ValidationException;

import java.util.Locale;

/** Parses one complete endpoint without guessing, resolving hosts, or changing editor state. */
public final class ProxyEndpointInput {
    private ProxyEndpointInput() {}

    /**
     * Accepts host:port or a supported scheme://host:port, with brackets required for IPv6.
     * Only surrounding whitespace is trimmed; host validation and canonicalization belong to core.
     */
    public static ProxySpec parse(String raw, ProxySpec.Scheme defaultScheme) {
        if (raw == null) throw invalidEndpoint();
        String endpoint = trimWhitespace(raw);
        if (endpoint.isEmpty()) throw invalidEndpoint();
        if (endpoint.indexOf('@') >= 0) {
            throw new ValidationException("PROXY_AUTH_UNSUPPORTED",
                    "Proxy authentication is not supported; user information is not permitted");
        }

        ProxySpec.Scheme scheme = defaultScheme;
        int schemeEnd = endpoint.indexOf("://");
        if (schemeEnd >= 0) {
            String protocol = endpoint.substring(0, schemeEnd).toLowerCase(Locale.ROOT);
            switch (protocol) {
                case "http":
                    scheme = ProxySpec.Scheme.HTTP;
                    break;
                case "https":
                    scheme = ProxySpec.Scheme.HTTPS;
                    break;
                case "socks":
                case "socks5":
                    scheme = ProxySpec.Scheme.SOCKS5;
                    break;
                default:
                    throw new ValidationException("INVALID_PROXY_SCHEME",
                            "Proxy scheme must be HTTP, HTTPS, or SOCKS5");
            }
            endpoint = endpoint.substring(schemeEnd + 3);
        }
        if (endpoint.indexOf('/') >= 0 || endpoint.indexOf('\\') >= 0
                || endpoint.indexOf('?') >= 0 || endpoint.indexOf('#') >= 0) {
            throw invalidEndpoint();
        }

        String host;
        String port;
        if (endpoint.startsWith("[")) {
            int bracketEnd = endpoint.indexOf(']');
            if (bracketEnd < 0 || bracketEnd + 1 >= endpoint.length()
                    || endpoint.charAt(bracketEnd + 1) != ':') {
                throw invalidEndpoint();
            }
            host = endpoint.substring(0, bracketEnd + 1);
            port = endpoint.substring(bracketEnd + 2);
        } else {
            int colon = endpoint.indexOf(':');
            if (colon <= 0 || colon != endpoint.lastIndexOf(':')) throw invalidEndpoint();
            host = endpoint.substring(0, colon);
            port = endpoint.substring(colon + 1);
        }
        return new ProxySpec(scheme, host, parsePort(port), false);
    }

    private static String trimWhitespace(String raw) {
        int start = 0;
        int end = raw.length();
        while (start < end && Character.isWhitespace(raw.charAt(start))) start++;
        while (start < end && Character.isWhitespace(raw.charAt(end - 1))) end--;
        // String.trim() would also discard non-whitespace controls such as NUL.
        return raw.substring(start, end);
    }

    private static int parsePort(String raw) {
        if (raw.isEmpty()) throw invalidPort();
        int port = 0;
        for (int i = 0; i < raw.length(); i++) {
            char digit = raw.charAt(i);
            if (digit < '0' || digit > '9') throw invalidPort();
            // Bound every step before multiplication, including arbitrarily long input.
            if (port > (65535 - (digit - '0')) / 10) throw invalidPort();
            port = port * 10 + digit - '0';
        }
        return port; // Core rejects zero and owns the definitive port/host validation.
    }

    private static ValidationException invalidEndpoint() {
        return new ValidationException("INVALID_PROXY_ENDPOINT",
                "Enter one complete host:port endpoint; IPv6 addresses require brackets and URLs cannot have paths, queries, or fragments");
    }

    private static ValidationException invalidPort() {
        return new ValidationException("INVALID_PORT", "Proxy port must be decimal and between 1 and 65535");
    }
}
