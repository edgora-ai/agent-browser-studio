package com.ahoo.abs.android.browser;

import android.icu.util.TimeZone;
import com.ahoo.abs.core.ProfileSpec;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IllformedLocaleException;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Local native declarations/locale validation only; never a network or hardware gate.
 * The caller must first enforce UTF-8 size, trusted origin, source and main-frame provenance.
 */
public final class IdentityReport {
    private static final List<String> KINDS = Collections.unmodifiableList(Arrays.asList(
            "main", "same-origin-frame", "cross-origin-frame", "dedicated-worker", "shared-worker", "service-worker"));
    private static final Instant JANUARY = Instant.parse("2026-01-15T00:00:00Z");
    private static final Instant JULY = Instant.parse("2026-07-15T00:00:00Z");

    private IdentityReport() { }

    public static final class Result {
        public final boolean identityVerified;
        /** Fixed codes, including coverage limitations even when identityVerified is true. */
        public final List<String> reasons;
        /** Unique status=ok realms with a values object, not a count of matching identities. */
        public final int observedContexts;
        private Result(State state) {
            identityVerified = !state.failed;
            reasons = Collections.unmodifiableList(new ArrayList<>(state.reasons));
            observedContexts = state.observed;
        }
    }

    private static final class State {
        final Set<String> reasons = new LinkedHashSet<>(Arrays.asList(
                "NETWORK_HEADERS_NOT_COVERED", "PROXY_ROUTING_NOT_COVERED", "HARDWARE_EMULATION_NOT_COVERED"));
        boolean failed;
        int observed;
        void fail(String code) { failed = true; reasons.add(code); }
        void note(String code) { reasons.add(code); }
        Result finish() { return new Result(this); }
    }

    private static final class Invalid extends Exception {
        final String code;
        Invalid(String code) { this.code = code; }
    }

    public static Result evaluate(ProfileSpec expected, String expectedChallenge, JSONObject report) {
        State state = new State();
        if (expected == null || expected.deviceMode == null || !safeChallenge(expectedChallenge) || report == null) {
            state.fail("EXPECTED_INPUT_INVALID");
            return state.finish();
        }
        if (expected.deviceMode != ProfileSpec.DeviceMode.NATIVE) {
            state.fail("DECLARED_ANDROID_UNSUPPORTED");
            return state.finish();
        }
        state.note("NATIVE_DECLARATIONS_ONLY");
        try {
            if (expected.languageTags == null || expected.languageTags.isEmpty() || expected.languageTags.size() > 8)
                throw new Invalid("EXPECTED_LANGUAGE_INVALID");
            List<String> languages = new ArrayList<>();
            for (String tag : expected.languageTags) languages.add(language(tag));
            if (new HashSet<>(languages).size() != languages.size()) throw new Invalid("EXPECTED_LANGUAGE_INVALID");
            String expectedZone = canonicalZone(expected.timeZoneId);
            ZoneId zone = ZoneId.of(expected.timeZoneId);
            if (report.length() != 5 || integer(report.get("schemaVersion"), 1, 1) != 1)
                throw new Invalid("SCHEMA_INVALID");
            String challenge = text(report.get("challenge"), 1, 128);
            if (!safeChallenge(challenge) || !expectedChallenge.equals(challenge)) throw new Invalid("CHALLENGE_MISMATCH");
            if (!bool(report.get("complete"))) state.fail("REPORT_INCOMPLETE");
            JSONObject coverage = object(report.get("coverage"));
            if (coverage.length() != 3 || bool(coverage.get("networkHeaders")) || bool(coverage.get("proxyRouting")) ||
                    bool(coverage.get("hardwareEmulation"))) throw new Invalid("COVERAGE_INVALID");
            JSONArray array = array(report.get("contexts"));
            if (array.length() != 6) throw new Invalid("CONTEXT_SET_INVALID");
            Map<String, JSONObject> contexts = new HashMap<>();
            for (int i = 0; i < array.length(); i++) {
                JSONObject context = object(array.get(i));
                String kind = text(context.get("kind"), 1, 32);
                if (!KINDS.contains(kind) || contexts.put(kind, context) != null) throw new Invalid("CONTEXT_SET_INVALID");
            }
            String mainUa = null;
            for (String kind : KINDS) {
                try {
                    JSONObject context = contexts.get(kind);
                    String status = text(context.get("status"), 1, 16);
                    if ("unsupported".equals(status) && "shared-worker".equals(kind)) {
                        if (context.length() != 3 || !"API_UNSUPPORTED".equals(text(context.get("code"), 1, 64)))
                            throw new Invalid("CONTEXT_FORMAT_INVALID");
                        state.note("SHARED_WORKER_UNSUPPORTED");
                        continue;
                    }
                    if (!"ok".equals(status)) {
                        state.fail("failed".equals(status) ? "CONTEXT_FAILED" : "REQUIRED_CONTEXT_NOT_OK");
                        continue;
                    }
                    if (context.length() != 3 || context.has("code")) throw new Invalid("CONTEXT_FORMAT_INVALID");
                    JSONObject values = object(context.get("values"));
                    state.observed++;
                    JSONObject navigator = object(values.get("navigator"));
                    String ua = text(navigator.get("userAgent"), 1, 4096);
                    if ("main".equals(kind)) mainUa = ua;
                    else if (mainUa == null || !mainUa.equals(ua)) state.fail("REALM_UA_MISMATCH");
                    checkCore(values, navigator, zone, expectedZone, languages, state);
                    checkNavigator(navigator, state);
                    if ("main".equals(kind) || kind.endsWith("-frame")) checkScreen(values, state);
                } catch (JSONException error) {
                    state.fail("REPORT_FIELD_MISSING");
                } catch (Invalid error) {
                    state.fail(error.code);
                }
            }
        } catch (JSONException error) {
            state.fail("REPORT_FIELD_MISSING");
        } catch (Invalid error) {
            state.fail(error.code);
        } catch (DateTimeException error) {
            state.fail("EXPECTED_TIME_ZONE_UNSUPPORTED");
        }
        return state.finish();
    }

