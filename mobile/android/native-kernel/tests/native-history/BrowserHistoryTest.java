import com.ahoo.abs.android.nativekernel.BrowserHistory;

import java.util.List;
import java.util.Objects;

/** Pure-JDK regression suite; run with javac -Xlint:all -Werror and java -ea. */
public final class BrowserHistoryTest {
    private static int checks;
    private static int failures;

    private BrowserHistoryTest() { }

    public static void main(String[] args) {
        boolean assertions = false;
        assert assertions = true;
        check(assertions, "assertions enabled");
        canonicalOrigins();
        invalidUrls();
        inputNormalization();
        mergedVisitsAndSaturation();
        titleSanitation();
        rankingRemovalAndCaps();
        persistence();
        corruptPersistenceBounds();
        System.out.println(checks + " checks, " + failures + " failures");
        if (failures != 0) throw new AssertionError("BrowserHistory regressions: " + failures);
    }

    private static void canonicalOrigins() {
        String[][] cases = {
            {"https://user:pass@Example.COM/a/b?q=secret#token", "https://example.com"},
            {" HTTP://EXAMPLE.COM:00080/ ", "http://example.com"},
            {"https://Example.com.:443/", "https://example.com"},
            {"https://example.com:8443/a", "https://example.com:8443"},
            {"http://localhost:65535/", "http://localhost:65535"},
            {"https://bücher.example/书?q=中文", "https://xn--bcher-kva.example"},
            {"https://EXAMPLE\u3002COM/", "https://example.com"},
            {"http://127.0.0.1/a", "http://127.0.0.1"},
            {"https://[2001:0DB8:0000:0:0:0:0:1]:443/a", "https://[2001:db8::1]"},
            {"http://[0:0:0:0:0:0:0:0]:8080/", "http://[::]:8080"},
            {"https://[::1]/", "https://[::1]"},
            {"https://[1:0:0:2:0:0:3:4]/", "https://[1::2:0:0:3:4]"},
            {"https://[::ffff:192.0.2.1]/", "https://[::ffff:c000:201]"},
            {"https://[1:2:3:4:5:6:7:8]/", "https://[1:2:3:4:5:6:7:8]"},
            {"https://user%40name:p%3Ass@example.com/%20?q=%20", "https://example.com"}
        };
        for (String[] entry : cases) {
            equal(BrowserHistory.canonicalOrigin(entry[0]), entry[1], "canonical " + entry[0]);
            check(BrowserHistory.isTrackable(entry[0]), "trackable " + entry[0]);
            equal(BrowserHistory.canonicalOrigin(entry[1]), entry[1], "canonical idempotence");
        }
    }

    private static void invalidUrls() {
        String[] invalid = {
            null, "", " ", "https://", "https:///path", "http:example.com", "https:/example.com",
            "file:///tmp/x", "javascript:alert(1)", "data:text/html,x", "ftp://example.com",
            "about:blank", "chrome://version", "https://a b.com/", "https://a.com/a b",
            "https://a.com/\t", "https://a.com/\n", "\u0000https://a.com/", "https://a.com/\u0085",
            "https://a.com/\\secret", "https://a.com\\@evil.com", "https://a.com/%",
            "https://a.com/%xx", "https://a.com/?bad=%z1", "https://a.com/#%",
            "https://a.com:0", "https://a.com:65536", "https://a.com:-1", "https://a.com:+80",
            "https://a.com:", "https://a.com:abc", "https://a.com:123456", "https://a..com/",
            "https://a.com../", "https://-a.com", "https://a-.com", "https://a_b.com",
            "https://.", "https://@", "https://u@p@a.com", "https://u[ser]@a.com",
            "https://%65xample.com", "https://[not-ip]/", "https://[::1]evil",
            "https://[::1]:", "https://[1:2:3]/", "https://2001:db8::1/",
            "https://[fe80::1%25en0]/", "https://[::ffff:192.000.2.1]/",
            "https://999.1.1.1/", "https://127.1/", "https://0177.0.0.1/",
            "https://2130706433/", "https://0x7f.0.0.1/", "https://a.com/\ud800",
            "https://" + "a".repeat(64) + ".com/", "https://a.com/" + "a".repeat(4096)
        };
        for (String value : invalid) {
            check(BrowserHistory.canonicalOrigin(value) == null, "reject URL " + value);
            check(!BrowserHistory.isTrackable(value), "untrackable URL " + value);
        }
    }

