package com.ahoo.abs.android.process;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.Process;
import android.os.RemoteException;
import android.os.SystemClock;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import com.ahoo.abs.android.browser.BrowserActivity;
import com.ahoo.abs.android.browser.BrowserControlService;
import com.ahoo.abs.android.browser.ControlProtocol;
import com.ahoo.abs.android.data.BootstrapStore;
import com.ahoo.abs.core.LaunchReplayGuard;
import com.ahoo.abs.core.LaunchSpec;
import com.ahoo.abs.core.LifecycleControlPolicy;
import com.ahoo.abs.core.ProfileSpec;
import com.ahoo.abs.core.RuntimeStateMachine;
import java.io.IOException;

/** Main-process controller: a drain reply never serves as process-exit evidence. */
public final class LaunchCoordinator {
    private static LaunchCoordinator instance;
    private final Context context;
    private final BootstrapStore store;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final LaunchReplayGuard replay = new LaunchReplayGuard(128);
    private Connection connection;
    private LaunchSpec current;
    private RuntimeStateMachine machine;
    private Messenger remote;
    private IBinder remoteBinder;
    private String incarnation;
    private int pid;
    private int rejectedPid;
    private String rejectedSession;
    private boolean bound;
    private boolean deathObserved;
    private boolean validatedControl;
    private boolean stopping;
    private long exitWaitGeneration;
    private Runnable observer;
    private String status = "无活动验证环境；手机与 Ping0 尚未验收。";

    private LaunchCoordinator(Context context) {
        this.context = context.getApplicationContext();
        store = new BootstrapStore(this.context);
    }

    public static synchronized LaunchCoordinator get(Context context) {
        if (instance == null) instance = new LaunchCoordinator(context);
        return instance;
    }

    public void observe(Runnable observer) { this.observer = observer; }
    public void clearObserver(Runnable expected) { if (observer == expected) observer = null; }
    public String status() { return status; }

    public void open(ProfileSpec profile) {
        requireMain();
        try (ProcessLifecycle.Hold ignored = ProcessLifecycle.holdPublication(context)) {
            reconcile();
            BootstrapStore.ActiveLaunch active = store.readActive();
            if (active != null) {
                if (!stopping && active.state == BootstrapStore.State.CLAIMED
                        && active.launch.profile.id.equals(profile.id)
                        && active.launch.profile.revision.equals(profile.revision)
                        && active.pid > 0 && !ProcessLifecycle.isBrowserLockFree(context)) {
                    current = active.launch;
                    incarnation = active.incarnationId;
                    pid = active.pid;
                    if (bindControl()) update("正在核对已有浏览进程，不修改运行中配置。");
                    return;
                }
                throw new IllegalStateException("BROWSER_EXIT_UNCONFIRMED");
            }
            if (!ProcessLifecycle.isBrowserLockFree(context)) throw new IllegalStateException("BROWSER_PROCESS_BUSY");
            current = store.publish(profile.id, profile.revision, 120000);
            machine = new RuntimeStateMachine(current, replay, System.currentTimeMillis());
            incarnation = null;
            pid = 0;
            rejectedPid = 0;
            rejectedSession = null;
            validatedControl = false;
            deathObserved = false;
            stopping = false;
            if (bindControl()) update("启动票据已发布；等待同一 UID 浏览进程的一次性 claim。");
        } catch (IOException | RuntimeException failure) {
            update("未启动或退出未确认：" + safeCode(failure));
        }
    }

    public void stop() {
        requireMain();
        stopping = true;
        try {
            BootstrapStore.ActiveLaunch active = store.readActive();
            if (active == null) {
                update(ProcessLifecycle.isBrowserLockFree(context) ? "没有活动环境。" : "浏览进程状态未知，未解除启动门禁。");
                return;
            }
            active = store.requestStop(active.launch.sessionId);
            if (confirmAbsent(active)) return;
            if (active.pid == 0) {
                if (active.state == BootstrapStore.State.PUBLISHED) store.revoke(active.launch.sessionId);
                store.markExitUnconfirmed(active.launch.sessionId, null);
                current = active.launch;
                incarnation = null;
                stopping = true;
                rejectedPid = 0;
                if (bindControl()) update("未消费授权已撤销；正在核实拒绝启动的自有进程退出，尚未解除门禁。");
                return;
            }
            current = active.launch;
            incarnation = active.incarnationId;
            pid = active.pid;
            if (remote == null || !bound) {
                stopping = true;
                if (bindControl()) update("正在核对原浏览进程；不向数据库 PID 发送退出信号。");
                return;
            }
            beginDrain();
        } catch (IOException | RuntimeException failure) {
            update("退出未确认：" + safeCode(failure));
        }
    }

