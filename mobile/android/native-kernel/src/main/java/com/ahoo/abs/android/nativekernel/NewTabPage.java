package com.ahoo.abs.android.nativekernel;

import android.app.Dialog;
import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.List;
import java.util.Locale;

/**
 * Native new-tab surface shown over the ShellManager while the active WebContents is still
 * blank. Built entirely from framework widgets (no XML resources, no AndroidX) in the
 * activity's live theme. The Activity omnibox owns all search input and keyboard state.
 * Tiles come from the real per-profile history store — nothing is preseeded.
 */
final class NewTabPage extends FrameLayout {
    // Palette resolved from the activity's night mode (NativeBrowserActivity.resolvePalette).
    private int PAGE;
    private int CARD;
    private int INK;
    private int MUTED;
    private int ACCENT;
    private int ACCENT_SOFT;
    private int STROKE;
    private int RIPPLE;
    private final NativeBrowserActivity.PaletteBindings staticPaletteBindings =
            new NativeBrowserActivity.PaletteBindings();
    private final NativeBrowserActivity.PaletteBindings tilePaletteBindings =
            new NativeBrowserActivity.PaletteBindings();
    private final NativeBrowserActivity.FontBindings staticFonts = new NativeBrowserActivity.FontBindings();
    private final NativeBrowserActivity.FontBindings tileFonts = new NativeBrowserActivity.FontBindings();
    private static final int MAX_TILES = 9;

    /** Actions the activity performs on behalf of the new-tab page. */
    interface Listener {
        void onNtpNavigate(String url);

        void onNtpOpenHistory();
    }

    private final BrowserHistoryStore store;
    private final Listener listener;
    private final LinearLayout tiles;
    private final View emptyState;
    private Dialog removalDialog;
    private boolean quiescing;

    NewTabPage(Context context, BrowserHistoryStore store, String profileName, Listener listener) {
        super(context);
        readPalette();

        this.store = store;
        this.listener = listener;
        GradientDrawable pageBackground = new GradientDrawable();
        setBackground(pageBackground);
        staticPaletteBindings.add(() -> pageBackground.setColor(PAGE));
        // Consume taps over the blank WebContents without taking focus from the toolbar.
        setClickable(true);

        ScrollView scroll = new ScrollView(context);
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        addView(scroll, new FrameLayout.LayoutParams(-1, -1));

        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        int side = dp(18);
        column.setPadding(side, dp(20), side, dp(28));
        scroll.addView(column, new FrameLayout.LayoutParams(-1, -2));

        column.addView(buildIdentityRow(context, profileName));
        // The single History action remains reachable even before the first visit.
        column.addView(buildSectionRow(context));
        tiles = new LinearLayout(context);
        tiles.setOrientation(LinearLayout.VERTICAL);
        column.addView(tiles, new LinearLayout.LayoutParams(-1, -2));
        emptyState = buildEmptyState(context);
        column.addView(emptyState);

        TextView footer = new TextView(context);
        footer.setText("长按站点可移除 · 历史记录仅保存在本设备的当前环境，不会上传");
        staticFonts.bind(footer, 11);
        staticPaletteBindings.add(() -> footer.setTextColor(MUTED));
        footer.setGravity(Gravity.CENTER);
        column.addView(footer, new LinearLayout.LayoutParams(-1, -2));

        setVisibility(View.GONE);
    }

    private void readPalette() {
        PAGE = NativeBrowserActivity.C_CANVAS;
        CARD = NativeBrowserActivity.C_SURFACE; INK = NativeBrowserActivity.C_INK;
        MUTED = NativeBrowserActivity.C_MUTED; ACCENT = NativeBrowserActivity.C_ACCENT;
        ACCENT_SOFT = NativeBrowserActivity.C_ACCENT_SOFT; STROKE = NativeBrowserActivity.C_STROKE;
        RIPPLE = NativeBrowserActivity.C_RIPPLE;
    }

    /** Recolors the existing surface and dialogs without rebuilding content. */
    void applyPalette() {
        readPalette();
        staticPaletteBindings.apply();
        tilePaletteBindings.apply();
        if (removalDialog != null) BrowserDialogs.applyPalette(removalDialog);
    }

    /** Rebind existing text without rebuilding tiles or changing scroll/focus state. */
    void applyFontScale() {
        if (quiescing) return;
        staticFonts.apply();
        tileFonts.apply();
        if (removalDialog != null) BrowserDialogs.applyFontScale(removalDialog);
    }

    private LinearLayout buildIdentityRow(Context context, String profileName) {
        String name = profileName == null || profileName.trim().isEmpty() ? "默认环境" : profileName.trim();
        LinearLayout header = new LinearLayout(context);
        header.setOrientation(LinearLayout.VERTICAL);

        TextView title = new TextView(context);
        title.setText(name);
        staticFonts.bind(title, 17);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        staticPaletteBindings.add(() -> title.setTextColor(INK));
        title.setSingleLine(false);
        header.addView(title, new LinearLayout.LayoutParams(-1, -2));

        TextView hint = new TextView(context);
        hint.setText("历史记录按环境隔离");
        staticFonts.bind(hint, 12.5f);
        staticPaletteBindings.add(() -> hint.setTextColor(MUTED));
        LinearLayout.LayoutParams hintLayout = new LinearLayout.LayoutParams(-1, -2);
        hintLayout.setMargins(0, dp(4), 0, 0);
        header.addView(hint, hintLayout);
        return header;
    }

