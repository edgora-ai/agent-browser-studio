package com.ahoo.abs.core;

import java.time.DateTimeException;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.IllformedLocaleException;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Immutable requested settings, not an assertion that a WebView can implement them. */
public final class ProfileSpec {
    /** NATIVE does not promise distinct hardware fingerprints between profiles. */
    public enum DeviceMode { NATIVE, DECLARED_ANDROID }

    private static final Set<String> COUNTRIES = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList(Locale.getISOCountries())));

    public final String id;
    public final String revision;
    public final String name;
    public final String countryCode;
    public final String timeZoneId;
    public final String deviceModel;
    public final String credentialRevision;
    public final List<String> languageTags;
    public final ProxySpec proxy;
    public final DeviceMode deviceMode;
    private final String canonicalFingerprint;

    public ProfileSpec(String id, String revision, String name, ProxySpec proxy, String countryCode,
            String timeZoneId, List<String> languageTags, DeviceMode deviceMode, String deviceModel,
            String credentialRevision) {
        this.id = CoreValidation.uuid(id);
        this.revision = CoreValidation.uuid(revision);
        this.name = CoreValidation.boundedText(name, 1, 80, "INVALID_NAME");
        if (isBlank(this.name)) throw CoreValidation.error("INVALID_NAME", "A nonblank profile name is required");
        if (proxy == null) throw CoreValidation.error("INVALID_PROXY", "An explicit proxy is required");
        this.proxy = proxy;
        this.countryCode = country(countryCode);
        this.timeZoneId = zone(timeZoneId);
        this.languageTags = languages(languageTags);
        if (deviceMode == null) throw CoreValidation.error("INVALID_DEVICE_MODE", "A device mode is required");
        this.deviceMode = deviceMode;
        this.deviceModel = CoreValidation.boundedText(deviceModel, 0, 128, "INVALID_DEVICE_MODEL");
        CoreValidation.text(credentialRevision, "INVALID_CREDENTIAL_REVISION");
        if (proxy.hasCredentials) {
            this.credentialRevision = CoreValidation.uuid(credentialRevision);
        } else {
            if (!credentialRevision.isEmpty()) {
                throw CoreValidation.error("INVALID_CREDENTIAL_REVISION", "A credential-free proxy cannot have a credential revision");
            }
            this.credentialRevision = "";
        }
        canonicalFingerprint = computeFingerprint();
    }

    /** A single relative basename; never derived from user-visible names or external paths. */
    public String dataDirectorySuffix() {
        return "p_" + id.replace("-", "");
    }

    /** Contains only public settings and a random credential-rotation UUID, never credential material. */
    public String fingerprint() {
        return canonicalFingerprint;
    }

    private String computeFingerprint() {
        CanonicalHash hash = new CanonicalHash("abs.profile.v1");
        hash.add(id).add(revision).add(name).add(proxy.scheme.name()).add(proxy.host).add(proxy.port)
                .add(proxy.hasCredentials).add(countryCode).add(timeZoneId).add(languageTags.size());
        for (String tag : languageTags) hash.add(tag);
        return hash.add(deviceMode.name()).add(deviceModel).add(credentialRevision).finish();
    }

    private static String country(String value) {
        CoreValidation.text(value, "INVALID_COUNTRY");
        String code = value.toUpperCase(Locale.ROOT);
        if (!value.isEmpty() && (!value.matches("[a-zA-Z]{2}") || !COUNTRIES.contains(code))) {
            throw CoreValidation.error("INVALID_COUNTRY", "Country must be empty or an ISO 3166-1 alpha-2 code");
        }
        return code;
    }

    private static String zone(String value) {
        CoreValidation.text(value, "INVALID_TIME_ZONE");
        try {
            return ZoneId.of(value).getId();
        } catch (DateTimeException e) {
            throw CoreValidation.error("INVALID_TIME_ZONE", "A real ZoneId is required");
        }
    }

    private static List<String> languages(List<String> values) {
        if (values == null || values.isEmpty()) {
            throw CoreValidation.error("INVALID_LANGUAGE_TAG", "At least one BCP 47 language tag is required");
        }
        List<String> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (String value : values) {
            CoreValidation.text(value, "INVALID_LANGUAGE_TAG");
            if (value.isEmpty()) throw CoreValidation.error("INVALID_LANGUAGE_TAG", "A language tag cannot be empty");
            String tag;
            try {
                tag = new Locale.Builder().setLanguageTag(value).build().toLanguageTag();
                rejectRepeatedSubtags(value);
            } catch (IllformedLocaleException e) {
                throw CoreValidation.error("INVALID_LANGUAGE_TAG", "A well-formed BCP 47 language tag is required");
            }
            if (!seen.add(tag.toLowerCase(Locale.ROOT))) {
                throw CoreValidation.error("DUPLICATE_LANGUAGE_TAG", "Language tags must be distinct after normalization");
            }
            result.add(tag);
        }
        return Collections.unmodifiableList(result);
    }

    /** Locale.Builder silently drops repeated extension singletons and accepts repeated variants. */
    private static void rejectRepeatedSubtags(String value) {
        String[] parts = value.toLowerCase(Locale.ROOT).split("-");
        if ("x".equals(parts[0])) return;
        Set<String> variants = new HashSet<>();
        Set<String> singletons = new HashSet<>();
        boolean inExtension = false;
        for (int i = 1; i < parts.length; i++) {
            String part = parts[i];
            if ("x".equals(part)) break;
            if (part.length() == 1) {
                inExtension = true;
                if (!singletons.add(part)) {
                    throw CoreValidation.error("INVALID_LANGUAGE_TAG", "BCP 47 extension singletons cannot repeat");
                }
            } else if (!inExtension && part.matches("(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3})") && !variants.add(part)) {
                throw CoreValidation.error("INVALID_LANGUAGE_TAG", "BCP 47 variants cannot repeat");
            }
        }
    }

    private static boolean isBlank(String value) {
        for (int i = 0; i < value.length();) {
            int point = value.codePointAt(i);
            if (!Character.isWhitespace(point) && !Character.isSpaceChar(point)) return false;
            i += Character.charCount(point);
        }
        return true;
    }
}
