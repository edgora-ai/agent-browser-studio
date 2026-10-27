package com.ahoo.abs.android.data;

import java.util.Arrays;

/** Owned, short-lived buffers. Never put these buffers in an Intent or LaunchSpec. */
public final class Credentials implements AutoCloseable {
    private final char[] username;
    private final char[] password;
    private boolean closed;

    Credentials(char[] username, char[] password) {
        this.username = username;
        this.password = password;
    }

    /** Returns the owned buffer, not a new String. It is zeroed by close(). */
    public synchronized char[] username() {
        requireOpen();
        return username;
    }

    /** Returns the owned buffer, not a copy; callers must not retain it past close(). */
    public synchronized char[] password() {
        requireOpen();
        return password;
    }

    @Override
    public synchronized void close() {
        Arrays.fill(username, '\0');
        Arrays.fill(password, '\0');
        closed = true;
    }

    private void requireOpen() {
        if (closed) throw new StorageException(StorageException.Code.CLOSED);
    }

    @Override
    public String toString() {
        return "Credentials[redacted]";
    }
}
