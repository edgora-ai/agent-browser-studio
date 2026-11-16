package org.json;
import java.util.List;
import java.util.Map;
/** Dependency-free strict JSON test parser, not a replacement for Android platform tests. */
final class JsonHost {
    private final String input;
    private int position;
    JsonHost(String input) { this.input = input; }
    Object parse() throws JSONException {
        Object value = value(); whitespace();
        if (position != input.length()) throw invalid();
        return value;
    }
    private void whitespace() { while (position < input.length() && " \r\n\t".indexOf(input.charAt(position)) >= 0) position++; }
    private Object value() throws JSONException {
        whitespace(); if (position >= input.length()) throw invalid();
        char token = input.charAt(position);
        if (token == '"') return string();
        if (token == '{') {
            position++; JSONObject object = new JSONObject(); whitespace();
            if (take('}')) return object;
            do {
                whitespace(); String key = string(); whitespace();
                if (!take(':')) throw invalid();
                object.put(key, value()); whitespace();
                if (take('}')) return object;
            } while (take(','));
            throw invalid();
        }
        if (token == '[') {
            position++; JSONArray array = new JSONArray(); whitespace();
            if (take(']')) return array;
            do { array.put(value()); whitespace(); if (take(']')) return array; } while (take(','));
            throw invalid();
        }
        for (String literal : new String[]{"true", "false", "null"}) {
            if (input.startsWith(literal, position)) {
                position += literal.length();
                return literal.equals("null") ? JSONObject.NULL : Boolean.valueOf(literal);
            }
        }
        int start = position;
        while (position < input.length() && "-+0123456789.eE".indexOf(input.charAt(position)) >= 0) position++;
        String number = input.substring(start, position);
        if (!number.matches("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")) throw invalid();
        try {
            if (number.indexOf('.') >= 0 || number.indexOf('e') >= 0 || number.indexOf('E') >= 0) return Double.valueOf(number);
            long parsed = Long.parseLong(number);
            if (parsed >= Integer.MIN_VALUE && parsed <= Integer.MAX_VALUE) return Integer.valueOf((int) parsed);
            return Long.valueOf(parsed);
        } catch (NumberFormatException exception) { throw invalid(); }
    }
    private String string() throws JSONException {
        if (!take('"')) throw invalid();
        StringBuilder result = new StringBuilder();
        while (position < input.length()) {
            char next = input.charAt(position++);
            if (next == '"') return result.toString();
            if (next < 32) throw invalid();
            if (next != '\\') { result.append(next); continue; }
            if (position >= input.length()) throw invalid();
            char escape = input.charAt(position++);
            switch (escape) {
                case '"': case '\\': case '/': result.append(escape); break;
                case 'b': result.append('\b'); break;
                case 'f': result.append('\f'); break;
                case 'n': result.append('\n'); break;
                case 'r': result.append('\r'); break;
                case 't': result.append('\t'); break;
                case 'u':
                    if (position + 4 > input.length()) throw invalid();
                    try { result.append((char) Integer.parseInt(input.substring(position, position + 4), 16)); }
                    catch (NumberFormatException exception) { throw invalid(); }
                    position += 4; break;
                default: throw invalid();
            }
        }
        throw invalid();
    }
    private boolean take(char value) {
        if (position >= input.length() || input.charAt(position) != value) return false;
        position++; return true;
    }
    private static JSONException invalid() { return new JSONException("Malformed JSON"); }
    static String encode(Object value) {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof String) {
            StringBuilder result = new StringBuilder("\"");
            for (char token : ((String) value).toCharArray()) {
                if (token == '"' || token == '\\') result.append('\\').append(token);
                else if (token < 32) result.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) token));
                else result.append(token);
            }
            return result.append('"').toString();
        }
        if (value instanceof JSONObject) return encode(((JSONObject) value).values);
        if (value instanceof JSONArray) return encode(((JSONArray) value).values);
        if (value instanceof Map<?,?>) {
            StringBuilder result = new StringBuilder("{");
            for (Map.Entry<?,?> entry : ((Map<?,?>) value).entrySet()) {
                if (result.length() > 1) result.append(',');
                result.append(encode(entry.getKey())).append(':').append(encode(entry.getValue()));
            }
            return result.append('}').toString();
        }
        if (value instanceof List<?>) {
            StringBuilder result = new StringBuilder("[");
            for (Object item : (List<?>) value) { if (result.length() > 1) result.append(','); result.append(encode(item)); }
            return result.append(']').toString();
        }
        return value.toString();
    }
}
