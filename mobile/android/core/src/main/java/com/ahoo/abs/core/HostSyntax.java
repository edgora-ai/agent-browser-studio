package com.ahoo.abs.core;

import java.net.IDN;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Pure syntax only: never calls InetAddress, a resolver, or any network API. */
final class HostSyntax {
    private HostSyntax() {}

    static String normalize(String input) {
        CoreValidation.text(input, "INVALID_HOST");
        if (input.isEmpty() || input.indexOf('@') >= 0 || input.indexOf('/') >= 0
                || input.indexOf('\\') >= 0 || input.indexOf('?') >= 0 || input.indexOf('#') >= 0
                || input.indexOf('%') >= 0) {
            throw invalidHost();
        }
        String host = input;
        if (host.startsWith("[") || host.endsWith("]")) {
            if (!host.startsWith("[") || !host.endsWith("]") || host.indexOf(':') < 0) throw invalidHost();
            host = host.substring(1, host.length() - 1);
        }
        if (host.indexOf(':') >= 0) return ipv6(host);
        String ascii;
        try {
            ascii = IDN.toASCII(host, IDN.USE_STD3_ASCII_RULES).toLowerCase(Locale.ROOT);
        } catch (IllegalArgumentException e) {
            throw invalidHost();
        }
        if (ascii.endsWith(".")) ascii = ascii.substring(0, ascii.length() - 1);
        if (ascii.isEmpty() || ascii.length() > 253) throw invalidHost();
        for (String label : ascii.split("\\.", -1)) {
            if (label.isEmpty() || label.length() > 63 || !label.matches("[a-z0-9](?:[a-z0-9-]*[a-z0-9])?")) {
                throw invalidHost();
            }
            if (label.startsWith("xn--")) {
                String unicode = IDN.toUnicode(label, IDN.USE_STD3_ASCII_RULES);
                if (unicode.equalsIgnoreCase(label)) throw invalidHost();
                try {
                    if (!IDN.toASCII(unicode, IDN.USE_STD3_ASCII_RULES).equalsIgnoreCase(label)) throw invalidHost();
                } catch (IllegalArgumentException e) {
                    throw invalidHost();
                }
            }
        }
        // Browsers interpret numeric/hex/octal shorthand as IPs. Accept only dotted decimal.
        if (ascii.matches("(?i)(?:[0-9]+|0x[0-9a-f]+)(?:\\.(?:[0-9]+|0x[0-9a-f]+))*")) {
            ipv4(ascii);
        }
        return ascii;
    }

    static Endpoint authority(String raw) {
        if (raw == null || raw.isEmpty()) throw invalidHost();
        if (raw.indexOf('@') >= 0) {
            throw CoreValidation.error("USERINFO_NOT_ALLOWED", "URL user information is not permitted");
        }
        String host;
        int port = -1;
        if (raw.startsWith("[")) {
            int end = raw.indexOf(']');
            if (end < 0) throw invalidHost();
            host = raw.substring(0, end + 1);
            if (end + 1 < raw.length()) {
                if (raw.charAt(end + 1) != ':') throw invalidHost();
                port = parsePort(raw.substring(end + 2));
            }
        } else {
            int colon = raw.indexOf(':');
            if (colon >= 0) {
                if (colon != raw.lastIndexOf(':')) throw invalidHost();
                host = raw.substring(0, colon);
                port = parsePort(raw.substring(colon + 1));
            } else {
                host = raw;
            }
        }
        return new Endpoint(normalize(host), port);
    }

    static String bracket(String host) {
        return host.indexOf(':') >= 0 ? "[" + host + "]" : host;
    }

    private static int parsePort(String raw) {
        if (raw.isEmpty()) throw CoreValidation.error("INVALID_PORT", "An explicit port cannot be empty");
        int value = 0;
        for (int i = 0; i < raw.length(); i++) {
            char digit = raw.charAt(i);
            if (digit < '0' || digit > '9') throw CoreValidation.error("INVALID_PORT", "Port must be decimal");
            value = value * 10 + digit - '0';
            if (value > 65535) throw CoreValidation.error("INVALID_PORT", "Port must be at most 65535");
        }
        CoreValidation.port(value);
        return value;
    }

    private static int[] ipv4(String host) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) throw invalidHost();
        int[] bytes = new int[4];
        for (int i = 0; i < 4; i++) {
            String part = parts[i];
            if (part.isEmpty() || part.length() > 3 || (part.length() > 1 && part.charAt(0) == '0')) throw invalidHost();
            int value = 0;
            for (int j = 0; j < part.length(); j++) {
                char digit = part.charAt(j);
                if (digit < '0' || digit > '9') throw invalidHost();
                value = value * 10 + digit - '0';
            }
            if (value > 255) throw invalidHost();
            bytes[i] = value;
        }
        return bytes;
    }

    private static String ipv6(String input) {
        String[] halves = input.split("::", -1);
        if (halves.length > 2) throw invalidHost();
        List<Integer> left = words(halves[0], halves.length == 1);
        List<Integer> right = halves.length == 2 ? words(halves[1], true) : new ArrayList<Integer>();
        int count = left.size() + right.size();
        if ((halves.length == 1 && count != 8) || (halves.length == 2 && count >= 8)) throw invalidHost();
        int[] address = new int[8];
        for (int i = 0; i < left.size(); i++) address[i] = left.get(i);
        for (int i = 0; i < right.size(); i++) address[8 - right.size() + i] = right.get(i);
        int bestStart = -1;
        int bestLength = 1;
        for (int i = 0; i < address.length;) {
            if (address[i] != 0) { i++; continue; }
            int start = i;
            while (i < address.length && address[i] == 0) i++;
            if (i - start > bestLength) { bestStart = start; bestLength = i - start; }
        }
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < address.length;) {
            if (i == bestStart) {
                result.append("::");
                i += bestLength;
            } else {
                if (result.length() > 0 && result.charAt(result.length() - 1) != ':') result.append(':');
                result.append(Integer.toHexString(address[i++]));
            }
        }
        return result.toString();
    }

    private static List<Integer> words(String section, boolean mayContainIpv4) {
        List<Integer> result = new ArrayList<>();
        if (section.isEmpty()) return result;
        String[] parts = section.split(":", -1);
        for (int i = 0; i < parts.length; i++) {
            String word = parts[i];
            if (word.indexOf('.') >= 0) {
                if (!mayContainIpv4 || i != parts.length - 1) throw invalidHost();
                int[] bytes = ipv4(word);
                result.add((bytes[0] << 8) | bytes[1]);
                result.add((bytes[2] << 8) | bytes[3]);
            } else {
                if (!word.matches("[0-9a-fA-F]{1,4}")) throw invalidHost();
                result.add(Integer.parseInt(word, 16));
            }
        }
        return result;
    }

    private static ValidationException invalidHost() {
        return CoreValidation.error("INVALID_HOST", "Host must be a valid DNS, IDN, IPv4, or IPv6 address without credentials or URL components");
    }

    static final class Endpoint {
        final String host;
        final int port;
        Endpoint(String host, int port) { this.host = host; this.port = port; }
    }
}
