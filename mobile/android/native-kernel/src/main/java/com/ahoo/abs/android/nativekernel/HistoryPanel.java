package com.ahoo.abs.android.nativekernel;

import android.app.Dialog;
import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
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
    private int PAGE;
    private int CARD;
    private int INK;
    private int MUTED;
    private int ACCENT;
    private int ACCENT_SOFT;
    private int STROKE;
    private int PILL;
    private final NativeBrowserActivity.PaletteBindings staticPaletteBindings =
            new NativeBrowserActivity.PaletteBindings();
    private final NativeBrowserActivity.PaletteBindings rowPaletteBindings =
            new NativeBrowserActivity.PaletteBindings();

    private final NativeBrowserActivity.FontBindings staticFonts = new NativeBrowserActivity.FontBindings();
    private final NativeBrowserActivity.FontBindings rowFonts = new NativeBrowserActivity.FontBindings();

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
    private final android.widget.EditText searchField;
    private String searchQuery = "";
    private Dialog clearDialog;
    private Dialog rowDialog;
    private boolean quiescing;

    HistoryPanel(Context context, BrowserHistoryStore store, Listener listener) {
        super(context);
        readPalette();

        this.store = store;
        this.listener = listener;
        ColorDrawable pageBackground = new ColorDrawable();
        setBackground(pageBackground);
        staticPaletteBindings.add(() -> pageBackground.setColor(PAGE));
        setClickable(true);

        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        addView(column, new FrameLayout.LayoutParams(-1, -1));

        LinearLayout header = new LinearLayout(context);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        ColorDrawable headerBackground = new ColorDrawable();
        header.setBackground(headerBackground);
        staticPaletteBindings.add(() -> headerBackground.setColor(CARD));
        header.setPadding(dp(4), dp(4), dp(4), dp(4));
        header.setMinimumHeight(dp(56));

        TextView back = new TextView(context);
        back.setText("‹");
        staticFonts.bind(back, 23);
        staticPaletteBindings.add(() -> back.setTextColor(INK));
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
        staticFonts.bind(title, 18);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        staticPaletteBindings.add(() -> title.setTextColor(INK));
        LinearLayout.LayoutParams titleLayout = new LinearLayout.LayoutParams(0, -2, 1);
        titleLayout.setMargins(dp(6), 0, 0, 0);
        header.addView(title, titleLayout);

        TextView clear = new TextView(context);
        clear.setText("清空");
        staticFonts.bind(clear, 13);
        clear.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        staticPaletteBindings.add(() -> clear.setTextColor(ACCENT));
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
        ColorDrawable dividerBackground = new ColorDrawable();
        divider.setBackground(dividerBackground);
        staticPaletteBindings.add(() -> dividerBackground.setColor(STROKE));
        column.addView(divider, new LinearLayout.LayoutParams(-1, dp(1)));

        // Search over the aggregated sites; filtering is local and never touches the store.
        searchField = new android.widget.EditText(context);
        searchField.setSingleLine(true);
        searchField.setHint("搜索历史站点");
        staticPaletteBindings.add(() -> searchField.setHintTextColor(MUTED));
        staticPaletteBindings.add(() -> searchField.setTextColor(INK));
        staticFonts.bind(searchField, 14);
        searchField.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH);
        GradientDrawable searchBackground = rounded(PILL, 14);
        searchField.setBackground(searchBackground);
        staticPaletteBindings.add(() -> searchBackground.setColor(PILL));
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
        staticFonts.bind(emptyTitle, 13);
        staticPaletteBindings.add(() -> emptyTitle.setTextColor(MUTED));
        emptyTitle.setGravity(Gravity.CENTER);
        emptyTitle.setPadding(0, dp(48), 0, 0);
        emptyTitle.setVisibility(View.GONE);

        TextView hint = new TextView(context);
        hint.setText("点按在当前标签页打开 · 长按在新标签页打开 · × 删除该站点");
        staticFonts.bind(hint, 11);
        staticPaletteBindings.add(() -> hint.setTextColor(MUTED));
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, dp(8), 0, dp(12));
        column.addView(hint, new LinearLayout.LayoutParams(-1, -2));

        setVisibility(View.GONE);
    }

    private void readPalette() {
        PAGE = NativeBrowserActivity.C_CANVAS; CARD = NativeBrowserActivity.C_SURFACE;
        INK = NativeBrowserActivity.C_INK; MUTED = NativeBrowserActivity.C_MUTED;
        ACCENT = NativeBrowserActivity.C_ACCENT; ACCENT_SOFT = NativeBrowserActivity.C_ACCENT_SOFT;
        STROKE = NativeBrowserActivity.C_STROKE; PILL = NativeBrowserActivity.C_PILL;
    }

    /** Recolors existing controls, rows and dialogs without querying or rebuilding data. */
    void applyPalette() {
        readPalette();
        staticPaletteBindings.apply();
        rowPaletteBindings.apply();
        if (clearDialog != null) BrowserDialogs.applyPalette(clearDialog);
        if (rowDialog != null) BrowserDialogs.applyPalette(rowDialog);
    }

    /** Preserve query, selection and row identities while refreshing system-scaled SP. */
    void applyFontScale() {
        if (quiescing) return;
        staticFonts.apply();
        rowFonts.apply();
        if (clearDialog != null) BrowserDialogs.applyFontScale(clearDialog);
        if (rowDialog != null) BrowserDialogs.applyFontScale(rowDialog);
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
        rowPaletteBindings.clear();
        rowFonts.clear();
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
                rowFonts.bind(header, 12.5f);
                header.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
                rowPaletteBindings.add(() -> header.setTextColor(MUTED));
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
        GradientDrawable rowBackground = stroked(CARD, 16);
        row.setBackground(rowBackground);
        rowPaletteBindings.add(() -> {
            rowBackground.setColor(CARD);
            rowBackground.setStroke(dp(1), STROKE);
        });
        row.setElevation(dp(1.5f));
        row.setPadding(dp(16), dp(12), dp(10), dp(12));
        row.setMinimumHeight(dp(56));

        String host = NewTabPage.displayHostFor(visit.origin);
        TextView badge = new TextView(context);
        badge.setText(host.isEmpty() ? "•" : host.substring(0, 1).toUpperCase(java.util.Locale.ROOT));
        rowFonts.bind(badge, 14);
        badge.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        rowPaletteBindings.add(() -> badge.setTextColor(ACCENT));
        badge.setGravity(Gravity.CENTER);
        GradientDrawable badgeBackground = rounded(ACCENT_SOFT, 18);
        badge.setBackground(badgeBackground);
        rowPaletteBindings.add(() -> badgeBackground.setColor(ACCENT_SOFT));
        LinearLayout.LayoutParams badgeLayout = new LinearLayout.LayoutParams(dp(36), dp(36));
        badgeLayout.rightMargin = dp(12);
        row.addView(badge, badgeLayout);

        LinearLayout text = new LinearLayout(context);
        text.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(context);
        title.setText(label);
        rowFonts.bind(title, 14);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        rowPaletteBindings.add(() -> title.setTextColor(INK));
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        text.addView(title, new LinearLayout.LayoutParams(-1, -2));
        TextView sub = new TextView(context);
        sub.setText(host + " · " + visit.visitCount + " 次");
        rowFonts.bind(sub, 12.5f);
        rowPaletteBindings.add(() -> sub.setTextColor(MUTED));
        sub.setSingleLine(true);
        sub.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams subLayout = new LinearLayout.LayoutParams(-1, -2);
        subLayout.setMargins(0, dp(2), 0, 0);
        text.addView(sub, subLayout);
        row.addView(text, new LinearLayout.LayoutParams(0, -2, 1));

        TextView time = new TextView(context);
        time.setText(rowTime(visit.lastVisitMillis));
        rowFonts.bind(time, 11.5f);
        rowPaletteBindings.add(() -> time.setTextColor(MUTED));
        LinearLayout.LayoutParams timeLayout = new LinearLayout.LayoutParams(-2, -2);
        timeLayout.setMargins(dp(8), 0, 0, 0);
        row.addView(time, timeLayout);

        TextView remove = new TextView(context);
        remove.setText("×");
        rowFonts.bind(remove, 15);
        remove.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        rowPaletteBindings.add(() -> remove.setTextColor(MUTED));
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
