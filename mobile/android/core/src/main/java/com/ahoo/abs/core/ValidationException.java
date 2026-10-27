package com.ahoo.abs.core;

/** A stable machine-readable rejection; messages deliberately omit submitted values. */
public final class ValidationException extends IllegalArgumentException {
    private static final long serialVersionUID = 1L;
    public final String code;

    public ValidationException(String code, String message) {
        super(message);
        if (code == null || !code.matches("[A-Z][A-Z0-9_]+")) {
            throw new IllegalArgumentException("Validation codes must be uppercase identifiers");
        }
        this.code = code;
    }
}
