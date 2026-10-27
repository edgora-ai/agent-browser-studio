package com.ahoo.abs.android.data;

import java.text.Normalizer;
import java.util.Locale;
import java.util.UUID;

final class StoreChecks {
    private StoreChecks() {}

    static String uuid(String value) {
        if (value == null) invalid();
        try {
            if (!UUID.fromString(value).toString().equals(value)) invalid();
        } catch (IllegalArgumentException exception) {
            throw new StorageException(StorageException.Code.INVALID_ARGUMENT);
        }
        return value;
    }

    static String nameKey(String name) {
        if (name == null || name.trim().isEmpty()) invalid();
        String folded = Normalizer.normalize(name, Normalizer.Form.NFKC)
                .toUpperCase(Locale.ROOT).toLowerCase(Locale.ROOT);
        return Normalizer.normalize(folded, Normalizer.Form.NFKC);
    }

    static void same(String expected, String actual) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new StorageException(StorageException.Code.INTEGRITY_FAILURE);
        }
    }

    static void invalid() {
        throw new StorageException(StorageException.Code.INVALID_ARGUMENT);
    }
}
