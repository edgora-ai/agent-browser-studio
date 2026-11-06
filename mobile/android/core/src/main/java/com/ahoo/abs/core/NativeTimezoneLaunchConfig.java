package com.ahoo.abs.core;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;

/** Serializes a claimed launch for native schema 1; neither consumes a claim nor proves native application. */
public final class NativeTimezoneLaunchConfig {
    public static final String CONFIG_SWITCH = "agent-browser-fingerprint-config";
    public static final String REQUIRED_SWITCH = "agent-browser-timezone-required";
    private static final String UUID_V4 =
            "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    private final String encoded;
    private final String inputSha256;

    private NativeTimezoneLaunchConfig(String json) {
        byte[] payload = json.getBytes(StandardCharsets.US_ASCII);
        encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(payload);
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(payload);
            StringBuilder hex = new StringBuilder(64);
            for (byte value : digest) {
                hex.append("0123456789abcdef".charAt((value & 255) >>> 4));
                hex.append("0123456789abcdef".charAt(value & 15));
            }
            inputSha256 = hex.toString();
        } catch (NoSuchAlgorithmException unavailable) {
            throw new IllegalStateException("NATIVE_CONFIG_SHA256_UNAVAILABLE", unavailable);
        }
    }

    /** The owner must already hold the lifetime lock and have atomically claimed this launch. */
    public static NativeTimezoneLaunchConfig fromLaunch(LaunchSpec launch, String incarnation, long nowMillis) {
        if (launch == null) throw CoreValidation.error("INVALID_LAUNCH", "A launch is required");
        launch.validateAt(nowMillis);
        if (launch.profile.deviceMode != ProfileSpec.DeviceMode.NATIVE) {
            throw CoreValidation.error("NATIVE_DEVICE_MODE_REQUIRED", "Native schema 1 does not implement device emulation");
        }
        if (!launch.profile.id.matches(UUID_V4)) {
            throw CoreValidation.error("INVALID_NATIVE_PROFILE_ID", "Native schema 1 requires a UUIDv4 profile");
        }
        if (incarnation == null || !incarnation.matches(UUID_V4)) {
            throw CoreValidation.error("INVALID_NATIVE_LAUNCH_ID", "A fresh canonical UUIDv4 incarnation is required");
        }
        String zone = launch.profile.timeZoneId;
        if (zone.length() > 128 || !zone.matches("[A-Za-z0-9/_+\\-]+")) {
            throw CoreValidation.error("UNSUPPORTED_NATIVE_TIME_ZONE", "The timezone cannot be represented in native schema 1");
        }
        String json = "{\"launchId\":\"" + incarnation + "\",\"mode\":\"timezone-only\",\"profileId\":\""
                + launch.profile.id + "\",\"schemaVersion\":1,\"timezone\":\"" + zone + "\"}";
        return new NativeTimezoneLaunchConfig(json);
    }

    public String encoded() { return encoded; }
    public String inputSha256() { return inputSha256; }

    /** A fresh array; no writable command-line file, Intent arguments, credentials or JS flags. */
    public String[] commandLine() {
        return new String[]{"agent-browser-product", "--" + CONFIG_SWITCH + "=" + encoded, "--" + REQUIRED_SWITCH};
    }
}
