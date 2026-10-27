package com.ahoo.abs.core;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Untrusted ordinary navigation only. Trusted local probe loading must use a separate path. */
public final class NavigationPolicy {
    private static final Pattern SCHEME = Pattern.compile("^([A-Za-z][A-Za-z0-9+.-]*):(.*)$", Pattern.DOTALL);
    private static final Pattern HOST_PORT = Pattern.compile("^[^/?#:\\[\\]]+:[0-9]+(?:[/?#].*)?$", Pattern.DOTALL);
    private static final String[] RESERVED_HOSTS = {
            "appassets.androidplatform.net", "frames.abs-browser.invalid", "abs-probe.invalid"
    };

    private NavigationPolicy() {}

    /** Returns a canonical HTTP(S) URI or a stable ValidationException, without DNS/network access. */
    public static URI normalize(String input) {
        CoreValidation.text(input, "INVALID_URL");
        if (input.isEmpty() || input.indexOf('\\') >= 0) throw invalidUrl();
        rejectEscapedControls(input);
        String candidate;
        if (input.startsWith("//")) {
            candidate = "https:" + input;
        } else {
            Matcher matcher = SCHEME.matcher(input);
            if (!matcher.matches()) {
                candidate = "https://" + input;
            } else {
                String scheme = matcher.group(1).toLowerCase(Locale.ROOT);
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    candidate = input;
                } else if (HOST_PORT.matcher(input).matches() && !isForbiddenScheme(scheme)) {
                    candidate = "https://" + input;
                } else {
                    throw CoreValidation.error("UNSUPPORTED_SCHEME", "Only HTTP and HTTPS navigation is permitted");
                }
            }
        }
        try {
            URI parsed = new URI(candidate);
            String scheme = parsed.getScheme() == null ? "" : parsed.getScheme().toLowerCase(Locale.ROOT);
            if ((!"http".equals(scheme) && !"https".equals(scheme)) || parsed.isOpaque()) throw invalidUrl();
            HostSyntax.Endpoint endpoint = HostSyntax.authority(parsed.getRawAuthority());
            for (String reserved : RESERVED_HOSTS) {
                if (endpoint.host.equals(reserved) || endpoint.host.endsWith("." + reserved)) {
                    throw CoreValidation.error("RESERVED_PROBE_ORIGIN", "Internal probe origins cannot be opened as ordinary navigation");
                }
            }
            int port = endpoint.port;
            if (("http".equals(scheme) && port == 80) || ("https".equals(scheme) && port == 443)) port = -1;
            String path = parsed.getRawPath();
            if (path == null || path.isEmpty()) path = "/";
            StringBuilder canonical = new StringBuilder(scheme).append("://").append(HostSyntax.bracket(endpoint.host));
            if (port != -1) canonical.append(':').append(port);
            canonical.append(path);
            if (parsed.getRawQuery() != null) canonical.append('?').append(parsed.getRawQuery());
            if (parsed.getRawFragment() != null) canonical.append('#').append(parsed.getRawFragment());
            URI normalized = new URI(canonical.toString()).normalize();
            return new URI(normalized.toASCIIString());
        } catch (URISyntaxException e) {
            throw invalidUrl();
        }
    }

    private static boolean isForbiddenScheme(String scheme) {
        switch (scheme) {
            case "javascript": case "data": case "file": case "intent": case "content": case "about":
            case "blob": case "ftp": case "ftps": case "ws": case "wss": case "mailto": case "tel":
            case "chrome": case "chrome-extension": case "android-app":
                return true;
            default:
                return false;
        }
    }

    private static void rejectEscapedControls(String value) {
        for (int i = 0; i + 2 < value.length(); i++) {
            if (value.charAt(i) != '%') continue;
            int high = Character.digit(value.charAt(i + 1), 16);
            int low = Character.digit(value.charAt(i + 2), 16);
            if (high < 0 || low < 0) throw invalidUrl();
            int octet = (high << 4) | low;
            if (octet < 32 || octet == 127) throw encodedControl();
            if (octet == 194 && i + 5 < value.length() && value.charAt(i + 3) == '%') {
                int nextHigh = Character.digit(value.charAt(i + 4), 16);
                int nextLow = Character.digit(value.charAt(i + 5), 16);
                int next = (nextHigh << 4) | nextLow;
                if (nextHigh >= 0 && nextLow >= 0 && next >= 128 && next <= 159) throw encodedControl();
            }
        }
    }

    private static ValidationException encodedControl() {
        return CoreValidation.error("CONTROL_CHARACTER", "Encoded control characters are not permitted");
    }

    private static ValidationException invalidUrl() {
        return CoreValidation.error("INVALID_URL", "A well-formed HTTP or HTTPS URL is required");
    }
}
