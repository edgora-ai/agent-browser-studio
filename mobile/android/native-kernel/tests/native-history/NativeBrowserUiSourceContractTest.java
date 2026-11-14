import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.Tree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreeScanner;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

/**
 * Pure-JDK syntax/source-contract regressions for the embedding, not a device/RAF benchmark.
 * Parsing intentionally does not resolve Android/Chromium dependencies; a release build and
 * foreground device checks still need to verify native symbols, real surfaces and lifecycle.
 */
public final class NativeBrowserUiSourceContractTest {
    private static final String SOURCE_DIR =
            "mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel";
    private static final List<String> FILES = List.of(
            "NativeBrowserActivity.java", "TabSwitcherView.java", "NewTabPage.java",
            "BrowserHistoryStore.java", "HistoryPanel.java", "NativeBrowserRuntime.java", "BrowserDialogs.java",
            "NativeBrowserApplication.java", "FingerprintSeedStore.java");
    private static final Map<String, String> sources = new HashMap<>();
    private static final Map<String, String> methods = new HashMap<>();
    private static final Map<String, String> methodDeclarations = new HashMap<>();
    private static int checks;
    private static int failures;

    private NativeBrowserUiSourceContractTest() { }

    public static void main(String[] args) throws IOException {
        boolean assertions = false;
        assert assertions = true;
        check(assertions, "assertions enabled");
        check(Runtime.version().feature() == 17, "run on the release JDK 17 baseline");
        Path root = args.length == 0 ? Path.of("") : Path.of(args[0]);
        parseSources(root.toAbsolutePath());
        retainedActivityAndFrozenReuse();
        explicitEnvironmentExit();
        quietManagerList();
        quietComponentsAndEditors();
        shortSearchAndIndependentHeader();
        nativePaletteContinuity();
        nativeFontContinuity();
        nonDestructiveQuiescence();
        drainAndRejectedActivityRecords();
        privateLifecycleStages();
        eventDrivenForegroundVisibility();
        realPreviewOwnership();
        pageRestoreCover();
        popupAndHistorySemantics();
        overlaySafetyAndWarnings();
        frozenProxyOnlyResolverChain();
        perProfileFingerprintSeeds();
        System.out.println(checks + " UI source-contract checks, " + failures + " failures");
        if (failures != 0) throw new AssertionError("Native browser UI source regressions: " + failures);
    }