    public void reconcile() {
        requireMain();
        try {
            BootstrapStore.ActiveLaunch active = store.readActive();
            if (active != null && !confirmAbsent(active)) {
                update("环境处于 " + active.state.name() + " / " + active.phase.name()
                        + "；停止回执不等于实际退出。");
            }
        } catch (IOException | RuntimeException failure) {
            update("运行状态未知：" + safeCode(failure));
        }
    }

    private boolean confirmAbsent(BootstrapStore.ActiveLaunch active) throws IOException {
        int observedPid = active.pid > 0 ? active.pid
                : active.launch.sessionId.equals(rejectedSession) ? rejectedPid : 0;
        if (observedPid <= 0 || !ProcessLifecycle.isBrowserLockFree(context)) return false;
        try {
            Os.kill(observedPid, 0);
            return false;
        } catch (ErrnoException observed) {
            if (observed.errno != OsConstants.ESRCH) return false;
        }
        store.markExitUnconfirmed(active.launch.sessionId, active.incarnationId);
        store.recordConfirmedExit(active.launch.sessionId, active.incarnationId);
        if (active.pid > 0 && machine != null && machine.recordedPid() == active.pid
                && machine.sessionId.equals(active.launch.sessionId)
                && machine.state() != RuntimeStateMachine.State.EXIT_CONFIRMED) {
            machine.observePidCheck(active.launch.sessionId, active.pid, RuntimeStateMachine.ESRCH, true);
        }
        exitWaitGeneration++;
        unbindControl();
        remote = null;
        current = null;
        rejectedPid = 0;
        rejectedSession = null;
        stopping = false;
        update("原验证宿主已退出（确切 PID 为 ESRCH 且生命周期锁可获取）。网页存储持久性仍未验收。");
        return true;
    }

    private boolean bindControl() {
        if (bound) {
            if (remote != null) {
                // An explicit open may reactivate once; unsolicited duplicate HELLOs may not.
                connection.activateOnHello = !stopping;
                return send(ControlProtocol.HELLO);
            }
            return true;
        }
        Intent intent = new Intent(context, BrowserControlService.class);
        connection = new Connection(current.sessionId, current.nonce);
        remoteBinder = null;
        validatedControl = false;
        bound = context.bindService(intent, connection, Context.BIND_AUTO_CREATE);
        if (!bound) throw new IllegalStateException("CONTROL_BIND_FAILED");
        return true;
    }

    private RuntimeStateMachine currentMachine() {
        return current != null && machine != null && machine.sessionId.equals(current.sessionId) ? machine : null;
    }

    private void beginDrain() {
        stopping = true;
        if (validatedControl) store.markExitUnconfirmed(current.sessionId, incarnation);
        LifecycleControlPolicy.DrainAction action = LifecycleControlPolicy.requestDrain(
                currentMachine(), current.sessionId, validatedControl);
        if (action == LifecycleControlPolicy.DrainAction.WAIT_FOR_HELLO) {
            if (send(ControlProtocol.HELLO)) update("正在核对原浏览进程；握手通过前不发送退出控制。");
        } else if (action == LifecycleControlPolicy.DrainAction.SEND_DRAIN) {
            if (send(ControlProtocol.DRAIN)) update("已请求退出；等待 Cookie 提交尝试，再单独确认宿主死亡。");
        } else {
            waitForExit(SystemClock.elapsedRealtime() + 5000);
        }
    }

