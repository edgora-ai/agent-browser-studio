package com.ahoo.abs.android.data;

import com.ahoo.abs.core.ProfileSpec;
import com.ahoo.abs.core.ProxySpec;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/** Whitelisted metadata only. No username, password or runtime object is serialized. */
final class ProfileCodec {
    private static final String[] PROFILE_KEYS = {"id", "revision", "name", "proxy",
            "countryCode", "timeZoneId", "languageTags", "deviceMode", "deviceModel",
            "credentialRevision"};
    private static final String[] PROXY_KEYS = {"scheme", "host", "port", "hasCredentials"};

    private ProfileCodec() {}

    static ProfileSpec freeze(ProfileSpec profile) {
        return fromJson(toJson(profile));
    }

    static ProfileSpec withCredentialRevision(ProfileSpec value, String credentialRevision) {
        try {
            return new ProfileSpec(value.id, value.revision, value.name, value.proxy,
                    value.countryCode, value.timeZoneId, new ArrayList<>(value.languageTags),
                    value.deviceMode, value.deviceModel, credentialRevision);
        } catch (RuntimeException exception) {
            throw invalid();
        }
    }

    static String toJson(ProfileSpec value) {
        try {
            validateIdentity(value);
            JSONObject proxy = new JSONObject();
            proxy.put("scheme", value.proxy.scheme.name());
            proxy.put("host", value.proxy.host);
            proxy.put("port", value.proxy.port);
            proxy.put("hasCredentials", value.proxy.hasCredentials);
            JSONArray languages = new JSONArray();
            for (String tag : value.languageTags) languages.put(tag);
            JSONObject json = new JSONObject();
            json.put("id", value.id);
            json.put("revision", value.revision);
            json.put("name", value.name);
            json.put("proxy", proxy);
            json.put("countryCode", value.countryCode);
            json.put("timeZoneId", value.timeZoneId);
            json.put("languageTags", languages);
            json.put("deviceMode", value.deviceMode.name());
            json.put("deviceModel", value.deviceModel);
            json.put("credentialRevision", value.credentialRevision);
            String encoded = json.toString();
            if (encoded.length() > 65536) throw invalid();
            return encoded;
        } catch (JSONException | RuntimeException exception) {
            throw invalid();
        }
    }

    static ProfileSpec fromJson(String encoded) {
        try {
            if (encoded == null || encoded.length() > 65536) throw invalid();
            JSONObject json = new JSONObject(encoded);
            keys(json, PROFILE_KEYS);
            JSONObject proxyJson = json.getJSONObject("proxy");
            keys(proxyJson, PROXY_KEYS);
            Object port = proxyJson.get("port");
            Object authentication = proxyJson.get("hasCredentials");
            if (!(port instanceof Integer) || !(authentication instanceof Boolean)) throw invalid();
            ProxySpec proxy = new ProxySpec(ProxySpec.Scheme.valueOf(text(proxyJson, "scheme")),
                    text(proxyJson, "host"), (Integer) port, (Boolean) authentication);
            JSONArray tags = json.getJSONArray("languageTags");
            List<String> languages = new ArrayList<>();
            if (tags.length() == 0 || tags.length() > 64) throw invalid();
            for (int i = 0; i < tags.length(); i++) {
                Object tag = tags.get(i);
                if (!(tag instanceof String)) throw invalid();
                languages.add((String) tag);
            }
            ProfileSpec profile = new ProfileSpec(text(json, "id"), text(json, "revision"),
                    text(json, "name"), proxy, text(json, "countryCode"), text(json, "timeZoneId"),
                    languages, ProfileSpec.DeviceMode.valueOf(text(json, "deviceMode")),
                    text(json, "deviceModel"), text(json, "credentialRevision"));
            validateIdentity(profile);
            return profile;
        } catch (JSONException | RuntimeException exception) {
            throw invalid();
        }
    }

    private static void validateIdentity(ProfileSpec value) {
        if (value == null || value.proxy == null || value.credentialRevision == null) throw invalid();
        StoreChecks.uuid(value.id);
        StoreChecks.uuid(value.revision);
        if (value.proxy.hasCredentials) StoreChecks.uuid(value.credentialRevision);
        else if (!value.credentialRevision.isEmpty()) throw invalid();
        if (!value.fingerprint().matches("[0-9a-f]{64}")) throw invalid();
        if (!value.dataDirectorySuffix().matches("[a-zA-Z0-9_-]{1,128}")) throw invalid();
    }

    private static String text(JSONObject object, String key) throws JSONException {
        Object value = object.get(key);
        if (!(value instanceof String)) throw invalid();
        return (String) value;
    }

    private static void keys(JSONObject object, String[] expected) throws JSONException {
        if (object.length() != expected.length) throw invalid();
        for (String key : expected) if (!object.has(key)) throw invalid();
        Iterator<String> keys = object.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            boolean allowed = false;
            for (String item : expected) if (item.equals(key)) allowed = true;
            if (!allowed) throw invalid();
        }
    }

    private static StorageException invalid() {
        return new StorageException(StorageException.Code.PROFILE_INVALID);
    }
}