    private static void parseSources(Path root) throws IOException {
        sources.put("AndroidManifest.xml.jinja2", Files.readString(root.resolve(
                "mobile/android/native-kernel/AndroidManifest.xml.jinja2"), StandardCharsets.UTF_8));
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new IllegalStateException("A full JDK is required");
        List<Path> paths = new ArrayList<>();
        for (String name : FILES) {
            Path path = root.resolve(SOURCE_DIR).resolve(name);
            sources.put(name, Files.readString(path, StandardCharsets.UTF_8));
            paths.add(path);
        }
        for (String relative : List.of(
                "mobile/android/app/src/main/java/com/ahoo/abs/android/Ui.java",
                "mobile/android/app/src/main/java/com/ahoo/abs/android/MainActivity.java",
                "mobile/android/app/src/main/java/com/ahoo/abs/android/ProfileEditor.java",
                "mobile/android/app/src/main/java/com/ahoo/abs/android/ProxyEditor.java",
                "mobile/android/app/src/main/java/com/ahoo/abs/android/process/LaunchCoordinator.java",
                "mobile/android/core/src/main/java/com/ahoo/abs/core/ProxySpec.java")) {
            Path path = root.resolve(relative);
            sources.put(path.getFileName().toString(), Files.readString(path, StandardCharsets.UTF_8));
            paths.add(path);
        }
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager files = compiler.getStandardFileManager(
                diagnostics, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, diagnostics,
                    List.of("-proc:none", "--release", "17"), null,
                    files.getJavaFileObjectsFromPaths(paths));
            int parsed = 0;
            for (CompilationUnitTree unit : task.parse()) {
                parsed++;
                String unitSource = unit.getSourceFile().getCharContent(true).toString();
                var positions = com.sun.source.util.Trees.instance(task).getSourcePositions();
                new TreeScanner<Void, Void>() {
                    private final ArrayDeque<String> classes = new ArrayDeque<>();
                    @Override public Void visitMethodInvocation(MethodInvocationTree node, Void unused) {
                        String file = unit.getSourceFile().getName();
                        if ((file.endsWith("/NativeBrowserActivity.java") || file.endsWith("/NativeBrowserRuntime.java"))
                                && node.getMethodSelect().toString().matches("Log\\.[diwe]")) {
                            check(node.getArguments().size() == 2, "log has no dynamic fields or Throwable: " + node);
                            check(node.getArguments().size() >= 2
                                            && node.getArguments().get(1).getKind() == Tree.Kind.STRING_LITERAL,
                                    "log message is a compile-time literal: " + node);
                        }
                        return super.visitMethodInvocation(node, unused);
                    }

                    @Override public Void visitClass(ClassTree node, Void unused) {
                        classes.addLast(node.getSimpleName().toString());
                        try { return super.visitClass(node, unused); }
                        finally { classes.removeLast(); }
                    }
                    @Override public Void visitMethod(MethodTree node, Void unused) {
                        if (!classes.isEmpty() && node.getBody() != null) {
                            methods.put(classes.getLast() + "#" + node.getName(), node.getBody().toString());
                            long start = positions.getStartPosition(unit, node.getBody());
                            long end = positions.getEndPosition(unit, node.getBody());
                            if (start < 0 || end <= start || end > unitSource.length()) {
                                throw new AssertionError("Missing actual method source positions: " + node.getName());
                            }
                            methodDeclarations.put(classes.getLast() + "#" + node.getName(),
                                    unitSource.substring(Math.toIntExact(start), Math.toIntExact(end)));
                        }
                        return super.visitMethod(node, unused);
                    }
                }.scan(unit, null);
            }
            check(parsed == paths.size(), "all browser and manager sources parsed with JDK 17");
        }
        for (Diagnostic<? extends JavaFileObject> diagnostic : diagnostics.getDiagnostics()) {
            check(diagnostic.getKind() != Diagnostic.Kind.ERROR,
                    "syntax parse: " + diagnostic);
        }
    }

    private static void retainedActivityAndFrozenReuse() {
        String back = method("NativeBrowserActivity", "returnToList");
        has(back, "FLAG_ACTIVITY_REORDER_TO_FRONT", "manager return preserves activity stack");
        has(back, "FLAG_ACTIVITY_SINGLE_TOP", "manager return avoids duplicate manager instance");
        lacks(back, "finish()", "manager return is not explicit profile exit");
        lacks(back, "FLAG_ACTIVITY_CLEAR_TOP", "manager return cannot clear retained browser");
        String reuse = method("NativeBrowserActivity", "onNewIntent");
        has(reuse, "super.onNewIntent(intent)", "reuse honors Android intent lifecycle");
        has(reuse, "validateIntent(intent)", "reuse revalidates immutable session and nonce");
        has(reuse, "application.verifyFrozenCommandLine()", "reuse validates frozen process switches");
        has(reuse, "!current()", "closed, draining or stale runtime cannot be continued");
        before(reuse, "validateIntent(intent)", "setIntent(intent)", "validate before publishing new intent");
        lacks(reuse, "runtime.attach", "Continue cannot attach a second native runtime");
        lacks(reuse, "prepareInitialTab", "Continue cannot recreate the initial blank tab");
        lacks(reuse, "new ShellManager", "Continue cannot recreate retained shells");
    }

    private static void explicitEnvironmentExit() {
        has(source("NativeBrowserActivity.java"), "\"关闭当前标签页\", \"返回环境列表（保留运行）\", \"退出当前环境\"}", "owned popup menu includes explicit exit after retained return");
        has(method("NativeBrowserActivity", "performMenuAction"), "requestEnvironmentExit()", "exit menu invokes manager handoff");
        has(method("NativeBrowserActivity", "showMenu"), "performMenuAction(title)", "menu delegates unchanged action semantics");
        String request = method("NativeBrowserActivity", "requestEnvironmentExit");
        has(request, "MainActivity.ACTION_REQUEST_ENVIRONMENT_EXIT", "exit routed to manager process");
        has(request, "launch.sessionId", "exit request bound to current session");
        has(request, "launch.nonce", "exit request bound to current nonce");
        lacks(request, "finish()", "browser does not fake exit with Activity finish");
        String consume = method("MainActivity", "consumeExitRequest");
        has(consume, "intent.setAction(null)", "exit action consumed before handling");
        has(consume, "observed.launch.sessionId.equals(session)", "reject stale exit session");
        has(consume, "observed.launch.nonce.equals(nonce)", "reject unauthenticated exit request");
        has(consume, "confirmEnvironmentExit", "exported launcher requires user confirmation");
        lacks(consume, "coordinator.stop()", "external Intent cannot stop environment directly");
        String confirm = method("MainActivity", "confirmEnvironmentExit");
        before(confirm, "expectedSession.equals(observed.launch.sessionId)", "coordinator.stop()",
                "revalidate session at confirmation before stopping");
        before(confirm, "expectedSession.equals(target.launch.sessionId)", "sheet.actions",
                "exit dialog first identifies the current target");
        has(method("MainActivity", "onNewIntent"), "consumeExitRequest(intent)", "retained manager handles exit");
        has(method("MainActivity", "onBackPressed"), "moveTaskToBack(true)", "manager back cannot reveal browser");
        has(method("MainActivity", "onCreate"), "registerOnBackInvokedCallback", "gesture back handles retained task");
        String card = method("MainActivity", "profileCard");
        has(card, "boolean exiting", "exit-unconfirmed card has a retry state");
        has(card, "confirmEnvironmentExit(ownedSession)", "card exit bound to its rendered session");
        lacks(card, "if (running || launching)", "running exit button cannot inherit edit-disabled condition");
        has(method("LaunchCoordinator", "reconcile"), "!stopping", "refresh cannot overwrite actionable exit failure");
        String bind = method("LaunchCoordinator", "bindControl");
        before(bind, "unbindControl()", "context.bindService", "disconnected binding is replaced on explicit retry");
        has(method("Connection", "onBindingDied"), "recoverInvalidBinding()", "dead binding is handled");
        has(method("Connection", "onNullBinding"), "unbindControl()", "null binding does not remain stuck bound");
        String timeout = method("LaunchCoordinator", "watchExitControl");
        has(timeout, "attempt != exitControlGeneration", "timeout is owned by control generation");
        has(timeout, "session.equals(current.sessionId)", "timeout cannot affect another session");
        has(timeout, "confirmAbsent(active)", "timeout checks actual process exit");
        has(timeout, "unbindControl()", "timeout allows explicit retry with fresh HELLO");
        lacks(timeout, "recordConfirmedExit", "timeout never clears environment gate");
    }

    private static void quietManagerList() {
        String home = method("MainActivity", "onCreate");
        lacks(home, "Ui.gradient", "home has no gradient branding");
        String heading = method("MainActivity", "itemHeading");
        lacks(heading, "Ui.avatar", "list uses line icons instead of colored avatars");
        has(heading, "Ui.Glyph.FOLDER", "list uses shared folder glyph");
        has(heading, "setMaxLines(2)", "long names and summaries have wrapping space");
        String profile = method("MainActivity", "profileCard");
        lacks(profile, "Ui.card(this)", "environment is a lightweight row, not a boxed card");
        lacks(profile, "Ui.primary", "each environment does not repeat a primary button");
        lacks(profile, "chipFlow", "metadata is not squeezed into pill rows");
        has(profile, "card.setOnClickListener", "environment row remains actionable");
        lacks(method("MainActivity", "proxyCard"), "Ui.tonal", "proxy rows do not repeat edit buttons");
        has(source("Ui.java"), "BG = 0xFFF7F7F7", "light canvas follows neutral reference");
        has(method("Ui", "positionSegmentIndicator"), "tab.getHeight()", "segmented indicator follows measured text height");
    }

    private static void quietComponentsAndEditors() {
        String buttons = method("Ui", "baseButton");
        has(buttons, "setMinHeight(dp(context, 48))", "button touch minimum is 48dp");
        has(buttons, "setSingleLine(false)", "action text may wrap");
        lacks(buttons, "TruncateAt.END", "critical actions never silently ellipsize");
        has(method("Ui", "iconButton"), "dp(context, 48)", "icon target is independent from glyph");
        has(method("Ui", "root"), "WindowInsets.Type.ime()", "root handles keyboard insets");
        has(source("Ui.java"), "MUTED = 0xFF6A6A6A", "secondary text is not decorative gray");
        has(method("Ui", "danger"), "ON_DANGER", "danger foreground has separate semantic token");
        has(method("Sheet", "dangerActions"), "true", "sheet exposes destructive variant");
        has(source("Ui.java"), "body.addView(heading", "long sheet titles scroll with content");
        has(method("MainActivity", "onCreate"), "runtime.setMaxLines(2)", "runtime summary cannot consume list viewport");
        String actions = method("Sheet", "buildActions");
        has(actions, "LinearLayout.VERTICAL", "sheet stacks actions at narrow/large text sizes");
        has(actions, "if (onPrimary != null) onPrimary.run(); else dialog.dismiss()",
                "callback retains explicit dismissal ownership");
        lacks(actions, "dp(activity, 46)", "sheet actions are content-height rather than fixed");
        String discard = method("ProfileEditor", "confirmDiscard");
        has(discard, "sheet.dangerActions", "discard uses danger semantics");
        before(discard, "sheet.dialog().dismiss()", "target.dismiss()", "discard closes both overlay levels");
        has(method("ProfileEditor", "setError"), "View.VISIBLE", "nonempty field errors become visible");
        has(method("ProfileEditor", "errorLine"), "ACCESSIBILITY_LIVE_REGION_POLITE", "feedback has live region");
        has(method("ProfileEditor", "focusError"), "setFocusableInTouchMode(true)", "action error target can receive touch-mode focus");
        has(method("ProfileEditor", "configureWindow"), "SOFT_INPUT_ADJUST_RESIZE", "editor requests keyboard resize");
        String proxy = method("ProxyEditor", "showForm");
        has(proxy, "requestGeneration != inputGeneration[0]", "stale probe generation is rejected");
        has(proxy, "!requestSnapshot.equals(endpointSnapshot(protocol, host, port))", "probe result belongs to captured endpoint");
        has(proxy, "catch (RuntimeException invalidEndpoint)", "invalid host cannot escape click handler");
        before(proxy, "catch (RuntimeException invalidEndpoint)", "PROBE_EXECUTOR.execute", "endpoint validation precedes worker dispatch");
        has(proxy, "ProfileEditor.setError(testResult, line)", "probe completion uses visible inline feedback");
        has(method("MainActivity", "profileMenu"), "ProfileEditor.show", "existing environment has edit entry");
        has(method("MainActivity", "reload"), "updateRuntimeSheet()", "runtime detail follows observer reload");
        has(method("MainActivity", "updateRuntimeSheet"), "confirmEnvironmentExit(expectedSession)", "runtime exit requires session-bound confirmation");
        has(method("MainActivity", "showRuntime"), "setOnDismissListener", "runtime sheet releases its reference");
        has(method("NativeBrowserActivity", "buildChrome"), "dp(48)", "toolbar tab target remains 48dp");
        has(method("NativeBrowserActivity", "onConfigurationChanged"), "applyChromePalette()", "existing toolbar recolors without kernel recreation");
        has(source("NativeBrowserActivity.java"), "返回环境列表（保留运行）", "return is distinct from stopping");
    }

    /** Source contract only: neither this parser nor NTP host tests execute toolbar buildChrome. */
    // Use actual AST source spans: pretty-printing escapes Chinese and canonicalizes f to F.
    // Existing contracts keep their original AST-body representation unchanged.
    private static String declaration(String owner, String name) {
        String body = methodDeclarations.get(owner + "#" + name);
        if (body == null) throw new IllegalArgumentException("Declaration not parsed: " + owner + "#" + name);
        return body;
    }

    private static boolean searchLabelContract(String body, String editor) {
        String text = compact(body);
        return text.contains(compact(editor + ".setHint(\"搜索\");"))
                && text.contains(compact(editor + ".setContentDescription(\"搜索或输入网址\");"))
                && !text.contains(compact(editor + ".setHint(\"搜索或输入网址\");"));
    }

    private static boolean singleSearchOwnerContract(String ntp) {
        return !ntp.contains("EditText") && !ntp.contains("buildSearchCard")
                && !ntp.contains("setOnEditorActionListener") && !ntp.contains("InputMethodManager")
                && !ntp.contains("SearchEngine.resolve");
    }

    private static void shortSearchAndIndependentHeader() {
        String body = declaration("NativeBrowserActivity", "buildChrome");
        check(searchLabelContract(body, "address"), "sole omnibox has short hint/full label; not runtime accessibility proof");
        check(!searchLabelContract(body.replace("address.setHint(\"搜索\");", "address.setHint(\"搜索或输入网址\");"), "address"),
                "reject old-long-hint in-memory control");
        check(!searchLabelContract(body.replace("address.setContentDescription(\"搜索或输入网址\");", ""), "address"),
                "reject missing-full-label in-memory control");
        String ntp = source("NewTabPage.java");
        check(singleSearchOwnerContract(ntp), "NTP has no second editor, resolver, submission or keyboard owner");
        check(!singleSearchOwnerContract(ntp + "new EditText(context)"), "reject reintroduced real editor negative control");
        check(!singleSearchOwnerContract(ntp + "SearchEngine.resolve(query)"), "reject separate navigation resolver negative control");
        String header = declaration("NewTabPage", "buildIdentityRow");
        has(header, "header.setOrientation(LinearLayout.VERTICAL)", "environment identity and metadata have independent lines");
        has(header, "title.setSingleLine(false)", "full environment name may wrap instead of disappearing");
        lacks(header, "setOnClickListener", "identity does not duplicate the history action");
        String section = declaration("NewTabPage", "buildSectionRow");
        has(section, "all.setContentDescription(\"历史记录\")", "contextual all action has full accessible destination");
        has(section, "all.setMinimumWidth(dp(48))", "history action has48dp width floor");
        has(section, "all.setMinimumHeight(dp(48))", "history action has48dp height floor");
        lacks(method("NewTabPage", "refresh"), "sectionRow.setVisibility", "history destination stays reachable with empty history");
        has(declaration("NewTabPage", "buildEmptyState"), "顶部地址栏", "empty state explains the real next action");
        has(body, "chromeFonts.bind(address, 16)", "sole toolbar editor retains16sp role");
        String history = method("NativeBrowserActivity", "createHistorySurfaces");
        has(history, "browserFrame.addView(historyPanel", "history owns a full-window single header");
        lacks(history, "pageContainer.addView(historyPanel", "history does not stack a second browser header");
        String open = method("NativeBrowserActivity", "showHistoryPanel");
        before(open, "dismissAddressEditor()", "historyPanel.show()", "history takes focus/IME ownership before entry");
        has(open, "IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS", "covered browser chrome is not exposed to accessibility");
        String dismiss = method("HistoryPanel", "dismiss");
        before(dismiss, "searchField.clearFocus()", "setVisibility(View.GONE)", "history releases editor focus before hiding");
        has(dismiss, "hideSoftInputFromWindow", "history filter keyboard closes on dismissal");
        has(method("NativeBrowserActivity", "onBackPressed"), "address.hasFocus()", "Back settles editing independently of suggestions");
        String row = method("HistoryPanel", "makeRow");
        has(row, "remove.setMinimumWidth(dp(48))", "delete does not compete with open-row below48dp width");
        has(row, "remove.setMinimumHeight(dp(48))", "delete target minimum48dp high");
    }

    private static void nativePaletteContinuity() {
        String dispatch = method("NativeBrowserActivity", "applySurfacePalette");
        String chrome = method("NativeBrowserActivity", "applyChromePalette");
        lacks(chrome, "dismiss()", "theme repaint retains open menu identity and focus");
        lacks(chrome, "refreshUrlSuggestions()", "theme repaint retains existing suggestion rows");
        has(chrome, "overflowPalette.apply()", "open menu colors update without reopening");
        has(chrome, "suggestionPalette.apply()", "existing suggestion rows recolor in place");
        lacks(chrome, "address.setBackground(", "address background identity survives repaint");
        before(method("NativeBrowserActivity", "refreshUrlSuggestions"), "suggestionPalette.clear()",
                "urlSuggest.removeAllViews()", "replaced suggestions release their bindings");
        has(method("NativeBrowserActivity", "showMenu"), "overflowPalette.clear()", "dismissed menu releases owned bindings");
        has(method("NativeBrowserActivity", "showMenu"), "setClippingEnabled(true)", "popup uses the public SDK clipping API");
        lacks(source("NativeBrowserActivity.java"), "setClipToScreenEnabled", "non-public popup API must not return");
        has(method("NativeBrowserActivity", "applySystemBarAppearance"), "setSystemBarsAppearance", "modern bar appearance is updated explicitly");
        has(method("NativeBrowserActivity", "applySystemBarAppearance"), "SYSTEM_UI_FLAG_LAYOUT_STABLE",
                "system-bar visibility excursions must not change the retained scroll viewport");
        before(method("BrowserDialogs", "confirm"), "dialog.show()", "dialog.palette.apply()", "dialog window is repainted after framework show initialization");
        lacks(dispatch, "interactive()", "paused/startup palette repaint is not an input action");
        has(dispatch, "closed || quiescing || cleanupComplete", "terminal overlays are not repainted");
        lacks(source("NativeBrowserActivity.java"), "rebuildPaletteSurfaces", "theme changes never replace live overlay owners");
        for (String owner : List.of("NewTabPage", "HistoryPanel", "TabSwitcherView")) {
            String paint = method(owner, "applyPalette");
            has(paint, "readPalette()", owner + " reads current semantic roles");
            has(paint, ".apply()", owner + " repaints owned bindings");
            has(dispatch, "applyPalette()", "activity dispatches native overlay paints");
            for (String forbidden : List.of("new ", "refresh(", "rebuild(", "show(", "dismiss(", "setText(",
                    "requestFocus(", "clearFocus(", "scrollTo(", "setVisibility(", "store.", ".add(")) {
                lacks(paint, forbidden, owner + " palette operation preserves content/state: " + forbidden);
            }
            lacks(source(owner + ".java"), "private final int PAGE", owner + " palette roles are not constructor snapshots");
        }
        has(method("NewTabPage", "applyPalette"), "BrowserDialogs.applyPalette", "NTP retains/repaints its live dialog");
        has(method("HistoryPanel", "applyPalette"), "BrowserDialogs.applyPalette", "history retains/repaints live dialogs");
        has(method("TabSwitcherView", "rebuild"), "cardPalette.clear()", "replaced tab cards release old view bindings");
        has(method("TabSwitcherView", "dismiss"), "cardPalette.clear()", "dismissed tab cards release view bindings");
        has(method("BrowserDialogs", "danger"), "ON_DANGER()", "danger foreground has its own contrast role");
        has(method("BrowserDialogs", "confirm"), "applySystemBarAppearance", "dialog has its own window appearance binding");
        has(method("NativeBrowserActivity", "applySystemBarPalette"), "setBackgroundDrawable", "transparent bars have a palette-aware window underlay");
        has(method("NativeBrowserActivity", "applySystemBarPalette"), "browserFrame.setBackgroundColor(CANVAS)", "inset frame does not expose a light background at night");
        String config = method("NativeBrowserActivity", "onConfigurationChanged");
        before(config, "tabSwitcher.retainPaletteAnchor()", "super.onConfigurationChanged(newConfig)",
                "overview anchor precedes superclass Window configuration dispatch, not just later palette mutations");
        has(method("NativeBrowserActivity", "onCreate"), "browserFrame = createBrowserFrame()", "real Activity uses the tested root inset hook");
        String insetRoot = method("NativeBrowserActivity", "createBrowserFrame");
        before(insetRoot, "tabSwitcher.retainInsetsAnchor()", "super.onApplyWindowInsets(insets)", "logical capture precedes existing inset owner application");
        has(insetRoot, "return super.onApplyWindowInsets(insets)", "root preserves original consumption/IME dispatch result");
        String bars = method("NativeBrowserActivity", "applySystemBarPalette");
        before(bars, "tabSwitcher.retainPaletteAnchor()", "Window windowFrame", "overview anchor is captured before any Window palette mutation");
        has(bars, "windowBackground == null", "window underlay is installed only once per Activity");
        has(bars, "windowBackground.setColor(CANVAS)", "later palette changes invalidate the retained window drawable in place");
        lacks(bars, "setBackgroundDrawable(new ", "palette cannot replace the Window background drawable each time");
        before(method("TabSwitcherView", "applyPalette"), "retainPaletteAnchor()", "readPalette()", "standalone overview repaint also protects its viewport");
        String anchor = method("TabSwitcherView", "retainPaletteAnchor");
        has(anchor, "paletteObserver != null", "palette work coalesces until its settled pre-draw");
        before(anchor, "retainScrollPosition()", "addOnPreDrawListener", "capture precedes registration of the final-layout restore");
        lacks(anchor, ".post(", "no delayed retry can race the settled range");
        has(source("TabSwitcherView.java"), "if (paletteAnchorRestore != this)", "obsolete pre-draw snapshot cannot consume a new transaction");
        has(method("TabSwitcherView", "onLayout"), "restoreOnLayout && paletteObserver == null", "intermediate inset layout cannot consume a palette anchor");
        has(method("TabSwitcherView", "restoreScrollPosition"), "scroll.getScrollY() != target", "unchanged palette viewport causes no scroll call");
        has(method("TabSwitcherView", "cancelScrollWork"), "removePaletteAnchorListener()", "dismiss/detach/show/input release observer ownership");
        for (String input : List.of("dispatchTouchEvent", "dispatchGenericMotionEvent", "dispatchKeyEvent")) {
            has(method("TabSwitcherView", input), "cancelScrollWork()", "new user input wins over deferred anchor work: " + input);
        }
        has(source("TabSwitcherView.java"), "new FrameLayout.LayoutParams(dp(48), dp(48), Gravity.TOP | Gravity.END)", "overview close target is at least 48dp without resizing the preview slot");
    }

    private static void nativeFontContinuity() {
        has(source("AndroidManifest.xml.jinja2"),
                "android:configChanges=\"orientation|screenSize|keyboardHidden|uiMode|fontScale\"",
                "only fontScale is added to the native Activity configuration contract");
        has(method("NativeBrowserActivity", "onCreate"),
                "appliedFontScale = getResources().getConfiguration().fontScale", "initialize last-applied font scale");
        String config = method("NativeBrowserActivity", "onConfigurationChanged");
        before(config, "tabSwitcher.retainPaletteAnchor()", "super.onConfigurationChanged(newConfig)",
                "font configuration retains the existing pre-super anchor boundary");
        has(config, "Float.compare(appliedFontScale, newConfig.fontScale)", "compare applied state, not already-updated Resources");
        before(config, "appliedFontScale = newConfig.fontScale", "applySurfaceFonts()", "record current font before dispatch");
        has(method("FontBindings", "bind"), "view.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, originalSp)",
                "framework SP handles nonlinear conversion; no cached pixel size");
        has(method("FontBindings", "clear"), "bindings.clear()", "retired font owners release references");
        String dispatch = method("NativeBrowserActivity", "applySurfaceFonts");
        has(dispatch, "closed || quiescing || cleanupComplete", "terminal owners cannot receive font dispatch");
        lacks(dispatch, "interactive()", "startup/hidden/paused font refresh is not an input action");
        for (String owner : List.of("chromeFonts", "suggestionFonts", "overflowFonts")) {
            has(dispatch, owner + ".apply()", "existing Activity font owner refreshes: " + owner);
        }
        for (String owner : List.of("newTab", "historyPanel", "tabSwitcher")) {
            has(dispatch, "if (" + owner + " != null) " + owner + ".applyFontScale()", "null-safe font surface: " + owner);
        }
        for (String owner : List.of("NewTabPage", "HistoryPanel", "TabSwitcherView")) {
            String font = method(owner, "applyFontScale");
            has(font, "staticFonts.apply()", "static font roles refresh on " + owner);
            for (String forbidden : List.of("refresh(", "rebuild(", "removeAllViews(", "setText(", "clearFocus(", "hideKeyboard(")) {
                lacks(font, forbidden, "font refresh preserves existing content/focus on " + owner + ": " + forbidden);
            }
        }
        for (String body : List.of(config, dispatch)) {
            for (String forbidden : List.of("runtime.", "manager.", "window.", "initializeBrowserUi(", "createBlankTab(",
                    "closeNativeView(", "finish(", "recreate(", "setContentView(", "dismiss(")) {
                lacks(body, forbidden, "font configuration does not change native/window ownership: " + forbidden);
            }
        }
        before(method("NewTabPage", "refresh"), "tileFonts.clear()", "tiles.removeAllViews()", "replaced tile fonts retire");
        before(method("HistoryPanel", "rebuild"), "rowFonts.clear()", "list.removeAllViews()", "replaced history fonts retire");
        before(method("TabSwitcherView", "rebuild"), "cardFonts.clear()", "grid.removeAllViews()", "replaced card fonts retire");
        has(method("TabSwitcherView", "dismiss"), "cardFonts.clear()", "dismissed card fonts retire");
        before(method("NativeBrowserActivity", "refreshUrlSuggestions"), "suggestionFonts.clear()", "urlSuggest.removeAllViews()",
                "replaced suggestion fonts retire");
        String menu = method("NativeBrowserActivity", "showMenu");
        has(menu, "overflowFonts.clear()", "dismissed overflow fonts retire");
        has(menu, "anchor.addOnLayoutChangeListener(anchorLayout)", "live popup responds to actual anchor layout only");
        has(menu, "Runnable resize = () -> resizeOverflowMenu(popup, scroll, anchor)", "same owner receives one direct remeasure");
        has(menu, "anchor.removeOnLayoutChangeListener(anchorLayout)", "popup anchor listener retires on dismiss");
        for (String forbidden : List.of("post(", "postDelayed(", "addOnGlobalLayoutListener(", "addOnPreDrawListener(")) {
            lacks(menu, forbidden, "popup layout hook has no timer/retry/global self-layout loop: " + forbidden);
        }
        has(menu, "overflowResize = null", "dismissed popup releases its resize owner");
        String resize = method("NativeBrowserActivity", "resizeOverflowMenu");
        has(resize, "overflowMenu != popup || !popup.isShowing()", "retired popup cannot resize a replacement");
        has(resize, "getMaxAvailableHeight(anchor, dp(6))", "live popup uses actual anchor bounds");
        has(resize, "View.MeasureSpec.AT_MOST", "live popup has a bounded scroll viewport");
        has(resize, "popup.update(width, scroll.getMeasuredHeight())", "resize same live popup after actual text growth");
        for (String forbidden : List.of("showAsDropDown", "dismiss(", "scrollTo(", "requestFocus(", "requestLayout(", "post(")) {
            lacks(resize, forbidden, "popup font remeasure retains identity/scroll/focus: " + forbidden);
        }
        has(method("NewTabPage", "applyFontScale"), "BrowserDialogs.applyFontScale(removalDialog)", "NTP dialog follows system font");
        has(method("HistoryPanel", "applyFontScale"), "BrowserDialogs.applyFontScale(clearDialog)", "clear dialog follows system font");
        has(method("HistoryPanel", "applyFontScale"), "BrowserDialogs.applyFontScale(rowDialog)", "row dialog follows system font");
        has(method("ThemedDialog", "dismiss"), "fonts.clear()", "dismissed dialog drops its font callbacks");
        has(method("DialogActions", "onMeasure"), "cancel.getMeasuredWidth()", "complete cancel label decides horizontal fit");
        has(method("DialogActions", "onMeasure"), "confirm.getMeasuredWidth()", "complete positive label decides horizontal fit");
        has(method("DialogActions", "onMeasure"), "stacked ? VERTICAL : HORIZONTAL", "actions stack from measured content");
        lacks(method("DialogActions", "onMeasure"), "fontScale", "stacking does not use a magic font-scale threshold");
        has(method("DialogPanel", "onMeasure"), "available - margins - actions.getMeasuredHeight()", "body scroll budget reserves actions");
        has(method("BrowserDialogs", "confirm"), "panel.addView(textScroll", "dialog text is separately scrollable");
        has(source("TabSwitcherView.java"), "Math.max(dp(122), placeholder.getMeasuredHeight())", "preview floor admits measured large-font content");
        has(source("TabSwitcherView.java"), "placeholder.measure", "preview grows from owned text, not bitmap intrinsic dimensions");
        String[][] roles = {
            {"NativeBrowserActivity", "chromeFonts.bind(title, 19)", "chromeFonts.bind(splashStatus, 13)",
                "chromeFonts.bind(tabCounter, 12)", "chromeFonts.bind(address, 16)", "chromeFonts.bind(restoreRetry, 14)", "overflowFonts.bind(action, 14)",
                "suggestionFonts.bind(titleView, 14.5f)", "suggestionFonts.bind(originView, 12)"},
            {"NewTabPage", "staticFonts.bind(footer, 11)", "staticFonts.bind(title, 17)",
                "staticFonts.bind(hint, 12.5f)", "staticFonts.bind(section, 17)", "staticFonts.bind(all, 14)",
                "staticFonts.bind(title, 16)", "staticFonts.bind(body, 13.5f)",
                "tileFonts.bind(avatar, 16)", "tileFonts.bind(name, 12.5f)", "tileFonts.bind(meta, 10.5f)"},
            {"HistoryPanel", "staticFonts.bind(back, 23)", "staticFonts.bind(title, 18)", "staticFonts.bind(clear, 13)",
                "staticFonts.bind(searchField, 14)", "staticFonts.bind(emptyTitle, 13)", "staticFonts.bind(hint, 11)",
                "rowFonts.bind(header, 12.5f)", "rowFonts.bind(badge, 14)", "rowFonts.bind(title, 14)",
                "rowFonts.bind(sub, 12.5f)", "rowFonts.bind(time, 11.5f)", "rowFonts.bind(remove, 15)"},
            {"TabSwitcherView", "staticFonts.bind(emptyLabel, 13)", "staticFonts.bind(back, 23)", "staticFonts.bind(title, 18)",
                "staticFonts.bind(countLabel, 12.5f)", "staticFonts.bind(create, 24)", "staticFonts.bind(label, 12.5f)",
                "staticFonts.bind(hint, 11)", "cardFonts.bind(hostLabel, 11)", "cardFonts.bind(note, 12)",
                "cardFonts.bind(close, 14)", "cardFonts.bind(title, 13)", "cardFonts.bind(badge, 10)",
                "cardFonts.bind(url, 11.5f)", "cardFonts.bind(avatar, 18)"},
            {"BrowserDialogs", "dialog.fonts.bind(heading, 19)", "dialog.fonts.bind(body, 14.5f)", "fonts.bind(view, 14.5f)"}
        };
        int count = 0;
        for (String[] file : roles) {
            String text = source(file[0] + ".java");
            for (int i = 1; i < file.length; i++) {
                has(text, file[i], "original SP role retained: " + file[0] + ": " + file[i]);
                count++;
            }
            lacks(text, "scaledDensity", "no linear pixel conversion in " + file[0]);
            lacks(text, "COMPLEX_UNIT_PX", "no frozen pixel font in " + file[0]);
            lacks(text, "setAutoSizeTextType", "no font shrinking to mask overflow in " + file[0]);
            if (!file[0].equals("NativeBrowserActivity")) lacks(text, ".setTextSize(", "all roles participate in binding: " + file[0]);
        }
        check(count == 47, "all47 surviving/new text roles audited; removed editor/decorative roles are not retained");
    }

    private static void nonDestructiveQuiescence() {
        String quiet = method("NativeBrowserActivity", "quiesceForShutdown");
        has(source("NativeBrowserActivity.java"), "    void quiesceForShutdown()",
                "shutdown barrier is package-private for runtime coordination");
        has(quiet, "Looper.myLooper() != Looper.getMainLooper()", "shutdown is UI-thread-only");
        has(quiet, "quiescing || cleanupComplete", "shutdown barrier is idempotent");
        before(quiet, "quiescing = true", "contents.stop()", "disable actions before stopping navigation");
        has(quiet, "resumed = false", "quiesced browser is not foreground");
        has(quiet, "cancelUiWork()", "quiescence cancels refresh/capture scheduling");
        has(quiet, "historyPanel.quiesce()", "history actions are stopped");
        has(quiet, "newTab.quiesce()", "native new-tab actions are stopped");
        has(quiet, "overflowMenu.dismiss()", "pending native menu is dismissed");
        has(quiet, "for (Shell shell : manager.getShells())", "stop every retained native tab");
        has(quiet, "contents.stop()", "stop pending native navigations");
        has(quiet, "updateWebContentsVisibility(Visibility.HIDDEN)", "hide native pages before storage flush");
        has(quiet, "NATIVE_VIEW_QUIESCE_UNCONFIRMED", "native barrier failure cannot become success");
        for (String destruction : List.of("shell.close()", "manager.destroy()", "window.destroy()",
                "contents.destroy()", "closeNativeView()")) {
            lacks(quiet, destruction, "quiescence retains native objects: " + destruction);
        }
        String cancel = method("NativeBrowserActivity", "cancelUiWork");
        has(cancel, "main.removeCallbacks(chromeRefresh)", "cancel owned refresh work");
        has(cancel, "browserFrame.removeCallbacks(previewCapture)", "cancel owned capture scheduling");
        lacks(cancel, "previewResults.remove", "PixelCopy result cleanup cannot be cancelled");
        lacks(source("NativeBrowserActivity.java"), "removeCallbacksAndMessages",
                "no blanket cancellation that can strand async capture destinations");
        has(method("NativeBrowserActivity", "dispatchTouchEvent"), "quiescing || closed",
                "touch input is consumed after quiescence");
        has(method("NativeBrowserActivity", "dispatchKeyEvent"), "quiescing || closed",
                "key input is consumed after quiescence");
        has(method("NativeBrowserActivity", "current"), "!quiescing", "all observer callbacks honor shutdown");
        before(method("NativeBrowserActivity", "closeNativeView"), "quiesceForShutdown()", "shell.close()",
                "destruction can occur only after the local barrier");
    }

    private static void drainAndRejectedActivityRecords() {
        String begin = method("NativeBrowserRuntime", "beginDrain");
        before(begin, "draining = true", "current.quiesceForShutdown()", "revoke runtime before quiescence");
        before(begin, "current.quiesceForShutdown()", "ShellManager.flushPersistentStorageForShutdown", "retain shells until native flush replies");
        lacks(begin, "closeNativeView()", "no early shell destruction in beginDrain");
        lacks(begin, ".finish()", "no early Activity finish in beginDrain");
        has(source("NativeBrowserRuntime.java"), "DRAIN_TIMEOUT_MS = 5000", "bounded five-second drain retained");
        String done = method("NativeBrowserRuntime", "finishDrain");
        has(done, "!draining || drainReturned || generation != expectedGeneration", "ignore late or stale completion");
        before(done, "drainReturned = true", "current.closeNativeView()", "claim completion before reentrant teardown");
        before(done, "current.closeNativeView()", "current.finish()", "remove record only after native view closes");
        before(done, "current.finish()", "main.post", "request Activity removal before delivering drain receipt");
        has(done, "result = \"FAILED\"", "close/finish exceptions preserve FAILED receipt");
        has(done, "RuntimeException | LinkageError", "teardown runtime/linkage failures remain failures");
        String create = method("NativeBrowserActivity", "onCreate");
        has(create, "boolean runtimeAttached = false", "new Activity starts without runtime ownership");
        before(create, "generation = runtime.attach(this)", "runtimeAttached = true", "attach must return before ownership is committed");
        has(create, "generation = runtime.attach(this); runtimeAttached = true;", "no throwing work between attach and ownership flag");
        has(method("NativeBrowserRuntime", "attach"), "view = activity; activity.onStatus(status); return ++generation;", "attach publishes only through a non-throwing tail");
        check(compact(method("NativeBrowserActivity", "onStatus")).equals("{}"), "status hook cannot throw after runtime ownership is published");
        before(create, "runtimeAttached = true", "DeviceUtils.updateDeviceSpecificUserAgentSwitch", "later initialization rejection is post-attach");
        before(create, "startupFailed(\"NATIVE_STARTUP_REJECTED\")", "if (!runtimeAttached && !closed && !quiescing) finish()", "only unattached create rejection finishes after manager return");
        lacks(method("NativeBrowserActivity", "startupFailed"), "finish()", "shared startup rejection never finishes a live Activity");
        lacks(method("NativeBrowserActivity", "onNewIntent"), "finish()", "onNewIntent rejection preserves live tabs");
        String failure = method("NativeBrowserActivity", "startupFailed");
        has(failure, "!closed && !quiescing && !isFinishing() && !isDestroyed()", "late failure cannot navigate a draining/finished Activity");
        String asynchronous = method("", "onFailure");
        before(asynchronous, "if (!current()) return", "startupFailed", "late startup callback is ignored");
        lacks(asynchronous, "finish()", "async failure cannot destroy an attached runtime");
        has(create, "savedState != null && !launch.sessionId.equals(savedState.getString(ControlProtocol.SESSION))", "saved-session validation retained");
        String validate = method("NativeBrowserActivity", "validateIntent");
        for (String guard : List.of("application.requireBrowserActivation()", "intent == null", "intent.getData() != null",
                "intent.getSelector() != null", "intent.getClipData() != null", "extras == null", "extras.size() != 2",
                "extras.containsKey(\"commandLineArgs\")", "!launch.sessionId.equals(extras.getString(ControlProtocol.SESSION))",
                "!launch.nonce.equals(extras.getString(ControlProtocol.NONCE))")) {
            has(validate, guard, "strict intent gate retained: " + guard);
        }
    }

    private static void privateLifecycleStages() {
        String create = method("NativeBrowserActivity", "onCreate");
        before(create, "Log.i(TAG, \"LIFECYCLE_ON_CREATE_INTENT_VALIDATE\")", "validateIntent(getIntent())", "intent stage is fixed and precedes validation");
        before(create, "Log.i(TAG, \"LIFECYCLE_ON_CREATE_SAVED_STATE_SESSION_CHECK\")", "savedState != null", "saved-state stage precedes session check");
        before(create, "Log.i(TAG, \"LIFECYCLE_ON_CREATE_RUNTIME_ATTACH\")", "runtime.attach(this)", "attach stage precedes runtime ownership");
        has(create, "Log.w(TAG, \"LIFECYCLE_ON_CREATE_REJECTED\")", "create failure has a fixed stage");
        has(method("", "onFailure"), "Log.w(TAG, \"LIFECYCLE_ASYNC_STARTUP_FAILURE\")", "async failure has a distinct fixed stage");
        has(method("NativeBrowserActivity", "onNewIntent"), "Log.w(TAG, \"LIFECYCLE_ON_NEW_INTENT_REJECTED\")", "new intent failure has a distinct fixed stage");
        has(create, "Log.w(TAG, \"LIFECYCLE_ASYNC_VIEW_INITIALIZATION_FAILURE\")", "async view failure has a distinct fixed stage");
    }

    private static void eventDrivenForegroundVisibility() {
        String activity = source("NativeBrowserActivity.java");
        lacks(activity, "uiTick", "no perpetual UI polling runnable");
        lacks(activity, "postDelayed", "no periodic view/history/preview polling");
        has(method("NativeBrowserActivity", "requestChromeRefresh"), "chromeRefreshPosted",
                "native view events coalesce into one main-loop refresh");
        String visibility = method("NativeBrowserActivity", "syncWebContentsVisibility");
        has(visibility, "resumed && current()", "visibility requires actual resumed current activity");
        has(visibility, "pageForeground && shell == active ? Visibility.VISIBLE : Visibility.HIDDEN",
                "only selected foreground WebContents may be visible");
        has(visibility, "contents.getVisibility() != visibility", "visibility updates are idempotent");
        for (String overlay : List.of("historyPanel", "newTab")) {
            has(visibility, overlay, "native overlay hides underlying web page: " + overlay);
        }
        lacks(visibility, "tabSwitcher.isShowing()",
                "tab switcher keeps the active page visible so real previews can be captured");
        String pause = method("NativeBrowserActivity", "onPause");
        before(pause, "resumed = false", "syncWebContentsVisibility()", "background flag set before hiding tabs");
        has(pause, "cancelUiWork()", "pause cancels pending capture/refresh");
        has(pause, "previewEpoch++", "pause invalidates pending pixels");
        has(method("NativeBrowserActivity", "onResume"), "resumed = true", "resume restores foreground state");
        has(method("NativeBrowserActivity", "onResume"), "requestActivePreview", "resume requests real fresh pixels");
        has(method("NativeBrowserActivity", "onStop"), "syncWebContentsVisibility()", "stop reconciles all tab visibility");
        has(method("ShellHistoryObserver", "onVisibilityChanged"), "requestChromeRefresh()",
                "background popup visibility is reconciled from native events");
    }

    private static void realPreviewOwnership() {
        String capture = method("NativeBrowserActivity", "captureActivePreview");
        has(capture, "renderView.getSurfaceView()", "use manager's actual shared renderer SurfaceView");
        has(capture, "surface.getHolder().getSurface().isValid()", "check real surface validity");
        has(capture, "renderer.isReady()", "check native compositor readiness");
        has(capture, "source.isAttachedToWindow()", "source must be attached");
        has(capture, "source.isShown()", "do not capture hidden or detached surfaces");
        has(capture, "observer.awaitingPaint", "cross-document loads wait for paint/load events");
        has(capture, "PixelCopy.request(surface, bitmap", "web previews contain actual compositor pixels");
        has(capture, "source.draw(canvas)", "native new-tab previews contain actual view pixels");
        has(capture, "}, previewResults)", "async result handler is separate from UI work cancellation");
        has(capture, "resumed && validTab(shell) && previewEpoch == epoch", "pending pixels have foreground and epoch ownership");
        has(capture, "manager.getActiveShell() == shell", "shared surface still belongs to captured tab");
        has(capture, "shell.getWebContents() == contents", "WebContents identity must still match");
        has(capture, "url.equals(visibleUrl(shell))", "preview URL must still match");
        has(capture, "result == PixelCopy.SUCCESS && samePage", "only matching successful pixels are published");
        has(capture, "Preview copy rejected", "rejected copies stay diagnosable without string concatenation");
        has(capture, "previewRetries < MAX_PREVIEW_RETRIES", "source-no-data retries are bounded");
        has(method("NativeBrowserActivity", "schedulePreviewCapture"), "postOnAnimation(previewCapture)",
                "retry on a real animation traversal, not timer/JS spoofing");
        has(method("ShellHistoryObserver", "didFirstVisuallyNonEmptyPaint"), "requestActivePreview(shell)",
                "previews captured while tabs are visited, not only at overview open");
        has(method("ShellHistoryObserver", "didStopLoading"), "requestActivePreview(shell)",
                "load completion requests settled pixels");
        has(method("NativeBrowserActivity", "installPreviewSurfaceHooks"), "surfaceChanged",
                "resized/recreated surfaces trigger new captures");
        String compact = compact(capture);
        int success = compact.indexOf("if(result==PixelCopy.SUCCESS&&samePage)");
        int reject = compact.indexOf("}else{", success);
        check(success >= 0 && reject > success
                        && !compact.substring(success, reject).contains("bitmap.recycle()"),
                "published web bitmaps never explicitly recycled");
        int home = compact.indexOf("if(nativeHome)");
        int async = compact.indexOf("previewInFlight=true", home);
        String homeBlock = compact.substring(home, async);
        before(homeBlock, "bitmap.recycle()", "tabPreviews.put", "native draw error is handled before publication");
        lacks(method("NativeBrowserActivity", "closeNativeView"), ".recycle()",
                "cleanup releases published preview references without recycling display lists");
        for (String fake : List.of("evaluateJavaScript", "requestAnimationFrame", "setFrameRate(",
                "setPreferredRefreshRate", "captureContentAsBitmapForTesting", "Bitmap.compress")) {
            lacks(source("NativeBrowserActivity.java"), fake, "no fake score, frame cadence or disk snapshots: " + fake);
        }
    }

    private static void pageRestoreCover() {
        String show = method("NativeBrowserActivity", "showPageRestoring");
        has(show, "restoreSplashShown = true", "reclaimed renderer gets honest page-area loading state");
        has(show, "splash.setVisibility(View.VISIBLE)", "reuse the startup splash without touching the renderer");
        has(show, "isPageReady(shell)", "a ready page is never covered");
        has(show, "restoreShell = shell", "restore state is Shell-owned");
        has(show, "restoreContents = contents", "restore state is WebContents-owned");
        has(show, "restoreUrl = visibleUrl(shell)", "navigation URL belongs to restore state");
        has(show, "restoreEpoch != epoch", "retired deadline cannot alter a new restore");
        has(show, "restoreRetry.setVisibility(View.VISIBLE)", "deadline exposes a real reload action, not an empty page");
        has(show, "splashSpinner.setVisibility(View.GONE)", "a long recovery is not an endless spinner");
        has(show, "postOnAnimationDelayed(restoreTimeout, 8000)", "deadline changes state at8s, not fake readiness");
        lacks(show, "bringToFront()", "recovery stays below chrome/native destinations");
        String owns = method("NativeBrowserActivity", "ownsPageRestoring");
        for (String guard : List.of("restoreGeneration == generation", "manager.getActiveShell() == shell",
                "restoreShell == shell", "restoreContents == contents", "shell.getWebContents() == contents",
                "restoreUrl.equals(visibleUrl(shell))", "interactive()")) {
            has(owns, guard, "recovery ownership guard: " + guard);
        }
        String reconcile = method("NativeBrowserActivity", "reconcilePageRestoring");
        has(reconcile, "active != chromeShell || contents != chromeContents", "all active-owner transitions are reconciled");
        has(reconcile, "changed || stale", "ordinary refresh cannot reset delayed recovery");
        has(method("NativeBrowserActivity", "refreshChrome"), "reconcilePageRestoring()", "close/native-close/new-tab paths share reconciliation");
        has(method("NativeBrowserActivity", "hidePageRestoring"), "removeCallbacks(restoreTimeout)", "cancel stale deadlines explicitly");
        has(method("NativeBrowserActivity", "cancelUiWork"), "hidePageRestoring()", "pause/shutdown retires recovery state");
        String retry = method("NativeBrowserActivity", "retryPageRestoring");
        has(retry, "ownsPageRestoring(shell, contents)", "retry validates current live owner");
        before(retry, "showPageRestoring(shell)", "reload(true)", "reset state before reload prevents repeat taps");
        String complete = method("NativeBrowserActivity", "completePageRestoring");
        has(complete, "ownsPageRestoring(shell, contents) && isPageReady(shell)", "load-stop alone is not success evidence");
        for (String event : List.of("didFirstVisuallyNonEmptyPaint", "didStopLoading")) {
            has(method("ShellHistoryObserver", event), "completePageRestoring(shell, contents)", "observer callback has exact identity: " + event);
        }
        has(method("NativeBrowserActivity", "initializeBrowserUi"), "reparentSplashToPageArea()", "startup cover becomes page-area-only after startup");
        has(method("NativeBrowserActivity", "reparentSplashToPageArea"), "pageContainer.addView(splash", "chrome remains reachable throughout recovery");
        String capture = method("NativeBrowserActivity", "captureActivePreview");
        lacks(capture, "if (!retrying)", "retry callback cannot suppress its own schedule");
        has(capture, "result == PixelCopy.ERROR_TIMEOUT", "only transient copy failures are retryable");
        lacks(capture, "tabSwitcher.isShowing()", "surface-only copy may settle behind overview sibling");
    }

    private static void popupAndHistorySemantics() {
        String hooks = method("NativeBrowserActivity", "installShellObserverHooks");
        has(hooks, "contentview_holder", "popup ContentView initialization hook is retained");
        has(hooks, "observeShell(shell)", "popup observer installed synchronously at initialization");
        lacks(hooks, "postDelayed", "popup first navigation does not race a polling timer");
        String commits = method("ShellHistoryObserver", "didFinishNavigationInPrimaryMainFrame");
        has(commits, "navigation.hasCommitted()", "only committed navigation creates history");
        has(commits, "navigation.isSameDocument()", "same-document navigations do not create repeated visits");
        has(commits, "historyStore.recordVisit", "real top-level visits still recorded");
        has(method("NativeBrowserActivity", "updateNtpVisibility"), "url.equals(newTabUrls.get(active))",
                "native new-tab overlay belongs only to its browser-created blank entry");
        has(method("NativeBrowserActivity", "refreshChrome"), "!address.hasFocus()", "omnibox typing is not overwritten");
        has(method("NativeBrowserActivity", "onBackPressed"), "!interactive()", "back cannot navigate after shutdown");
        has(method("NativeBrowserActivity", "loadResolvedUrl"), "!interactive()", "native search/history cannot navigate after shutdown");
    }

    private static void overlaySafetyAndWarnings() {
        String switcher = source("TabSwitcherView.java");
        has(switcher, "new AnchorScrollView(context)", "tab overview scrolls through all retained tabs");
        has(switcher, "class AnchorScrollView extends ScrollView", "overview retains native ScrollView behavior");
        has(switcher, "widthDp < 300f ? 1 : 2", "overview retains adaptive two-column cards");
        has(method("CardBinding", "bind"), "item.preview != null && !item.preview.isRecycled()", "overview accepts only a valid cached bitmap");
        has(method("CardBinding", "bind"), "image.setImageBitmap(nextPreview)", "overview displays the actual cached bitmap, or clears an absent preview");
        has(method("TabSwitcherView", "refresh"), "canUpdateCards(items, columns)", "unchanged shell order updates retained cards");
        has(method("TabSwitcherView", "onMeasure"), "View.MeasureSpec.getSize(widthMeasureSpec)", "reflow observes the new measured width, not a stale previous width");
        lacks(method("TabSwitcherView", "refresh"), ".post(", "refresh never restores against an old or empty layout range");
        has(method("TabSwitcherView", "onDetachedFromWindow"), "cancelScrollWork()", "detached overview cancels pending layout work");
        has(method("TabSwitcherView", "dismiss"), "cancelScrollWork()", "shutdown/dismiss cancels deferred scrolling");
        has(method("TabSwitcherView", "dismiss"), "grid.removeAllViews()", "dismiss drops stale ImageView references");
        lacks(switcher, ".recycle()", "overview never recycles displayed bitmaps");
        for (String overlay : List.of("NewTabPage", "HistoryPanel")) {
            has(method(overlay, "quiesce"), "quiescing = true", "permanent action barrier: " + overlay);
        }
        has(method("NewTabPage", "confirmRemove"), "if (quiescing) return", "pending remove confirmation cannot mutate stopped profile");
        has(method("HistoryPanel", "confirmClear"), "if (quiescing) return", "pending clear confirmation cannot mutate stopped profile");
        has(method("HistoryPanel", "dismiss"), "onHistoryDismissed()", "dismiss restores correct underlying web visibility");
        has(source("BrowserHistoryStore.java"), "import org.chromium.base.Log;", "history uses Chromium logging facade");
        for (String name : FILES) {
            lacks(source(name), "import android.util.Log;", "NoAndroidLog compatibility: " + name);
            lacks(source(name), "ScrollView.LayoutParams", "canonical FrameLayout parameter type: " + name);
        }
    }

    private static String source(String name) {
        String source = sources.get(name);
        if (source == null) throw new IllegalArgumentException("Source not parsed: " + name);
        return source;
    }

    /**
     * The product is proxy-mandatory, so the only legitimate resolver is the proxy
     * exit: the frozen argv must short-circuit every local resolution path (including
     * DNS prefetch and preconnect hints) so destination hostnames cannot leak to the
     * local ISP resolver, while the proxy endpoint itself stays reachable.
     */
    /**
     * Per-profile fingerprint differentiation: each profile carries a CSPRNG
     * seed generated once and persisted in the app files dir, then frozen into
     * the engine fingerprint payload, so canvas and audio readbacks differ
     * across profiles, stay stable within one profile, and cannot be predicted
     * from the environment name.
     */
    private static void perProfileFingerprintSeeds() {
        String freeze = method("NativeBrowserApplication", "freezeCommandLine");
        has(freeze, "loadOrCreateFingerprintSeed(launch.directorySuffix(), seedContext)",
            "frozen argv must carry the per-profile fingerprint payload");
        has(freeze, "fingerprintConfigPayload(fingerprintSeed)",
            "frozen argv encodes the seed that was just persisted");
        has(freeze, "seed_fp=", "freeze logs a non-reversible seed fingerprint");
        String verify = method("NativeBrowserApplication", "verifyFrozenCommandLineFor");
        has(verify, "readPersistedFingerprintSeed(launch.directorySuffix(), seedContext)",
            "fingerprint payload belongs to the verified frozen switch set");
        String load = method("NativeBrowserApplication", "loadOrCreateFingerprintSeed");
        has(load, "FingerprintSeedStore.loadOrCreate(directorySuffix, context.getFilesDir())",
            "the Application hands the app-private files dir to the seed store");
        String file = method("NativeBrowserApplication", "fingerprintSeedFile");
        has(file, "context.getFilesDir()", "seed storage is app-private");
        lacks(file, "/data/data", "no hardcoded app data path");
        String storeSource = source("FingerprintSeedStore.java");
        String storeLoad = method("FingerprintSeedStore", "loadOrCreate");
        has(storeLoad, "new SecureRandom().nextBytes(fresh)",
            "seed is minted by a CSPRNG, not derived from the env name");
        has(storeLoad, "persistAtomically(file, fresh)",
            "the minted seed is persisted before the read-only verify");
        has(storeSource, "SEED_BYTES = 8", "seed is 8 bytes on disk");
        has(storeSource, "fingerprint-seeds", "seed storage lives under a dedicated dir");
        String storeFile = method("FingerprintSeedStore", "seedFile");
        has(storeFile, "directorySuffix + \".seed\"", "seed file is keyed by the env suffix");
        has(storeFile, "setPosixFilePermissions", "seed directory is owner-only");
        lacks(storeFile, "/data/data", "no hardcoded app data path");
        String persist = method("FingerprintSeedStore", "persistAtomically");
        has(persist, "ATOMIC_MOVE", "seed write is atomic");
        String verifySeed = method("FingerprintSeedStore", "readPersisted");
        has(verifySeed, "stored.length != SEED_BYTES", "persisted seed round-trips exactly");
        String digest = method("FingerprintSeedStore", "fingerprint");
        has(digest, "MessageDigest.getInstance(\"SHA-256\")",
            "logs carry a digest, never the raw seed");
        String payload = method("NativeBrowserApplication", "fingerprintConfigPayload");
        has(payload, "canvasSeed", "canvas noise seed is profile-derived");
        has(payload, "audioSeed", "audio noise seed is profile-derived");
        has(payload, "schemaVersion", "payload keeps the engine schema version");
    }

    private static void frozenProxyOnlyResolverChain() {
        String freeze = method("NativeBrowserApplication", "freezeCommandLine");
        has(freeze, "\"--host-resolver-rules=\" + launch.profile.proxy.hostResolverRules()",
                "frozen argv must carry proxy-exit-only resolver rules");
        has(freeze, "verifyFrozenCommandLineFor(seedContext);",
                "frozen argv is verified before native library load");
        String verify = method("NativeBrowserApplication", "verifyFrozenCommandLineFor");
        has(verify, "launch.profile.proxy.hostResolverRules()",
                "verification reads the same resolver rules builder as the freeze");
        has(verify, "\"host-resolver-rules\"",
                "resolver rules belong to the verified frozen switch set");
        String spec = method("ProxySpec", "hostResolverRules");
        has(spec, "MAP * ~NOTFOUND", "mapped names never reach the system resolver");
        has(spec, "EXCLUDE 127.0.0.1", "loopback proxy endpoints stay reachable");
        has(spec, "EXCLUDE localhost", "localhost proxy endpoints stay reachable");
        has(spec, "HostSyntax.bracket(host)", "IPv6 proxy hosts keep resolver-rule brackets");
    }

    private static String method(String owner, String name) {
        String body = methods.get(owner + "#" + name);
        if (body == null) throw new IllegalArgumentException("Method not parsed: " + owner + "#" + name);
        return body;
    }

    private static String compact(String text) {
        return text.replaceAll("\\s+", "");
    }

    private static void has(String body, String token, String label) {
        check(compact(body).contains(compact(token)), label);
    }

    private static void lacks(String body, String token, String label) {
        check(!compact(body).contains(compact(token)), label);
    }

    private static void before(String body, String first, String second, String label) {
        String text = compact(body);
        int a = text.indexOf(compact(first));
        int b = text.indexOf(compact(second));
        check(a >= 0 && b > a, label);
    }

    private static void check(boolean passed, String label) {
        checks++;
        if (!passed) {
            failures++;
            System.err.println("FAIL " + label);
        }
    }
}
