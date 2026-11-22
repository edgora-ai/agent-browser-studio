import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import java.lang.reflect.InvocationTargetException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.HashMap;
import java.util.Map;
import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

/**
 * Compiles the entire production TabSwitcherView against deterministic host View fixtures.
 * Exercises its actual refresh/bind/measure/layout code, including a transient empty-grid clamp.
 * Also extracts the actual Activity window-palette and root-inset methods. Models both a clamp
 * before palette pre-draw and the observed f2 ordering: palette pre-draw finishes, a later root
 * inset event causes super.onLayout to clamp, and a subsequent real inset restores the range.
 * Arbitrary deltas, all card rectangles/identities, cancellation, reflow and idle are asserted.
 * This is not Android rendering, a real ScrollView measurement test, or device/theme acceptance.
 */
public final class NativeTabSwitcherHostTest {
    private NativeTabSwitcherHostTest() { }

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]).toAbsolutePath();
        Path output = Path.of(args[1]).toAbsolutePath().resolve("tab-switcher-host");
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        Map<String, String> windowMembers = new HashMap<>();
        Path activity = root.resolve("mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel/NativeBrowserActivity.java");
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, null,
                    List.of("-proc:none", "--release", "17"), null, files.getJavaFileObjects(activity));
            for (CompilationUnitTree unit : task.parse()) {
                for (Tree top : unit.getTypeDecls()) {
                    if (!(top instanceof ClassTree type)) continue;
                    for (Tree member : type.getMembers()) {
                        if (member instanceof VariableTree field && field.getName().contentEquals("windowBackground")) {
                            windowMembers.put("windowBackground", field.toString() + ";");
                        }
                        if (member instanceof ClassTree nested && nested.getSimpleName().contentEquals("FontBindings")) {
                            windowMembers.put("FontBindings", nested.toString());
                        }
                        if (member instanceof MethodTree method
                                && List.of("applySystemBarPalette", "createBrowserFrame").contains(method.getName().toString())) {
                            windowMembers.put(method.getName().toString(), method.toString());
                        }
                    }
                }
            }
        }
        String windowCode = "";
        for (String name : List.of("windowBackground", "applySystemBarPalette", "createBrowserFrame", "FontBindings")) {
            if (!windowMembers.containsKey(name)) throw new AssertionError("Missing production member " + name);
            windowCode += windowMembers.get(name) + "\n";
        }
        Path overview = root.resolve("mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel/TabSwitcherView.java");
        int checks = execute(compiler, output.resolve("positive"), overview, windowCode);
        String source = Files.readString(overview, StandardCharsets.UTF_8);
        int rejected = 0;
        rejected += rejects(compiler, output, windowCode, source, "metadata-rebinds-bitmap",
                "if (boundPreview != nextPreview || previous == null) {\n                if (boundPreview != nextPreview) image.setImageBitmap(nextPreview);",
                "if (true) {\n                image.setImageBitmap(nextPreview);",
                "metadata-only update leaves preview untouched");
        rejected += rejects(compiler, output, windowCode, source, "repeated-show-restarts-open",
                "if (isShowing()) {", "if (false) {", "repeated show never restarts opening animation");
        rejected += rejects(compiler, output, windowCode, source, "cold-reopen-rebuilds",
                "revealOnLayout = true;\n        refresh(items);", "revealOnLayout = true;\n        rebuild(items, columnCount());",
                "dismiss then reopen retains card/grid identity without removeAllViews");
        rejected += rejects(compiler, output, windowCode, source, "hidden-item-retains-preview",
                "item = new TabItem(null, item.title, item.displayUrl, item.active, null);", ";",
                "dismiss clears every retained preview reference");
        rejected += rejects(compiler, output, windowCode, source, "permanent-release-retains-cards",
                "dismiss();\n        releaseCards();\n        gridColumns = 0;", "dismiss();\n        gridColumns = 0;",
                "final detach releases every retained card/Shell");
        rejected += rejects(compiler, output, windowCode, source, "ignore-recycled-bound-preview",
                "|| binding.boundPreview != preview", "", "same-item recycled preview clears the stale bound image");
        rejected += rejects(compiler, output, windowCode, source, "ignore-title-only-update",
                "|| !java.util.Objects.equals(previous.title, next.title)", "", "title-only update changes actual title");
        rejected += rejects(compiler, output, windowCode, source, "ignore-url-only-update",
                "|| !java.util.Objects.equals(previous.displayUrl, next.displayUrl)", "", "url-only update changes actual host");
        rejected += rejects(compiler, output, windowCode, source, "ignore-active-only-update",
                "previous.active != next.active || ", "", "active-only update changes actual selected badge");
        rejected += rejects(compiler, output, windowCode, source, "omit-native-zero-fling",
                "            scroll.fling(0);", "            ;",
                "warm dismiss settles pending motion at its current in-range offset");
        rejected += rejects(compiler, output, windowCode, source, "omit-immediate-native-compute",
                "            scroll.computeScroll();\n        } finally", "            ;\n        } finally",
                "warm dismiss settles pending motion at its current in-range offset");
        rejected += rejects(compiler, output, windowCode, source, "reverse-native-compute-and-fling",
                "            scroll.fling(0);\n            // Consume its final absolute offset now, not on a frame after the next reveal.\n            scroll.computeScroll();", "            scroll.computeScroll();\n            scroll.fling(0);",
                "warm dismiss settles pending motion at its current in-range offset");
        rejected += rejects(compiler, output, windowCode, source, "omit-native-preclamp",
                "            scroll.scrollTo(0, scroll.getScrollY());", "            ;",
                "lifecycle clamp prevents unfinished zero-speed edge work");
        rejected += rejects(compiler, output, windowCode, source, "omit-dismiss-native-settlement",
                "        setVisibility(View.GONE);\n        stopScrollAnimation();", "        setVisibility(View.GONE);",
                "warm dismiss settles pending motion at its current in-range offset");
        rejected += rejects(compiler, output, windowCode, source, "omit-hidden-show-native-settlement",
                "        stopScrollAnimation();\n        setVisibility(View.VISIBLE);", "        setVisibility(View.VISIBLE);",
                "hidden show settles before visibility and first layout");
        rejected += rejects(compiler, output, windowCode, source, "omit-first-reveal-native-settlement",
                "        // super.onLayout may have created fresh native focus/size scrolling since show().\n        stopScrollAnimation();", "        // First-reveal settlement intentionally omitted.",
                "first reveal settles native work created during super layout");
        rejected += rejects(compiler, output, windowCode, source, "show-native-settlement-after-visible",
                "        stopScrollAnimation();\n        setVisibility(View.VISIBLE);", "        setVisibility(View.VISIBLE);\n        stopScrollAnimation();",
                "only the first active reveal adds a visible settlement");
        rejected += rejects(compiler, output, windowCode, source, "dismiss-native-settlement-before-gone",
                "        setVisibility(View.GONE);\n        stopScrollAnimation();", "        stopScrollAnimation();\n        setVisibility(View.GONE);",
                "dismiss settlement runs only while overview is GONE");
        System.out.println(checks + " actual-view overview host checks passed, " + rejected
                + " behavioral mutation controls rejected (not Android runtime acceptance)");
    }

    private static int rejects(JavaCompiler compiler, Path output, String windowCode, String source,
            String label, String before, String after, String expectedFailure) throws Exception {
        int first = source.indexOf(before);
        if (first < 0 || source.indexOf(before, first + before.length()) >= 0) {
            throw new AssertionError("Mutation must replace one unambiguous expression: " + label);
        }
        Path changed = output.resolve(label).resolve("actual/TabSwitcherView.java");
        Files.createDirectories(changed.getParent());
        Files.writeString(changed, source.substring(0, first) + after + source.substring(first + before.length()),
                StandardCharsets.UTF_8);
        // A compile error is never counted as a killed behavioral mutation.
        try {
            execute(compiler, output.resolve(label), changed, windowCode);
        } catch (InvocationTargetException failure) {
            Throwable cause = failure.getCause();
            if (cause instanceof AssertionError && cause.getMessage() != null
                    && cause.getMessage().contains(expectedFailure)) {
                System.out.println("Rejected behavioral mutation " + label + ": " + cause.getMessage());
                return 1;
            }
            throw new AssertionError("Mutation failed for the wrong reason: " + label, cause);
        }
        throw new AssertionError("Behavioral mutation survived: " + label);
    }

    private static int execute(JavaCompiler compiler, Path output, Path overview, String windowCode) throws Exception {
        List<Path> sources = new ArrayList<>();
        sources.add(overview);
        for (String[] fixture : FIXTURES) {
            Path source = output.resolve(fixture[0] + ".java");
            Files.createDirectories(source.getParent());
            Files.writeString(source, fixture[1].replace("@WINDOW_MEMBERS@", windowCode), StandardCharsets.UTF_8);
            sources.add(source);
        }
        Path checks = output.resolve("com/ahoo/abs/android/nativekernel/TabSwitcherChecks.java");
        Files.writeString(checks, CHECKS, StandardCharsets.UTF_8);
        sources.add(checks);
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            boolean compiled = compiler.getTask(null, files, null,
                    List.of("--release", "17", "-Xlint:all", "-Werror", "-d", output.toString()), null,
                    files.getJavaFileObjectsFromPaths(sources)).call();
            if (!compiled) throw new AssertionError("Actual overview did not compile against host fixtures");
        }
        try (URLClassLoader loader = new URLClassLoader(new URL[]{output.toUri().toURL()}, NativeTabSwitcherHostTest.class.getClassLoader())) {
            return (Integer) loader.loadClass("com.ahoo.abs.android.nativekernel.TabSwitcherChecks").getMethod("run").invoke(null);
        }
    }

    private static final String[][] FIXTURES = {
        {"android/util/TypedValue", "package android.util; public final class TypedValue { public static final int COMPLEX_UNIT_SP = 2; }"},
        {"android/util/DisplayMetrics", """
            package android.util;
            public final class DisplayMetrics { public float density = 1; public int widthPixels = 400; }
            """},
        {"android/content/res/Configuration", """
            package android.content.res;
            public final class Configuration { public float fontScale = 1; }
            """},
        {"android/content/res/Resources", """
            package android.content.res;
            public final class Resources {
                private final android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
                private final Configuration config = new Configuration();
                public android.util.DisplayMetrics getDisplayMetrics() { return metrics; }
                public Configuration getConfiguration() { return config; }
            }
            """},
        {"android/content/Context", """
            package android.content;
            public class Context {
                private final android.content.res.Resources resources = new android.content.res.Resources();
                public android.content.res.Resources getResources() { return resources; }
            }
            """},
        {"android/content/res/ColorStateList", """
            package android.content.res;
            public final class ColorStateList {
                public final int color;
                private ColorStateList(int color) { this.color = color; }
                public static ColorStateList valueOf(int color) { return new ColorStateList(color); }
            }
            """},
        {"android/graphics/Rect", "package android.graphics; public final class Rect { }"},
        {"android/os/Bundle", "package android.os; public final class Bundle { }"},
        {"android/view/WindowInsets", """
            package android.view;
            public final class WindowInsets {
                public Runnable apply;
                public WindowInsets result;
                public int applications;
            }
            """},
        {"android/graphics/Bitmap", """
            package android.graphics;
            public final class Bitmap {
                private boolean recycled;
                public boolean isRecycled() { return recycled; }
                public void recycle() { recycled = true; }
            }
            """},
        {"android/graphics/Typeface", """
            package android.graphics;
            public final class Typeface {
                public static final int NORMAL = 0;
                public static Typeface create(String name, int style) { return new Typeface(); }
            }
            """},
        {"android/graphics/drawable/ColorDrawable", """
            package android.graphics.drawable;
            public final class ColorDrawable {
                public int color;
                public ColorDrawable(int color) { this.color = color; }
                public void setColor(int color) { this.color = color; }
            }
            """},
        {"android/graphics/drawable/GradientDrawable", """
            package android.graphics.drawable;
            public final class GradientDrawable {
                public enum Orientation { TOP_BOTTOM }
                public int color, strokeColor, strokeWidth;
                public int[] colors;
                public GradientDrawable() { }
                public GradientDrawable(Orientation orientation, int[] colors) { this.colors = colors; }
                public void setColor(int color) { this.color = color; }
                public void setColors(int[] colors) { this.colors = colors; }
                public void setCornerRadius(float radius) { }
                public void setStroke(int width, int color) { strokeWidth = width; strokeColor = color; }
            }
            """},
        {"android/graphics/drawable/RippleDrawable", """
            package android.graphics.drawable;
            public final class RippleDrawable {
                public RippleDrawable(android.content.res.ColorStateList color, Object content, Object mask) { }
                public void setColor(android.content.res.ColorStateList color) { }
            }
            """},
        {"android/text/TextUtils", """
            package android.text;
            public final class TextUtils { public enum TruncateAt { END } }
            """},
        {"android/view/Gravity", """
            package android.view;
            public final class Gravity {
                public static final int CENTER = 1, CENTER_VERTICAL = 2, CENTER_HORIZONTAL = 4, TOP = 8, END = 16;
            }
            """},
        {"android/view/HapticFeedbackConstants", """
            package android.view;
            public final class HapticFeedbackConstants { public static final int KEYBOARD_TAP = 1; }
            """},
        {"android/view/ViewParent", "package android.view; public interface ViewParent { }"},
        {"android/view/MotionEvent", """
            package android.view;
            public final class MotionEvent {
                public static final int ACTION_DOWN = 0, ACTION_SCROLL = 8;
                private final int action;
                public MotionEvent(int action) { this.action = action; }
                public int getActionMasked() { return action; }
            }
            """},
        {"android/view/KeyEvent", """
            package android.view;
            public final class KeyEvent {
                public static final int ACTION_DOWN = 0;
                private final int action;
                public KeyEvent(int action) { this.action = action; }
                public int getAction() { return action; }
            }
            """},
        {"android/view/ViewTreeObserver", """
            package android.view;
            public final class ViewTreeObserver {
                public interface OnPreDrawListener { boolean onPreDraw(); }
                public final java.util.List<OnPreDrawListener> listeners = new java.util.ArrayList<>();
                public boolean alive = true;
                public boolean isAlive() { return alive; }
                public void addOnPreDrawListener(OnPreDrawListener listener) { listeners.add(listener); }
                public void removeOnPreDrawListener(OnPreDrawListener listener) { listeners.remove(listener); }
                public void dispatchOnPreDraw() {
                    for (OnPreDrawListener listener : java.util.List.copyOf(listeners)) listener.onPreDraw();
                }
            }
            """},
        {"android/view/Window", """
            package android.view;
            public final class Window {
                public android.graphics.drawable.ColorDrawable background;
                public int backgroundInstalls;
                public Runnable onAppearance;
                public void setBackgroundDrawable(android.graphics.drawable.ColorDrawable value) {
                    background = value; backgroundInstalls++;
                }
            }
            """},
        {"android/view/View", """
            package android.view;
            public class View implements ViewParent {
                public static final int VISIBLE = 0, GONE = 8;
                private final android.content.Context context;
                public ViewParent parent;
                private int visibility, width, left, top, bottom, paddingTop, paddingBottom;
                private Object background, foreground;
                private CharSequence description;
                private OnClickListener click;
                private final ViewTreeObserver observer = new ViewTreeObserver();
                public android.view.ViewGroup.LayoutParams layoutParams;
                public int layoutRequests, posts, invalidations, descriptionWrites, animationStarts;
                public View(android.content.Context context) { this.context = context; }
                public interface OnClickListener { void onClick(View view); }
                public static final class MeasureSpec {
                    public static final int EXACTLY = 0x40000000, UNSPECIFIED = 0;
                    public static int getSize(int spec) { return spec & 0x3fffffff; }
                    public static int makeMeasureSpec(int size, int mode) { return size | mode; }
                }
                public android.content.Context getContext() { return context; }
                public android.content.res.Resources getResources() { return context.getResources(); }
                public void setBackground(Object value) { background = value; }
                public Object getBackground() { return background; }
                public void setBackgroundColor(int color) { }
                public void setForeground(Object value) { foreground = value; }
                public Object getForeground() { return foreground; }
                public void setVisibility(int value) { visibility = value; }
                public int getVisibility() { return visibility; }
                public void setContentDescription(CharSequence value) { description = value; descriptionWrites++; }
                public CharSequence getContentDescription() { return description; }
                public void setOnClickListener(OnClickListener listener) { click = listener; }
                public boolean performClick() { if (click != null) click.onClick(this); return click != null; }
                public boolean performHapticFeedback(int value) { return true; }
                public void setClickable(boolean value) { }
                public void setPadding(int left, int top, int right, int bottom) { paddingTop = top; paddingBottom = bottom; }
                public int getPaddingLeft() { return 0; }
                public int getPaddingRight() { return 0; }
                public int getMeasuredHeight() { return 0; }
                public int getPaddingTop() { return paddingTop; }
                public int getPaddingBottom() { return paddingBottom; }
                public void setMinimumWidth(int value) { }
                public void setMinimumHeight(int value) { }
                public void setElevation(float value) { }
                public void setAlpha(float value) { }
                public void setTranslationY(float value) { }
                public View animate() { return this; }
                public View alpha(float value) { return this; }
                public View translationY(float value) { return this; }
                public View setDuration(long value) { return this; }
                public void start() { animationStarts++; }
                public ViewParent getParent() { return parent; }
                public int getLeft() { return left; }
                public int getRight() { return left + width; }
                public int getWidth() { return width; }
                public int getHeight() { return bottom - top; }
                public int getTop() { return top; }
                public int getBottom() { return bottom; }
                public ViewTreeObserver getViewTreeObserver() { return observer; }
                public android.view.ViewGroup.LayoutParams getLayoutParams() { return layoutParams; }
                public void invalidate() { invalidations++; }
                public boolean dispatchTouchEvent(MotionEvent event) { return false; }
                public boolean dispatchGenericMotionEvent(MotionEvent event) { return false; }
                public boolean dispatchKeyEvent(KeyEvent event) { return false; }
                public void requestLayout() { layoutRequests++; }
                public boolean post(Runnable callback) { posts++; callback.run(); return true; }
                public boolean removeCallbacks(Runnable callback) { return true; }
                public final void measure(int widthSpec, int heightSpec) { onMeasure(widthSpec, heightSpec); }
                protected void onMeasure(int widthSpec, int heightSpec) { }
                public final void layout(int left, int top, int right, int bottom) {
                    boolean changed = width != right - left || this.top != top || this.bottom != bottom;
                    width = right - left; this.left = left; this.top = top; this.bottom = bottom;
                    onLayout(changed, left, top, right, bottom);
                }
                protected void onLayout(boolean changed, int left, int top, int right, int bottom) { }
                protected void onScrollChanged(int x, int y, int oldX, int oldY) { }
                public boolean requestChildRectangleOnScreen(View child, android.graphics.Rect rect, boolean immediate) { return false; }
                public void requestChildFocus(View child, View focused) { }
                public boolean performAccessibilityAction(int action, android.os.Bundle arguments) { return false; }
                protected void onDetachedFromWindow() { }
                public final void detach() { onDetachedFromWindow(); }
            }
            """},
        {"android/view/ViewGroup", """
            package android.view;
            public class ViewGroup extends View {
                public static class LayoutParams {
                    public int width, height, leftMargin, topMargin, rightMargin, bottomMargin;
                    public LayoutParams(int width, int height) { this.width = width; this.height = height; }
                    public void setMargins(int left, int top, int right, int bottom) {
                        leftMargin = left; topMargin = top; rightMargin = right; bottomMargin = bottom;
                    }
                }
                private final java.util.List<View> children = new java.util.ArrayList<>();
                public int removals;
                public ViewGroup(android.content.Context context) { super(context); }
                public void addView(View child) { children.add(child); child.parent = this; requestLayout(); }
                public void addView(View child, LayoutParams params) { child.layoutParams = params; addView(child); }
                public int getChildCount() { return children.size(); }
                public View getChildAt(int index) { return children.get(index); }
                public void removeAllViews() {
                    removals++;
                    for (View child : children) child.parent = null;
                    children.clear(); requestLayout();
                    // Deterministic worst-case: the empty replacement has no scroll range yet.
                    for (ViewParent p = getParent(); p instanceof View view; p = view.getParent()) {
                        if (view instanceof android.widget.ScrollView scroll) { scroll.scrollTo(0, 0); break; }
                    }
                }
            }
            """},
        {"android/widget/FrameLayout", """
            package android.widget;
            public class FrameLayout extends android.view.ViewGroup {
                public static class LayoutParams extends android.view.ViewGroup.LayoutParams {
                    public LayoutParams(int width, int height) { super(width, height); }
                    public LayoutParams(int width, int height, int gravity) { super(width, height); }
                }
                public FrameLayout(android.content.Context context) { super(context); }
                // Host-only injection of work created during super.onLayout, not Android layout emulation.
                public Runnable modelSuperLayoutWork;
                @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
                    super.onLayout(changed, left, top, right, bottom);
                    if (modelSuperLayoutWork != null) {
                        Runnable work = modelSuperLayoutWork; modelSuperLayoutWork = null; work.run();
                    }
                }
                public android.view.WindowInsets onApplyWindowInsets(android.view.WindowInsets insets) {
                    insets.applications++;
                    if (insets.apply != null) insets.apply.run();
                    return insets.result == null ? insets : insets.result;
                }
            }
            """},
        {"android/widget/LinearLayout", """
            package android.widget;
            public class LinearLayout extends android.view.ViewGroup {
                public static final int VERTICAL = 1, HORIZONTAL = 0;
                public static class LayoutParams extends android.view.ViewGroup.LayoutParams {
                    public LayoutParams(int width, int height) { super(width, height); }
                    public LayoutParams(int width, int height, float weight) { super(width, height); }
                }
                public LinearLayout(android.content.Context context) { super(context); }
                public void setOrientation(int value) { }
                public void setGravity(int value) { }
            }
            """},
        {"android/widget/ScrollView", """
            package android.widget;
            public class ScrollView extends FrameLayout {
                public int maxScroll = 2000, scrollCalls, layoutClamps, zeroFlings, visibleZeroFlings;
                private int scrollY;
                private Integer pendingScroll;
                private boolean pendingSpringback;
                public boolean nativeLayoutRange;
                public ScrollView(android.content.Context context) { super(context); }
                public void setFillViewport(boolean value) { }
                public void setVerticalScrollBarEnabled(boolean value) { }
                public int getScrollY() { return scrollY; }
                public void scrollTo(int x, int y) {
                    scrollCalls++; int old = scrollY;
                    scrollY = Math.max(0, Math.min(y, maxScroll));
                    if (old != scrollY) onScrollChanged(x, scrollY, 0, old);
                }
                @Override protected void onLayout(boolean changed, int l, int t, int r, int b) {
                    super.onLayout(changed, l, t, r, b);
                    if (nativeLayoutRange) {
                        maxScroll = Math.max(0, getChildAt(0).getHeight() - getHeight() + getPaddingTop() + getPaddingBottom());
                        int old = scrollY;
                        scrollTo(0, scrollY); // Android's super.onLayout clamp, before the parent restores.
                        if (old != scrollY) layoutClamps++;
                    }
                }
                // Bounded state model derived from API35 source, NOT a velocity/timing implementation
                // and NOT evidence of the guest's native scroller state or real rendering.
                public boolean failZeroFling, failCompute;
                public boolean hasPendingScroll() { return pendingScroll != null; }
                public void modelNativeOffset(int y) { scrollY = y; } // Model an overfling position.
                public void fling(int velocityY) {
                    if (velocityY == 0) {
                        if (failZeroFling) throw new IllegalStateException("modeled fling failure");
                        zeroFlings++;
                        boolean hidden = false;
                        for (android.view.View current = this; current != null;
                                current = current.parent instanceof android.view.View parent ? parent : null) {
                            if (current.getVisibility() == GONE) hidden = true;
                        }
                        if (!hidden) visibleZeroFlings++;
                        pendingSpringback = scrollY < 0 || scrollY > maxScroll;
                        pendingScroll = Math.max(0, Math.min(scrollY, maxScroll));
                    } else {
                        pendingSpringback = false;
                        pendingScroll = Math.max(0, Math.min(scrollY + velocityY / 4, maxScroll));
                    }
                }
                public final void smoothScrollTo(int x, int y) {
                    pendingSpringback = false; pendingScroll = Math.max(0, Math.min(y, maxScroll));
                }
                public void computeScroll() {
                    if (failCompute) throw new IllegalStateException("modeled compute failure");
                    if (pendingScroll == null) return;
                    // Model unfinished edge work as a separate transition, not any number of ms/frames.
                    if (pendingSpringback) { pendingSpringback = false; return; }
                    int old = scrollY; scrollY = pendingScroll; pendingScroll = null;
                    // Framework animation applies an absolute offset without our scrollTo override.
                    if (old != scrollY) onScrollChanged(0, scrollY, 0, old);
                }
                public void layoutRange(int range) {
                    maxScroll = Math.max(0, range);
                    int clamped = Math.max(0, Math.min(maxScroll, scrollY));
                    if (clamped != scrollY) layoutClamps++;
                    scrollY = clamped;
                }
            }
            """},
        {"android/widget/TextView", """
            package android.widget;
            public final class TextView extends android.view.View {
                private CharSequence text = "";
                public int textWrites, textColor;
                public float textSizePx;
                public TextView(android.content.Context context) { super(context); }
                public void setText(CharSequence value) { text = value; textWrites++; }
                public CharSequence getText() { return text; }
                public void setTextSize(int unit, float sp) {
                    if (unit != android.util.TypedValue.COMPLEX_UNIT_SP) throw new AssertionError("SP required");
                    setTextSize(sp);
                }
                public void setTextSize(float sp) {
                    textSizePx = sp * getResources().getDisplayMetrics().density * getResources().getConfiguration().fontScale;
                }
                public void setTextColor(int value) { textColor = value; }
                public void setGravity(int value) { }
                public void setSingleLine(boolean value) { }
                public void setEllipsize(android.text.TextUtils.TruncateAt value) { }
                public void setTypeface(android.graphics.Typeface value) { }
            }
            """},
        {"android/widget/ImageView", """
            package android.widget;
            public final class ImageView extends android.view.View {
                public enum ScaleType { CENTER_CROP }
                public android.graphics.Bitmap bitmap;
                public int bitmapWrites;
                public ImageView(android.content.Context context) { super(context); }
                public void setImageBitmap(android.graphics.Bitmap value) { bitmap = value; bitmapWrites++; }
                public void setScaleType(ScaleType value) { }
            }
            """},
        {"org/chromium/content_shell/Shell", "package org.chromium.content_shell; public final class Shell { }"},
        {"com/ahoo/abs/android/nativekernel/NativeBrowserActivity", """
            package com.ahoo.abs.android.nativekernel;
            import android.view.Window;
            import android.view.WindowInsets;
            import android.widget.FrameLayout;
            import android.widget.TextView;
            import java.util.List;
            import java.util.ArrayList;
            final class NativeBrowserActivity extends android.content.Context {
                static int C_CANVAS = 1, C_SURFACE = 2, C_INK = 3, C_MUTED = 4,
                        C_ACCENT = 5, C_ACCENT_SOFT = 6, C_STROKE = 7, C_TILE_TOP = 8, C_TILE_BOTTOM = 9, C_RIPPLE = 10;
                static int CANVAS = 11;
                android.widget.FrameLayout browserFrame;
                TabSwitcherView tabSwitcher;
                // Only the normal inset path is exercised by this overview host.
                Object fullscreenOwner;
                static WindowInsets applyPageFullscreenInsets(FrameLayout frame, WindowInsets insets) { return insets; }
                final Window window = new Window();
                private Window getWindow() { return window; }
                static void applySystemBarAppearance(Window window) {
                    if (window.onAppearance != null) window.onAppearance.run();
                }
                void repaintSystemBars() { applySystemBarPalette(); }
                FrameLayout makeBrowserFrame() { return createBrowserFrame(); }
                @WINDOW_MEMBERS@
                static final class PaletteBindings {
                    private final java.util.List<Runnable> bindings = new java.util.ArrayList<>();
                    void add(Runnable binding) { bindings.add(binding); binding.run(); }
                    void apply() { for (Runnable binding : bindings) binding.run(); }
                    void clear() { bindings.clear(); }
                }
            }
            """},
        {"com/ahoo/abs/android/nativekernel/NewTabPage", """
            package com.ahoo.abs.android.nativekernel;
            final class NewTabPage {
                static String displayHostFor(String url) {
                    try { String host = java.net.URI.create(url).getHost(); return host == null ? "" : host; }
                    catch (IllegalArgumentException invalid) { return ""; }
                }
            }
            """}
    };

    private static final String CHECKS = """
        package com.ahoo.abs.android.nativekernel;
        import android.content.Context;
        import android.graphics.Bitmap;
        import android.graphics.drawable.GradientDrawable;
        import android.graphics.drawable.ColorDrawable;
        import android.view.KeyEvent;
        import android.view.MotionEvent;
        import android.view.View;
        import android.view.ViewTreeObserver;
        import android.view.ViewGroup;
        import android.widget.ImageView;
        import android.widget.LinearLayout;
        import android.widget.ScrollView;
        import android.widget.TextView;
        import java.lang.reflect.Field;
        import java.util.ArrayList;
        import java.util.Collections;
        import java.util.List;
        import org.chromium.content_shell.Shell;

        public final class TabSwitcherChecks {
            private static int checks;
            private static void check(boolean value, String message) {
                checks++; if (!value) throw new AssertionError(message);
            }
            private static Object field(Object owner, String name) throws Exception {
                Field field = owner.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(owner);
            }
            private static final class Recorder implements TabSwitcherView.Listener {
                Shell selected, closed;
                int selects, closes, news, dismisses;
                public void onSelect(Shell shell) { selected = shell; selects++; }
                public void onClose(Shell shell) { closed = shell; closes++; }
                public void onNewTab() { news++; }
                public void onDismiss() { dismisses++; }
            }
            private static final class Fixture {
                final Context context = new Context();
                final Recorder recorder = new Recorder();
                final TabSwitcherView view = new TabSwitcherView(context, "EMQA-host", recorder);
                final LinearLayout grid;
                final ScrollView scroll;
                final List<TabSwitcherView.TabItem> items = new ArrayList<>();
                Fixture() throws Exception {
                    grid = (LinearLayout) field(view, "grid"); scroll = (ScrollView) field(view, "scroll");
                    for (int i = 0; i < 5; i++) items.add(new TabSwitcherView.TabItem(new Shell(),
                            "Tab " + i, "https://example.test/" + i, i == 4, new Bitmap()));
                    view.show(items);
                }
                void measure(int width) {
                    view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                            View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY));
                }
                void finishLayout(int width, int rowHeight) {
                    layoutOnly(width, rowHeight);
                    view.getViewTreeObserver().dispatchOnPreDraw();
                }
                void layoutOnly(int width, int rowHeight) {
                    // Fixtures supply row bounds; Android's widget measurement is intentionally not emulated.
                    int y = 12;
                    for (int i = 0; i < grid.getChildCount(); i++) {
                        View row = grid.getChildAt(i); row.layout(0, y, width, y + rowHeight);
                        if (row instanceof ViewGroup group) {
                            for (int j = 0; j < group.getChildCount(); j++) group.getChildAt(j).layout(0, 0, width / 2, rowHeight);
                        }
                        y += rowHeight + 10;
                    }
                    view.layout(0, 0, width, 600);
                }
                void open() { measure(400); finishLayout(400, 200); scroll.scrollTo(0, 63); }
                Object binding(int index) throws Exception { return ((List<?>) field(view, "cards")).get(index); }
                View card(int index) throws Exception { return (View) field(binding(index), "card"); }
                TextView text(int index, String name) throws Exception { return (TextView) field(binding(index), name); }
                ImageView image(int index) throws Exception { return (ImageView) field(binding(index), "image"); }
                void replace(int index, String title, String url, boolean active, Bitmap bitmap) {
                    Shell shell = items.get(index).shell;
                    items.set(index, new TabSwitcherView.TabItem(shell, title, url, active, bitmap));
                }
            }
            private static void paletteAndPreviewKeepIdentity() throws Exception {
                Fixture f = new Fixture(); f.open();
                View row = f.grid.getChildAt(0), card = f.card(4);
                ImageView image = f.image(4);
                int removals = f.grid.removals, scrollCalls = f.scroll.scrollCalls;
                int writes = f.text(4, "title").textWrites;
                NativeBrowserActivity.C_SURFACE = 0xff202020;
                NativeBrowserActivity.C_INK = 0xffeeeeee;
                f.view.applyPalette();
                Bitmap replacement = new Bitmap();
                f.replace(4, "Tab 4", "https://example.test/4", true, replacement);
                f.view.refresh(f.items);
                f.measure(400); f.finishLayout(400, 200);
                check(f.grid.getChildAt(0) == row && f.card(4) == card && f.image(4) == image, "palette/preview retains row, card and image identities");
                check(f.scroll.getScrollY() == 63 && f.scroll.scrollCalls == scrollCalls, "five-tab theme/preview cannot shift or re-scroll the viewport");
                check(f.grid.removals == removals, "preview cannot empty/rebuild the live grid");
                check(image.bitmap == replacement, "binds the actual replacement bitmap, not stale content");
                check(((GradientDrawable) card.getBackground()).color == NativeBrowserActivity.C_SURFACE, "retained card is recolored");
                check(f.text(4, "title").textWrites == writes, "unchanged text does not request text relayout");
                for (int i = 0; i < 50; i++) {
                    f.replace(4, "Tab 4", "https://example.test/4", true, new Bitmap());
                    f.view.refresh(f.items);
                }
                check(f.grid.removals == removals && f.scroll.getScrollY() == 63, "repeated asynchronous previews retain structure and offset");
                check(((List<?>) field(field(f.view, "cardPalette"), "bindings")).size() == 10, "preview updates do not accumulate palette bindings");
                check(f.scroll.posts == 0, "no restore runnable races an unfinished layout");
            }
            private static void paletteSurvivesTransientRangeWithoutRebuild() throws Exception {
                Fixture f = new Fixture(); f.open(); f.scroll.scrollTo(0, 253);
                View row = f.grid.getChildAt(1), card = f.card(2);
                int removals = f.grid.removals, calls = f.scroll.scrollCalls;
                f.view.retainPaletteAnchor();
                f.scroll.layoutRange(190); // Inject a 63px clamp before final equal-bounds layout.
                f.layoutOnly(400, 200);
                check(f.scroll.getScrollY() == 190 && f.scroll.layoutClamps == 1, "palette fixture really loses 63px without removing a view");
                f.view.applyPalette(); f.view.refresh(f.items); f.view.retainPaletteAnchor();
                f.layoutOnly(400, 200);
                check(f.view.getViewTreeObserver().listeners.size() == 1 && f.scroll.scrollCalls == calls, "palette coalesces and cannot restore in an intermediate onLayout");
                f.scroll.layoutRange(2000); f.finishLayout(400, 200);
                check(f.scroll.getScrollY() == 253 && f.scroll.scrollCalls == calls + 1, "one settled pre-draw restores the original Shell offset after range recovery");
                check(f.grid.getChildAt(1) == row && f.card(2) == card && f.grid.removals == removals, "inset-clamp recovery retains every card/row identity");
                check(f.view.getViewTreeObserver().listeners.isEmpty() && !(Boolean) field(f.view, "restoreOnLayout"), "palette guard is fully consumed");
                f.finishLayout(400, 200); f.view.getViewTreeObserver().dispatchOnPreDraw();
                check(f.scroll.scrollCalls == calls + 1, "later layouts and draws cannot replay palette scrolling");
                f.view.applyPalette(); f.finishLayout(400, 200);
                check(f.scroll.getScrollY() == 253 && f.scroll.scrollCalls == calls + 1, "unchanged palette is zero-scroll, not an unconditional retry");
                f.view.applyPalette(); f.scroll.layoutRange(20); f.finishLayout(400, 200);
                check(f.scroll.getScrollY() == 20 && f.view.getViewTreeObserver().listeners.isEmpty(), "a genuinely smaller final range remains clamped without retrying");
            }
            private static void paletteAndStructuralReflowShareOriginalShell() throws Exception {
                Fixture f = new Fixture(); f.open(); f.scroll.scrollTo(0, 253);
                Shell anchor = f.items.get(2).shell;
                f.view.retainPaletteAnchor(); f.scroll.layoutRange(190);
                Collections.rotate(f.items, 2); f.view.refresh(f.items);
                f.context.getResources().getConfiguration().fontScale = 1.3f;
                f.measure(250); f.layoutOnly(250, 300); f.view.applyPalette();
                check(f.view.getViewTreeObserver().listeners.size() == 1 && (Integer) field(f.view, "gridColumns") == 1, "palette and genuine resize/font/order changes share one pending guard");
                f.scroll.layoutRange(2000); f.finishLayout(250, 300);
                int index = 0; while (f.items.get(index).shell != anchor) index++;
                check(f.scroll.getScrollY() == 12 + index * 310 + 31, "combined reflow preserves the original visible Shell/offset, not a clamped intermediate anchor");
                check(f.view.getViewTreeObserver().listeners.isEmpty(), "combined palette/reflow consumes the one guard completely");
            }
            private static void actualWindowPaletteRetainsDrawableAndCapturesEarly() throws Exception {
                NativeBrowserActivity activity = new NativeBrowserActivity();
                activity.repaintSystemBars(); // Actual production method: startup has no overview/frame.
                ColorDrawable underlay = activity.window.background;
                check(underlay != null && activity.window.backgroundInstalls == 1, "window underlay is installed at startup");
                Fixture f = new Fixture(); f.open(); f.scroll.scrollTo(0, 253);
                activity.tabSwitcher = f.view;
                activity.browserFrame = new android.widget.FrameLayout(f.context);
                activity.window.onAppearance = () -> { f.scroll.layoutRange(190); f.layoutOnly(400, 200); };
                int calls = f.scroll.scrollCalls, removals = f.grid.removals;
                NativeBrowserActivity.CANVAS = 0xff141414;
                activity.repaintSystemBars();
                check(f.scroll.getScrollY() == 190 && f.scroll.layoutClamps == 1, "actual Activity dispatch is exercised across a non-no-op inset/range pipeline");
                f.view.applyPalette(); // Too late to capture on its own: the clamp already happened.
                activity.repaintSystemBars();
                check(activity.window.background == underlay && activity.window.backgroundInstalls == 1, "subsequent window palettes mutate the retained drawable, never replace it");
                check(underlay.color == NativeBrowserActivity.CANVAS, "retained transparent-bar underlay receives the latest palette color");
                check(f.view.getViewTreeObserver().listeners.size() == 1 && f.scroll.scrollCalls == calls, "Window and surface mutations share exactly one pre-draw guard");
                f.scroll.layoutRange(2000); f.finishLayout(400, 200);
                check(f.scroll.getScrollY() == 253 && f.scroll.scrollCalls == calls + 1 && f.grid.removals == removals, "Activity captures before bar mutations, not the already-clamped surface-palette state");
                NativeBrowserActivity.CANVAS = 0xfff7f7f7; activity.window.onAppearance = null;
                activity.repaintSystemBars(); f.finishLayout(400, 200);
                check(underlay.color == NativeBrowserActivity.CANVAS && activity.window.backgroundInstalls == 1 && f.scroll.scrollCalls == calls + 1, "reverse palette retains underlay identity and does not re-scroll an unchanged viewport");
            }
            private static NativeBrowserActivity insetFixture(Fixture f) {
                NativeBrowserActivity activity = new NativeBrowserActivity();
                activity.tabSwitcher = f.view;
                activity.browserFrame = activity.makeBrowserFrame();
                f.grid.layout(0, 0, 400, 900);
                f.scroll.nativeLayoutRange = true;
                f.scroll.layout(0, 0, 400, 600);
                f.scroll.scrollTo(0, 300);
                return activity;
            }
            private static void applyInsets(NativeBrowserActivity activity, Fixture f, int viewport) {
                android.view.WindowInsets incoming = new android.view.WindowInsets();
                android.view.WindowInsets forwarded = new android.view.WindowInsets();
                incoming.result = forwarded;
                incoming.apply = () -> {
                    check(f.view.getViewTreeObserver().listeners.size() == 1,
                            "actual root captures BEFORE the existing super applies padding/layout");
                    f.scroll.layout(0, 0, 400, viewport);
                    f.view.layout(0, 0, 400, 600);
                };
                check(activity.browserFrame.onApplyWindowInsets(incoming) == forwarded,
                        "root returns exactly super's insets: no consumption or IME dispatch rewrite");
                check(incoming.applications == 1, "existing root inset application runs exactly once");
            }
            private static int[] cardRects(Fixture f) throws Exception {
                int[] result = new int[f.items.size() * 4];
                for (int i = 0; i < f.items.size(); i++) {
                    View card = f.card(i), row = (View) card.getParent();
                    result[i * 4] = row.getLeft() + card.getLeft();
                    result[i * 4 + 1] = row.getTop() + card.getTop() - f.scroll.getScrollY();
                    result[i * 4 + 2] = row.getLeft() + card.getRight();
                    result[i * 4 + 3] = row.getTop() + card.getBottom() - f.scroll.getScrollY();
                }
                return result;
            }
            private static void actualInsetsAfterPalettePreDraw() throws Exception {
                for (int delta : new int[]{1, 19, 47, 63, 131, 317}) {
                    Fixture f = new Fixture(); f.open();
                    NativeBrowserActivity activity = insetFixture(f);
                    List<View> cards = new ArrayList<>(), rows = new ArrayList<>();
                    for (int i = 0; i < f.items.size(); i++) cards.add(f.card(i));
                    for (int i = 0; i < f.grid.getChildCount(); i++) rows.add(f.grid.getChildAt(i));
                    int[] rects = cardRects(f);
                    int removals = f.grid.removals;
                    activity.repaintSystemBars(); f.view.applyPalette();
                    f.view.getViewTreeObserver().dispatchOnPreDraw();
                    check(f.view.getViewTreeObserver().listeners.isEmpty()
                            && !(Boolean) field(f.view, "restoreOnLayout"), "first palette pre-draw has already ended");
                    // f2 ordering: an actual LATER inset traversal enlarges the viewport.
                    applyInsets(activity, f, 600 + delta);
                    check(f.scroll.getScrollY() == Math.max(0, 300 - delta) && f.scroll.layoutClamps == 1,
                            "real ScrollView super.onLayout fixture clamps before parent restoration: " + delta);
                    f.view.getViewTreeObserver().dispatchOnPreDraw();
                    check((Boolean) field(f.view, "restoreOnLayout") && (Boolean) field(f.view, "insetAnchorPending")
                            && field(f.view, "anchorShell") == f.items.get(2).shell,
                            "unreachable UNCLAMPED Shell target survives pre-draw: " + delta);
                    int calls = f.scroll.scrollCalls, invalidations = f.view.invalidations;
                    for (int n = 0; n < 4; n++) f.view.getViewTreeObserver().dispatchOnPreDraw();
                    check(f.scroll.scrollCalls == calls && f.view.invalidations == invalidations
                            && f.view.getViewTreeObserver().listeners.isEmpty() && f.view.posts == 0,
                            "no further event means no retry, callback, invalidate or scroll: " + delta);
                    // Duplicate inset capture must retain the first, not the clamped anchor.
                    applyInsets(activity, f, 600 + delta);
                    f.view.getViewTreeObserver().dispatchOnPreDraw();
                    applyInsets(activity, f, 600);
                    f.view.getViewTreeObserver().dispatchOnPreDraw();
                    check(f.scroll.getScrollY() == 300 && !(Boolean) field(f.view, "restoreOnLayout")
                            && !(Boolean) field(f.view, "insetAnchorPending") && field(f.view, "anchorShell") == null,
                            "later actual range recovery restores and consumes original logical target: " + delta);
                    check(java.util.Arrays.equals(rects, cardRects(f)), "ALL final card rectangles match, not only clipped top: " + delta);
                    for (int i = 0; i < cards.size(); i++) check(cards.get(i) == f.card(i), "same card identity " + delta + "/" + i);
                    for (int i = 0; i < rows.size(); i++) check(rows.get(i) == f.grid.getChildAt(i), "same row identity " + delta + "/" + i);
                    check(f.grid.removals == removals && f.view.getViewTreeObserver().listeners.isEmpty(), "no rebuild or persistent listener");
                    // Reverse theme is a fresh actual event transaction, not replay of the first.
                    f.view.applyPalette(); f.view.getViewTreeObserver().dispatchOnPreDraw();
                    applyInsets(activity, f, 600 + delta); f.view.getViewTreeObserver().dispatchOnPreDraw();
                    applyInsets(activity, f, 600); f.view.getViewTreeObserver().dispatchOnPreDraw();
                    check(java.util.Arrays.equals(rects, cardRects(f)), "reverse palette retains every final rectangle: " + delta);
                }
            }
            private static void insetNavigationCancellation() throws Exception {
                for (int mode = 0; mode < 12; mode++) {
                    Fixture f = new Fixture(); f.open();
                    NativeBrowserActivity activity = insetFixture(f);
                    f.view.applyPalette(); f.view.getViewTreeObserver().dispatchOnPreDraw();
                    applyInsets(activity, f, 750);
                    ViewTreeObserver.OnPreDrawListener obsolete = f.view.getViewTreeObserver().listeners.get(0);
                    f.view.getViewTreeObserver().dispatchOnPreDraw();
                    check((Boolean) field(f.view, "insetAnchorPending"), "cancellation fixture is genuinely pending " + mode);
                    int stops = f.scroll.zeroFlings;
                    switch (mode) {
                        case 0 -> f.view.dispatchTouchEvent(new MotionEvent(MotionEvent.ACTION_DOWN));
                        case 1 -> f.view.dispatchGenericMotionEvent(new MotionEvent(MotionEvent.ACTION_SCROLL));
                        case 2 -> f.view.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN));
                        case 3 -> f.scroll.fling(600);
                        case 4 -> f.scroll.requestChildRectangleOnScreen(f.grid, new android.graphics.Rect(), false);
                        case 5 -> f.scroll.requestChildFocus(f.grid, f.card(0));
                        case 6 -> f.scroll.performAccessibilityAction(4096, new android.os.Bundle());
                        case 7 -> f.scroll.scrollTo(0, f.scroll.getScrollY()); // Intent even without movement.
                        case 8 -> { f.scroll.smoothScrollTo(0, 11); f.scroll.computeScroll(); }
                        case 9 -> f.view.dismiss();
                        case 10 -> f.view.detach();
                        case 11 -> { f.view.dismiss(); f.view.show(f.items); }
                        default -> throw new AssertionError("unreachable");
                    }
                    check(!(Boolean) field(f.view, "insetAnchorPending") && field(f.view, "anchorShell") == null
                            && f.view.getViewTreeObserver().listeners.isEmpty(), "real navigation/lifecycle wins over logical anchor " + mode);
                    if (mode >= 9) continue;
                    check(f.scroll.zeroFlings == stops, "real input/navigation cancellation never replaces native motion " + mode);
                    f.scroll.scrollTo(0, 11);
                    f.scroll.layout(0, 0, 400, 600); f.view.layout(0, 0, 400, 600);
                    obsolete.onPreDraw();
                    check(f.scroll.getScrollY() == 11, "old inset cannot resurrect before a newer user destination " + mode);
                }
            }
            private static void insetThenStructuralClampAndIdle() throws Exception {
                Fixture f = new Fixture(); f.open();
                NativeBrowserActivity activity = insetFixture(f);
                applyInsets(activity, f, 750); f.view.getViewTreeObserver().dispatchOnPreDraw();
                f.items.remove(2); f.view.refresh(f.items);
                check(!(Boolean) field(f.view, "insetAnchorPending"), "tab structural change ends inset ownership");
                f.scroll.layout(0, 0, 400, 860); f.finishLayout(400, 200);
                check(f.scroll.getScrollY() == 40 && !(Boolean) field(f.view, "restoreOnLayout")
                        && field(f.view, "anchorShell") == null, "normal structural anchor still consumes a final smaller-range clamp");
                f.scroll.layout(0, 0, 400, 600); f.view.layout(0, 0, 400, 600);
                check(f.scroll.getScrollY() == 40, "later geometry cannot resurrect a structurally obsolete anchor");
                int calls = f.scroll.scrollCalls, posts = f.view.posts, invalidations = f.view.invalidations, requests = f.view.layoutRequests;
                for (int n = 0; n < 20; n++) f.view.getViewTreeObserver().dispatchOnPreDraw();
                check(f.scroll.scrollCalls == calls && f.view.posts == posts && f.view.invalidations == invalidations
                        && f.view.layoutRequests == requests && f.view.getViewTreeObserver().listeners.isEmpty(),
                        "empty event sequence schedules absolutely no work");
                NativeBrowserActivity startup = new NativeBrowserActivity();
                android.view.WindowInsets event = new android.view.WindowInsets();
                check(startup.makeBrowserFrame().onApplyWindowInsets(event) == event && event.applications == 1,
                        "startup with no overview still forwards insets exactly once");
            }
            private static void insetThenPermanentMetricsClamp() throws Exception {
                for (int metric = 0; metric < 4; metric++) {
                    Fixture f = new Fixture(); f.open();
                    NativeBrowserActivity activity = insetFixture(f);
                    applyInsets(activity, f, 750); f.view.getViewTreeObserver().dispatchOnPreDraw();
                    int width = metric == 0 ? 420 : metric == 1 ? 260 : 400;
                    if (metric == 2) f.context.getResources().getConfiguration().fontScale = 1.2f;
                    if (metric == 3) f.context.getResources().getDisplayMetrics().density = 1.3f;
                    f.view.measure(width, 600);
                    check(!(Boolean) field(f.view, "insetAnchorPending"), "genuine width/columns/font/density ends inset ownership " + metric);
                    f.scroll.layout(0, 0, width, 860); f.finishLayout(width, 200);
                    check(f.scroll.getScrollY() == 40 && !(Boolean) field(f.view, "restoreOnLayout")
                            && field(f.view, "anchorShell") == null, "metrics path still consumes final permanent clamp " + metric);
                    f.scroll.layout(0, 0, width, 600); f.view.layout(0, 0, width, 600);
                    check(f.scroll.getScrollY() == 40, "later viewport cannot resurrect pre-reflow anchor " + metric);
                }
                Fixture hidden = new Fixture(); hidden.open();
                NativeBrowserActivity activity = insetFixture(hidden); hidden.view.dismiss();
                int invalidations = hidden.view.invalidations;
                android.view.WindowInsets event = new android.view.WindowInsets();
                check(activity.browserFrame.onApplyWindowInsets(event) == event && event.applications == 1
                        && hidden.view.invalidations == invalidations && hidden.view.getViewTreeObserver().listeners.isEmpty(),
                        "hidden overview does not schedule any inset anchor work");
            }
            private static void paletteCancellationAndObsoleteSnapshots() throws Exception {
                for (int mode = 0; mode < 5; mode++) {
                    Fixture f = new Fixture(); f.open(); f.scroll.scrollTo(0, 253); f.view.retainPaletteAnchor();
                    ViewTreeObserver.OnPreDrawListener queued = f.view.getViewTreeObserver().listeners.get(0);
                    f.scroll.layoutRange(190);
                    switch (mode) {
                        case 0 -> f.view.dismiss();
                        case 1 -> f.view.detach();
                        case 2 -> f.view.dispatchTouchEvent(new MotionEvent(MotionEvent.ACTION_DOWN));
                        case 3 -> f.view.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN));
                        case 4 -> f.view.dispatchGenericMotionEvent(new MotionEvent(MotionEvent.ACTION_SCROLL));
                        default -> throw new AssertionError("unreachable");
                    }
                    f.scroll.layoutRange(2000); f.scroll.scrollTo(0, 111);
                    int calls = f.scroll.scrollCalls;
                    f.finishLayout(400, 200); queued.onPreDraw();
                    check(f.scroll.getScrollY() == 111 && f.scroll.scrollCalls == calls, "dismiss/detach/new input cannot be overwritten by a palette callback " + mode);
                    check(f.view.getViewTreeObserver().listeners.isEmpty() && field(f.view, "anchorShell") == null, "cancellation removes observer and stale Shell ownership " + mode);
                }
                Fixture f = new Fixture(); f.open(); f.scroll.scrollTo(0, 253); f.view.retainPaletteAnchor();
                ViewTreeObserver.OnPreDrawListener old = f.view.getViewTreeObserver().listeners.get(0);
                f.view.dispatchTouchEvent(new MotionEvent(MotionEvent.ACTION_DOWN));
                f.scroll.scrollTo(0, 144); f.view.retainPaletteAnchor();
                ViewTreeObserver.OnPreDrawListener next = f.view.getViewTreeObserver().listeners.get(0);
                old.onPreDraw(); // A removed listener may remain in a framework dispatch snapshot.
                check(old != next && f.view.getViewTreeObserver().listeners.size() == 1, "obsolete dispatch snapshot cannot consume a newer palette transaction");
                f.scroll.layoutRange(50); f.layoutOnly(400, 200); f.scroll.layoutRange(2000); f.finishLayout(400, 200);
                check(f.scroll.getScrollY() == 144, "a fresh palette restores only the user's newer anchor");
                f.view.retainPaletteAnchor();
                ViewTreeObserver.OnPreDrawListener retained = f.view.getViewTreeObserver().listeners.get(0);
                f.view.show(f.items);
                check(f.view.getViewTreeObserver().listeners.size() == 1
                        && f.view.getViewTreeObserver().listeners.get(0) == retained,
                        "repeated show preserves existing palette restoration ownership");
                f.finishLayout(400, 200);
                check(f.scroll.getScrollY() == 144, "repeated show cannot replace the user's anchor with active-card reveal");
                f.view.retainPaletteAnchor(); f.view.dismiss(); f.view.show(f.items);
                check(f.view.getViewTreeObserver().listeners.isEmpty(), "dismiss then new show cancels the old palette observer");
                f.finishLayout(400, 200);
                check(f.scroll.getScrollY() == 424, "fresh show still performs its one initial active-card reveal");
                f.view.dismiss(); f.view.applyPalette();
                check(f.view.getViewTreeObserver().listeners.isEmpty(), "hidden overview does not retain a palette listener");
            }
            private static void closeTargetFitsItsPreviewSlot() throws Exception {
                Fixture f = new Fixture(); f.open();
                ViewGroup.LayoutParams close = f.text(0, "close").getLayoutParams();
                View preview = (View) f.text(0, "close").getParent();
                check(close.width >= 48 && close.height >= 48, "close has a minimum 48dp layout/touch target");
                check(close.height + close.topMargin + close.bottomMargin <= preview.getLayoutParams().height, "close target and margins fit wholly inside the 122dp preview slot");
                check(close.width + close.leftMargin + close.rightMargin <= (300 - 28 - 10) / 2, "close target fits the declared narrowest two-column card geometry");
            }
            private static void contentAndCallbacksStayCurrent() throws Exception {
                Fixture f = new Fixture(); f.open(); View card = f.card(4);
                f.replace(4, "😀 Latest", "https://changed.test/path", false, null);
                f.view.refresh(f.items);
                check(f.card(4) == card, "title/url/active changes retain card identity");
                check(f.text(4, "title").getText().toString().equals("😀 Latest"), "new title is bound");
                check(f.text(4, "url").getText().toString().equals("changed.test"), "new display host is bound");
                check(f.text(4, "avatar").getText().toString().equals("😀"), "updated avatar preserves a whole code point");
                check(f.text(4, "badge").getVisibility() == View.GONE, "old active badge clears");
                check(f.image(4).bitmap == null && f.image(4).getVisibility() == View.GONE, "missing preview clears old bitmap");
                check(((View) field(f.binding(4), "placeholder")).getVisibility() == View.VISIBLE, "missing preview exposes the honest placeholder");
                check(f.text(4, "note").getVisibility() == View.VISIBLE, "nonblank missing preview explains its absence");
                check(card.getContentDescription().toString().endsWith("😀 Latest"), "card accessibility label updates");
                check(f.text(4, "close").getContentDescription().toString().endsWith("😀 Latest"), "close accessibility label updates");
                card.performClick(); f.text(4, "close").performClick();
                check(f.recorder.selected == f.items.get(4).shell && f.recorder.closed == f.items.get(4).shell, "retained callbacks target the correct live Shell");
                Bitmap real = new Bitmap(); f.replace(4, "", "about:blank#uuid", true, real); f.view.refresh(f.items);
                check(f.image(4).bitmap == real && f.text(4, "badge").getVisibility() == View.VISIBLE, "new valid preview and active badge bind in place");
                Bitmap recycled = new Bitmap(); recycled.recycle();
                f.replace(4, "   ", "about:blank#uuid", true, recycled); f.view.refresh(f.items);
                check(f.image(4).bitmap == null, "a recycled bitmap is never displayed");
                check(f.text(4, "title").getText().toString().equals("新标签页"), "empty title keeps the real fallback");
                check(f.text(4, "note").getVisibility() == View.GONE, "blank page does not claim a failed live preview");
                check(!real.isRecycled(), "view never recycles a previously published bitmap");
            }
            private static void coalescedStructureRestoresAfterLayout() throws Exception {
                Fixture f = new Fixture(); f.open(); Shell anchor = f.items.get(0).shell;
                Collections.reverse(f.items); f.view.refresh(f.items);
                check(f.scroll.getScrollY() == 0, "fixture exposes transient empty-grid clamp");
                Collections.rotate(f.items, 2); f.view.refresh(f.items);
                f.view.refresh(f.items); // In-place update must not cancel the pending structural restore.
                check((Boolean) field(f.view, "restoreOnLayout"), "coalesced updates keep the original pending restore");
                f.measure(400); f.finishLayout(400, 200);
                int index = 0; while (f.items.get(index).shell != anchor) index++;
                int rowTop = 12 + (index / 2) * 210;
                check(f.scroll.getScrollY() == rowTop + 51, "post-layout restore retains original visible Shell and pixel offset");
                int calls = f.scroll.scrollCalls;
                f.measure(400); f.finishLayout(400, 200);
                check(f.scroll.scrollCalls == calls && !(Boolean) field(f.view, "restoreOnLayout"), "restore is consumed once, not a persistent onLayout loop");
                f.scroll.maxScroll = 20; f.items.remove(0); f.view.refresh(f.items); f.finishLayout(400, 200);
                check(f.scroll.getScrollY() <= 20, "legitimate smaller scroll ranges are still clamped");
            }
            private static void measuredResizeAndFontReflow() throws Exception {
                Fixture f = new Fixture(); f.open(); f.scroll.scrollTo(0, 253);
                int removals = f.grid.removals;
                f.measure(250); // No refresh(items): exercise the actual size listener with old getWidth()==400.
                check(f.grid.getChildCount() == 5 && (Integer) field(f.view, "gridColumns") == 1, "new measure width reflows two columns to one");
                f.finishLayout(250, 200);
                check(f.scroll.getScrollY() == 463, "narrow reflow anchors the first visible Shell");
                f.context.getResources().getConfiguration().fontScale = 1.5f;
                f.measure(250); f.finishLayout(250, 300);
                check(f.scroll.getScrollY() == 663, "font reflow restores the same logical anchor after new row heights");
                check(f.text(2, "title").textSizePx == 19.5f, "fresh cards use the changed system font scale");
                f.context.getResources().getDisplayMetrics().density = 2;
                f.measure(250); f.finishLayout(250, 400);
                check(f.scroll.getScrollY() == 863 && f.text(2, "title").textSizePx == 39, "density reflow updates actual card geometry and text sizing");
                f.measure(1000); // old getWidth()==250 would incorrectly keep one column.
                check(f.grid.getChildCount() == 3 && (Integer) field(f.view, "gridColumns") == 2, "new wide measure spec restores two columns");
                f.finishLayout(1000, 400);
                check(f.scroll.getScrollY() == 453, "wide reflow preserves the visible Shell offset");
                check(f.grid.removals == removals + 4, "one rebuild per real layout-spec change");
                removals = f.grid.removals;
                f.measure(1000); f.finishLayout(1000, 400);
                check(f.grid.removals == removals, "unchanged layout specs do not rebuild repeatedly");
                check(((List<?>) field(field(f.view, "cardPalette"), "bindings")).size() == 10, "reflow releases old palette binding references");
            }
            private static void firstRevealDismissAndDetach() throws Exception {
                Fixture f = new Fixture();
                f.view.refresh(f.items); f.measure(400); f.finishLayout(400, 200);
                check(f.scroll.getScrollY() == 424, "preview before first layout cannot cancel initial active-card reveal");
                f.scroll.scrollTo(0, 63); f.items.remove(0); f.view.refresh(f.items);
                f.view.dismiss();
                int calls = f.scroll.scrollCalls;
                f.finishLayout(400, 200); f.view.refresh(f.items);
                check(f.grid.getChildCount() == 2 && ((List<?>) field(f.view, "cards")).size() == 4
                        && f.image(0).bitmap == null, "dismiss retains current card structure but releases ImageView ownership");
                check(f.scroll.scrollCalls == calls && !(Boolean) field(f.view, "restoreOnLayout"), "dismiss cancels pending structural restoration");
                f.view.show(f.items); f.view.detach(); f.scroll.scrollTo(0, 112);
                calls = f.scroll.scrollCalls; f.measure(400); f.finishLayout(400, 200);
                check(f.scroll.getScrollY() == 112 && f.scroll.scrollCalls == calls, "detach cancels pending initial reveal");
                f.view.dismiss(); f.view.show(null); f.measure(400); f.finishLayout(400, 200);
                check(f.grid.getChildCount() == 1 && ((TextView) field(f.view, "emptyLabel")).getVisibility() == View.VISIBLE, "empty state remains honest and usable");
            }
            private static int[] metadataWrites(Fixture f, int index) throws Exception {
                return new int[]{f.text(index, "title").textWrites, f.text(index, "url").textWrites,
                        f.text(index, "hostLabel").textWrites, f.text(index, "avatar").textWrites,
                        f.card(index).descriptionWrites, f.text(index, "close").descriptionWrites};
            }
            private static int[] paletteColors(Fixture f, int index) throws Exception {
                return ((GradientDrawable) field(f.binding(index), "previewBackground")).colors;
            }
            private static View headerAction(Fixture f, int index) {
                return ((ViewGroup) ((ViewGroup) f.view.getChildAt(0)).getChildAt(0)).getChildAt(index);
            }
            private static View.OnClickListener clickListener(View view) throws Exception {
                Field field = View.class.getDeclaredField("click"); field.setAccessible(true);
                return (View.OnClickListener) field.get(view);
            }
            private static void unchangedRefreshAndShowCoalesce() throws Exception {
                Fixture f = new Fixture(); f.open();
                View row = f.grid.getChildAt(0), target = f.card(4);
                ImageView image = f.image(4);
                int removals = f.grid.removals, scrollCalls = f.scroll.scrollCalls, animations = f.view.animationStarts;
                int[][] metadata = new int[5][], colors = new int[5][];
                int[] bitmapWrites = new int[5];
                for (int i = 0; i < 5; i++) {
                    metadata[i] = metadataWrites(f, i); colors[i] = paletteColors(f, i);
                    bitmapWrites[i] = f.image(i).bitmapWrites;
                    TabSwitcherView.TabItem old = f.items.get(i);
                    f.replace(i, new String(old.title), new String(old.displayUrl), old.active, old.preview);
                }
                for (int i = 0; i < 20; i++) f.view.refresh(f.items);
                for (int i = 0; i < 5; i++) {
                    check(java.util.Arrays.equals(metadataWrites(f, i), metadata[i])
                            && f.image(i).bitmapWrites == bitmapWrites[i] && paletteColors(f, i) == colors[i],
                            "unchanged refresh performs no metadata, bitmap or palette writes " + i);
                }
                for (int changedField = 0; changedField < 3; changedField++) {
                    int changed = changedField == 2 ? 4 : changedField;
                    TabSwitcherView.TabItem old = f.items.get(changed);
                    f.replace(changed, changedField == 0 ? "Only title changed" : old.title,
                            changedField == 1 ? "https://different.test/url-only" : old.displayUrl,
                            changedField == 2 ? !old.active : old.active, old.preview);
                    f.view.refresh(f.items);
                    if (changedField == 0) check(f.text(0, "title").getText().toString().equals("Only title changed"),
                            "title-only update changes actual title");
                    if (changedField == 1) check(f.text(1, "hostLabel").getText().toString().equals("different.test"),
                            "url-only update changes actual host");
                    if (changedField == 2) check(f.text(4, "badge").getVisibility() == View.GONE,
                            "active-only update changes actual selected badge");
                    for (int i = 0; i < 5; i++) {
                        int[] actual = metadataWrites(f, i);
                        for (int j = 0; j < actual.length; j++) {
                            boolean titleWrite = changedField == 0 && i == changed && (j == 0 || j >= 3);
                            boolean urlWrite = changedField == 1 && i == changed && (j == 1 || j == 2);
                            check(actual[j] == metadata[i][j] + (titleWrite || urlWrite ? 1 : 0),
                                    "field-specific metadata/a11y writes " + changedField + "/" + i + "/" + j);
                        }
                        check(f.image(i).bitmapWrites == bitmapWrites[i], "metadata-only update leaves preview untouched " + i);
                        check((paletteColors(f, i) != colors[i]) == (changedField == 2 && i == changed),
                                "only selection changes repaint a data-bound card " + changedField + "/" + i);
                        metadata[i] = actual; colors[i] = paletteColors(f, i);
                    }
                }
                Bitmap replacement = new Bitmap();
                f.replace(4, "Tab 4", "https://example.test/4", false, replacement);
                for (int i = 0; i < 20; i++) f.view.show(f.items);
                check(f.view.animationStarts == animations, "repeated show never restarts opening animation");
                check(f.grid.getChildAt(0) == row && f.card(4) == target && f.image(4) == image
                        && f.grid.removals == removals && f.scroll.getScrollY() == 63
                        && f.scroll.scrollCalls == scrollCalls, "repeated show retains card identities and scroll");
                check(image.bitmap == replacement && image.bitmapWrites == bitmapWrites[4] + 1,
                        "repeated show still writes one changed preview once");
                for (int i = 0; i < 5; i++) {
                    check(java.util.Arrays.equals(metadataWrites(f, i), metadata[i]) && paletteColors(f, i) == colors[i],
                            "preview-only update leaves all metadata/a11y and palette untouched " + i);
                }
                replacement.recycle(); f.view.refresh(f.items);
                check(image.bitmap == null && image.getVisibility() == View.GONE
                        && image.bitmapWrites == bitmapWrites[4] + 2,
                        "same-item recycled preview clears the stale bound image");
                f.view.refresh(f.items);
                check(image.bitmapWrites == bitmapWrites[4] + 2
                        && java.util.Arrays.equals(metadataWrites(f, 4), metadata[4]) && paletteColors(f, 4) == colors[4],
                        "sanitized null preview performs no further writes or metadata work");
                NativeBrowserActivity.C_SURFACE = 0xff323232; f.view.applyPalette();
                check(((GradientDrawable) target.getBackground()).color == NativeBrowserActivity.C_SURFACE
                        && paletteColors(f, 4) != colors[4], "explicit palette repaint remains independent of bind skipping");
                f.view.dismiss(); f.view.show(f.items); f.measure(400); f.finishLayout(400, 200);
                check(f.view.animationStarts == animations + 1 && f.grid.getChildCount() == 3
                        && f.grid.getChildAt(0) == row && f.card(4) == target && f.grid.removals == removals,
                        "dismiss then reopen retains card/grid identity without removeAllViews");
            }
            private static void repeatedWarmDismissAndOpen() throws Exception {
                Fixture f = new Fixture(); f.open();
                List<View> oldCards = new ArrayList<>(), rows = new ArrayList<>();
                List<Object> bindings = new ArrayList<>();
                Bitmap[] reusable = new Bitmap[5];
                for (int i = 0; i < 5; i++) { oldCards.add(f.card(i)); bindings.add(f.binding(i)); reusable[i] = f.image(i).bitmap; }
                for (int i = 0; i < f.grid.getChildCount(); i++) rows.add(f.grid.getChildAt(i));
                int removals = f.grid.removals, paletteSize = ((List<?>) field(field(f.view, "cardPalette"), "bindings")).size();
                int fontSize = ((List<?>) field(field(f.view, "cardFonts"), "bindings")).size();
                for (int cycle = 0; cycle < 16; cycle++) {
                    int[][] metadata = new int[5][];
                    List<Bitmap> published = new ArrayList<>();
                    for (int i = 0; i < 5; i++) {
                        metadata[i] = metadataWrites(f, i);
                        if (f.image(i).bitmap != null) published.add(f.image(i).bitmap);
                    }
                    f.view.retainPaletteAnchor();
                    ViewTreeObserver.OnPreDrawListener stale = f.view.getViewTreeObserver().listeners.get(0);
                    f.view.dismiss();
                    check(!f.view.isShowing() && field(f.view, "activeCard") == null
                            && ((List<?>) field(f.view, "shownItems")).isEmpty(), "warm dismiss drops pending input snapshot and active reveal");
                    check(f.grid.removals == removals && f.grid.getChildCount() == rows.size(),
                            "warm dismiss never removes retained grid rows " + cycle);
                    for (int i = 0; i < 5; i++) {
                        TabSwitcherView.TabItem hidden = (TabSwitcherView.TabItem) field(f.binding(i), "item");
                        check(f.binding(i) == bindings.get(i) && f.card(i) == oldCards.get(i)
                                && hidden.shell == null && hidden.preview == null
                                && ((java.lang.ref.WeakReference<?>) field(f.binding(i), "shellIdentity")).get() == f.items.get(i).shell
                                && field(f.binding(i), "boundPreview") == null && f.image(i).bitmap == null,
                                "dismiss clears every retained preview reference " + cycle + "/" + i);
                        check(f.image(i).getVisibility() == View.GONE
                                && ((View) field(f.binding(i), "placeholder")).getVisibility() == View.VISIBLE,
                                "hidden preview state is ready for null/recycled reuse " + i);
                    }
                    for (Bitmap bitmap : published) check(!bitmap.isRecycled(), "dismiss never recycles a published preview");
                    f.card(0).performClick(); f.text(0, "close").performClick();
                    headerAction(f, 0).performClick(); headerAction(f, 3).performClick();
                    check(f.recorder.selects == 0 && f.recorder.closes == 0 && f.recorder.news == 0 && f.recorder.dismisses == 0,
                            "GONE cards/header cannot dispatch stale select/close/new/dismiss actions");
                    int selected = cycle % 5;
                    for (int i = 0; i < 5; i++) {
                        TabSwitcherView.TabItem old = f.items.get(i);
                        int kind = (cycle + i) % 4;
                        Bitmap preview = kind == 2 ? null : kind == 3 ? reusable[i] : new Bitmap();
                        if (kind == 1) preview.recycle();
                        f.replace(i, old.title, old.displayUrl, i == selected, preview);
                    }
                    f.view.refresh(f.items);
                    check(((List<?>) field(f.view, "shownItems")).isEmpty() && f.grid.removals == removals,
                            "hidden refresh cannot reacquire a strong input snapshot or rebuild rows");
                    for (int i = 0; i < 5; i++) {
                        TabSwitcherView.TabItem hidden = (TabSwitcherView.TabItem) field(f.binding(i), "item");
                        check(hidden.shell == null && hidden.preview == null && f.image(i).bitmap == null,
                                "hidden refresh cannot reacquire Shells or previews " + i);
                    }
                    f.view.show(f.items); int calls = f.scroll.scrollCalls;
                    stale.onPreDraw();
                    check(f.scroll.scrollCalls == calls && (Boolean) field(f.view, "revealOnLayout")
                            && !(Boolean) field(f.view, "restoreOnLayout"), "obsolete dismissed pre-draw cannot steal a new active reveal");
                    f.measure(400); f.finishLayout(400, 200);
                    check(f.scroll.getScrollY() == ((View) f.card(selected).getParent()).getTop() - 8,
                            "every new open reveals the newly selected active card " + selected);
                    for (int i = 0; i < 5; i++) {
                        Bitmap expected = f.items.get(i).preview;
                        if (expected != null && expected.isRecycled()) expected = null;
                        check(f.card(i) == oldCards.get(i) && f.image(i).bitmap == expected
                                && ((TabSwitcherView.TabItem) field(f.binding(i), "item")).shell == f.items.get(i).shell
                                && java.util.Arrays.equals(metadataWrites(f, i), metadata[i]),
                                "warm reopen preserves cards and binds only current valid previews " + cycle + "/" + i);
                    }
                    for (int i = 0; i < rows.size(); i++) check(f.grid.getChildAt(i) == rows.get(i), "warm reopen preserves row identity " + i);
                    check(f.grid.removals == removals && ((List<?>) field(f.view, "cards")).size() == 5
                            && ((List<?>) field(field(f.view, "cardPalette"), "bindings")).size() == paletteSize
                            && ((List<?>) field(field(f.view, "cardFonts"), "bindings")).size() == fontSize,
                            "repeated warm reopen retains one bounded set of card/palette/font bindings");
                    f.scroll.scrollTo(0, 63);
                }
                TabSwitcherView.TabItem old = f.items.get(4);
                f.replace(4, old.title, old.displayUrl, old.active, new Bitmap()); f.view.refresh(f.items); f.finishLayout(400, 200);
                check(f.scroll.getScrollY() == 63 && f.grid.removals == removals, "warm live preview refresh preserves browsing viewport");
                headerAction(f, 3).performClick(); headerAction(f, 0).performClick();
                check(f.recorder.news == 1 && f.recorder.dismisses == 1, "visible retained header new/dismiss actions stay usable");
            }
            private static void retainedMotionSettlesBeforeReveal() throws Exception {
                for (int motion = 0; motion < 3; motion++) for (int active : new int[]{0, 4}) {
                    Fixture f = new Fixture(); f.open(); f.scroll.maxScroll = 700;
                    for (int i = 0; i < f.items.size(); i++) {
                        TabSwitcherView.TabItem item = f.items.get(i);
                        f.replace(i, item.title, item.displayUrl, i == active, item.preview);
                    }
                    f.view.refresh(f.items); f.finishLayout(400, 200);
                    f.scroll.scrollTo(0, active == 0 ? 170 : 530);
                    int original = f.scroll.getScrollY();
                    View card = f.card(active), row = (View) card.getParent();
                    int removals = f.grid.removals, visibleStops = f.scroll.visibleZeroFlings;
                    if (motion < 2) f.scroll.fling(motion == 0 ? 900 : -900);
                    else f.scroll.smoothScrollTo(0, 690);
                    check(f.scroll.hasPendingScroll(), "motion fixture has a pending absolute offset");
                    f.view.retainPaletteAnchor();
                    ViewTreeObserver.OnPreDrawListener obsolete = f.view.getViewTreeObserver().listeners.get(0);
                    f.view.dismiss();
                    check(!f.scroll.hasPendingScroll() && f.scroll.getScrollY() == original,
                            "warm dismiss settles pending motion at its current in-range offset");
                    check(f.scroll.visibleZeroFlings == visibleStops, "dismiss settlement runs only while overview is GONE");
                    check(!(Boolean) field(f.view, "internalScroll"), "settlement restores internal-scroll ownership");
                    f.scroll.computeScroll();
                    check(f.scroll.getScrollY() == original, "hidden compute cannot continue a retired trajectory");
                    f.view.show(f.items); f.measure(400); f.finishLayout(400, 200);
                    int activeTop = Math.max(0, Math.min(row.getTop() - 8, f.scroll.maxScroll));
                    f.scroll.computeScroll(); f.scroll.computeScroll(); obsolete.onPreDraw();
                    check(f.scroll.getScrollY() == activeTop && !f.scroll.hasPendingScroll(),
                            "warm active reveal survives later modeled draws and obsolete anchor callbacks");
                    check(f.scroll.visibleZeroFlings <= visibleStops + 1, "only the first active reveal adds a visible settlement");
                    check(f.card(active) == card && card.getParent() == row && f.grid.removals == removals,
                            "motion cancellation retains warm card and row identity");
                    int stops = f.scroll.zeroFlings;
                    f.scroll.fling(600); f.view.show(f.items); f.view.refresh(f.items); f.view.applyPalette();
                    check(f.scroll.hasPendingScroll() && f.scroll.zeroFlings == stops,
                            "visible refresh/show/palette never replace normal native navigation");
                    f.scroll.computeScroll();
                    check(f.scroll.getScrollY() > activeTop && f.scroll.zeroFlings == stops,
                            "ordinary fling still moves after a warm reopen");
                    f.scroll.smoothScrollTo(0, 11); f.scroll.computeScroll();
                    check(f.scroll.getScrollY() == 11 && f.scroll.zeroFlings == stops,
                            "ordinary smooth navigation remains native after a warm reopen");
                }
            }
            private static void hiddenMotionAndEdgesSettle() throws Exception {
                for (int edge : new int[]{-35, 735, 0, 700}) {
                    Fixture f = new Fixture(); f.open(); f.scroll.maxScroll = 700;
                    f.scroll.modelNativeOffset(edge); f.scroll.fling(edge < 0 ? -900 : 900);
                    f.view.dismiss();
                    int clamped = Math.max(0, Math.min(edge, 700));
                    check(f.scroll.getScrollY() == clamped && !f.scroll.hasPendingScroll(),
                            "lifecycle clamp prevents unfinished zero-speed edge work");
                    f.scroll.computeScroll();
                    check(f.scroll.getScrollY() == clamped, "retired overfling cannot move the hidden viewport");
                    f.view.dismiss(); f.view.show(f.items); f.measure(400); f.finishLayout(400, 200);
                    int target = f.scroll.getScrollY(); f.scroll.computeScroll();
                    check(f.scroll.getScrollY() == target && !f.scroll.hasPendingScroll(), "edge settlement and repeated dismiss are idempotent");
                }
                for (int motion = 0; motion < 2; motion++) {
                    Fixture f = new Fixture(); f.open(); f.view.dismiss();
                    // Deliberately seed public scroll work while hidden to test show independently of dismiss.
                    if (motion == 0) f.scroll.fling(900); else f.scroll.smoothScrollTo(0, 1111);
                    check(f.scroll.hasPendingScroll(), "hidden motion fixture genuinely has pending work");
                    int visibleStops = f.scroll.visibleZeroFlings;
                    f.view.show(f.items);
                    check(!f.scroll.hasPendingScroll(), "hidden show settles before visibility and first layout");
                    check(f.scroll.visibleZeroFlings == visibleStops, "hidden show settlement precedes visibility");
                    f.measure(400); f.finishLayout(400, 200);
                    int activeTop = ((View) f.card(4).getParent()).getTop() - 8;
                    f.scroll.computeScroll();
                    check(f.scroll.getScrollY() == activeTop && !f.scroll.hasPendingScroll(),
                            "hidden pending motion cannot overwrite the next active reveal");
                    check(f.scroll.visibleZeroFlings <= visibleStops + 1, "only the first active reveal adds a visible settlement");
                    f.scroll.fling(900); f.view.release();
                    check(!f.scroll.hasPendingScroll() && ((List<?>) field(f.view, "cards")).isEmpty(),
                            "permanent release settles motion and releases retained bindings");
                    f.view.release(); f.scroll.computeScroll();
                    check(!f.scroll.hasPendingScroll(), "repeated permanent teardown never leaves native work");
                }
                Fixture empty = new Fixture(); empty.open(); empty.view.dismiss(); empty.items.clear();
                empty.scroll.maxScroll = 0; empty.scroll.modelNativeOffset(35); empty.scroll.smoothScrollTo(0, 700);
                empty.view.show(empty.items); empty.measure(400); empty.finishLayout(400, 200); empty.scroll.computeScroll();
                check(empty.scroll.getScrollY() == 0 && !empty.scroll.hasPendingScroll(),
                        "zero-range empty overview settles without an active card");
            }
            private static void firstRevealSettlesLateLayoutWork() throws Exception {
                Fixture f = new Fixture(); f.open(); f.view.dismiss(); f.view.show(f.items);
                f.view.modelSuperLayoutWork = () -> f.scroll.smoothScrollTo(0, 1111);
                f.measure(400); f.finishLayout(400, 200);
                int activeTop = ((View) f.card(4).getParent()).getTop() - 8;
                f.scroll.computeScroll();
                check(f.view.modelSuperLayoutWork == null && f.scroll.getScrollY() == activeTop
                        && !f.scroll.hasPendingScroll(), "first reveal settles native work created during super layout");
                int stops = f.scroll.zeroFlings;
                f.finishLayout(400, 200); f.view.refresh(f.items); f.finishLayout(400, 200);
                f.view.applyPalette(); f.view.getViewTreeObserver().dispatchOnPreDraw();
                check(f.scroll.zeroFlings == stops, "later layouts live refresh and palette never repeat lifecycle settlement");
            }
            private static void settlementGuardSurvivesFailure() throws Exception {
                for (int operation = 0; operation < 2; operation++) {
                    Fixture f = new Fixture(); f.open();
                    f.scroll.failZeroFling = operation == 0; f.scroll.failCompute = operation == 1;
                    try {
                        f.view.dismiss(); throw new AssertionError("modeled native failure was not exercised");
                    } catch (IllegalStateException expected) {
                        check(expected.getMessage().startsWith("modeled "), "only the intentional fixture failure is accepted");
                    }
                    check(!(Boolean) field(f.view, "internalScroll"), "settlement guard restores ownership after native exception");
                    f.scroll.failZeroFling = false; f.scroll.failCompute = false; f.view.release();
                    check(!(Boolean) field(f.view, "internalScroll") && !f.scroll.hasPendingScroll(),
                            "subsequent teardown remains usable after a modeled native exception");
                }
            }
            private static void hiddenChangesRevalidateStructure() throws Exception {
                for (int change = 0; change < 7; change++) {
                    Fixture f = new Fixture(); f.open();
                    View oldCard = f.card(0); Object oldBinding = f.binding(0);
                    View.OnClickListener staleSelect = clickListener(oldCard), staleClose = clickListener(f.text(0, "close"));
                    int removals = f.grid.removals, width = 400, rowHeight = 200;
                    f.view.dismiss();
                    if (change == 0) {
                        NativeBrowserActivity.C_SURFACE = 0xff454545; f.view.applyPalette();
                        check(((GradientDrawable) oldCard.getBackground()).color == NativeBrowserActivity.C_SURFACE,
                                "hidden theme updates retained card surfaces in place");
                        f.replace(0, "Hidden updated", "https://hidden.test/path", false, new Bitmap());
                    } else if (change == 1) {
                        f.context.getResources().getConfiguration().fontScale = 1.5f; f.view.applyFontScale(); rowHeight = 300;
                        check(f.text(0, "title").textSizePx == 19.5f
                                && ((TextView) field(f.view, "countLabel")).textSizePx == 18.75f,
                                "hidden font event updates retained card and static SP bindings");
                    } else if (change == 2) {
                        f.context.getResources().getDisplayMetrics().density = 2f; width = 800;
                        f.view.applyFontScale();
                    } else if (change == 3) width = 250;
                    else if (change == 4) {
                        TabSwitcherView.TabItem old = f.items.get(1);
                        f.items.set(1, new TabSwitcherView.TabItem(new Shell(), old.title, old.displayUrl, old.active, new Bitmap()));
                        Collections.reverse(f.items);
                    } else if (change == 5) {
                        f.items.remove(4); TabSwitcherView.TabItem old = f.items.get(3);
                        f.replace(3, old.title, old.displayUrl, true, old.preview);
                    } else f.items.clear();
                    f.measure(width); f.finishLayout(width, rowHeight);
                    check(f.grid.removals == removals && f.view.getViewTreeObserver().listeners.isEmpty(),
                            "hidden config/state changes do not rebuild or arm viewport callbacks " + change);
                    f.view.show(f.items); f.measure(width); f.finishLayout(width, rowHeight);
                    check(f.grid.removals == removals + (change == 0 ? 0 : 1), "reopen rebuilds exactly for real structural/metric changes " + change);
                    if (change == 0) {
                        check(f.card(0) == oldCard && f.text(0, "title").getText().toString().equals("Hidden updated")
                                && f.text(0, "url").getText().toString().equals("hidden.test")
                                && oldCard.getContentDescription().toString().endsWith("Hidden updated"),
                                "hidden content/theme changes bind without replacing card/accessibility identity");
                    } else {
                        check(field(oldBinding, "item") == null && field(oldBinding, "boundPreview") == null,
                                "reflow retires old Shell and preview references " + change);
                        staleSelect.onClick(oldCard); staleClose.onClick(oldCard);
                        check(f.recorder.selects == 0 && f.recorder.closes == 0, "retired callbacks ignore closed/reordered Shells after reopen " + change);
                    }
                    for (int i = 0; i < f.items.size(); i++) {
                        TabSwitcherView.TabItem actual = (TabSwitcherView.TabItem) field(f.binding(i), "item");
                        check(actual.shell == f.items.get(i).shell, "reopened card follows current live Shell order " + change + "/" + i);
                        if (actual.active) check(f.scroll.getScrollY() == Math.max(0, ((View) f.card(i).getParent()).getTop()
                                - Math.round(8 * f.context.getResources().getDisplayMetrics().density)),
                                "structural reopen reveals current selection instead of a stale hidden anchor " + change);
                    }
                    if (change == 6) {
                        check(((List<?>) field(f.view, "cards")).isEmpty() && f.grid.getChildCount() == 1,
                                "all closed Shells reopen as the existing honest empty state");
                    } else {
                        f.card(0).performClick(); f.text(0, "close").performClick();
                        check(f.recorder.selected == f.items.get(0).shell && f.recorder.closed == f.items.get(0).shell,
                                "reopened select/close callbacks target current Shell identity " + change);
                    }
                }
            }
            private static void finalReleaseAndObsoleteCallbacks() throws Exception {
                Fixture f = new Fixture(); f.open();
                List<Object> oldBindings = new ArrayList<>();
                List<Bitmap> published = new ArrayList<>();
                for (int i = 0; i < 5; i++) { oldBindings.add(f.binding(i)); published.add(f.image(i).bitmap); }
                View oldCard = f.card(0), oldClose = f.text(0, "close");
                View.OnClickListener staleSelect = clickListener(oldCard), staleClose = clickListener(oldClose);
                f.view.retainInsetsAnchor();
                ViewTreeObserver.OnPreDrawListener staleDraw = f.view.getViewTreeObserver().listeners.get(0);
                f.view.detach();
                check(!f.view.isShowing() && f.grid.getChildCount() == 0 && ((List<?>) field(f.view, "cards")).isEmpty()
                        && ((List<?>) field(f.view, "shownItems")).isEmpty() && field(f.view, "activeCard") == null
                        && field(f.view, "anchorShell") == null && f.view.getViewTreeObserver().listeners.isEmpty(),
                        "final detach releases every retained card/Shell and viewport callback");
                check(((List<?>) field(field(f.view, "cardPalette"), "bindings")).isEmpty()
                        && ((List<?>) field(field(f.view, "cardFonts"), "bindings")).isEmpty(),
                        "final detach releases palette/font closures retaining old views");
                for (Object binding : oldBindings) {
                    check(field(binding, "item") == null && field(binding, "boundPreview") == null
                            && ((java.lang.ref.WeakReference<?>) field(binding, "shellIdentity")).get() == null
                            && ((ImageView) field(binding, "image")).bitmap == null,
                            "even externally held retired card bindings release Shell/bitmap references");
                }
                int removals = f.grid.removals;
                f.view.release(); f.view.detach();
                check(f.grid.removals == removals, "permanent release and detach are idempotent");
                for (Bitmap bitmap : published) check(!bitmap.isRecycled(), "final cleanup never recycles published display-list bitmaps");
                f.view.show(f.items); f.measure(400); f.finishLayout(400, 200);
                check(f.card(0) != oldCard && f.grid.getChildCount() == 3, "a later attach/open starts with fresh bounded cards");
                f.scroll.scrollTo(0, 63); f.view.retainPaletteAnchor();
                Object currentGuard = field(f.view, "paletteAnchorRestore"); int calls = f.scroll.scrollCalls;
                staleDraw.onPreDraw(); staleSelect.onClick(oldCard); staleClose.onClick(oldClose);
                oldCard.performClick(); oldClose.performClick();
                check(f.scroll.scrollCalls == calls && field(f.view, "paletteAnchorRestore") == currentGuard
                        && f.recorder.selects == 0 && f.recorder.closes == 0,
                        "old detached callbacks cannot act on a new open or cancel its current viewport guard");
                f.view.release();
            }
            public static int run() throws Exception {
                unchangedRefreshAndShowCoalesce(); repeatedWarmDismissAndOpen();
                hiddenChangesRevalidateStructure(); finalReleaseAndObsoleteCallbacks();
                paletteAndPreviewKeepIdentity(); paletteSurvivesTransientRangeWithoutRebuild();
                paletteAndStructuralReflowShareOriginalShell(); actualWindowPaletteRetainsDrawableAndCapturesEarly();
                paletteCancellationAndObsoleteSnapshots();
                actualInsetsAfterPalettePreDraw(); insetNavigationCancellation(); insetThenStructuralClampAndIdle();
                insetThenPermanentMetricsClamp();
                closeTargetFitsItsPreviewSlot(); contentAndCallbacksStayCurrent();
                coalescedStructureRestoresAfterLayout(); measuredResizeAndFontReflow(); firstRevealDismissAndDetach();
                retainedMotionSettlesBeforeReveal(); hiddenMotionAndEdgesSettle();
                firstRevealSettlesLateLayoutWork(); settlementGuardSurvivesFailure();
                return checks;
            }
        }
        """;
}