    private LinearLayout buildSectionRow(Context context) {
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams rowLayout = new LinearLayout.LayoutParams(-1, -2);
        rowLayout.setMargins(0, dp(20), 0, dp(8));
        row.setLayoutParams(rowLayout);

        TextView section = new TextView(context);
        section.setText("最近访问");
        staticFonts.bind(section, 17);
        section.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        staticPaletteBindings.add(() -> section.setTextColor(INK));
        row.addView(section, new LinearLayout.LayoutParams(0, -2, 1));

        TextView all = new TextView(context);
        all.setText("全部");
        all.setContentDescription("历史记录");
        staticFonts.bind(all, 14);
        staticPaletteBindings.add(() -> all.setTextColor(ACCENT));
        all.setMinimumWidth(dp(48));
        all.setMinimumHeight(dp(48));
        all.setPadding(dp(12), dp(8), dp(12), dp(8));
        all.setGravity(Gravity.CENTER);
        GradientDrawable historyMask = rounded(CARD, 12);
        android.graphics.drawable.RippleDrawable historyRipple = new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(RIPPLE), null, historyMask);
        all.setBackground(historyRipple);
        staticPaletteBindings.add(() -> {
            historyRipple.setColor(android.content.res.ColorStateList.valueOf(RIPPLE));
            historyMask.setColor(CARD);
        });
        all.setOnClickListener(view -> {
            if (quiescing) return;
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            listener.onNtpOpenHistory();
        });
        row.addView(all, new LinearLayout.LayoutParams(-2, -2));
        return row;
    }

    private LinearLayout buildEmptyState(Context context) {
        LinearLayout empty = new LinearLayout(context);
        empty.setOrientation(LinearLayout.VERTICAL);
        empty.setPadding(0, dp(20), 0, dp(24));

        TextView title = new TextView(context);
        title.setText("还没有浏览记录");
        staticFonts.bind(title, 16);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        staticPaletteBindings.add(() -> title.setTextColor(INK));
        empty.addView(title, new LinearLayout.LayoutParams(-1, -2));

        TextView body = new TextView(context);
        body.setText("使用顶部地址栏搜索或输入网址，访问过的站点会显示在这里。");
        staticFonts.bind(body, 13.5f);
        staticPaletteBindings.add(() -> body.setTextColor(MUTED));
        body.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams bodyLayout = new LinearLayout.LayoutParams(-1, -2);
        bodyLayout.setMargins(0, dp(8), 0, 0);
        empty.addView(body, bodyLayout);
        empty.setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
        return empty;
    }

    /** Called by the activity right after the overlay becomes visible; rebuilds the tiles. */
    void onShown() {
        if (quiescing) return;
        if (getVisibility() != View.VISIBLE) {
            setVisibility(View.VISIBLE);
            refresh();
        }
    }

    /** Rebuilds tiles after a history mutation (removal, clear) while the page is visible. */
    void refresh() {
        if (quiescing) return;
        List<BrowserHistory.SiteVisit> ranked = store.ranked();
        boolean empty = ranked.isEmpty();
        emptyState.setVisibility(empty ? View.VISIBLE : View.GONE);
        tilePaletteBindings.clear();
        tileFonts.clear();
        tiles.removeAllViews();
        if (empty) return;
        int shown = Math.min(ranked.size(), MAX_TILES);
        for (int start = 0; start < shown; start += 3) {
            LinearLayout row = new LinearLayout(getContext());
            row.setOrientation(LinearLayout.HORIZONTAL);
            int end = Math.min(start + 3, shown);
            for (int i = start; i < end; i++) {
                row.addView(makeTile(ranked.get(i)));
            }
            for (int pad = end; pad < start + 3; pad++) {
                row.addView(new View(getContext()), tileLayout());
            }
            LinearLayout.LayoutParams rowLayout = new LinearLayout.LayoutParams(-1, -2);
            rowLayout.setMargins(0, 0, 0, dp(10));
            tiles.addView(row, rowLayout);
        }
    }

    private static LinearLayout.LayoutParams tileLayout() {
        return new LinearLayout.LayoutParams(0, -2, 1);
    }

    private LinearLayout makeTile(final BrowserHistory.SiteVisit visit) {
        Context context = getContext();
        final String host = displayHostFor(visit.origin);
        LinearLayout tile = new LinearLayout(context);
        tile.setOrientation(LinearLayout.VERTICAL);
        tile.setGravity(Gravity.CENTER_HORIZONTAL);
        GradientDrawable tileBackground = stroked(CARD, 14);
        tile.setBackground(tileBackground);
        tilePaletteBindings.add(() -> {
            tileBackground.setColor(CARD);
            tileBackground.setStroke(dp(1), STROKE);
        });
        GradientDrawable rippleMask = rounded(CARD, 14);
        android.graphics.drawable.RippleDrawable ripple = new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(RIPPLE), null, rippleMask);
        tile.setForeground(ripple);
        tilePaletteBindings.add(() -> {
            ripple.setColor(android.content.res.ColorStateList.valueOf(RIPPLE));
            rippleMask.setColor(CARD);
        });
        tile.setPadding(dp(10), dp(14), dp(10), dp(14));
        LinearLayout.LayoutParams tileLayout = new LinearLayout.LayoutParams(0, -2, 1);
        tileLayout.setMargins(dp(5), 0, dp(5), 0);
        tile.setLayoutParams(tileLayout);
        tile.setMinimumHeight(dp(88));
        tile.setOnClickListener(view -> {
            if (quiescing) return;
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            listener.onNtpNavigate(visit.origin);
        });
        tile.setOnLongClickListener(view -> {
            confirmRemove(visit, host);
            return true;
        });

        TextView avatar = new TextView(context);
        avatar.setText(firstLetter(host));
        tileFonts.bind(avatar, 16);
        avatar.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        tilePaletteBindings.add(() -> avatar.setTextColor(ACCENT));
        avatar.setGravity(Gravity.CENTER);
        GradientDrawable avatarBackground = rounded(ACCENT_SOFT, 14);
        avatar.setBackground(avatarBackground);
        tilePaletteBindings.add(() -> avatarBackground.setColor(ACCENT_SOFT));
        tile.addView(avatar, new LinearLayout.LayoutParams(dp(42), dp(42)));

        TextView name = new TextView(context);
        name.setText(host);
        tileFonts.bind(name, 12.5f);
        name.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        tilePaletteBindings.add(() -> name.setTextColor(INK));
        name.setSingleLine(true);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        name.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams nameLayout = new LinearLayout.LayoutParams(-1, -2);
        nameLayout.setMargins(dp(2), dp(8), dp(2), 0);
        tile.addView(name, nameLayout);

        TextView meta = new TextView(context);
        meta.setText(relativeTimeFor(visit.lastVisitMillis) + " · " + visit.visitCount + " 次");
        tileFonts.bind(meta, 10.5f);
        tilePaletteBindings.add(() -> meta.setTextColor(MUTED));
        meta.setSingleLine(false);
        meta.setGravity(Gravity.CENTER);
        tile.addView(meta, new LinearLayout.LayoutParams(-1, -2));
        return tile;
    }

    void dismissDialogs() {
        if (removalDialog != null) removalDialog.dismiss();
    }

    void quiesce() {
        quiescing = true;
        dismissDialogs();
    }

    private void confirmRemove(final BrowserHistory.SiteVisit visit, String host) {
        if (quiescing) return;
        dismissDialogs();
        Dialog pending = BrowserDialogs.confirm(getContext(), "移除该站点？",
                "将从历史记录中移除 " + host + "；只删除记录，不影响该网站的数据。", "移除", () -> {
                    if (quiescing) return;
                    store.removeSite(visit.origin);
                    refresh();
                    Toast.makeText(getContext(), "已从历史记录中移除", Toast.LENGTH_SHORT).show();
                });
        removalDialog = pending;
        pending.setOnDismissListener(dialog -> {
            if (removalDialog == pending) removalDialog = null;
        });
    }

    /** Host label for an origin: scheme and credentials dropped, leading www. removed. */
    static String displayHostFor(String origin) {
        String host = origin;
        int scheme = host.indexOf("://");
        if (scheme >= 0) host = host.substring(scheme + 3);
        if (host.startsWith("www.") && host.length() > 4) host = host.substring(4);
        return host;
    }

    private static String firstLetter(String host) {
        if (host == null || host.isEmpty()) return "•";
        char first = host.charAt(0);
        return Character.toUpperCase(first) + "";
    }

    /** Compact Chinese relative timestamp shared with the history list rows. */
    static String relativeTimeFor(long then) {
        long delta = System.currentTimeMillis() - then;
        if (delta < 0) delta = 0;
        if (delta < 60000L) return "刚刚";
        if (delta < 3600000L) return (delta / 60000L) + " 分钟前";
        if (delta < 86400000L) return (delta / 3600000L) + " 小时前";
        if (delta < 2 * 86400000L) return "昨天";
        if (delta < 7 * 86400000L) return (delta / 86400000L) + " 天前";
        return new java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US)
                .format(new java.util.Date(then));
    }

    private int dp(float value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    private GradientDrawable rounded(int color, float radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        return drawable;
    }

    private GradientDrawable stroked(int color, float radiusDp) {
        GradientDrawable drawable = rounded(color, radiusDp);
        drawable.setShape(GradientDrawable.RECTANGLE);
        drawable.setStroke(dp(1), STROKE);
        return drawable;
    }
}
