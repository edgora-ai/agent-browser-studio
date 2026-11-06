package com.ahoo.abs.android.data;

import java.util.Arrays;

/** Explicit UI decision. Each instance is consumed once and closed even on save failure. */
public final class CredentialUpdate implements AutoCloseable {
    enum Kind { KEEP, CLEAR, REPLACE }

    final Kind kind;
    private char[] username;
    private char[] password;
    private boolean consumed;
    private boolean closed;

    private CredentialUpdate(Kind kind, char[] username, char[] password) {
        this.kind = kind;
        this.username = username;
        this.password = password;
    }

    public static CredentialUpdate keep() {
        return new CredentialUpdate(Kind.KEEP, null, null);
    }

    public static CredentialUpdate clear() {
        return new CredentialUpdate(Kind.CLEAR, null, null);
    }

    /** Copies the password. The caller still owns and must clear its original buffer. */
    public static CredentialUpdate replace(String username, char[] password) {
        if (username == null || password == null || username.length() == 0
                || username.length() > 4096 || password.length == 0 || password.length > 4096) {
            invalid();
        }
        char[] userCopy = username.toCharArray();
        char[] passCopy = password.clone();
        if (!valid(userCopy) || !valid(passCopy)) {
            Arrays.fill(userCopy, '\0');
            Arrays.fill(passCopy, '\0');
            invalid();
        }
        return new CredentialUpdate(Kind.REPLACE, userCopy, passCopy);
    }

    synchronized Credentials consume() {
        if (consumed || closed) {
            throw new StorageException(StorageException.Code.CREDENTIAL_UPDATE_CLOSED);
        }
        consumed = true;
        Credentials owned = kind == Kind.REPLACE ? new Credentials(username, password) : null;
        username = null;
        password = null;
        closed = true;
        return owned;
    }

    private static boolean valid(char[] value) {
        if (value.length == 0 || value.length > 4096) return false;
        for (char c : value) {
            if (c == '\0' || c == '\r' || c == '\n') return false;
        }
        return true;
    }

    private static void invalid() {
        throw new StorageException(StorageException.Code.CREDENTIAL_UPDATE_INVALID);
    }

    @Override
    public synchronized void close() {
        if (username != null) Arrays.fill(username, '\0');
        if (password != null) Arrays.fill(password, '\0');
        username = null;
        password = null;
        closed = true;
    }

    @Override
    public String toString() {
        return "CredentialUpdate[" + kind.name() + ",redacted]";
    }
}
