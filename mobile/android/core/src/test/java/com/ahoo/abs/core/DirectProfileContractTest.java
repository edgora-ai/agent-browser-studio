package com.ahoo.abs.core;

import java.util.Arrays;

/** Pure-JDK direct-mode regressions, including independent pre-direct v1 hash vectors. */
public final class DirectProfileContractTest {
    private static final String ID = "12345678-1234-4234-8234-123456789abc";
    private static final String REV = "22345678-1234-4234-8234-123456789abc";
    private static final String CRED = "52345678-1234-4234-8234-123456789abc";
    private static int checks;
    private DirectProfileContractTest() {}

    public static void main(String[] args) {
        String[][] legacy = {
            {"563679edbc3c346bf087941752bdc00a65ba73d6f4b7ec7cd270826035f964f4", "957e20a67f919a6082ab14ed01df7ca3f31f7389a5c30a2c0337c08d5b3b033d"},
            {"fdca96694ac50e92b1d1c759dd09108df0e32508b83cc097bba46d32578a7ff5", "a8c30d54c49dd460d9de6104c161b4a279e36db4f80d20222a1d1ea81275fa5e"},
            {"23138daca1b07df4c533e9048fe22188d7291395eb09ebdf6e3f45e09dc2de0a", "9e13f3ae53428de6864348f928d36ec68f0c81d99758fb9d6f60f80d7bf6efca"}
        };
        for (ProxySpec.Scheme scheme : ProxySpec.Scheme.values()) {
            for (int auth = 0; auth < 2; auth++) {
                ProfileSpec profile = profile(new ProxySpec(scheme, "proxy.example", 8080, auth != 0), auth != 0 ? CRED : "");
                check(!profile.isDirect(), "Legacy proxy became direct");
                check(profile.hasProxyCredentials() == (auth != 0), "Legacy credential helper");
                check(legacy[scheme.ordinal()][auth].equals(profile.fingerprint()), "Legacy v1 hash changed");
            }
        }
        ProfileSpec direct = profile(null, "");
        check(direct.isDirect() && !direct.hasProxyCredentials(), "Explicit direct helpers");
        check("2f7cfccdddcacc4f12bd10f63780718ab29e32564ea2301c996abefd89a294d3".equals(direct.fingerprint()), "Direct hash domain vector");
        try { profile(null, CRED); throw new AssertionError("Direct credential revision accepted"); }
        catch (ValidationException expected) { check("INVALID_CREDENTIAL_REVISION".equals(expected.code), "Wrong credential rejection"); }
        AdmissionGate.Decision decision = AdmissionGate.evaluate(direct,
                new AdmissionGate.Evidence(false, false, false, false, false));
        check(decision.status == AdmissionGate.Status.UNVERIFIED, "Direct must remain unverified");
        check(decision.reasons.contains("DIRECT_CONNECTION_UNPROTECTED"), "Direct protection disclaimer missing");
        check(!decision.reasons.contains("PROXY_NOT_CONFIGURED"), "Direct incorrectly requires proxy");
        check(!decision.reasons.contains("UNSUPPORTED_PROXY_AUTH"), "Direct incorrectly requires auth");
        for (String reason : Arrays.asList("IDENTITY_UNVERIFIED", "NETWORK_CONFINEMENT_UNVERIFIED", "STORAGE_LIFECYCLE_UNVERIFIED")) {
            check(decision.reasons.contains(reason), "Direct evidence was weakened");
        }
        check(AdmissionGate.evaluate(direct, new AdmissionGate.Evidence(true, true, true, true, true)).status
                == AdmissionGate.Status.UNVERIFIED, "Direct cannot imply proxy protection");
        long now = 1800000000000L;
        LaunchSpec launch = new LaunchSpec(direct, "32345678-1234-4234-8234-123456789abc",
                "42345678-1234-4234-8234-123456789abc", now, now + 1000);
        launch.validateAt(now);
        check(launch.profile.isDirect(), "Frozen direct launch changed");
        check(!launch.configHash().equals(direct.fingerprint()), "Hash domains collapsed");
        System.out.println("DirectProfileContractTest: " + checks + " checks passed");
    }

    private static ProfileSpec profile(ProxySpec proxy, String credentials) {
        return new ProfileSpec(ID, REV, "Legacy profile", proxy, "US", "America/New_York",
                Arrays.asList("en-US", "en"), ProfileSpec.DeviceMode.NATIVE, "", credentials);
    }
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
    }
}
