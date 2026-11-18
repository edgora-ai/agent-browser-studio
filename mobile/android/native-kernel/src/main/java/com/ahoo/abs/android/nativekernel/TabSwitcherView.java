package com.ahoo.abs.android.nativekernel;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewTreeObserver;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.chromium.content_shell.Shell;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
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
    // Owned view bindings repaint in place; the retained input/scroll/preview state is untouched.
    private final NativeBrowserActivity.PaletteBindings palette = new NativeBrowserActivity.PaletteBindings();
    private final NativeBrowserActivity.PaletteBindings cardPalette = new NativeBrowserActivity.PaletteBindings();
    private final NativeBrowserActivity.FontBindings staticFonts = new NativeBrowserActivity.FontBindings();
    private final NativeBrowserActivity.FontBindings cardFonts = new NativeBrowserActivity.FontBindings();
    private int PAGE;
    private int CARD;
    private int INK;
    private int MUTED;
    private int ACCENT;
    private int ACCENT_SOFT;
    private int STROKE;
    private int PAGE_TOP;
    private int TILE_BOTTOM;
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
    private final List<CardBinding> cards = new ArrayList<>();
    private List<TabItem> shownItems = new ArrayList<>();
    private View activeCard;
    private int gridColumns;
    private float gridDensity;
    private float gridFontScale;
    private int savedScroll;
    private Shell anchorShell;
    private int anchorOffset;
    private boolean revealOnLayout;
    private boolean restoreOnLayout;
    private boolean insetAnchorPending;
    private boolean internalScroll;
    private boolean layingOutScroll;
    private int measuredWidth;
    private ViewTreeObserver paletteObserver;
    private ViewTreeObserver.OnPreDrawListener paletteAnchorRestore;

    TabSwitcherView(Context context, String profileName, Listener listener) {
        super(context);
        readPalette();

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

        scroll = new AnchorScrollView(context);
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
        staticFonts.bind(emptyLabel, 13);
        emptyLabel.setTextColor(MUTED);
        emptyLabel.setGravity(Gravity.CENTER);
        emptyLabel.setPadding(0, dp(64), 0, 0);
        emptyLabel.setVisibility(View.GONE);
        palette.add(() -> {
            setBackgroundColor(PAGE);
            divider.setBackgroundColor(STROKE);
            emptyLabel.setTextColor(MUTED);
        });

        setVisibility(View.GONE);
    }

    private void readPalette() {
        PAGE = NativeBrowserActivity.C_CANVAS;
        CARD = NativeBrowserActivity.C_SURFACE;
        INK = NativeBrowserActivity.C_INK;
        MUTED = NativeBrowserActivity.C_MUTED;
        ACCENT = NativeBrowserActivity.C_ACCENT;
        ACCENT_SOFT = NativeBrowserActivity.C_ACCENT_SOFT;
        STROKE = NativeBrowserActivity.C_STROKE;
        PAGE_TOP = NativeBrowserActivity.C_TILE_TOP;
        TILE_BOTTOM = NativeBrowserActivity.C_TILE_BOTTOM;
    }

    void applyPalette() {
        retainPaletteAnchor();
        readPalette();
        palette.apply();
        cardPalette.apply();
    }

    /**
     * Coalesce the visible Shell/offset until this palette traversal's one pre-draw.
     * Real later inset traversals capture independently via retainInsetsAnchor(); a
     * palette callback alone cannot predict when the Window will next change padding.
     */
    void retainPaletteAnchor() {
        if (!isShowing() || revealOnLayout || paletteObserver != null) return;
        retainScrollPosition();
        paletteObserver = getViewTreeObserver();
        paletteAnchorRestore = new ViewTreeObserver.OnPreDrawListener() {
            @Override
            public boolean onPreDraw() {
                // A removed listener can still be in the observer's dispatch snapshot.
                if (paletteAnchorRestore != this) return true;
                removePaletteAnchorListener();
                if (isShowing() && restoreOnLayout) {
                    restoreScrollPosition();
                }
                return true;
            }
        };
        paletteObserver.addOnPreDrawListener(paletteAnchorRestore);
        // Drawable-only repaint need not request layout, but still needs one pre-draw to
        // consume/cancel the guard. No delayed retry, timer or additional pre-draw loop.
        invalidate();
    }

    /** Called by the existing root inset owner before it applies new padding. */
    void retainInsetsAnchor() {
        if (!isShowing() || revealOnLayout) return;
        retainPaletteAnchor();
        insetAnchorPending = true;
    }

    private void removePaletteAnchorListener() {
        if (paletteObserver == null) return;
        ViewTreeObserver observer = paletteObserver.isAlive() ? paletteObserver : getViewTreeObserver();
        if (observer.isAlive()) observer.removeOnPreDrawListener(paletteAnchorRestore);
        paletteObserver = null;
        paletteAnchorRestore = null;
    }

    /** Makes the switcher visible and reveals the active card after its first layout. */
    void show(List<TabItem> items) {
        if (isShowing()) {
            refresh(items);
            return;
        }
        cancelScrollWork();
        stopScrollAnimation();
        setVisibility(View.VISIBLE);
        setAlpha(0f);
        setTranslationY(dp(18));
        animate().alpha(1f).translationY(0f).setDuration(200).start();
        // New opens reveal the current active card; live refreshes keep their viewport.
        // Set this before refresh so a real reflow cannot capture the hidden viewport.
        revealOnLayout = true;
        refresh(items);
    }

    /** Preview/title/selection changes must not detach rows or reset a live scroll viewport. */
    void refresh(List<TabItem> items) {
        if (!isShowing()) return;
        int columns = columnCount();
        if (canUpdateCards(items, columns)) {
            shownItems = items == null ? new ArrayList<>() : new ArrayList<>(items);
            activeCard = null;
            for (int i = 0; i < cards.size(); i++) {
                CardBinding binding = cards.get(i);
                TabItem next = shownItems.get(i);
                TabItem previous = binding.item;
                Bitmap preview = next.preview != null && !next.preview.isRecycled() ? next.preview : null;
                if (previous.shell != next.shell || previous.active != next.active || previous.preview != next.preview
                        || !java.util.Objects.equals(previous.title, next.title)
                        || !java.util.Objects.equals(previous.displayUrl, next.displayUrl)
                        || binding.boundPreview != preview) {
                    binding.bind(next);
                }
                if (binding.item.active) activeCard = binding.card;
            }
            return;
        }
        retainScrollPosition();
        rebuild(items, columns);
    }

    private boolean canUpdateCards(List<TabItem> items, int columns) {
        int count = items == null ? 0 : items.size();
        if (columns != gridColumns || count != cards.size() || layoutMetricsChanged()) return false;
        for (int i = 0; i < count; i++) {
            if (cards.get(i).shellIdentity.get() != items.get(i).shell) return false;
        }
        return true;
    }

    /** Static headings also need new SP metrics; actual card reflow keeps its normal anchor. */
    void applyFontScale() {
        retainPaletteAnchor();
        staticFonts.apply();
        cardFonts.apply();
    }

    private boolean layoutMetricsChanged() {
        return gridDensity != getResources().getDisplayMetrics().density
                || Float.compare(gridFontScale, getResources().getConfiguration().fontScale) != 0;
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        // A real width/font/density change can require different rows or fresh sp/dp sizes.
        // A uiMode-only event has the same geometry and must retain every existing card.
        int width = View.MeasureSpec.getSize(widthMeasureSpec);
        if (measuredWidth != 0 && measuredWidth != width) insetAnchorPending = false;
        measuredWidth = width;
        int columns = columnCount(width);
        if (isShowing() && (columns != gridColumns || layoutMetricsChanged())) {
            retainScrollPosition();
            rebuild(shownItems, columns);
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec);
    }

    @Override
    protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        super.onLayout(changed, left, top, right, bottom);
        if (!isShowing()) return;
        // post() can run before measure/layout, when ScrollView still has the old/empty
        // range. Restore only after the replacement rows have their final bounds.
        if (revealOnLayout) {
            revealOnLayout = false;
            scrollToActiveCard();
        } else if (restoreOnLayout && paletteObserver == null) {
            restoreScrollPosition();
        }
    }

    void dismiss() {
        cancelScrollWork();
        setVisibility(View.GONE);
        stopScrollAnimation();
        // Keep only the last bounded card structure/identity metadata across GONE.
        // Neither ImageViews nor retained TabItems may keep old previews alive; published
        // bitmaps can still belong to display lists and must never be recycled here.
        shownItems.clear();
        for (CardBinding binding : cards) binding.releasePreview();
        activeCard = null;
    }

    /** Permanent teardown, separate from a warm ordinary dismiss. Safe to repeat. */
    void release() {
        dismiss();
        releaseCards();
        gridColumns = 0;
    }

    private void releaseCards() {
        cardPalette.clear();
        cardFonts.clear();
        for (CardBinding binding : cards) binding.release();
        cards.clear();
        activeCard = null;
        if (grid.getChildCount() > 0) grid.removeAllViews();
    }

    /** Settle native work at lifecycle boundaries, before it can overwrite an active-card reveal. */
    private void stopScrollAnimation() {
        boolean previous = internalScroll;
        internalScroll = true;
        try {
            // Outside the current range, even a zero-velocity fling can animate back from an edge.
            scroll.scrollTo(0, scroll.getScrollY());
            scroll.fling(0);
            // Consume its final absolute offset now, not on a frame after the next reveal.
            scroll.computeScroll();
        } finally {
            internalScroll = previous;
        }
    }

    private void cancelScrollWork() {
        removePaletteAnchorListener();
        revealOnLayout = false;
        restoreOnLayout = false;
        insetAnchorPending = false;
        anchorShell = null;
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) cancelScrollWork();
        return super.dispatchTouchEvent(event);
    }

    @Override
    public boolean dispatchGenericMotionEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_SCROLL) cancelScrollWork();
        return super.dispatchGenericMotionEvent(event);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) cancelScrollWork();
        return super.dispatchKeyEvent(event);
    }

    @Override
    protected void onDetachedFromWindow() {
        release();
        super.onDetachedFromWindow();
    }

    private void retainScrollPosition() {
        // Coalesced refreshes/palettes must not replace the original anchor with an
        // intermediate range clamp (whether from row replacement or Window/inset layout).
        // Keep the first-show reveal too.
        if (restoreOnLayout || revealOnLayout) return;
        savedScroll = scroll.getScrollY();
        anchorShell = null;
        for (CardBinding binding : cards) {
            View row = (View) binding.card.getParent();
            if (row != null && row.getBottom() > savedScroll) {
                anchorShell = binding.item.shell;
                anchorOffset = row.getTop() - savedScroll;
                break;
            }
        }
        restoreOnLayout = true;
    }

    private void scrollToActiveCard() {
        if (!isShowing() || activeCard == null) return;
        // super.onLayout may have created fresh native focus/size scrolling since show().
        stopScrollAnimation();
        View row = (View) activeCard.getParent();
        int top = row == null ? activeCard.getTop() : row.getTop();
        scrollInternallyTo(Math.max(0, top - dp(8)));
    }

    private void restoreScrollPosition() {
        int target = savedScroll;
        for (CardBinding binding : cards) {
            if (binding.item.shell == anchorShell) {
                View row = (View) binding.card.getParent();
                if (row != null) target = row.getTop() - anchorOffset;
                break;
            }
        }
        // Compare the UNCLAMPED logical target to the current real viewport range.
        // A late inset can enlarge the viewport after palette pre-draw and make this
        // target temporarily unreachable. Keep it dormant until a real later layout;
        // do not turn the already-clamped scrollY into the next transaction's anchor.
        int range = Math.max(0, grid.getHeight() - scroll.getHeight()
                + scroll.getPaddingTop() + scroll.getPaddingBottom());
        if (insetAnchorPending && (target < 0 || target > range)) return;
        restoreOnLayout = false;
        insetAnchorPending = false;
        anchorShell = null;
        target = Math.max(0, target);
        if (isShowing() && scroll.getScrollY() != target) scrollInternallyTo(target);
    }

    private void scrollInternallyTo(int target) {
        boolean previous = internalScroll;
        internalScroll = true;
        try {
            scroll.scrollTo(0, target);
        } finally {
            internalScroll = previous;
        }
    }

    private void cancelInsetAnchorForNavigation() {
        if (insetAnchorPending && !internalScroll && !layingOutScroll) cancelScrollWork();
    }

    /** Layout clamps are not new navigation; every outside-layout scroll is. */
    private final class AnchorScrollView extends ScrollView {
        AnchorScrollView(Context context) { super(context); }

        @Override
        protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
            boolean previous = layingOutScroll;
            layingOutScroll = true;
            try {
                super.onLayout(changed, left, top, right, bottom);
            } finally {
                layingOutScroll = previous;
            }
        }

        @Override
        public void scrollTo(int x, int y) {
            cancelInsetAnchorForNavigation();
            super.scrollTo(x, y);
        }

        @Override
        protected void onScrollChanged(int x, int y, int oldX, int oldY) {
            // Includes computeScroll/fling and Android's final smoothScroll methods.
            if (x != oldX || y != oldY) cancelInsetAnchorForNavigation();
            super.onScrollChanged(x, y, oldX, oldY);
        }

        @Override
        public void fling(int velocityY) {
            cancelInsetAnchorForNavigation();
            super.fling(velocityY);
        }

        @Override
        public boolean requestChildRectangleOnScreen(View child, Rect rectangle, boolean immediate) {
            cancelInsetAnchorForNavigation();
            return super.requestChildRectangleOnScreen(child, rectangle, immediate);
        }

        @Override
        public void requestChildFocus(View child, View focused) {
            cancelInsetAnchorForNavigation();
            super.requestChildFocus(child, focused);
        }

        @Override
        public boolean performAccessibilityAction(int action, Bundle arguments) {
            cancelInsetAnchorForNavigation();
            return super.performAccessibilityAction(action, arguments);
        }
    }

    boolean isShowing() {
        return getVisibility() == View.VISIBLE;
    }

    /** Compact chrome bar matching the browser address row: same surface, height, divider
     *  rhythm and icon-sized actions. The count is inline, not a second title line. */
    private LinearLayout buildHeader(Context context, TextView countLabel) {
        LinearLayout header = new LinearLayout(context);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setBackgroundColor(CARD);
        header.setPadding(dp(4), dp(4), dp(4), dp(4));
        header.setMinimumHeight(dp(56));

        TextView back = new TextView(context);
        back.setText("‹");
        staticFonts.bind(back, 23);
        back.setTextColor(INK);
        back.setGravity(Gravity.CENTER);
        back.setMinimumWidth(dp(48));
        back.setMinimumHeight(dp(48));
        back.setContentDescription("返回浏览器");
        back.setOnClickListener(view -> {
            if (!isShowing()) return;
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            if (listener != null) listener.onDismiss();
        });
        header.addView(back);

        TextView title = new TextView(context);
        title.setText("标签页");
        staticFonts.bind(title, 18);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setTextColor(INK);
        title.setSingleLine(true);
        LinearLayout.LayoutParams titleLayout = new LinearLayout.LayoutParams(-2, -2);
        titleLayout.setMargins(dp(6), 0, 0, 0);
        header.addView(title, titleLayout);

        staticFonts.bind(countLabel, 12.5f);
        countLabel.setTextColor(MUTED);
        countLabel.setSingleLine(true);
        LinearLayout.LayoutParams countLayout = new LinearLayout.LayoutParams(0, -2, 1);
        countLayout.setMargins(dp(6), 0, dp(8), 0);
        header.addView(countLabel, countLayout);

        TextView create = new TextView(context);
        create.setText("＋");
        staticFonts.bind(create, 24);
        create.setTextColor(ACCENT);
        create.setGravity(Gravity.CENTER);
        create.setMinimumWidth(dp(48));
        create.setMinimumHeight(dp(48));
        create.setContentDescription("新建标签页");
        create.setOnClickListener(view -> {
            if (!isShowing()) return;
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            if (listener != null) listener.onNewTab();
        });
        header.addView(create);
        palette.add(() -> {
            header.setBackgroundColor(CARD);
            back.setTextColor(INK);
            title.setTextColor(INK);
            countLabel.setTextColor(MUTED);
            create.setTextColor(ACCENT);
        });
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
        staticFonts.bind(label, 12.5f);
        label.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        label.setTextColor(MUTED);
        label.setSingleLine(true);
        label.setEllipsize(TextUtils.TruncateAt.END);
        row.addView(label, new LinearLayout.LayoutParams(0, -2, 1));

        TextView hint = new TextView(context);
        hint.setText("点按卡片切换 · × 关闭");
        staticFonts.bind(hint, 11);
        hint.setTextColor(MUTED);
        hint.setSingleLine(true);
        LinearLayout.LayoutParams hintLayout = new LinearLayout.LayoutParams(-2, -2);
        hintLayout.setMargins(dp(8), 0, 0, 0);
        row.addView(hint, hintLayout);
        palette.add(() -> {
            label.setTextColor(MUTED);
            hint.setTextColor(MUTED);
        });
        return row;
    }

    private void rebuild(List<TabItem> items, int columns) {
        // A real tab/metrics reflow uses the normal one-layout anchor and clamp rules.
        insetAnchorPending = false;
        shownItems = items == null ? new ArrayList<>() : new ArrayList<>(items);
        gridColumns = columns;
        gridDensity = getResources().getDisplayMetrics().density;
        gridFontScale = getResources().getConfiguration().fontScale;
        releaseCards();
        int count = shownItems.size();
        countLabel.setText("· " + count);
        if (count == 0) {
            emptyLabel.setVisibility(View.VISIBLE);
            grid.addView(emptyLabel, new LinearLayout.LayoutParams(-1, -2));
            return;
        }
        emptyLabel.setVisibility(View.GONE);
        for (int start = 0; start < count; start += columns) {
            LinearLayout row = new LinearLayout(getContext());
            row.setOrientation(LinearLayout.HORIZONTAL);
            int end = Math.min(start + columns, count);
            for (int i = start; i < end; i++) {
                CardBinding binding = makeCard(shownItems.get(i));
                cards.add(binding);
                cardPalette.add(binding::applyPalette);
                row.addView(binding.card, cardLayout());
                if (binding.item.active) activeCard = binding.card;
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

    private CardBinding makeCard(TabItem item) {
        return new CardBinding(item);
    }

    /** Stable card identity; preview height has a 122dp floor, not a large-font cap. */
    private final class CardBinding {
        private TabItem item;
        // Hidden cards keep identity for reuse, never ownership of a possibly closed Shell.
        private final WeakReference<Shell> shellIdentity;
        private Bitmap boundPreview;
        private final LinearLayout card;
        private final FrameLayout preview;
        private final ImageView image;
        private final LinearLayout placeholder;
        private final TextView avatar;
        private final TextView hostLabel;
        private final TextView note;
        private final TextView close;
        private final TextView title;
        private final TextView badge;
        private final TextView url;
        private final GradientDrawable previewBackground;
        private final GradientDrawable closeBackground;

        CardBinding(TabItem item) {
            shellIdentity = new WeakReference<>(item.shell);
            Context context = getContext();
            card = new LinearLayout(context) {
                @Override
                protected void onMeasure(int widthSpec, int heightSpec) {
                    // Measure owned placeholder text at its real width, even behind a bitmap.
                    int width = Math.max(0, View.MeasureSpec.getSize(widthSpec)
                            - getPaddingLeft() - getPaddingRight());
                    placeholder.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
                    preview.getLayoutParams().height = Math.max(dp(122), placeholder.getMeasuredHeight());
                    super.onMeasure(widthSpec, heightSpec);
                }
            };
            card.setOrientation(LinearLayout.VERTICAL);
            card.setBackground(stroked(item.active));
            card.setForeground(new android.graphics.drawable.RippleDrawable(
                    android.content.res.ColorStateList.valueOf(NativeBrowserActivity.C_RIPPLE), null, rounded(CARD, 18)));
            card.setPadding(dp(6), dp(6), dp(6), dp(12));
            card.setOnClickListener(view -> {
                if (!isShowing() || this.item == null) return;
                view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
                if (listener != null) listener.onSelect(this.item.shell);
            });

            preview = new FrameLayout(context);
            previewBackground = new GradientDrawable(
                    GradientDrawable.Orientation.TOP_BOTTOM, new int[]{PAGE_TOP, TILE_BOTTOM});
            previewBackground.setCornerRadius(dp(14));
            preview.setBackground(previewBackground);
            card.addView(preview, new LinearLayout.LayoutParams(-1, dp(122)));

            image = new ImageView(context);
            image.setScaleType(ImageView.ScaleType.CENTER_CROP);
            preview.addView(image, new FrameLayout.LayoutParams(-1, -1));

            placeholder = new LinearLayout(context);
            placeholder.setOrientation(LinearLayout.VERTICAL);
            placeholder.setGravity(Gravity.CENTER_HORIZONTAL | Gravity.CENTER_VERTICAL);
            avatar = (TextView) makeAvatar(context, cardTitle(item));
            placeholder.addView(avatar, new LinearLayout.LayoutParams(dp(56), dp(56)));
            hostLabel = new TextView(context);
            cardFonts.bind(hostLabel, 11);
            hostLabel.setSingleLine(true);
            hostLabel.setEllipsize(TextUtils.TruncateAt.END);
            hostLabel.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams hostLayout = new LinearLayout.LayoutParams(-2, -2);
            hostLayout.topMargin = dp(8);
            hostLayout.leftMargin = dp(10);
            hostLayout.rightMargin = dp(10);
            placeholder.addView(hostLabel, hostLayout);
            note = new TextView(context);
            note.setText("暂无实时预览");
            cardFonts.bind(note, 12);
            note.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams noteLayout = new LinearLayout.LayoutParams(-2, -2);
            noteLayout.topMargin = dp(2);
            placeholder.addView(note, noteLayout);
            preview.addView(placeholder, new FrameLayout.LayoutParams(-1, -1));

            close = new TextView(context);
            close.setText("×");
            cardFonts.bind(close, 14);
            close.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            close.setGravity(Gravity.CENTER);
            closeBackground = new GradientDrawable();
            closeBackground.setCornerRadius(dp(24));
            close.setBackground(closeBackground);
            close.setElevation(dp(1));
            close.setOnClickListener(view -> {
                if (!isShowing() || this.item == null) return;
                view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
                if (listener != null) listener.onClose(this.item.shell);
            });
            FrameLayout.LayoutParams closeLayout =
                    new FrameLayout.LayoutParams(dp(48), dp(48), Gravity.TOP | Gravity.END);
            closeLayout.setMargins(0, dp(6), dp(6), 0);
            preview.addView(close, closeLayout);

            LinearLayout info = new LinearLayout(context);
            info.setOrientation(LinearLayout.HORIZONTAL);
            info.setGravity(Gravity.CENTER_VERTICAL);
            info.setPadding(dp(10), dp(9), dp(4), 0);
            card.addView(info, new LinearLayout.LayoutParams(-1, -2));
            title = new TextView(context);
            cardFonts.bind(title, 13);
            title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            title.setSingleLine(true);
            title.setEllipsize(TextUtils.TruncateAt.END);
            info.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
            badge = new TextView(context);
            badge.setText("当前");
            cardFonts.bind(badge, 10);
            badge.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            badge.setPadding(dp(6), dp(2), dp(2), dp(2));
            info.addView(badge, new LinearLayout.LayoutParams(-2, -2));
            url = new TextView(context);
            cardFonts.bind(url, 11.5f);
            url.setSingleLine(true);
            url.setEllipsize(TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams urlLayout = new LinearLayout.LayoutParams(-1, -2);
            urlLayout.setMargins(dp(8), dp(2), dp(8), 0);
            card.addView(url, urlLayout);
            bind(item);
        }

        void bind(TabItem next) {
            TabItem previous = item;
            item = next;
            if (previous == null || !java.util.Objects.equals(previous.title, item.title)) {
                String label = cardTitle(item);
                setTextIfChanged(title, label);
                setTextIfChanged(avatar, label.isEmpty() ? "•" : new String(Character.toChars(label.codePointAt(0))));
                String selectLabel = "切换到标签页：" + label;
                String closeLabel = "关闭标签页：" + label;
                if (card.getContentDescription() == null
                        || !selectLabel.contentEquals(card.getContentDescription())) card.setContentDescription(selectLabel);
                if (close.getContentDescription() == null
                        || !closeLabel.contentEquals(close.getContentDescription())) close.setContentDescription(closeLabel);
            }
            if (previous == null || !java.util.Objects.equals(previous.displayUrl, item.displayUrl)) {
                String subtitle = cardSubtitle(item);
                setTextIfChanged(url, subtitle);
                setTextIfChanged(hostLabel, subtitle);
                boolean blank = item.displayUrl != null && item.displayUrl.startsWith("about:blank");
                note.setVisibility(blank ? View.GONE : View.VISIBLE);
            }
            if (previous == null || previous.active != item.active) {
                badge.setVisibility(item.active ? View.VISIBLE : View.GONE);
                card.setElevation(item.active ? dp(3) : dp(1.5f));
                // Initial palette application belongs to the binding registration below;
                // only a later selection change needs to repaint as part of a data bind.
                if (previous != null) applyPalette();
            }
            Bitmap nextPreview = item.preview != null && !item.preview.isRecycled() ? item.preview : null;
            if (boundPreview != nextPreview || previous == null) {
                if (boundPreview != nextPreview) image.setImageBitmap(nextPreview);
                boundPreview = nextPreview;
                image.setVisibility(nextPreview == null ? View.GONE : View.VISIBLE);
                placeholder.setVisibility(nextPreview == null ? View.VISIBLE : View.GONE);
            }
        }

        void releasePreview() {
            clearPreview();
            if (item.shell != null || item.preview != null) {
                item = new TabItem(null, item.title, item.displayUrl, item.active, null);
            }
        }

        private void clearPreview() {
            if (boundPreview != null) image.setImageBitmap(null);
            boundPreview = null;
            image.setVisibility(View.GONE);
            placeholder.setVisibility(View.VISIBLE);
        }

        void release() {
            clearPreview();
            shellIdentity.clear();
            item = null;
            card.setOnClickListener(null);
            close.setOnClickListener(null);
        }

        void applyPalette() {
            GradientDrawable surface = (GradientDrawable) card.getBackground();
            surface.setColor(CARD);
            surface.setStroke(dp(item.active ? 2 : 1), item.active ? ACCENT : STROKE);
            ((android.graphics.drawable.RippleDrawable) card.getForeground()).setColor(
                    android.content.res.ColorStateList.valueOf(NativeBrowserActivity.C_RIPPLE));
            previewBackground.setColors(new int[]{PAGE_TOP, TILE_BOTTOM});
            hostLabel.setTextColor(MUTED);
            note.setTextColor(MUTED);
            close.setTextColor(MUTED);
            closeBackground.setColor((CARD & 0x00FFFFFF) | 0xF2000000);
            closeBackground.setStroke(dp(1), STROKE);
            title.setTextColor(item.active ? ACCENT : INK);
            badge.setTextColor(ACCENT);
            url.setTextColor(MUTED);
        }
    }

    private static void setTextIfChanged(TextView view, String value) {
        if (!value.contentEquals(view.getText())) view.setText(value);
    }

    private View makeAvatar(Context context, String label) {
        TextView avatar = new TextView(context);
        avatar.setText(label.isEmpty() ? "•" : new String(Character.toChars(label.codePointAt(0))));
        cardFonts.bind(avatar, 18);
        avatar.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        avatar.setGravity(Gravity.CENTER);
        GradientDrawable background = rounded(ACCENT_SOFT, 28);
        avatar.setBackground(background);
        cardPalette.add(() -> {
            avatar.setTextColor(ACCENT);
            background.setColor(ACCENT_SOFT);
        });
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
        return columnCount(width);
    }

    private int columnCount(int width) {
        float widthDp = width / getResources().getDisplayMetrics().density;
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
