package com.ahoo.abs.core;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/** Explicit observation only. Never supplies evidence to AdmissionGate or a network firewall. */
public final class Ping0ObservationPolicy {
    public static final String TARGET = "https://ping0.cc/env";
    public static final long DURATION_MILLIS = 600000;
    public static final int MAX_REPORTED_ORIGINS = 8;
    private static final java.util.regex.Pattern DNS_CHALLENGE_HOST = java.util.regex.Pattern.compile(
            "r-[1-9][0-9]{12}-(0|[1-9][0-9]{0,15})[.]d[.]ping0[.]cc");

    private Ping0ObservationPolicy() {}

    /** Call only after native user confirmation; elapsed time must come from one process/boot. */
    public static Grant issue(String sessionId, String configHash, String incarnationId, long elapsedMillis) {
        if (!uuid(sessionId) || configHash == null || !configHash.matches("[0-9a-f]{64}")
                || !uuid(incarnationId) || elapsedMillis < 0
                || elapsedMillis > Long.MAX_VALUE - DURATION_MILLIS) {
            throw CoreValidation.error("INVALID_DIAGNOSTIC_GRANT", "A current session, config and process are required");
        }
        return new Grant(sessionId, configHash, incarnationId, elapsedMillis);
    }

    public static final class Grant {
        private final String sessionId;
        private final String configHash;
        private final String incarnationId;
        private final long issuedAtMillis;
        public final long expiresAtMillis;
        private final AtomicBoolean revoked = new AtomicBoolean();

        private Grant(String sessionId, String configHash, String incarnationId, long elapsedMillis) {
            this.sessionId = sessionId;
            this.configHash = configHash;
            this.incarnationId = incarnationId;
            issuedAtMillis = elapsedMillis;
            expiresAtMillis = elapsedMillis + DURATION_MILLIS;
        }

        public void revoke() { revoked.set(true); }

        public boolean isActive(String session, String config, String incarnation, long elapsedMillis) {
            return !revoked.get() && sessionId.equals(session) && configHash.equals(config)
                    && incarnationId.equals(incarnation) && elapsedMillis >= issuedAtMillis
                    && elapsedMillis < expiresAtMillis;
        }

        /** Initial navigation is constant TARGET; every intercepted WEB/SW request is checked too. */
        public boolean allowsRequest(String session, String config, String incarnation, long elapsedMillis,
                String url, boolean mainFrame, String method) {
            if (!isActive(session, config, incarnation, elapsedMillis)
                    || method == null || !method.matches("[A-Z]{1,16}")) return false;
            URI uri = parse(url);
            if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())
                    || uri.getRawUserInfo() != null) return false;
            String host = uri.getHost();
            String authority = uri.getRawAuthority();
            if (host == null || (!host.equalsIgnoreCase(authority)
                    && !(host + ":443").equalsIgnoreCase(authority))) return false;
            if ("ping0.cc".equalsIgnoreCase(host)) {
                return !mainFrame || ("GET".equals(method) && "/env".equals(uri.getRawPath())
                        && uri.getRawQuery() == null && uri.getRawFragment() == null);
            }
            if (mainFrame || !"GET".equals(method) || uri.getRawFragment() != null) return false;
            String path = uri.getRawPath();
            String query = uri.getRawQuery();
            if ("cdn.ping0.cc".equalsIgnoreCase(host)) {
                if (query != null) return false;
                // Reviewed scripts/module tree and two fixed CSS images, not arbitrary CDN paths.
                return "/js/vue.min.js".equals(path) || "/js/axios.min.js".equals(path) || "/js/head.js".equals(path)
                        || "/images/light.png".equals(path) || "/images/yanhua.png".equals(path)
                        || (path != null && path.matches("/js/envdetect/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+[.]js"));
            }
            if ("ipv4.ping0.cc".equalsIgnoreCase(host) || "ipv6.ping0.cc".equalsIgnoreCase(host)) {
                return "/envdetect/ipinfo-cors".equals(path) && "token=".equals(query);
            }
            return isDnsChallengeHost(host) && "/probe".equals(path)
                    && (query == null || isRandomProbeQuery(query));
        }
    }

    private static boolean isDnsChallengeHost(String host) {
        if (host == null) return false;
        java.util.regex.Matcher match = DNS_CHALLENGE_HOST.matcher(host.toLowerCase(Locale.ROOT));
        return match.matches() && Long.parseLong(match.group(1)) <= 9007199254740990L;
    }

    private static boolean isRandomProbeQuery(String value) {
        if (value.length() > 32 || !value.matches("(?:0(?:[.][0-9]+)?|[1-9](?:[.][0-9]+)?[eE]-[0-9]+)")) return false;
        double number = Double.parseDouble(value);
        return Double.isFinite(number) && number >= 0 && number < 1;
    }

    /** Bounded, thread-safe observations; never retains paths, credentials, queries or fragments. */
    public static final class BlockedDependencies {
        private int count;
        private final Set<String> origins = new LinkedHashSet<>();

        public synchronized void record(String url) {
            if (count < Integer.MAX_VALUE) count++;
            if (origins.size() < MAX_REPORTED_ORIGINS) origins.add(redactedOrigin(url));
        }

        public synchronized Snapshot snapshot() {
            return new Snapshot(count, new ArrayList<>(origins));
        }
    }

    public static final class Snapshot {
        public final int blockedRequests;
        public final List<String> origins;

        private Snapshot(int blockedRequests, List<String> origins) {
            this.blockedRequests = blockedRequests;
            this.origins = Collections.unmodifiableList(origins);
        }
    }

    public static String redactedOrigin(String url) {
        URI uri = parse(url);
        if (uri == null) return "<invalid-origin>";
        String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
        if (!"https".equals(scheme) && !"http".equals(scheme)) return "<non-http-origin>";
        String host = uri.getHost();
        int port = uri.getPort();
        if (host == null || host.length() > 253 || !host.matches("[A-Za-z0-9.\\-:\\[\\]]+")
                || port < -1 || port == 0 || port > 65535) return "<invalid-origin>";
        host = host.toLowerCase(Locale.ROOT);
        if (isDnsChallengeHost(host)) host = "<dns-challenge>.d.ping0.cc";
        if (host.indexOf(':') >= 0 && !host.startsWith("[")) host = "[" + host + "]";
        boolean defaultPort = port == -1 || ("https".equals(scheme) && port == 443)
                || ("http".equals(scheme) && port == 80);
        return scheme + "://" + host + (defaultPort ? "" : ":" + port);
    }

    private static URI parse(String value) {
        if (value == null || value.length() > 4096 || value.indexOf('\\') >= 0) return null;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isISOControl(c) || Character.isWhitespace(c)) return null;
            if (c == '%' && i + 2 < value.length()) {
                int high = Character.digit(value.charAt(i + 1), 16);
                int low = Character.digit(value.charAt(i + 2), 16);
                int octet = high * 16 + low;
                if (high >= 0 && low >= 0 && (octet < 32 || octet == 127)) return null;
            }
        }
        try {
            URI uri = new URI(value);
            return !uri.isAbsolute() || uri.isOpaque() ? null : uri;
        } catch (URISyntaxException invalid) {
            return null;
        }
    }

    private static boolean uuid(String value) {
        if (value == null) return false;
        try {
            return UUID.fromString(value).toString().equals(value);
        } catch (IllegalArgumentException invalid) {
            return false;
        }
    }
}
