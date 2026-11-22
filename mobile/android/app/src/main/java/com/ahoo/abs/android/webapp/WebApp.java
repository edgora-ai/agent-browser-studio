package com.ahoo.abs.android.webapp;

import java.net.URI;
import java.util.Locale;
import java.util.Objects;
import java.util.UUID;

/** A validated, profile-owned install record. Metadata comes from Chromium's manifest bridge. */
public final class WebApp {
    public final String shortcutId;
    public final String profileId;
    public final String manifestId;
    public final String name;
    public final String startUrl;
    public final String scope;
    public final String origin;

    WebApp(String shortcutId, String profileId, String manifestId, String name, String startUrl,
            String scope, String origin) {
        if (!isOpaqueId(shortcutId) || !isOpaqueId(profileId)) throw invalid();
        validatedScope(manifestId, startUrl, scope, origin);
        this.shortcutId = shortcutId;
        this.profileId = profileId;
        this.manifestId = manifestId;
        this.name = displayName(name);
        this.startUrl = startUrl;
        this.scope = scope;
        this.origin = origin;
    }

    public boolean contains(String url) {
        try { return within(httpsUrl(url), httpsUrl(scope)); }
        catch (IllegalArgumentException invalid) { return false; }
    }

    /** Validate the same manifest metadata and boundary that would be stored after consent. */
    public static boolean canInstall(String id, String start, String scope, String origin, String current) {
        try { return within(httpsUrl(current), validatedScope(id, start, scope, origin)); }
        catch (IllegalArgumentException invalid) { return false; }
    }

    private static URI validatedScope(String id, String start, String scope, String origin) {
        URI identity = httpsUrl(id);
        URI boundary = httpsUrl(scope);
        if (identity.getRawFragment() != null || boundary.getRawQuery() != null
                || boundary.getRawFragment() != null || !originOf(identity).equals(origin)
                || !originOf(boundary).equals(origin) || !within(httpsUrl(start), boundary)) throw invalid();
        return boundary;
    }

    public boolean sameInstall(WebApp other) {
        return other != null && shortcutId.equals(other.shortcutId) && profileId.equals(other.profileId)
                && manifestId.equals(other.manifestId) && name.equals(other.name)
                && startUrl.equals(other.startUrl) && scope.equals(other.scope) && origin.equals(other.origin);
    }

    public static boolean isOpaqueId(String value) {
        if (value == null || value.length() != 36) return false;
        try {
            UUID parsed = UUID.fromString(value);
            return parsed.version() == 4 && parsed.variant() == 2 && parsed.toString().equals(value);
        } catch (IllegalArgumentException malformed) { return false; }
    }

    /** Labels cannot inject lines or bidi overrides. Show the actual ASCII origin separately. */
    public static String displayName(String value) {
        if (value == null || value.length() > 1024) throw invalid();
        StringBuilder out = new StringBuilder();
        int count = 0;
        for (int i = 0; i < value.length() && count < 80;) {
            int cp = value.codePointAt(i);
            i += Character.charCount(cp);
            int type = Character.getType(cp);
            if (Character.isISOControl(cp) || type == Character.FORMAT || type == Character.SURROGATE
                    || Character.isWhitespace(cp) || Character.isSpaceChar(cp)) {
                if (out.length() != 0 && out.charAt(out.length() - 1) != ' ') {
                    out.append(' ');
                    count++;
                }
            } else {
                out.appendCodePoint(cp);
                count++;
            }
        }
        String label = out.toString().trim();
        if (label.isEmpty()) throw invalid();
        return label;
    }

    private static boolean within(URI url, URI scope) {
        if (!originOf(scope).equals(originOf(url))) return false;
        String limit = scope.getRawPath();
        String path = url.getRawPath();
        // A slashless scope includes descendants, not a sibling with the same name prefix.
        return path.equals(limit) || path.startsWith(limit.endsWith("/") ? limit : limit + "/");
    }

    private static URI httpsUrl(String raw) {
        if (raw == null || raw.length() > 4096 || !raw.startsWith("https://")) throw invalid();
        URI uri = URI.create(raw);
        if (!raw.equals(uri.toASCIIString()) || !"https".equals(uri.getScheme())
                || uri.getHost() == null || uri.getRawUserInfo() != null || uri.isOpaque()
                || uri.getPort() > 65535 || uri.getPort() == 443 || uri.getPort() == 0
                || !Objects.equals(uri.getRawAuthority(), uri.getHost()
                        + (uri.getPort() == -1 ? "" : ":" + uri.getPort()))) throw invalid();
        String path = uri.getRawPath();
        String lower = path.toLowerCase(Locale.ROOT);
        if (!path.startsWith("/") || lower.contains("%2f") || lower.contains("%5c")
                || lower.contains("%00") || lower.contains("%25")) throw invalid();
        for (String segment : lower.replace("%2e", ".").split("/", -1)) {
            if (segment.equals(".") || segment.equals("..")) throw invalid();
        }
        return uri;
    }

    private static String originOf(URI url) { return "https://" + url.getRawAuthority(); }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("INVALID_WEB_APP"); }
}