    private boolean receive(Connection owner, IBinder binder, long generation, Message message) {
        if (message.sendingUid != Process.myUid() || current == null || !bound || remote == null
                || connection != owner || remoteBinder != binder || owner.generation != generation
                || !owner.ownerSession.equals(current.sessionId) || !owner.ownerNonce.equals(current.nonce)) return true;
        Bundle data = message.getData();
        if (message.what == ControlProtocol.ERROR) {
            String code = data.getString(ControlProtocol.CODE, "CONTROL_ERROR");
            if ("BOOTSTRAP_REJECTED".equals(code) && remote != null
                    && current.sessionId.equals(data.getString(ControlProtocol.SESSION))
                    && current.nonce.equals(data.getString(ControlProtocol.NONCE))) {
                String rejectedIncarnation = data.getString(ControlProtocol.INCARNATION);
                try {
                    if (rejectedIncarnation == null || !java.util.UUID.fromString(rejectedIncarnation).toString().equals(rejectedIncarnation)) {
                        throw new IllegalStateException("INVALID_REJECTED_INCARNATION");
                    }
                    rejectedPid = data.getInt(ControlProtocol.PID, 0);
                    if (rejectedPid <= 0) throw new IllegalStateException("INVALID_REJECTED_PID");
                    rejectedSession = current.sessionId;
                    Message exit = Message.obtain(null, ControlProtocol.EXIT_REJECTED);
                    Bundle own = new Bundle();
                    own.putString(ControlProtocol.INCARNATION, rejectedIncarnation);
                    exit.setData(own);
                    Messenger endpoint = remote;
                    unbindControl();
                    try {
                        endpoint.send(exit);
                    } catch (RemoteException disconnected) {
                        update("拒绝进程的退出请求回执不明；仍核对实际进程和锁。");
                    }
                    waitForExit(SystemClock.elapsedRealtime() + 5000);
                } catch (RuntimeException failure) {
                    update("失败的浏览进程退出仍未确认：" + safeCode(failure));
                }
            } else {
                update("控制操作被拒绝；未解除门禁。");
            }
            return true;
        }
        if (!current.sessionId.equals(data.getString(ControlProtocol.SESSION))) return true;
        if (message.what != ControlProtocol.HELLO_REPLY && message.what != ControlProtocol.DRAIN_REPLY) return true;
        if (message.what == ControlProtocol.DRAIN_REPLY && !validatedControl) return true;
        try {
            BootstrapStore.ActiveLaunch active = store.findLaunch(current.sessionId);
            if (active == null || active.pid <= 0 || active.pid != data.getInt(ControlProtocol.PID, 0)
                    || active.incarnationId == null
                    || !active.incarnationId.equals(data.getString(ControlProtocol.INCARNATION))) {
                throw new IllegalStateException("CONTROL_INCARNATION_MISMATCH");
            }
            incarnation = active.incarnationId;
            pid = active.pid;
            if (message.what == ControlProtocol.HELLO_REPLY) {
                validatedControl = true;
                owner.validated = true;
                RuntimeStateMachine activeMachine = currentMachine();
                if (activeMachine != null && activeMachine.state() == RuntimeStateMachine.State.STARTING) {
                    activeMachine.recordPid(current.sessionId, pid);
                    activeMachine.bootstrapped(current.sessionId);
                    activeMachine.beginProbing(current.sessionId);
                }
                if (data.getBoolean("drained", false)) {
                    stopping = true;
                    LifecycleControlPolicy.drainReported(activeMachine, current.sessionId);
                    finishExit(data.getString(ControlProtocol.COOKIE, "UNKNOWN"));
                } else if (stopping || active.state == BootstrapStore.State.EXIT_UNCONFIRMED) {
                    beginDrain();
                } else if (owner.activateOnHello) {
                    owner.activateOnHello = false;
                    Intent browser = new Intent(context, BrowserActivity.class);
                    browser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    browser.putExtra(ControlProtocol.SESSION, current.sessionId);
                    browser.putExtra(ControlProtocol.NONCE, current.nonce);
                    context.startActivity(browser);
                    update("已核对专用浏览进程；仅进入能力验证模式。");
                }
            } else if (message.what == ControlProtocol.DRAIN_REPLY) {
                if (!stopping) throw new IllegalStateException("UNREQUESTED_DRAIN_REPLY");
                String cookie = data.getString(ControlProtocol.COOKIE, "UNKNOWN");
                LifecycleControlPolicy.drainReported(currentMachine(), current.sessionId);
                finishExit(cookie);
            }
        } catch (RemoteException | RuntimeException failure) {
            update("控制或退出结果未知：" + safeCode(failure));
        }
        return true;
    }

    private void finishExit(String cookie) throws RemoteException {
        if (remote == null || current == null) throw new IllegalStateException("EXIT_CONTROL_MISSING");
        store.markExitUnconfirmed(current.sessionId, incarnation);
        Message exit = command(ControlProtocol.EXIT_SELF);
        Messenger endpoint = remote;
        unbindControl();
        boolean sent = true;
        try {
            endpoint.send(exit);
        } catch (RemoteException disconnected) {
            sent = false;
        }
        String safeCookie = java.util.Arrays.asList("RETURNED", "FAILED", "TIMED_OUT", "NOT_ATTEMPTED").contains(cookie) ? cookie : "UNKNOWN";
        update((sent ? "" : "退出请求回执不明；") + "Cookie flush=" + safeCookie
                + "；等待真实进程退出，LS/IDB 完整性未证明。");
        waitForExit(SystemClock.elapsedRealtime() + 5000);
    }

    private void waitForExit(long deadline) {
        if (current != null) pollExit(current.sessionId, ++exitWaitGeneration, deadline);
    }