    private static void checkCore(JSONObject values, JSONObject navigator, ZoneId zone, String expectedZone,
            List<String> languages, State state) throws JSONException, Invalid {
        JSONObject intl = object(values.get("intl"));
        if (!expectedZone.equals(canonicalZone(text(intl.get("timeZone"), 1, 128)))) state.fail("TIME_ZONE_MISMATCH");
        if (!languages.get(0).equals(language(intl.get("locale")))) state.fail("INTL_LOCALE_MISMATCH");
        if (!languages.get(0).equals(language(navigator.get("language")))) state.fail("NAVIGATOR_LANGUAGE_MISMATCH");
        JSONArray actual = array(navigator.get("languages"));
        if (actual.length() == 0 || actual.length() > 8) throw new Invalid("LANGUAGES_INVALID");
        if (actual.length() != languages.size()) state.fail("NAVIGATOR_LANGUAGES_MISMATCH");
        for (int i = 0; i < actual.length(); i++) {
            String tag = language(actual.get(i));
            if (i >= languages.size() || !languages.get(i).equals(tag)) state.fail("NAVIGATOR_LANGUAGES_MISMATCH");
        }
        JSONObject date = object(values.get("date"));
        long epoch = integer(date.get("epochMilliseconds"), -8640000000000000L, 8640000000000000L);
        text(date.get("localString"), 1, 512);
        checkOffset(date, "timezoneOffset", Instant.ofEpochMilli(epoch), zone, state);
        checkOffset(date, "januaryTimezoneOffset", JANUARY, zone, state);
        checkOffset(date, "julyTimezoneOffset", JULY, zone, state);
    }

    private static void checkOffset(JSONObject date, String key, Instant instant, ZoneId zone, State state)
            throws JSONException, Invalid {
        double actual = number(date.get(key), -1440, 1440);
        double wanted = -zone.getRules().getOffset(instant).getTotalSeconds() / 60.0;
        if (actual != wanted) state.fail("DATE_OFFSET_MISMATCH");
    }

