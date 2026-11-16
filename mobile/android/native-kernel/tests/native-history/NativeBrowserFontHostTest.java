import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.Tree;
import com.sun.source.util.JavacTask;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

/**
 * Executes production SP bindings, all five font-dispatch paths, popup remeasurement and dialog
 * measurement policy. Fixtures deliberately use a synthetic NONLINEAR conversion to expose px
 * freezing and cumulative scale multiplication. They are NOT Android's converter or widget
 * measurement and cannot establish Android typography, IME/native identity or visual acceptance.
 */
public final class NativeBrowserFontHostTest {
    private NativeBrowserFontHostTest() { }

    private static Map<String, String> members(JavaCompiler compiler, Path source) throws Exception {
        Map<String, String> result = new HashMap<>();
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, null, List.of("-proc:none", "--release", "17"),
                    null, files.getJavaFileObjects(source));
            for (CompilationUnitTree unit : task.parse()) {
                for (Tree top : unit.getTypeDecls()) {
                    if (!(top instanceof ClassTree type)) continue;
                    for (Tree member : type.getMembers()) {
                        if (member instanceof ClassTree nested) result.put(nested.getSimpleName().toString(), nested.toString());
                        if (member instanceof MethodTree method) result.put(method.getName().toString(), method.toString());
                    }
                }
            }
        }
        return result;
    }

    private static String select(Map<String, String> members, String... names) {
        StringBuilder code = new StringBuilder();
        for (String name : names) {
            if (!members.containsKey(name)) throw new AssertionError("Missing production member " + name);
            code.append(members.get(name)).append('\n');
        }
        return code.toString();
    }

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]).toAbsolutePath();
        Path output = Path.of(args[1]).toAbsolutePath().resolve("font-host");
        Path source = root.resolve("mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel");
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        String host = HOST.replace("@ACTIVITY@", select(members(compiler, source.resolve("NativeBrowserActivity.java")),
                "FontBindings", "PaletteBindings", "dp", "applySurfaceFonts", "applySurfacePalette", "onConfigurationChanged", "resizeOverflowMenu"))
                .replace("@NTP@", select(members(compiler, source.resolve("NewTabPage.java")), "applyFontScale"))
                .replace("@HISTORY@", select(members(compiler, source.resolve("HistoryPanel.java")), "applyFontScale"))
                .replace("@OVERVIEW@", select(members(compiler, source.resolve("TabSwitcherView.java")), "applyFontScale"))
                .replace("@DIALOG@", select(members(compiler, source.resolve("BrowserDialogs.java")),
                        "ThemedDialog", "applyFontScale", "DialogPanel", "DialogActions", "dp"));
        List<Path> paths = new ArrayList<>();
        Files.createDirectories(output);
        Path owner = output.resolve("NativeBrowserActivity.java");
        Files.writeString(owner, host, StandardCharsets.UTF_8);
        paths.add(owner);
        for (String[] fixture : FIXTURES) {
            Path path = output.resolve(fixture[0] + ".java");
            Files.createDirectories(path.getParent());
            Files.writeString(path, fixture[1], StandardCharsets.UTF_8);
            paths.add(path);
        }
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            boolean compiled = compiler.getTask(null, files, null,
                    List.of("--release", "17", "-Xlint:all", "-Werror", "-d", output.toString()), null,
                    files.getJavaFileObjectsFromPaths(paths)).call();
            if (!compiled) throw new AssertionError("Actual font/reflow members did not compile on fake host");
        }
        try (URLClassLoader loader = new URLClassLoader(new URL[]{output.toUri().toURL()}, NativeBrowserFontHostTest.class.getClassLoader())) {
            Object count = loader.loadClass("NativeBrowserActivity").getMethod("run").invoke(null);
            System.out.println(count + " source-extracted font ownership/reflow fake-host checks passed (not Android runtime acceptance)");
        }
    }

    private static final String[][] FIXTURES = {
        {"android/util/TypedValue", "package android.util; public final class TypedValue { public static final int COMPLEX_UNIT_SP = 2; }"},
        {"android/util/DisplayMetrics", "package android.util; public final class DisplayMetrics { public float density = 1; public int widthPixels = 400, heightPixels = 800; }"},
        {"android/content/res/Configuration", "package android.content.res; public final class Configuration { public float fontScale = 1; }"},
        {"android/content/res/Resources", """
            package android.content.res;
            public final class Resources {
                final android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
                final Configuration config = new Configuration();
                public android.util.DisplayMetrics getDisplayMetrics() { return metrics; }
                public Configuration getConfiguration() { return config; }
            }
            """},
        {"android/content/Context", """
            package android.content;
            public class Context {
                final android.content.res.Resources resources = new android.content.res.Resources();
                public android.content.res.Resources getResources() { return resources; }
            }
            """},
        {"android/view/Gravity", "package android.view; public final class Gravity { public static final int CENTER_VERTICAL = 16; }"},
        {"android/view/View", """
            package android.view;
            public class View {
                private final android.content.Context context;
                public int measuredWidth, measuredHeight, naturalWidth, naturalHeight, minHeight, layoutRequests;
                private int pl, pt, pr, pb;
                private android.view.ViewGroup.LayoutParams params = new android.view.ViewGroup.LayoutParams(-2, -2);
                public View(android.content.Context context) { this.context = context; }
                public android.content.Context getContext() { return context; }
                public android.content.res.Resources getResources() { return context.getResources(); }
                public static final class MeasureSpec {
                    public static final int EXACTLY = 0x40000000, AT_MOST = 0x80000000, UNSPECIFIED = 0;
                    public static int getSize(int spec) { return spec & 0x3fffffff; }
                    public static int getMode(int spec) { return spec & 0xc0000000; }
                    public static int makeMeasureSpec(int size, int mode) { return size | mode; }
                }
                public static int resolveSize(int size, int spec) {
                    if (MeasureSpec.getMode(spec) == MeasureSpec.EXACTLY) return MeasureSpec.getSize(spec);
                    if (MeasureSpec.getMode(spec) == MeasureSpec.AT_MOST) return Math.min(size, MeasureSpec.getSize(spec));
                    return size;
                }
                public final void measure(int width, int height) { onMeasure(width, height); }
                protected void onMeasure(int width, int height) {
                    setMeasuredDimension(resolveSize(naturalWidth + pl + pr, width),
                            resolveSize(Math.max(minHeight, naturalHeight + pt + pb), height));
                }
                protected final void setMeasuredDimension(int width, int height) { measuredWidth = width; measuredHeight = height; }
                public int getMeasuredWidth() { return measuredWidth; }
                public int getMeasuredHeight() { return measuredHeight; }
                public int getPaddingLeft() { return pl; }
                public int getPaddingRight() { return pr; }
                public int getPaddingTop() { return pt; }
                public int getPaddingBottom() { return pb; }
                public void setPadding(int left, int top, int right, int bottom) { pl = left; pt = top; pr = right; pb = bottom; }
                public android.view.ViewGroup.LayoutParams getLayoutParams() { return params; }
                public void setLayoutParams(android.view.ViewGroup.LayoutParams value) { params = value; }
                public void requestLayout() { layoutRequests++; }
            }
            """},
        {"android/view/ViewGroup", """
            package android.view;
            public class ViewGroup extends View {
                public ViewGroup(android.content.Context context) { super(context); }
                public static class LayoutParams {
                    public int width, height;
                    public LayoutParams(int width, int height) { this.width = width; this.height = height; }
                }
            }
            """},
        {"android/view/Window", """
            package android.view;
            public final class Window {
                final View decor;
                public Window(android.content.Context context) { decor = new View(context); }
                public View getDecorView() { return decor; }
            }
            """},
        {"android/app/Dialog", """
            package android.app;
            public class Dialog {
                private final android.view.Window window;
                public boolean showing = true;
                public Dialog(android.content.Context context) { window = new android.view.Window(context); }
                public android.view.Window getWindow() { return window; }
                public void dismiss() { showing = false; }
            }
            """},
        {"android/widget/TextView", """
            package android.widget;
            public class TextView extends android.view.View {
                public float originalSp, px;
                public int writes, unit, selectionStart = 2, selectionEnd = 5;
                public boolean focused = true;
                public String text = "draft.example/草稿";
                public TextView(android.content.Context context) { super(context); }
                public static float convert(float sp, float scale) { return sp * (1 + (scale - 1) * 18 / (sp + 18)); }
                public void setTextSize(int unit, float sp) {
                    if (unit != android.util.TypedValue.COMPLEX_UNIT_SP) throw new AssertionError("Explicit SP required");
                    this.unit = unit; originalSp = sp; writes++;
                    px = convert(sp, getResources().getConfiguration().fontScale) * getResources().getDisplayMetrics().density;
                    naturalWidth = (int) Math.ceil(text.length() * px * 0.6f);
                    naturalHeight = (int) Math.ceil(px * 1.2f);
                }
            }
            """},
        {"android/widget/LinearLayout", """
            package android.widget;
            import android.view.View;
            public class LinearLayout extends View {
                public static final int HORIZONTAL = 0, VERTICAL = 1;
                public static final class LayoutParams extends android.view.ViewGroup.LayoutParams {
                    public int leftMargin, topMargin, rightMargin, bottomMargin;
                    public float weight;
                    public LayoutParams(int width, int height) { super(width, height); }
                    public LayoutParams(int width, int height, float weight) { this(width, height); this.weight = weight; }
                }
                private final java.util.List<View> children = new java.util.ArrayList<>();
                private int orientation;
                public LinearLayout(android.content.Context context) { super(context); }
                public void setOrientation(int value) { orientation = value; }
                public int getOrientation() { return orientation; }
                public void setGravity(int value) { }
                public void addView(View child, LayoutParams params) { child.setLayoutParams(params); children.add(child); }
                public View getChildAt(int index) { return children.get(index); }
                @Override protected void onMeasure(int widthSpec, int heightSpec) {
                    int width = MeasureSpec.getSize(widthSpec), totalH = 0, maxW = 0, totalW = 0;
                    float weights = 0;
                    int margins = 0;
                    for (View child : children) { LayoutParams lp = (LayoutParams) child.getLayoutParams(); weights += lp.weight; margins += lp.leftMargin + lp.rightMargin; }
                    for (View child : children) {
                        LayoutParams lp = (LayoutParams) child.getLayoutParams();
                        int childWidth = width - lp.leftMargin - lp.rightMargin;
                        int mode = lp.width == -1 ? MeasureSpec.EXACTLY : MeasureSpec.AT_MOST;
                        if (orientation == HORIZONTAL && weights > 0) { childWidth = (int)((width - margins) * lp.weight / weights); mode = MeasureSpec.EXACTLY; }
                        child.measure(MeasureSpec.makeMeasureSpec(Math.max(0, childWidth), mode),
                                MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
                        int h = child.getMeasuredHeight() + lp.topMargin + lp.bottomMargin;
                        int w = child.getMeasuredWidth() + lp.leftMargin + lp.rightMargin;
                        totalH = orientation == VERTICAL ? totalH + h : Math.max(totalH, h);
                        totalW += w; maxW = Math.max(maxW, w);
                    }
                    setMeasuredDimension(resolveSize(orientation == VERTICAL ? maxW : totalW, widthSpec), resolveSize(totalH, heightSpec));
                }
            }
            """},
        {"android/widget/ScrollView", """
            package android.widget;
            public final class ScrollView extends android.view.View {
                public int scrollY = 91;
                public ScrollView(android.content.Context context) { super(context); }
            }
            """},
        {"android/widget/PopupWindow", """
            package android.widget;
            public final class PopupWindow {
                public boolean showing = true;
                public int available = 180, updates, width, height;
                public boolean isShowing() { return showing; }
                public int getMaxAvailableHeight(android.view.View anchor, int offset) { return available; }
                public void update(int width, int height) { this.width = width; this.height = height; updates++; }
            }
            """}
    };

    private static final String HOST = """
        import android.app.Dialog;
        import android.content.Context;
        import android.view.Gravity;
        import android.view.View;
        import android.view.Window;
        import android.widget.LinearLayout;
        import android.widget.PopupWindow;
        import android.widget.ScrollView;
        import android.widget.TextView;
        import java.util.ArrayList;
        import java.util.List;
        class FontBase extends Context {
            final List<String> order = new ArrayList<>();
            public void onConfigurationChanged(android.content.res.Configuration config) { order.add("super"); }
        }
        public final class NativeBrowserActivity extends FontBase {
            @ACTIVITY@
            static boolean C_DARK, requestedDark;
            static int checks;
            boolean closed, quiescing, cleanupComplete, resumed, uiBuilt;
            float appliedFontScale = 1;
            final Object manager = new Object(), shell = new Object(), nativeWindow = new Object();
            final FontBindings chromeFonts = new FontBindings(), overflowFonts = new FontBindings(), suggestionFonts = new FontBindings();
            Runnable overflowResize;
            PopupWindow overflowMenu;
            NewTabPage newTab;
            HistoryPanel historyPanel;
            TabSwitcherView tabSwitcher;
            int palettePasses, refreshes;
            static void resolvePalette(NativeBrowserActivity owner) { C_DARK = requestedDark; }
            void applyChromePalette() { palettePasses++; }
            void requestChromeRefresh() { refreshes++; }
            static final class NewTabPage {
                boolean quiescing;
                final FontBindings staticFonts = new FontBindings(), tileFonts = new FontBindings();
                Dialog removalDialog;
                @NTP@
                void applyPalette() { }
            }
            static final class HistoryPanel {
                boolean quiescing;
                final FontBindings staticFonts = new FontBindings(), rowFonts = new FontBindings();
                Dialog clearDialog, rowDialog;
                @HISTORY@
                void applyPalette() { }
            }
            static final class TabSwitcherView {
                final FontBindings staticFonts = new FontBindings(), cardFonts = new FontBindings();
                final List<String> order;
                TabSwitcherView(List<String> order) { this.order = order; }
                void retainPaletteAnchor() { order.add("anchor"); }
                @OVERVIEW@
                void applyPalette() { }
            }
            static final class BrowserDialogs { @DIALOG@ }
            static void check(boolean ok, String message) { checks++; if (!ok) throw new AssertionError(message); }
            static TextView bind(Context context, FontBindings bindings, float sp) {
                TextView view = new TextView(context); bindings.bind(view, sp); return view;
            }
            static BrowserDialogs.ThemedDialog dialog(Context context) {
                BrowserDialogs.ThemedDialog dialog = new BrowserDialogs.ThemedDialog(context);
                bind(context, dialog.fonts, 19); bind(context, dialog.fonts, 14.5f);
                bind(context, dialog.fonts, 14.5f); bind(context, dialog.fonts, 14.5f);
                return dialog;
            }
            static void bindingSemantics() {
                Context context = new Context();
                // All distinct original-SP roles from the 51-site production audit.
                for (float role : new float[]{10, 10.5f, 11, 11.5f, 12, 12.5f, 13, 13.5f, 14, 14.5f, 15, 15.5f, 16, 17, 18, 19, 20, 23}) {
                    FontBindings fonts = new FontBindings();
                    context.getResources().getConfiguration().fontScale = 1;
                    TextView view = bind(context, fonts, role);
                    check(view.px == role && view.writes == 1, "initial original SP " + role);
                    int writes = 1;
                    for (float scale : new float[]{1, 1.3f, 2, 2, 1}) {
                        context.getResources().getConfiguration().fontScale = scale;
                        fonts.apply(); writes++;
                        check(view.originalSp == role && view.unit == 2, "no cumulative role scaling " + role + ":" + scale);
                        check(view.px == TextView.convert(role, scale), "framework receives SP at current nonlinear fixture scale " + role + ":" + scale);
                        check(view.writes == writes, "one application per explicit binding pass");
                        check(view.focused && view.selectionStart == 2 && view.selectionEnd == 5 && view.text.equals("draft.example/草稿"), "text/focus/selection unchanged");
                    }
                    fonts.clear(); fonts.apply();
                    check(view.writes == writes, "retired role is not retained " + role);
                }
                check(TextView.convert(10, 2) / 10 != TextView.convert(23, 2) / 23, "fixture is intentionally nonlinear, not Android converter proof");
            }
            static void dispatchContinuity() {
                for (int state = 0; state < 4; state++) {
                    NativeBrowserActivity owner = new NativeBrowserActivity();
                    owner.resumed = (state & 1) != 0; owner.uiBuilt = (state & 2) != 0;
                    owner.newTab = new NewTabPage(); owner.historyPanel = new HistoryPanel();
                    owner.tabSwitcher = new TabSwitcherView(owner.order);
                    NewTabPage ntp = owner.newTab; HistoryPanel history = owner.historyPanel; TabSwitcherView tabs = owner.tabSwitcher;
                    ntp.removalDialog = dialog(owner); history.clearDialog = dialog(owner); history.rowDialog = dialog(owner);
                    Dialog remove = ntp.removalDialog, clear = history.clearDialog, row = history.rowDialog;
                    Object manager = owner.manager, shell = owner.shell, window = owner.nativeWindow;
                    List<TextView> views = new ArrayList<>();
                    for (FontBindings fonts : List.of(owner.chromeFonts, owner.overflowFonts, owner.suggestionFonts,
                            ntp.staticFonts, ntp.tileFonts, history.staticFonts, history.rowFonts, tabs.staticFonts, tabs.cardFonts,
                            ((BrowserDialogs.ThemedDialog) remove).fonts, ((BrowserDialogs.ThemedDialog) clear).fonts,
                            ((BrowserDialogs.ThemedDialog) row).fonts)) views.add(bind(owner, fonts, 14.5f));
                    int[] popupUpdates = {0}; owner.overflowResize = () -> popupUpdates[0]++;
                    C_DARK = requestedDark = false;
                    int passes = 0; float previous = 1;
                    for (float scale : new float[]{1, 1.3f, 1.3f, 2, 1}) {
                        // Resources is already updated BEFORE onConfigurationChanged is entered.
                        owner.getResources().getConfiguration().fontScale = scale;
                        android.content.res.Configuration config = new android.content.res.Configuration(); config.fontScale = scale;
                        if (scale == 2) requestedDark = true;
                        owner.order.clear(); owner.onConfigurationChanged(config);
                        if (scale != previous) passes++;
                        check(owner.order.size() >= 2 && owner.order.get(0).equals("anchor") && owner.order.get(1).equals("super"), "anchor captured before super " + state);
                        for (TextView view : views) {
                            check(view.writes == 1 + passes && view.px == TextView.convert(14.5f, scale), "all live/hidden native roles update once " + state + ":" + scale);
                            check(view.focused && view.selectionStart == 2 && view.selectionEnd == 5 && view.text.equals("draft.example/草稿"), "draft/focus/selection retained " + state);
                        }
                        check(owner.newTab == ntp && owner.historyPanel == history && owner.tabSwitcher == tabs
                                && ntp.removalDialog == remove && history.clearDialog == clear && history.rowDialog == row, "surface/dialog identities retained");
                        check(owner.manager == manager && owner.shell == shell && owner.nativeWindow == window, "host owner handles unchanged (not native runtime identity proof)");
                        check(popupUpdates[0] == passes, "same live popup dispatch follows real font deltas");
                        check(owner.appliedFontScale == scale, "last applied font updated");
                        previous = scale;
                    }
                    check(owner.palettePasses == 1, "combined night/font event still paints once");
                    int writes = views.get(0).writes;
                    requestedDark = false; android.content.res.Configuration sameFont = new android.content.res.Configuration();
                    owner.onConfigurationChanged(sameFont);
                    check(owner.palettePasses == 2 && views.get(0).writes == writes, "night-only event does not refont");
                    TextView retired = bind(owner, ntp.tileFonts, 16);
                    ntp.tileFonts.clear(); TextView replacement = bind(owner, ntp.tileFonts, 16);
                    owner.getResources().getConfiguration().fontScale = 2; owner.applySurfaceFonts();
                    check(retired.writes == 1 && replacement.writes == 2, "retired tile owner is not updated");
                    TextView dismissed = bind(owner, ((BrowserDialogs.ThemedDialog) remove).fonts, 19);
                    remove.dismiss(); BrowserDialogs.applyFontScale(remove);
                    check(dismissed.writes == 1, "actual ThemedDialog.dismiss releases bindings");
                }
                for (int terminal = 0; terminal < 3; terminal++) {
                    NativeBrowserActivity owner = new NativeBrowserActivity();
                    TextView view = bind(owner, owner.chromeFonts, 16);
                    owner.closed = terminal == 0; owner.quiescing = terminal == 1; owner.cleanupComplete = terminal == 2;
                    owner.getResources().getConfiguration().fontScale = 2; owner.applySurfaceFonts();
                    check(view.writes == 1, "terminal owner cannot update fonts " + terminal);
                }
                NativeBrowserActivity startup = new NativeBrowserActivity();
                startup.getResources().getConfiguration().fontScale = 1.3f;
                android.content.res.Configuration config = new android.content.res.Configuration(); config.fontScale = 1.3f;
                startup.onConfigurationChanged(config);
                TextView late = bind(startup, startup.chromeFonts, 19);
                check(late.px == TextView.convert(19, 1.3f) && startup.appliedFontScale == 1.3f, "startup null surfaces and later construction use current font");
                NewTabPage quietNtp = new NewTabPage(); HistoryPanel quietHistory = new HistoryPanel();
                TextView ntpView = bind(startup, quietNtp.staticFonts, 17), historyView = bind(startup, quietHistory.rowFonts, 14);
                quietNtp.quiescing = quietHistory.quiescing = true; quietNtp.applyFontScale(); quietHistory.applyFontScale();
                check(ntpView.writes == 1 && historyView.writes == 1, "draining surface owners do not update fonts");
            }
            static void popupBoundsAndRetirement() {
                NativeBrowserActivity owner = new NativeBrowserActivity();
                PopupWindow popup = owner.overflowMenu = new PopupWindow();
                ScrollView scroll = new ScrollView(owner); View anchor = new View(owner);
                scroll.naturalHeight = 1200;
                owner.resizeOverflowMenu(popup, scroll, anchor);
                check(popup.height == 180 && popup.width == 288 && popup.updates == 1, "live popup uses bounded natural measurement");
                popup.available = 94; owner.getResources().getDisplayMetrics().widthPixels = 250;
                owner.resizeOverflowMenu(popup, scroll, anchor);
                check(popup.height == 94 && popup.width == 226 && popup.updates == 2, "real anchor/viewport dimensions remeasure same popup");
                check(owner.overflowMenu == popup && scroll.scrollY == 91, "popup identity and scroll remain untouched");
                owner.overflowMenu = new PopupWindow(); owner.resizeOverflowMenu(popup, scroll, anchor);
                check(popup.updates == 2, "late retired popup callback cannot update a replacement");
                owner.overflowMenu = popup; popup.showing = false; owner.resizeOverflowMenu(popup, scroll, anchor);
                check(popup.updates == 2, "dismissed popup never updates");
            }
            static int spec(int size, int mode) { return View.MeasureSpec.makeMeasureSpec(size, mode); }
            static void dialogBudgetAndCompleteActions() {
                Context context = new Context();
                BrowserDialogs.DialogPanel panel = new BrowserDialogs.DialogPanel(context);
                panel.setPadding(20, 20, 20, 16);
                View body = new View(context); body.naturalHeight = 1600;
                BrowserDialogs.DialogActions actions = new BrowserDialogs.DialogActions(context);
                TextView cancel = new TextView(context), confirm = new TextView(context);
                cancel.text = "取消"; confirm.text = "删除全部历史记录";
                cancel.setPadding(16, 10, 16, 10); confirm.setPadding(16, 10, 16, 10);
                cancel.minHeight = confirm.minHeight = 50;
                FontBindings fonts = new FontBindings(); fonts.bind(cancel, 14.5f); fonts.bind(confirm, 14.5f);
                actions.addView(cancel, new LinearLayout.LayoutParams(0, -2, 1));
                LinearLayout.LayoutParams positive = new LinearLayout.LayoutParams(0, -2, 1.25f); positive.leftMargin = 10;
                actions.addView(confirm, positive);
                panel.addView(body, new LinearLayout.LayoutParams(-1, -2));
                LinearLayout.LayoutParams actionParams = new LinearLayout.LayoutParams(-1, -2); actionParams.topMargin = 20;
                panel.addView(actions, actionParams);
                panel.measure(spec(240, View.MeasureSpec.EXACTLY), spec(300, View.MeasureSpec.AT_MOST));
                check(actions.getOrientation() == LinearLayout.HORIZONTAL, "default font fits both measured weighted allocations");
                context.getResources().getConfiguration().fontScale = 2; fonts.apply();
                panel.measure(spec(240, View.MeasureSpec.EXACTLY), spec(200, View.MeasureSpec.AT_MOST));
                check(actions.getOrientation() == LinearLayout.VERTICAL, "large measured labels stack instead of shrinking/truncating");
                check(cancel.originalSp == 14.5f && confirm.originalSp == 14.5f, "complete actions retain original SP roles");
                check(cancel.getMeasuredWidth() >= cancel.naturalWidth + 32 && confirm.getMeasuredWidth() >= confirm.naturalWidth + 32, "both complete labels fit stacked width");
                check(panel.getMeasuredHeight() == 200 && body.getMeasuredHeight() == 200 - 36 - 20 - actions.getMeasuredHeight(), "bounded body reserves complete actions in a short window");
                check(actions.getMeasuredHeight() == cancel.getMeasuredHeight() + confirm.getMeasuredHeight() + 10, "stacked actions retain both natural heights and gap");
                panel.measure(spec(400, View.MeasureSpec.EXACTLY), spec(400, View.MeasureSpec.AT_MOST));
                check(actions.getOrientation() == LinearLayout.HORIZONTAL && positive.topMargin == 0 && positive.leftMargin == 10, "real wider content fit restores horizontal layout");
                context.getResources().getConfiguration().fontScale = 1; fonts.apply();
                panel.measure(spec(240, View.MeasureSpec.EXACTLY), spec(300, View.MeasureSpec.AT_MOST));
                check(actions.getOrientation() == LinearLayout.HORIZONTAL && cancel.px == 14.5f, "font restoration reverses typography and action reflow");
            }
            public static int run() {
                bindingSemantics(); dispatchContinuity(); popupBoundsAndRetirement(); dialogBudgetAndCompleteActions();
                return checks;
            }
        }
        """;
}
