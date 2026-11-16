package org.json;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
/** Host JSON API double, with Android NULL-versus-missing and insertion-order semantics. */
public final class JSONObject {
    public static final Object NULL = new Object() { @Override public String toString() { return "null"; } };
    final Map<String,Object> values = new LinkedHashMap<>();
    public JSONObject() {}
    public JSONObject(String encoded) throws JSONException {
        Object parsed = new JsonHost(encoded).parse();
        if (!(parsed instanceof JSONObject)) throw new JSONException("Object required");
        values.putAll(((JSONObject) parsed).values);
    }
    public JSONObject put(String key, Object value) throws JSONException {
        if (key == null) throw new JSONException("Null key");
        if (value == null) values.remove(key); else values.put(key, value);
        return this;
    }
    public Object get(String key) throws JSONException {
        if (!has(key)) throw new JSONException("Missing key");
        return values.get(key);
    }
    public JSONArray getJSONArray(String key) throws JSONException {
        Object value = get(key);
        if (!(value instanceof JSONArray)) throw new JSONException("Array required");
        return (JSONArray) value;
    }
    public boolean has(String key) { return values.containsKey(key); }
    public int length() { return values.size(); }
    public Iterator<String> keys() { return values.keySet().iterator(); }
    @Override public String toString() { return JsonHost.encode(values); }
}
