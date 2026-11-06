package com.ahoo.abs.android.nativekernel;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.chromium.content_shell.Shell;

import java.util.List;

/**
 * Mobile-Chrome style full-screen tab switcher shown as the topmost overlay. Unlike the fixed
 * horizontal strip (which clips to roughly two tabs), cards flow in a vertically scrollable
 * adaptive grid — two columns, one on truly narrow screens — so every open tab stays
 * reachable. Tap a card to select that tab, tap the large × to close only that tab, or start
 * a new tab from the header. Card previews show the caller-supplied bitmap when still valid,
 * otherwise an honest letter placeholder: never a fabricated page image. No network access,
 * no persistence.
 */
final class TabSwitcherView extends FrameLayout {
    // Palette resolved from the activity's night mode (NativeBrowserActivity.resolvePalette).
    private final int PAGE;
    private final int CARD;
    private final int INK;
    private final int MUTED;
    private final int ACCENT;
    private final int ACCENT_SOFT;
    private final int STROKE;
    private final int PAGE_TOP;
    private final int TILE_BOTTOM;
    private static final int[] AVATAR_HUES = {0xFF4F46E5, 0xFF0D9488, 0xFFDB2777, 0xFFD97706,
            0xFF0284C7, 0xFF7C3AED, 0xFF059669, 0xFF64748B};
    private static final String FALLBACK_LABEL = "新标签页";

    /** One open tab as described by the activity; {@code preview} may be null or recycled. */
    static final class TabItem {
        final Shell shell;
        final String title;
        final String displayUrl;
        final boolean active;
        final Bitmap preview;

        TabItem(Shell shell, String title, String displayUrl, boolean active, Bitmap preview) {
            this.shell = shell;
            this.title = title;
            this.displayUrl = displayUrl;
            this.active = active;
            this.preview = preview;
        }
    }

    /** Tab actions the activity performs on behalf of the switcher. */
    interface Listener {
        void onSelect(Shell shell);

        void onClose(Shell shell);

        void onNewTab();

        void onDismiss();
    }

    private final Listener listener;
    private final ScrollView scroll;
    private final LinearLayout grid;
    private final TextView countLabel;
    private final TextView emptyLabel;
    private View activeCard;
    private int savedScroll;
    private final Runnable revealActive = this::scrollToActiveCard;
    private final Runnable restoreScroll = this::restoreScrollPosition;

    TabSwitcherView(Context context, String profileName, Listener listener) {
        super(context);
        PAGE = NativeBrowserActivity.C_CANVAS; CARD = NativeBrowserActivity.C_SURFACE;
        INK = NativeBrowserActivity.C_INK; MUTED = NativeBrowserActivity.C_MUTED;
        ACCENT = NativeBrowserActivity.C_ACCENT; ACCENT_SOFT = NativeBrowserActivity.C_ACCENT_SOFT;
        STROKE = NativeBrowserActivity.C_STROKE;
        PAGE_TOP = NativeBrowserActivity.C_TILE_TOP; TILE_BOTTOM = NativeBrowserActivity.C_TILE_BOTTOM;

        this.listener = listener;
        setBackgroundColor(PAGE);
        setClickable(true);

        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        addView(column, new FrameLayout.LayoutParams(-1, -1));
        countLabel = new TextView(context);
        column.addView(buildHeader(context, countLabel));
        View divider = new View(context);
        divider.setBackgroundColor(STROKE);
        column.addView(divider, new LinearLayout.LayoutParams(-1, dp(1)));
        column.addView(buildProfileRow(context, profileName));

        scroll = new ScrollView(context);
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        column.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

        grid = new LinearLayout(context);
        grid.setOrientation(LinearLayout.VERTICAL);
        int side = dp(14);
        grid.setPadding(side, dp(12), side, dp(24));
        scroll.addView(grid, new FrameLayout.LayoutParams(-1, -2));

        emptyLabel = new TextView(context);
        emptyLabel.setText("暂无打开的标签页\n\n点按右上角“新建”开始浏览");
        emptyLabel.setTextSize(13);
        emptyLabel.setTextColor(MUTED);
        emptyLabel.setGravity(Gravity.CENTER);
        emptyLabel.setPadding(0, dp(64), 0, 0);
        emptyLabel.setVisibility(View.GONE);

        setVisibility(View.GONE);
    }

