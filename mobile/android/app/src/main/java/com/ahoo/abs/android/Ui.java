package com.ahoo.abs.android;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.animation.DecelerateInterpolator;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import com.ahoo.abs.android.data.StorageException;
import com.ahoo.abs.core.ValidationException;

/**
 * Native design system shared by the manager and editors. Everything is built from framework
 * views and hand-drawn vector glyphs; intentionally no WebView, AndroidX or XML resources.
 *
 * <p>Visual language: airy canvas, white surfaces with hairline strokes, one indigo→violet
 * accent, medium-weight sans titles and 220 ms decelerate motion. Interactive controls use a
 * bounded ripple, a subtle press-scale and a haptic tick when they change state.
 */
public final class Ui {
    // ── Palette ────────────────────────────────────────────────────────────────────────────
    // Resolved per-activity from the current night mode (initPalette from root()). Static
    // because the design system is used from static builders; never cache into final copies.
    public static int BG;
    public static int BG_DEEP;
    public static int INK;
    public static int INK_SOFT;
    public static int MUTED;
    public static int FAINT;
    public static int ACCENT;
    public static int ACCENT_DEEP;
    public static int ACCENT_2;
    public static int ACCENT_SOFT;
    public static int STROKE;
    public static int WHITE;
    public static int SUCCESS;
    public static int WARNING;
    public static int DANGER;
    public static int SURFACE_SOFT;
    /** True when the palette was resolved for night mode; for the few fixed-surface cases. */
    public static boolean DARK;
    /** Top of the home gradient; equals the theme window background of the active mode. */
    public static int SURFACE_TOP;

    public static final int RADIUS_CARD = 20;
    public static final int RADIUS_FIELD = 14;
    public static final int RADIUS_BUTTON = 16;

    private static final Typeface MEDIUM = Typeface.create("sans-serif-medium", Typeface.NORMAL);
    private static final Typeface REGULAR = Typeface.create("sans-serif", Typeface.NORMAL);
    private static final DecelerateInterpolator EASE = new DecelerateInterpolator(1.6f);

    private Ui() { }

    /** Resolve the palette from the current uiMode; light values stay the r8 design language. */
    public static void initPalette(Context context) {
        int mask = context.getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
        if (mask == android.content.res.Configuration.UI_MODE_NIGHT_YES) {
            DARK = true;
            BG = 0xFF0E1016;
            BG_DEEP = 0xFF161923;
            INK = 0xFFE6E9F2;
            INK_SOFT = 0xFFC3C9D6;
            MUTED = 0xFF8B94A7;
            FAINT = 0xFF5A6478;
            ACCENT = 0xFF818CF8;
            ACCENT_DEEP = 0xFFA5B4FC;
            ACCENT_2 = 0xFFA78BFA;
            ACCENT_SOFT = 0xFF23264A;
            STROKE = 0xFF232838;
            WHITE = 0xFF171B26;
            SUCCESS = 0xFF34D399;
            WARNING = 0xFFFBBF24;
            DANGER = 0xFFF87171;
            SURFACE_SOFT = 0xFF1E2230;
            SURFACE_TOP = 0xFF141824;
        } else {
            DARK = false;
            BG = 0xFFF4F5F9;
            BG_DEEP = 0xFFEDEFF6;
            INK = 0xFF0F172A;
            INK_SOFT = 0xFF334155;
            MUTED = 0xFF64748B;
            FAINT = 0xFF94A3B8;
            ACCENT = 0xFF4F46E5;
            ACCENT_DEEP = 0xFF4338CA;
            ACCENT_2 = 0xFF7C3AED;
            ACCENT_SOFT = 0xFFEDEFFF;
            STROKE = 0xFFE7E9F0;
            WHITE = 0xFFFFFFFF;
            SUCCESS = 0xFF059669;
            WARNING = 0xFFD97706;
            DANGER = 0xFFDC2626;
            SURFACE_SOFT = 0xFFF7F8FC;
            SURFACE_TOP = 0xFFF7F8FC;
        }
    }

