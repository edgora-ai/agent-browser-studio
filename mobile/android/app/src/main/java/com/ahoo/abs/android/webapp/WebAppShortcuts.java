package com.ahoo.abs.android.webapp;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.os.Bundle;
import com.ahoo.abs.android.MainActivity;
import com.ahoo.abs.android.R;
import java.util.List;

/** Android pins are only launch handles; the private registry supplies all navigation metadata. */
public final class WebAppShortcuts {
    private static final String ENTRY = "com.ahoo.abs.android.PinnedWebApp";
    private static final String ACTION = "com.ahoo.abs.android.OPEN_PINNED_WEB_APP";
    private static final String ID = "shortcutId";

    public enum PinState { CONFIRMED, NOT_PINNED, UNAVAILABLE }
    public enum PinRequest {
        CONFIRMED("桌面入口已添加。"),
        AWAITING_LAUNCHER("已向桌面发送请求，需在系统提示中确认。"),
        NOT_SUPPORTED("当前桌面不支持添加网页应用入口。"),
        NOT_ACCEPTED("桌面未接受添加请求，可在网页应用中重试。");

        public final String message;
        PinRequest(String message) { this.message = message; }
    }

    private WebAppShortcuts() { }

    /** The framework dispatches a launcher pin as its publisher. The alias isn't publicly exported. */
    public static String shortcutId(Context context, Intent intent) {
        if (!isShortcutIntent(context, intent)) return null;
        if (!ACTION.equals(intent.getAction()) || intent.getData() != null || intent.getType() != null
                || intent.getSelector() != null || intent.getClipData() != null) return null;
        try {
            Bundle extras = intent.getExtras();
            if (extras == null || extras.size() != 1) return null;
            String value = extras.getString(ID);
            return WebApp.isOpaqueId(value) ? value : null;
        } catch (RuntimeException malformed) { return null; }
    }

    public static boolean isShortcutIntent(Context context, Intent intent) {
        return intent != null && entry(context).equals(intent.getComponent());
    }

    public static PinState pinState(Context context, String id) {
        if (!WebApp.isOpaqueId(id)) return PinState.NOT_PINNED;
        try {
            ShortcutManager manager = context.getSystemService(ShortcutManager.class);
            if (manager == null) return PinState.UNAVAILABLE;
            for (ShortcutInfo pin : manager.getPinnedShortcuts()) {
                if (id.equals(pin.getId()) && pin.isEnabled()) return PinState.CONFIRMED;
            }
            return PinState.NOT_PINNED;
        } catch (RuntimeException unavailable) { return PinState.UNAVAILABLE; }
    }

    public static PinRequest requestPin(Context context, WebApp app) {
        ShortcutManager manager = context.getSystemService(ShortcutManager.class);
        if (manager == null) return PinRequest.NOT_SUPPORTED;
        Intent intent = new Intent(ACTION).setComponent(entry(context)).putExtra(ID, app.shortcutId);
        ShortcutInfo pin = new ShortcutInfo.Builder(context, app.shortcutId)
                .setActivity(new ComponentName(context, MainActivity.class))
                .setShortLabel(app.name)
                .setLongLabel(app.name + " · " + app.origin)
                .setIcon(Icon.createWithResource(context, R.drawable.ic_launcher))
                .setIntent(intent)
                .build();
        if (pinState(context, app.shortcutId) == PinState.CONFIRMED) {
            return manager.updateShortcuts(List.of(pin)) && pinState(context, app.shortcutId) == PinState.CONFIRMED
                    ? PinRequest.CONFIRMED : PinRequest.NOT_ACCEPTED;
        }
        if (!manager.isRequestPinShortcutSupported()) return PinRequest.NOT_SUPPORTED;
        if (!manager.requestPinShortcut(pin, null)) return PinRequest.NOT_ACCEPTED;
        return pinState(context, app.shortcutId) == PinState.CONFIRMED
                ? PinRequest.CONFIRMED : PinRequest.AWAITING_LAUNCHER;
    }

    public static void disable(Context context, String id) {
        ShortcutManager manager = context.getSystemService(ShortcutManager.class);
        if (manager != null) manager.disableShortcuts(List.of(id), "此网页应用已移除。");
    }

    private static ComponentName entry(Context context) { return new ComponentName(context.getPackageName(), ENTRY); }
}
