package com.ahoo.abs.android.nativekernel;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Set;

/**
 * Pure-JDK behavioural regressions for the per-env fingerprint seed store.
 * A real temporary directory stands in for Context.getFilesDir(); no Android,
 * no Chromium, no device. This is the fast guard for the attachBaseContext
 * bug class: missing seed, stable seed, per-env distinct seed, corrupt-file
 * healing, owner-only directory, fail-closed read and null-dir rejection.
 */
public final class FingerprintSeedStoreHostTest {
    private static int checks;
    private static int failures;

    private FingerprintSeedStoreHostTest() { }

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("fingerprint-seed-host-");
        Path files = root.resolve("files");
        Files.createDirectories(files);
        Path seedDirectory = files.resolve("fingerprint-seeds");

        long first = FingerprintSeedStore.loadOrCreate("env-a", files.toFile());
        check(Files.isRegularFile(seedDirectory.resolve("env-a.seed")), "first load creates the seed file");
        check(Files.size(seedDirectory.resolve("env-a.seed")) == 8, "seed is exactly 8 bytes");
        check(FingerprintSeedStore.loadOrCreate("env-a", files.toFile()) == first, "seed is stable across loads");
        check(FingerprintSeedStore.readPersisted("env-a", files.toFile()) == first, "readPersisted returns the stored seed");
        check(FingerprintSeedStore.fingerprint(first).length() == 16, "fingerprint is 16 hex chars");
        check(FingerprintSeedStore.fingerprint(first).equals(FingerprintSeedStore.fingerprint(first)),
                "fingerprint is stable for one seed");

        long other = FingerprintSeedStore.loadOrCreate("env-b", files.toFile());
        check(other != first, "different env suffixes get different seeds");
        check(!FingerprintSeedStore.fingerprint(other).equals(FingerprintSeedStore.fingerprint(first)),
                "different seeds have different fingerprints");

        Files.write(seedDirectory.resolve("env-a.seed"), new byte[]{1, 2, 3});
        long healed = FingerprintSeedStore.loadOrCreate("env-a", files.toFile());
        check(Files.size(seedDirectory.resolve("env-a.seed")) == 8, "a corrupt seed is healed to 8 bytes");
        check(FingerprintSeedStore.readPersisted("env-a", files.toFile()) == healed, "healed seed round-trips");

        boolean missingThrown = false;
        try {
            FingerprintSeedStore.readPersisted("env-absent", files.toFile());
        } catch (IllegalStateException expected) {
            missingThrown = expected.getMessage().contains("FINGERPRINT_SEED_MISSING");
        }
        check(missingThrown, "readPersisted fails closed on a missing seed");

        Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(seedDirectory);
        boolean ownerOnly = permissions.stream().allMatch(permission ->
                permission == PosixFilePermission.OWNER_READ
                        || permission == PosixFilePermission.OWNER_WRITE
                        || permission == PosixFilePermission.OWNER_EXECUTE);
        check(ownerOnly, "seed directory is owner-only");

        boolean nullRejected = false;
        try {
            FingerprintSeedStore.seedFile("env-a", null);
        } catch (IllegalStateException expected) {
            nullRejected = expected.getMessage().contains("FINGERPRINT_SEED_CONTEXT_MISSING");
        }
        check(nullRejected, "a null files dir is rejected");

        System.out.println(checks + " fingerprint-seed-store host checks, " + failures + " failures");
        if (failures != 0) throw new AssertionError("Fingerprint seed store regressions: " + failures);
    }

    private static void check(boolean passed, String label) {
        checks++;
        if (!passed) {
            failures++;
            System.out.println("FAIL " + label);
        }
    }
}
