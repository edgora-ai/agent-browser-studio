"""Compile/execute the real LaunchCoordinator on JDK17 with narrow host doubles.

No Android SDK, Gradle, IPC, SQL, locks, processes, ActivityTaskManager or device is used.
A successful fake Context.startActivity is dispatch evidence only, never UI/boot proof.
All generated sources/classes are retained below a required fresh absolute output path.
"""
from pathlib import Path
import subprocess
import sys

ANDROID = Path(__file__).resolve().parents[4]
JDK = Path("/opt/homebrew/opt/openjdk@17/bin")

STUBS = {
    "android/content/Context.java": """package android.content;
public class Context {
 public static final int BIND_AUTO_CREATE = 1;
 public Context getApplicationContext() { return this; }
 public String getPackageName() { return "test.abs"; }
 public boolean bindService(Intent i, ServiceConnection c, int f) { throw new AssertionError("override bind"); }
 public void unbindService(ServiceConnection c) { }
 public void startActivity(Intent i) { throw new AssertionError("override start"); }
}""",
    "android/content/ComponentName.java": """package android.content;
public final class ComponentName {
 private final String pkg, name;
 public ComponentName(Context c, Class<?> cls) { this(c.getPackageName(), cls.getName()); }
 public ComponentName(String pkg, String name) { this.pkg = pkg; this.name = name; }
 public String getPackageName() { return pkg; }
 public String getClassName() { return name; }
}""",
    "android/content/ServiceConnection.java": """package android.content;
public interface ServiceConnection {
 void onServiceConnected(ComponentName n, android.os.IBinder b);
 void onServiceDisconnected(ComponentName n);
}""",
    "android/content/Intent.java": """package android.content;
public class Intent {
 public static final int FLAG_ACTIVITY_NEW_TASK=0x10000000, FLAG_ACTIVITY_CLEAR_TOP=0x04000000,
  FLAG_ACTIVITY_SINGLE_TOP=0x20000000, FLAG_ACTIVITY_REORDER_TO_FRONT=0x00020000;
 private int flags;
 private ComponentName component;
 private Object data, clip;
 private Intent selector;
 private android.os.Bundle extras;
 public Intent() { }
 public Intent(Context c, Class<?> cls) { component = new ComponentName(c, cls); }
 public int getFlags() { return flags; }
 public Intent setFlags(int f) { flags=f; return this; }
 public Intent addFlags(int f) { flags |= f; return this; }
 public ComponentName getComponent() { return component; }
 public Intent setComponent(ComponentName c) { component=c; return this; }
 public Object getData() { return data; }
 public Intent setData(Object d) { data=d; return this; }
 public Intent getSelector() { return selector; }
 public void setSelector(Intent s) { selector=s; }
 public Object getClipData() { return clip; }
 public void setClipData(Object c) { clip=c; }
 public android.os.Bundle getExtras() { return extras; }
 public Intent putExtra(String k, String v) { if (extras==null) extras=new android.os.Bundle(); extras.putString(k,v); return this; }
}""",
    "android/os/Bundle.java": """package android.os;
public class Bundle {
 private final java.util.Map<String,Object> values = new java.util.HashMap<>();
 public void putString(String k, String v) { values.put(k,v); }
 public void putInt(String k, int v) { values.put(k,v); }
 public void putBoolean(String k, boolean v) { values.put(k,v); }
 public String getString(String k) { return (String)values.get(k); }
 public String getString(String k, String d) { String v=getString(k); return v==null?d:v; }
 public int getInt(String k, int d) { Object v=values.get(k); return v==null?d:(Integer)v; }
 public boolean getBoolean(String k, boolean d) { Object v=values.get(k); return v==null?d:(Boolean)v; }
 public int size() { return values.size(); }
}""",
    "android/os/Looper.java": """package android.os;
public final class Looper {
 private static final Looper MAIN = new Looper();
 public static boolean onMain = true;
 public static Looper getMainLooper() { return MAIN; }
 public static Looper myLooper() { return onMain ? MAIN : null; }
}""",
    "android/os/Handler.java": """package android.os;
public final class Handler {
 public interface Callback { boolean handleMessage(Message m); }
 private final Callback callback;
 public final java.util.List<Runnable> queued = new java.util.ArrayList<>();
 public Handler(Looper l) { callback=null; }
 public Handler(Looper l, Callback c) { callback=c; }
 public boolean post(Runnable r) { queued.add(r); return true; }
 public boolean postDelayed(Runnable r, long delay) { queued.add(r); return true; }
 public void dispatchMessage(Message m) { if (callback==null) throw new AssertionError("No callback"); callback.handleMessage(m); }
}""",
    "android/os/IBinder.java": """package android.os;
public interface IBinder {
 interface DeathRecipient { void binderDied(); }
 void linkToDeath(DeathRecipient d, int flags) throws RemoteException;
 void send(Message m) throws RemoteException;
}""",
    "android/os/Message.java": """package android.os;
public final class Message {
 public int what, sendingUid;
 public Messenger replyTo;
 private Bundle data = new Bundle();
 public static Message obtain(Handler h, int what) { Message m=new Message(); m.what=what; return m; }
 public Bundle getData() { return data; }
 public void setData(Bundle b) { data=b; }
}""",
    "android/os/Messenger.java": """package android.os;
public final class Messenger {
 private final Handler handler;
 private final IBinder binder;
 public Messenger(Handler h) { handler=h; binder=null; }
 public Messenger(IBinder b) { binder=b; handler=null; }
 public void send(Message m) throws RemoteException { if (handler!=null) handler.dispatchMessage(m); else binder.send(m); }
}""",
    "android/os/RemoteException.java": """package android.os;
public class RemoteException extends Exception { }""",
    "android/os/Process.java": """package android.os;
public final class Process { public static int myUid() { return 12000; } }""",
    "android/os/SystemClock.java": """package android.os;
public final class SystemClock { public static long elapsedRealtime() { return System.nanoTime()/1000000; } }""",
    "android/system/ErrnoException.java": """package android.system;
public class ErrnoException extends Exception { public final int errno; public ErrnoException(int e) { errno=e; } }""",
    "android/system/OsConstants.java": """package android.system;
public final class OsConstants { public static final int ESRCH=3; }""",
    "android/system/Os.java": """package android.system;
public final class Os {
 public static boolean alive=true;
 public static int checks;
 public static void kill(int pid, int signal) throws ErrnoException {
  if (signal!=0 || pid<=0) throw new AssertionError("Never signal a process in host test");
  checks++; if (!alive) throw new ErrnoException(OsConstants.ESRCH);
 }
}""",
    "com/ahoo/abs/android/browser/BrowserControlService.java": """package com.ahoo.abs.android.browser;
public final class BrowserControlService { }""",
    "com/ahoo/abs/android/process/ProcessLifecycle.java": """package com.ahoo.abs.android.process;
public final class ProcessLifecycle {
 public static boolean lockFree=true, publicationHeld, failPublication;
 public static Hold holdPublication(android.content.Context c) throws java.io.IOException {
  if (failPublication) throw new java.io.IOException("synthetic publication failure");
  if (publicationHeld) throw new AssertionError("Unexpected nested hold");
  publicationHeld=true; return new Hold();
 }
 public static boolean isBrowserLockFree(android.content.Context c) throws java.io.IOException { return lockFree; }
 public static final class Hold implements AutoCloseable { public void close() { publicationHeld=false; } }
}""",
    "com/ahoo/abs/android/data/BootstrapStore.java": """package com.ahoo.abs.android.data;
import com.ahoo.abs.core.LaunchSpec;
public final class BootstrapStore {
 public enum State { PUBLISHED, CLAIMED, REVOKED, EXIT_UNCONFIRMED, EXIT_CONFIRMED }
 public enum RuntimePhase { PUBLISHED, CLAIMED, EXIT_UNCONFIRMED, EXIT_CONFIRMED }
 public static final class ActiveLaunch {
  public final LaunchSpec launch;
  public final State state;
  public final String incarnationId;
  public final int pid;
  public final RuntimePhase phase;
  public ActiveLaunch(LaunchSpec l, State s, String inc, int pid) {
   launch=l; state=s; incarnationId=inc; this.pid=pid; phase=RuntimePhase.valueOf(s==State.REVOKED?"PUBLISHED":s.name());
  }
 }
 public static ActiveLaunch active;
 public static LaunchSpec nextLaunch;
 public static int publications;
 public static boolean failPublish;
 public BootstrapStore(android.content.Context c) { }
 public ActiveLaunch readActive() { return active; }
 public ActiveLaunch findLaunch(String s) { return active!=null && active.launch.sessionId.equals(s)?active:null; }
 public LaunchSpec publish(String id, String revision, long ttl) {
  if (!com.ahoo.abs.android.process.ProcessLifecycle.publicationHeld
      || !com.ahoo.abs.android.process.ProcessLifecycle.lockFree || active!=null) throw new AssertionError("publish bypassed gate");
  if (failPublish) throw new StorageException(StorageException.Code.LAUNCH_ACTIVE);
  if (!nextLaunch.profile.id.equals(id) || !nextLaunch.profile.revision.equals(revision) || ttl!=120000) throw new AssertionError("publish arguments changed");
  publications++; active=new ActiveLaunch(nextLaunch,State.PUBLISHED,null,0); return nextLaunch;
 }
 public ActiveLaunch requestStop(String s) { if (findLaunch(s)==null) throw new AssertionError("Unknown stop"); return active; }
 public void revoke(String s) { active=new ActiveLaunch(active.launch,State.REVOKED,active.incarnationId,active.pid); }
 public void markExitUnconfirmed(String s, String inc) { active=new ActiveLaunch(active.launch,State.EXIT_UNCONFIRMED,active.incarnationId,active.pid); }
 public void recordConfirmedExit(String s, String inc) { if (findLaunch(s)==null) throw new AssertionError("Unknown exit"); active=null; }
}""",
}


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: run_launch_contracts.py /absolute/fresh/output")
    output = Path(sys.argv[1])
    if not output.is_absolute() or ".." in output.parts or output.exists():
        raise SystemExit("output must be a fresh absolute non-traversing path; prior evidence is never removed")
    if any(ancestor.is_symlink() for ancestor in (output, *output.parents)):
        raise SystemExit("No symlink output paths")
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    sources = []
    for name, source in STUBS.items():
        dest = output / "host-doubles" / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(source)
        sources.append(dest)
    core = ANDROID / "core/src/main/java/com/ahoo/abs/core"
    for name in ("ValidationException", "CoreValidation", "CanonicalHash", "HostSyntax", "ProxySpec", "ProfileSpec", "LaunchSpec", "LaunchReplayGuard", "RuntimeStateMachine", "LifecycleControlPolicy", "AdmissionGate"):
        sources.append(core / (name + ".java"))
    app = ANDROID / "app/src/main/java/com/ahoo/abs/android"
    for name in ("process/LaunchCoordinator.java", "process/BrowserProcessOwner.java", "process/BrowserProcessRuntime.java", "browser/ControlProtocol.java", "data/StorageException.java"):
        sources.append(app / name)
    sources.append(Path(__file__).with_name("FreshSessionLaunchContractTest.java"))
    classes = output / "classes"
    classes.mkdir()
    subprocess.run([str(JDK / "javac"), "--release", "17", "-d", str(classes), *map(str, sources)], check=True)
    subprocess.run([str(JDK / "java"), "-ea", "-cp", str(classes), "com.ahoo.abs.android.process.FreshSessionLaunchContractTest"], check=True)
    print("Boundary: real coordinator/core; host doubles only. Android task lifecycle, focus, tabs, SQLite, Chromium build and device NOT verified.")


if __name__ == "__main__":
    main()