    private static void checkNavigator(JSONObject navigator, State state) throws JSONException, Invalid {
        optionalText(navigator, "platform", 256, state, "NAVIGATOR_OPTIONALS_NOT_COVERED");
        optionalNumber(navigator, "hardwareConcurrency", 1, 65536, state, "NAVIGATOR_OPTIONALS_NOT_COVERED");
        optionalNumber(navigator, "deviceMemory", 0, 65536, state, "NAVIGATOR_OPTIONALS_NOT_COVERED");
        optionalNumber(navigator, "maxTouchPoints", 0, 65536, state, "NAVIGATOR_OPTIONALS_NOT_COVERED");
        Object raw = nullable(navigator, "userAgentData");
        if (raw == null) { state.note("UA_DATA_NOT_COVERED"); return; }
        JSONObject data = object(raw);
        state.note("UA_DATA_OBSERVED_ONLY");
        checkBrands(nullable(data, "brands"), state, "UA_DATA_NOT_COVERED");
        Object mobile = nullable(data, "mobile");
        if (mobile == null) state.note("UA_DATA_NOT_COVERED"); else bool(mobile);
        optionalText(data, "platform", 256, state, "UA_DATA_NOT_COVERED");
        Object entropy = nullable(data, "highEntropy");
        if (entropy == null) { state.note("UA_HIGH_ENTROPY_NOT_COVERED"); return; }
        JSONObject high = object(entropy);
        String status = text(high.get("status"), 1, 16);
        if ("failed".equals(status)) throw new Invalid("UA_DATA_FAILED");
        if ("unsupported".equals(status)) {
            if (!"API_UNSUPPORTED".equals(text(high.get("code"), 1, 64))) throw new Invalid("UA_DATA_FORMAT_INVALID");
            state.note("UA_HIGH_ENTROPY_NOT_COVERED");
        } else if (!"ok".equals(status) || high.has("code")) throw new Invalid("UA_DATA_FORMAT_INVALID");
        JSONObject hints = object(high.get("values"));
        for (String key : Arrays.asList("model", "architecture", "bitness", "platformVersion"))
            optionalText(hints, key, 256, state, "UA_HIGH_ENTROPY_NOT_COVERED");
        checkBrands(nullable(hints, "fullVersionList"), state, "UA_HIGH_ENTROPY_NOT_COVERED");
    }

    private static void checkBrands(Object raw, State state, String limitation) throws JSONException, Invalid {
        if (raw == null) { state.note(limitation); return; }
        JSONArray list = array(raw);
        if (list.length() == 0) state.note(limitation);
        if (list.length() > 32) throw new Invalid("UA_DATA_FORMAT_INVALID");
        for (int i = 0; i < list.length(); i++) {
            JSONObject brand = object(list.get(i));
            text(brand.get("brand"), 1, 256);
            text(brand.get("version"), 1, 64);
        }
    }

    private static void checkScreen(JSONObject values, State state) throws JSONException, Invalid {
        Object raw = nullable(values, "screen");
        if (raw == null) state.note("SCREEN_NOT_COVERED");
        else {
            JSONObject screen = object(raw);
            for (String key : Arrays.asList("width", "height", "availWidth", "availHeight"))
                optionalNumber(screen, key, 0, 100000, state, "SCREEN_NOT_COVERED");
            optionalNumber(screen, "colorDepth", 1, 128, state, "SCREEN_NOT_COVERED");
            optionalNumber(screen, "pixelDepth", 1, 128, state, "SCREEN_NOT_COVERED");
            Object rawOrientation = nullable(screen, "orientation");
            if (rawOrientation == null) state.note("SCREEN_ORIENTATION_NOT_COVERED");
            else {
                JSONObject orientation = object(rawOrientation);
                optionalText(orientation, "type", 64, state, "SCREEN_ORIENTATION_NOT_COVERED");
                optionalNumber(orientation, "angle", -360, 360, state, "SCREEN_ORIENTATION_NOT_COVERED");
            }
        }
        optionalNumber(values, "devicePixelRatio", 0.01, 100, state, "SCREEN_NOT_COVERED");
    }