    private static void inputNormalization() {
        String[][] cases = {
            {" example.com ", "https://example.com"},
            {"example.com:8443/a?x=1", "https://example.com:8443/a?x=1"},
            {"localhost:8080", "https://localhost:8080"},
            {"[::1]:8443/a", "https://[::1]:8443/a"},
            {"https://Example.com/x?q=1", "https://Example.com/x?q=1"},
            {"http://localhost:8080", "http://localhost:8080"},
            {" ABOUT:BLANK ", "about:blank"},
            {" \thello\t world\n你好\r\n ", "https://www.bing.com/search?q=hello+world+%E4%BD%A0%E5%A5%BD"},
            {"\u00a0hello\u2003world\u00a0", "https://www.bing.com/search?q=hello+world"},
            {"a+b &c", "https://www.bing.com/search?q=a%2Bb+%26c"},
            {"two words.com", "https://www.bing.com/search?q=two+words.com"}
        };
        for (String[] entry : cases) equal(BrowserHistory.resolveInput(entry[0]), entry[1], "input " + entry[0]);
        String[] rejected = {
            null, "", " \t\r\n", "javascript:alert(1)", "file:///tmp/x", "data:text/html,x",
            "intent://x", "ftp://a.com", "about:blank#x", "https://", "http:example.com",
            "https://a..com", "https://a.com:0", "https://a.com/%zz", "example.com:65536",
            "localhost:abc", "example.com\\@evil.com", "https://a.com/a\tb", "hi\u0000there",
            "javascript:user@example.com", "\ud800", "\udc00", "x".repeat(4097)
        };
        for (String value : rejected) check(BrowserHistory.resolveInput(value) == null, "reject input " + value);
    }

    private static void mergedVisitsAndSaturation() {
        BrowserHistory history = new BrowserHistory();
        check(history.recordVisit("https://a.com/a", "A", 1000), "first visit");
        check(history.recordVisit("https://a.com/b?q=secret", "A2", 2000), "merged mutation must persist");
        BrowserHistory.SiteVisit visit = history.ranked().get(0);
        check(visit.lastVisitMillis == 2000 && visit.visitCount == 1, "merged timestamp only, no count inflation");
        equal(visit.title, "A2", "merged title refreshed");
        check(!history.recordVisit("https://a.com", "A2", 2000), "identical callback is unchanged");
        check(history.recordVisit("https://a.com", "Changed", 2000), "same-time title mutation must persist");
        check(history.recordVisit("https://a.com", "", 2001), "time-only mutation must persist");
        check(!history.recordVisit("https://a.com", null, Long.MIN_VALUE), "clock rollback does not inflate");
        check(visit.lastVisitMillis == 2001 && visit.visitCount == 1, "clock cannot regress");
        check(history.recordVisit("https://a.com", null, 5001), "exact window boundary counts");
        check(visit.visitCount == 2, "second visit count");
        check(!history.recordVisit("file:///x", "X", 9000), "invalid visit unchanged");
        BrowserHistory negative = new BrowserHistory();
        check(negative.recordVisit("https://negative.com", null, Long.MIN_VALUE), "negative timestamp accepted safely");
        check(negative.ranked().get(0).lastVisitMillis == 0, "negative timestamp clamps");
        BrowserHistory saturated = BrowserHistory.deserialize("ABSHISTv1\tp\nt\t0\t9999\thttps://max.com\tMax\n", "p");
        check(saturated.recordVisit("https://max.com", null, Long.MAX_VALUE), "max timestamp persists");
        visit = saturated.ranked().get(0);
        check(visit.visitCount == 9999 && visit.lastVisitMillis == Long.MAX_VALUE, "count and timestamp saturate");
        check(!saturated.recordVisit("https://max.com", null, Long.MIN_VALUE), "overflow-safe old timestamp");
        check(!saturated.recordVisit("https://max.com", "Max", Long.MAX_VALUE), "max duplicate unchanged");
        equal(BrowserHistory.deserialize(saturated.serialize("p"), "p").serialize("p"), saturated.serialize("p"), "max values roundtrip");
    }

