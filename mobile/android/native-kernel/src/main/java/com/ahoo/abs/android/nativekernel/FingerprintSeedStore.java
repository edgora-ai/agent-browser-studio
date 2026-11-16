package com.ahoo.abs.android.nativekernel;

import java.io.File;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Set;

/** Pure-Java per-environment CSPRNG fingerprint seed storage.
 *
 *  <p>The caller supplies the app-private files directory
 *  ({@code Context.getFilesDir()}), so the whole read/create/persist lifecycle
 *  can be exercised by host regression tests without Android or Chromium
 *  classes. Predictable suffix-derived seeds are gone: an attacker who can
 *  guess the environment name cannot reproduce the noise.
 */
final class FingerprintSeedStore {
    private static final String DIRECTORY = "fingerprint-seeds";
    private static final int SEED_BYTES = 8;
    private static final long SEED_MASK = 0x7fffffffffffffffL;
    private static final char[] HEX_DIGITS = "0123456789abcdef".toCharArray();

    private FingerprintSeedStore() { }

    /** Resolve the per-env file, creating an owner-only seed directory. */
    static File seedFile(String directorySuffix, File filesDir) {
        if (filesDir == null) throw new IllegalStateException("FINGERPRINT_SEED_CONTEXT_MISSING");
        File directory = new File(filesDir, DIRECTORY);
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IllegalStateException("FINGERPRINT_SEED_DIR_UNAVAILABLE");
        }
        try {
            Files.setPosixFilePermissions(directory.toPath(),
                    PosixFilePermissions.fromString("rwx------"));
        } catch (IOException | UnsupportedOperationException ignored) {
            // non-POSIX host: the app-private parent still guards the directory
        }
        return new File(directory, directorySuffix + ".seed");
    }

    /** Read the persisted seed, or mint one with a CSPRNG and persist it. */
    static long loadOrCreate(String directorySuffix, File filesDir) {
        File file = seedFile(directorySuffix, filesDir);
        try {
            byte[] stored = Files.readAllBytes(file.toPath());
            if (stored.length == SEED_BYTES) return decode(stored);
        } catch (IOException missing) {
            // first launch of this environment: fall through and mint a seed
        }
        byte[] fresh = new byte[SEED_BYTES];
        new SecureRandom().nextBytes(fresh);
        long seed = decode(fresh);
        // re-encode from the masked value so the stored bytes round-trip exactly
        encode(seed, fresh);
        persistAtomically(file, fresh);
        return seed;
    }

    /** Read-only access for the bootstrap verification: fail closed. */
    static long readPersisted(String directorySuffix, File filesDir) {
        File file = seedFile(directorySuffix, filesDir);
        try {
            byte[] stored = Files.readAllBytes(file.toPath());
            if (stored.length != SEED_BYTES) {
                throw new IllegalStateException("FINGERPRINT_SEED_CORRUPT");
            }
            return decode(stored);
        } catch (IOException missing) {
            throw new IllegalStateException("FINGERPRINT_SEED_MISSING", missing);
        }
    }

    /** Stable, non-reversible digest for logs; the raw seed never leaves here. */
    static String fingerprint(long seed) {
        byte[] value = new byte[SEED_BYTES];
        encode(seed, value);
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
            char[] hex = new char[16];
            for (int i = 0; i < 8; i++) {
                int unsigned = digest[i] & 0xff;
                hex[i * 2] = HEX_DIGITS[unsigned >>> 4];
                hex[i * 2 + 1] = HEX_DIGITS[unsigned & 0xf];
            }
            return new String(hex);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256_UNAVAILABLE", impossible);
        }
    }

    private static long decode(byte[] bytes) {
        long seed = 0L;
        for (byte b : bytes) {
            seed = (seed << 8) | (b & 0xffL);
        }
        return seed & SEED_MASK;
    }

    private static void encode(long seed, byte[] out) {
        long remaining = seed;
        for (int i = out.length - 1; i >= 0; i--) {
            out[i] = (byte) (remaining & 0xffL);
            remaining >>>= 8;
        }
    }

    /** Temp file + rename, so a crash mid-write can never leave a half seed
     *  behind (a corrupt 8-byte file would otherwise brick the bootstrap). */
    private static void persistAtomically(File file, byte[] bytes) {
        Path target = file.toPath();
        Path temporary = null;
        try {
            temporary = Files.createTempFile(target.getParent(), ".seed-", ".tmp");
            Files.write(temporary, bytes);
            try {
                Files.move(temporary, target,
                        StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException fallback) {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException failure) {
            throw new IllegalStateException("FINGERPRINT_SEED_PERSIST_FAILED", failure);
        } finally {
            if (temporary != null) {
                try {
                    Files.deleteIfExists(temporary);
                } catch (IOException ignored) {
                    // best effort cleanup of the staging file
                }
            }
        }
    }
}
