import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreeScanner;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

/**
 * Compiles actual Activity focus/navigation/refresh/input methods against deterministic JDK hosts.
 * Focus propagation into Chromium, Android window/IME behavior and real RAF require device tests;
 * these are not an Android compile, a document.hasFocus assertion, or an FPS benchmark.
 */
public final class NativeBrowserFocusHostTest {
    private static final Map<String, String> methods = new HashMap<>();
    private static final Map<String, String> fields = new HashMap<>();
    private static String rootListener;
    private static int contracts;

    private NativeBrowserFocusHostTest() { }

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]).toAbsolutePath();
        Path output = Path.of(args[1]).toAbsolutePath().resolve("focus-host");
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        Path activity = root.resolve("mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel/NativeBrowserActivity.java");
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, null,
                    List.of("-proc:none", "--release", "17"), null, files.getJavaFileObjects(activity));
            for (CompilationUnitTree unit : task.parse()) {
                for (Tree top : unit.getTypeDecls()) {
                    if (!(top instanceof ClassTree type)) continue;
                    for (Tree member : type.getMembers()) {
                        if (member instanceof MethodTree method) methods.put(method.getName().toString(), method.toString());
                        if (member instanceof VariableTree field) fields.put(field.getName().toString(), field.toString() + ";\n");
                    }
                }
                new TreeScanner<Void, Void>() {
                    @Override public Void visitMethodInvocation(MethodInvocationTree node, Void unused) {
                        if (node.getMethodSelect().toString().equals("root.setOnFocusChangeListener")) {
                            if (rootListener != null) throw new AssertionError("Ambiguous neutral-root focus listener");
                            rootListener = node + ";";
                        }
                        return super.visitMethodInvocation(node, unused);
                    }
                }.scan(unit, null);
            }
        }
        String members = "";
        for (String name : List.of("pendingFocusShell", "pendingFocusContents", "pendingFocusGeneration", "navigationFocusEpoch", "chromeRefresh",
                "progressBar", "loadingShell", "urlSuggest", "lastBackExitHint")) {
            members += required(fields, name);
        }
        for (String name : List.of("navigate", "cancelNavigationFocus", "completeNavigationFocus",
                "requestChromeRefresh", "refreshChrome", "syncWebContentsVisibility", "updateNtpVisibility",
                "loadResolvedUrl", "loadResolvedUrlInternal", "current", "interactive", "validTab", "cancelUiWork",
                "dispatchTouchEvent", "dispatchKeyEvent", "onWindowFocusChanged", "onPause", "onStop", "onResume",
                "installShellObserverHooks", "showHistoryPanel", "hideUrlSuggestions", "dismissAddressEditor")) members += required(methods, name) + "\n";
        require(rootListener != null, "actual root ownership listener exists");
        String posted = required(fields, "chromeRefresh");
        require(posted.indexOf("refreshChrome()") < posted.indexOf("completeNavigationFocus()"), "posted focus follows refresh");
        require(!required(methods, "refreshChrome").contains("completeNavigationFocus"), "synchronous refresh cannot hand off focus");
        require(!required(methods, "navigate").contains("completeNavigationFocus"), "navigate cannot hand off before returning to main loop");
        for (String name : List.of("showMenu", "showHistoryPanel", "showTabSwitcher", "onBackPressed", "cancelUiWork", "loadResolvedUrl")) {
            require(required(methods, name).contains("cancelNavigationFocus()"), name + " cancels ownership");
        }
        String hierarchy = required(methods, "installShellObserverHooks");
        require(hierarchy.split("cancelNavigationFocus\\(\\)", -1).length == 3, "Shell add and removal both invalidate ticket");
        require(!hierarchy.contains("completeNavigationFocus"), "hierarchy callbacks never focus inline");
        require(!required(methods, "onResume").contains("completeNavigationFocus"), "resume does not mint focus intent");
        String source = Files.readString(activity, StandardCharsets.UTF_8);
        for (String forbidden : List.of(".setFocus(", "evaluateJavaScript(", "requestAnimationFrame", "setFrameRate(")) {
            require(!source.contains(forbidden), "no forced page state or frame-rate adjustment: " + forbidden);
        }
        Files.createDirectories(output);
        Path host = output.resolve("FocusHost.java");
        Files.writeString(host, HOST.replace("@MEMBERS@", members).replace("@ROOT_LISTENER@", rootListener), StandardCharsets.UTF_8);
        Path ime = output.resolve("android/view/inputmethod/InputMethodManager.java");
        Files.createDirectories(ime.getParent());
        Files.writeString(ime, "package android.view.inputmethod; public final class InputMethodManager { public int hides; public boolean hideSoftInputFromWindow(Object token, int flags) { hides++; return true; } }", StandardCharsets.UTF_8);
        Path ids = output.resolve("org/chromium/content_shell/R.java");
        Files.createDirectories(ids.getParent());
        Files.writeString(ids, "package org.chromium.content_shell; public final class R { public static final class id { public static final int contentview_holder = 1; } }", StandardCharsets.UTF_8);
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            boolean compiled = compiler.getTask(null, files, null,
                    List.of("--release", "17", "-Xlint:all", "-Werror", "-classpath", System.getProperty("java.class.path"), "-d", output.toString()),
                    null, files.getJavaFileObjects(host, ime, ids)).call();
            if (!compiled) throw new AssertionError("Actual source-extracted focus host did not compile");
        }
        try (URLClassLoader loader = new URLClassLoader(new URL[] {output.toUri().toURL()}, NativeBrowserFocusHostTest.class.getClassLoader())) {
            Object checks = loader.loadClass("FocusHost").getMethod("run").invoke(null);
            System.out.println(checks + " source-extracted focus fake-host checks + " + contracts + " source contracts, 0 failures");
        }
    }

    private static String required(Map<String, String> values, String name) {
        String value = values.get(name);
        if (value == null) throw new AssertionError("Missing production member: " + name);
        return value;
    }

    private static void require(boolean condition, String message) {
        contracts++;
        if (!condition) throw new AssertionError(message);
    }

    private static final String HOST = """
            import java.util.*;
            import com.ahoo.abs.android.nativekernel.BrowserHistory;
            public final class FocusHost {
                static int checks;
                static final List<String> events = new ArrayList<>();
                static void check(boolean value, String message) { checks++; if (!value) throw new AssertionError(message + " " + events); }
                static final class Handler {
                    final ArrayDeque<Runnable> queue = new ArrayDeque<>();
                    void post(Runnable task) { queue.add(task); }
                    void removeCallbacks(Runnable task) { queue.removeIf(item -> item == task); }
                    void all() { int count = 0; while (!queue.isEmpty()) { if (++count > 20) throw new AssertionError("polling loop"); queue.remove().run(); } }
                }
                interface FocusListener { void changed(View view, boolean focused); }
                static class View {
                    static final int VISIBLE = 0, GONE = 8;
                    static View focus;
                    final Activity owner;
                    final String name;
                    int visibility = VISIBLE, requests;
                    boolean attached = true, shown = true, allowFocus = true;
                    FocusListener listener;
                    Runnable onRequest;
                    View(Activity owner, String name) { this.owner = owner; this.name = name; }
                    boolean isFocused() { return focus == this; }
                    boolean hasFocus() { return isFocused(); }
                    boolean requestFocus() {
                        requests++; events.add(name + "_FOCUS");
                        if (onRequest != null) onRequest.run();
                        if (!allowFocus) return false;
                        View old = focus; focus = this;
                        if (old != this && old != null && old.listener != null) old.listener.changed(old, false);
                        if (old != this && listener != null) listener.changed(this, true);
                        return true;
                    }
                    void clearFocus() { if (focus == this) { focus = null; if (listener != null) listener.changed(this, false); } }
                    void setOnFocusChangeListener(FocusListener value) { listener = value; }
                    int getVisibility() { return visibility; }
                    void setVisibility(int value) { visibility = value; events.add(name + (value == GONE ? "_HIDE" : "_SHOW")); }
                    boolean isAttachedToWindow() { return attached; }
                    boolean isShown() { return shown && visibility == VISIBLE; }
                    Object getWindowToken() { return this; }
                    void removeCallbacks(Runnable task) { }
                    void bringToFront() { }
                    View findViewById(int id) { return null; }
                }
                static class ViewGroup extends View {
                    interface OnHierarchyChangeListener {
                        void onChildViewAdded(View parent, View child);
                        void onChildViewRemoved(View parent, View child);
                    }
                    OnHierarchyChangeListener hierarchy;
                    ViewGroup(Activity owner, String name) { super(owner, name); }
                    void setOnHierarchyChangeListener(OnHierarchyChangeListener value) { hierarchy = value; }
                    @Override boolean hasFocus() { return focus != null && focus.owner == owner; }
                }
                static final class LinearLayout extends ViewGroup {
                    LinearLayout(Activity owner, String name) { super(owner, name); }
                }
                static final class TextView extends View {
                    String text = "";
                    TextView(Activity owner, String name) { super(owner, name); }
                    void setContentDescription(String text) { }
                }
                static final class NewTabPage extends View {
                    NewTabPage(Activity owner) { super(owner, "NTP"); visibility = GONE; }
                    void onShown() { setVisibility(VISIBLE); }
                    void refresh() { }
                    void dismissDialogs() { }
                }
                static final class HistoryPanel extends View {
                    HistoryPanel(Activity owner) { super(owner, "HISTORY"); visibility = GONE; }
                    void dismiss() { visibility = GONE; }
                    void show() { visibility = VISIBLE; }
                }
                static final class TabSwitcher { boolean showing; boolean isShowing() { return showing; } }
                static final class PopupMenu { void dismiss() { } }
                static final class HistoryStore { void flush() { } }
                static final class GURL { final String value; GURL(String value) { this.value = value; } String getSpec() { return value; } }
                static final class NavigationController { boolean canGoBack() { return false; } }
                static final class Visibility { static final int VISIBLE = 0, HIDDEN = 1; }
                static final class WebContents {
                    String url = "https://old.invalid/";
                    boolean destroyed;
                    int visibility = Visibility.VISIBLE;
                    boolean isDestroyed() { return destroyed; }
                    GURL getVisibleUrl() { return new GURL(url); }
                    NavigationController getNavigationController() { return new NavigationController(); }
                    int getVisibility() { return visibility; }
                    void updateWebContentsVisibility(int value) { visibility = value; events.add(value == Visibility.VISIBLE ? "WC_VISIBLE" : "WC_HIDDEN"); }
                }
                static final class Shell extends View {
                    WebContents contents = new WebContents();
                    View content;
                    final ViewGroup holder;
                    boolean destroyed, defer;
                    int loads, contentAccesses;
                    Runnable onLoad;
                    Shell(Activity owner) { super(owner, "SHELL"); content = new View(owner, "PAGE"); holder = new ViewGroup(owner, "HOLDER"); }
                    boolean isDestroyed() { return destroyed; }
                    WebContents getWebContents() { return contents; }
                    View getContentView() { contentAccesses++; if (contents == null || contents.destroyed) throw new AssertionError("unsafe Shell getter"); return content; }
                    void loadUrl(String url) { loads++; if (!defer) contents.url = url; if (onLoad != null) onLoad.run(); }
                    @Override View findViewById(int id) { return holder; }
                }
                static final class ShellManager extends ViewGroup {
                    final List<Shell> shells = new ArrayList<>();
                    Shell active;
                    ShellManager(Activity owner) { super(owner, "MANAGER"); active = new Shell(owner); shells.add(active); }
                    List<Shell> getShells() { return shells; }
                    Shell getActiveShell() { return active; }
                    void selectShell(Shell shell) {
                        if (active != null && hierarchy != null) hierarchy.onChildViewRemoved(this, active);
                        active = shell;
                        if (hierarchy != null) hierarchy.onChildViewAdded(this, shell);
                    }
                    void launchShellInNewTab(String url) { Shell shell = new Shell(owner); shell.contents.url = url; shells.add(shell); selectShell(shell); }
                }
                static final class Runtime {
                    boolean valid = true;
                    boolean isCurrent(Activity activity, long generation) { return valid; }
                }
                static final class MotionEvent {
                    static final int ACTION_DOWN = 0, ACTION_UP = 1, ACTION_MOVE = 2;
                    final int action;
                    MotionEvent(int action) { this.action = action; }
                    int getActionMasked() { return action; }
                }
                static final class KeyEvent {
                    static final int ACTION_DOWN = 0, ACTION_UP = 1;
                    final int action;
                    KeyEvent(int action) { this.action = action; }
                    int getAction() { return action; }
                }
                static final class Toast {
                    static final int LENGTH_SHORT = 0;
                    static Toast makeText(Object context, String text, int length) { return new Toast(); }
                    void show() { }
                }
                static class BaseActivity {
                    boolean windowFocus = true, finishing, destroyed;
                    boolean hasWindowFocus() { return windowFocus; }
                    boolean isFinishing() { return finishing; }
                    boolean isDestroyed() { return destroyed; }
                    public boolean dispatchTouchEvent(MotionEvent event) { return false; }
                    public boolean dispatchKeyEvent(KeyEvent event) { return false; }
                    public void onWindowFocusChanged(boolean focus) { windowFocus = focus; }
                    protected void onPause() { }
                    protected void onStop() { }
                    protected void onResume() { }
                }
                static final class Activity extends BaseActivity {
                    static final int MAX_TABS = 10;
                    static final String INPUT_METHOD_SERVICE = "ime";
                    final Handler main = new Handler();
                    final ViewGroup root = new ViewGroup(this, "ROOT"), browserFrame = new ViewGroup(this, "FRAME");
                    final TextView address = new TextView(this, "ADDRESS"), tabCounter = new TextView(this, "COUNT"), back = new TextView(this, "BACK");
                    final NewTabPage newTab = new NewTabPage(this);
                    final HistoryPanel historyPanel = new HistoryPanel(this);
                    final TabSwitcher tabSwitcher = new TabSwitcher();
                    final HistoryStore historyStore = new HistoryStore();
                    final Runtime runtime = new Runtime();
                    final Map<Shell, Object> tabPreviews = new HashMap<>();
                    final Map<Shell, String> previewUrls = new HashMap<>(), newTabUrls = new HashMap<>();
                    final Runnable previewCapture = () -> { };
                    final android.view.inputmethod.InputMethodManager ime = new android.view.inputmethod.InputMethodManager();
                    ShellManager manager = new ShellManager(this);
                    PopupMenu overflowMenu;
                    long generation = 7, previewEpoch;
                    boolean resumed = true, uiBuilt = true, closed, quiescing, cleanupComplete, chromeRefreshPosted;
                    boolean ntpRenderDirty, previewRequested;
                    Activity() { @ROOT_LISTENER@ installShellObserverHooks(); address.requestFocus(); events.clear(); }
                    Object getSystemService(String service) { return ime; }
                    void trackHistory() { }
                    void hideShellToolbar(Shell shell) { }
                    void tint(TextView text, boolean value) { }
                    void setTextIfChanged(TextView text, String value) { text.text = value; }
                    boolean isBlankPage(Shell shell, String url) { return url == null || url.startsWith("about:blank"); }
                    void refreshTabSwitcher(boolean value) { }
                    void requestActivePreview(Shell shell) { }
                    void observeShell(Shell shell) { requestChromeRefresh(); }
                    void dismissTabSwitcher() { tabSwitcher.showing = false; }
                    @MEMBERS@
                }
                interface Change { void apply(Activity activity, Shell shell, WebContents contents, View content); }
                static Activity navigation(boolean ntp) {
                    Activity a = new Activity(); Shell shell = a.manager.active;
                    if (ntp) { shell.contents.url = "about:blank#owned"; a.newTabUrls.put(shell, shell.contents.url); a.newTab.visibility = View.VISIBLE; shell.defer = true; }
                    a.navigate("https://owned.invalid/probe");
                    check(shell.loads == 1, "one genuine native load requested");
                    check(shell.content.requests == 0, "no inline page focus on navigation stack");
                    check(a.root.isFocused(), "root owns neutral transition focus");
                    check(a.pendingFocusShell == shell && a.pendingFocusContents == shell.contents, "ticket bound to exact active Shell and WebContents");
                    check(a.pendingFocusGeneration == a.generation, "ticket bound to runtime generation");
                    check(a.ime.hides == 1, "address submit hides IME");
                    check(a.main.queue.size() == 1, "only existing coalesced chrome post");
                    return a;
                }
                static void cancelled(String reason, Change change) {
                    Activity a = navigation(true); Shell shell = a.manager.active; WebContents wc = shell.contents; View cv = shell.content;
                    change.apply(a, shell, wc, cv); a.main.all();
                    check(cv.requests == 0, reason + " prevents page focus");
                    check(a.pendingFocusShell == null && a.pendingFocusContents == null, reason + " permanently cancels ticket");
                    a.windowFocus = true; a.resumed = true; a.closed = false; a.quiescing = false; a.cleanupComplete = false; a.uiBuilt = true;
                    a.finishing = false; a.destroyed = false; a.runtime.valid = true; a.generation = 7;
                    if (a.manager == null) a.manager = new ShellManager(a);
                    a.manager.active = shell; if (!a.manager.shells.contains(shell)) a.manager.shells.add(shell);
                    shell.destroyed = false; shell.contents = wc; wc.destroyed = false; wc.url = "https://owned.invalid/probe";
                    a.tabSwitcher.showing = false; a.historyPanel.visibility = View.GONE; a.overflowMenu = null;
                    a.root.requestFocus(); a.requestChromeRefresh(); a.main.all();
                    check(cv.requests == 0, reason + " cannot resurrect after state returns");
                }
                public static int run() {
                    Activity a = navigation(false); View cv = a.manager.active.content;
                    a.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP));
                    check(a.pendingFocusShell != null, "editor ENTER key-up preserves pending handoff");
                    a.main.all(); check(cv.requests == 1 && cv.isFocused(), "posted real content request once");
                    check(a.pendingFocusShell == null && a.pendingFocusContents == null, "ticket consumed before requestFocus");
                    for (int i = 0; i < 4; i++) a.requestChromeRefresh(); a.main.all();
                    check(cv.requests == 1, "regular refreshes never steal focus");
                    a.address.requestFocus(); a.requestChromeRefresh(); a.main.all();
                    check(a.address.isFocused() && cv.requests == 1, "typing survives later refresh");
                    a = navigation(true); Shell target = a.manager.active; cv = target.content;
                    a.main.all(); check(cv.requests == 0 && a.pendingFocusShell == target, "NTP may remain visible asynchronously without focus penetration");
                    check(a.main.queue.isEmpty(), "waiting ticket creates no polling or retries");
                    check(target.contents.visibility == Visibility.HIDDEN, "covered native NTP web contents stays hidden");
                    events.clear(); target.contents.url = "https://owned.invalid/probe"; a.requestChromeRefresh(); a.main.all();
                    check(cv.requests == 1, "real navigation event can finish pending NTP handoff");
                    check(events.indexOf("NTP_HIDE") < events.indexOf("WC_VISIBLE") && events.indexOf("WC_VISIBLE") < events.indexOf("PAGE_FOCUS"), "native overlay hides and contents becomes visible before focus");
                    cancelled("address refocus then root regain", (x, s, w, v) -> { x.address.requestFocus(); check(x.root.hasFocus() && !x.root.isFocused(), "ViewGroup.hasFocus includes editor, isFocused does not"); x.root.requestFocus(); });
                    cancelled("touch down", (x, s, w, v) -> x.dispatchTouchEvent(new MotionEvent(MotionEvent.ACTION_DOWN)));
                    cancelled("new key down", (x, s, w, v) -> x.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN)));
                    cancelled("window loss and gain", (x, s, w, v) -> { x.onWindowFocusChanged(false); x.onWindowFocusChanged(true); });
                    cancelled("pause and resume", (x, s, w, v) -> { x.onPause(); x.onResume(); });
                    cancelled("stop and resume", (x, s, w, v) -> { x.onStop(); x.onResume(); });
                    cancelled("quiesce cancellation", (x, s, w, v) -> { x.quiescing = true; x.cancelUiWork(); });
                    cancelled("another native navigation", (x, s, w, v) -> x.loadResolvedUrl("https://other.invalid/", false));
                    cancelled("history opens and closes before post", (x, s, w, v) -> { x.showHistoryPanel(); x.historyPanel.dismiss(); });
                    cancelled("A to B to A", (x, s, w, v) -> { Shell other = new Shell(x); x.manager.shells.add(other); x.manager.selectShell(other); x.manager.selectShell(s); });
                    cancelled("Shell removal and return", (x, s, w, v) -> { x.manager.hierarchy.onChildViewRemoved(x.manager, s); x.manager.hierarchy.onChildViewAdded(x.manager, s); });
                    List<Change> invalid = List.of(
                            (x,s,w,v) -> x.resumed = false, (x,s,w,v) -> x.uiBuilt = false,
                            (x,s,w,v) -> x.closed = true, (x,s,w,v) -> x.quiescing = true,
                            (x,s,w,v) -> x.cleanupComplete = true, (x,s,w,v) -> x.finishing = true,
                            (x,s,w,v) -> x.destroyed = true, (x,s,w,v) -> x.runtime.valid = false,
                            (x,s,w,v) -> x.generation++, (x,s,w,v) -> x.windowFocus = false,
                            (x,s,w,v) -> x.manager = null, (x,s,w,v) -> x.manager.active = null,
                            (x,s,w,v) -> x.manager.active = new Shell(x), (x,s,w,v) -> x.manager.shells.remove(s),
                            (x,s,w,v) -> s.destroyed = true, (x,s,w,v) -> s.contents = null,
                            (x,s,w,v) -> s.contents = new WebContents(), (x,s,w,v) -> w.destroyed = true,
                            (x,s,w,v) -> x.tabSwitcher.showing = true, (x,s,w,v) -> x.historyPanel.visibility = View.VISIBLE,
                            (x,s,w,v) -> x.overflowMenu = new PopupMenu());
                    int index = 0;
                    for (Change change : invalid) cancelled("guard " + index++, change);
                    a = navigation(true); target = a.manager.active; cv = target.content;
                    a.installShellObserverHooks(); a.manager.hierarchy.onChildViewAdded(a.manager, target);
                    a.navigate("https://owned.invalid/again");
                    target.holder.hierarchy.onChildViewAdded(target.holder, cv);
                    check(cv.requests == 0, "ContentView insertion only posts, never focuses on Shell.init stack");
                    target.contents.url = "https://owned.invalid/again"; a.main.all();
                    check(cv.requests == 1, "insertion's coalesced post can safely finish handoff");
                    for (int state = 0; state < 3; state++) {
                        a = navigation(false); target = a.manager.active; cv = target.content;
                        if (state == 0) target.content = null; else if (state == 1) cv.attached = false; else cv.shown = false;
                        a.main.all(); check(cv.requests == 0 && a.pendingFocusShell != null, "not ready view waits without requests " + state);
                        target.content = cv; cv.attached = true; cv.shown = true; a.requestChromeRefresh(); a.main.all();
                        check(cv.requests == 1, "real readiness event can consume ticket " + state);
                    }
                    a = navigation(false); cv = a.manager.active.content; cv.allowFocus = false;
                    a.main.all(); check(cv.requests == 1 && a.pendingFocusShell == null, "failed real request still consumes ticket");
                    a.requestChromeRefresh(); a.main.all(); check(cv.requests == 1 && a.root.isFocused(), "failed request cannot retry or refocus editor");
                    a = navigation(false); cv = a.manager.active.content; Activity reentrant = a;
                    cv.onRequest = reentrant::completeNavigationFocus; a.main.all(); check(cv.requests == 1, "reentrant focus callback sees consumed ticket");
                    for (String invalidUrl : List.of("", "  ", "javascript:alert(1)", "file:///private")) {
                        a = new Activity(); a.navigate(invalidUrl); a.main.all();
                        check(a.manager.active.loads == 0 && a.manager.active.content.requests == 0, "invalid address does not issue load or ticket: " + invalidUrl);
                        check(a.address.isFocused() && a.ime.hides == 0 && a.pendingFocusShell == null, "invalid address preserves editing");
                    }
                    for (int state = 0; state < 11; state++) {
                        a = new Activity(); Activity changed = a; Shell s = a.manager.active; int kind = state;
                        s.onLoad = () -> { switch (kind) { case 0 -> changed.resumed = false; case 1 -> changed.generation++; case 2 -> changed.windowFocus = false; case 3 -> changed.manager.active = new Shell(changed); case 4 -> s.contents = new WebContents();
                            case 5 -> { changed.onWindowFocusChanged(false); changed.onWindowFocusChanged(true); }
                            case 6 -> { changed.onPause(); changed.onResume(); }
                            case 7 -> { Shell other = new Shell(changed); changed.manager.shells.add(other); changed.manager.selectShell(other); changed.manager.selectShell(s); }
                            case 8 -> changed.dispatchTouchEvent(new MotionEvent(MotionEvent.ACTION_DOWN));
                            case 9 -> changed.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN));
                            case 10 -> { changed.showHistoryPanel(); changed.historyPanel.dismiss(); }
                            default -> throw new AssertionError(); } };
                        a.navigate("https://owned.invalid/"); a.main.all();
                        check(s.content.requests == 0 && a.pendingFocusShell == null && a.address.isFocused(), "reentrant native load invalidation cannot publish focus intent " + state);
                    }
                    a = new Activity(); a.manager.active.contents = null; a.navigate("https://owned.invalid/");
                    check(a.manager.active.loads == 0 && a.manager.active.contentAccesses == 0, "uninitialized Shell cannot load or dereference content getter");
                    a = new Activity(); a.requestChromeRefresh(); a.main.all();
                    check(a.manager.active.content.requests == 0, "empty intent: refresh never mints focus request");
                    return checks;
                }
            }
            """;
}
