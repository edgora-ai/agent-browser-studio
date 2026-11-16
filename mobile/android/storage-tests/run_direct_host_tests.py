"""JDK17 regressions: actual core/data/codec with host API/JSON doubles + Python SQLite.

No Android platform JSON/SQLite/KeyStore, product build, network server, device or key use.
All SQL is executed on fresh explicitly admitted synthetic storage evidence; no cleanup.
Usage: ABS_STORAGE_TEST_ROOT=... python3 -B .../run_direct_host_tests.py /absolute/fresh/output
"""
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid

from storage_harness import ANDROID, DATA, no_symlinks, require_root


def main():
    root = require_root()
    if len(sys.argv) != 2:
        raise SystemExit("Pass a fresh absolute host output directory")
    output = Path(sys.argv[1])
    if not output.is_absolute() or output.exists() or ".." in output.parts:
        raise SystemExit("Fresh absolute host output required")
    no_symlinks(output.parent)
    output.mkdir(mode=0o700)
    case = root / ("verification_" + uuid.uuid4().hex)
    case.mkdir(mode=0o700)
    no_symlinks(case)
    if case.stat().st_uid != os.getuid() or stat.S_IMODE(case.stat().st_mode) != 0o700:
        raise SystemExit("Fresh fixture ownership rejected")
    original = ANDROID / "app/src/test/contract-cleanup/run_contracts.py"
    spec = importlib.util.spec_from_file_location("cleanup_host", original)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    doubles = {name: text for name, text in module.STUBS.items() if not name.startswith("com/ahoo/")}
    doubles["android/content/Context.java"] = """package android.content;
public class Context {
 public android.content.pm.ApplicationInfo getApplicationInfo() { return new android.content.pm.ApplicationInfo(); }
 public boolean isDeviceProtectedStorage() { return false; }
 public java.io.File getNoBackupFilesDir() { return new java.io.File(System.getProperty("host.fixtures")); }
 public android.content.res.AssetManager getAssets() { return new android.content.res.AssetManager(); }
}"""
    doubles["android/os/Process.java"] = """package android.os;
/** Test-only binding to this host JVM PID, not evidence about Android process lifecycle. */
public final class Process { public static int myPid() { return Math.toIntExact(ProcessHandle.current().pid()); } }
"""
    doubles["android/content/res/AssetManager.java"] = """package android.content.res;
public final class AssetManager {
 public java.io.InputStream open(String name) throws java.io.IOException {
  if (!name.equals("profile-schema.sql")) throw new AssertionError("Unexpected asset");
  return new java.io.FileInputStream(System.getProperty("host.schema"));
 }
}"""
    doubles["android/content/ContentValues.java"] = """package android.content;
public final class ContentValues {
 public final java.util.Map<String,Object> values = new java.util.LinkedHashMap<>();
 public void put(String key, String value) { values.put(key, value); }
 public void put(String key, Integer value) { values.put(key, value); }
 public void put(String key, Long value) { values.put(key, value); }
 public void put(String key, byte[] value) { values.put(key, value.clone()); }
 public void putNull(String key) { values.put(key, null); }
}"""
    host = Path(__file__).resolve().parent / "host-data"
    for name in ("SQLiteDatabase", "SQLiteOpenHelper"):
        doubles["android/database/sqlite/" + name + ".java"] = (host / (name + ".java")).read_text()
    for name in ("JSONObject", "JSONArray", "JSONException", "JsonHost"):
        doubles["org/json/" + name + ".java"] = (host / (name + ".java")).read_text()
    sources = []
    for name, text in doubles.items():
        target = output / "host-doubles" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text + "\n")
        sources.append(target)
    sources += list(DATA.glob("*.java"))
    sources += list((ANDROID / "core/src/main/java/com/ahoo/abs/core").glob("*.java"))
    sources += list((ANDROID / "core/src/test/java/com/ahoo/abs/core").glob("*.java"))
    sources += [host / "DirectStorageContractTest.java"]
    classes = output / "classes"
    classes.mkdir()
    jdk = Path(os.environ.get("JAVA17_BIN", "/opt/homebrew/opt/openjdk@17/bin"))
    subprocess.run([str(jdk / "javac"), "-d", str(classes), *map(str, sources)], check=True)
    java = [str(jdk / "java"), "-ea", "-cp", str(classes)]
    for contract in ("CoreContractTest", "MonitorContractTest"):
        subprocess.run([*java, "com.ahoo.abs.core." + contract], check=True)
    subprocess.run([*java, "-Dhost.fixtures=" + str(case),
                    "-Dhost.bridge=" + str(host / "sqlite_bridge.py"),
                    "-Dhost.schema=" + str(ANDROID / "app/src/main/assets/profile-schema.sql"),
                    "com.ahoo.abs.android.data.DirectStorageContractTest"], check=True)
    print("RETAINED HOST OUTPUT:", output)
    print("RETAINED SQLITE FIXTURES:", case)
    print("Boundary: production Java + host API/JSON doubles + Python SQLite; no Android/KeyStore/build/device proof")
    require_root()


if __name__ == "__main__":
    main()
