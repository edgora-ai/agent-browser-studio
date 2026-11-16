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
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

/** Executes actual binding/dispatch code on a JDK host, not Android rendering or IME tests. */
public final class NativeBrowserPaletteHostTest {
    private NativeBrowserPaletteHostTest() { }

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]).toAbsolutePath();
        Path output = Path.of(args[1]).toAbsolutePath().resolve("palette-host");
        Path activity = root.resolve("mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel/NativeBrowserActivity.java");
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        Map<String, String> members = new HashMap<>();
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, null,
                    List.of("-proc:none", "--release", "17"), null, files.getJavaFileObjects(activity));
            for (CompilationUnitTree unit : task.parse()) {
                for (Tree top : unit.getTypeDecls()) {
                    if (!(top instanceof ClassTree type)) continue;
                    for (Tree member : type.getMembers()) {
                        if (member instanceof ClassTree nested && nested.getSimpleName().contentEquals("PaletteBindings")) {
                            members.put("PaletteBindings", nested.toString());
                        }
                        if (member instanceof MethodTree method) members.put(method.getName().toString(), method.toString());
                    }
                }
            }
        }
        String actual = "";
        for (String name : List.of("PaletteBindings", "applySurfacePalette", "onConfigurationChanged")) {
            if (!members.containsKey(name)) throw new AssertionError("Missing production member " + name);
            actual += members.get(name) + "\n";
        }
        Files.createDirectories(output);
        Path host = output.resolve("PaletteHost.java");
        Files.writeString(host, HOST.replace("@ACTUAL@", actual), StandardCharsets.UTF_8);
        Path config = output.resolve("android/content/res/Configuration.java");
        Files.createDirectories(config.getParent());
        Files.writeString(config, "package android.content.res; public final class Configuration { public float fontScale = 1; }", StandardCharsets.UTF_8);
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            boolean compiled = compiler.getTask(null, files, null,
                    List.of("--release", "17", "-Xlint:all", "-Werror", "-d", output.toString()), null,
                    files.getJavaFileObjects(host, config)).call();
            if (!compiled) throw new AssertionError("Actual palette code did not compile on fake host");
        }
        try (URLClassLoader loader = new URLClassLoader(new URL[]{output.toUri().toURL()}, NativeBrowserPaletteHostTest.class.getClassLoader())) {
            Object checks = loader.loadClass("PaletteHost").getMethod("run").invoke(null);
            System.out.println(checks + " source-extracted palette binding/dispatch fake-host checks, 0 failures");
        }
    }

    private static final String HOST = """
            import java.util.ArrayList;
            import java.util.List;
            class PaletteBase {
                int superCalls;
                final List<String> configOrder = new ArrayList<>();
                public void onConfigurationChanged(android.content.res.Configuration ignored) {
                    configOrder.add("super");
                    superCalls++;
                }
            }
            public final class PaletteHost extends PaletteBase {
                @ACTUAL@
                static boolean C_DARK;
                static boolean requestedDark;
                boolean closed, quiescing, cleanupComplete, resumed, uiBuilt;
                Surface newTab, historyPanel, tabSwitcher;
                int chromePaints, refreshes;
                float appliedFontScale = 1;
                void applySurfaceFonts() { }
                static int checks;
                static void resolvePalette(PaletteHost ignored) { C_DARK = requestedDark; }
                void applyChromePalette() { chromePaints++; }
                void requestChromeRefresh() { refreshes++; }
                static final class Surface {
                    int paints;
                    List<String> configOrder;
                    void retainPaletteAnchor() { if (configOrder != null) configOrder.add("anchor"); }
                    void applyPalette() { paints++; }
                }
                static void check(boolean pass, String message) {
                    checks++;
                    if (!pass) throw new AssertionError(message);
                }
                public static int run() {
                    PaletteBindings bindings = new PaletteBindings();
                    int[] value = {1};
                    int[] paints = {0};
                    int[] oldRow = {0};
                    bindings.add(() -> paints[0] = value[0]);
                    check(paints[0] == 1, "register paints immediately");
                    value[0] = 7;
                    bindings.apply();
                    check(paints[0] == 7, "bindings use current semantic palette");
                    bindings.add(() -> oldRow[0]++);
                    check(oldRow[0] == 1, "second binding paints initially");
                    bindings.apply();
                    check(oldRow[0] == 2, "existing row repaints without re-register");
                    bindings.clear();
                    value[0] = 9;
                    bindings.apply();
                    check(paints[0] == 7 && oldRow[0] == 2, "clear releases removed rows");
                    bindings.add(() -> paints[0] = value[0]);
                    bindings.apply();
                    check(paints[0] == 9 && oldRow[0] == 2, "new rows do not retain old row bindings");
                    for (int state = 0; state < 4; state++) {
                        PaletteHost host = new PaletteHost();
                        host.resumed = (state & 1) != 0;
                        host.uiBuilt = (state & 2) != 0;
                        Surface ntp = host.newTab = new Surface();
                        Surface history = host.historyPanel = new Surface();
                        Surface tabs = host.tabSwitcher = new Surface();
                        tabs.configOrder = host.configOrder;
                        C_DARK = false;
                        requestedDark = true;
                        host.onConfigurationChanged(new android.content.res.Configuration());
                        check(host.configOrder.equals(List.of("anchor", "super")),
                                "palette anchor capture precedes superclass dispatch " + state);
                        check(ntp.paints == 1 && history.paints == 1 && tabs.paints == 1,
                                "startup/paused/ready surfaces all repaint " + state);
                        check(host.newTab == ntp && host.historyPanel == history && host.tabSwitcher == tabs,
                                "palette dispatch retains overlay identities " + state);
                        check(host.chromePaints == 1 && host.superCalls == 1, "chrome and superclass updated " + state);
                        host.onConfigurationChanged(new android.content.res.Configuration());
                        check(ntp.paints == 1 && host.chromePaints == 1, "same-mode event does not repaint " + state);
                        check(host.configOrder.equals(List.of("anchor", "super", "anchor", "super")),
                                "same-mode configuration retains pre-super capture order " + state);
                        requestedDark = false;
                        host.onConfigurationChanged(new android.content.res.Configuration());
                        check(ntp.paints == 2 && history.paints == 2 && tabs.paints == 2, "reverse switch repaints " + state);
                        check(host.configOrder.equals(List.of("anchor", "super", "anchor", "super", "anchor", "super")),
                                "reverse palette switch captures before superclass dispatch " + state);
                        check(host.refreshes == 3, "config retains coalesced refresh request " + state);
                    }
                    for (int terminal = 0; terminal < 3; terminal++) {
                        PaletteHost host = new PaletteHost();
                        host.newTab = new Surface();
                        host.closed = terminal == 0;
                        host.quiescing = terminal == 1;
                        host.cleanupComplete = terminal == 2;
                        host.applySurfacePalette();
                        check(host.newTab.paints == 0, "terminal owner is not repainted " + terminal);
                    }
                    PaletteHost beforeViews = new PaletteHost();
                    beforeViews.applySurfacePalette();
                    check(beforeViews.newTab == null, "null startup surfaces are harmless");
                    beforeViews.onConfigurationChanged(new android.content.res.Configuration());
                    check(beforeViews.configOrder.equals(List.of("super")),
                            "configuration before surfaces retains superclass dispatch");
                    return checks;
                }
            }
            """;
}
