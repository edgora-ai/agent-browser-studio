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
}
