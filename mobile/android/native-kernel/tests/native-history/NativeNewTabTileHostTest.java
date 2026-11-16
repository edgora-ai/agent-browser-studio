import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.VariableTree;
import com.sun.source.tree.Tree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.Trees;
import com.sun.source.util.TreeScanner;
import java.io.StringWriter;
import java.lang.reflect.InvocationTargetException;
import java.net.URI;
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
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

/**
 * Compiles COMPLETE actual NewTabPage and verbatim actual FontBindings/PaletteBindings.
 * Synthetic framework substitutes model finite-width weighted measurement, wrapping, line ranges,
 * margins, padding, minimums, GONE and upward height propagation. NOT Android text shaping,
 * nonlinear font conversion, native rendering, device, lifecycle or visual acceptance evidence.
 * --fixture-control changes only the in-memory metadata singleLine argument while production is
 * frozen; it is explicitly NOT genuine product-fix evidence. Default mode uses unchanged source.
 * Both modes reject geometry/font false-greens plus local-editor, fake-card, focus, History target,
 * empty reachability, palette, ranking and quiescence regressions. Colors, listeners and accessibility
 * labels are observable fixture state, not native rendering, TalkBack, real touches or IME evidence.
 * Toolbar ownership is checked against parsed actual Activity source; buildChrome is not executed.
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

    /** Parses real toolbar ownership, without claiming to execute the Activity on this host. */
    private static void sharedSearchOwner(JavaCompiler compiler, String activity) throws Exception {
        JavaFileObject input = new SimpleJavaFileObject(URI.create("string:///NativeBrowserActivity.java"), JavaFileObject.Kind.SOURCE) {
            @Override public CharSequence getCharContent(boolean ignoreEncodingErrors) { return activity; }
        };
        int[] editors = {0}, fields = {0}; boolean[] roles = {false, false, false};
        JavacTask task = (JavacTask) compiler.getTask(null, null, null,
                List.of("--release", "17", "-proc:none"), null, List.of(input));
        for (CompilationUnitTree unit : task.parse()) new TreeScanner<Void, Void>() {
            @Override public Void visitNewClass(NewClassTree tree, Void unused) {
                if (tree.getIdentifier().toString().equals("EditText")
                        || tree.getIdentifier().toString().equals("android.widget.EditText")) editors[0]++;
                return super.visitNewClass(tree, unused);
            }
            @Override public Void visitVariable(VariableTree tree, Void unused) {
                if (tree.getName().contentEquals("address") && tree.getType().toString().equals("EditText")) fields[0]++;
                return super.visitVariable(tree, unused);
            }
            @Override public Void visitMethodInvocation(MethodInvocationTree tree, Void unused) {
                String select = tree.getMethodSelect().toString();
                Object literal = tree.getArguments().size() == 1 && tree.getArguments().get(0) instanceof LiteralTree value ? value.getValue() : null;
                if (select.equals("address.setHint") && "搜索".equals(literal)) roles[0] = true;
                if (select.equals("address.setContentDescription") && "搜索或输入网址".equals(literal)) roles[1] = true;
                if (select.equals("address.setOnEditorActionListener")) roles[2] = true;
                return super.visitMethodInvocation(tree, unused);
            }
        }.scan(unit, null);
        if (editors[0] != 1 || fields[0] != 1 || !roles[0] || !roles[1] || !roles[2]) {
            throw new AssertionError("SHARED_SEARCH_OWNER one real toolbar address editor, short hint/full label and submit listener required; editors=" + editors[0] + " addressFields=" + fields[0] + " roles=" + java.util.Arrays.toString(roles));
        }
    }

    private static void sourceRejected(JavaCompiler compiler, String label, String source) throws Exception {
        try { sharedSearchOwner(compiler, source); }
        catch (AssertionError rejected) {
            if (!rejected.getMessage().contains("SHARED_SEARCH_OWNER")) throw rejected;
            System.out.println("EXPECTED_REJECTION " + label + ": " + rejected.getMessage());
            return;
        }
        throw new AssertionError("Toolbar ownership source sensitivity failed: " + label);
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
        String activity = Files.readString(source.resolve("NativeBrowserActivity.java"));
        sharedSearchOwner(compiler, activity);
        sourceRejected(compiler, "toolbar-old-long-hint", replaceOnce(activity,
                "address.setHint(\"搜索\");", "address.setHint(\"搜索或输入网址\");"));
        sourceRejected(compiler, "toolbar-missing-full-label", replaceOnce(activity,
                "address.setContentDescription(\"搜索或输入网址\");", "/* MUTATION: missing toolbar label */"));
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
        if (positive.failure != null) throw new AssertionError("Genuine/control main geometry oracle FAILED", positive.failure);
        rejected("old-metadata-singleline", run(compiler, output.resolve("old-singleline"), metadataMode(tested, true), history, realBindings, false, false), "META_VISIBLE");
        rejected("zero-text-height", run(compiler, output.resolve("zero-height"), tested, history, realBindings, true, false), "TEXT_NONZERO");
        rejected("no-op-tile-font-rebind", run(compiler, output.resolve("noop-rebind"), tested, history, realBindings, false, true), "FONT_SP");
        rejected("reintroduced-local-editor", run(compiler, output.resolve("local-editor"),
                replaceOnce(tested, "column.addView(buildIdentityRow(context, profileName));",
                        "column.addView(new android.widget.EditText(context));\n        column.addView(buildIdentityRow(context, profileName));"),
                history, realBindings, false, false), "NO_LOCAL_EDITOR");
        rejected("replacement-fake-search-card", run(compiler, output.resolve("fake-search-card"),
                replaceOnce(tested, "column.addView(buildIdentityRow(context, profileName));",
                        "column.addView(buildIdentityRow(context, profileName));\n        TextView fake = new TextView(context); fake.setText(\"搜索或输入网址\"); column.addView(fake);"),
                history, realBindings, false, false), "NTP_TREE");
        rejected("missing-history-label", run(compiler, output.resolve("history-label"),
                replaceOnce(tested, "all.setContentDescription(\"历史记录\");", "/* MUTATION: missing History label */"),
                history, realBindings, false, false), "HISTORY_LABEL");
        rejected("undersized-history-target", run(compiler, output.resolve("history-target"),
                replaceOnce(tested, "all.setMinimumHeight(dp(48));", "all.setMinimumHeight(dp(40));"),
                history, realBindings, false, false), "HISTORY_TARGET");
        rejected("history-hidden-when-empty", run(compiler, output.resolve("history-empty"),
                replaceOnce(tested, "emptyState.setVisibility(empty ? View.VISIBLE : View.GONE);",
                        "emptyState.setVisibility(empty ? View.VISIBLE : View.GONE);\n        ((LinearLayout) emptyState.getParent()).getChildAt(1).setVisibility(empty ? View.GONE : View.VISIBLE);"),
                history, realBindings, false, false), "HISTORY_REACHABLE");
        rejected("ntp-steals-toolbar-focus", run(compiler, output.resolve("focus-owner"),
                replaceOnce(tested, "setClickable(true);", "setClickable(true); requestFocus();"),
                history, realBindings, false, false), "FOCUS_OWNER");
        rejected("no-op-static-palette", run(compiler, output.resolve("static-palette"),
                replaceOnce(tested, "staticPaletteBindings.apply();", "/* MUTATION: stale static palette */"),
                history, realBindings, false, false), "PALETTE_STATIC");
        rejected("no-op-tile-palette", run(compiler, output.resolve("tile-palette"),
                replaceOnce(tested, "tilePaletteBindings.apply();", "/* MUTATION: stale tile palette */"),
                history, realBindings, false, false), "PALETTE_TILE");
        rejected("removed-nine-tile-cap", run(compiler, output.resolve("max-nine"),
                replaceOnce(tested, "Math.min(ranked.size(), MAX_TILES)", "ranked.size()"),
                history, realBindings, false, false), "RANKED_CAP");
        rejected("retired-tile-font-bindings", run(compiler, output.resolve("retired-bindings"),
                replaceOnce(tested, "tileFonts.clear();", "/* MUTATION: retain stale tile bindings */"),
                history, realBindings, false, false), "RETIRED_BINDINGS");
        rejected("quiescent-refresh-requeries", run(compiler, output.resolve("quiescent-refresh"),
                replaceOnce(tested, "void refresh() {\n        if (quiescing) return;", "void refresh() {"),
                history, realBindings, false, false), "QUIESCENT_QUERY");
        if (!Files.readString(source.resolve("NewTabPage.java")).equals(original)) throw new AssertionError("Production source changed during run: unstable receipt");
        System.out.println("PASS " + positive.checks + " geometry/state assertions; 108 cases / 540 constrained layout states; 24 empty-profile cases / 120 additional states; 16 mutations rejected");
        System.out.println("EVIDENCE_LIMIT synthetic JDK host only; labels/colors/listeners/scroll are fixture state; actual toolbar source parsed, buildChrome not executed; no Android shaping/conversion/rendering/device/visual/TalkBack/real-touch/IME claim");
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
                public int focusWrites, focusConfigWrites, keyboardRequests, haptics;
                public android.content.res.Resources getResources() { return resources; }
                public Object getSystemService(String name) { keyboardRequests++; return null; }
            }
            """),
        Map.entry("android/content/DialogInterface", "package android.content; public interface DialogInterface { interface OnDismissListener { void onDismiss(DialogInterface dialog); } }"),
        Map.entry("android/content/res/ColorStateList", "package android.content.res; public final class ColorStateList { public final int color; private ColorStateList(int value) { color = value; } public static ColorStateList valueOf(int color) { return new ColorStateList(color); } }"),
        Map.entry("android/app/Activity", "package android.app; public class Activity extends android.content.Context { public static final String INPUT_METHOD_SERVICE = \"input_method\"; }"),
        Map.entry("android/app/Dialog", """
            package android.app;
            public class Dialog implements android.content.DialogInterface {
                private android.content.DialogInterface.OnDismissListener listener;
                public boolean showing = true;
                public int paletteCalls, fontCalls;
                public String title, body, action;
                public Runnable callback;
                public void dismiss() {
                    if (!showing) return;
                    showing = false;
                    if (listener != null) listener.onDismiss(this);
                }
                public void confirm() { if (!showing) throw new AssertionError("Already dismissed"); dismiss(); callback.run(); }
                public void setOnDismissListener(android.content.DialogInterface.OnDismissListener value) { listener = value; }
            }
            """),
        Map.entry("android/graphics/Color", "package android.graphics; public final class Color { private Color() { } }"),
        Map.entry("android/graphics/Typeface", "package android.graphics; public final class Typeface { public static final int NORMAL = 0; public static final Typeface DEFAULT_BOLD = new Typeface(); public static Typeface create(String family, int style) { return new Typeface(); } }"),
        Map.entry("android/graphics/drawable/GradientDrawable", """
            package android.graphics.drawable;
            public class GradientDrawable {
                public static final int OVAL = 1, RECTANGLE = 0;
                public enum Orientation { TOP_BOTTOM }
                public int color, strokeWidth, strokeColor, shape;
                public float radius;
                public int[] colors;
                public void setOrientation(Orientation value) { }
                public void setColors(int[] value) { colors = value.clone(); }
                public void setColor(int value) { color = value; }
                public void setStroke(int width, int value) { strokeWidth = width; strokeColor = value; }
                public void setCornerRadius(float value) { radius = value; }
                public void setShape(int value) { shape = value; }
            }
            """),
        Map.entry("android/graphics/drawable/RippleDrawable", """
            package android.graphics.drawable;
            public final class RippleDrawable {
                public int color;
                public final Object content, mask;
                public RippleDrawable(android.content.res.ColorStateList colors, Object content, Object mask) { color = colors.color; this.content = content; this.mask = mask; }
                public void setColor(android.content.res.ColorStateList colors) { color = colors.color; }
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
                public EditText(android.content.Context context) { super(context); }
            }
            """),
        Map.entry("android/widget/Toast", "package android.widget; public final class Toast { public static final int LENGTH_SHORT = 0; public static int shown; public static String lastText; public static Toast makeText(android.content.Context context, String text, int duration) { lastText = text; return new Toast(); } public void show() { shown++; } }"),
        Map.entry("com/ahoo/abs/android/nativekernel/BrowserHistoryStore", """
            package com.ahoo.abs.android.nativekernel;
            import java.util.List;
            final class BrowserHistoryStore {
                List<BrowserHistory.SiteVisit> visits;
                private BrowserHistory model;
                int rankedCalls, removeCalls;
                String removedOrigin;
                BrowserHistoryStore(List<BrowserHistory.SiteVisit> visits) { this.visits = List.copyOf(visits); }
                BrowserHistoryStore(BrowserHistory model) { this.model = model; }
                public List<BrowserHistory.SiteVisit> ranked() { rankedCalls++; return model == null ? List.copyOf(visits) : model.ranked(); }
                public boolean removeSite(String origin) {
                    removeCalls++; removedOrigin = origin;
                    if (model != null) return model.removeSite(origin);
                    List<BrowserHistory.SiteVisit> next = visits.stream().filter(visit -> !visit.origin.equals(origin)).toList();
                    boolean changed = next.size() != visits.size(); visits = next; return changed;
                }
            }
            """),
        Map.entry("com/ahoo/abs/android/nativekernel/BrowserDialogs", """
            package com.ahoo.abs.android.nativekernel;
            final class BrowserDialogs {
                static void applyPalette(android.app.Dialog dialog) { dialog.paletteCalls++; }
                static void applyFontScale(android.app.Dialog dialog) { dialog.fontCalls++; }
                static android.app.Dialog confirm(android.content.Context context, String title, String body, String action, Runnable callback) {
                    android.app.Dialog dialog = new android.app.Dialog();
                    dialog.title = title; dialog.body = body; dialog.action = action; dialog.callback = callback; return dialog;
                }
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
            private Object background, foreground;
            private float elevation;
            private boolean clickable, enabled = true;
            private OnClickListener click;
            private OnLongClickListener longClick;
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
            public boolean requestFocus() { context.focusWrites++; context.focused = this; return true; }
            public boolean hasFocus() { return context.focused == this; }
            public void clearFocus() { context.focusWrites++; if (context.focused == this) context.focused = null; }
            public void setBackground(Object drawable) { background = drawable; }
            public Object getBackground() { return background; }
            public void setForeground(Object drawable) { foreground = drawable; }
            public Object getForeground() { return foreground; }
            public void setElevation(float value) { elevation = value; }
            public float getElevation() { return elevation; }
            public void setClickable(boolean value) { clickable = value; }
            public boolean isClickable() { return clickable; }
            public void setDescendantFocusability(int value) { context.focusConfigWrites++; }
            public void setFocusableInTouchMode(boolean value) { context.focusConfigWrites++; }
            public void setFocusable(boolean value) { context.focusConfigWrites++; }
            public void setEnabled(boolean value) { enabled = value; }
            public void setOnClickListener(OnClickListener listener) { click = listener; clickable = listener != null; }
            public boolean hasOnClickListeners() { return click != null; }
            public void setOnLongClickListener(OnLongClickListener listener) { longClick = listener; }
            public boolean performClick() { if (enabled && click != null) { click.onClick(this); return true; } return false; }
            public boolean performLongClick() { return enabled && longClick != null && longClick.onLongClick(this); }
            public boolean performHapticFeedback(int value) { context.haptics++; return true; }
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
            private int scrollY;
            public int getScrollY() { return scrollY; }
            public void scrollTo(int x, int y) { scrollY = Math.max(0, Math.min(y, getChildAt(0).getMeasuredHeight() - getMeasuredHeight())); }
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
            private int textColor;
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
            public void setTextColor(int color) { textColor = color; }
            public int getCurrentTextColor() { return textColor; }
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
            private record Header(LinearLayout wrapper, TextView title, TextView hint,
                    LinearLayout section, TextView recent, TextView history) { }
            private static LinearLayout column(NewTabPage page) {
                require(page.getChildCount() == 1 && page.getChildAt(0) instanceof ScrollView,
                        "NTP_TREE one scroll surface, not a replacement search card");
                return (LinearLayout) ((ScrollView) page.getChildAt(0)).getChildAt(0);
            }
            private static void noEditor(View view) {
                require(!(view instanceof EditText), "NO_LOCAL_EDITOR toolbar is the sole editor, including hidden views");
                if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) noEditor(group.getChildAt(i));
            }
            private static void inputOwnership(NewTabPage page, Context context, View externalFocus) {
                noEditor(page);
                require(context.focused == externalFocus && context.focusWrites == 0 && context.focusConfigWrites == 0
                                && context.keyboardRequests == 0,
                        "FOCUS_OWNER NTP never requests/configures/clears focus or owns keyboard services");
                require(page.isClickable() && !page.hasOnClickListeners(), "blank WebContents taps consumed without fake search action");
                for (var declared : NewTabPage.class.getDeclaredFields())
                    require(!EditText.class.isAssignableFrom(declared.getType()), "NO_LOCAL_EDITOR no detached editor field");
                for (var declared : NewTabPage.class.getDeclaredMethods())
                    require(!List.of("buildSearchCard", "submit", "hideKeyboard", "showKeyboard").contains(declared.getName()),
                            "NO_LOCAL_EDITOR no local card/submit/keyboard owner methods");
            }
            private static Header header(NewTabPage page) {
                LinearLayout column = column(page);
                require(column.getChildCount() == 5, "NTP_TREE identity, section, tiles, empty text and footer only; no fake search card");
                require(column.getChildAt(0) instanceof LinearLayout && column.getChildAt(1) instanceof LinearLayout,
                        "HEADER_TREE identity and recent section are independent siblings");
                LinearLayout identity = (LinearLayout) column.getChildAt(0), section = (LinearLayout) column.getChildAt(1);
                require(identity.getOrientation() == LinearLayout.VERTICAL && identity.getChildCount() == 2
                                && identity.getChildAt(0) instanceof TextView && identity.getChildAt(1) instanceof TextView,
                        "HEADER_TREE environment title and isolation metadata only, no avatar/history pill");
                require(section.getOrientation() == LinearLayout.HORIZONTAL && section.getChildCount() == 2
                                && section.getChildAt(0) instanceof TextView && section.getChildAt(1) instanceof TextView,
                        "HEADER_TREE recent heading and one History action in their own section");
                return new Header(identity, (TextView) identity.getChildAt(0), (TextView) identity.getChildAt(1),
                        section, (TextView) section.getChildAt(0), (TextView) section.getChildAt(1));
            }
            private static void storedApiChecks() {
                scenario = "fixture sensitivity only, not Android rendering/accessibility/touch evidence";
                TextView probe = new TextView(new Context());
                require(probe.getContentDescription() == null, "stored label defaults absent");
                probe.setContentDescription("one"); require("one".contentEquals(probe.getContentDescription()), "label round-trip");
                probe.setContentDescription("two"); require("two".contentEquals(probe.getContentDescription()), "label replacement observable");
                probe.setContentDescription(null); require(probe.getContentDescription() == null, "label clear observable");
                probe.setTextColor(17); require(probe.getCurrentTextColor() == 17, "color writes observable, not no-op setters");
                probe.setTextColor(29); require(probe.getCurrentTextColor() == 29, "color replacement observable");
                int[] clicks = {0}; probe.setOnClickListener(view -> clicks[0]++); probe.performClick();
                require(clicks[0] == 1, "fixture dispatches captured actual listener");
            }
            private static void completeText(TextView text, String reason) {
                var layout = text.getLayout();
                require(layout != null && text.getMeasuredWidth() > 0 && text.getMeasuredHeight() > 0
                                && layout.lineHeight() > 0 && layout.naturalHeight() > 0, reason + " nonzero text extent");
                int next = 0;
                for (var line : layout.lines()) {
                    require(line.start() == next && line.end() > next && line.visibleEnd() == line.end()
                                    && line.ellipsisCount() == 0 && Float.isFinite(line.advance())
                                    && line.advance() <= layout.contentWidth() + .01f,
                            reason + " all actual characters fit finite synthetic line bounds");
                    next = line.end();
                }
                require(next == text.getText().length()
                                && layout.naturalHeight() + text.getPaddingTop() + text.getPaddingBottom() <= text.getMeasuredHeight(),
                        reason + " complete text fits allocated height");
            }
            private static boolean visibleToPage(View view, NewTabPage page) {
                for (View current = view; current != null; current = current.getParent()) {
                    if (current.getVisibility() != View.VISIBLE) return false;
                    if (current == page) return true;
                }
                return false;
            }
            private static int historyActions(View view) {
                int found = view.hasOnClickListeners() && "历史记录".contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription()) ? 1 : 0;
                if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) found += historyActions(group.getChildAt(i));
                return found;
            }
            private static Header headerGeometry(NewTabPage page, Context context) throws Exception {
                Header h = header(page);
                require(h.history().getText().toString().equals("全部")
                                && "历史记录".contentEquals(h.history().getContentDescription() == null ? "" : h.history().getContentDescription()),
                        "HISTORY_LABEL visible 全部 has full accessible History name");
                require(h.history().hasOnClickListeners() && historyActions(page) == 1, "HISTORY_LABEL exactly one History callback");
                require(visibleToPage(h.history(), page), "HISTORY_REACHABLE History remains visible even for empty history");
                require(h.history().getMinimumWidth() >= dp(context, 48) && h.history().getMinimumHeight() >= dp(context, 48)
                                && h.history().getMeasuredWidth() >= dp(context, 48) && h.history().getMeasuredHeight() >= dp(context, 48),
                        "HISTORY_TARGET minimum and measured touch target at least48dp in both dimensions");
                require(h.wrapper().getLayoutParams().width == -1 && h.wrapper().getLayoutParams().height == -2
                                && h.section().getLayoutParams().width == -1 && h.section().getLayoutParams().height == -2,
                        "HEADER_LAYOUT full-width WRAP_CONTENT identity and recent section");
                for (TextView text : List.of(h.title(), h.hint())) {
                    require(text.getLayoutParams().width == -1 && text.getLayoutParams().height == -2
                                    && text.getMeasuredWidth() == h.wrapper().getMeasuredWidth(), "HEADER_LAYOUT full identity width independent of History");
                    completeText(text, "HEADER_TEXT");
                }
                require(!h.title().isSingleLine() && h.title().getEllipsize() == null
                                && h.hint().getText().toString().equals("历史记录按环境隔离")
                                && h.recent().getText().toString().equals("最近访问"), "HEADER_LAYOUT long profile wraps; concise identity metadata");
                font(h.title(), 17, context); font(h.hint(), 12.5f, context); font(h.recent(), 17, context); font(h.history(), 14, context);
                completeText(h.recent(), "SECTION_TEXT"); completeText(h.history(), "HISTORY_TEXT");
                require(h.recent().getRight() <= h.history().getLeft() && h.history().getRight() <= h.section().getMeasuredWidth(),
                        "SECTION_LAYOUT heading and History do not overlap at narrow/large font");
                require(h.history().getLayoutParams().height == -2 && h.section().getMeasuredHeight() >= h.history().getMeasuredHeight(),
                        "HISTORY_TARGET WRAP_CONTENT action/section grow rather than clip text");
                LinearLayout empty = (LinearLayout) field(page, "emptyState");
                require(empty.getChildCount() == 2 && empty.getBackground() == null && empty.getElevation() == 0,
                        "EMPTY_FLAT text-only empty state, no fake search card/badge/elevation");
                TextView emptyTitle = (TextView) empty.getChildAt(0), body = (TextView) empty.getChildAt(1);
                font(emptyTitle, 16, context); font(body, 13.5f, context);
                require(body.getText().toString().contains("顶部地址栏") && !body.hasOnClickListeners(), "EMPTY_OWNERSHIP honest toolbar instruction, not pseudo-input");
                if (empty.getVisibility() == View.VISIBLE) { completeText(emptyTitle, "EMPTY_TEXT"); completeText(body, "EMPTY_TEXT"); vertical(empty, false); }
                font((TextView) column(page).getChildAt(4), 11, context); vertical(h.wrapper(), false);
                return h;
            }
            private static String headerReceipt(Header h) {
                return "syntheticHeader=" + h.wrapper().getMeasuredWidth() + "x" + h.wrapper().getMeasuredHeight()
                        + ",identityWidth:" + h.title().getMeasuredWidth() + ",history:"
                        + h.history().getMeasuredWidth() + "x" + h.history().getMeasuredHeight()
                        + ",label:" + h.history().getContentDescription() + ",sectionVisible:" + h.section().getVisibility();
            }
            private static void setPalette(boolean dark) {
                NativeBrowserActivity.C_CANVAS = dark ? 0xff111111 : 0xfff7f7f7;
                NativeBrowserActivity.C_SURFACE = dark ? 0xff1d1d1d : 0xffffffff;
                NativeBrowserActivity.C_INK = dark ? 0xffeeeeee : 0xff171717;
                NativeBrowserActivity.C_MUTED = dark ? 0xffa8a8a8 : 0xff646464;
                NativeBrowserActivity.C_ACCENT = dark ? 0xffb7c8ee : 0xff314e79;
                NativeBrowserActivity.C_ACCENT_SOFT = dark ? 0xff29354a : 0xffe8edf6;
                NativeBrowserActivity.C_STROKE = dark ? 0xff3b3b3b : 0xffdedede;
                NativeBrowserActivity.C_RIPPLE = dark ? 0x1affffff : 0x14000000;
            }
            private static void palette(NewTabPage page) throws Exception {
                Header h = header(page);
                var background = (android.graphics.drawable.GradientDrawable) page.getBackground();
                require(background.color == NativeBrowserActivity.C_CANVAS && background.colors == null
                                && h.title().getCurrentTextColor() == NativeBrowserActivity.C_INK
                                && h.hint().getCurrentTextColor() == NativeBrowserActivity.C_MUTED
                                && h.recent().getCurrentTextColor() == NativeBrowserActivity.C_INK
                                && h.history().getCurrentTextColor() == NativeBrowserActivity.C_ACCENT, "PALETTE_STATIC flat page/identity/section colors update");
                var historyRipple = (android.graphics.drawable.RippleDrawable) h.history().getBackground();
                require(historyRipple.color == NativeBrowserActivity.C_RIPPLE
                                && ((android.graphics.drawable.GradientDrawable) historyRipple.mask).color == NativeBrowserActivity.C_SURFACE,
                        "PALETTE_STATIC History ripple/mask update");
                LinearLayout empty = (LinearLayout) field(page, "emptyState");
                require(((TextView) empty.getChildAt(0)).getCurrentTextColor() == NativeBrowserActivity.C_INK
                                && ((TextView) empty.getChildAt(1)).getCurrentTextColor() == NativeBrowserActivity.C_MUTED
                                && ((TextView) column(page).getChildAt(4)).getCurrentTextColor() == NativeBrowserActivity.C_MUTED,
                        "PALETTE_STATIC empty/footer update even when hidden");
                for (LinearLayout tile : tileList(page)) {
                    var tileBackground = (android.graphics.drawable.GradientDrawable) tile.getBackground();
                    var ripple = (android.graphics.drawable.RippleDrawable) tile.getForeground();
                    TextView avatar = (TextView) tile.getChildAt(0), title = (TextView) tile.getChildAt(1), meta = (TextView) tile.getChildAt(2);
                    require(tileBackground.color == NativeBrowserActivity.C_SURFACE && tileBackground.strokeColor == NativeBrowserActivity.C_STROKE
                                    && tileBackground.strokeWidth == dp(page.getContext(), 1) && tile.getElevation() == 0
                                    && ripple.color == NativeBrowserActivity.C_RIPPLE
                                    && ((android.graphics.drawable.GradientDrawable) ripple.mask).color == NativeBrowserActivity.C_SURFACE
                                    && avatar.getCurrentTextColor() == NativeBrowserActivity.C_ACCENT
                                    && ((android.graphics.drawable.GradientDrawable) avatar.getBackground()).color == NativeBrowserActivity.C_ACCENT_SOFT
                                    && title.getCurrentTextColor() == NativeBrowserActivity.C_INK && meta.getCurrentTextColor() == NativeBrowserActivity.C_MUTED,
                            "PALETTE_TILE tile/stroke/ripple/avatar/name/meta recolor in place without elevation");
                }
            }
            private static List<LinearLayout> tileList(NewTabPage page) throws Exception {
                LinearLayout tiles = (LinearLayout) field(page, "tiles"); List<LinearLayout> result = new ArrayList<>();
                for (int r = 0; r < tiles.getChildCount(); r++) {
                    LinearLayout row = (LinearLayout) tiles.getChildAt(r);
                    for (int c = 0; c < row.getChildCount(); c++) if (row.getChildAt(c) instanceof LinearLayout tile) result.add(tile);
                }
                return result;
            }
            private NtpTileOracle() { }
            private static void require(boolean condition, String message) { checks++; if (!condition) throw new AssertionError(message + " [" + scenario + "]"); }
            private static int dp(Context context, float value) { return Math.round(context.getResources().getDisplayMetrics().density * value); }
            private static Object field(Object owner, String name) throws Exception { var field = owner.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(owner); }
            private record Identity(View view, ViewGroup parent, ViewGroup.LayoutParams params, String text,
                    Object background, Object foreground, String label) { }
            private static void identities(View view, List<Identity> result) {
                result.add(new Identity(view, view.getParent(), view.getLayoutParams(), view instanceof TextView text ? text.getText().toString() : null,
                        view.getBackground(), view.getForeground(), view.getContentDescription() == null ? null : view.getContentDescription().toString()));
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
                View empty = (View) field(page, "emptyState");
                ScrollView scroll = (ScrollView) page.getChildAt(0); LinearLayout column = (LinearLayout) scroll.getChildAt(0);
                TextView footer = (TextView) column.getChildAt(column.getChildCount() - 1);
                require(column.getPaddingLeft() == dp(context, 18) && column.getPaddingRight() == dp(context, 18), "actual outer18dp constrains width");
                require(tiles.getMeasuredWidth() == page.getMeasuredWidth() - dp(context, 18) * 2, "real constrained tiles width");
                require(tiles.getChildCount() == (count + 2) / 3, "RANKED_CAP actual refresh row count respects max9");
                require(empty.getVisibility() == (count == 0 ? View.VISIBLE : View.GONE), "actual empty visibility follows ranked history");
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
            private static final class Actions implements NewTabPage.Listener {
                final List<String> navigations = new ArrayList<>(); int history;
                @Override public void onNtpNavigate(String url) { navigations.add(url); }
                @Override public void onNtpOpenHistory() { history++; }
            }
            private static void sameTree(NewTabPage page, List<Identity> before, String reason) {
                List<Identity> after = new ArrayList<>(); identities(page, after);
                require(after.size() == before.size(), reason + " complete tree size");
                for (int i = 0; i < before.size(); i++) {
                    Identity a = before.get(i), b = after.get(i);
                    require(a.view == b.view && a.parent == b.parent && a.params == b.params && a.background == b.background && a.foreground == b.foreground
                                    && java.util.Objects.equals(a.text, b.text) && java.util.Objects.equals(a.label, b.label),
                            reason + " original view/parent/LayoutParams/text/drawables/label identities");
                }
            }
            private static void layout(NewTabPage page, Context context, int width, int height) {
                page.measure(View.MeasureSpec.makeMeasureSpec(dp(context, width), View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(dp(context, height), View.MeasureSpec.EXACTLY));
                page.layout(0, 0, page.getMeasuredWidth(), page.getMeasuredHeight());
                require(page.getMeasuredWidth() == dp(context, width) && page.getMeasuredHeight() == dp(context, height), "finite constrained root dimensions");
            }
            private static void runCase(int width, float density, int count, int content) throws Exception { runSurface(width, density, count, content, "测试环境", false); }
            private static void runEmptyCase(int width, float density, String profile) throws Exception { runSurface(width, density, 0, 0, profile, true); }
            private static void runSurface(int width, float density, int supplied, int content, String profile, boolean extraEmpty) throws Exception {
                scenario = "constructor width=" + width + " density=" + density + " supplied=" + supplied + " content=" + content; setPalette(false);
                Context context = new Context(); context.getResources().getDisplayMetrics().density = density;
                View externalFocus = new View(context); context.focused = externalFocus;
                List<BrowserHistory.SiteVisit> visits = new ArrayList<>(); long now = System.currentTimeMillis() + 60000L;
                for (int i = 0; i < supplied; i++) {
                    boolean old = content == 1 || (content == 2 && i % 2 == 0);
                    visits.add(new BrowserHistory.SiteVisit("https://long-history-hostname-" + i + ".example", "真实长度测试标题" + i, old ? 946771200000L : now, old ? 9999 : 1));
                }
                BrowserHistoryStore store = new BrowserHistoryStore(visits); Actions actions = new Actions();
                NewTabPage page = new NewTabPage(context, store, profile, actions); inputOwnership(page, context, externalFocus); header(page);
                require(store.rankedCalls == 0, "constructor never invents a history query"); page.onShown();
                require(store.rankedCalls == 1, "actual onShown/refresh one ranked query"); Header originalHeader = header(page);
                String expectedName = profile == null || profile.trim().isEmpty() ? "默认环境" : profile.trim();
                require(originalHeader.title().getText().toString().equals(expectedName), "profile default/blank/Chinese/mixed name preserved");
                List<Identity> snapshot = new ArrayList<>(); identities(page, snapshot);
                LinearLayout tiles = (LinearLayout) field(page, "tiles"); ScrollView scroll = (ScrollView) page.getChildAt(0);
                Map<View, Integer> baseMeta = new IdentityHashMap<>(); int count = Math.min(supplied, 9);
                List<Integer> baseline = null, peak = null; int baseHeight = 0, peakHeight = 0, baseMetaTotal = 0, baseIdentityWidth = 0, scrollY = 0;
                float[] scales = {1, 1.3f, 2, 2, 1};
                for (int step = 0; step < scales.length; step++) {
                    float scale = scales[step]; scenario = (extraEmpty ? "EMPTY_PROFILE " : "TILES ") + "width=" + width + "dp density=" + density + " supplied=" + supplied
                            + " content=" + content + " profile=" + expectedName + " step=" + step + " font=" + scale;
                    context.getResources().getConfiguration().fontScale = scale; int requests = page.layoutRequests; page.applyFontScale();
                    require(page.layoutRequests > requests, "font rebind requests layout on original tree");
                    setPalette(step > 0 && step < 4); page.applyPalette(); palette(page); layout(page, context, width, 720); inputOwnership(page, context, externalFocus);
                    Header currentHeader = headerGeometry(page, context); int metaTotal = geometry(page, context, count, content, scale);
                    require(currentHeader.equals(originalHeader), "HEADER_IDENTITY same identity/section/text/action references");
                    if (step == 0) baseIdentityWidth = currentHeader.title().getMeasuredWidth();
                    require(currentHeader.title().getMeasuredWidth() == baseIdentityWidth, "HEADER_LAYOUT History/font growth cannot consume profile width");
                    sameTree(page, snapshot, "FONT_PALETTE_IDENTITY");
                    require(store.rankedCalls == 1 && store.removeCalls == 0 && actions.history == 0 && actions.navigations.isEmpty(), "font/palette never rebuild/requery/mutate history or navigate");
                    require(field(page, "tiles") == tiles, "same grid container through repeated live updates");
                    List<LinearLayout> actualTiles = tileList(page); require(actualTiles.size() == count, "RANKED_CAP genuine ranked results capped to9, no seeded/filler sites");
                    for (int i = 0; i < actualTiles.size(); i++) {
                        LinearLayout tile = actualTiles.get(i); TextView title = (TextView) tile.getChildAt(1), meta = (TextView) tile.getChildAt(2);
                        require(title.getText().toString().equals(NewTabPage.displayHostFor(visits.get(i).origin)), "RANKED_ORDER supplied ranked order retained");
                        if (step == 0) baseMeta.put(meta, meta.getMeasuredHeight());
                        if (scale == 2) require(meta.getMeasuredHeight() > baseMeta.get(meta), "individual metadata height grows under2x");
                    }
                    if (step == 0) { baseline = rectangles(page); baseHeight = tiles.getMeasuredHeight(); baseMetaTotal = metaTotal; scroll.scrollTo(0, 31); scrollY = scroll.getScrollY(); }
                    require(scroll.getScrollY() == scrollY, "SCROLL_STATE fixture offset retained across font/palette updates");
                    if (step == 2) { peak = rectangles(page); peakHeight = tiles.getMeasuredHeight(); }
                    if (step == 3) require(rectangles(page).equals(peak) && tiles.getMeasuredHeight() == peakHeight, "repeated2x idempotent geometry/ranges");
                    if (step == 4) require(rectangles(page).equals(baseline) && tiles.getMeasuredHeight() == baseHeight, "return1x restores exact geometry/ranges");
                    if (count > 0 && step == 2) require(tiles.getMeasuredHeight() > baseHeight && metaTotal > baseMetaTotal, "metadata growth propagates up to rows and tiles");
                    if (extraEmpty) { emptyTrace.write(scenario + (char) 9 + headerReceipt(currentHeader) + (char) 9 + "localEditors=0;historyActions=1;LIMIT=synthetic-state-only" + (char) 10); emptyTrace.flush(); emptyStates++; }
                    else { measurementReceipt(page, tiles); states++; }
                }
                require(originalHeader.history().performClick() && actions.history == 1 && actions.navigations.isEmpty(), "HISTORY_CALLBACK same real History callback in empty/populated states");
                List<LinearLayout> liveTiles = tileList(page);
                for (int i = 0; i < liveTiles.size(); i++) { liveTiles.get(i).performClick(); require(actions.navigations.get(i).equals(visits.get(i).origin), "RANKED_NAVIGATION exact origin matching each tile"); }
                int navigationCount = actions.navigations.size(), haptics = context.haptics;
                page.quiesce(); page.setVisibility(View.GONE); page.refresh(); page.onShown();
                require(store.rankedCalls == 1 && page.getVisibility() == View.GONE, "QUIESCENT_QUERY refresh/onShown cannot requery or reshow stopped profile");
                int requests = page.layoutRequests; page.applyFontScale(); require(page.layoutRequests == requests, "quiescent page does not rebind fonts");
                originalHeader.history().performClick(); for (LinearLayout tile : liveTiles) { tile.performClick(); tile.performLongClick(); }
                require(actions.history == 1 && actions.navigations.size() == navigationCount && context.haptics == haptics && store.removeCalls == 0 && field(page, "removalDialog") == null,
                        "QUIESCENT_ACTION no navigation/History/haptic/removal/dialog on stopped page");
                inputOwnership(page, context, externalFocus); sameTree(page, snapshot, "QUIESCENT_IDENTITY");
            }
            private static void retiredBindings() throws Exception {
                scenario = "retired tile bindings released on refresh and empty"; setPalette(false); Context context = new Context();
                BrowserHistoryStore store = new BrowserHistoryStore(List.of(new BrowserHistory.SiteVisit("https://old.example", "old", 946771200000L, 2)));
                NewTabPage page = new NewTabPage(context, store, "scope", new Actions()); page.onShown();
                LinearLayout oldTile = tileList(page).get(0); TextView oldMeta = (TextView) oldTile.getChildAt(2); int calls = oldMeta.textSizeCalls, color = oldMeta.getCurrentTextColor();
                store.visits = List.of(new BrowserHistory.SiteVisit("https://new.example", "new", 946771200000L, 3)); page.refresh();
                require(tileList(page).get(0) != oldTile && oldTile.getParent().getParent() == null, "refresh retires old row, not static page tree");
                context.getResources().getConfiguration().fontScale = 2; setPalette(true); page.applyFontScale(); page.applyPalette();
                require(oldMeta.textSizeCalls == calls && oldMeta.getCurrentTextColor() == color, "RETIRED_BINDINGS detached font/palette bindings never run again");
                font((TextView) tileList(page).get(0).getChildAt(2), 10.5f, context); palette(page);
                TextView nextMeta = (TextView) tileList(page).get(0).getChildAt(2); calls = nextMeta.textSizeCalls; color = nextMeta.getCurrentTextColor();
                store.visits = List.of(); page.refresh(); context.getResources().getConfiguration().fontScale = 1; setPalette(false); page.applyFontScale(); page.applyPalette();
                require(nextMeta.textSizeCalls == calls && nextMeta.getCurrentTextColor() == color && tileList(page).isEmpty(), "RETIRED_BINDINGS clear-to-empty also releases tile bindings");
                layout(page, context, 288, 720); headerGeometry(page, context);
            }
            private static void rankedProfilesAndConfirmation() throws Exception {
                scenario = "actual BrowserHistory ranking, injected profile boundaries and modeled confirmation"; setPalette(false);
                long now = System.currentTimeMillis(); BrowserHistory a = new BrowserHistory(), b = new BrowserHistory();
                for (int i = 0; i < 12; i++) a.recordVisit("https://profile-a-" + i + ".example/path", "A" + i, now - (12 - i) * 6000L);
                b.recordVisit("https://profile-b.example/private", "B", now); BrowserHistoryStore storeA = new BrowserHistoryStore(a), storeB = new BrowserHistoryStore(b);
                Actions actionsA = new Actions(), actionsB = new Actions(); Context contextA = new Context(), contextB = new Context();
                NewTabPage pageA = new NewTabPage(contextA, storeA, "A", actionsA), pageB = new NewTabPage(contextB, storeB, "B", actionsB);
                pageA.onShown(); pageB.onShown(); List<BrowserHistory.SiteVisit> ranked = a.ranked();
                require(tileList(pageA).size() == 9 && tileList(pageB).size() == 1, "actual ranking feeds max9 tiles, separate supplied profile stores");
                for (int i = 0; i < 9; i++) { tileList(pageA).get(i).performClick(); require(actionsA.navigations.get(i).equals(ranked.get(i).origin), "RANKED_ORDER actual most-recent order, not insertion order"); }
                require(((TextView) tileList(pageB).get(0).getChildAt(1)).getText().toString().equals("profile-b.example"), "profile B never displays profile A sites");
                List<Identity> profileB = new ArrayList<>(); identities(pageB, profileB); LinearLayout tile = tileList(pageA).get(0); String origin = ranked.get(0).origin; int toasts = android.widget.Toast.shown;
                require(tile.performLongClick(), "actual long-press listener consumes removal request"); android.app.Dialog cancel = (android.app.Dialog) field(pageA, "removalDialog");
                require(cancel != null && cancel.title.equals("移除该站点？") && cancel.action.equals("移除") && cancel.body.contains(NewTabPage.displayHostFor(origin)) && storeA.removeCalls == 0,
                        "REMOVAL_CONFIRM real origin named, no mutation before explicit confirm");
                cancel.dismiss(); require(field(pageA, "removalDialog") == null && storeA.removeCalls == 0 && android.widget.Toast.shown == toasts, "REMOVAL_CANCEL cancel has no mutation/success feedback");
                tile.performLongClick(); android.app.Dialog confirm = (android.app.Dialog) field(pageA, "removalDialog"); pageA.applyFontScale(); pageA.applyPalette();
                require(field(pageA, "removalDialog") == confirm && confirm.fontCalls == 1 && confirm.paletteCalls == 1, "DIALOG_STATE live font/palette dispatch retains open dialog");
                confirm.confirm();
                require(storeA.removeCalls == 1 && origin.equals(storeA.removedOrigin) && storeA.rankedCalls == 2 && a.size() == 11 && android.widget.Toast.shown == toasts + 1 && field(pageA, "removalDialog") == null,
                        "REMOVAL_CONFIRM explicit confirm removes exact site, refreshes ranking, emits success");
                require(!((TextView) tileList(pageA).get(0).getChildAt(1)).getText().toString().equals(NewTabPage.displayHostFor(origin)), "removed site absent from refreshed tiles");
                sameTree(pageB, profileB, "PROFILE_ISOLATION"); require(b.size() == 1 && storeB.removeCalls == 0 && storeB.rankedCalls == 1, "profile B model/store untouched");
                tile = tileList(pageA).get(0); tile.performLongClick(); android.app.Dialog pending = (android.app.Dialog) field(pageA, "removalDialog");
                Runnable staleConfirm = pending.callback; int queries = storeA.rankedCalls, nav = actionsA.navigations.size(), haptics = contextA.haptics;
                pageA.quiesce(); require(!pending.showing && field(pageA, "removalDialog") == null, "QUIESCENT_DIALOG dismiss and clear pending confirmation");
                staleConfirm.run(); tile.performClick(); tile.performLongClick(); header(pageA).history().performClick(); pageA.setVisibility(View.GONE); pageA.onShown(); pageA.refresh();
                require(storeA.removeCalls == 1 && storeA.rankedCalls == queries && actionsA.navigations.size() == nav && actionsA.history == 0 && contextA.haptics == haptics && android.widget.Toast.shown == toasts + 1 && field(pageA, "removalDialog") == null,
                        "QUIESCENT_CONFIRM late callback/click/long-press/History cannot touch stopped profile");
                BrowserHistory last = new BrowserHistory(); last.recordVisit("https://last.example", "last", now);
                NewTabPage lastPage = new NewTabPage(new Context(), new BrowserHistoryStore(last), "last", new Actions()); lastPage.onShown();
                tileList(lastPage).get(0).performLongClick(); ((android.app.Dialog) field(lastPage, "removalDialog")).confirm();
                require(last.size() == 0 && tileList(lastPage).isEmpty() && ((View) field(lastPage, "emptyState")).getVisibility() == View.VISIBLE, "REMOVAL_EMPTY last-site confirm exposes real empty state");
                layout(lastPage, lastPage.getContext(), 288, 720); headerGeometry(lastPage, lastPage.getContext());
            }
            private static void nonzeroScrollState() throws Exception {
                scenario = "nonzero retained synthetic scroll, not Android lifecycle"; setPalette(false); Context context = new Context(); List<BrowserHistory.SiteVisit> visits = new ArrayList<>();
                for (int i = 0; i < 9; i++) visits.add(new BrowserHistory.SiteVisit("https://scroll-" + i + ".example", "scroll", 946771200000L, 9999));
                NewTabPage page = new NewTabPage(context, new BrowserHistoryStore(visits), "scroll", new Actions()); page.onShown(); layout(page, context, 288, 320);
                ScrollView scroll = (ScrollView) page.getChildAt(0); scroll.scrollTo(0, 37); require(scroll.getScrollY() == 37, "SCROLL_STATE dedicated fixture has nonzero offset");
                List<Identity> snapshot = new ArrayList<>(); identities(page, snapshot);
                for (float scale : new float[]{1.3f, 2, 2, 1}) { context.getResources().getConfiguration().fontScale = scale; setPalette(scale != 1); page.applyFontScale(); page.applyPalette(); layout(page, context, 288, 320);
                    require(scroll.getScrollY() == 37, "SCROLL_STATE nonzero offset survives live font/palette cycles"); sameTree(page, snapshot, "SCROLL_IDENTITY"); }
            }
            public static int run(String receiptPath) throws Exception {
                try (var writer = java.nio.file.Files.newBufferedWriter(java.nio.file.Path.of(receiptPath));
                        var emptyWriter = java.nio.file.Files.newBufferedWriter(java.nio.file.Path.of(receiptPath).resolveSibling("empty-profile.tsv"))) {
                    trace = writer; emptyTrace = emptyWriter; storedApiChecks();
                    for (int width : new int[]{288, 320, 412}) for (float density : new float[]{1, 2.625f})
                        for (int count : new int[]{0, 1, 3, 4, 9, 12}) for (int content = 0; content < 3; content++) {
                            runCase(width, density, count, content); cases++;
                        }
                    require(cases == 108 && states == 540, "complete108case/540state matrix, including >9 real results");
                    for (int width : new int[]{288, 320, 412}) for (float density : new float[]{1, 2.625f})
                        for (String profile : new String[]{null, "  ", "这是用于窄屏大字检验的长中文环境名称", "Route104 alpha-beta mixed 环境名称"}) {
                            runEmptyCase(width, density, profile); emptyCases++;
                        }
                    require(emptyCases == 24 && emptyStates == 120, "separate24case/120state empty-profile matrix");
                    retiredBindings(); rankedProfilesAndConfirmation(); nonzeroScrollState();
                    return checks;
                }
            }
        }
        """;
}
