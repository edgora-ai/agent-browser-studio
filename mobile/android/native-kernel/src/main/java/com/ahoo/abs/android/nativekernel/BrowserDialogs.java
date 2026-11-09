package com.ahoo.abs.android.nativekernel;

import android.app.Dialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** On-brand rounded confirmation dialogs for the browser surfaces (no AndroidX). */
public final class BrowserDialogs {
    // Palette read from the shared holders resolved by NativeBrowserActivity.resolvePalette.
    private static int INK() { return NativeBrowserActivity.C_INK; }
    private static int INK_SOFT() { return NativeBrowserActivity.C_INK_SOFT; }
    private static int ACCENT() { return NativeBrowserActivity.C_ACCENT; }
    private static int DANGER() { return NativeBrowserActivity.C_DANGER; }
    private static int SURFACE() { return NativeBrowserActivity.C_SURFACE; }
    private static int ON_DANGER() { return com.ahoo.abs.android.Ui.ON_DANGER; }

    private static final class ThemedDialog extends Dialog {
        final NativeBrowserActivity.PaletteBindings palette = new NativeBrowserActivity.PaletteBindings();
        final NativeBrowserActivity.FontBindings fonts = new NativeBrowserActivity.FontBindings();

        ThemedDialog(Context context) { super(context); }

        @Override public void dismiss() {
            super.dismiss();
            fonts.clear();
        }
    }

    static void applyPalette(Dialog dialog) {
        if (dialog instanceof ThemedDialog) ((ThemedDialog) dialog).palette.apply();
    }

    static void applyFontScale(Dialog dialog) {
        if (!(dialog instanceof ThemedDialog)) return;
        ThemedDialog owned = (ThemedDialog) dialog;
        owned.fonts.apply();
        Window window = owned.getWindow();
        if (window != null) window.getDecorView().requestLayout();
    }

    /** Keep actions outside the bounded text scroller, including short landscape windows. */
    private static final class DialogPanel extends LinearLayout {
        DialogPanel(Context context) { super(context); setOrientation(VERTICAL); }

        @Override protected void onMeasure(int widthSpec, int heightSpec) {
            int width = View.MeasureSpec.getSize(widthSpec);
            int height = View.MeasureSpec.getMode(heightSpec) == View.MeasureSpec.UNSPECIFIED
                    ? getResources().getDisplayMetrics().heightPixels : View.MeasureSpec.getSize(heightSpec);
            int innerWidth = Math.max(0, width - getPaddingLeft() - getPaddingRight());
            int available = Math.max(0, height - getPaddingTop() - getPaddingBottom());
            View actions = getChildAt(1);
            LinearLayout.LayoutParams actionParams = (LinearLayout.LayoutParams) actions.getLayoutParams();
            int margins = actionParams.topMargin + actionParams.bottomMargin;
            actions.measure(View.MeasureSpec.makeMeasureSpec(innerWidth, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(Math.max(0, available - margins), View.MeasureSpec.AT_MOST));
            View text = getChildAt(0);
            text.measure(View.MeasureSpec.makeMeasureSpec(innerWidth, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(Math.max(0, available - margins - actions.getMeasuredHeight()),
                            View.MeasureSpec.AT_MOST));
            setMeasuredDimension(View.resolveSize(width, widthSpec), View.resolveSize(getPaddingTop()
                    + text.getMeasuredHeight() + margins + actions.getMeasuredHeight() + getPaddingBottom(), heightSpec));
        }
    }

    /** Fit complete labels by measuring the current font, never by shrinking the SP roles. */
    private static final class DialogActions extends LinearLayout {
        DialogActions(Context context) { super(context); setGravity(Gravity.CENTER_VERTICAL); }

        @Override protected void onMeasure(int widthSpec, int heightSpec) {
            int width = View.MeasureSpec.getSize(widthSpec);
            View cancel = getChildAt(0);
            View confirm = getChildAt(1);
            int natural = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED);
            cancel.measure(natural, natural);
            confirm.measure(natural, natural);
            int gap = dp(getContext(), 10);
            // Horizontal weights are 1 : 1.25; both individual allocations must fit.
            boolean stacked = View.MeasureSpec.getMode(widthSpec) != View.MeasureSpec.UNSPECIFIED
                    && (cancel.getMeasuredWidth() > (width - gap) / 2.25f
                        || confirm.getMeasuredWidth() > (width - gap) * 1.25f / 2.25f);
            setOrientation(stacked ? VERTICAL : HORIZONTAL);
            LinearLayout.LayoutParams first = (LinearLayout.LayoutParams) cancel.getLayoutParams();
            LinearLayout.LayoutParams second = (LinearLayout.LayoutParams) confirm.getLayoutParams();
            first.width = stacked ? -1 : 0;
            first.weight = stacked ? 0 : 1;
            second.width = stacked ? -1 : 0;
            second.weight = stacked ? 0 : 1.25f;
            second.leftMargin = stacked ? 0 : gap;
            second.topMargin = stacked ? gap : 0;
            super.onMeasure(widthSpec, heightSpec);
        }
    }

