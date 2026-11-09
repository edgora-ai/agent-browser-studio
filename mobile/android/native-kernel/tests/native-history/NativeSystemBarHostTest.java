import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
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
 * Executes the actual source-extracted system-bar method against small deterministic host fixtures.
 * Checks requested flags, colors, and API gating; not Android runtime or navigation-inset stability.
 */
public final class NativeSystemBarHostTest {
    private NativeSystemBarHostTest() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Expected repository root and output directory");
        Path root = Path.of(args[0]).toAbsolutePath();
        Path output = Path.of(args[1]).toAbsolutePath().resolve("system-bar-host");
        Path activity = root.resolve("mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel/NativeBrowserActivity.java");
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new AssertionError("A JDK 17 compiler is required");
        Map<String, String> members = new HashMap<>();
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, null,
                    List.of("-proc:none", "--release", "17"), null, files.getJavaFileObjects(activity));
            for (CompilationUnitTree unit : task.parse()) {
                for (Tree top : unit.getTypeDecls()) {
                    if (!(top instanceof ClassTree type)
                            || !type.getSimpleName().contentEquals("NativeBrowserActivity")) continue;
                    for (Tree member : type.getMembers()) {
                        if (member instanceof VariableTree field
                                && (field.getName().contentEquals("C_DARK") || field.getName().contentEquals("C_CANVAS"))) {
                            members.put(field.getName().toString(), field.toString() + ";");
                        }
                        if (member instanceof MethodTree method && method.getName().contentEquals("applySystemBarAppearance")) {
                            members.put("applySystemBarAppearance", method.toString());
                        }
                    }
                }
            }
        }
        StringBuilder actual = new StringBuilder();
        for (String name : List.of("C_DARK", "C_CANVAS", "applySystemBarAppearance")) {
            if (!members.containsKey(name)) throw new AssertionError("Missing production member " + name);
            actual.append(members.get(name)).append('\n');
        }
        List<Path> sources = new ArrayList<>();
        for (String[] fixture : FIXTURES) {
            Path source = output.resolve(fixture[0] + ".java");
            Files.createDirectories(source.getParent());
            Files.writeString(source, fixture[1], StandardCharsets.UTF_8);
            sources.add(source);
        }
        Path host = output.resolve("com/ahoo/abs/android/nativekernel/SystemBarChecks.java");
        Files.createDirectories(host.getParent());
        Files.writeString(host, CHECKS.replace("@ACTUAL@", actual.toString()), StandardCharsets.UTF_8);
        sources.add(host);
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            boolean compiled = compiler.getTask(null, files, null,
                    List.of("-proc:none", "--release", "17", "-Xlint:all", "-Werror", "-d", output.toString()), null,
                    files.getJavaFileObjectsFromPaths(sources)).call();
            if (!compiled) throw new AssertionError("Actual system-bar method did not compile against host fixtures");
        }
        try (URLClassLoader loader = new URLClassLoader(new URL[]{output.toUri().toURL()}, NativeSystemBarHostTest.class.getClassLoader())) {
            Object checks = loader.loadClass("com.ahoo.abs.android.nativekernel.SystemBarChecks").getMethod("run").invoke(null);
            System.out.println(checks + " source-extracted system-bar host checks passed (not Android runtime or navigation-inset stability)");
        }
    }

    private static final String[][] FIXTURES = {
        {"android/os/Build", """
            package android.os;
            public final class Build {
                public static final class VERSION { public static int SDK_INT; }
                public static final class VERSION_CODES { public static final int R = 30; }
            }
            """},
        {"android/view/View", """
            package android.view;
            public final class View {
                public static final int SYSTEM_UI_FLAG_LIGHT_STATUS_BAR = 0x2000;
                public static final int SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR = 0x10;
                public static final int SYSTEM_UI_FLAG_LAYOUT_STABLE = 0x100;
                public int systemUiVisibility;
                public final java.util.List<Integer> writes = new java.util.ArrayList<>();
                public int getSystemUiVisibility() { return systemUiVisibility; }
                public void setSystemUiVisibility(int flags) {
                    systemUiVisibility = flags;
                    writes.add(flags);
                }
            }
            """},
        {"android/view/WindowInsetsController", """
            package android.view;
            public final class WindowInsetsController {
                public static final int APPEARANCE_LIGHT_STATUS_BARS = 8;
                public static final int APPEARANCE_LIGHT_NAVIGATION_BARS = 16;
                public int appearance;
                public final java.util.List<Integer> values = new java.util.ArrayList<>();
                public final java.util.List<Integer> masks = new java.util.ArrayList<>();
                public void setSystemBarsAppearance(int value, int mask) {
                    values.add(value);
                    masks.add(mask);
                    appearance = (appearance & ~mask) | (value & mask);
                }
            }
            """},
        {"android/view/Window", """
            package android.view;
            public final class Window {
                private final View decor;
                private final WindowInsetsController controller;
                public int statusBarColor, navigationBarColor, controllerLookups;
                public final java.util.List<Integer> statusWrites = new java.util.ArrayList<>();
                public final java.util.List<Integer> navigationWrites = new java.util.ArrayList<>();
                public Window(View decor, WindowInsetsController controller) {
                    this.decor = decor;
                    this.controller = controller;
                }
                public View getDecorView() { return decor; }
                public void setStatusBarColor(int color) { statusBarColor = color; statusWrites.add(color); }
                public void setNavigationBarColor(int color) { navigationBarColor = color; navigationWrites.add(color); }
                public WindowInsetsController getInsetsController() {
                    controllerLookups++;
                    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R) {
                        throw new AssertionError("API 29 must not invoke getInsetsController");
                    }
                    return controller;
                }
            }
            """}
    };

    private static final String CHECKS = """
            package com.ahoo.abs.android.nativekernel;
            import android.os.Build;
            import android.view.View;
            import android.view.Window;
            import android.view.WindowInsetsController;
            public final class SystemBarChecks {
                @ACTUAL@
                private static final int LIGHT_FLAGS = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                        | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                private static final int STABLE = View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
                private static final int LIGHT_APPEARANCE = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                private static int checks;
                private static void check(boolean pass, String message) {
                    checks++;
                    if (!pass) throw new AssertionError(message);
                }
                public static int run() {
                    checks = 0;
                    int[] initialLights = {0, View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR,
                            View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR, LIGHT_FLAGS};
                    int[] colors = {0xFFF5F5F5, 0xFFF5F5F5, 0xFF151515, 0xFF151515, 0xFFE9F0F6, 0xFFE9F0F6};
                    for (int sdk : new int[]{29, 30, 35, 36}) {
                        Build.VERSION.SDK_INT = sdk;
                        for (boolean dark : new boolean[]{false, true}) {
                            C_DARK = dark;
                            C_CANVAS = dark ? 0xFF151515 : 0xFFF5F5F5;
                            int canvas = C_CANVAS;
                            applySystemBarAppearance(null);
                            check(C_DARK == dark && C_CANVAS == canvas, "null window is harmless API " + sdk + " dark=" + dark);
                        }
                        for (boolean hasController : new boolean[]{false, true}) {
                            for (int seed = 0; seed < initialLights.length; seed++) {
                                View decor = new View();
                                decor.systemUiVisibility = 0xC0001606 | initialLights[seed] | ((seed & 1) == 0 ? 0 : STABLE);
                                WindowInsetsController controller = new WindowInsetsController();
                                controller.appearance = 0x40000080
                                        | ((seed & 1) == 0 ? 0 : WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS)
                                        | ((seed & 2) == 0 ? 0 : WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
                                Window window = new Window(decor, hasController ? controller : null);
                                int previousFlags = 0;
                                int previousAppearance = 0;
                                // Light, repeat light, dark, repeat dark, light, repeat light.
                                for (int call = 0; call < colors.length; call++) {
                                    if (call == 2) {
                                        // Another owner adds an unrelated flag and removes stable before dark.
                                        decor.systemUiVisibility = (decor.systemUiVisibility & ~STABLE) | 0x80;
                                        controller.appearance |= 0x20000000;
                                    } else if (call == 4) {
                                        // Removed unrelated flags must not accumulate from a cached earlier value.
                                        decor.systemUiVisibility = (decor.systemUiVisibility & ~(0x40000000 | STABLE)) | 0x01000000;
                                        controller.appearance = (controller.appearance & ~0x40000000) | 0x01000000;
                                    }
                                    int beforeFlags = decor.systemUiVisibility;
                                    int beforeAppearance = controller.appearance;
                                    boolean dark = call == 2 || call == 3;
                                    C_DARK = dark;
                                    C_CANVAS = colors[call];
                                    String label = "API " + sdk + " controller=" + hasController + " seed=" + seed + " call=" + call;
                                    applySystemBarAppearance(window);
                                    int count = call + 1;
                                    int expectedFlags = (beforeFlags & ~LIGHT_FLAGS) | STABLE | (dark ? 0 : LIGHT_FLAGS);
                                    check(decor.writes.size() == count, "one decor flag update per call " + label);
                                    check(decor.systemUiVisibility == expectedFlags && decor.writes.get(call) == expectedFlags,
                                            "exact light/dark flags without accumulation " + label);
                                    check((decor.writes.get(call) & STABLE) != 0, "stable requested on every call " + label);
                                    check((decor.systemUiVisibility & ~(LIGHT_FLAGS | STABLE))
                                            == (beforeFlags & ~(LIGHT_FLAGS | STABLE)), "preserve unrelated current flags " + label);
                                    check(window.statusBarColor == colors[call] && window.navigationBarColor == colors[call],
                                            "both bars use current canvas " + label);
                                    check(window.statusWrites.size() == count && window.navigationWrites.size() == count
                                            && window.statusWrites.get(call) == colors[call] && window.navigationWrites.get(call) == colors[call],
                                            "both colors requested on every call " + label);
                                    check(window.controllerLookups == (sdk >= 30 ? count : 0), "controller API gate including null controller " + label);
                                    boolean invokesController = sdk >= 30 && hasController;
                                    int requests = invokesController ? count : 0;
                                    check(controller.values.size() == requests && controller.masks.size() == requests,
                                            "no controller invocation below R or with null controller " + label);
                                    if (invokesController) {
                                        int value = dark ? 0 : LIGHT_APPEARANCE;
                                        check(controller.values.get(call) == value, "exact controller appearance request " + label);
                                        check(controller.masks.get(call) == LIGHT_APPEARANCE, "exact status and navigation appearance mask " + label);
                                        check(controller.appearance == ((beforeAppearance & ~LIGHT_APPEARANCE) | value),
                                                "controller preserves unrelated appearance without accumulation " + label);
                                    } else {
                                        check(controller.appearance == beforeAppearance, "unused controller untouched " + label);
                                    }
                                    if ((call & 1) != 0) {
                                        check(decor.systemUiVisibility == previousFlags && controller.appearance == previousAppearance,
                                                "repeated same-palette call is idempotent " + label);
                                    }
                                    previousFlags = decor.systemUiVisibility;
                                    previousAppearance = controller.appearance;
                                }
                            }
                        }
                    }
                    return checks;
                }
            }
            """;
}
