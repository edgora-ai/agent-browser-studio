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

/** Executes real freeze/verify method bodies and real core profile/config types on a fake
 * CommandLine/Context host. Not a Chromium, Android, DNS/egress or device acceptance test. */
public final class NativeNetworkLaunchHostTest {
    private NativeNetworkLaunchHostTest() { }

    private static Map<String, String> methods(JavaCompiler compiler, Path source) throws Exception {
        Map<String, String> result = new HashMap<>();
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, null,
                    List.of("-proc:none", "--release", "17"), null, files.getJavaFileObjects(source));
            for (CompilationUnitTree unit : task.parse()) {
                for (Tree top : unit.getTypeDecls()) {
                    if (!(top instanceof ClassTree type)) continue;
                    for (Tree member : type.getMembers()) {
                        if (member instanceof MethodTree method) {
                            result.put(method.getName().toString(), method.toString());
                        }
                    }
                }
            }
        }
        return result;
    }

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]).toAbsolutePath();
        Path output = Path.of(args[1]).toAbsolutePath().resolve("network-launch-host");
        Path source = root.resolve("mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel/NativeBrowserApplication.java");
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new AssertionError("A full JDK 17 is required");
        Map<String, String> members = methods(compiler, source);
        StringBuilder selected = new StringBuilder();
        for (String name : List.of("freezeCommandLine", "verifyFrozenCommandLineFor", "frozenNetworkMatches",
                "fingerprintConfigPayload")) {
            String actual = members.get(name);
            if (actual == null) throw new AssertionError("Missing actual method " + name);
            selected.append(actual).append('\n');
        }
        Files.createDirectories(output);
        Path owner = output.resolve("NetworkLaunchProbe.java");
        Files.writeString(owner, HOST.replace("@ACTUAL_METHODS@", selected), StandardCharsets.UTF_8);
        List<Path> paths = new ArrayList<>();
        paths.add(owner);
        Path process = output.resolve("android/os/Process.java");
        Files.createDirectories(process.getParent());
        Files.writeString(process, "package android.os; public final class Process { public static int myPid() { return 123; } }");
        paths.add(process);
        try (var sources = Files.list(root.resolve("mobile/android/core/src/main/java/com/ahoo/abs/core"))) {
            sources.filter(path -> path.toString().endsWith(".java")).sorted().forEach(paths::add);
        }
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            boolean compiled = compiler.getTask(null, files, null,
                    List.of("--release", "17", "-Xlint:all", "-Werror", "-d", output.toString()), null,
                    files.getJavaFileObjectsFromPaths(paths)).call();
            if (!compiled) throw new AssertionError("Actual network freeze/verify members did not compile on host");
        }
        try (URLClassLoader loader = new URLClassLoader(new URL[]{output.toUri().toURL()}, NativeNetworkLaunchHostTest.class.getClassLoader())) {
            Object count = loader.loadClass("NetworkLaunchProbe").getMethod("run").invoke(null);
            System.out.println(count + " actual Java network freeze/verify fake-host checks passed (not native/device network acceptance)");
        }
    }

    private static final String HOST = """
        import com.ahoo.abs.core.*;
        import java.util.*;
        public final class NetworkLaunchProbe {
            private static final String ID = "11111111-1111-4111-8111-111111111111";
            private static final String REV = "22222222-2222-4222-8222-222222222222";
            private static final String SESSION = "33333333-3333-4333-8333-333333333333";
            private static final String NONCE = "44444444-4444-4444-8444-444444444444";
            private static final String INCARNATION = "55555555-5555-4555-8555-555555555555";
            private static final long SEED = 1234567890123456789L;
            private static final Context CONTEXT = new Context();
            private static int checks;
            private LaunchSpec launch;
            private NativeTimezoneLaunchConfig frozen;
            private static final class Context { }
            private static final class Log { static void i(String tag, String message) { } }
            private static final class CommandLine {
                private static CommandLine current;
                private final Map<String, String> switches = new LinkedHashMap<>();
                static boolean isInitialized() { return current != null; }
                static CommandLine getInstance() { return current; }
                static void init(String[] argv) {
                    current = new CommandLine();
                    require("agent-browser-product".equals(argv[0]), "program comes from frozen timezone config");
                    for (int i = 1; i < argv.length; ++i) {
                        require(argv[i].startsWith("--"), "only switches follow the program");
                        String[] parts = argv[i].substring(2).split("=", 2);
                        require(!current.switches.containsKey(parts[0]), "freeze never emits duplicate switch " + parts[0]);
                        current.switches.put(parts[0], parts.length == 1 ? "" : parts[1]);
                    }
                }
                boolean hasSwitch(String name) { return switches.containsKey(name); }
                String getSwitchValue(String name) { return switches.get(name); }
            }
            private static long loadOrCreateFingerprintSeed(String suffix, Context context) { return SEED; }
            private static long readPersistedFingerprintSeed(String suffix, Context context) { return SEED; }
            private static String fingerprintSeedDigest(long seed) { return "synthetic-host-digest"; }
            @ACTUAL_METHODS@

            private static void require(boolean value, String label) {
                ++checks;
                if (!value) throw new AssertionError(label);
            }
            private static void rejected(Runnable action, String expected, String label) {
                try { action.run(); }
                catch (IllegalStateException failure) {
                    require(expected.equals(failure.getMessage()), label + ": " + failure.getMessage());
                    return;
                }
                throw new AssertionError("Accepted " + label);
            }
            private static NetworkLaunchProbe create(ProxySpec proxy) {
                ProfileSpec profile = new ProfileSpec(ID, REV, "Network host fixture", proxy, "US", "America/New_York",
                        List.of("en-US", "zh-CN"), ProfileSpec.DeviceMode.NATIVE, "Synthetic Host", "");
                NetworkLaunchProbe probe = new NetworkLaunchProbe();
                probe.launch = new LaunchSpec(profile, SESSION, NONCE, 1000L, 61000L);
                probe.frozen = NativeTimezoneLaunchConfig.fromLaunch(probe.launch, INCARNATION, 1000L);
                return probe;
            }
            private static Map<String, String> snapshot() { return new LinkedHashMap<>(CommandLine.current.switches); }
            private static void restore(Map<String, String> switches) {
                CommandLine.current = new CommandLine();
                CommandLine.current.switches.putAll(switches);
            }
            private static void changed(NetworkLaunchProbe probe, String name, String value) {
                Map<String, String> original = snapshot();
                if (value == null) CommandLine.current.switches.remove(name);
                else CommandLine.current.switches.put(name, value);
                rejected(() -> probe.verifyFrozenCommandLineFor(CONTEXT), "NATIVE_FROZEN_CONFIG_CHANGED", name + "=" + value);
                restore(original);
                probe.verifyFrozenCommandLineFor(CONTEXT);
            }
            private static void sharedRestrictions(NetworkLaunchProbe probe) {
                for (String name : List.of("agent-browser-product-profile", NativeTimezoneLaunchConfig.REQUIRED_SWITCH,
                        NativeTimezoneLaunchConfig.CONFIG_SWITCH, "agent-browser-noise-seeds", "disable-quic",
                        "use-mobile-user-agent", "disable-features", "force-webrtc-ip-handling-policy", "lang", "accept-lang")) {
                    changed(probe, name, null);
                }
                for (String name : List.of(NativeTimezoneLaunchConfig.CONFIG_SWITCH, "agent-browser-noise-seeds",
                        "disable-features", "force-webrtc-ip-handling-policy", "lang", "accept-lang")) {
                    changed(probe, name, "wrong");
                }
                changed(probe, "agent-browser-product-preflight", "");
                for (String name : List.of("roxy-fingerprint-config", "js-flags", "user-data-dir", "content-shell-user-data-dir",
                        "no-sandbox", "disable-web-security", "ignore-certificate-errors", "run-web-tests", "remote-debugging-port",
                        "remote-debugging-pipe", "remote-debugging-socket-name")) {
                    CommandLine.current.switches.put(name, "");
                    rejected(() -> probe.verifyFrozenCommandLineFor(CONTEXT), "NATIVE_UNSAFE_COMMAND_LINE", name);
                    CommandLine.current.switches.remove(name);
                }
                Map<String, String> unchanged = snapshot();
                rejected(() -> probe.freezeCommandLine(CONTEXT), "NATIVE_COMMAND_LINE_ALREADY_INITIALIZED", "second freeze");
                require(unchanged.equals(snapshot()), "second freeze never mutates initialized command line");
            }
            public static int run() {
                require(Runtime.version().feature() == 17, "host baseline JDK17");
                CommandLine.current = null;
                NetworkLaunchProbe direct = create(null);
                require(direct.launch.profile.isDirect(), "explicit direct profile has null endpoint");
                direct.freezeCommandLine(CONTEXT);
                direct.verifyFrozenCommandLineFor(CONTEXT);
                require("direct".equals(CommandLine.current.getSwitchValue("agent-browser-product-network-mode")), "exact direct switch");
                require(CommandLine.current.switches.size() == 11, "direct emits only product, timezone and shared restrictions");
                for (String name : CommandLine.current.switches.keySet()) {
                    require(!name.contains("proxy") && !name.equals("host-resolver-rules") && !name.equals("host-rules"),
                            "direct does not inherit proxy or DNS controls: " + name);
                }
                Map<String, String> directSwitches = snapshot();
                changed(direct, "agent-browser-product-network-mode", null);
                for (String value : List.of("", "proxy", "DIRECT", " direct", "direct ", "system", "auto", "unknown")) {
                    changed(direct, "agent-browser-product-network-mode", value);
                }
                for (String name : List.of("proxy-server", "proxy-bypass-list", "no-proxy-server", "proxy-pac-url", "proxy-auto-detect",
                        "use-system-proxy-resolver", "winhttp-proxy-resolver", "proxy-resolver-v8-tracing", "host-resolver-rules",
                        "host-rules", "agent-browser-local-dns-policy", "agent-browser-proxy-bootstrap-host")) {
                    for (String value : List.of("", "stale")) changed(direct, name, value);
                }
                sharedRestrictions(direct);
                for (ProxySpec.Scheme scheme : ProxySpec.Scheme.values()) {
                    for (String host : List.of("proxy.example", "192.0.2.5", "[2001:db8::1]")) {
                        CommandLine.current = null;
                        NetworkLaunchProbe proxy = create(new ProxySpec(scheme, host, 8080, false));
                        proxy.freezeCommandLine(CONTEXT);
                        proxy.verifyFrozenCommandLineFor(CONTEXT);
                        require(!CommandLine.current.hasSwitch("agent-browser-product-network-mode"), "legacy proxy never emits mode switch");
                        require(proxy.launch.profile.proxy.proxyRule().equals(CommandLine.current.getSwitchValue("proxy-server")), "exact sole proxy");
                        require("<-loopback>".equals(CommandLine.current.getSwitchValue("proxy-bypass-list")), "no bypass fallback");
                        require(proxy.launch.profile.proxy.hostResolverRules().equals(CommandLine.current.getSwitchValue("host-resolver-rules")),
                                "proxy retains exact deny resolver command line");
                        changed(proxy, "proxy-server", null);
                        changed(proxy, "proxy-server", "DIRECT");
                        changed(proxy, "proxy-bypass-list", null);
                        changed(proxy, "proxy-bypass-list", "*");
                        changed(proxy, "host-resolver-rules", null);
                        changed(proxy, "host-resolver-rules", "MAP * 192.0.2.42");
                        for (String value : List.of("", "proxy", "direct", "unknown")) changed(proxy, "agent-browser-product-network-mode", value);
                        sharedRestrictions(proxy);
                        Map<String, String> proxySwitches = snapshot();
                        restore(directSwitches);
                        rejected(() -> proxy.verifyFrozenCommandLineFor(CONTEXT), "NATIVE_FROZEN_CONFIG_CHANGED", "proxy cannot reuse direct argv");
                        restore(proxySwitches);
                        rejected(() -> direct.verifyFrozenCommandLineFor(CONTEXT), "NATIVE_FROZEN_CONFIG_CHANGED", "direct cannot reuse proxy argv");
                    }
                }
                CommandLine.current = null;
                rejected(() -> direct.verifyFrozenCommandLineFor(CONTEXT), "NATIVE_FROZEN_CONFIG_MISSING", "uninitialized command line");
                restore(directSwitches);
                direct.frozen = null;
                rejected(() -> direct.verifyFrozenCommandLineFor(CONTEXT), "NATIVE_FROZEN_CONFIG_MISSING", "missing frozen config");
                return checks;
            }
        }
        """;
}
