package com.ahoo.abs.android.nativekernel;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
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
 * manager's premium light theme. Tiles come from the real per-profile history store —
 * nothing is preseeded, and the empty state explains that sites appear after browsing.
 */
final class NewTabPage extends FrameLayout {
    // Palette resolved from the activity's night mode (NativeBrowserActivity.resolvePalette).
    private int PAGE;
    private int PAGE_TOP;
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
    private final EditText search;
    private final LinearLayout tiles;
    private final View sectionRow;
    private final View emptyCard;
    private Dialog removalDialog;
    private boolean quiescing;

    NewTabPage(Context context, BrowserHistoryStore store, String profileName, Listener listener) {
        super(context);
        readPalette();

        this.store = store;
        this.listener = listener;
        search = new EditText(context);
        GradientDrawable pageBackground = new GradientDrawable();
        pageBackground.setOrientation(GradientDrawable.Orientation.TOP_BOTTOM);
        setBackground(pageBackground);
        staticPaletteBindings.add(() -> pageBackground.setColors(new int[]{PAGE_TOP, PAGE}));
        setClickable(true);
        setDescendantFocusability(FOCUS_BEFORE_DESCENDANTS);
        setFocusableInTouchMode(true);

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
        column.addView(buildSearchCard(context));
        sectionRow = buildSectionRow(context);
        column.addView(sectionRow);
        tiles = new LinearLayout(context);
        tiles.setOrientation(LinearLayout.VERTICAL);
        column.addView(tiles, new LinearLayout.LayoutParams(-1, -2));
        emptyCard = buildEmptyCard(context);
        column.addView(emptyCard);

        TextView footer = new TextView(context);
        footer.setText("长按站点可移除 · 历史记录仅保存在本设备的当前环境，不会上传");
        staticFonts.bind(footer, 11);
        staticPaletteBindings.add(() -> footer.setTextColor(MUTED));
        footer.setGravity(Gravity.CENTER);
        column.addView(footer, new LinearLayout.LayoutParams(-1, -2));

        setVisibility(View.GONE);
    }

    private void readPalette() {
        PAGE = NativeBrowserActivity.C_CANVAS; PAGE_TOP = NativeBrowserActivity.C_TILE_TOP;
        CARD = NativeBrowserActivity.C_SURFACE; INK = NativeBrowserActivity.C_INK;
        MUTED = NativeBrowserActivity.C_MUTED; ACCENT = NativeBrowserActivity.C_ACCENT;
        ACCENT_SOFT = NativeBrowserActivity.C_ACCENT_SOFT; STROKE = NativeBrowserActivity.C_STROKE;
        RIPPLE = NativeBrowserActivity.C_RIPPLE;
    }

    /** Recolors the existing surface and dialogs without rebuilding content or input. */
    void applyPalette() {
        readPalette();
        staticPaletteBindings.apply();
        tilePaletteBindings.apply();
        if (removalDialog != null) BrowserDialogs.applyPalette(removalDialog);
    }

    /** Rebind existing text without rebuilding tiles or changing the search draft. */
    void applyFontScale() {
        if (quiescing) return;
        staticFonts.apply();
        tileFonts.apply();
        if (removalDialog != null) BrowserDialogs.applyFontScale(removalDialog);
    }

