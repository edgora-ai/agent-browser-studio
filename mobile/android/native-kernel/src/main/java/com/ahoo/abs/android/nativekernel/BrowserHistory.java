package com.ahoo.abs.android.nativekernel;

import java.net.IDN;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;

/**
 * Pure per-profile, site-level browsing history. Instances are not thread-safe; the owner
 * touches them on the main thread. Only HTTP(S) origins are retained, never URL userinfo,
 * paths, queries or fragments. Titles do not independently increment visit counts.
 */
public final class BrowserHistory {
    public static final int MAX_SITES = 200;
    public static final long MERGE_WINDOW_MILLIS = 3000L;
    private static final int MAX_VISIT_COUNT = 9999;
    private static final int MAX_TITLE_CHARS = 200;
    private static final int MAX_URL_CHARS = 4096;
    private static final String MAGIC = "ABSHISTv1";
    // More than a complete, maximally escaped real history; corrupt input cannot allocate
    // an unbounded line array/map or force an unbounded number of row parses.
    private static final int MAX_STORED_LINE_CHARS = 8192;
    private static final int MAX_STORED_CHARS = 1024 * 1024;
    private static final int MAX_STORED_LINES = MAX_SITES * 20;

    public static final class SiteVisit {
        public final String origin;
        public String title;
        public long lastVisitMillis;
        public int visitCount;

        SiteVisit(String origin, String title, long lastVisitMillis, int visitCount) {
            this.origin = origin;
            this.title = title == null ? "" : title;
            this.lastVisitMillis = lastVisitMillis;
            this.visitCount = visitCount;
        }
    }

    private final LinkedHashMap<String, SiteVisit> sites = new LinkedHashMap<>();