    /** Makes the switcher visible and lays out the tabs, scrolled to the active card. */
    void show(List<TabItem> items) {
        setVisibility(View.VISIBLE);
        setAlpha(0f);
        setTranslationY(dp(18));
        animate().alpha(1f).translationY(0f).setDuration(200).start();
        rebuild(items);
        cancelScrollWork();
        scroll.post(revealActive);
    }

    /** Rebuilds the cards in place (no activity restart), keeping the current scroll offset. */
    void refresh(List<TabItem> items) {
        savedScroll = scroll.getScrollY();
        rebuild(items);
        cancelScrollWork();
        scroll.post(restoreScroll);
    }

    void dismiss() {
        setVisibility(View.GONE);
        cancelScrollWork();
        // Release ImageView references without recycling bitmaps still owned by display lists.
        grid.removeAllViews();
        activeCard = null;
    }

    private void cancelScrollWork() {
        scroll.removeCallbacks(revealActive);
        scroll.removeCallbacks(restoreScroll);
    }

    private void scrollToActiveCard() {
        if (!isShowing() || activeCard == null) return;
        View row = (View) activeCard.getParent();
        int top = row == null ? activeCard.getTop() : row.getTop();
        scroll.scrollTo(0, Math.max(0, top - dp(8)));
    }

    private void restoreScrollPosition() {
        if (isShowing()) scroll.scrollTo(0, savedScroll);
    }

    boolean isShowing() {
        return getVisibility() == View.VISIBLE;
    }