    private LinearLayout buildIdentityRow(Context context, String profileName) {
        String name = profileName == null || profileName.trim().isEmpty() ? "默认环境" : profileName.trim();
        // Keep identity and navigation on independent lines at every font size.
        LinearLayout header = new LinearLayout(context);
        header.setOrientation(LinearLayout.VERTICAL);
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        TextView avatar = new TextView(context);
        avatar.setText(new String(Character.toChars(name.codePointAt(0))).toUpperCase(Locale.ROOT));
        staticFonts.bind(avatar, 17);
        avatar.setTypeface(Typeface.DEFAULT_BOLD);
        staticPaletteBindings.add(() -> avatar.setTextColor(ACCENT));
        avatar.setGravity(Gravity.CENTER);
        GradientDrawable disc = new GradientDrawable();
        disc.setShape(GradientDrawable.OVAL);
        staticPaletteBindings.add(() -> disc.setColor((ACCENT & 0x00FFFFFF) | 0x1A000000));
        avatar.setBackground(disc);
        row.addView(avatar, new LinearLayout.LayoutParams(dp(44), dp(44)));

        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(context);
        title.setText(name);
        staticFonts.bind(title, 17);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        staticPaletteBindings.add(() -> title.setTextColor(INK));
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        column.addView(title, new LinearLayout.LayoutParams(-2, -2));
        TextView hint = new TextView(context);
        hint.setText("历史记录按环境隔离");
        staticFonts.bind(hint, 12.5f);
        staticPaletteBindings.add(() -> hint.setTextColor(MUTED));
        column.addView(hint, new LinearLayout.LayoutParams(-2, -2));
        LinearLayout.LayoutParams columnLayout = new LinearLayout.LayoutParams(0, -2, 1);
        columnLayout.setMargins(dp(12), 0, dp(8), 0);
        row.addView(column, columnLayout);

        TextView historyButton = new TextView(context);
        historyButton.setText("历史记录");
        staticFonts.bind(historyButton, 12.5f);
        historyButton.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        staticPaletteBindings.add(() -> historyButton.setTextColor(ACCENT));
        historyButton.setGravity(Gravity.CENTER);
        historyButton.setMinimumWidth(dp(48));
        historyButton.setMinimumHeight(dp(40));
        GradientDrawable historyButtonBackground = rounded(ACCENT_SOFT, 20);
        historyButton.setBackground(historyButtonBackground);
        staticPaletteBindings.add(() -> historyButtonBackground.setColor(ACCENT_SOFT));
        historyButton.setPadding(dp(14), 0, dp(14), 0);
        historyButton.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            if (!quiescing) listener.onNtpOpenHistory();
        });
        header.addView(row, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams historyLayout = new LinearLayout.LayoutParams(-2, -2);
        historyLayout.setMargins(0, dp(8), 0, 0);
        header.addView(historyButton, historyLayout);
        return header;
    }

    private LinearLayout buildSearchCard(Context context) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable cardBackground = stroked(CARD, 23);
        card.setBackground(cardBackground);
        staticPaletteBindings.add(() -> {
            cardBackground.setColor(CARD);
            cardBackground.setStroke(dp(1), STROKE);
        });
        card.setElevation(dp(1.5f));
        card.setPadding(dp(10), dp(8), dp(10), dp(8));
        LinearLayout.LayoutParams cardLayout = new LinearLayout.LayoutParams(-1, -2);
        cardLayout.setMargins(0, dp(20), 0, 0);
        card.setLayoutParams(cardLayout);

        search.setHint("搜索");
        search.setContentDescription("搜索或输入网址");
        staticPaletteBindings.add(() -> search.setHintTextColor(MUTED));
        staticPaletteBindings.add(() -> search.setTextColor(INK));
        staticFonts.bind(search, 15.5f);
        search.setSingleLine(true);
        search.setBackground(null);
        search.setImeOptions(EditorInfo.IME_ACTION_GO);
        search.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        search.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO
                    || (event != null && event.getKeyCode() == android.view.KeyEvent.KEYCODE_ENTER)) {
                submit();
                return true;
            }
            return false;
        });
        card.addView(search, new LinearLayout.LayoutParams(0, -2, 1));

        TextView go = new TextView(context);
        go.setText("前往");
        staticFonts.bind(go, 13.5f);
        go.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        staticPaletteBindings.add(() -> go.setTextColor(ACCENT));
        go.setGravity(Gravity.CENTER);
        go.setMinimumWidth(dp(56));
        go.setMinimumHeight(dp(40));
        GradientDrawable goBackground = rounded(ACCENT_SOFT, 20);
        go.setBackground(goBackground);
        staticPaletteBindings.add(() -> goBackground.setColor(ACCENT_SOFT));
        go.setPadding(dp(14), 0, dp(14), 0);
        go.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            submit();
        });
        card.addView(go, new LinearLayout.LayoutParams(-2, -2));
        return card;
    }

    private LinearLayout buildSectionRow(Context context) {
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams rowLayout = new LinearLayout.LayoutParams(-1, -2);
        rowLayout.setMargins(0, dp(26), 0, dp(12));
        row.setLayoutParams(rowLayout);

        TextView section = new TextView(context);
        section.setText("最近访问");
        staticFonts.bind(section, 17);
        section.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        staticPaletteBindings.add(() -> section.setTextColor(INK));
        row.addView(section, new LinearLayout.LayoutParams(0, -2, 1));

        TextView all = new TextView(context);
        all.setText("全部 ›");
        staticFonts.bind(all, 12.5f);
        staticPaletteBindings.add(() -> all.setTextColor(MUTED));
        all.setMinimumWidth(dp(48));
        all.setMinimumHeight(dp(40));
        all.setGravity(Gravity.CENTER);
        all.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            if (!quiescing) listener.onNtpOpenHistory();
        });
        row.addView(all, new LinearLayout.LayoutParams(-2, -2));
        return row;
    }

    private LinearLayout buildEmptyCard(Context context) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER);
        GradientDrawable cardBackground = stroked(CARD, 20);
        card.setBackground(cardBackground);
        staticPaletteBindings.add(() -> {
            cardBackground.setColor(CARD);
            cardBackground.setStroke(dp(1), STROKE);
        });
        card.setElevation(dp(1.5f));
        card.setPadding(dp(22), dp(30), dp(22), dp(30));

        TextView badge = new TextView(context);
        badge.setText("空");
        staticFonts.bind(badge, 20);
        badge.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        staticPaletteBindings.add(() -> badge.setTextColor(ACCENT));
        badge.setGravity(Gravity.CENTER);
        GradientDrawable disc = new GradientDrawable();
        disc.setShape(GradientDrawable.OVAL);
        staticPaletteBindings.add(() -> disc.setColor(ACCENT_SOFT));
        badge.setBackground(disc);
        card.addView(badge, new LinearLayout.LayoutParams(dp(56), dp(56)));

        TextView title = new TextView(context);
        title.setText("还没有浏览记录");
        staticFonts.bind(title, 16);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        staticPaletteBindings.add(() -> title.setTextColor(INK));
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleLayout = new LinearLayout.LayoutParams(-2, -2);
        titleLayout.setMargins(0, dp(14), 0, 0);
        card.addView(title, titleLayout);

        TextView body = new TextView(context);
        body.setText("正常浏览网页后，最近访问的站点\n会以卡片形式显示在这里");
        staticFonts.bind(body, 12.5f);
        staticPaletteBindings.add(() -> body.setTextColor(MUTED));
        body.setLineSpacing(dp(3), 1f);
        body.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams bodyLayout = new LinearLayout.LayoutParams(-2, -2);
        bodyLayout.setMargins(0, dp(6), 0, 0);
        card.addView(body, bodyLayout);
        LinearLayout.LayoutParams cardLayout = new LinearLayout.LayoutParams(-1, -2);
        cardLayout.setMargins(0, dp(8), 0, 0);
        card.setLayoutParams(cardLayout);
        return card;
    }

    /** Called by the activity right after the overlay becomes visible; rebuilds the tiles. */
    void onShown() {
        if (getVisibility() != View.VISIBLE) {
            setVisibility(View.VISIBLE);
            refresh();
        }
    }

    /** Rebuilds tiles after a history mutation (removal, clear) while the page is visible. */
    void refresh() {
        List<BrowserHistory.SiteVisit> ranked = store.ranked();
        boolean empty = ranked.isEmpty();
        sectionRow.setVisibility(empty ? View.GONE : View.VISIBLE);
        emptyCard.setVisibility(empty ? View.VISIBLE : View.GONE);
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
        GradientDrawable tileBackground = stroked(CARD, 18);
        tile.setBackground(tileBackground);
        tilePaletteBindings.add(() -> {
            tileBackground.setColor(CARD);
            tileBackground.setStroke(dp(1), STROKE);
        });
        tile.setElevation(dp(1.5f));
        GradientDrawable rippleMask = rounded(CARD, 18);
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
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            if (!quiescing) listener.onNtpNavigate(visit.origin);
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
        search.setEnabled(false);
        search.clearFocus();
        hideKeyboard();
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

    private void submit() {
        if (quiescing) return;
        String url = BrowserHistory.resolveInput(search.getText().toString());
        if (url == null) {
            Toast.makeText(getContext(), "暂不支持打开该类型的链接", Toast.LENGTH_SHORT).show();
            return;
        }
        search.setText("");
        search.clearFocus();
        hideKeyboard();
        listener.onNtpNavigate(url);
    }

    private void hideKeyboard() {
        InputMethodManager keyboard =
                (InputMethodManager) getContext().getSystemService(Activity.INPUT_METHOD_SERVICE);
        if (keyboard != null && getWindowToken() != null) {
            keyboard.hideSoftInputFromWindow(getWindowToken(), 0);
        }
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
