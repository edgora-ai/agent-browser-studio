package org.json;
import java.util.ArrayList;
import java.util.List;
public final class JSONArray {
    final List<Object> values = new ArrayList<>();
    public JSONArray put(Object value) { values.add(value == null ? JSONObject.NULL : value); return this; }
    public int length() { return values.size(); }
    public Object get(int index) throws JSONException {
        if (index < 0 || index >= values.size()) throw new JSONException("Array index");
        return values.get(index);
    }
    @Override public String toString() { return JsonHost.encode(values); }
}