    private LinearLayout buildHeader(Context context, TextView countLabel) {
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
            if (listener != null) listener.onDismiss();
        });
        header.addView(back);

        LinearLayout titles = new LinearLayout(context);
        titles.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(context);
        title.setText("标签页");
        title.setTextSize(18);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setTextColor(INK);
        titles.addView(title, new LinearLayout.LayoutParams(-2, -2));
        countLabel.setTextSize(12.5f);
        countLabel.setTextColor(MUTED);
        titles.addView(countLabel, new LinearLayout.LayoutParams(-2, -2));
        LinearLayout.LayoutParams titlesLayout = new LinearLayout.LayoutParams(0, -2, 1);
        titlesLayout.setMargins(dp(6), 0, dp(8), 0);
        header.addView(titles, titlesLayout);

        TextView create = new TextView(context);
        create.setText("＋ 新建");
        create.setTextSize(13);
        create.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        create.setTextColor(ACCENT);
        create.setGravity(Gravity.CENTER);
        create.setMinimumWidth(dp(48));
        create.setMinimumHeight(dp(48));
        create.setPadding(dp(12), 0, dp(12), 0);
        create.setBackground(rounded(ACCENT_SOFT, 20));
        create.setContentDescription("新建标签页");
        create.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            if (listener != null) listener.onNewTab();
        });
        header.addView(create);
        return header;
    }

    private View buildProfileRow(Context context, String profileName) {
        String name = profileName == null || profileName.trim().isEmpty()
                ? "默认环境" : profileName.trim();
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(16), dp(10), dp(16), dp(2));

        TextView label = new TextView(context);
        label.setText("浏览环境：" + name);
        label.setTextSize(12.5f);
        label.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        label.setTextColor(MUTED);
        label.setSingleLine(true);
        label.setEllipsize(TextUtils.TruncateAt.END);
        row.addView(label, new LinearLayout.LayoutParams(0, -2, 1));

        TextView hint = new TextView(context);
        hint.setText("点按卡片切换 · × 关闭");
        hint.setTextSize(11);
        hint.setTextColor(MUTED);
        hint.setSingleLine(true);
        LinearLayout.LayoutParams hintLayout = new LinearLayout.LayoutParams(-2, -2);
        hintLayout.setMargins(dp(8), 0, 0, 0);
        row.addView(hint, hintLayout);
        return row;
    }

    private void rebuild(List<TabItem> items) {
        activeCard = null;
        grid.removeAllViews();
        int count = items == null ? 0 : items.size();
        countLabel.setText("共 " + count + " 个标签页");
        if (count == 0) {
            emptyLabel.setVisibility(View.VISIBLE);
            grid.addView(emptyLabel, new LinearLayout.LayoutParams(-1, -2));
            return;
        }
        emptyLabel.setVisibility(View.GONE);
        int columns = columnCount();
        for (int start = 0; start < count; start += columns) {
            LinearLayout row = new LinearLayout(getContext());
            row.setOrientation(LinearLayout.HORIZONTAL);
            int end = Math.min(start + columns, count);
            for (int i = start; i < end; i++) {
                row.addView(makeCard(items.get(i)), cardLayout());
            }
            for (int pad = end; pad < start + columns; pad++) {
                row.addView(new View(getContext()), cardLayout());
            }
            LinearLayout.LayoutParams rowLayout = new LinearLayout.LayoutParams(-1, -2);
            rowLayout.setMargins(0, 0, 0, dp(10));
            grid.addView(row, rowLayout);
        }
    }

    private LinearLayout.LayoutParams cardLayout() {
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(0, -2, 1);
        layout.setMargins(dp(5), 0, dp(5), 0);
        return layout;
    }

    private View makeCard(final TabItem item) {
        Context context = getContext();
        final String label = cardTitle(item);

        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(stroked(item.active));
        card.setElevation(item.active ? dp(3) : dp(1.5f));
        card.setForeground(new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(NativeBrowserActivity.C_RIPPLE), null, rounded(CARD, 18)));
        card.setPadding(dp(6), dp(6), dp(6), dp(12));
        card.setContentDescription("切换到标签页：" + label);
        card.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            if (listener != null) listener.onSelect(item.shell);
        });
        if (item.active) activeCard = card;

        FrameLayout preview = new FrameLayout(context);
        GradientDrawable previewBackground = new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM, new int[]{PAGE_TOP, TILE_BOTTOM});
        previewBackground.setCornerRadius(dp(14));
        preview.setBackground(previewBackground);
        card.addView(preview, new LinearLayout.LayoutParams(-1, dp(122)));

        if (item.preview != null && !item.preview.isRecycled()) {
            ImageView image = new ImageView(context);
            image.setImageBitmap(item.preview);
            image.setScaleType(ImageView.ScaleType.CENTER_CROP);
            preview.addView(image, new FrameLayout.LayoutParams(-1, -1));
        } else {
            String host = cardSubtitle(item);
            boolean blank = "about:blank".equals(item.displayUrl)
                    || (item.displayUrl != null && item.displayUrl.startsWith("about:blank"));
            LinearLayout placeholder = new LinearLayout(context);
            placeholder.setOrientation(LinearLayout.VERTICAL);
            placeholder.setGravity(Gravity.CENTER_HORIZONTAL | Gravity.CENTER_VERTICAL);
            placeholder.addView(makeAvatar(context, label), new LinearLayout.LayoutParams(dp(56), dp(56)));
            TextView hostLabel = new TextView(context);
            hostLabel.setText(host);
            hostLabel.setTextSize(11);
            hostLabel.setTextColor(MUTED);
            hostLabel.setSingleLine(true);
            hostLabel.setEllipsize(android.text.TextUtils.TruncateAt.END);
            hostLabel.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams hostLayout = new LinearLayout.LayoutParams(-2, -2);
            hostLayout.topMargin = dp(8);
            hostLayout.leftMargin = dp(10);
            hostLayout.rightMargin = dp(10);
            placeholder.addView(hostLabel, hostLayout);
            if (!blank) {
                TextView note = new TextView(context);
                note.setText("暂无实时预览");
                note.setTextSize(12);
                note.setTextColor(MUTED);
                note.setGravity(Gravity.CENTER);
                LinearLayout.LayoutParams noteLayout = new LinearLayout.LayoutParams(-2, -2);
                noteLayout.topMargin = dp(2);
                placeholder.addView(note, noteLayout);
            }
            preview.addView(placeholder, new FrameLayout.LayoutParams(-1, -1));
        }

        TextView close = new TextView(context);
        close.setText("×");
        close.setTextSize(14);
        close.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        close.setTextColor(MUTED);
        close.setGravity(Gravity.CENTER);
        GradientDrawable closeBackground = new GradientDrawable();
        closeBackground.setColor((NativeBrowserActivity.C_SURFACE & 0x00FFFFFF) | 0xF2000000);
        closeBackground.setCornerRadius(dp(20));
        closeBackground.setStroke(dp(1), STROKE);
        close.setBackground(closeBackground);
        close.setElevation(dp(1));
        close.setContentDescription("关闭标签页：" + label);
        close.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            if (listener != null) listener.onClose(item.shell);
        });
        FrameLayout.LayoutParams closeLayout =
                new FrameLayout.LayoutParams(dp(40), dp(40), Gravity.TOP | Gravity.END);
        closeLayout.setMargins(0, dp(6), dp(6), 0);
        preview.addView(close, closeLayout);

        LinearLayout info = new LinearLayout(context);
        info.setOrientation(LinearLayout.HORIZONTAL);
        info.setGravity(Gravity.CENTER_VERTICAL);
        info.setPadding(dp(10), dp(9), dp(4), 0);
        card.addView(info, new LinearLayout.LayoutParams(-1, -2));

        TextView title = new TextView(context);
        title.setText(label);
        title.setTextSize(13);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setTextColor(item.active ? ACCENT : INK);
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);
        info.addView(title, new LinearLayout.LayoutParams(0, -2, 1));

        TextView badge = new TextView(context);
        badge.setText("当前");
        badge.setTextSize(10);
        badge.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        badge.setTextColor(ACCENT);
        badge.setPadding(dp(6), dp(2), dp(2), dp(2));
        badge.setVisibility(item.active ? View.VISIBLE : View.GONE);
        info.addView(badge, new LinearLayout.LayoutParams(-2, -2));

        TextView url = new TextView(context);
        url.setText(cardSubtitle(item));
        url.setTextSize(11.5f);
        url.setTextColor(MUTED);
        url.setSingleLine(true);
        url.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams urlLayout = new LinearLayout.LayoutParams(-1, -2);
        urlLayout.setMargins(dp(8), dp(2), dp(8), 0);
        card.addView(url, urlLayout);
        return card;
    }

    private View makeAvatar(Context context, String label) {
        int hue = AVATAR_HUES[Math.floorMod(label.hashCode(), AVATAR_HUES.length)];
        TextView avatar = new TextView(context);
        avatar.setText(label.isEmpty() ? "•" : new String(Character.toChars(label.codePointAt(0))));
        avatar.setTextSize(18);
        avatar.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        avatar.setTextColor(hue);
        avatar.setGravity(Gravity.CENTER);
        avatar.setBackground(rounded((hue & 0x00FFFFFF) | 0x1A000000, 28));
        return avatar;
    }

    /** Title for a card: trims the caller value, falling back when blank — never assumes nonempty. */
    private static String cardTitle(TabItem item) {
        String title = item.title;
        if (title != null && !title.trim().isEmpty()) return title.trim();
        return FALLBACK_LABEL;
    }

    /** Short origin for a card; any about:blank form (incl. the reserved UUID) is a 新标签页. */
    private static String cardSubtitle(TabItem item) {
        String url = item.displayUrl;
        if (url == null) return FALLBACK_LABEL;
        url = url.trim();
        if (url.isEmpty() || url.startsWith("about:blank")) return FALLBACK_LABEL;
        String host = NewTabPage.displayHostFor(url);
        return host.isEmpty() ? FALLBACK_LABEL : host;
    }

    /** Two columns everywhere except truly narrow windows (split screen, tiny devices). */
    private int columnCount() {
        DisplayMetrics metrics = getResources().getDisplayMetrics();
        int width = getWidth() > 0 ? getWidth() : metrics.widthPixels;
        float widthDp = width / metrics.density;
        return widthDp < 300f ? 1 : 2;
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

    private GradientDrawable stroked(boolean active) {
        GradientDrawable drawable = rounded(CARD, 14);
        drawable.setStroke(dp(active ? 2 : 1), active ? ACCENT : STROKE);
        return drawable;
    }
}