    private static void titleSanitation() {
        BrowserHistory history = new BrowserHistory();
        history.recordVisit("https://title.com", " \u00a0A\tB\nC\rD\u0000\u007f\u0085\u00a0 ", 1);
        equal(history.ranked().get(0).title, "ABCD", "trim and strip C0, C1 and DEL");
        check(!history.updateTitle("https://title.com", "\t \u0085"), "empty sanitized title preserves old");
        check(!history.updateTitle("https://unknown.com", "X"), "unknown title update ignored");
        check(history.updateTitle("https://title.com/a", "  Renamed  "), "title update");
        check(history.ranked().get(0).visitCount == 1, "title update leaves count");
        check(!history.updateTitle("https://title.com", "Renamed"), "same title unchanged");
        history.updateTitle("https://title.com", "x".repeat(199) + "😀");
        check(history.ranked().get(0).title.length() == 199, "title cap never splits surrogate pair");
        history.updateTitle("https://title.com", "😀".repeat(150));
        check(history.ranked().get(0).title.length() == 200, "Unicode title capped at 200 UTF-16 chars");
        history.updateTitle("https://title.com", "A\ud800B\udc00C");
        equal(history.ranked().get(0).title, "ABC", "unpaired surrogates stripped");
    }

    private static void rankingRemovalAndCaps() {
        BrowserHistory history = BrowserHistory.deserialize("ABSHISTv1\tp\n"
                + "t\t100\t2\thttps://b.com\tB\n"
                + "t\t100\t2\thttps://a.com\tA\n"
                + "t\t100\t3\thttps://c.com\tC\n"
                + "t\t101\t1\thttps://d.com\tD\n", "p");
        List<BrowserHistory.SiteVisit> ranked = history.ranked();
        equal(ranked.get(0).origin, "https://d.com", "rank by recency");
        equal(ranked.get(1).origin, "https://c.com", "rank count tiebreak");
        equal(ranked.get(2).origin, "https://a.com", "rank lexical tiebreak");
        check(history.removeSite("HTTPS://B.COM:443/path?q=1"), "canonical site removal");
        check(!history.removeSite("https://b.com") && !history.removeSite(null), "absent removal");
        history.clear();
        check(history.size() == 0 && history.ranked().isEmpty(), "clear history");
        for (int i = 0; i < BrowserHistory.MAX_SITES + 20; i++) {
            history.recordVisit("https://s" + i + ".com", "S", i + 1L);
        }
        check(history.size() == 200, "200 live entries cap");
        equal(history.ranked().get(199).origin, "https://s20.com", "oldest retained after cap");
        check(!history.removeSite("https://s0.com"), "oldest evicted");
        check(!history.recordVisit("https://ancient.com", "Ancient", 0), "immediately evicted insert is unchanged");
        check(history.size() == 200, "cap remains after ancient insert");
        StringBuilder rows = new StringBuilder("ABSHISTv1\tp\n");
        for (int i = 999; i >= 0; i--) rows.append("t\t").append(i).append("\t1\thttps://d").append(i).append(".com\tD\n");
        history = BrowserHistory.deserialize(rows.toString(), "p");
        check(history.size() == 200, "deserialize capped throughout ingestion");
        check(history.ranked().get(199).lastVisitMillis == 800, "old tail cannot evict newer history");
        check(BrowserHistory.deserialize(history.serialize("p"), "p").size() == 200, "entire capped history roundtrips");
    }

