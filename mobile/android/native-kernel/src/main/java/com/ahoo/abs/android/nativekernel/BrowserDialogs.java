package com.ahoo.abs.android.nativekernel;

import android.app.Dialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** On-brand rounded confirmation dialogs for the browser surfaces (no AndroidX). */
public final class BrowserDialogs {
    // Palette read from the shared holders resolved by NativeBrowserActivity.resolvePalette.
    private static int INK() { return NativeBrowserActivity.C_INK; }
    private static int INK_SOFT() { return NativeBrowserActivity.C_INK_SOFT; }
    private static int MUTED() { return NativeBrowserActivity.C_MUTED; }
    private static int ACCENT() { return NativeBrowserActivity.C_ACCENT; }
    private static int DANGER() { return NativeBrowserActivity.C_DANGER; }
    private static int WHITE() { return NativeBrowserActivity.C_SURFACE; }

    private BrowserDialogs() { }

    public static Dialog confirm(Context context, String title, String message,
            String positiveLabel, Runnable onConfirm) {
        Dialog dialog = new Dialog(context);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.setDimAmount(0.32f);
            window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        }
        LinearLayout panel = new LinearLayout(context);
        panel.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable background = new GradientDrawable();
        background.setColor(WHITE());
        background.setCornerRadius(dp(context, 26));
        panel.setBackground(background);
        int pad = dp(context, 20);
        panel.setPadding(pad, dp(context, 20), pad, dp(context, 16));

        TextView heading = new TextView(context);
        heading.setText(title);
        heading.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setTextColor(INK());
        panel.addView(heading);

        TextView body = new TextView(context);
        body.setText(message);
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        body.setTextColor(INK_SOFT());
        body.setLineSpacing(dp(context, 4), 1f);
        LinearLayout.LayoutParams bodyLayout = new LinearLayout.LayoutParams(-1, -2);
        bodyLayout.topMargin = dp(context, 10);
        panel.addView(body, bodyLayout);

        LinearLayout actions = new LinearLayout(context);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams actionsLayout = new LinearLayout.LayoutParams(-1, -2);
        actionsLayout.topMargin = dp(context, 20);
        panel.addView(actions, actionsLayout);

        Button cancel = ghost(context, "取消");
        Button confirm = danger(context, positiveLabel);
        cancel.setOnClickListener(view -> dialog.dismiss());
        confirm.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            dialog.dismiss();
            if (onConfirm != null) onConfirm.run();
        });
        actions.addView(cancel, new LinearLayout.LayoutParams(0, dp(context, 50), 1f));
        LinearLayout.LayoutParams positiveLayout = new LinearLayout.LayoutParams(0, dp(context, 50), 1.25f);
        positiveLayout.leftMargin = dp(context, 10);
        actions.addView(confirm, positiveLayout);

        dialog.setContentView(panel);
        dialog.setCancelable(true);
        dialog.setCanceledOnTouchOutside(true);
        dialog.show();
        if (window != null) {
            // Cap the panel on tablets: a dialog stretching edge to edge reads as a full screen.
            int width = Math.min((int) (context.getResources().getDisplayMetrics().widthPixels * 0.9f),
                    dp(context, 420));
            window.setLayout(width, LinearLayout.LayoutParams.WRAP_CONTENT);
            View decor = window.getDecorView();
            decor.setScaleX(0.96f);
            decor.setScaleY(0.96f);
            decor.setAlpha(0f);
            decor.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(180).start();
        }
        return dialog;
    }

    private static Button ghost(Context context, String label) {
        Button view = base(context, label, NativeBrowserActivity.C_RIPPLE, 0, ACCENT());
        return view;
    }

    private static Button danger(Context context, String label) {
        return base(context, label, 0x22FFFFFF, DANGER(), WHITE());
    }

    private static Button base(Context context, String label, int ripple, int solid, int textColor) {
        Button view = new Button(context);
        view.setText(label);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        view.setAllCaps(false);
        view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        view.setTextColor(textColor);
        view.setMinHeight(dp(context, 50));
        view.setMinimumHeight(dp(context, 50));
        view.setPadding(dp(context, 16), dp(context, 10), dp(context, 16), dp(context, 10));
        view.setStateListAnimator(null);
        GradientDrawable fill = new GradientDrawable();
        fill.setColor(solid);
        fill.setCornerRadius(dp(context, 16));
        if (solid == 0) {
            fill.setColor(0x00000000);
        }
        view.setBackground(new RippleDrawable(ColorStateList.valueOf(ripple),
                solid == 0 ? null : fill, null));
        return view;
    }

    private static int dp(Context context, float value) {
        return Math.round(context.getResources().getDisplayMetrics().density * value);
    }
}
