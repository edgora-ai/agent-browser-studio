package com.ahoo.abs.core;

/** An immutable, short-lived launch envelope; replay consumption is a separate mandatory step. */
public final class LaunchSpec {
    public static final long MAX_TTL_MILLIS = 120000L;
    public static final long MAX_FUTURE_SKEW_MILLIS = 5000L;

    public final ProfileSpec profile;
    public final String sessionId;
    public final String nonce;
    public final long issuedAtMillis;
    public final long expiresAtMillis;
    private final String canonicalConfigHash;

    public LaunchSpec(ProfileSpec profile, String sessionId, String nonce, long issuedAtMillis, long expiresAtMillis) {
        if (profile == null) throw CoreValidation.error("INVALID_PROFILE", "A profile is required");
        this.profile = profile;
        this.sessionId = CoreValidation.uuid(sessionId);
        this.nonce = CoreValidation.uuid(nonce);
        if (issuedAtMillis < 0 || expiresAtMillis <= issuedAtMillis
                || expiresAtMillis - issuedAtMillis > MAX_TTL_MILLIS) {
            throw CoreValidation.error("INVALID_TTL", "Launch lifetime must be positive and at most 120000 milliseconds");
        }
        this.issuedAtMillis = issuedAtMillis;
        this.expiresAtMillis = expiresAtMillis;
        canonicalConfigHash = new CanonicalHash("abs.launch.v1").add(profile.fingerprint()).add(this.sessionId)
                .add(this.nonce).add(issuedAtMillis).add(expiresAtMillis).finish();
    }

    public void validateAt(long nowMillis) {
        if (nowMillis < 0) throw CoreValidation.error("INVALID_TIME", "A nonnegative observation time is required");
        if (nowMillis >= expiresAtMillis) throw CoreValidation.error("LAUNCH_EXPIRED", "The launch envelope has expired");
        if (issuedAtMillis > nowMillis && issuedAtMillis - nowMillis > MAX_FUTURE_SKEW_MILLIS) {
            throw CoreValidation.error("LAUNCH_FROM_FUTURE", "The launch timestamp is unreasonably far in the future");
        }
    }

    /** Binds every launch field, including session, nonce, timestamps, and the complete profile fingerprint. */
    public String configHash() {
        return canonicalConfigHash;
    }

    public String directorySuffix() {
        return profile.dataDirectorySuffix();
    }
}
