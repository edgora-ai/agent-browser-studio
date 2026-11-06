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
import java.util.List;

/**
 * Full-page history list shown as the topmost overlay inside the page area. Rows are the
 * aggregated per-profile sites: tap opens a site in the active tab, long-press opens it in
 * a new tab, and 清空 removes history records only — never site cookies or storage.
 */
final class HistoryPanel extends FrameLayout {
    // Palette resolved from the activity's night mode (NativeBrowserActivity.resolvePalette).
    private final int PAGE;
    private final int CARD;
    private final int INK;
    private final int MUTED;
    private final int ACCENT;
    private final int STROKE;

    /** Opens a stored origin; {@code newTab} selects a fresh tab instead of the active one. */
    interface Listener {
        void onOpenHistoryUrl(String url, boolean newTab);
        void onHistoryChanged();
        void onHistoryDismissed();
    }

    private final BrowserHistoryStore store;
    private final Listener listener;
    private final LinearLayout list;
    private final TextView emptyTitle;
    private android.widget.EditText searchField;
    private String searchQuery = "";
    private Dialog clearDialog;
    private Dialog rowDialog;
    private boolean quiescing;

    HistoryPanel(Context context, BrowserHistoryStore store, Listener listener) {
        super(context);
        PAGE = NativeBrowserActivity.C_CANVAS; CARD = NativeBrowserActivity.C_SURFACE;
        INK = NativeBrowserActivity.C_INK; MUTED = NativeBrowserActivity.C_MUTED;
        ACCENT = NativeBrowserActivity.C_ACCENT; STROKE = NativeBrowserActivity.C_STROKE;

        this.store = store;
        this.listener = listener;
        setBackgroundColor(PAGE);
        setClickable(true);

        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        addView(column, new FrameLayout.LayoutParams(-1, -1));

        LinearLayout header = new LinearLayout(context);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setBackgroundColor(CARD);
        header.setElevation(dp(1.5f));
        header.setPadding(dp(8), dp(8), dp(14), dp(8));

        TextView back = new TextView(context);
        back.setText("‹");
        back.setTextSize(23);
        back.setTextColor(INK);
        back.setGravity(Gravity.CENTER);
        back.setMinimumWidth(dp(48));
        back.setMinimumHeight(dp(48));
        back.setContentDescription("返回浏览器");
        back.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            dismiss();
        });
        header.addView(back);

        TextView title = new TextView(context);
        title.setText("历史记录");
        title.setTextSize(18);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setTextColor(INK);
        LinearLayout.LayoutParams titleLayout = new LinearLayout.LayoutParams(0, -2, 1);
        titleLayout.setMargins(dp(6), 0, 0, 0);
        header.addView(title, titleLayout);

        TextView clear = new TextView(context);
        clear.setText("清空");
        clear.setTextSize(13);
        clear.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        clear.setTextColor(ACCENT);
        clear.setGravity(Gravity.CENTER);
        clear.setMinimumWidth(dp(48));
        clear.setMinimumHeight(dp(48));
        clear.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            confirmClear();
        });
        header.addView(clear);
        column.addView(header, new LinearLayout.LayoutParams(-1, -2));

        View divider = new View(context);
        divider.setBackgroundColor(STROKE);
        column.addView(divider, new LinearLayout.LayoutParams(-1, dp(1)));

        // Search over the aggregated sites; filtering is local and never touches the store.
        searchField = new android.widget.EditText(context);
        searchField.setSingleLine(true);
        searchField.setHint("搜索历史站点");
        searchField.setHintTextColor(MUTED);
        searchField.setTextColor(INK);
        searchField.setTextSize(14);
        searchField.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH);
        searchField.setBackground(rounded(NativeBrowserActivity.C_PILL, 14));
        searchField.setPadding(dp(14), dp(9), dp(14), dp(9));
        searchField.setVisibility(View.GONE);
        LinearLayout.LayoutParams searchLayout = new LinearLayout.LayoutParams(-1, -2);
        searchLayout.setMargins(dp(14), dp(10), dp(14), 0);
        column.addView(searchField, searchLayout);
        searchField.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }
            @Override public void afterTextChanged(android.text.Editable value) {
                searchQuery = value.toString().trim().toLowerCase(java.util.Locale.ROOT);
                rebuild();
            }
        });

        ScrollView scroll = new ScrollView(context);
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        column.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

        list = new LinearLayout(context);
        list.setOrientation(LinearLayout.VERTICAL);
        int side = dp(14);
        list.setPadding(side, dp(14), side, dp(14));
        scroll.addView(list, new FrameLayout.LayoutParams(-1, -2));

        emptyTitle = new TextView(context);
        emptyTitle.setText("暂无历史记录\n\n浏览过的网站会记录在这里");
        emptyTitle.setTextSize(13);
        emptyTitle.setTextColor(MUTED);
        emptyTitle.setGravity(Gravity.CENTER);
        emptyTitle.setPadding(0, dp(48), 0, 0);
        emptyTitle.setVisibility(View.GONE);

        TextView hint = new TextView(context);
        hint.setText("点按在当前标签页打开 · 长按在新标签页打开 · × 删除该站点");
        hint.setTextSize(11);
        hint.setTextColor(MUTED);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, dp(8), 0, dp(12));
        column.addView(hint, new LinearLayout.LayoutParams(-1, -2));

        setVisibility(View.GONE);
    }

    /** Makes the panel visible and rebuilds its rows from the store. */
    void show() {
        if (quiescing) return;
        setVisibility(View.VISIBLE);
        searchField.setVisibility(View.VISIBLE);
        rebuild();
    }

    void dismiss() {
        boolean wasShowing = getVisibility() == View.VISIBLE;
        setVisibility(View.GONE);
        if (clearDialog != null) clearDialog.dismiss();
        if (rowDialog != null) rowDialog.dismiss();
        if (wasShowing) listener.onHistoryDismissed();
    }

    void quiesce() {
        quiescing = true;
        dismiss();
    }

    private void rebuild() {
        list.removeAllViews();
        List<BrowserHistory.SiteVisit> ranked = store.ranked();
        List<BrowserHistory.SiteVisit> visible = new java.util.ArrayList<>();
        for (BrowserHistory.SiteVisit visit : ranked) {
            if (searchQuery.isEmpty()
                    || visit.origin.toLowerCase(java.util.Locale.ROOT).contains(searchQuery)
                    || (visit.title != null
                        && visit.title.toLowerCase(java.util.Locale.ROOT).contains(searchQuery))) {
                visible.add(visit);
            }
        }
        boolean searching = !searchQuery.isEmpty();
        emptyTitle.setText(searching ? "没有匹配的站点\n\n试试其他关键词" : "暂无历史记录\n\n浏览过的网站会记录在这里");
        emptyTitle.setVisibility(visible.isEmpty() ? View.VISIBLE : View.GONE);
        if (visible.isEmpty()) list.addView(emptyTitle, new LinearLayout.LayoutParams(-1, -2));
        String previousGroup = null;
        for (final BrowserHistory.SiteVisit visit : visible) {
            String group = dayGroup(visit.lastVisitMillis);
            if (!group.equals(previousGroup)) {
                TextView header = new TextView(getContext());
                header.setText(group);
                header.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12.5f);
                header.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
                header.setTextColor(MUTED);
                header.setLetterSpacing(0.04f);
                header.setPadding(dp(8), dp(previousGroup == null ? 2 : 16), dp(8), dp(8));
                list.addView(header, new LinearLayout.LayoutParams(-1, -2));
                previousGroup = group;
            }
            list.addView(makeRow(visit), rowLayout());
        }
    }

    /** Local-day grouping label used by the history list headers. */
    private static String dayGroup(long millis) {
        java.util.Calendar then = java.util.Calendar.getInstance();
        then.setTimeInMillis(millis);
        java.util.Calendar now = java.util.Calendar.getInstance();
        int sameDay = then.get(java.util.Calendar.YEAR) * 1000 + then.get(java.util.Calendar.DAY_OF_YEAR);
        int today = now.get(java.util.Calendar.YEAR) * 1000 + now.get(java.util.Calendar.DAY_OF_YEAR);
        now.add(java.util.Calendar.DAY_OF_YEAR, -1);
        int yesterday = now.get(java.util.Calendar.YEAR) * 1000 + now.get(java.util.Calendar.DAY_OF_YEAR);
        if (sameDay == today) return "今天";
        if (sameDay == yesterday) return "昨天";
        return "更早";
    }

    private LinearLayout.LayoutParams rowLayout() {
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2);
        layout.setMargins(0, 0, 0, dp(8));
        return layout;
    }

    private View makeRow(final BrowserHistory.SiteVisit visit) {
        Context context = getContext();
        String label = visit.title == null || visit.title.trim().isEmpty()
                ? BrowserHistory.canonicalOrigin(visit.origin) : visit.title.trim();

        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setBackground(stroked(CARD, 16));
        row.setElevation(dp(1.5f));
        row.setPadding(dp(16), dp(12), dp(10), dp(12));
        row.setMinimumHeight(dp(56));

        String host = NewTabPage.displayHostFor(visit.origin);
        TextView badge = new TextView(context);
        badge.setText(host.isEmpty() ? "•" : host.substring(0, 1).toUpperCase(java.util.Locale.ROOT));
        badge.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14);
        badge.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        int hue = AVATAR_HUES[Math.floorMod(host.hashCode(), AVATAR_HUES.length)];
        badge.setTextColor(hue);
        badge.setGravity(Gravity.CENTER);
        badge.setBackground(rounded((hue & 0x00FFFFFF) | 0x1F000000, 18));
        LinearLayout.LayoutParams badgeLayout = new LinearLayout.LayoutParams(dp(36), dp(36));
        badgeLayout.rightMargin = dp(12);
        row.addView(badge, badgeLayout);

        LinearLayout text = new LinearLayout(context);
        text.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(context);
        title.setText(label);
        title.setTextSize(14);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setTextColor(INK);
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        text.addView(title, new LinearLayout.LayoutParams(-1, -2));
        TextView sub = new TextView(context);
        sub.setText(host + " · " + visit.visitCount + " 次");
        sub.setTextSize(12.5f);
        sub.setTextColor(MUTED);
        sub.setSingleLine(true);
        sub.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams subLayout = new LinearLayout.LayoutParams(-1, -2);
        subLayout.setMargins(0, dp(2), 0, 0);
        text.addView(sub, subLayout);
        row.addView(text, new LinearLayout.LayoutParams(0, -2, 1));

        TextView time = new TextView(context);
        time.setText(rowTime(visit.lastVisitMillis));
        time.setTextSize(11.5f);
        time.setTextColor(MUTED);
        LinearLayout.LayoutParams timeLayout = new LinearLayout.LayoutParams(-2, -2);
        timeLayout.setMargins(dp(8), 0, 0, 0);
        row.addView(time, timeLayout);

        TextView remove = new TextView(context);
        remove.setText("×");
        remove.setTextSize(15);
        remove.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        remove.setTextColor(MUTED);
        remove.setGravity(Gravity.CENTER);
        remove.setMinimumWidth(dp(36));
        remove.setMinimumHeight(dp(36));
        remove.setContentDescription("删除站点记录：" + label);
        remove.setOnClickListener(view -> {
            if (quiescing) return;
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            confirmRemoveSite(visit);
        });
        row.addView(remove);

        row.setOnClickListener(view -> {
            if (quiescing) return;
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            listener.onOpenHistoryUrl(visit.origin, false);
            dismiss();
        });
        row.setOnLongClickListener(view -> {
            if (quiescing) return true;
            listener.onOpenHistoryUrl(visit.origin, true);
            dismiss();
            return true;
        });
        return row;
    }

    /** Calendar-aligned row time: 今天/昨天 get clock times; 更早 gets a date, matching groups. */
    private static String rowTime(long millis) {
        String group = dayGroup(millis);
        java.util.Calendar calendar = java.util.Calendar.getInstance();
        calendar.setTimeInMillis(millis);
        String clock = String.format(java.util.Locale.ROOT, "%02d:%02d",
                calendar.get(java.util.Calendar.HOUR_OF_DAY), calendar.get(java.util.Calendar.MINUTE));
        if ("今天".equals(group)) return clock;
        if ("昨天".equals(group)) return "昨天 " + clock;
        java.util.Calendar now = java.util.Calendar.getInstance();
        if (calendar.get(java.util.Calendar.YEAR) == now.get(java.util.Calendar.YEAR)) {
            return String.format(java.util.Locale.ROOT, "%d月%d日",
                    calendar.get(java.util.Calendar.MONTH) + 1, calendar.get(java.util.Calendar.DAY_OF_MONTH));
        }
        return String.format(java.util.Locale.ROOT, "%d年%d月%d日", calendar.get(java.util.Calendar.YEAR),
                calendar.get(java.util.Calendar.MONTH) + 1, calendar.get(java.util.Calendar.DAY_OF_MONTH));
    }

    private void confirmRemoveSite(final BrowserHistory.SiteVisit visit) {
        if (rowDialog != null) rowDialog.dismiss();
        String host = NewTabPage.displayHostFor(visit.origin);
        Dialog pending = BrowserDialogs.confirm(getContext(), "删除该站点的访问记录？",
                (host.isEmpty() ? visit.origin : host) + " · 仅删除历史记录，不清除 Cookie 或网站存储。", "删除", () -> {
                    if (quiescing) return;
                    store.removeSite(visit.origin);
                    listener.onHistoryChanged();
                    rebuild();
                });
        rowDialog = pending;
        pending.setOnDismissListener(dialog -> {
            if (rowDialog == pending) rowDialog = null;
        });
    }

    private void confirmClear() {
        if (quiescing) return;
        if (clearDialog != null) clearDialog.dismiss();
        Dialog pending = BrowserDialogs.confirm(getContext(), "清空历史记录？",
                "只清除当前环境的浏览历史记录，不会操作 Cookie 或网站存储。", "清空", () -> {
                    if (quiescing) return;
                    store.clear();
                    listener.onHistoryChanged();
                    rebuild();
                });
        clearDialog = pending;
        pending.setOnDismissListener(dialog -> {
            if (clearDialog == pending) clearDialog = null;
        });
    }

    private static final int[] AVATAR_HUES = {0xFF4F46E5, 0xFF0D9488, 0xFFDB2777, 0xFFD97706,
            0xFF0284C7, 0xFF7C3AED, 0xFF059669, 0xFF64748B};

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
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        drawable.setStroke(dp(1), STROKE);
        return drawable;
    }
}