    private void pollExit(String ownerSession, long generation, long deadline) {
        if (generation != exitWaitGeneration || current == null || !ownerSession.equals(current.sessionId)) return;
        try {
            BootstrapStore.ActiveLaunch active = store.findLaunch(ownerSession);
            if (active == null || active.state == BootstrapStore.State.EXIT_CONFIRMED || confirmAbsent(active)) return;
            if (SystemClock.elapsedRealtime() >= deadline) {
                if (machine != null && machine.sessionId.equals(ownerSession)
                        && machine.state() == RuntimeStateMachine.State.EXIT_WAIT) machine.exitTimedOut(ownerSession);
                update("退出尚未确认，不能启动另一个环境；未强杀任何记录 PID。");
                return;
            }
            main.postDelayed(() -> pollExit(ownerSession, generation, deadline), 100);
        } catch (IOException | RuntimeException failure) {
            update("退出核对失败：" + safeCode(failure));
        }
    }

    private Message command(int what) {
        if (current == null || connection == null || connection.inbox == null) {
            throw new IllegalStateException("CONTROL_NOT_CONNECTED");
        }
        if (what != ControlProtocol.HELLO && !validatedControl) throw new IllegalStateException("CONTROL_NOT_VALIDATED");
        Message message = Message.obtain(null, what);
        Bundle data = new Bundle();
        data.putString(ControlProtocol.SESSION, current.sessionId);
        data.putString(ControlProtocol.NONCE, current.nonce);
        data.putString(ControlProtocol.INCARNATION, incarnation);
        data.putBoolean("stopping", stopping);
        message.setData(data);
        message.replyTo = connection.inbox;
        return message;
    }

    private boolean send(int what) {
        try {
            if (remote == null || current == null || !bound) throw new IllegalStateException("CONTROL_NOT_CONNECTED");
            remote.send(command(what));
            return true;
        } catch (RemoteException failure) {
            update("控制连接已断开；实际退出仍需核实。");
            return false;
        }
    }

    private void unbindControl() {
        boolean wasBound = bound;
        bound = false;
        remote = null;
        validatedControl = false;
        // Keep only the original connection's validated death watch until it is replaced.
        // Its inbox is already invalidated by bound=false, even if replies are queued.
        if (wasBound) context.unbindService(connection);
    }

    private void update(String value) {
        status = value;
        if (observer != null) observer.run();
    }

    private static String safeCode(Exception failure) {
        if (failure instanceof com.ahoo.abs.core.ValidationException) return ((com.ahoo.abs.core.ValidationException) failure).code;
        if (failure instanceof com.ahoo.abs.android.data.StorageException) return ((com.ahoo.abs.android.data.StorageException) failure).code.name();
        return failure.getClass().getSimpleName();
    }

    private static void requireMain() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("COORDINATOR_WRONG_THREAD");
    }

    private final class Connection implements ServiceConnection {
        private final String ownerSession;
        private final String ownerNonce;
        private Messenger inbox;
        private long generation;
        private boolean validated;
        private boolean activateOnHello;

        Connection(String session, String nonce) { ownerSession = session; ownerNonce = nonce; }

        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            if (connection != this || !bound || current == null || !ownerSession.equals(current.sessionId)
                    || !ownerNonce.equals(current.nonce)) return;
            long endpointGeneration = ++generation;
            validated = false;
            validatedControl = false;
            deathObserved = false;
            activateOnHello = true;
            remoteBinder = binder;
            remote = new Messenger(binder);
            inbox = new Messenger(new Handler(Looper.getMainLooper(),
                    message -> receive(this, binder, endpointGeneration, message)));
            try {
                binder.linkToDeath(() -> main.post(() -> {
                    if (connection != Connection.this || remoteBinder != binder || current == null
                            || generation != endpointGeneration || !ownerSession.equals(current.sessionId)
                            || !ownerNonce.equals(current.nonce)) return;
                    deathObserved = true;
                    try {
                        boolean free = ProcessLifecycle.isBrowserLockFree(context);
                        if (validated && machine != null && machine.sessionId.equals(ownerSession)
                                && machine.state() != RuntimeStateMachine.State.EXIT_CONFIRMED) {
                            machine.observeBinderDeath(machine.sessionId, deathObserved, free);
                        }
                        reconcile();
                    } catch (IOException failure) {
                        update("收到 Binder 死亡，但生命周期核对失败；退出仍未知。");
                    }
                }), 0);
                send(ControlProtocol.HELLO);
            } catch (RemoteException failure) {
                update("控制端在握手前死亡；未假定已退出。");
            }
        }
        @Override public void onServiceDisconnected(ComponentName name) {
            if (connection != this || !bound || current == null || !ownerSession.equals(current.sessionId)
                    || !ownerNonce.equals(current.nonce)) return;
            generation++;
            validated = false;
            remote = null;
            remoteBinder = null;
            validatedControl = false;
            update("服务连接断开，不等于浏览进程退出。");
        }
    }
}
