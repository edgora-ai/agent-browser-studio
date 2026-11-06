package com.ahoo.abs.core;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Length-prefixed, domain-separated UTF-8 hashing; delimiters cannot alias fields. */
final class CanonicalHash {
    private final MessageDigest digest;

    CanonicalHash(String domain) {
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("The Java platform must provide SHA-256", e);
        }
        add(domain);
    }

    CanonicalHash add(String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        int length = bytes.length;
        digest.update((byte) (length >>> 24));
        digest.update((byte) (length >>> 16));
        digest.update((byte) (length >>> 8));
        digest.update((byte) length);
        digest.update(bytes);
        return this;
    }

    CanonicalHash add(long value) {
        return add(Long.toString(value));
    }

    CanonicalHash add(boolean value) {
        return add(value ? "1" : "0");
    }

    String finish() {
        final char[] hex = "0123456789abcdef".toCharArray();
        byte[] bytes = digest.digest();
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            result.append(hex[(value & 255) >>> 4]);
            result.append(hex[value & 15]);
        }
        return result.toString();
    }
}
