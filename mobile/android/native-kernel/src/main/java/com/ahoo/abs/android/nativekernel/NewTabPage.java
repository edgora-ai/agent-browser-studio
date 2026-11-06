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
    private final int PAGE;
    private final int PAGE_TOP;
    private final int CARD;
    private final int INK;
    private final int MUTED;
    private final int ACCENT;
    private final int ACCENT_SOFT;
    private final int STROKE;
    private static final int[] TILE_HUES = {0xFF4F46E5, 0xFF0D9488, 0xFFDB2777, 0xFFD97706,
            0xFF0284C7, 0xFF7C3AED, 0xFF059669, 0xFF64748B};
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
        PAGE = NativeBrowserActivity.C_CANVAS; PAGE_TOP = NativeBrowserActivity.C_TILE_TOP;
        CARD = NativeBrowserActivity.C_SURFACE; INK = NativeBrowserActivity.C_INK;
        MUTED = NativeBrowserActivity.C_MUTED; ACCENT = NativeBrowserActivity.C_ACCENT;
        ACCENT_SOFT = NativeBrowserActivity.C_ACCENT_SOFT; STROKE = NativeBrowserActivity.C_STROKE;

        this.store = store;
        this.listener = listener;
        search = new EditText(context);
        GradientDrawable pageBackground = new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM, new int[]{PAGE_TOP, PAGE});
        setBackground(pageBackground);
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
        footer.setTextSize(11);
        footer.setTextColor(MUTED);
        footer.setGravity(Gravity.CENTER);
        column.addView(footer, new LinearLayout.LayoutParams(-1, -2));

        setVisibility(View.GONE);
    }

    private LinearLayout buildIdentityRow(Context context, String profileName) {
        String name = profileName == null || profileName.trim().isEmpty() ? "默认环境" : profileName.trim();
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        TextView avatar = new TextView(context);
        avatar.setText(new String(Character.toChars(name.codePointAt(0))).toUpperCase(Locale.ROOT));
        avatar.setTextSize(17);
        avatar.setTypeface(Typeface.DEFAULT_BOLD);
        avatar.setTextColor(ACCENT);
        avatar.setGravity(Gravity.CENTER);
        GradientDrawable disc = new GradientDrawable();
        disc.setShape(GradientDrawable.OVAL);
        disc.setColor((ACCENT & 0x00FFFFFF) | 0x1A000000);
        avatar.setBackground(disc);
        row.addView(avatar, new LinearLayout.LayoutParams(dp(44), dp(44)));

        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(context);
        title.setText(name);
        title.setTextSize(17);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setTextColor(INK);
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        column.addView(title, new LinearLayout.LayoutParams(-2, -2));
        TextView hint = new TextView(context);
        hint.setText("历史记录按环境隔离");
        hint.setTextSize(12.5f);
        hint.setTextColor(MUTED);
        column.addView(hint, new LinearLayout.LayoutParams(-2, -2));
        LinearLayout.LayoutParams columnLayout = new LinearLayout.LayoutParams(0, -2, 1);
        columnLayout.setMargins(dp(12), 0, dp(8), 0);
        row.addView(column, columnLayout);

        TextView historyButton = new TextView(context);
        historyButton.setText("历史记录");
        historyButton.setTextSize(12.5f);
        historyButton.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        historyButton.setTextColor(ACCENT);
        historyButton.setGravity(Gravity.CENTER);
        historyButton.setMinimumWidth(dp(48));
        historyButton.setMinimumHeight(dp(40));
        historyButton.setBackground(rounded(ACCENT_SOFT, 20));
        historyButton.setPadding(dp(14), 0, dp(14), 0);
        historyButton.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            if (!quiescing) listener.onNtpOpenHistory();
        });
        row.addView(historyButton, new LinearLayout.LayoutParams(-2, -2));
        return row;
    }

    private LinearLayout buildSearchCard(Context context) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setBackground(stroked(CARD, 23));
        card.setElevation(dp(1.5f));
        card.setPadding(dp(10), dp(8), dp(10), dp(8));
        LinearLayout.LayoutParams cardLayout = new LinearLayout.LayoutParams(-1, -2);
        cardLayout.setMargins(0, dp(20), 0, 0);
        card.setLayoutParams(cardLayout);

        search.setHint("搜索或输入网址");
        search.setHintTextColor(MUTED);
        search.setTextColor(INK);
        search.setTextSize(15.5f);
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
        go.setTextSize(13.5f);
        go.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        go.setTextColor(ACCENT);
        go.setGravity(Gravity.CENTER);
        go.setMinimumWidth(dp(56));
        go.setMinimumHeight(dp(40));
        go.setBackground(rounded(ACCENT_SOFT, 20));
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
        section.setTextSize(17);
        section.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        section.setTextColor(INK);
        row.addView(section, new LinearLayout.LayoutParams(0, -2, 1));

        TextView all = new TextView(context);
        all.setText("全部 ›");
        all.setTextSize(12.5f);
        all.setTextColor(MUTED);
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
        card.setBackground(stroked(CARD, 20));
        card.setElevation(dp(1.5f));
        card.setPadding(dp(22), dp(30), dp(22), dp(30));

        TextView badge = new TextView(context);
        badge.setText("空");
        badge.setTextSize(20);
        badge.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        badge.setTextColor(ACCENT);
        badge.setGravity(Gravity.CENTER);
        GradientDrawable disc = new GradientDrawable();
        disc.setShape(GradientDrawable.OVAL);
        disc.setColor(ACCENT_SOFT);
        badge.setBackground(disc);
        card.addView(badge, new LinearLayout.LayoutParams(dp(56), dp(56)));

        TextView title = new TextView(context);
        title.setText("还没有浏览记录");
        title.setTextSize(16);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setTextColor(INK);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleLayout = new LinearLayout.LayoutParams(-2, -2);
        titleLayout.setMargins(0, dp(14), 0, 0);
        card.addView(title, titleLayout);

        TextView body = new TextView(context);
        body.setText("正常浏览网页后，最近访问的站点\n会以卡片形式显示在这里");
        body.setTextSize(12.5f);
        body.setTextColor(MUTED);
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
        tile.setBackground(stroked(CARD, 18));
        tile.setElevation(dp(1.5f));
        tile.setForeground(new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(NativeBrowserActivity.C_RIPPLE), null, rounded(CARD, 18)));
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

        int hue = TILE_HUES[Math.floorMod(host.hashCode(), TILE_HUES.length)];
        TextView avatar = new TextView(context);
        avatar.setText(firstLetter(host));
        avatar.setTextSize(16);
        avatar.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        avatar.setTextColor(hue);
        avatar.setGravity(Gravity.CENTER);
        avatar.setBackground(rounded((hue & 0x00FFFFFF) | 0x1F000000, 14));
        tile.addView(avatar, new LinearLayout.LayoutParams(dp(42), dp(42)));

        TextView name = new TextView(context);
        name.setText(host);
        name.setTextSize(12.5f);
        name.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        name.setTextColor(INK);
        name.setSingleLine(true);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        name.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams nameLayout = new LinearLayout.LayoutParams(-1, -2);
        nameLayout.setMargins(dp(2), dp(8), dp(2), 0);
        tile.addView(name, nameLayout);

        TextView meta = new TextView(context);
        meta.setText(relativeTimeFor(visit.lastVisitMillis) + " · " + visit.visitCount + " 次");
        meta.setTextSize(10.5f);
        meta.setTextColor(MUTED);
        meta.setSingleLine(true);
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