    /**
     * Returns a canonical scheme://host[:port], or null for malformed/non-HTTP(S) URLs.
     * Validates the whole URL before discarding sensitive components. DNS names use IDNA,
     * IPv6 literals are compressed, default ports and one trailing FQDN dot are removed.
     */
    public static String canonicalOrigin(String rawUrl) {
        if (rawUrl == null || rawUrl.length() > MAX_URL_CHARS) return null;
        for (int i = 0; i < rawUrl.length(); i++) {
            if (Character.isISOControl(rawUrl.charAt(i))) return null;
        }
        String url = rawUrl.trim();
        if (url.isEmpty()) return null;
        for (int i = 0; i < url.length(); i++) {
            char c = url.charAt(i);
            if (Character.isWhitespace(c) || Character.isSpaceChar(c) || c == '\\') return null;
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= url.length() || !Character.isLowSurrogate(url.charAt(++i))) return null;
            } else if (Character.isLowSurrogate(c)) {
                return null;
            }
        }
        final URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException malformed) {
            return null;
        }
        String scheme = uri.getScheme();
        if (scheme == null) return null;
        scheme = scheme.toLowerCase(Locale.US);
        boolean http = "http".equals(scheme);
        if (!http && !"https".equals(scheme)) return null;
        String authority = uri.getRawAuthority();
        if (authority == null || authority.isEmpty()) return null;
        int at = authority.indexOf('@');
        if (at != authority.lastIndexOf('@')) return null;
        String hostPort = at >= 0 ? authority.substring(at + 1) : authority;
        if (at >= 0) {
            String userInfo = authority.substring(0, at);
            if (userInfo.indexOf('[') >= 0 || userInfo.indexOf(']') >= 0) return null;
        }
        String host;
        int port = -1;
        if (hostPort.startsWith("[")) {
            int bracket = hostPort.indexOf(']');
            if (bracket < 0) return null;
            host = canonicalIpv6(hostPort.substring(1, bracket));
            if (host == null) return null;
            String tail = hostPort.substring(bracket + 1);
            if (!tail.isEmpty()) {
                if (!tail.startsWith(":")) return null;
                port = parsePort(tail.substring(1));
                if (port < 0) return null;
            }
        } else {
            int colon = hostPort.lastIndexOf(':');
            if (colon >= 0) {
                if (hostPort.indexOf(':') != colon) return null;
                port = parsePort(hostPort.substring(colon + 1));
                if (port < 0) return null;
                hostPort = hostPort.substring(0, colon);
            }
            host = canonicalDnsHost(hostPort);
            if (host == null) return null;
        }
        boolean defaultPort = (http && port == 80) || (!http && port == 443);
        return scheme + "://" + host + (port >= 0 && !defaultPort ? ":" + port : "");
    }

    private static String canonicalDnsHost(String value) {
        if (value.isEmpty() || value.indexOf('%') >= 0) return null;
        final String ascii;
        try {
            ascii = IDN.toASCII(value, IDN.USE_STD3_ASCII_RULES).toLowerCase(Locale.US);
        } catch (IllegalArgumentException malformed) {
            return null;
        }
        String host = ascii.endsWith(".") ? ascii.substring(0, ascii.length() - 1) : ascii;
        if (host.isEmpty() || host.length() > 253 || host.endsWith(".")) return null;
        // Reject ambiguous browser IPv4 spellings (short/octal/hex/integer), rather than
        // retaining a different origin from the one a browser would actually navigate to.
        String lastLabel = host.substring(host.lastIndexOf('.') + 1);
        boolean numeric = true;
        for (int i = 0; i < lastLabel.length(); i++) {
            char c = lastLabel.charAt(i);
            if (c < '0' || c > '9') numeric = false;
        }
        if (numeric || lastLabel.startsWith("0x")) {
            String[] parts = host.split("\\.", -1);
            if (parts.length != 4) return null;
            for (String part : parts) {
                if (part.isEmpty() || part.length() > 3
                        || (part.length() > 1 && part.charAt(0) == '0')) return null;
                int number = 0;
                for (int i = 0; i < part.length(); i++) {
                    char c = part.charAt(i);
                    if (c < '0' || c > '9') return null;
                    number = number * 10 + c - '0';
                }
                if (number > 255) return null;
            }
        }
        return host;
    }

    // URI already validates IPv6 syntax. Expand the numeric groups without DNS/network
    // calls, then emit one deterministic spelling, including IPv4-mapped literals.
    private static String canonicalIpv6(String literal) {
        if (literal.indexOf(':') < 0 || literal.indexOf('%') >= 0) return null;
        int[] groups = new int[8];
        int count = 0;
        int gap = -1;
        String[] parts = literal.split(":", -1);
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            if (part.isEmpty()) {
                if (i > 0 && i < parts.length - 1) {
                    if (gap >= 0) return null;
                    gap = count;
                }
                continue;
            }
            if (part.indexOf('.') >= 0) {
                if (i != parts.length - 1 || count > 6) return null;
                String[] bytes = part.split("\\.", -1);
                if (bytes.length != 4) return null;
                int address = 0;
                for (String octet : bytes) {
                    if (octet.isEmpty() || octet.length() > 3
                            || (octet.length() > 1 && octet.charAt(0) == '0')) return null;
                    int number;
                    try {
                        number = Integer.parseInt(octet);
                    } catch (NumberFormatException malformed) {
                        return null;
                    }
                    if (number < 0 || number > 255) return null;
                    address = (address << 8) | number;
                }
                groups[count++] = (address >>> 16) & 0xffff;
                groups[count++] = address & 0xffff;
            } else {
                if (count == 8 || part.length() > 4) return null;
                try {
                    groups[count++] = Integer.parseInt(part, 16);
                } catch (NumberFormatException malformed) {
                    return null;
                }
            }
        }
        if (gap >= 0) {
            if (count >= 8) return null;
            int shift = 8 - count;
            for (int i = count - 1; i >= gap; i--) groups[i + shift] = groups[i];
            for (int i = gap; i < gap + shift; i++) groups[i] = 0;
        } else if (count != 8) {
            return null;
        }
        int bestStart = -1;
        int bestLength = 1;
        for (int i = 0; i < groups.length;) {
            if (groups[i] != 0) { i++; continue; }
            int start = i;
            while (i < groups.length && groups[i] == 0) i++;
            if (i - start > bestLength) {
                bestStart = start;
                bestLength = i - start;
            }
        }
        StringBuilder out = new StringBuilder("[");
        for (int i = 0; i < groups.length;) {
            if (i == bestStart) {
                out.append("::");
                i += bestLength;
            } else {
                if (i > 0 && i != bestStart + bestLength) out.append(':');
                out.append(Integer.toHexString(groups[i++]));
            }
        }
        return out.append(']').toString();
    }

    public static boolean isTrackable(String rawUrl) {
        return canonicalOrigin(rawUrl) != null;
    }

    private static int parsePort(String value) {
        if (value.isEmpty() || value.length() > 5) return -1;
        int port = 0;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < '0' || c > '9') return -1;
            port = port * 10 + c - '0';
        }
        return port >= 1 && port <= 65535 ? port : -1;
    }

    /**
     * Normalizes omnibox whitespace, validates explicit HTTP(S) URLs and host-like input,
     * and encodes other input as a search. Unsafe/unknown schemes are never navigated.
     */
    public static String resolveInput(String raw) {
        if (raw == null || raw.length() > MAX_URL_CHARS) return null;
        StringBuilder normalized = new StringBuilder(raw.length());
        boolean space = false;
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= raw.length() || !Character.isLowSurrogate(raw.charAt(i + 1))) return null;
            } else if (Character.isLowSurrogate(c)
                    && (i == 0 || !Character.isHighSurrogate(raw.charAt(i - 1)))) {
                return null;
            }
            if (Character.isWhitespace(c) || Character.isSpaceChar(c)) {
                space = normalized.length() > 0;
            } else {
                if (Character.isISOControl(c)) return null;
                if (space) normalized.append(' ');
                normalized.append(c);
                space = false;
            }
        }
        String value = normalized.toString();
        if (value.isEmpty()) return null;
        if ("about:blank".equalsIgnoreCase(value)) return "about:blank";
        int colon = value.indexOf(':');
        if (colon > 0) {
            String scheme = value.substring(0, colon).toLowerCase(Locale.US);
            if ("http".equals(scheme) || "https".equals(scheme)) {
                return canonicalOrigin(value) == null ? null : value;
            }
            if (isScheme(scheme) && !"localhost".equals(scheme) && scheme.indexOf('.') < 0) return null;
        }
        // Try host:port before interpreting a colon as a scheme.
        if (looksLikeHost(value)) {
            String url = "https://" + value;
            return canonicalOrigin(url) == null ? null : url;
        }
        if (colon > 0 && isScheme(value.substring(0, colon))) return null;
        try {
            // Bing: reachable with or without a proxy in the target market; Google is not.
            return "https://www.bing.com/search?q=" + URLEncoder.encode(value, "UTF-8");
        } catch (java.io.UnsupportedEncodingException impossible) {
            return null;
        }
    }

    private static boolean isScheme(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
            if (!letter && (i == 0 || !((c >= '0' && c <= '9')
                    || c == '+' || c == '-' || c == '.'))) return false;
        }
        return !value.isEmpty();
    }

    private static boolean looksLikeHost(String value) {
        if (value.indexOf(' ') >= 0) return false;
        int end = value.length();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '/' || c == '?' || c == '#') { end = i; break; }
        }
        String authority = value.substring(0, end);
        String host = authority.substring(authority.lastIndexOf('@') + 1);
        if (host.startsWith("[")) return true;
        int colon = host.indexOf(':');
        if (colon >= 0) host = host.substring(0, colon);
        return "localhost".equalsIgnoreCase(host) || host.indexOf('.') >= 0
                || host.indexOf('\u3002') >= 0 || host.indexOf('\uff0e') >= 0
                || host.indexOf('\uff61') >= 0;
    }

    /**
     * Records a navigation, returning whether any persisted state changed. Merged callbacks
     * refresh time/title without adding a visit; stale/rolled-back clocks never add visits.
     * Negative timestamps are clamped to zero and counts saturate rather than wrapping.
     */
    public boolean recordVisit(String rawUrl, String title, long nowMillis) {
        String origin = canonicalOrigin(rawUrl);
        if (origin == null) return false;
        nowMillis = Math.max(0L, nowMillis);
        String clean = cleanTitle(title);
        SiteVisit visit = sites.get(origin);
        if (visit == null) {
            sites.put(origin, new SiteVisit(origin, clean, nowMillis, 1));
            evictOverCap();
            return sites.containsKey(origin);
        }
        boolean merged = nowMillis <= visit.lastVisitMillis
                || nowMillis - visit.lastVisitMillis < MERGE_WINDOW_MILLIS;
        boolean changed = false;
        if (nowMillis > visit.lastVisitMillis) {
            visit.lastVisitMillis = nowMillis;
            changed = true;
        }
        if (!clean.isEmpty() && !clean.equals(visit.title)) {
            visit.title = clean;
            changed = true;
        }
        if (!merged && visit.visitCount < MAX_VISIT_COUNT) {
            visit.visitCount++;
            changed = true;
        }
        return changed;
    }

    public boolean updateTitle(String rawUrl, String title) {
        String origin = canonicalOrigin(rawUrl);
        if (origin == null) return false;
        String clean = cleanTitle(title);
        if (clean.isEmpty()) return false;
        SiteVisit visit = sites.get(origin);
        if (visit == null || clean.equals(visit.title)) return false;
        visit.title = clean;
        return true;
    }

    public boolean removeSite(String origin) {
        String canonical = canonicalOrigin(origin);
        return canonical != null && sites.remove(canonical) != null;
    }

    public void clear() {
        sites.clear();
    }

    public int size() {
        return sites.size();
    }

    /** Most recent first, then most visited, then lexical origin for deterministic ties. */
    public List<SiteVisit> ranked() {
        List<SiteVisit> all = new ArrayList<>(sites.values());
        all.sort(BrowserHistory::compareVisits);
        return all;
    }

    private static int compareVisits(SiteVisit a, SiteVisit b) {
        int time = Long.compare(b.lastVisitMillis, a.lastVisitMillis);
        if (time != 0) return time;
        int count = Integer.compare(b.visitCount, a.visitCount);
        return count != 0 ? count : a.origin.compareTo(b.origin);
    }

    private void evictOverCap() {
        while (sites.size() > MAX_SITES) {
            SiteVisit victim = null;
            for (SiteVisit visit : sites.values()) {
                if (victim == null || compareVisits(visit, victim) > 0) victim = visit;
            }
            if (victim == null) break;
            sites.remove(victim.origin);
        }
    }

    private static String cleanTitle(String title) {
        if (title == null) return "";
        StringBuilder out = new StringBuilder(Math.min(title.length(), MAX_TITLE_CHARS));
        for (int i = 0; i < title.length() && out.length() < MAX_TITLE_CHARS;) {
            int cp = title.codePointAt(i);
            i += Character.charCount(cp);
            if (Character.isISOControl(cp) || (cp >= 0xd800 && cp <= 0xdfff)) continue;
            if (out.length() == 0 && isSpace(cp)) continue;
            if (out.length() + Character.charCount(cp) > MAX_TITLE_CHARS) break;
            out.appendCodePoint(cp);
        }
        while (out.length() > 0 && isSpace(out.codePointBefore(out.length()))) {
            out.setLength(out.length() - Character.charCount(out.codePointBefore(out.length())));
        }
        return out.toString();
    }

    private static boolean isSpace(int cp) {
        return Character.isWhitespace(cp) || Character.isSpaceChar(cp);
    }

    // ------------------------------------------------------------------ persistence

    /** First line is an escaped isolation key; rows are t, time, count, origin, title. */
    public String serialize(String isolationKey) {
        StringBuilder out = new StringBuilder();
        out.append(MAGIC).append('\t').append(escape(isolationKey == null ? "" : isolationKey)).append('\n');
        for (SiteVisit visit : ranked()) {
            out.append("t").append('\t').append(visit.lastVisitMillis).append('\t')
                    .append(visit.visitCount).append('\t')
                    .append(escape(visit.origin)).append('\t')
                    .append(escape(visit.title)).append('\n');
        }
        return out.toString();
    }

    /**
     * Loads only the exact owning profile key. Malformed rows are skipped; parsing work,
     * per-line allocation and retained entries stay bounded even for corrupt storage.
     */
    public static BrowserHistory deserialize(String text, String isolationKey) {
        BrowserHistory history = new BrowserHistory();
        if (text == null || text.isEmpty()) return history;
        int limit = Math.min(text.length(), MAX_STORED_CHARS);
        int end = lineEnd(text, 0, limit);
        if (end > MAX_STORED_LINE_CHARS) return history;
        String[] header = splitFields(text.substring(0, end));
        if (header.length != 2 || !MAGIC.equals(header[0])) return history;
        String storedKey = unescape(header[1]);
        if (storedKey == null || !storedKey.equals(isolationKey == null ? "" : isolationKey)) return history;
        int start = end + 1;
        for (int row = 0; start < limit && row < MAX_STORED_LINES; row++) {
            end = lineEnd(text, start, limit);
            // A truncated final line is not a complete record.
            if (end == limit && limit < text.length()) break;
            if (end - start <= MAX_STORED_LINE_CHARS && end > start) {
                history.readRow(text.substring(start, end));
            }
            start = end + 1;
        }
        return history;
    }

    private static int lineEnd(String text, int start, int limit) {
        int end = start;
        while (end < limit && text.charAt(end) != '\n') end++;
        return end;
    }

    private void readRow(String line) {
        String[] fields = splitFields(line);
        if (fields.length != 5 || !"t".equals(fields[0])) return;
        long lastVisit;
        int count;
        try {
            lastVisit = Long.parseLong(fields[1]);
            count = Integer.parseInt(fields[2]);
        } catch (NumberFormatException malformed) {
            return;
        }
        if (lastVisit < 0 || count < 1 || count > MAX_VISIT_COUNT) return;
        String rawOrigin = unescape(fields[3]);
        String title = unescape(fields[4]);
        String origin = canonicalOrigin(rawOrigin);
        if (origin == null || title == null) return;
        title = cleanTitle(title);
        SiteVisit existing = sites.get(origin);
        if (existing == null) {
            sites.put(origin, new SiteVisit(origin, title, lastVisit, count));
            evictOverCap();
        } else {
            if (!title.isEmpty() && lastVisit >= existing.lastVisitMillis) existing.title = title;
            existing.lastVisitMillis = Math.max(lastVisit, existing.lastVisitMillis);
            existing.visitCount = Math.max(count, existing.visitCount);
        }
    }

    private static String escape(String value) {
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\': out.append("\\\\"); break;
                case '\t': out.append("\\t"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                default: out.append(c);
            }
        }
        return out.toString();
    }

    private static String unescape(String value) {
        if (value.indexOf('\\') < 0) return value;
        StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c != '\\') { out.append(c); continue; }
            if (++i >= value.length()) return null;
            switch (value.charAt(i)) {
                case 't': out.append('\t'); break;
                case 'n': out.append('\n'); break;
                case 'r': out.append('\r'); break;
                case '\\': out.append('\\'); break;
                default: return null;
            }
        }
        return out.toString();
    }

    private static String[] splitFields(String line) {
        // Escaped delimiters are two literal characters (backslash + t), not actual tabs.
        // Preserve escapes for exactly one unescape pass; cap corrupt extra-field arrays.
        return line.split("\t", 6);
    }
}
