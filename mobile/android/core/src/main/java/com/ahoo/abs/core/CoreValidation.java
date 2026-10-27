package com.ahoo.abs.core;

import java.text.Normalizer;
import java.util.UUID;

final class CoreValidation {
    private CoreValidation() {}

    static String uuid(String value) {
        text(value, "INVALID_UUID");
        if (!value.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) {
            throw error("INVALID_UUID", "A full canonical UUID is required");
        }
        return UUID.fromString(value).toString();
    }

    static String text(String value, String nullCode) {
        if (value == null) throw error(nullCode, "A required value is missing");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isISOControl(c)) {
                throw error("CONTROL_CHARACTER", "Control characters are not permitted");
            }
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(i + 1))) {
                    throw error("INVALID_UNICODE", "Malformed Unicode is not permitted");
                }
                i++;
            } else if (Character.isLowSurrogate(c)) {
                throw error("INVALID_UNICODE", "Malformed Unicode is not permitted");
            }
        }
        return value;
    }

    static String boundedText(String value, int minimum, int maximum, String code) {
        String normalized = Normalizer.normalize(text(value, code), Normalizer.Form.NFC);
        int length = normalized.codePointCount(0, normalized.length());
        if (length < minimum || length > maximum) {
            throw error(code, "Text length is outside the permitted range");
        }
        return normalized;
    }

    static void port(int value) {
        if (value < 1 || value > 65535) throw error("INVALID_PORT", "Port must be between 1 and 65535");
    }

    static ValidationException error(String code, String message) {
        return new ValidationException(code, message);
    }
}
