import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.Tree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.Trees;
import java.io.StringWriter;
import java.lang.reflect.InvocationTargetException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

/**
 * Compiles COMPLETE actual NewTabPage and verbatim actual FontBindings/PaletteBindings.
 * Synthetic framework substitutes model finite-width weighted measurement, wrapping, line ranges,
 * margins, padding, minimums, GONE and upward height propagation. NOT Android text shaping,
 * nonlinear font conversion, native rendering, device, lifecycle or visual acceptance evidence.
 * --fixture-control changes only the in-memory metadata singleLine argument while production is
 * frozen; it is explicitly NOT genuine product-fix evidence. Default mode uses unchanged source.
 * Both modes retain rejection of old-singleline, zero-height and no-op mutations, plus short-hint,
 * full-label and separate-header sensitivity controls. Hint/contentDescription are STORED values;
 * the host does not render hints, execute toolbar buildChrome, or prove TalkBack/click/IME behavior.
 */
public final class NativeNewTabTileHostTest {
    private NativeNewTabTileHostTest() { }

    private static String sha(String text) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(text.getBytes(StandardCharsets.UTF_8)));
    }

    private static String bindings(JavaCompiler compiler, Path path) throws Exception {
        String original = Files.readString(path);
        Map<String, String> found = new LinkedHashMap<>();
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, null,
                    List.of("-proc:none", "--release", "17"), null, files.getJavaFileObjects(path));
            for (CompilationUnitTree unit : task.parse()) {
                var positions = Trees.instance(task).getSourcePositions();
                for (Tree top : unit.getTypeDecls()) {
                    if (!(top instanceof ClassTree type)) continue;
                    for (Tree member : type.getMembers()) {
                        if (!(member instanceof ClassTree nested)) continue;
                        String name = nested.getSimpleName().toString();
                        if (!name.equals("FontBindings") && !name.equals("PaletteBindings")) continue;
                        int start = Math.toIntExact(positions.getStartPosition(unit, member));
                        int end = Math.toIntExact(positions.getEndPosition(unit, member));
                        if (found.put(name, original.substring(start, end)) != null) throw new AssertionError("Ambiguous binding " + name);
                    }
                }
            }
        }
        if (found.size() != 2) throw new AssertionError("Missing actual production binding classes");
        return found.get("PaletteBindings") + "\n" + found.get("FontBindings");
    }

    private static String metadataMode(String source, boolean single) {
        String old = "meta.setSingleLine(true);", fixed = "meta.setSingleLine(false);";
        int count = (source.length() - source.replace(old, "").length()) / old.length()
                + (source.length() - source.replace(fixed, "").length()) / fixed.length();
        if (count != 1) throw new AssertionError("Expected exactly one actual metadata singleLine call");
        return source.replace(old, single ? old : fixed).replace(fixed, single ? old : fixed);
    }

    private static String replaceOnce(String source, String from, String to) {
        int at = source.indexOf(from);
        if (at < 0 || source.indexOf(from, at + from.length()) >= 0) {
            throw new AssertionError("Expected one unambiguous sensitivity mutation: " + from);
        }
        return source.substring(0, at) + to + source.substring(at + from.length());
    }

    private static String oldHeader(String source) {
        return replaceOnce(source, """
                    header.addView(row, new LinearLayout.LayoutParams(-1, -2));
                    LinearLayout.LayoutParams historyLayout = new LinearLayout.LayoutParams(-2, -2);
                    historyLayout.setMargins(0, dp(8), 0, 0);
                    header.addView(historyButton, historyLayout);
                    return header;
            """, """
                    row.addView(historyButton, new LinearLayout.LayoutParams(-2, -2));
                    return row;
            """);
    }

    private record Result(int checks, Throwable failure) { }

    private static Result run(JavaCompiler compiler, Path output, String ntp, String history,
            String actualBindings, boolean zeroHeight, boolean noFontRebind) throws Exception {
        if (Files.exists(output)) throw new AssertionError("Output must be unique: " + output);
        Files.createDirectories(output);
        Map<String, String> units = new LinkedHashMap<>(FIXTURES);
        units.put("com/ahoo/abs/android/nativekernel/NewTabPage", ntp);
        units.put("com/ahoo/abs/android/nativekernel/BrowserHistory", history);
        units.put("com/ahoo/abs/android/nativekernel/NativeBrowserActivity", ACTIVITY.replace("@BINDINGS@", actualBindings));
        units.put("com/ahoo/abs/android/nativekernel/NtpTileOracle", ORACLE);
        units.put("android/widget/TextView", TEXT_VIEW.replace("@ZERO_HEIGHT@", String.valueOf(zeroHeight)));
        if (noFontRebind) {
            String needle = "tileFonts.apply();";
            if (ntp.indexOf(needle) < 0 || ntp.indexOf(needle) != ntp.lastIndexOf(needle)) throw new AssertionError("Ambiguous real tile font rebind");
            units.put("com/ahoo/abs/android/nativekernel/NewTabPage", ntp.replace(needle, "/* MUTATION: no-op tile font rebind */"));
        }
        List<Path> sources = new ArrayList<>();
        for (var unit : units.entrySet()) {
            Path file = output.resolve("src").resolve(unit.getKey() + ".java");
            Files.createDirectories(file.getParent());
            Files.writeString(file, unit.getValue()); sources.add(file);
        }
        Path classes = output.resolve("classes");
        Files.createDirectories(classes);
        StringWriter diagnostics = new StringWriter();
        List<String> options = List.of("--release", "17", "-Xlint:all", "-Werror", "-proc:none", "-d", classes.toString());
        Files.writeString(output.resolve("compile-command.txt"), "JavaCompiler API (javac) " + String.join(" ", options)
                + "\n" + String.join("\n", sources.stream().map(Path::toString).toList()) + "\n");
        boolean compiled;
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            compiled = compiler.getTask(diagnostics, files, null,
                    options,
                    null, files.getJavaFileObjectsFromPaths(sources)).call();
        }
        Files.writeString(output.resolve("compile.log"), diagnostics.toString());
        if (!compiled) throw new AssertionError("Actual full NTP fixture compilation failed; " + output.resolve("compile.log"));
        try (URLClassLoader loader = new URLClassLoader(new URL[]{classes.toUri().toURL()}, ClassLoader.getPlatformClassLoader())) {
            try {
                int checks = (Integer) loader.loadClass("com.ahoo.abs.android.nativekernel.NtpTileOracle")
                        .getMethod("run", String.class).invoke(null, output.resolve("geometry.tsv").toString());
                Files.writeString(output.resolve("result.txt"), "PASS " + checks + " synthetic host assertions\n");
                return new Result(checks, null);
            } catch (InvocationTargetException failed) {
                Throwable cause = failed.getCause();
                StringWriter trace = new StringWriter(); cause.printStackTrace(new java.io.PrintWriter(trace));
                Files.writeString(output.resolve("result.txt"), trace.toString());
                return new Result(0, cause);
            }
        }
    }

    private static void rejected(String label, Result result, String reason) {
        if (!(result.failure instanceof AssertionError) || !result.failure.getMessage().contains(reason)) {
            throw new AssertionError("Sensitivity control " + label + " failed to reject for " + reason, result.failure);
        }
        System.out.println("EXPECTED_REJECTION " + label + ": " + result.failure.getMessage());
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2 || args.length > 3 || (args.length == 3 && !args[2].equals("--fixture-control"))) throw new IllegalArgumentException("ROOT UNIQUE_OUTPUT [--fixture-control]");
        Path root = Path.of(args[0]).toRealPath(), output = Path.of(args[1]).toRealPath();
        Path allowed = root.resolve(".tmp-apk/proxy-fix-work/v13j-font-tests").toRealPath();
        if (!output.startsWith(allowed) || output.equals(allowed)) throw new AssertionError("Output outside task61 scope");
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null || Runtime.version().feature() != 17) throw new AssertionError("JDK17 required");
        Path source = root.resolve("mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel");
        String original = Files.readString(source.resolve("NewTabPage.java"));
        String history = Files.readString(source.resolve("BrowserHistory.java"));
        String realBindings = bindings(compiler, source.resolve("NativeBrowserActivity.java"));
        boolean control = args.length == 3;
        String tested = control ? metadataMode(original, false) : original;
        Files.writeString(output.resolve("source-receipt.txt"),
                "mode=" + (control ? "IN_MEMORY_FALSE_FIXTURE_CONTROL_NOT_PRODUCT_EVIDENCE" : "ACTUAL_UNMODIFIED_SOURCE")
                + "\nactualNewTabPageSHA256=" + sha(original) + "\ntestedNewTabPageSHA256=" + sha(tested)
                + "\nverbatimBindingsSHA256=" + sha(realBindings) + "\n");
        System.out.println("MODE " + (control ? "IN_MEMORY_FALSE_FIXTURE_CONTROL_NOT_PRODUCT_EVIDENCE" : "ACTUAL_UNMODIFIED_SOURCE"));
        System.out.println("ACTUAL_NTP_SHA256 " + sha(original));
        System.out.println("TESTED_NTP_SHA256 " + sha(tested));
        Result positive = run(compiler, output.resolve("positive"), tested, history, realBindings, false, false);
        rejected("old-metadata-singleline", run(compiler, output.resolve("old-singleline"), metadataMode(tested, true), history, realBindings, false, false), "META_VISIBLE");
        rejected("zero-text-height", run(compiler, output.resolve("zero-height"), tested, history, realBindings, true, false), "TEXT_NONZERO");
        rejected("no-op-tile-font-rebind", run(compiler, output.resolve("noop-rebind"), tested, history, realBindings, false, true), "FONT_SP");
        rejected("old-long-search-hint", run(compiler, output.resolve("old-search-hint"),
                replaceOnce(tested, "search.setHint(\"搜索\");", "search.setHint(\"搜索或输入网址\");"),
                history, realBindings, false, false), "SEARCH_HINT");
        rejected("missing-search-label", run(compiler, output.resolve("missing-search-label"),
                replaceOnce(tested, "search.setContentDescription(\"搜索或输入网址\");", "/* MUTATION: missing accessible label */"),
                history, realBindings, false, false), "SEARCH_LABEL");
        rejected("old-shared-horizontal-header", run(compiler, output.resolve("old-shared-header"),
                oldHeader(tested), history, realBindings, false, false), "HEADER_TREE");
        if (positive.failure != null) throw new AssertionError("Genuine/control main geometry oracle FAILED", positive.failure);
        if (!Files.readString(source.resolve("NewTabPage.java")).equals(original)) throw new AssertionError("Production source changed during run: unstable receipt");
        System.out.println("PASS " + positive.checks + " geometry/state assertions; 90 cases / 450 constrained layout states; 18 empty-editor cases / 90 additional states; 6 mutations rejected");
        System.out.println("EVIDENCE_LIMIT synthetic JDK host only; hints/labels are stored, not rendered; toolbar buildChrome not executed; no Android shaping/conversion/rendering/device/visual/TalkBack/click/IME claim");
    }

    private static final String ACTIVITY = """
        package com.ahoo.abs.android.nativekernel;
        import java.util.ArrayList;
        import java.util.List;
        import android.widget.TextView;
        final class NativeBrowserActivity {
            static int C_CANVAS, C_TILE_TOP, C_SURFACE, C_INK, C_MUTED, C_ACCENT, C_ACCENT_SOFT, C_STROKE, C_RIPPLE;
            @BINDINGS@
        }
        """;

    private static final Map<String, String> FIXTURES = Map.ofEntries(
        Map.entry("android/util/DisplayMetrics", "package android.util; public final class DisplayMetrics { public float density = 1; }"),
        Map.entry("android/util/TypedValue", "package android.util; public final class TypedValue { public static final int COMPLEX_UNIT_SP = 2; }"),
        Map.entry("android/content/res/Configuration", "package android.content.res; public final class Configuration { public float fontScale = 1; }"),
        Map.entry("android/content/res/Resources", """
            package android.content.res;
            public final class Resources {
                private final android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
                private final Configuration config = new Configuration();
                public android.util.DisplayMetrics getDisplayMetrics() { return metrics; }
                public Configuration getConfiguration() { return config; }
            }
            """),
        Map.entry("android/content/Context", """
            package android.content;
            public class Context {
                private final android.content.res.Resources resources = new android.content.res.Resources();
                public android.view.View focused;
                public android.content.res.Resources getResources() { return resources; }
                public Object getSystemService(String name) { return null; }
            }
            """),
        Map.entry("android/content/DialogInterface", "package android.content; public interface DialogInterface { interface OnDismissListener { void onDismiss(DialogInterface dialog); } }"),
        Map.entry("android/content/res/ColorStateList", "package android.content.res; public final class ColorStateList { public static ColorStateList valueOf(int color) { return new ColorStateList(); } }"),
        Map.entry("android/app/Activity", "package android.app; public class Activity extends android.content.Context { public static final String INPUT_METHOD_SERVICE = \"input_method\"; }"),
        Map.entry("android/app/Dialog", """
            package android.app;
            public class Dialog implements android.content.DialogInterface {
                public void dismiss() { throw new AssertionError("Unexpected dialog action"); }
                public void setOnDismissListener(android.content.DialogInterface.OnDismissListener listener) { }
            }
            """),
        Map.entry("android/graphics/Color", "package android.graphics; public final class Color { private Color() { } }"),
        Map.entry("android/graphics/Typeface", "package android.graphics; public final class Typeface { public static final int NORMAL = 0; public static final Typeface DEFAULT_BOLD = new Typeface(); public static Typeface create(String family, int style) { return new Typeface(); } }"),
        Map.entry("android/graphics/drawable/GradientDrawable", """
            package android.graphics.drawable;
            public class GradientDrawable {
                public static final int OVAL = 1, RECTANGLE = 0;
                public enum Orientation { TOP_BOTTOM }
                public void setOrientation(Orientation value) { }
                public void setColors(int[] colors) { }
                public void setColor(int color) { }
                public void setStroke(int width, int color) { }
                public void setCornerRadius(float radius) { }
                public void setShape(int shape) { }
            }
            """),
        Map.entry("android/graphics/drawable/RippleDrawable", """
            package android.graphics.drawable;
            public final class RippleDrawable {
                public RippleDrawable(android.content.res.ColorStateList colors, Object content, Object mask) { }
                public void setColor(android.content.res.ColorStateList colors) { }
            }
            """),
        Map.entry("android/view/Gravity", "package android.view; public final class Gravity { public static final int CENTER_HORIZONTAL = 1, CENTER_VERTICAL = 16, CENTER = 17; }"),
        Map.entry("android/view/HapticFeedbackConstants", "package android.view; public final class HapticFeedbackConstants { public static final int KEYBOARD_TAP = 3; }"),
        Map.entry("android/view/KeyEvent", "package android.view; public final class KeyEvent { public static final int KEYCODE_ENTER = 66; public int getKeyCode() { return 0; } }"),
        Map.entry("android/view/inputmethod/EditorInfo", "package android.view.inputmethod; public final class EditorInfo { public static final int IME_ACTION_GO = 2; }"),
        Map.entry("android/view/inputmethod/InputMethodManager", "package android.view.inputmethod; public final class InputMethodManager { public void hideSoftInputFromWindow(Object token, int flags) { throw new AssertionError(\"Unexpected keyboard action\"); } }"),
        Map.entry("android/text/TextUtils", "package android.text; public final class TextUtils { public enum TruncateAt { END } }"),
        Map.entry("android/text/InputType", "package android.text; public final class InputType { public static final int TYPE_CLASS_TEXT = 1, TYPE_TEXT_VARIATION_URI = 16; }"),
        Map.entry("android/view/View", NativeNewTabTileHostTest.VIEW),
        Map.entry("android/view/ViewGroup", NativeNewTabTileHostTest.VIEW_GROUP),
        Map.entry("android/widget/LinearLayout", NativeNewTabTileHostTest.LINEAR_LAYOUT),
        Map.entry("android/widget/FrameLayout", NativeNewTabTileHostTest.FRAME_LAYOUT),
        Map.entry("android/widget/ScrollView", NativeNewTabTileHostTest.SCROLL_VIEW),
        Map.entry("android/widget/EditText", """
            package android.widget;
            public final class EditText extends TextView {
                private int start, end;
                private CharSequence hint;
                public EditText(android.content.Context context) { super(context); }
                public void setSelection(int first, int last) {
                    if (first < 0 || last < first || last > getText().length()) throw new AssertionError("Invalid selection");
                    start = first; end = last;
                }
                public int getSelectionStart() { return start; }
                public int getSelectionEnd() { return end; }
                public void setHint(CharSequence value) { hint = value; requestLayout(); }
                public CharSequence getHint() { return hint; }
                // Stored API only: this fixture deliberately does not render or measure the hint.
                public void setHintTextColor(int color) { }
                public void setImeOptions(int options) { }
                public void setInputType(int type) { }
                public void setOnEditorActionListener(OnEditorActionListener listener) { }
                public interface OnEditorActionListener { boolean onEditorAction(TextView view, int action, android.view.KeyEvent event); }
            }
            """),
        Map.entry("android/widget/Toast", "package android.widget; public final class Toast { public static final int LENGTH_SHORT = 0; public static Toast makeText(android.content.Context context, String text, int duration) { throw new AssertionError(\"Unexpected toast\"); } public void show() { } }"),
        Map.entry("com/ahoo/abs/android/nativekernel/BrowserHistoryStore", """
            package com.ahoo.abs.android.nativekernel;
            import java.util.List;
            final class BrowserHistoryStore {
                final List<BrowserHistory.SiteVisit> visits;
                int rankedCalls;
                BrowserHistoryStore(List<BrowserHistory.SiteVisit> visits) { this.visits = visits; }
                public List<BrowserHistory.SiteVisit> ranked() { rankedCalls++; return List.copyOf(visits); }
                public boolean removeSite(String origin) { throw new AssertionError("Unexpected history mutation"); }
            }
            """),
        Map.entry("com/ahoo/abs/android/nativekernel/BrowserDialogs", """
            package com.ahoo.abs.android.nativekernel;
            final class BrowserDialogs {
                static void applyPalette(android.app.Dialog dialog) { throw new AssertionError("Unexpected dialog"); }
                static void applyFontScale(android.app.Dialog dialog) { throw new AssertionError("Unexpected dialog"); }
                static android.app.Dialog confirm(android.content.Context context, String title, String body, String action, Runnable callback) { throw new AssertionError("Unexpected dialog"); }
            }
            """)
    );

    private static final String VIEW = """
        package android.view;
        public class View {
            public static final int VISIBLE = 0, INVISIBLE = 4, GONE = 8, FOCUS_BEFORE_DESCENDANTS = 131072;
            private final android.content.Context context;
            private ViewGroup parent;
            private ViewGroup.LayoutParams params;
            private CharSequence contentDescription;
            private int visibility, width, height, left, top, right, bottom, minWidth, minHeight;
            private int pl, pt, pr, pb;
            public int layoutRequests, measures;
            public View(android.content.Context context) { this.context = context; }
            public android.content.Context getContext() { return context; }
            public android.content.res.Resources getResources() { return context.getResources(); }
            public ViewGroup getParent() { return parent; }
            final void attach(ViewGroup value) { if (parent != null && value != null) throw new AssertionError("Already parented"); parent = value; }
            public void setLayoutParams(ViewGroup.LayoutParams value) { params = value; requestLayout(); }
            public ViewGroup.LayoutParams getLayoutParams() { return params; }
            public void setContentDescription(CharSequence value) { contentDescription = value; }
            public CharSequence getContentDescription() { return contentDescription; }
            public void requestLayout() { layoutRequests++; if (parent != null) parent.requestLayout(); }
            public void setPadding(int l, int t, int r, int b) { pl = l; pt = t; pr = r; pb = b; requestLayout(); }
            public int getPaddingLeft() { return pl; }
            public int getPaddingRight() { return pr; }
            public int getPaddingTop() { return pt; }
            public int getPaddingBottom() { return pb; }
            public void setMinimumWidth(int value) { minWidth = value; requestLayout(); }
            public void setMinimumHeight(int value) { minHeight = value; requestLayout(); }
            public int getMinimumWidth() { return minWidth; }
            public int getMinimumHeight() { return minHeight; }
            public void setVisibility(int value) { visibility = value; requestLayout(); }
            public int getVisibility() { return visibility; }
            public static final class MeasureSpec {
                public static final int UNSPECIFIED = 0, EXACTLY = 1073741824, AT_MOST = -2147483648;
                public static int makeMeasureSpec(int size, int mode) { if (size < 0 || size > 0x3fffffff) throw new AssertionError("Non-finite size"); return size | mode; }
                public static int getSize(int spec) { return spec & 0x3fffffff; }
                public static int getMode(int spec) { return spec & 0xc0000000; }
            }
            public static int resolveSize(int desired, int spec) {
                if (MeasureSpec.getMode(spec) == MeasureSpec.EXACTLY) return MeasureSpec.getSize(spec);
                return MeasureSpec.getMode(spec) == MeasureSpec.AT_MOST ? Math.min(desired, MeasureSpec.getSize(spec)) : desired;
            }
            public final void measure(int w, int h) {
                measures++;
                if (visibility == GONE) { setMeasuredDimension(0, 0); return; }
                onMeasure(w, h);
                if (width < 0 || height < 0 || width > 100000 || height > 100000) throw new AssertionError("Non-finite measurement");
            }
            protected void onMeasure(int w, int h) { setMeasuredDimension(resolveSize(Math.max(minWidth, pl + pr), w), resolveSize(Math.max(minHeight, pt + pb), h)); }
            protected final void setMeasuredDimension(int w, int h) { width = w; height = h; }
            public int getMeasuredWidth() { return width; }
            public int getMeasuredHeight() { return height; }
            public final void layout(int l, int t, int r, int b) { left = l; top = t; right = r; bottom = b; onLayout(); }
            protected void onLayout() { }
            public int getLeft() { return left; }
            public int getTop() { return top; }
            public int getRight() { return right; }
            public int getBottom() { return bottom; }
            public int getWidth() { return right - left; }
            public int getHeight() { return bottom - top; }
            public boolean requestFocus() { context.focused = this; return true; }
            public boolean hasFocus() { return context.focused == this; }
            public void clearFocus() { if (context.focused == this) context.focused = null; }
            public void setBackground(Object drawable) { }
            public void setForeground(Object drawable) { }
            public void setElevation(float value) { }
            public void setClickable(boolean value) { }
            public void setDescendantFocusability(int value) { }
            public void setFocusableInTouchMode(boolean value) { }
            public void setEnabled(boolean value) { }
            public void setOnClickListener(OnClickListener listener) { }
            public void setOnLongClickListener(OnLongClickListener listener) { }
            public boolean performHapticFeedback(int value) { throw new AssertionError("Unexpected action"); }
            public Object getWindowToken() { return this; }
            public interface OnClickListener { void onClick(View view); }
            public interface OnLongClickListener { boolean onLongClick(View view); }
        }
        """;

    private static final String VIEW_GROUP = """
        package android.view;
        public class ViewGroup extends View {
            protected final java.util.List<View> children = new java.util.ArrayList<>();
            public ViewGroup(android.content.Context context) { super(context); }
            public static class LayoutParams {
                public static final int MATCH_PARENT = -1, WRAP_CONTENT = -2;
                public int width, height;
                public LayoutParams(int w, int h) { width = w; height = h; }
            }
            public static class MarginLayoutParams extends LayoutParams {
                public int leftMargin, topMargin, rightMargin, bottomMargin;
                public MarginLayoutParams(int w, int h) { super(w, h); }
                public void setMargins(int l, int t, int r, int b) { leftMargin = l; topMargin = t; rightMargin = r; bottomMargin = b; }
            }
            protected LayoutParams generateDefaultLayoutParams() { return new LayoutParams(-1, -2); }
            public void addView(View child) { addView(child, child.getLayoutParams() == null ? generateDefaultLayoutParams() : child.getLayoutParams()); }
            public void addView(View child, LayoutParams params) { child.setLayoutParams(params); child.attach(this); children.add(child); requestLayout(); }
            public void removeAllViews() { for (View child : children) child.attach(null); children.clear(); requestLayout(); }
            public int getChildCount() { return children.size(); }
            public View getChildAt(int index) { return children.get(index); }
            public static MarginLayoutParams margins(View view) {
                LayoutParams params = view.getLayoutParams();
                if (params instanceof MarginLayoutParams margin) return margin;
                return new MarginLayoutParams(params.width, params.height);
            }
            public static int childSpec(int parentSpec, int consumed, int dimension) {
                if (dimension >= 0) return MeasureSpec.makeMeasureSpec(dimension, MeasureSpec.EXACTLY);
                int mode = MeasureSpec.getMode(parentSpec);
                if (mode == MeasureSpec.UNSPECIFIED) return MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED);
                int available = Math.max(0, MeasureSpec.getSize(parentSpec) - consumed);
                return MeasureSpec.makeMeasureSpec(available, dimension == -1 ? MeasureSpec.EXACTLY : MeasureSpec.AT_MOST);
            }
            protected void gone(View view) { view.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.EXACTLY)); view.layout(0, 0, 0, 0); }
        }
        """;

    private static final String LINEAR_LAYOUT = """
        package android.widget;
        import android.view.View;
        import android.view.ViewGroup;
        public class LinearLayout extends ViewGroup {
            public static final int HORIZONTAL = 0, VERTICAL = 1;
            private int orientation, gravity;
            public int naturalHeight;
            public LinearLayout(android.content.Context context) { super(context); }
            public void setOrientation(int value) { orientation = value; requestLayout(); }
            public int getOrientation() { return orientation; }
            public void setGravity(int value) { gravity = value; requestLayout(); }
            public static class LayoutParams extends MarginLayoutParams {
                public float weight;
                public LayoutParams(int w, int h) { super(w, h); }
                public LayoutParams(int w, int h, float weight) { super(w, h); this.weight = weight; }
            }
            @Override protected ViewGroup.LayoutParams generateDefaultLayoutParams() { return new LayoutParams(-1, -2); }
            @Override protected void onMeasure(int width, int height) {
                int hp = getPaddingLeft() + getPaddingRight(), vp = getPaddingTop() + getPaddingBottom();
                int usedWidth = hp, usedHeight = vp, maxWidth = 0, maxHeight = 0;
                float totalWeight = 0;
                for (View child : children) {
                    if (child.getVisibility() == GONE) { gone(child); continue; }
                    LayoutParams lp = (LayoutParams) child.getLayoutParams();
                    if (orientation == HORIZONTAL && lp.width == 0 && lp.weight > 0) {
                        totalWeight += lp.weight; usedWidth += lp.leftMargin + lp.rightMargin; continue;
                    }
                    int consumed = (orientation == HORIZONTAL ? usedWidth : hp) + lp.leftMargin + lp.rightMargin;
                    child.measure(childSpec(width, consumed, lp.width), childSpec(height, vp + lp.topMargin + lp.bottomMargin, lp.height));
                    usedWidth += child.getMeasuredWidth() + lp.leftMargin + lp.rightMargin;
                    usedHeight += child.getMeasuredHeight() + lp.topMargin + lp.bottomMargin;
                    maxWidth = Math.max(maxWidth, child.getMeasuredWidth() + lp.leftMargin + lp.rightMargin);
                    maxHeight = Math.max(maxHeight, child.getMeasuredHeight() + lp.topMargin + lp.bottomMargin);
                }
                if (orientation == HORIZONTAL && totalWeight > 0) {
                    if (MeasureSpec.getMode(width) == MeasureSpec.UNSPECIFIED) throw new AssertionError("Weighted measurement needs finite width");
                    int remaining = Math.max(0, MeasureSpec.getSize(width) - usedWidth);
                    for (View child : children) {
                        if (child.getVisibility() == GONE) continue;
                        LayoutParams lp = (LayoutParams) child.getLayoutParams();
                        if (lp.width != 0 || lp.weight <= 0) continue;
                        int share = Math.round(remaining * lp.weight / totalWeight);
                        remaining -= share; totalWeight -= lp.weight;
                        child.measure(MeasureSpec.makeMeasureSpec(share, MeasureSpec.EXACTLY), childSpec(height, vp + lp.topMargin + lp.bottomMargin, lp.height));
                        usedWidth += child.getMeasuredWidth();
                        maxHeight = Math.max(maxHeight, child.getMeasuredHeight() + lp.topMargin + lp.bottomMargin);
                    }
                }
                naturalHeight = Math.max(getMinimumHeight(), orientation == VERTICAL ? usedHeight : maxHeight + vp);
                int naturalWidth = Math.max(getMinimumWidth(), orientation == HORIZONTAL ? usedWidth : maxWidth + hp);
                setMeasuredDimension(resolveSize(naturalWidth, width), resolveSize(naturalHeight, height));
            }
            @Override protected void onLayout() {
                int cursor = orientation == VERTICAL ? getPaddingTop() : getPaddingLeft();
                for (View child : children) {
                    if (child.getVisibility() == GONE) continue;
                    LayoutParams lp = (LayoutParams) child.getLayoutParams();
                    int x = getPaddingLeft() + lp.leftMargin, y = getPaddingTop() + lp.topMargin;
                    if (orientation == VERTICAL) {
                        cursor += lp.topMargin; y = cursor;
                        int free = getWidth() - getPaddingLeft() - getPaddingRight() - lp.leftMargin - lp.rightMargin - child.getMeasuredWidth();
                        if ((gravity & 7) == 1) x += Math.max(0, free / 2);
                        cursor += child.getMeasuredHeight() + lp.bottomMargin;
                    } else {
                        cursor += lp.leftMargin; x = cursor;
                        int free = getHeight() - getPaddingTop() - getPaddingBottom() - lp.topMargin - lp.bottomMargin - child.getMeasuredHeight();
                        if ((gravity & 112) == 16) y += Math.max(0, free / 2);
                        cursor += child.getMeasuredWidth() + lp.rightMargin;
                    }
                    child.layout(x, y, x + child.getMeasuredWidth(), y + child.getMeasuredHeight());
                }
            }
        }
        """;

    private static final String FRAME_LAYOUT = """
        package android.widget;
        import android.view.View;
        import android.view.ViewGroup;
        public class FrameLayout extends ViewGroup {
            public FrameLayout(android.content.Context context) { super(context); }
            public static class LayoutParams extends MarginLayoutParams { public LayoutParams(int w, int h) { super(w, h); } }
            @Override protected ViewGroup.LayoutParams generateDefaultLayoutParams() { return new LayoutParams(-1, -1); }
            @Override protected void onMeasure(int w, int h) {
                int maxW = 0, maxH = 0;
                for (View child : children) {
                    if (child.getVisibility() == GONE) { gone(child); continue; }
                    var lp = margins(child);
                    child.measure(childSpec(w, getPaddingLeft() + getPaddingRight() + lp.leftMargin + lp.rightMargin, lp.width),
                            childSpec(h, getPaddingTop() + getPaddingBottom() + lp.topMargin + lp.bottomMargin, lp.height));
                    maxW = Math.max(maxW, child.getMeasuredWidth() + lp.leftMargin + lp.rightMargin);
                    maxH = Math.max(maxH, child.getMeasuredHeight() + lp.topMargin + lp.bottomMargin);
                }
                setMeasuredDimension(resolveSize(maxW + getPaddingLeft() + getPaddingRight(), w), resolveSize(maxH + getPaddingTop() + getPaddingBottom(), h));
            }
            @Override protected void onLayout() {
                for (View child : children) {
                    if (child.getVisibility() == GONE) continue;
                    var lp = margins(child);
                    int x = getPaddingLeft() + lp.leftMargin, y = getPaddingTop() + lp.topMargin;
                    child.layout(x, y, x + child.getMeasuredWidth(), y + child.getMeasuredHeight());
                }
            }
        }
        """;

    private static final String SCROLL_VIEW = """
        package android.widget;
        import android.view.View;
        public final class ScrollView extends FrameLayout {
            private boolean fill;
            public ScrollView(android.content.Context context) { super(context); }
            public void setFillViewport(boolean value) { fill = value; }
            public void setVerticalScrollBarEnabled(boolean value) { }
            @Override protected void onMeasure(int w, int h) {
                if (getChildCount() != 1) throw new AssertionError("Scroll child invariant");
                View child = getChildAt(0);
                child.measure(childSpec(w, getPaddingLeft() + getPaddingRight(), child.getLayoutParams().width), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
                int viewport = resolveSize(child.getMeasuredHeight() + getPaddingTop() + getPaddingBottom(), h);
                if (fill && child.getMeasuredHeight() < viewport) child.measure(childSpec(w, 0, child.getLayoutParams().width), MeasureSpec.makeMeasureSpec(viewport, MeasureSpec.EXACTLY));
                setMeasuredDimension(resolveSize(child.getMeasuredWidth(), w), viewport);
            }
        }
        """;

    private static final String TEXT_VIEW = """
        package android.widget;
        import android.view.View;
        import java.util.ArrayList;
        import java.util.List;
        public class TextView extends View {
            private String text = "";
            private float sizeSp = 14, sizePx = 14, spacingExtra, spacingMultiplier = 1;
            private boolean singleLine;
            private android.text.TextUtils.TruncateAt ellipsize;
            public int textSizeCalls;
            private TextLayout layout;
            public TextView(android.content.Context context) { super(context); }
            public void setText(CharSequence value) { text = value.toString(); requestLayout(); }
            public CharSequence getText() { return text; }
            public void setTextSize(int unit, float sp) {
                if (unit != android.util.TypedValue.COMPLEX_UNIT_SP || !Float.isFinite(sp) || sp <= 0) throw new AssertionError("SP role required");
                sizeSp = sp;
                // Synthetic LINEAR conversion: never claim Android nonlinear/font-shaping fidelity.
                sizePx = sp * getResources().getDisplayMetrics().density * getResources().getConfiguration().fontScale;
                textSizeCalls++; requestLayout();
            }
            public float getTextSize() { return sizePx; }
            public float originalSp() { return sizeSp; }
            public void setSingleLine(boolean value) { singleLine = value; requestLayout(); }
            public boolean isSingleLine() { return singleLine; }
            public void setEllipsize(android.text.TextUtils.TruncateAt value) { ellipsize = value; requestLayout(); }
            public android.text.TextUtils.TruncateAt getEllipsize() { return ellipsize; }
            public void setGravity(int value) { }
            public void setTextColor(int color) { }
            public void setTypeface(android.graphics.Typeface face) { }
            public void setLineSpacing(float extra, float multiplier) { spacingExtra = extra; spacingMultiplier = multiplier; requestLayout(); }
            public TextLayout getLayout() { return layout; }
            public record Line(int start, int end, int visibleEnd, float advance, int ellipsisCount) { }
            public record TextLayout(List<Line> lines, int lineHeight, int fontPadding, int contentWidth, int naturalHeight) { }
            public float advance(int cp) {
                if (cp == '\\n') return 0;
                if (Character.isWhitespace(cp)) return sizePx * .32f;
                if (cp >= 0x2e80 || cp == 0x2026) return sizePx;
                if (cp == '-' || cp == '.' || cp == 0xb7) return sizePx * .42f;
                return sizePx * .55f;
            }
            private float width(String value, int start, int end) {
                float result = 0;
                for (int at = start; at < end;) { int cp = value.codePointAt(at); result += advance(cp); at += Character.charCount(cp); }
                return result;
            }
            private int fittingEnd(int start, int end, float available) {
                int at = start; float used = 0;
                while (at < end) {
                    int cp = text.codePointAt(at);
                    if (used + advance(cp) > available + .001f) break;
                    used += advance(cp); at += Character.charCount(cp);
                }
                return at;
            }
            @Override protected void onMeasure(int w, int h) {
                float natural = 0;
                for (String part : text.split("\\\\n", -1)) natural = Math.max(natural, width(part, 0, part.length()));
                int measuredW = resolveSize(Math.max(getMinimumWidth(), (int) Math.ceil(natural) + getPaddingLeft() + getPaddingRight()), w);
                int available = Math.max(1, measuredW - getPaddingLeft() - getPaddingRight());
                List<Line> lines = new ArrayList<>();
                if (singleLine) {
                    float advance = width(text, 0, text.length());
                    int visible = fittingEnd(0, text.length(), available), omitted = 0;
                    if (ellipsize != null && visible < text.length()) {
                        visible = fittingEnd(0, text.length(), Math.max(0, available - advance(0x2026)));
                        omitted = text.length() - visible;
                        advance = width(text, 0, visible) + Math.min(available, advance(0x2026));
                    }
                    lines.add(new Line(0, text.length(), visible, advance, omitted));
                } else {
                    int start = 0;
                    while (start < text.length()) {
                        int newline = text.indexOf('\\n', start);
                        int limit = newline < 0 ? text.length() : newline;
                        int end = fittingEnd(start, limit, available);
                        if (end == start && end < limit) end += Character.charCount(text.codePointAt(end));
                        boolean consumeNewline = end == limit && newline >= 0;
                        int next = end + (consumeNewline ? 1 : 0);
                        lines.add(new Line(start, next, next, width(text, start, end), 0)); start = next;
                    }
                    if (lines.isEmpty()) lines.add(new Line(0, 0, 0, 0, 0));
                }
                int ascent = (int) Math.ceil(sizePx * .80f), descent = (int) Math.ceil(sizePx * .22f);
                int lineHeight = Math.max(1, (int) Math.ceil((ascent + descent) * spacingMultiplier + spacingExtra));
                int fontPadding = (int) Math.ceil(sizePx * .15f), naturalHeight = lines.size() * lineHeight + fontPadding;
                layout = new TextLayout(List.copyOf(lines), lineHeight, fontPadding, available, naturalHeight);
                int desiredH = Math.max(getMinimumHeight(), naturalHeight + getPaddingTop() + getPaddingBottom());
                // Sensitivity mutation targets metadata alone, not unrelated header/footer widgets.
                setMeasuredDimension(measuredW, @ZERO_HEIGHT@ && sizeSp == 10.5f ? 0 : resolveSize(desiredH, h));
            }
        }
        """;

    private static final String ORACLE = """
        package com.ahoo.abs.android.nativekernel;
        import android.content.Context;
        import android.view.View;
        import android.view.ViewGroup;
        import android.widget.EditText;
        import android.widget.LinearLayout;
        import android.widget.ScrollView;
        import android.widget.TextView;
        import java.util.ArrayList;
        import java.util.IdentityHashMap;
        import java.util.List;
        import java.util.Map;
        public final class NtpTileOracle {
            private static int checks, cases, states, emptyCases, emptyStates;
            private static String scenario;
            private static java.io.BufferedWriter trace, emptyTrace;
            private static void measurementReceipt(NewTabPage page, LinearLayout tiles) throws Exception {
                LinearLayout column = (LinearLayout) ((ScrollView) page.getChildAt(0)).getChildAt(0);
                View footer = column.getChildAt(column.getChildCount() - 1);
                StringBuilder details = new StringBuilder(headerReceipt(header(page)));
                for (int r = 0; r < tiles.getChildCount(); r++) {
                    LinearLayout row = (LinearLayout) tiles.getChildAt(r);
                    for (int c = 0; c < row.getChildCount(); c++) {
                        if (!(row.getChildAt(c) instanceof LinearLayout tile)) continue;
                        TextView meta = (TextView) tile.getChildAt(2);
                        details.append(" row").append(r).append("tile").append(c)
                                .append("=tile:").append(tile.getMeasuredWidth()).append('x').append(tile.getMeasuredHeight())
                                .append(",rowH:").append(row.getMeasuredHeight()).append(",meta:")
                                .append(meta.getMeasuredWidth()).append('x').append(meta.getMeasuredHeight())
                                .append(",text:").append(meta.getText()).append(",lines:").append(meta.getLayout().lines());
                    }
                }
                trace.write(scenario + "\\troot=" + page.getMeasuredWidth() + "x" + page.getMeasuredHeight()
                        + "\\ttiles=" + tiles.getMeasuredWidth() + "x" + tiles.getMeasuredHeight()
                        + "\\tcolumn=" + column.getMeasuredHeight() + ",natural:" + column.naturalHeight
                        + "\\tfooter=" + footer.getTop() + ".." + footer.getBottom() + "\\t" + details + "\\n");
                trace.flush();
            }
            private record Header(LinearLayout wrapper, LinearLayout row, TextView avatar,
                    LinearLayout identity, TextView title, TextView hint, TextView history) { }
            private static Header header(NewTabPage page) {
                LinearLayout column = (LinearLayout) ((ScrollView) page.getChildAt(0)).getChildAt(0);
                require(column.getChildAt(0) instanceof LinearLayout, "HEADER_TREE stable header container");
                LinearLayout wrapper = (LinearLayout) column.getChildAt(0);
                require(wrapper.getOrientation() == LinearLayout.VERTICAL && wrapper.getChildCount() == 2,
                        "HEADER_TREE vertical wrapper separates identity from History width competition");
                require(wrapper.getChildAt(0) instanceof LinearLayout && wrapper.getChildAt(1) instanceof TextView,
                        "HEADER_TREE identity first, same History TextView on independent second line");
                LinearLayout row = (LinearLayout) wrapper.getChildAt(0);
                require(row.getOrientation() == LinearLayout.HORIZONTAL && row.getChildCount() == 2,
                        "HEADER_TREE horizontal row contains only avatar and weighted identity column");
                require(row.getChildAt(0) instanceof TextView && row.getChildAt(1) instanceof LinearLayout,
                        "HEADER_TREE existing avatar and title/hint column types");
                LinearLayout identity = (LinearLayout) row.getChildAt(1);
                require(identity.getOrientation() == LinearLayout.VERTICAL && identity.getChildCount() == 2
                                && identity.getChildAt(0) instanceof TextView && identity.getChildAt(1) instanceof TextView,
                        "HEADER_TREE title/hint keep their own vertical column");
                TextView history = (TextView) wrapper.getChildAt(1);
                require(history.getText().toString().equals("历史记录") && history.getParent() == wrapper
                                && row.getParent() == wrapper && identity.getParent() == row,
                        "HEADER_TREE History belongs to header, never identity row/column");
                return new Header(wrapper, row, (TextView) row.getChildAt(0), identity,
                        (TextView) identity.getChildAt(0), (TextView) identity.getChildAt(1), history);
            }
            private static void searchLabels(EditText search) {
                require("搜索".contentEquals(search.getHint() == null ? "" : search.getHint()),
                        "SEARCH_HINT actual stored short hint, including empty-editor phase");
                require("搜索或输入网址".contentEquals(search.getContentDescription() == null ? "" : search.getContentDescription()),
                        "SEARCH_LABEL actual stored full accessible name, not TalkBack execution");
            }
            private static void storedApiChecks() {
                scenario = "stored fixture APIs only; no Android accessibility/rendering claim";
                EditText probe = new EditText(new Context());
                require(probe.getHint() == null && probe.getContentDescription() == null, "stored API defaults are not invented labels");
                probe.setHint("first hint"); probe.setContentDescription("first label");
                require("first hint".contentEquals(probe.getHint()) && "first label".contentEquals(probe.getContentDescription()), "stored API values round-trip");
                probe.setHint("second hint"); probe.setContentDescription("second label");
                require("second hint".contentEquals(probe.getHint()) && "second label".contentEquals(probe.getContentDescription()), "stored API replacement is observable");
                probe.setHint(null); probe.setContentDescription(null);
                require(probe.getHint() == null && probe.getContentDescription() == null, "stored API clear is observable");
            }
            private static Header headerGeometry(NewTabPage page, Context context) {
                Header h = header(page);
                LinearLayout.LayoutParams rowLp = (LinearLayout.LayoutParams) h.row().getLayoutParams();
                LinearLayout.LayoutParams identityLp = (LinearLayout.LayoutParams) h.identity().getLayoutParams();
                LinearLayout.LayoutParams historyLp = (LinearLayout.LayoutParams) h.history().getLayoutParams();
                require(h.wrapper().getLayoutParams().width == -1 && h.wrapper().getLayoutParams().height == -2
                                && rowLp.width == -1 && rowLp.height == -2 && rowLp.weight == 0,
                        "HEADER_LAYOUT stable full-width WRAP header and identity row");
                require(identityLp.width == 0 && identityLp.height == -2 && identityLp.weight == 1
                                && identityLp.leftMargin == dp(context, 12) && identityLp.rightMargin == dp(context, 8),
                        "HEADER_LAYOUT existing weighted identity column/margins unchanged");
                require(historyLp.width == -2 && historyLp.height == -2 && historyLp.weight == 0
                                && historyLp.leftMargin == 0 && historyLp.rightMargin == 0
                                && historyLp.topMargin == dp(context, 8) && historyLp.bottomMargin == 0,
                        "HEADER_LAYOUT History has its own WRAP second line and8dp gap");
                require(h.avatar().getLayoutParams().width == dp(context, 44) && h.avatar().getLayoutParams().height == dp(context, 44)
                                && h.avatar().getMeasuredWidth() == dp(context, 44) && h.avatar().getMeasuredHeight() == dp(context, 44),
                        "HEADER_LAYOUT original44dp identity avatar retained");
                font(h.avatar(), 17, context); font(h.title(), 17, context);
                font(h.hint(), 12.5f, context); font(h.history(), 12.5f, context);
                require(h.title().isSingleLine() && h.title().getEllipsize() == android.text.TextUtils.TruncateAt.END
                                && h.hint().getText().toString().equals("历史记录按环境隔离"),
                        "HEADER_LAYOUT original title ellipsis and identity hint retained");
                int rowWidth = h.wrapper().getMeasuredWidth() - h.wrapper().getPaddingLeft() - h.wrapper().getPaddingRight();
                require(h.row().getMeasuredWidth() == rowWidth && h.identity().getMeasuredWidth() > 0
                                && h.identity().getMeasuredWidth() == rowWidth - h.row().getPaddingLeft() - h.row().getPaddingRight()
                                    - h.avatar().getMeasuredWidth() - identityLp.leftMargin - identityLp.rightMargin,
                        "SYNTHETIC_HEADER identity finite width excludes History entirely");
                require(h.history().getTop() == h.row().getBottom() + dp(context, 8)
                                && h.history().getMeasuredWidth() <= rowWidth && h.history().getMeasuredHeight() > 0,
                        "SYNTHETIC_HEADER History below identity, bounded only by full header width");
                var layout = h.history().getLayout();
                require(layout != null && layout.lines().size() == 1 && layout.lines().get(0).start() == 0
                                && layout.lines().get(0).end() == 4 && layout.lines().get(0).visibleEnd() == 4
                                && layout.lines().get(0).ellipsisCount() == 0
                                && Math.abs(layout.lines().get(0).advance() - 4 * h.history().getTextSize()) < .01f
                                && layout.lines().get(0).advance() <= layout.contentWidth() + .01f
                                && layout.naturalHeight() <= h.history().getMeasuredHeight(),
                        "SYNTHETIC_HEADER four-character History label fits generated line bounds, not Android proof");
                vertical(h.identity(), false); vertical(h.wrapper(), false);
                return h;
            }
            private static String headerReceipt(Header h) {
                return "syntheticHeader=" + h.wrapper().getMeasuredWidth() + "x" + h.wrapper().getMeasuredHeight()
                        + ",identityWidth:" + h.identity().getMeasuredWidth() + ",history:"
                        + h.history().getMeasuredWidth() + "x" + h.history().getMeasuredHeight()
                        + ",secondLine:" + h.history().getTop() + ".." + h.history().getBottom();
            }
            private NtpTileOracle() { }
            private static void require(boolean condition, String message) { checks++; if (!condition) throw new AssertionError(message + " [" + scenario + "]"); }
            private static int dp(Context context, float value) { return Math.round(context.getResources().getDisplayMetrics().density * value); }
            private static Object field(Object owner, String name) throws Exception { var field = owner.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(owner); }
            private record Identity(View view, ViewGroup parent, ViewGroup.LayoutParams params, String text) { }
            private static void identities(View view, List<Identity> result) {
                result.add(new Identity(view, view.getParent(), view.getLayoutParams(), view instanceof TextView text ? text.getText().toString() : null));
                if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) identities(group.getChildAt(i), result);
            }
            private static List<Integer> rectangles(View view) { List<Integer> result = new ArrayList<>(); rects(view, result); return result; }
            private static void rects(View view, List<Integer> result) {
                result.add(view.getMeasuredWidth()); result.add(view.getMeasuredHeight());
                result.add(view.getLeft()); result.add(view.getTop()); result.add(view.getRight()); result.add(view.getBottom());
                if (view instanceof TextView text && text.getLayout() != null) for (var line : text.getLayout().lines()) { result.add(line.start()); result.add(line.end()); result.add(line.visibleEnd()); }
                if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) rects(group.getChildAt(i), result);
            }
            private static void font(TextView text, float sp, Context context) {
                float expected = sp * context.getResources().getDisplayMetrics().density * context.getResources().getConfiguration().fontScale;
                require(text.originalSp() == sp && Math.abs(text.getTextSize() - expected) < .01f, "FONT_SP original role rebound without cumulative/stale px");
            }
            private static float independentMetaAdvance(TextView meta, int start, int end) {
                String value = meta.getText().toString();
                float em = 0;
                for (int at = start; at < end;) {
                    int cp = value.codePointAt(at);
                    em += Character.isWhitespace(cp) ? .32f : cp >= 0x2e80 ? 1 : cp == '-' || cp == '.' || cp == 0xb7 ? .42f : .55f;
                    at += Character.charCount(cp);
                }
                return em * meta.getTextSize();
            }
            private static void completeMeta(TextView meta) {
                var layout = meta.getLayout();
                require(meta.getMeasuredWidth() > 0 && meta.getMeasuredHeight() > 0 && layout != null && layout.lineHeight() > 0 && layout.naturalHeight() > 0, "TEXT_NONZERO metadata metric/layout extent");
                String text = meta.getText().toString(); require(text.endsWith(" 次"), "metadata actual complete unit");
                int next = 0;
                for (var line : layout.lines()) {
                    require(line.start() == next && line.end() > line.start() && line.end() <= text.length(), "META_VISIBLE contiguous nonempty character ranges");
                    require(line.visibleEnd() == line.end() && line.ellipsisCount() == 0 && Float.isFinite(line.advance()) && line.advance() <= layout.contentWidth() + .01f,
                            "META_VISIBLE every character fits finite line (including final次)");
                    require(Math.abs(line.advance() - independentMetaAdvance(meta, line.start(), line.end())) < .01f,
                            "META_VISIBLE independent actual-character advance agrees with line extent");
                    next = line.end();
                }
                require(next == text.length(), "META_VISIBLE ranges cover entire actual metadata including final次");
                require(layout.naturalHeight() + meta.getPaddingTop() + meta.getPaddingBottom() <= meta.getMeasuredHeight(), "META_VISIBLE last line fits vertical text bounds");
                require(meta.getLayoutParams().width == -1 && meta.getLayoutParams().height == -2, "metadata retains MATCH_PARENT / WRAP_CONTENT");
            }
            private static void vertical(LinearLayout group, boolean allowFill) {
                int cursor = group.getPaddingTop();
                for (int i = 0; i < group.getChildCount(); i++) {
                    View child = group.getChildAt(i);
                    if (child.getVisibility() == View.GONE) { require(child.getMeasuredWidth() == 0 && child.getMeasuredHeight() == 0, "GONE contributes no measured extent"); continue; }
                    var lp = ViewGroup.margins(child); cursor += lp.topMargin;
                    require(child.getTop() == cursor && child.getBottom() == cursor + child.getMeasuredHeight(), "vertical position follows measured height plus margin");
                    require(child.getLeft() >= group.getPaddingLeft() + lp.leftMargin && child.getRight() <= group.getMeasuredWidth() - group.getPaddingRight() - lp.rightMargin, "finite child horizontal containment");
                    cursor += child.getMeasuredHeight() + lp.bottomMargin;
                }
                cursor += group.getPaddingBottom(); int expected = Math.max(group.getMinimumHeight(), cursor);
                require(group.naturalHeight == expected, "upward natural height aggregates children/padding/margins/minimum");
                require(allowFill ? group.getMeasuredHeight() >= expected : group.getMeasuredHeight() == expected, "upward measured height propagation");
            }
            private static int geometry(NewTabPage page, Context context, int count, int content, float scale) throws Exception {
                LinearLayout tiles = (LinearLayout) field(page, "tiles");
                View empty = (View) field(page, "emptyCard"), section = (View) field(page, "sectionRow");
                ScrollView scroll = (ScrollView) page.getChildAt(0); LinearLayout column = (LinearLayout) scroll.getChildAt(0);
                TextView footer = (TextView) column.getChildAt(column.getChildCount() - 1);
                require(column.getPaddingLeft() == dp(context, 18) && column.getPaddingRight() == dp(context, 18), "actual outer18dp constrains width");
                require(tiles.getMeasuredWidth() == page.getMeasuredWidth() - dp(context, 18) * 2, "real constrained tiles width");
                require(tiles.getChildCount() == (count + 2) / 3, "actual refresh row count");
                require(empty.getVisibility() == (count == 0 ? View.VISIBLE : View.GONE) && section.getVisibility() == (count == 0 ? View.GONE : View.VISIBLE), "actual empty/section visibility");
                int seen = 0, previousBottom = 0, previousGap = 0, metaTotal = 0;
                for (int r = 0; r < tiles.getChildCount(); r++) {
                    LinearLayout row = (LinearLayout) tiles.getChildAt(r);
                    require(row.getChildCount() == 3, "three actual weighted columns including sparse fillers");
                    var rowLp = ViewGroup.margins(row);
                    require(rowLp.bottomMargin == dp(context, 10) && rowLp.height == -2, "row WRAP and10dp rhythm");
                    require(row.getTop() == previousBottom + previousGap, "row spacing follows preceding actual height");
                    int maximum = 0, cursor = 0, minWidth = Integer.MAX_VALUE, maxWidth = 0;
                    for (int c = 0; c < 3; c++) {
                        View child = row.getChildAt(c); LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) child.getLayoutParams();
                        require(lp.width == 0 && lp.height == -2 && lp.weight == 1, "actual weighted WRAP tile/filler layout");
                        cursor += lp.leftMargin;
                        require(child.getLeft() == cursor && child.getRight() == cursor + child.getMeasuredWidth(), "weighted positions honor margins");
                        cursor += child.getMeasuredWidth() + lp.rightMargin;
                        maximum = Math.max(maximum, child.getMeasuredHeight() + lp.topMargin + lp.bottomMargin);
                        minWidth = Math.min(minWidth, child.getMeasuredWidth()); maxWidth = Math.max(maxWidth, child.getMeasuredWidth());
                        if (!(child instanceof LinearLayout tile)) { require(seen == count && child.getMeasuredHeight() == 0, "sparse actual filler has no invented text height"); continue; }
                        seen++;
                        require(lp.leftMargin == dp(context, 5) && lp.rightMargin == dp(context, 5), "actual tile5dp margins");
                        require(tile.getPaddingLeft() == dp(context, 10) && tile.getPaddingRight() == dp(context, 10) && tile.getPaddingTop() == dp(context, 14) && tile.getPaddingBottom() == dp(context, 14), "actual tile padding10/14dp");
                        require(tile.getMinimumHeight() == dp(context, 88) && tile.getMeasuredHeight() >= dp(context, 88), "tile minimum88dp not maximum");
                        require(tile.getChildCount() == 3, "actual avatar/name/meta children");
                        TextView avatar = (TextView) tile.getChildAt(0), title = (TextView) tile.getChildAt(1), meta = (TextView) tile.getChildAt(2);
                        font(avatar, 16, context); font(title, 12.5f, context); font(meta, 10.5f, context); completeMeta(meta);
                        boolean old = content == 1 || (content == 2 && (seen - 1) % 2 == 0);
                        String actualMeta = meta.getText().toString();
                        require(old ? actualMeta.matches("[0-9]{4}-[0-9]{2}-[0-9]{2} · 9999 次") : actualMeta.equals("刚刚 · 1 次"),
                                "actual metadata exercises expected short timestamp or yyyy-MM-dd/count9999 including unit");
                        require(avatar.getMeasuredWidth() == dp(context, 42) && avatar.getMeasuredHeight() == dp(context, 42), "fixed actual42dp avatar");
                        require(title.isSingleLine() && title.getEllipsize() == android.text.TextUtils.TruncateAt.END, "name stays singleLine END ellipsis");
                        require(title.getLayout().lines().size() == 1 && title.getLayout().lines().get(0).ellipsisCount() > 0 && title.getLayout().lines().get(0).advance() <= title.getLayout().contentWidth() + .01f, "long actual hostname visibly END-ellipsized inside width");
                        var titleLp = ViewGroup.margins(title);
                        require(titleLp.topMargin == dp(context, 8) && titleLp.leftMargin == dp(context, 2) && titleLp.rightMargin == dp(context, 2), "actual name margins2/8dp");
                        require(meta.getTop() == title.getBottom() && meta.getBottom() <= tile.getMeasuredHeight() - tile.getPaddingBottom(), "metadata last line fully inside grown tile");
                        if (old && scale == 2) require(meta.getLayout().lines().size() >= 2, "old yyyy-MM-dd/count9999 truly wraps at large font");
                        metaTotal += meta.getMeasuredHeight(); vertical(tile, false);
                    }
                    require(cursor == row.getMeasuredWidth() && maxWidth - minWidth <= 1, "finite weighted widths exhaust row without drift/overflow");
                    require(row.getMeasuredHeight() == maximum && maximum > 0, "row propagates tallest actual tile");
                    previousBottom = row.getBottom(); previousGap = rowLp.bottomMargin;
                }
                require(seen == count, "all actual history tiles audited"); vertical(tiles, false); vertical(column, true);
                require(footer.getMeasuredHeight() > 0 && footer.getLayout() != null, "TEXT_NONZERO actual footer");
                require(footer.getTop() >= tiles.getBottom() && (count != 0 || footer.getTop() >= empty.getBottom()), "footer below final row/empty state");
                require(column.getMeasuredHeight() >= footer.getBottom() + column.getPaddingBottom(), "scroll content encloses footer after propagation");
                return metaTotal;
            }
            private static void runCase(int width, float density, int count, int content) throws Exception {
                scenario = "draft constructor width=" + width + "dp density=" + density + " count=" + count + " content=" + content;
                Context context = new Context(); context.getResources().getDisplayMetrics().density = density;
                List<BrowserHistory.SiteVisit> visits = new ArrayList<>(); long now = System.currentTimeMillis();
                for (int i = 0; i < count; i++) {
                    boolean old = content == 1 || (content == 2 && i % 2 == 0);
                    visits.add(new BrowserHistory.SiteVisit("https://long-history-hostname-" + i + ".example", "真实长度测试标题" + i, old ? 946771200000L : now, old ? 9999 : 1));
                }
                BrowserHistoryStore store = new BrowserHistoryStore(visits); int[] actions = {0};
                NewTabPage page = new NewTabPage(context, store, "测试环境", new NewTabPage.Listener() {
                    @Override public void onNtpNavigate(String url) { actions[0]++; }
                    @Override public void onNtpOpenHistory() { actions[0]++; }
                });
                require(store.rankedCalls == 0, "constructor no invented history query"); page.onShown();
                require(store.rankedCalls == 1, "actual onShown/refresh one ranked query");
                EditText search = (EditText) field(page, "search"); String draft = "保留草稿 example.invalid/路径?x=未提交";
                require(search.getText().length() == 0, "SEARCH_EMPTY actual NTP editor starts empty before draft"); searchLabels(search);
                Header originalHeader = header(page); int baseIdentityWidth = 0, baseHistoryWidth = 0;
                search.setText(draft); search.setSelection(2, 9); search.requestFocus();
                List<Identity> snapshot = new ArrayList<>(); identities(page, snapshot);
                LinearLayout tiles = (LinearLayout) field(page, "tiles"); Map<View, Integer> baseMeta = new IdentityHashMap<>();
                List<Integer> baseline = null, peak = null; int baseHeight = 0, peakHeight = 0, baseMetaTotal = 0;
                float[] scales = {1, 1.3f, 2, 2, 1};
                for (int step = 0; step < scales.length; step++) {
                    float scale = scales[step];
                    scenario = "width=" + width + "dp density=" + density + " count=" + count + " content=" + content + " step=" + step + " font=" + scale;
                    context.getResources().getConfiguration().fontScale = scale;
                    int requests = page.layoutRequests; page.applyFontScale();
                    require(page.layoutRequests > requests, "font rebind requests layout on same tree"); font(search, 15.5f, context);
                    page.measure(View.MeasureSpec.makeMeasureSpec(dp(context, width), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(dp(context, 720), View.MeasureSpec.EXACTLY));
                    page.layout(0, 0, page.getMeasuredWidth(), page.getMeasuredHeight());
                    require(page.getMeasuredWidth() == dp(context, width) && page.getMeasuredHeight() > 0, "root finite nonzero constrained measurement");
                    measurementReceipt(page, tiles);
                    int metaTotal = geometry(page, context, count, content, scale);
                    searchLabels(search); Header currentHeader = headerGeometry(page, context);
                    require(currentHeader.equals(originalHeader), "HEADER_IDENTITY all original header/row/text references retained");
                    if (step == 0) { baseIdentityWidth = currentHeader.identity().getMeasuredWidth(); baseHistoryWidth = currentHeader.history().getMeasuredWidth(); }
                    require(currentHeader.identity().getMeasuredWidth() == baseIdentityWidth, "SYNTHETIC_HEADER History growth never consumes identity width");
                    if (scale == 2) require(currentHeader.history().getMeasuredWidth() > baseHistoryWidth, "SYNTHETIC_HEADER unchanged History SP grows independently");
                    states++;
                    List<Identity> after = new ArrayList<>(); identities(page, after);
                    require(after.size() == snapshot.size(), "same complete tree size across font cycles");
                    for (int i = 0; i < snapshot.size(); i++) {
                        Identity a = snapshot.get(i), b = after.get(i);
                        require(a.view == b.view && a.parent == b.parent && a.params == b.params, "same view/parent/LayoutParams identity across font cycles");
                        require(java.util.Objects.equals(a.text, b.text), "text/search draft unchanged across font cycles");
                    }
                    require(field(page, "search") == search && search.hasFocus() && context.focused == search && search.getText().toString().equals(draft) && search.getSelectionStart() == 2 && search.getSelectionEnd() == 9, "search reference/draft/focus/selection preserved");
                    require(field(page, "tiles") == tiles && store.rankedCalls == 1 && actions[0] == 0, "no rebuild/history requery/navigation on font rebind");
                    for (int r = 0; r < tiles.getChildCount(); r++) {
                        LinearLayout row = (LinearLayout) tiles.getChildAt(r);
                        for (int c = 0; c < row.getChildCount(); c++) {
                            if (!(row.getChildAt(c) instanceof LinearLayout tile)) continue;
                            TextView meta = (TextView) tile.getChildAt(2);
                            if (step == 0) baseMeta.put(meta, meta.getMeasuredHeight());
                            if (scale == 2) require(meta.getMeasuredHeight() > baseMeta.get(meta), "individual metadata height grows under2x");
                        }
                    }
                    if (step == 0) { baseline = rectangles(page); baseHeight = tiles.getMeasuredHeight(); baseMetaTotal = metaTotal; }
                    if (step == 2) { peak = rectangles(page); peakHeight = tiles.getMeasuredHeight(); }
                    if (step == 3) require(rectangles(page).equals(peak) && tiles.getMeasuredHeight() == peakHeight, "repeated2x exactly idempotent geometry/ranges");
                    if (step == 4) require(rectangles(page).equals(baseline) && tiles.getMeasuredHeight() == baseHeight, "return1x exactly restores geometry/ranges");
                    if (count > 0 && step == 2) require(tiles.getMeasuredHeight() > baseHeight && metaTotal > baseMetaTotal, "metadata height growth propagates to rows/tiles");
                }
            }
            private static void runEmptyCase(int width, float density, String profile) throws Exception {
                scenario = "empty constructor width=" + width + "dp density=" + density + " profile=" + profile;
                Context context = new Context(); context.getResources().getDisplayMetrics().density = density;
                BrowserHistoryStore store = new BrowserHistoryStore(List.of()); int[] actions = {0};
                NewTabPage page = new NewTabPage(context, store, profile, new NewTabPage.Listener() {
                    @Override public void onNtpNavigate(String url) { actions[0]++; }
                    @Override public void onNtpOpenHistory() { actions[0]++; }
                });
                require(store.rankedCalls == 0, "empty constructor no invented query"); page.onShown();
                require(store.rankedCalls == 1, "empty actual onShown one ranked query");
                EditText search = (EditText) field(page, "search");
                require(search.getText().length() == 0, "SEARCH_EMPTY separate empty-editor phase has no draft"); searchLabels(search);
                search.setSelection(0, 0); search.requestFocus(); Header originalHeader = header(page);
                String expectedName = profile == null || profile.trim().isEmpty() ? "默认环境" : profile.trim();
                require(originalHeader.title().getText().toString().equals(expectedName), "empty profile title exercises default/long Chinese/mixed content");
                List<Identity> snapshot = new ArrayList<>(); identities(page, snapshot);
                List<Integer> baseline = null, peak = null; int baseIdentityWidth = 0, baseHistoryWidth = 0;
                float[] scales = {1, 1.3f, 2, 2, 1};
                for (int step = 0; step < scales.length; step++) {
                    float scale = scales[step];
                    scenario = "EMPTY_EDITOR width=" + width + "dp density=" + density + " profile=" + expectedName + " step=" + step + " font=" + scale;
                    context.getResources().getConfiguration().fontScale = scale;
                    int requests = page.layoutRequests; page.applyFontScale();
                    require(page.layoutRequests > requests, "empty font rebind requests layout on same tree"); font(search, 15.5f, context);
                    require(search.getText().length() == 0, "SEARCH_EMPTY no hidden populated-editor proxy for hint coverage"); searchLabels(search);
                    page.measure(View.MeasureSpec.makeMeasureSpec(dp(context, width), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(dp(context, 720), View.MeasureSpec.EXACTLY));
                    page.layout(0, 0, page.getMeasuredWidth(), page.getMeasuredHeight());
                    Header currentHeader = headerGeometry(page, context);
                    require(currentHeader.equals(originalHeader), "HEADER_IDENTITY empty phase retains existing header/History references");
                    if (step == 0) { baseline = rectangles(page); baseIdentityWidth = currentHeader.identity().getMeasuredWidth(); baseHistoryWidth = currentHeader.history().getMeasuredWidth(); }
                    require(currentHeader.identity().getMeasuredWidth() == baseIdentityWidth, "SYNTHETIC_HEADER empty-phase History never consumes identity width");
                    if (scale == 2) require(currentHeader.history().getMeasuredWidth() > baseHistoryWidth, "SYNTHETIC_HEADER empty-phase History grows without shrinking identity");
                    if (step == 2) peak = rectangles(page);
                    if (step == 3) require(rectangles(page).equals(peak), "empty repeated2x idempotent synthetic geometry");
                    if (step == 4) require(rectangles(page).equals(baseline), "empty return1x restores synthetic geometry");
                    List<Identity> after = new ArrayList<>(); identities(page, after);
                    require(after.size() == snapshot.size(), "empty same complete tree size");
                    for (int i = 0; i < snapshot.size(); i++) {
                        Identity a = snapshot.get(i), b = after.get(i);
                        require(a.view == b.view && a.parent == b.parent && a.params == b.params && java.util.Objects.equals(a.text, b.text), "empty view/parent/LayoutParams/text identity retained");
                    }
                    require(field(page, "search") == search && search.hasFocus() && context.focused == search
                                    && search.getSelectionStart() == 0 && search.getSelectionEnd() == 0
                                    && store.rankedCalls == 1 && actions[0] == 0,
                            "empty editor reference/focus/selection/query count unchanged; no navigation actions executed");
                    emptyTrace.write(scenario + (char) 9 + "textLength=" + search.getText().length() + (char) 9 + "storedHint=" + search.getHint()
                            + (char) 9 + "storedContentDescription=" + search.getContentDescription() + (char) 9 + headerReceipt(currentHeader)
                            + (char) 9 + "LIMIT=hint-not-rendered,no-TalkBack-click-IME-proof" + (char) 10); emptyTrace.flush();
                    emptyStates++;
                }
            }
            public static int run(String receiptPath) throws Exception {
                try (var writer = java.nio.file.Files.newBufferedWriter(java.nio.file.Path.of(receiptPath));
                        var emptyWriter = java.nio.file.Files.newBufferedWriter(java.nio.file.Path.of(receiptPath).resolveSibling("empty-editor.tsv"))) {
                    trace = writer; emptyTrace = emptyWriter; storedApiChecks();
                    for (int width : new int[]{288, 320, 412}) for (float density : new float[]{1, 2.625f})
                        for (int count : new int[]{0, 1, 3, 4, 9}) for (int content = 0; content < 3; content++) {
                            runCase(width, density, count, content); cases++;
                        }
                    require(cases == 90 && states == 450, "complete90case/450state matrix, no skipped fixture scenarios");
                    for (int width : new int[]{288, 320, 412}) for (float density : new float[]{1, 2.625f})
                        for (String profile : new String[]{null, "这是用于窄屏大字检验的长中文环境名称", "Route104 alpha-beta mixed 环境名称"}) {
                            runEmptyCase(width, density, profile); emptyCases++;
                        }
                    require(emptyCases == 18 && emptyStates == 90, "separate18case/90state empty-editor matrix, never counted as metadata states");
                    return checks;
                }
            }
        }
        """;
}