    // ── Metrics ────────────────────────────────────────────────────────────────────────────
    public static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    public static int dp(Context context, float value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    // ── Surfaces ───────────────────────────────────────────────────────────────────────────
    public static GradientDrawable shape(Context context, int color, int radius, boolean border) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(context, radius));
        if (border) drawable.setStroke(dp(context, 1), STROKE);
        return drawable;
    }

    public static GradientDrawable shape(Context context, int color, int radius) {
        return shape(context, color, radius, false);
    }

    public static GradientDrawable gradient(Context context, int radius, int start, int end) {
        GradientDrawable drawable = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{start, end});
        drawable.setCornerRadius(dp(context, radius));
        return drawable;
    }

    /** White card with a hairline stroke, soft ambient elevation and generous padding. */
    public static LinearLayout card(Context context) {
        LinearLayout view = column(context);
        view.setBackground(shape(context, WHITE, RADIUS_CARD, true));
        view.setElevation(dp(context, 1.5f));
        int pad = dp(context, 18);
        view.setPadding(pad, pad, pad, pad);
        return view;
    }

    public static View divider(Context context) {
        View line = new View(context);
        line.setBackgroundColor(STROKE);
        line.setLayoutParams(new LinearLayout.LayoutParams(-1, Math.max(1, dp(context, 1))));
        return line;
    }

    // ── Layout ─────────────────────────────────────────────────────────────────────────────
    public static LinearLayout column(Context context) {
        LinearLayout view = new LinearLayout(context);
        view.setOrientation(LinearLayout.VERTICAL);
        return view;
    }

    public static LinearLayout row(Context context) {
        LinearLayout view = new LinearLayout(context);
        view.setOrientation(LinearLayout.HORIZONTAL);
        view.setGravity(Gravity.CENTER_VERTICAL);
        return view;
    }

    /**
     * Single-line wrap flow for chips/tags. LinearLayout rows clip overflow when text is long
     * or the system font scale is large; this wraps to the next line instead. Children should
     * carry horizontal/right margins as their own layout params (read at layout time).
     */
    public static final class FlowLayout extends ViewGroup {
        private final List<View> children = new java.util.ArrayList<>();

        public FlowLayout(Context context) {
            super(context);
        }

        /** Adds a child with the given horizontal spacing (left/right margins, dp). */
        public void add(View child, int leftMarginDp, int rightMarginDp, int verticalSpacingDp) {
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2);
            params.leftMargin = dp(getContext(), leftMarginDp);
            params.rightMargin = dp(getContext(), rightMarginDp);
            params.topMargin = dp(getContext(), verticalSpacingDp);
            child.setLayoutParams(params);
            children.add(child);
            super.addView(child);
        }

        public void clear() {
            children.clear();
            removeAllViews();
        }

        @Override protected void onMeasure(int widthSpec, int heightSpec) {
            int maxWidth = MeasureSpec.getSize(widthSpec);
            int x = 0;
            int y = 0;
            int rowHeight = 0;
            for (View child : children) {
                if (child.getVisibility() == View.GONE) continue;
                child.measure(MeasureSpec.UNSPECIFIED, MeasureSpec.UNSPECIFIED);
                int width = child.getMeasuredWidth();
                int left = child.getLayoutParams() instanceof ViewGroup.MarginLayoutParams
                        ? ((ViewGroup.MarginLayoutParams) child.getLayoutParams()).leftMargin : 0;
                int right = child.getLayoutParams() instanceof ViewGroup.MarginLayoutParams
                        ? ((ViewGroup.MarginLayoutParams) child.getLayoutParams()).rightMargin : 0;
                int top = child.getLayoutParams() instanceof ViewGroup.MarginLayoutParams
                        ? ((ViewGroup.MarginLayoutParams) child.getLayoutParams()).topMargin : 0;
                if (x > 0 && x + left + width > maxWidth) {
                    x = 0;
                    y += rowHeight;
                    rowHeight = 0;
                }
                x += left + width + right;
                rowHeight = Math.max(rowHeight, child.getMeasuredHeight() + top);
            }
            setMeasuredDimension(resolveSize(maxWidth, widthSpec),
                    resolveSize(y + rowHeight + getPaddingBottom(), heightSpec));
        }

        @Override protected void onLayout(boolean changed, int l, int t, int r, int b) {
            int maxWidth = r - l - getPaddingLeft() - getPaddingRight();
            int x = 0;
            int y = getPaddingTop();
            int rowHeight = 0;
            for (View child : children) {
                if (child.getVisibility() == View.GONE) continue;
                ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) child.getLayoutParams();
                int width = child.getMeasuredWidth();
                if (x > 0 && x + params.leftMargin + width > maxWidth) {
                    x = 0;
                    y += rowHeight;
                    rowHeight = 0;
                }
                child.layout(getPaddingLeft() + x + params.leftMargin, y + params.topMargin,
                        getPaddingLeft() + x + params.leftMargin + width,
                        y + params.topMargin + child.getMeasuredHeight());
                x += params.leftMargin + width + params.rightMargin;
                rowHeight = Math.max(rowHeight, child.getMeasuredHeight() + params.topMargin);
            }
        }
    }

    /** Top margin for one block in the standard vertical rhythm. */
    public static LinearLayout.LayoutParams gap(Context context, float topDp) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(context, topDp);
        return params;
    }

    @SuppressWarnings("deprecation")
    public static LinearLayout root(Activity activity) {
        initPalette(activity);
        LinearLayout root = column(activity);
        root.setBackground(gradient(activity, 0, SURFACE_TOP, BG));
        int side = dp(activity, 20);
        // Keep the system-bar icons readable in both modes (API 35 ignores bar colors; the
        // night theme handles windowBackground, this keeps pre-35 devices consistent).
        View decor = activity.getWindow().getDecorView();
        int lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        if ((activity.getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES) {
            decor.setSystemUiVisibility(decor.getSystemUiVisibility() & ~lightFlags);
        } else {
            decor.setSystemUiVisibility(decor.getSystemUiVisibility() | lightFlags);
        }
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int top;
            int bottom;
            int left;
            int right;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                top = bars.top; bottom = bars.bottom; left = bars.left; right = bars.right;
            } else {
                top = insets.getSystemWindowInsetTop(); bottom = insets.getSystemWindowInsetBottom();
                left = insets.getSystemWindowInsetLeft(); right = insets.getSystemWindowInsetRight();
            }
            view.setPadding(side + left, dp(activity, 10) + top, side + right, dp(activity, 10) + bottom);
            return insets;
        });
        activity.setContentView(root);
        root.requestApplyInsets();
        return root;
    }

    // ── Typography ─────────────────────────────────────────────────────────────────────────
    public static TextView styled(Context context, String value, float sizeSp, int color, Typeface face) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        view.setTextColor(color);
        view.setTypeface(face);
        view.setIncludeFontPadding(false);
        return view;
    }

    public static TextView text(Context context, String value, int size) {
        TextView view = styled(context, value, size, INK, REGULAR);
        view.setLineSpacing(dp(context, 2), 1.0f);
        view.setPadding(0, dp(context, 4), 0, dp(context, 4));
        return view;
    }

    public static TextView display(Context context, String value) {
        TextView view = styled(context, value, 25, INK, MEDIUM);
        view.setLetterSpacing(-0.02f);
        return view;
    }

    public static TextView title(Context context, String value) {
        TextView view = styled(context, value, 17.5f, INK, MEDIUM);
        view.setLetterSpacing(-0.01f);
        return view;
    }

    public static TextView heading(Context context, String value) {
        return styled(context, value, 15, INK, MEDIUM);
    }

    public static TextView body(Context context, String value) {
        TextView view = styled(context, value, 14.5f, INK_SOFT, REGULAR);
        view.setLineSpacing(dp(context, 3), 1.0f);
        return view;
    }

    public static TextView caption(Context context, String value) {
        TextView view = styled(context, value, 12.5f, MUTED, REGULAR);
        view.setLineSpacing(dp(context, 2), 1.0f);
        return view;
    }

    public static TextView label(Context context, String value) {
        // MUTED, not FAINT: section labels are informative text and must clear 4.5:1.
        TextView view = styled(context, value, 12, MUTED, MEDIUM);
        view.setLetterSpacing(0.06f);
        view.setAllCaps(true);
        return view;
    }

    public static TextView muted(Context context, String value, int size) {
        return styled(context, value, size, MUTED, REGULAR);
    }

    public static TextView bold(Context context, String value, int size) {
        return styled(context, value, size, INK, MEDIUM);
    }

    // ── Interaction helpers ────────────────────────────────────────────────────────────────
    public static void haptic(View view) {
        // No FLAG_IGNORE_GLOBAL_SETTING: users who turned touch feedback off keep it off.
        view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
    }

    /** Subtle press-scale (0.97) with decelerate motion; the view keeps its own click listener. */
    public static void pressable(View view) {
        view.setOnTouchListener((v, event) -> {
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
                v.animate().scaleX(0.97f).scaleY(0.97f).setDuration(90).setInterpolator(EASE).start();
            } else if (event.getActionMasked() == MotionEvent.ACTION_CANCEL
                    || event.getActionMasked() == MotionEvent.ACTION_UP) {
                v.animate().scaleX(1f).scaleY(1f).setDuration(180).setInterpolator(EASE).start();
            }
            return false;
        });
    }

    public static void animateIn(View view) {
        view.setAlpha(0f);
        view.setTranslationY(dp(view.getContext(), 10));
        view.animate().alpha(1f).translationY(0f).setDuration(240).setInterpolator(EASE).start();
    }

    /**
     * Branded bottom capsule for lightweight outcomes (saved/deleted/copied). One at a time;
     * auto-dismisses. Deliberately not a Toast: it stays inside the activity's own window.
     */
    public static void snackbar(Activity activity, String message) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return;
        ViewGroup content = activity.findViewById(android.R.id.content);
        if (content == null) return;
        for (int i = content.getChildCount() - 1; i >= 0; i--) {
            View child = content.getChildAt(i);
            if ("abs-snackbar".equals(child.getTag())) content.removeView(child);
        }
        TextView capsule = new TextView(activity);
        capsule.setText(message);
        capsule.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        // Literal white: the capsule stays dark in both modes, and the WHITE palette resolves
        // to dark ink at night, which would be unreadable on it.
        capsule.setTextColor(0xFFFFFFFF);
        capsule.setTypeface(MEDIUM);
        capsule.setMaxLines(2);
        capsule.setElevation(dp(activity, 6f));
        int padH = dp(activity, 20);
        int padV = dp(activity, 13);
        capsule.setPadding(padH, padV, padH, padV);
        capsule.setBackground(shape(activity, 0xEE111827, 999));
        capsule.setTag("abs-snackbar");
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-2, -2);
        params.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        int margin = dp(activity, 20);
        params.bottomMargin = dp(activity, 80);
        params.leftMargin = margin;
        params.rightMargin = margin;
        content.addView(capsule, params);
        capsule.setTranslationY(dp(activity, 24));
        capsule.setAlpha(0f);
        capsule.animate().alpha(1f).translationY(0f).setDuration(200).setInterpolator(EASE).start();
        capsule.postDelayed(() -> {
            if (capsule.getParent() == null) return;
            capsule.animate().alpha(0f).translationY(dp(activity, 16)).setDuration(180)
                    .withEndAction(() -> { if (capsule.getParent() != null) content.removeView(capsule); })
                    .start();
        }, 2200);
    }

    /** Busy/disabled visual state: dims the whole button so a disabled primary stops looking tappable. */
    public static void setBusy(Button button, boolean busy) {
        button.setEnabled(!busy);
        button.setAlpha(busy ? 0.45f : 1f);
    }

    /** Dim styling for any disabled control (buttons keep their gradient otherwise). */
    public static void applyEnabledLook(View view, boolean enabled) {
        view.setEnabled(enabled);
        view.setAlpha(enabled ? 1f : 0.55f);
    }

    // ── Vector glyphs ──────────────────────────────────────────────────────────────────────
    public enum Glyph { BACK, CLOSE, SEARCH, PLUS, TABS, MENU, HISTORY, GLOBE, SHIELD, CHECK,
        CHEVRON, REFRESH, LOCK, PROFILE, PROXY, SPARK, TRASH, COPY, INFO }

    /** Crisp hand-drawn vector icon; no font glyph or emoji dependency. */
    public static final class IconView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        private Glyph glyph;
        private int color;

        public IconView(Context context, Glyph glyph, int color) {
            super(context);
            this.glyph = glyph;
            this.color = color;
            paint.setColor(color);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(dp(context, 1.9f));
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
        }

        public void setGlyph(Glyph glyph) {
            this.glyph = glyph;
            invalidate();
        }

        public void setColor(int color) {
            this.color = color;
            paint.setColor(color);
            invalidate();
        }

        @Override protected void onDraw(Canvas canvas) {
            float w = getWidth();
            float h = getHeight();
            float s = Math.min(w, h) * 0.34f;
            canvas.save();
            canvas.translate(w / 2f, h / 2f);
            path.reset();
            paint.setColor(color);
            switch (glyph) {
                case BACK:
                    path.moveTo(s * 0.55f, -s * 0.75f);
                    path.lineTo(-s * 0.55f, 0);
                    path.lineTo(s * 0.55f, s * 0.75f);
                    canvas.drawPath(path, paint);
                    break;
                case CLOSE:
                    path.moveTo(-s * 0.65f, -s * 0.65f); path.lineTo(s * 0.65f, s * 0.65f);
                    path.moveTo(s * 0.65f, -s * 0.65f); path.lineTo(-s * 0.65f, s * 0.65f);
                    canvas.drawPath(path, paint);
                    break;
                case SEARCH:
                    canvas.drawCircle(-s * 0.15f, -s * 0.15f, s * 0.62f, paint);
                    path.moveTo(s * 0.3f, s * 0.3f); path.lineTo(s * 0.95f, s * 0.95f);
                    canvas.drawPath(path, paint);
                    break;
                case PLUS:
                    path.moveTo(-s * 0.8f, 0); path.lineTo(s * 0.8f, 0);
                    path.moveTo(0, -s * 0.8f); path.lineTo(0, s * 0.8f);
                    canvas.drawPath(path, paint);
                    break;
                case TABS:
                    canvas.drawRect(-s * 0.85f, -s * 0.45f, s * 0.45f, s * 0.8f, paint);
                    path.moveTo(-s * 0.35f, -s * 0.75f);
                    path.lineTo(s * 0.75f, -s * 0.75f);
                    path.lineTo(s * 0.75f, s * 0.35f);
                    canvas.drawPath(path, paint);
                    break;
                case MENU:
                    paint.setStyle(Paint.Style.FILL);
                    canvas.drawCircle(0, -s * 0.72f, s * 0.20f, paint);
                    canvas.drawCircle(0, 0, s * 0.20f, paint);
                    canvas.drawCircle(0, s * 0.72f, s * 0.20f, paint);
                    paint.setStyle(Paint.Style.STROKE);
                    break;
                case HISTORY:
                    canvas.drawCircle(0, 0, s * 0.92f, paint);
                    path.moveTo(0, -s * 0.45f); path.lineTo(0, s * 0.05f);
                    path.lineTo(s * 0.45f, s * 0.28f);
                    canvas.drawPath(path, paint);
                    break;
                case GLOBE:
                    canvas.drawCircle(0, 0, s * 0.92f, paint);
                    canvas.drawOval(-s * 0.42f, -s * 0.92f, s * 0.42f, s * 0.92f, paint);
                    path.moveTo(-s * 0.9f, 0); path.lineTo(s * 0.9f, 0);
                    canvas.drawPath(path, paint);
                    break;
                case SHIELD:
                    path.moveTo(0, -s * 0.95f);
                    path.lineTo(s * 0.8f, -s * 0.55f);
                    path.lineTo(s * 0.8f, s * 0.1f);
                    path.quadTo(s * 0.8f, s * 0.75f, 0, s * 0.98f);
                    path.quadTo(-s * 0.8f, s * 0.75f, -s * 0.8f, s * 0.1f);
                    path.lineTo(-s * 0.8f, -s * 0.55f);
                    path.close();
                    canvas.drawPath(path, paint);
                    break;
                case CHECK:
                    path.moveTo(-s * 0.75f, 0);
                    path.lineTo(-s * 0.15f, s * 0.6f);
                    path.lineTo(s * 0.8f, -s * 0.6f);
                    canvas.drawPath(path, paint);
                    break;
                case CHEVRON:
                    path.moveTo(-s * 0.35f, -s * 0.55f);
                    path.lineTo(s * 0.4f, 0);
                    path.lineTo(-s * 0.35f, s * 0.55f);
                    canvas.drawPath(path, paint);
                    break;
                case REFRESH:
                    path.addArc(-s * 0.9f, -s * 0.9f, s * 0.9f, s * 0.9f, -60, 300);
                    canvas.drawPath(path, paint);
                    break;
                case LOCK:
                    canvas.drawRoundRect(-s * 0.65f, -s * 0.05f, s * 0.65f, s * 0.95f,
                            s * 0.18f, s * 0.18f, paint);
                    path.addArc(-s * 0.45f, -s * 0.8f, s * 0.45f, s * 0.1f, 180, 180);
                    canvas.drawPath(path, paint);
                    break;
                case PROFILE:
                    canvas.drawCircle(0, -s * 0.35f, s * 0.38f, paint);
                    path.addArc(-s * 0.85f, s * 0.15f, s * 0.85f, s * 1.45f, 180, 180);
                    canvas.drawPath(path, paint);
                    break;
                case PROXY:
                    canvas.drawCircle(-s * 0.4f, 0, s * 0.42f, paint);
                    canvas.drawCircle(s * 0.4f, 0, s * 0.42f, paint);
                    path.moveTo(-s * 0.05f, 0); path.lineTo(s * 0.05f, 0);
                    canvas.drawPath(path, paint);
                    break;
                case SPARK:
                    path.moveTo(0, -s * 0.95f); path.lineTo(s * 0.25f, -s * 0.25f);
                    path.lineTo(s * 0.95f, 0); path.lineTo(s * 0.25f, s * 0.25f);
                    path.lineTo(0, s * 0.95f); path.lineTo(-s * 0.25f, s * 0.25f);
                    path.lineTo(-s * 0.95f, 0); path.lineTo(-s * 0.25f, -s * 0.25f);
                    path.close();
                    canvas.drawPath(path, paint);
                    break;
                case TRASH:
                    path.moveTo(-s * 0.7f, -s * 0.55f); path.lineTo(s * 0.7f, -s * 0.55f);
                    path.moveTo(-s * 0.28f, -s * 0.55f); path.lineTo(-s * 0.28f, -s * 0.9f);
                    path.lineTo(s * 0.28f, -s * 0.9f); path.lineTo(s * 0.28f, -s * 0.55f);
                    path.moveTo(-s * 0.5f, -s * 0.55f); path.lineTo(-s * 0.4f, s * 0.9f);
                    path.lineTo(s * 0.4f, s * 0.9f); path.lineTo(s * 0.5f, -s * 0.55f);
                    canvas.drawPath(path, paint);
                    break;
                case COPY:
                    canvas.drawRoundRect(-s * 0.75f, -s * 0.45f, s * 0.35f, s * 0.9f,
                            s * 0.12f, s * 0.12f, paint);
                    path.moveTo(-s * 0.2f, -s * 0.75f); path.lineTo(s * 0.75f, -s * 0.75f);
                    path.lineTo(s * 0.75f, s * 0.4f);
                    canvas.drawPath(path, paint);
                    break;
                case INFO:
                default:
                    canvas.drawCircle(0, 0, s * 0.92f, paint);
                    paint.setStyle(Paint.Style.FILL);
                    canvas.drawCircle(0, -s * 0.5f, s * 0.12f, paint);
                    paint.setStyle(Paint.Style.STROKE);
                    path.moveTo(0, -s * 0.15f); path.lineTo(0, s * 0.55f);
                    canvas.drawPath(path, paint);
                    break;
            }
            canvas.restore();
        }
    }

    public static IconView icon(Context context, Glyph glyph, int color, int sizeDp) {
        IconView view = new IconView(context, glyph, color);
        view.setLayoutParams(new LinearLayout.LayoutParams(dp(context, sizeDp), dp(context, sizeDp)));
        return view;
    }

    /** Circular ripple icon button with an accessible description. */
    public static FrameLayout iconButton(Context context, Glyph glyph, String description, int color,
            View.OnClickListener action) {
        FrameLayout button = new FrameLayout(context);
        int size = dp(context, 44);
        button.setLayoutParams(new LinearLayout.LayoutParams(size, size));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(0x1A0F172A),
                null, shape(context, WHITE, 22)));
        IconView view = new IconView(context, glyph, color);
        int iconSize = dp(context, 20);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(iconSize, iconSize);
        params.gravity = Gravity.CENTER;
        button.addView(view, params);
        button.setContentDescription(description);
        button.setOnClickListener(v -> { haptic(v); action.onClick(v); });
        pressable(button);
        return button;
    }

    // ── Cards, chips, avatars ──────────────────────────────────────────────────────────────
    public static TextView chip(Context context, String label, boolean selected, View.OnClickListener action) {
        TextView chip = styled(context, label, 11.5f, selected ? WHITE : MUTED, MEDIUM);
        int padH = dp(context, 10);
        chip.setPadding(padH, dp(context, 5), padH, dp(context, 5));
        Drawable background = selected ? gradient(context, 999, ACCENT, ACCENT_2)
                : shape(context, SURFACE_SOFT, 999, true);
        chip.setBackground(new RippleDrawable(ColorStateList.valueOf(0x22FFFFFF), background, null));
        if (action != null) chip.setOnClickListener(action);
        return chip;
    }

    public static LinearLayout avatar(Context context, String initial, int color, int sizeDp) {
        LinearLayout holder = new LinearLayout(context);
        holder.setGravity(Gravity.CENTER);
        holder.setBackground(shape(context, (color & 0x00FFFFFF) | 0x1F000000, sizeDp / 2));
        holder.addView(styled(context, initial, 15, color, MEDIUM));
        holder.setLayoutParams(new LinearLayout.LayoutParams(dp(context, sizeDp), dp(context, sizeDp)));
        return holder;
    }

    // ── Buttons ────────────────────────────────────────────────────────────────────────────
    public static Button button(Context context, String label, View.OnClickListener action) {
        return baseButton(context, label, action, shape(context, WHITE, RADIUS_BUTTON, true), INK);
    }

    public static Button primary(Context context, String label, View.OnClickListener action) {
        Button view = baseButton(context, label, action,
                new RippleDrawable(ColorStateList.valueOf(0x33FFFFFF),
                        gradient(context, RADIUS_BUTTON, ACCENT, ACCENT_2), null), WHITE);
        view.setElevation(dp(context, 2f));
        return view;
    }

    public static Button tonal(Context context, String label, View.OnClickListener action) {
        return baseButton(context, label, action,
                new RippleDrawable(ColorStateList.valueOf(0x220F172A), shape(context, ACCENT_SOFT, RADIUS_BUTTON), null),
                ACCENT_DEEP);
    }

    public static Button ghost(Context context, String label, View.OnClickListener action) {
        return baseButton(context, label, action,
                new RippleDrawable(ColorStateList.valueOf(0x140F172A), null, null), ACCENT);
    }

    public static Button danger(Context context, String label, View.OnClickListener action) {
        return baseButton(context, label, action,
                new RippleDrawable(ColorStateList.valueOf(0x22FFFFFF), shape(context, DANGER, RADIUS_BUTTON), null),
                WHITE);
    }

    private static Button baseButton(Context context, String label, View.OnClickListener action,
            Drawable background, int textColor) {
        Button view = new Button(context);
        view.setText(label);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        view.setAllCaps(false);
        view.setTypeface(MEDIUM);
        view.setLetterSpacing(0.01f);
        view.setTextColor(new ColorStateList(new int[][]{new int[]{-android.R.attr.state_enabled}, new int[]{}},
                new int[]{0xFF98A2B3, textColor}));
        view.setMinHeight(dp(context, 50));
        view.setMinimumHeight(dp(context, 50));
        view.setMinWidth(0);
        view.setMinimumWidth(0);
        int padH = dp(context, 18);
        view.setPadding(padH, dp(context, 10), padH, dp(context, 10));
        view.setStateListAnimator(null);
        view.setElevation(0);
        view.setBackground(background);
        view.setOnClickListener(v -> {
            haptic(v);
            if (action != null) action.onClick(v);
        });
        pressable(view);
        return view;
    }

    // ── Inputs ─────────────────────────────────────────────────────────────────────────────
    public static EditText field(Context context, LinearLayout parent, String label, String value) {
        return field(context, parent, label, value, 0, null);
    }

    /** Field with an explicit IME action; `action` (nullable) runs when the keyboard commits. */
    public static EditText field(Context context, LinearLayout parent, String label, String value,
            int imeAction, android.widget.TextView.OnEditorActionListener action) {
        TextView heading = styled(context, label, 12.5f, MUTED, MEDIUM);
        heading.setLetterSpacing(0.02f);
        LinearLayout.LayoutParams title = new LinearLayout.LayoutParams(-1, -2);
        title.topMargin = dp(context, 14);
        parent.addView(heading, title);
        EditText input = new EditText(context);
        input.setSingleLine(true);
        input.setText(value);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f);
        input.setTextColor(INK);
        input.setHintTextColor(FAINT);
        input.setTypeface(REGULAR);
        input.setMinHeight(dp(context, 52));
        input.setPadding(dp(context, 16), dp(context, 12), dp(context, 16), dp(context, 12));
        input.setBackground(new RippleDrawable(ColorStateList.valueOf(0x0F0F172A),
                shape(context, SURFACE_SOFT, RADIUS_FIELD, true), null));
        input.setSelectAllOnFocus(true);
        input.setContentDescription(label);
        if (imeAction != 0) {
            input.setImeOptions(imeAction);
            if (action != null) input.setOnEditorActionListener(action);
        }
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(context, 7);
        parent.addView(input, params);
        return input;
    }

    public static EditText searchField(Context context) {
        EditText input = new EditText(context);
        input.setSingleLine(true);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        input.setTextColor(INK);
        input.setHintTextColor(FAINT);
        input.setBackground(null);
        input.setPadding(0, 0, 0, 0);
        input.setContentDescription("搜索环境或代理");
        return input;
    }

    public static LinearLayout searchSurface(Context context, EditText input) {
        LinearLayout surface = row(context);
        surface.setBackground(shape(context, WHITE, RADIUS_FIELD, true));
        surface.setElevation(dp(context, 1f));
        surface.setPadding(dp(context, 14), 0, dp(context, 14), 0);
        IconView leading = new IconView(context, Glyph.SEARCH, FAINT);
        leading.setLayoutParams(new LinearLayout.LayoutParams(dp(context, 18), dp(context, 18)));
        surface.addView(leading);
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(0, dp(context, 50), 1f);
        inputParams.leftMargin = dp(context, 10);
        surface.addView(input, inputParams);
        FrameLayout clear = iconButton(context, Glyph.CLOSE, "清空搜索", FAINT,
                v -> input.setText(""));
        clear.setVisibility(View.GONE);
        surface.addView(clear, new LinearLayout.LayoutParams(dp(context, 34), dp(context, 34)));
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
                clear.setVisibility(s.length() == 0 ? View.GONE : View.VISIBLE);
            }
            @Override public void afterTextChanged(Editable s) { }
        });
        return surface;
    }

    // ── Segmented control with a sliding indicator ─────────────────────────────────────────
    public interface SegmentListener { void onSegment(int index); }

    public static FrameLayout segmented(Context context, String[] labels, int[] counts, int selected,
            SegmentListener listener) {
        FrameLayout holder = new FrameLayout(context);
        holder.setBackground(shape(context, BG_DEEP, 16));
        int pad = dp(context, 4);
        holder.setPadding(pad, pad, pad, pad);
        final View indicator = new View(context);
        indicator.setBackground(gradient(context, 13, ACCENT, ACCENT_2));
        indicator.setElevation(dp(context, 1.5f));
        holder.addView(indicator, new FrameLayout.LayoutParams(0, dp(context, 42)));
        LinearLayout tabs = row(context);
        tabs.setElevation(dp(context, 2f));
        holder.addView(tabs, new FrameLayout.LayoutParams(-1, dp(context, 42)));
        final TextView[] views = new TextView[labels.length];
        for (int i = 0; i < labels.length; i++) {
            final int index = i;
            String text = labels[i] + (counts != null && counts[i] >= 0 ? "  " + counts[i] : "");
            TextView tab = styled(context, text, 13.5f, i == selected ? WHITE : MUTED, MEDIUM);
            tab.setTag(labels[i]);
            tab.setGravity(Gravity.CENTER);
            tab.setSingleLine(true);
            tab.setEllipsize(android.text.TextUtils.TruncateAt.END);
            tab.setPadding(dp(context, 6), 0, dp(context, 6), 0);
            tab.setLayoutParams(new LinearLayout.LayoutParams(0, -1, 1f));
            tab.setOnClickListener(v -> {
                haptic(v);
                listener.onSegment(index);
            });
            pressable(tab);
            views[i] = tab;
            tabs.addView(tab);
        }
        final int initial = selected;
        Runnable layout = () -> {
            int width = (holder.getWidth() - pad * 2) / labels.length;
            if (width <= 0) return;
            FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) indicator.getLayoutParams();
            params.width = width;
            indicator.setLayoutParams(params);
            indicator.setTranslationX(pad + width * initial);
        };
        holder.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> layout.run());
        holder.post(layout);
        holder.setTag(new Object[]{indicator, views});
        return holder;
    }

    public static void selectSegment(FrameLayout segmented, int index, int[] counts) {
        Object tag = segmented.getTag();
        if (!(tag instanceof Object[])) return;
        Object[] state = (Object[]) tag;
        View indicator = (View) state[0];
        TextView[] views = (TextView[]) state[1];
        if (index < 0 || index >= views.length) return;
        int pad = segmented.getPaddingLeft();
        int width = (segmented.getWidth() - pad * 2) / views.length;
        if (width > 0) {
            FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) indicator.getLayoutParams();
            params.width = width;
            indicator.setLayoutParams(params);
            indicator.animate().translationX(pad + width * index)
                    .setDuration(220).setInterpolator(EASE).start();
        }
        for (int i = 0; i < views.length; i++) {
            views[i].setTextColor(i == index ? WHITE : MUTED);
            if (counts != null && i < counts.length) {
                String base = String.valueOf(views[i].getTag());
                views[i].setText(counts[i] >= 0 ? base + "  " + counts[i] : base);
            }
        }
    }

    // ── Sheet (bottom-anchored dialog) ─────────────────────────────────────────────────────
    /** Rounded top sheet with a drag handle, header, scroll body and sticky footer actions. */
    public static final class Sheet {
        private final Activity activity;
        private final Dialog dialog;
        private final LinearLayout body;
        private final LinearLayout footer;
        private TextView lastText;

        private Sheet(Activity activity, String title, String subtitle) {
            this.activity = activity;
            dialog = new Dialog(activity);
            dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
            Window window = dialog.getWindow();
            if (window != null) {
                window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
                window.setDimAmount(0.32f);
                window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            }
            LinearLayout panel = column(activity);
            GradientDrawable background = new GradientDrawable();
            background.setColor(WHITE);
            float radius = Ui.dp(activity, 28);
            background.setCornerRadii(new float[]{radius, radius, radius, radius, 0, 0, 0, 0});
            panel.setBackground(background);
            int padH = Ui.dp(activity, 20);
            panel.setPadding(padH, Ui.dp(activity, 10), padH, Ui.dp(activity, 16));

            View handle = new View(activity);
            GradientDrawable handleBackground = new GradientDrawable();
            // Derived from the mode: a fixed light gray is invisible on the night panel.
            handleBackground.setColor(DARK ? 0xFF3A4152 : 0xFFD8DCE6);
            handleBackground.setCornerRadius(Ui.dp(activity, 3));
            handle.setBackground(handleBackground);
            LinearLayout.LayoutParams handleParams = new LinearLayout.LayoutParams(
                    Ui.dp(activity, 40), Ui.dp(activity, 4.5f));
            handleParams.gravity = Gravity.CENTER_HORIZONTAL;
            panel.addView(handle, handleParams);

            LinearLayout header = column(activity);
            LinearLayout.LayoutParams headerParams = new LinearLayout.LayoutParams(-1, -2);
            headerParams.topMargin = Ui.dp(activity, 16);
            panel.addView(header, headerParams);
            if (title != null) {
                TextView heading = styled(activity, title, 20, INK, MEDIUM);
                heading.setLetterSpacing(-0.02f);
                header.addView(heading);
            }
            if (subtitle != null && !subtitle.isEmpty()) {
                TextView sub = caption(activity, subtitle);
                LinearLayout.LayoutParams subParams = new LinearLayout.LayoutParams(-1, -2);
                subParams.topMargin = Ui.dp(activity, 6);
                header.addView(sub, subParams);
            }

            body = column(activity);
            LinearLayout.LayoutParams bodyParams = new LinearLayout.LayoutParams(-1, -2);
            bodyParams.topMargin = Ui.dp(activity, 16);
            panel.addView(body, bodyParams);
            footer = row(activity);
            LinearLayout.LayoutParams footerParams = new LinearLayout.LayoutParams(-1, -2);
            footerParams.topMargin = Ui.dp(activity, 18);
            panel.addView(footer, footerParams);

            ScrollView scroll = new ScrollView(activity);
            scroll.setFillViewport(true);
            scroll.addView(panel);
            FrameLayout shell = new FrameLayout(activity);
            shell.setPadding(Ui.dp(activity, 8), Ui.dp(activity, 16), Ui.dp(activity, 8), 0);
            shell.addView(scroll, new FrameLayout.LayoutParams(-1, -2));
            dialog.setContentView(shell);
            dialog.setCancelable(true);
            dialog.setCanceledOnTouchOutside(true);
        }

        public static Sheet create(Activity activity, String title, String subtitle) {
            return new Sheet(activity, title, subtitle);
        }

        public Sheet content(View view) {
            body.addView(view, new LinearLayout.LayoutParams(-1, -2));
            return this;
        }

        public Sheet text(String value) {
            TextView view = Ui.body(activity, value);
            lastText = view;
            body.addView(view);
            return this;
        }

        /** Refresh the text added by text() while the sheet is open (live status, probe output). */
        public void updateText(String value) {
            if (lastText != null) lastText.setText(value);
        }

        public Sheet actions(String secondary, Runnable onSecondary, String primary, Runnable onPrimary) {
            footer.removeAllViews();
            if (secondary != null) {
                Button cancel = ghost(activity, secondary, v -> {
                    if (onSecondary != null) onSecondary.run();
                    else dialog.dismiss();
                });
                footer.addView(cancel, new LinearLayout.LayoutParams(0, dp(activity, 50), 1f));
            }
            if (primary != null) {
                Button save = primary(activity, primary, v -> {
                    if (onPrimary != null) onPrimary.run();
                    else dialog.dismiss();
                });
                LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(activity, 50),
                        secondary == null ? 1f : 1.25f);
                if (secondary != null) params.leftMargin = dp(activity, 10);
                footer.addView(save, params);
            }
            return this;
        }

        public Dialog dialog() { return dialog; }

        public void show() {
            dialog.show();
            Window window = dialog.getWindow();
            if (window != null) {
                window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                window.setGravity(Gravity.BOTTOM);
                View decor = window.getDecorView();
                decor.setTranslationY(Ui.dp(activity, 320));
                decor.animate().translationY(0f).setDuration(260).setInterpolator(EASE).start();
            }
        }
    }

    // ── Empty state ────────────────────────────────────────────────────────────────────────
    public static LinearLayout emptyState(Context context, String title, String body) {
        LinearLayout card = card(context);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        int pad = dp(context, 26);
        card.setPadding(pad, pad, pad, pad);
        Illustration art = new Illustration(context);
        LinearLayout.LayoutParams artParams = new LinearLayout.LayoutParams(dp(context, 96), dp(context, 96));
        artParams.gravity = Gravity.CENTER_HORIZONTAL;
        card.addView(art, artParams);
        TextView heading = styled(context, title, 18.5f, INK, MEDIUM);
        heading.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(-1, -2);
        headingParams.topMargin = dp(context, 16);
        card.addView(heading, headingParams);
        TextView text = styled(context, body, 13.5f, MUTED, REGULAR);
        text.setGravity(Gravity.CENTER);
        text.setLineSpacing(dp(context, 3), 1f);
        LinearLayout.LayoutParams textParams = new LinearLayout.LayoutParams(-1, -2);
        textParams.topMargin = dp(context, 8);
        card.addView(text, textParams);
        return card;
    }

    /** Abstract on-brand illustration drawn with vector primitives (no bitmap assets). */
    public static final class Illustration extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        public Illustration(Context context) {
            super(context);
        }

        @Override protected void onDraw(Canvas canvas) {
            float w = getWidth();
            float h = getHeight();
            float cx = w / 2f;
            float cy = h / 2f;
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(0x0F4F46E5);
            canvas.drawCircle(cx, cy, w * 0.48f, paint);
            paint.setColor(0x1A4F46E5);
            canvas.drawCircle(cx, cy, w * 0.36f, paint);
            paint.setShader(new LinearGradient(0, 0, w, h, ACCENT, ACCENT_2, Shader.TileMode.CLAMP));
            canvas.drawCircle(cx, cy, w * 0.22f, paint);
            paint.setShader(null);
            paint.setColor(WHITE);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(dp(getContext(), 2f));
            Path path = new Path();
            path.moveTo(cx - w * 0.09f, cy);
            path.lineTo(cx - w * 0.02f, cy + w * 0.07f);
            path.lineTo(cx + w * 0.10f, cy - w * 0.07f);
            canvas.drawPath(path, paint);
        }
    }

    // ── Errors ─────────────────────────────────────────────────────────────────────────────
    public static String errorCode(RuntimeException failure) {
        if (failure instanceof ValidationException) return ((ValidationException) failure).code;
        if (failure instanceof StorageException) return ((StorageException) failure).code.name();
        return failure.getClass().getSimpleName();
    }

    public static String friendlyError(RuntimeException failure) {
        String code = errorCode(failure);
        switch (code) {
            case "PROFILE_ACTIVE": return "环境仍在运行，请先退出后再修改。";
            case "REVISION_CONFLICT": return "配置已被更新，请关闭编辑页后重新打开。";
            case "NAME_CONFLICT": return "名称已存在，请换一个名称。";
            case "PROXY_ENDPOINT_CONFLICT": return "这个代理地址已在列表中，可直接复用已有代理。";
            case "PROXY_IN_USE": return "代理仍被环境引用，请先为这些环境选择其他代理。";
            case "PROXY_NOT_FOUND": return "代理已被移除，请重新选择。";
            case "INVALID_COUNTRY": return "请输入有效的两位 ISO 地区代码，或留空。";
            case "INVALID_TIME_ZONE": return "请选择有效的 IANA 时区，例如 Asia/Shanghai。";
            case "INVALID_LANGUAGE_TAG": return "请检查语言标签格式，例如 zh-CN,en-US。";
            case "DUPLICATE_LANGUAGE_TAG": return "语言列表包含重复项，请删除重复标签。";
            case "INVALID_HOST": return "请输入有效的主机名或 IP，不包含协议、路径或凭据。";
            case "CONTROL_CHARACTER": return "输入不能含换行或其他控制字符。";
            case "PROXY_AUTH_UNSUPPORTED": return "当前内核不支持用户名/密码代理，请使用无认证端点。";
            default: return "未完成操作（" + code + "），原有配置未被替换。";
        }
    }
}
