package com.ahoo.abs.core;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Fail-closed admission based on independent adapter evidence, not a proxy callback alone. */
public final class AdmissionGate {
    public enum Status { BLOCKED, UNVERIFIED, VERIFIED }

    public static final class Evidence {
        public final boolean proxyConfigured;
        public final boolean proxyAuthenticationSupported;
        public final boolean identityVerified;
        public final boolean networkConfinementVerified;
        public final boolean storageLifecycleVerified;

        public Evidence(boolean proxyConfigured, boolean proxyAuthenticationSupported, boolean identityVerified,
                boolean networkConfinementVerified, boolean storageLifecycleVerified) {
            this.proxyConfigured = proxyConfigured;
            this.proxyAuthenticationSupported = proxyAuthenticationSupported;
            this.identityVerified = identityVerified;
            this.networkConfinementVerified = networkConfinementVerified;
            this.storageLifecycleVerified = storageLifecycleVerified;
        }
    }

    public static final class Decision {
        public final Status status;
        public final List<String> reasons;
        private final String profileFingerprint;

        private Decision(Status status, List<String> reasons, String profileFingerprint) {
            this.status = status;
            this.reasons = Collections.unmodifiableList(new ArrayList<>(reasons));
            this.profileFingerprint = profileFingerprint;
        }

        boolean matches(ProfileSpec profile) {
            return profileFingerprint.equals(profile.fingerprint());
        }
    }

    private AdmissionGate() {}

    public static Decision evaluate(ProfileSpec profile, Evidence evidence) {
        if (profile == null) throw CoreValidation.error("INVALID_PROFILE", "Admission requires a profile");
        if (evidence == null) throw CoreValidation.error("INVALID_EVIDENCE", "Admission requires explicit evidence");
        List<String> reasons = new ArrayList<>();
        boolean unsupportedAuth = profile.proxy.hasCredentials && !evidence.proxyAuthenticationSupported;
        // No physical device-emulation capability exists in this contract: retain the request and block it.
        boolean unsupportedEmulation = profile.deviceMode == ProfileSpec.DeviceMode.DECLARED_ANDROID;
        if (unsupportedAuth) reasons.add("UNSUPPORTED_PROXY_AUTH");
        if (unsupportedEmulation) reasons.add("UNSUPPORTED_DEVICE_EMULATION");
        if (!evidence.proxyConfigured) reasons.add("PROXY_NOT_CONFIGURED");
        if (!evidence.identityVerified) reasons.add("IDENTITY_UNVERIFIED");
        if (!evidence.networkConfinementVerified) reasons.add("NETWORK_CONFINEMENT_UNVERIFIED");
        if (!evidence.storageLifecycleVerified) reasons.add("STORAGE_LIFECYCLE_UNVERIFIED");
        Status status = unsupportedAuth || unsupportedEmulation ? Status.BLOCKED
                : reasons.isEmpty() ? Status.VERIFIED : Status.UNVERIFIED;
        return new Decision(status, reasons, profile.fingerprint());
    }
}
