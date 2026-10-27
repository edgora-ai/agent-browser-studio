package com.ahoo.abs.android.browser;

import android.app.Service;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.Process;
import android.os.RemoteException;
import android.util.Log;
import com.ahoo.abs.android.BrowserApplication;
import com.ahoo.abs.core.LaunchSpec;

/** Same-UID, non-exported control. Browser identity cannot be replaced through IPC. */
public final class BrowserControlService extends Service {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Messenger control = new Messenger(new Handler(Looper.getMainLooper(), this::receive));
    private static boolean drainRequested;
    private static boolean drainReturned;
    private static String cookieOutcome = "NOT_ATTEMPTED";
    private static Messenger drainDestination;

    @Override
    public IBinder onBind(Intent intent) {
        return control.getBinder();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_NOT_STICKY;
    }

    private boolean receive(Message message) {
        if (message.sendingUid != Process.myUid()) {
            Log.w("AbsBrowserControl", "CONTROL_CALLER_REJECTED");
            return true;
        }
        BrowserApplication application = (BrowserApplication) getApplication();
        LaunchSpec launch;
        try {
            launch = application.requireLaunch();
        } catch (IllegalStateException rejected) {
            if (message.what == ControlProtocol.EXIT_REJECTED && application.incarnation() != null
                    && application.incarnation().equals(message.getData().getString(ControlProtocol.INCARNATION))) {
                main.post(() -> Process.killProcess(Process.myPid()));
                return true;
            }
            Bundle error = new Bundle();
            error.putString(ControlProtocol.CODE, "BOOTSTRAP_REJECTED");
            error.putString(ControlProtocol.SESSION, message.getData().getString(ControlProtocol.SESSION));
            error.putString(ControlProtocol.NONCE, message.getData().getString(ControlProtocol.NONCE));
            error.putInt(ControlProtocol.PID, Process.myPid());
            error.putString(ControlProtocol.INCARNATION, application.incarnation());
            reply(message.replyTo, ControlProtocol.ERROR, error);
            return true;
        }
        Bundle request = message.getData();
        if (!launch.sessionId.equals(request.getString(ControlProtocol.SESSION))
                || !launch.nonce.equals(request.getString(ControlProtocol.NONCE))) {
            replyError(message.replyTo, "CONTROL_SESSION_REJECTED");
            return true;
        }
        switch (message.what) {
            case ControlProtocol.HELLO:
                if (!drainRequested && !request.getBoolean("stopping", false)) application.activateController();
                Bundle hello = session(launch, application);
                hello.putBoolean("drained", drainReturned);
                hello.putString(ControlProtocol.COOKIE, cookieOutcome);
                reply(message.replyTo, ControlProtocol.HELLO_REPLY, hello);
                break;
            case ControlProtocol.DRAIN:
                drainDestination = message.replyTo;
                if (drainReturned) {
                    drained(drainDestination, launch, application, cookieOutcome);
                    break;
                }
                if (drainRequested) break;
                drainRequested = true;
                application.markDraining();
                BrowserRuntime runtime = BrowserRuntime.existing(application);
                if (runtime == null) {
                    drained(drainDestination, launch, application, "NOT_ATTEMPTED");
                } else {
                    runtime.beginDrain(outcome -> drained(drainDestination, launch, application, outcome));
                }
                break;
            case ControlProtocol.EXIT_SELF:
                if (!drainReturned || !application.incarnation().equals(request.getString(ControlProtocol.INCARNATION))) {
                    replyError(message.replyTo, "EXIT_NOT_AUTHORIZED");
                    break;
                }
                // Never accepts an arbitrary PID; the initialized browser process exits itself.
                main.post(() -> Process.killProcess(Process.myPid()));
                break;
            default:
                replyError(message.replyTo, "CONTROL_COMMAND_REJECTED");
                break;
        }
        return true;
    }

    private void drained(Messenger destination, LaunchSpec launch, BrowserApplication application, String outcome) {
        drainReturned = true;
        cookieOutcome = outcome;
        Bundle receipt = session(launch, application);
        receipt.putString(ControlProtocol.COOKIE, outcome);
        receipt.putString("webStorageDurability", "UNVERIFIED");
        reply(destination, ControlProtocol.DRAIN_REPLY, receipt);
    }

    private static Bundle session(LaunchSpec launch, BrowserApplication application) {
        Bundle value = new Bundle();
        value.putString(ControlProtocol.SESSION, launch.sessionId);
        value.putString(ControlProtocol.INCARNATION, application.incarnation());
        value.putInt(ControlProtocol.PID, Process.myPid());
        return value;
    }

    private static void replyError(Messenger destination, String code) {
        Bundle value = new Bundle();
        value.putString(ControlProtocol.CODE, code);
        reply(destination, ControlProtocol.ERROR, value);
    }

    private static void reply(Messenger destination, int what, Bundle value) {
        if (destination == null) {
            Log.w("AbsBrowserControl", "CONTROL_REPLY_MISSING");
            return;
        }
        Message response = Message.obtain(null, what);
        response.setData(value);
        try {
            destination.send(response);
        } catch (RemoteException disconnected) {
            Log.w("AbsBrowserControl", "CONTROL_REPLY_DISCONNECTED");
        }
    }
}
