package com.ahoo.abs.core;

import java.util.Locale;

/** A proxy endpoint, deliberately incapable of holding usernames or passwords. */
public final class ProxySpec {
    public enum Scheme { HTTP, HTTPS, SOCKS5 }

    public final Scheme scheme;
    public final String host;
    public final int port;
    public final boolean hasCredentials;

    public ProxySpec(Scheme scheme, String host, int port, boolean hasCredentials) {
        if (scheme == null) throw CoreValidation.error("INVALID_PROXY_SCHEME", "A proxy scheme is required");
        CoreValidation.port(port);
        this.scheme = scheme;
        this.host = HostSyntax.normalize(host);
        this.port = port;
        this.hasCredentials = hasCredentials;
    }

    public String authority() {
        return HostSyntax.bracket(host) + ":" + port;
    }

    public String proxyRule() {
        return scheme.name().toLowerCase(Locale.ROOT) + "://" + authority();
    }

    /**
     * Resolver rules that short-circuit every local resolution to the proxy exit.
     * In proxy mode, requests carry the hostname in
     * CONNECT, so nothing needs the system resolver, and mapped answers keep DNS
     * prefetch and preconnect hints from leaking destination hostnames to the
     * local ISP resolver. The proxy endpoint itself and loopback stay excluded so
     * the configured proxy can still be reached; an IPv6 literal keeps brackets.
     */
    public String hostResolverRules() {
        return "MAP * ~NOTFOUND,EXCLUDE " + HostSyntax.bracket(host)
                + ",EXCLUDE 127.0.0.1,EXCLUDE localhost";
    }
}
