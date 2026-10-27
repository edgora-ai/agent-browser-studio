package com.ahoo.abs.android;

import com.ahoo.abs.core.ProxySpec;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.ZoneId;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Explicit user-requested lookup through one HTTP proxy; never a browser-routing proof. */
public final class ProxyGeoProbe {
    private static final String ENDPOINT = "https://ipwho.is/?fields=success,ip,country_code,timezone.id";
    private static final Set<String> COUNTRIES = new HashSet<>(Arrays.asList(Locale.getISOCountries()));

    private ProxyGeoProbe() { }

    public static final class Observation {
        public final String countryCode;
        public final String timeZoneId;
        public final long observedAtMillis;
        public final String source = "ipwho.is via app HTTP proxy client";
        public final String browserRouting = "UNVERIFIED";

        private Observation(String countryCode, String timeZoneId, long observedAtMillis) {
            this.countryCode = countryCode;
            this.timeZoneId = timeZoneId;
            this.observedAtMillis = observedAtMillis;
        }
    }

    public static final class ProbeException extends IOException {
        public final String code;
        ProbeException(String code) { super(code); this.code = code; }
    }

    public static Observation fetch(android.content.Context context, ProxySpec spec) throws ProbeException {
        if (spec.hasCredentials) throw new ProbeException("GEO_AUTH_UNSUPPORTED");
        if (spec.scheme != ProxySpec.Scheme.HTTP) throw new ProbeException("GEO_TRANSPORT_UNSUPPORTED");
        java.net.InetAddress proxyAddress = ProxyHostResolver.resolve(context, spec.host);
        HttpsURLConnection connection = null;
        ScheduledExecutorService deadline = Executors.newSingleThreadScheduledExecutor();
        AtomicBoolean expired = new AtomicBoolean();
        try {
            Proxy proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress(proxyAddress, spec.port));
            connection = (HttpsURLConnection) new URL(ENDPOINT).openConnection(proxy);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(7000);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Accept-Language", "en");
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("User-Agent", "ABS-Android-Development-GeoProbe/1");
            HttpsURLConnection owned = connection;
            deadline.schedule(() -> {
                expired.set(true);
                owned.disconnect();
            }, 15, TimeUnit.SECONDS);
            if (connection.getResponseCode() != 200) throw new ProbeException("GEO_HTTP_NOT_200");
            int length = connection.getContentLength();
            if (length > 32768) throw new ProbeException("GEO_RESPONSE_TOO_LARGE");
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[2048];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (expired.get() || Thread.currentThread().isInterrupted()) throw new ProbeException("GEO_CANCELLED_OR_EXPIRED");
                    if (body.size() + count > 32768) throw new ProbeException("GEO_RESPONSE_TOO_LARGE");
                    body.write(buffer, 0, count);
                }
            }
            if (expired.get()) throw new ProbeException("GEO_CANCELLED_OR_EXPIRED");
            JSONTokener tokener = new JSONTokener(body.toString(StandardCharsets.UTF_8.name()));
            Object value = tokener.nextValue();
            if (!(value instanceof JSONObject) || tokener.nextClean() != 0) throw new ProbeException("GEO_RESPONSE_INVALID");
            return parse((JSONObject) value, System.currentTimeMillis());
        } catch (ProbeException failure) {
            throw failure;
        } catch (IOException | JSONException | IllegalArgumentException failure) {
            throw new ProbeException(expired.get() ? "GEO_CANCELLED_OR_EXPIRED" : "GEO_LOOKUP_FAILED");
        } finally {
            deadline.shutdownNow();
            if (connection != null) connection.disconnect();
        }
    }

    /** Strict parsing is also exercised by the owned Android instrumentation suite. */
    public static Observation parse(JSONObject response, long observedAtMillis) throws ProbeException {
        if (response == null || !Boolean.TRUE.equals(response.opt("success")) || observedAtMillis <= 0) invalid();
        Object country = response.opt("country_code");
        Object timeZone = response.opt("timezone");
        Object ip = response.opt("ip");
        if (!(country instanceof String) || !COUNTRIES.contains(country)
                || !(timeZone instanceof JSONObject) || !(ip instanceof String) || !numericAddress((String) ip)) invalid();
        Object id = ((JSONObject) timeZone).opt("id");
        if (!(id instanceof String) || ((String) id).length() > 128) invalid();
        try {
            String validated = ZoneId.of((String) id).getId();
            return new Observation((String) country, validated, observedAtMillis);
        } catch (java.time.DateTimeException failure) {
            throw new ProbeException("GEO_TIMEZONE_INVALID");
        }
    }

    private static boolean numericAddress(String value) {
        if (value.length() > 64) return false;
        if (value.indexOf(':') >= 0) {
            try {
                return new java.net.URI("https://[" + value + "]/").getHost() != null
                        && value.matches("[0-9a-fA-F:]+(?:\\.[0-9]+)*");
            } catch (java.net.URISyntaxException invalid) {
                return false;
            }
        }
        String[] parts = value.split("\\.", -1);
        if (parts.length != 4) return false;
        for (String part : parts) {
            if (!part.matches("[0-9]{1,3}") || Integer.parseInt(part) > 255) return false;
        }
        return true;
    }

    public static String suggestedLanguage(String countryCode) {
        switch (countryCode) {
            case "US": return "en-US";
            case "GB": return "en-GB";
            case "AU": return "en-AU";
            case "NZ": return "en-NZ";
            case "CA": return "en-CA";
            case "DE": return "de-DE";
            case "FR": return "fr-FR";
            case "ES": return "es-ES";
            case "IT": return "it-IT";
            case "JP": return "ja-JP";
            case "KR": return "ko-KR";
            case "CN": return "zh-CN";
            case "TW": return "zh-TW";
            case "HK": return "zh-HK";
            case "BR": return "pt-BR";
            case "MX": return "es-MX";
            case "NL": return "nl-NL";
            default: return null;
        }
    }

    private static void invalid() throws ProbeException { throw new ProbeException("GEO_RESPONSE_INVALID"); }
}