    private BrowserDialogs() { }

    public static Dialog confirm(Context context, String title, String message,
            String positiveLabel, Runnable onConfirm) {
        ThemedDialog dialog = new ThemedDialog(context);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.setDimAmount(0.32f);
            window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        }
        LinearLayout panel = new DialogPanel(context);
        GradientDrawable background = new GradientDrawable();
        dialog.palette.add(() -> background.setColor(SURFACE()));
        background.setCornerRadius(dp(context, 26));
        panel.setBackground(background);
        int pad = dp(context, 20);
        panel.setPadding(pad, dp(context, 20), pad, dp(context, 16));

        ScrollView textScroll = new ScrollView(context);
        LinearLayout text = new LinearLayout(context);
        text.setOrientation(LinearLayout.VERTICAL);
        textScroll.addView(text, new android.widget.FrameLayout.LayoutParams(-1, -2));
        panel.addView(textScroll, new LinearLayout.LayoutParams(-1, -2));

        TextView heading = new TextView(context);
        heading.setText(title);
        dialog.fonts.bind(heading, 19);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        dialog.palette.add(() -> heading.setTextColor(INK()));
        text.addView(heading);

        TextView body = new TextView(context);
        body.setText(message);
        dialog.fonts.bind(body, 14.5f);
        dialog.palette.add(() -> body.setTextColor(INK_SOFT()));
        body.setLineSpacing(dp(context, 4), 1f);
        LinearLayout.LayoutParams bodyLayout = new LinearLayout.LayoutParams(-1, -2);
        bodyLayout.topMargin = dp(context, 10);
        text.addView(body, bodyLayout);

        LinearLayout actions = new DialogActions(context);
        LinearLayout.LayoutParams actionsLayout = new LinearLayout.LayoutParams(-1, -2);
        actionsLayout.topMargin = dp(context, 20);
        panel.addView(actions, actionsLayout);

        Button cancel = ghost(context, "取消", dialog.fonts);
        Button confirm = danger(context, positiveLabel, dialog.fonts);
        dialog.palette.add(() -> {
            tintButton(cancel, NativeBrowserActivity.C_RIPPLE, 0, ACCENT());
            tintButton(confirm, NativeBrowserActivity.C_RIPPLE, DANGER(), ON_DANGER());
        });
        dialog.palette.add(() -> NativeBrowserActivity.applySystemBarAppearance(dialog.getWindow()));
        cancel.setOnClickListener(view -> dialog.dismiss());
        confirm.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            dialog.dismiss();
            if (onConfirm != null) onConfirm.run();
        });
        actions.addView(cancel, new LinearLayout.LayoutParams(0, -2, 1f));
        LinearLayout.LayoutParams positiveLayout = new LinearLayout.LayoutParams(0, -2, 1.25f);
        positiveLayout.leftMargin = dp(context, 10);
        actions.addView(confirm, positiveLayout);

        dialog.setContentView(panel);
        dialog.setCancelable(true);
        dialog.setCanceledOnTouchOutside(true);
        dialog.show();
        dialog.palette.apply();
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

    private static Button ghost(Context context, String label, NativeBrowserActivity.FontBindings fonts) {
        Button view = base(context, label, NativeBrowserActivity.C_RIPPLE, 0, ACCENT(), fonts);
        return view;
    }

    private static Button danger(Context context, String label, NativeBrowserActivity.FontBindings fonts) {
        return base(context, label, NativeBrowserActivity.C_RIPPLE, DANGER(), ON_DANGER(), fonts);
    }

    private static Button base(Context context, String label, int ripple, int solid, int textColor,
            NativeBrowserActivity.FontBindings fonts) {
        Button view = new Button(context);
        view.setText(label);
        fonts.bind(view, 14.5f);
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

    private static void tintButton(Button view, int ripple, int solid, int foreground) {
        view.setTextColor(foreground);
        RippleDrawable background = (RippleDrawable) view.getBackground();
        background.setColor(ColorStateList.valueOf(ripple));
        if (background.getNumberOfLayers() > 0
                && background.getDrawable(0) instanceof GradientDrawable) {
            ((GradientDrawable) background.getDrawable(0)).setColor(solid);
        }
    }

    private static int dp(Context context, float value) {
        return Math.round(context.getResources().getDisplayMetrics().density * value);
    }
}