    private static void optionalText(JSONObject object, String key, int max, State state, String limitation)
            throws JSONException, Invalid {
        Object value = nullable(object, key);
        if (value == null) state.note(limitation); else text(value, 0, max);
    }

    private static void optionalNumber(JSONObject object, String key, double min, double max, State state, String limitation)
            throws JSONException, Invalid {
        Object value = nullable(object, key);
        if (value == null) state.note(limitation); else number(value, min, max);
    }

    private static Object nullable(JSONObject object, String key) throws JSONException {
        if (!object.has(key)) return null;
        Object value = object.get(key);
        return value == JSONObject.NULL ? null : value;
    }

    private static JSONObject object(Object value) throws Invalid {
        if (!(value instanceof JSONObject)) throw new Invalid("REPORT_TYPE_INVALID");
        return (JSONObject) value;
    }

    private static JSONArray array(Object value) throws Invalid {
        if (!(value instanceof JSONArray)) throw new Invalid("REPORT_TYPE_INVALID");
        return (JSONArray) value;
    }

    private static boolean bool(Object value) throws Invalid {
        if (!(value instanceof Boolean)) throw new Invalid("REPORT_TYPE_INVALID");
        return (Boolean) value;
    }

    private static String text(Object value, int min, int max) throws Invalid {
        if (!(value instanceof String)) throw new Invalid("REPORT_TYPE_INVALID");
        String text = (String) value;
        if (text.length() < min || text.length() > max) throw new Invalid("REPORT_VALUE_INVALID");
        for (int i = 0; i < text.length(); i++)
            if (Character.isISOControl(text.charAt(i))) throw new Invalid("REPORT_VALUE_INVALID");
        return text;
    }

    private static double number(Object value, double min, double max) throws Invalid {
        if (!(value instanceof Number)) throw new Invalid("REPORT_TYPE_INVALID");
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number < min || number > max) throw new Invalid("REPORT_VALUE_INVALID");
        return number;
    }

    private static long integer(Object value, long min, long max) throws Invalid {
        double number = number(value, min, max);
        if (number != Math.rint(number)) throw new Invalid("REPORT_TYPE_INVALID");
        return (long) number;
    }

    private static boolean safeChallenge(String challenge) {
        return challenge != null && challenge.length() <= 128 && challenge.matches("[a-fA-F0-9-]+") &&
                (challenge.matches("[a-fA-F0-9]+") || challenge.matches("[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}"));
    }

    private static String canonicalZone(String id) throws Invalid {
        text(id, 1, 128);
        String canonical = TimeZone.getCanonicalID(id);
        if (canonical == null || "Etc/Unknown".equals(canonical)) throw new Invalid("TIME_ZONE_INVALID");
        return canonical;
    }

    private static String language(Object value) throws Invalid {
        String tag = text(value, 1, 128);
        if (!tag.matches("[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*")) throw new Invalid("LANGUAGE_TAG_INVALID");
        String[] parts = tag.toLowerCase(Locale.ROOT).split("-");
        Set<String> variants = new HashSet<>();
        Set<String> singletons = new HashSet<>();
        boolean extension = false;
        if (!"x".equals(parts[0])) for (int i = 1; i < parts.length; i++) {
            String part = parts[i];
            if ("x".equals(part)) break;
            if (part.length() == 1) {
                extension = true;
                if (!singletons.add(part)) throw new Invalid("LANGUAGE_TAG_INVALID");
            } else if (!extension && part.matches("(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3})") && !variants.add(part))
                throw new Invalid("LANGUAGE_TAG_INVALID");
        }
        try {
            return new Locale.Builder().setLanguageTag(tag).build().toLanguageTag();
        } catch (IllformedLocaleException error) {
            throw new Invalid("LANGUAGE_TAG_INVALID");
        }
    }
}