    private static void persistence() {
        BrowserHistory history = new BrowserHistory();
        String title = "literal \\n \\t \\r \\ end\\";
        String key = "profile\\n\\t\\r\\\tactual\nline\r";
        history.recordVisit("https://user:secret@private.com/secret-path?secret-query#secret-fragment", title, 100);
        String text = history.serialize(key);
        check(!text.contains("user") && !text.contains("secret"), "privacy: credentials, path, query, fragment absent");
        BrowserHistory restored = BrowserHistory.deserialize(text, key);
        check(restored.size() == 1, "escaped-key roundtrip");
        equal(restored.ranked().get(0).title, title, "literal backslash n/t/r and trailing slash roundtrip");
        equal(restored.serialize(key), text, "serialization stable after one decode");
        check(BrowserHistory.deserialize(text, key + "x").size() == 0, "wrong profile empty");
        check(BrowserHistory.deserialize(text, "profile\n\t\r\\\tactual\nline\r").size() == 0, "literal and escaped keys differ");
        check(BrowserHistory.deserialize(null, key).size() == 0, "null storage empty");
        check(BrowserHistory.deserialize("garbage\n", key).size() == 0, "bad header empty");
        check(BrowserHistory.deserialize(new BrowserHistory().serialize(null), null).size() == 0, "empty null-key roundtrip");
        String bad = "ABSHISTv1\tp\nt\t1\t1\thttps://x.com/private?q=secret\t  A\\tB\\nC\\rD\u0085  \n";
        restored = BrowserHistory.deserialize(bad, "p");
        equal(restored.ranked().get(0).title, "ABCD", "loaded titles sanitized after decoding");
        check(!restored.serialize("p").contains("secret"), "loaded origin privacy stripping");
        restored = BrowserHistory.deserialize("ABSHISTv1\tp\nt\t1\t1\thttps://x.com\t" + "x".repeat(500) + "\n", "p");
        check(restored.ranked().get(0).title.length() == 200, "loaded title cap");
    }

    private static void corruptPersistenceBounds() {
        String header = "ABSHISTv1\tp\n";
        String good = "t\t10\t5\thttps://good.com\tGood\n";
        String[] rows = {
            "t\t-1\t1\thttps://bad.com\tBad\n", "t\t9223372036854775808\t1\thttps://bad.com\tBad\n",
            "t\t1\t0\thttps://bad.com\tBad\n", "t\t1\t10000\thttps://bad.com\tBad\n",
            "t\t1\t2147483648\thttps://bad.com\tBad\n", "t\tNaN\t1\thttps://bad.com\tBad\n",
            "t\t1\t1\thttps://bad.com\tbad\\x\n", "t\t1\t1\thttps://bad.com\tbad\\\n",
            "t\t1\t1\thttps://bad.com\ttoo\tmany\n", "t\t1\t1\thttps://bad.com\t" + "x".repeat(9000) + "\n"
        };
        for (String row : rows) {
            BrowserHistory history = BrowserHistory.deserialize(header + row + good, "p");
            check(history.size() == 1, "corrupt row skipped without losing following history");
            equal(history.ranked().get(0).origin, "https://good.com", "valid row survives corruption");
        }
        BrowserHistory duplicate = BrowserHistory.deserialize(header + good + "t\t1\t1\thttps://GOOD.com/path\tOld\n", "p");
        check(duplicate.size() == 1 && duplicate.ranked().get(0).lastVisitMillis == 10
                && duplicate.ranked().get(0).visitCount == 5, "duplicate older rows never regress history");
        equal(duplicate.ranked().get(0).title, "Good", "older duplicate title ignored");
        BrowserHistory bounded = BrowserHistory.deserialize(header + good + "x".repeat(2 * 1024 * 1024), "p");
        check(bounded.size() == 1, "oversized corrupt tail retains real history");
        bounded = BrowserHistory.deserialize(header + good + "bad\n".repeat(100000), "p");
        check(bounded.size() == 1, "corrupt line count bounded while retaining real history");
        check(BrowserHistory.deserialize("ABSHISTv1\t" + "x".repeat(9000) + "\n" + good, "p").size() == 0,
                "oversized header rejected");
        check(BrowserHistory.deserialize("ABSHISTv1\tp\\x\n" + good, "px").size() == 0,
                "malformed key escaping cannot alias another profile");
    }

    private static void equal(Object actual, Object expected, String label) {
        check(Objects.equals(actual, expected), label + " expected=" + expected + " actual=" + actual);
    }

    private static void check(boolean ok, String label) {
        checks++;
        if (!ok) {
            failures++;
            System.out.println("FAIL: " + label);
        }
    }
}
