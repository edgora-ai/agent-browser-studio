package com.ahoo.abs.android;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ScrollView;
import android.widget.TextView;
import com.ahoo.abs.android.data.BootstrapStore;
import com.ahoo.abs.android.data.ManagedProxy;
import com.ahoo.abs.android.data.ProfileRepository;
import com.ahoo.abs.android.process.LaunchCoordinator;
import com.ahoo.abs.android.process.BrowserProcessOwner;
import com.ahoo.abs.android.webapp.WebApp;
import com.ahoo.abs.android.webapp.WebAppRegistry;
import com.ahoo.abs.android.webapp.WebAppShortcuts;
import com.ahoo.abs.core.ProfileSpec;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/** Exported launcher accepts no external profile, URL, identity or proxy extras. */
public final class MainActivity extends Activity {
    public static final String ACTION_REQUEST_ENVIRONMENT_EXIT =
            "com.ahoo.abs.android.REQUEST_ENVIRONMENT_EXIT";
    private ProfileRepository repository;
    private BootstrapStore bootstrap;
    private LaunchCoordinator coordinator;
    private LinearLayout list;
    private TextView runtime;
    private TextView section;
    private FrameLayout segmentControl;
    private EditText search;
    private View create;
    private Ui.Sheet runtimeSheet;
    private Button runtimeExit;
    private BootstrapStore.ActiveLaunch active;
    private boolean runtimeKnown;
    private int selected;
    private Runnable runtimeObserver;
    private OpenTarget queuedOpen;
    private String pendingShortcutId;
    private long launchGeneration;
    private boolean foreground;
    private final Handler main = new Handler(Looper.getMainLooper());
    private List<ProfileSpec> profiles = new ArrayList<>();
    private List<ManagedProxy> proxies = new ArrayList<>();
    private final Map<String, String> proxyLinks = new HashMap<>();
    private final Map<String, Integer> proxyUsage = new HashMap<>();
    private String renderedSignature;
    private boolean sortByName;
    private TextView sortToggle;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (state != null) selected = state.getInt("section", 0) == 1 ? 1 : 0;
        LinearLayout root = Ui.root(this);

        LinearLayout brand = Ui.row(this);
        TextView heading = Ui.display(this, "浏览环境");
        heading.setTextSize(21);
        heading.setMaxLines(1);
        heading.setEllipsize(TextUtils.TruncateAt.END);
        brand.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout tools = Ui.row(this);
        tools.setBackground(Ui.shape(this, Ui.WHITE, 24));
        create = Ui.iconButton(this, Ui.Glyph.PLUS, "新建环境", Ui.INK, v -> createItem());
        create.setMinimumWidth(dp(48));
        create.setMinimumHeight(dp(48));
        tools.addView(create, new LinearLayout.LayoutParams(-2, -2));
        FrameLayout more = Ui.iconButton(this, Ui.Glyph.MENU, "更多设置", Ui.INK, this::showMore);
        more.setMinimumWidth(dp(48));
        more.setMinimumHeight(dp(48));
        tools.addView(more, new LinearLayout.LayoutParams(-2, -2));
        Ui.applyEnabledLook(create, false);
        brand.addView(tools);
        root.addView(brand, Ui.gap(this, 2));

        runtime = Ui.styled(this, "正在读取运行状态…", 14, Ui.MUTED,
                android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.NORMAL));
        runtime.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        runtime.setElevation(0);
        int padH = dp(2);
        int padV = dp(12);
        runtime.setPadding(padH, padV, padH, padV);
        runtime.setMinimumHeight(dp(48));
        runtime.setMaxLines(2);
        runtime.setEllipsize(TextUtils.TruncateAt.END);
        runtime.setOnClickListener(v -> showRuntime());
        root.addView(runtime, Ui.gap(this, 4));

        String[] labels = {"环境", "代理"};
        segmentControl = Ui.segmented(this, labels, new int[]{-1, -1}, selected, index -> {
            if (selected != index) {
                selected = index;
                search.setText("");
                render();
            }
        });
        root.addView(segmentControl, Ui.gap(this, 2));

        search = Ui.searchField(this);
        search.setHint(selected == 0 ? "搜索环境名称、代理或时区" : "搜索代理名称、地址或协议");
        LinearLayout searchSurface = Ui.searchSurface(this, search);
        root.addView(searchSurface, Ui.gap(this, 12));

        LinearLayout sectionRow = Ui.row(this);
        section = Ui.heading(this, "所有环境");
        sectionRow.addView(section, new LinearLayout.LayoutParams(0, -2, 1));
        sortToggle = Ui.caption(this, "智能排序  ↓");
        sortToggle.setMinHeight(dp(48));
        sortToggle.setGravity(Gravity.CENTER);
        sortToggle.setPadding(dp(10), 0, dp(4), 0);
        sortToggle.setOnClickListener(v -> {
            Ui.haptic(v);
            sortByName = !sortByName;
            render(false);
        });
        sectionRow.addView(sortToggle);
        sectionRow.setPadding(dp(2), dp(16), dp(2), dp(8));
        root.addView(sectionRow);

        ScrollView scroll = new ScrollView(this);
        scroll.setClipToPadding(false);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setFillViewport(true);
        list = Ui.column(this);
        scroll.addView(list);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

        TextView footerNote = Ui.caption(this, "ABS Browser  ·  独立环境，单个运行");
        footerNote.setGravity(Gravity.CENTER);
        footerNote.setPadding(0, dp(12), 0, dp(4));
        root.addView(footerNote);

        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s,int start,int count,int after) { }
            @Override public void onTextChanged(CharSequence s,int start,int before,int count) {
                // Debounced: typing never rebuilds the list per keystroke.
                main.removeCallbacks(searchRender);
                main.postDelayed(searchRender, 180);
            }
            @Override public void afterTextChanged(Editable value) { }
        });
        if (state != null) search.setText(state.getString("query", ""));
        try {
            repository = new ProfileRepository(this); // The manager alone may perform the additive migration.
            bootstrap = new BootstrapStore(this);
            coordinator = LaunchCoordinator.get(this);
            runtimeObserver = () -> { if (!isFinishing() && !isDestroyed()) reload(); };
            coordinator.observe(runtimeObserver); reload();
            consumeExitRequest(getIntent());
            if (state == null) receiveWebAppShortcut(getIntent());
        } catch (RuntimeException failure) {
            runtime.setText("配置存储不可用（" + Ui.errorCode(failure) + "）");
            Ui.applyEnabledLook(create, false);
        }
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    () -> moveTaskToBack(true));
        }
    }

    @Override protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        consumeExitRequest(intent);
        receiveWebAppShortcut(intent);
        dispatchWebAppShortcut();
    }

    private boolean supportsWebApps() {
        return getApplication() instanceof BrowserProcessOwner
                && ((BrowserProcessOwner) getApplication()).supportsWebApps();
    }

    private void receiveWebAppShortcut(Intent intent) {
        pendingShortcutId = supportsWebApps() ? WebAppShortcuts.shortcutId(this, intent) : null;
        if (WebAppShortcuts.isShortcutIntent(this, intent)) setIntent(new Intent(this, MainActivity.class));
    }

    private void dispatchWebAppShortcut() {
        if (!foreground || pendingShortcutId == null || repository == null || coordinator == null
                || isFinishing() || isDestroyed()) return;
        String id = pendingShortcutId;
        pendingShortcutId = null;
        try (WebAppRegistry registry = new WebAppRegistry(this)) {
            WebApp app = registry.get(id);
            if (app == null || WebAppShortcuts.pinState(this, id) != WebAppShortcuts.PinState.CONFIRMED) {
                Ui.snackbar(this, "此网页应用的桌面入口已失效。");
                return;
            }
            openInstalledWebApp(app);
        } catch (RuntimeException failure) { showError(failure); }
    }

    private void openInstalledWebApp(WebApp app) {
        ProfileSpec profile = repository.findProfile(app.profileId);
        if (profile == null) {
            Ui.snackbar(this, "网页应用所属环境已删除，未打开网页。");
            return;
        }
        openProfile(profile, app);
    }

    /** Exported launcher never executes stop directly from an Intent. Require a matching
     * live session and nonce, then a fresh user confirmation in the manager process. */
    private void consumeExitRequest(android.content.Intent intent) {
        if (intent == null || !ACTION_REQUEST_ENVIRONMENT_EXIT.equals(intent.getAction())) return;
        intent.setAction(null);
        String session;
        String nonce;
        try {
            session = intent.getStringExtra(com.ahoo.abs.android.browser.ControlProtocol.SESSION);
            nonce = intent.getStringExtra(com.ahoo.abs.android.browser.ControlProtocol.NONCE);
            intent.removeExtra(com.ahoo.abs.android.browser.ControlProtocol.SESSION);
            intent.removeExtra(com.ahoo.abs.android.browser.ControlProtocol.NONCE);
            if (bootstrap == null || coordinator == null) return;
            BootstrapStore.ActiveLaunch observed = bootstrap.readActive();
            if (observed == null || !observed.launch.sessionId.equals(session)
                    || !observed.launch.nonce.equals(nonce)) return;
            confirmEnvironmentExit(observed.launch.sessionId);
        } catch (RuntimeException rejected) {
            // Malformed or stale external intents cannot control a running environment.
        }
    }

    private void confirmEnvironmentExit(String expectedSession) {
        if (expectedSession == null || bootstrap == null || coordinator == null) return;
        try {
            BootstrapStore.ActiveLaunch target = bootstrap.readActive();
            if (target == null || !expectedSession.equals(target.launch.sessionId)) {
                reload();
                return;
            }
            Ui.Sheet sheet = Ui.Sheet.create(this, "退出当前环境？", null);
            sheet.text("环境：" + target.launch.profile.name
                    + "\n\n关闭所有浏览标签页并尝试保存网站数据，然后返回环境列表。未提交的网页内容可能丢失。");
            sheet.actions("取消", null, "退出环境", () -> {
                sheet.dialog().dismiss();
                try {
                    BootstrapStore.ActiveLaunch observed = bootstrap.readActive();
                    if (observed == null || !expectedSession.equals(observed.launch.sessionId)) {
                        reload();
                        return;
                    }
                    queuedOpen = null;
                    launchGeneration++;
                    coordinator.stop();
                } catch (RuntimeException failure) { showError(failure); }
            }).show();
        } catch (RuntimeException failure) { showError(failure); }
    }

    @Override public void onBackPressed() {
        // The retained browser may sit underneath this manager in the same task.
        // Background the task instead of finishing the manager and revealing it again.
        moveTaskToBack(true);
    }

    private int dp(int value) { return Ui.dp(this, value); }

    @Override protected void onResume() {
        super.onResume(); foreground = true;
        if (repository != null && coordinator != null) { coordinator.reconcile(); reload(); }
        dispatchWebAppShortcut();
    }
    @Override protected void onPause() {
        foreground = false; launchGeneration++;
        queuedOpen = null; // Do not launch a deferred environment after the manager loses foreground.
        pendingShortcutId = null;
        if (coordinator != null) coordinator.cancelWebAppOpen();
        super.onPause();
    }
    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state); state.putInt("section", selected);
        state.putString("query", search == null ? "" : search.getText().toString());
    }

    private void reload() {
        try {
            profiles = repository.listProfiles(); proxies = repository.listProxies();
            proxyLinks.clear(); proxyUsage.clear();
            for (ProfileSpec profile : profiles) {
                String proxyId = repository.proxyIdForProfile(profile.id);
                if (proxyId != null) {
                    proxyLinks.put(profile.id, proxyId);
                    Integer count = proxyUsage.get(proxyId);
                    proxyUsage.put(proxyId, count == null ? 1 : count + 1);
                }
            }
            active = bootstrap.readActive(); runtimeKnown = true;
            if (active == null) {
                runtime.setText("●  当前没有打开的环境 · 单环境运行");
                runtime.setTextColor(Ui.MUTED);
            } else {
                String suffix;
                switch (active.state) {
                    case CLAIMED: suffix = " 正在运行"; break;
                    case PUBLISHED: suffix = " · 正在启动…"; break;
                    default: suffix = " · 等待退出确认"; break;
                }
                runtime.setText("●  " + active.launch.profile.name + suffix);
                runtime.setTextColor(active.state == BootstrapStore.State.EXIT_UNCONFIRMED
                        || active.state == BootstrapStore.State.REVOKED ? Ui.WARNING : Ui.ACCENT);
            }
            if (active == null && queuedOpen != null) {
                OpenTarget pending = queuedOpen; queuedOpen = null;
                long token = launchGeneration;
                main.post(() -> {
                    if (foreground && token == launchGeneration && !isFinishing() && !isDestroyed()) {
                        dispatchOpen(pending);
                    }
                });
            }
            render();
        } catch (RuntimeException failure) {
            runtimeKnown = false; renderedSignature = null; queuedOpen = null; launchGeneration++;
            runtime.setText("读取失败（" + Ui.errorCode(failure) + "），未将现有配置视为空。" );
            Ui.applyEnabledLook(create, false);
            list.removeAllViews(); list.addView(Ui.muted(this, "暂时无法显示配置，请在运行状态中重新核对。", 14));
        } finally {
            updateRuntimeSheet();
        }
    }

    private final Runnable searchRender = () -> render(false);

    private void render() { render(true); }

    private void render(boolean animate) {
        if (list == null) return;
        Ui.selectSegment(segmentControl, selected, new int[]{profiles.size(), proxies.size()});
        search.setHint(selected == 0 ? "搜索环境名称、代理或时区" : "搜索代理名称、地址或协议");
        create.setContentDescription(selected == 0 ? "新建环境" : "新建代理");
        Ui.applyEnabledLook(create, repository != null && runtimeKnown);
        String query = search.getText().toString().trim().toLowerCase(Locale.ROOT);
        // Skip the whole rebuild when nothing visible changed (status ticks, reconcile calls).
        String activeKey = active == null ? "none"
                : active.state.name() + ":" + active.launch.sessionId + ":"
                + active.launch.profile.id + ":" + active.launch.profile.revision;
        StringBuilder signature = new StringBuilder(selected + "|" + query + "|" + sortByName + "|" + activeKey
                + "|" + profiles.size() + "|" + proxies.size());
        for (ProfileSpec profile : profiles) signature.append('|').append(profile.id).append(':').append(profile.revision);
        for (ManagedProxy proxy : proxies) signature.append('|').append(proxy.id).append(':').append(proxy.revision);
        String signatureValue = signature.toString();
        boolean listChanged = !signatureValue.equals(renderedSignature);
        renderedSignature = signatureValue;
        if (!listChanged) return;
        list.removeAllViews();
        int shown = 0;
        if (selected == 0) {
            List<ProfileSpec> visible = new ArrayList<>();
            for (ProfileSpec profile : profiles) {
                if (matches(query, profile.name, routeLabel(profile), profile.timeZoneId,
                        String.join(",", profile.languageTags))) visible.add(profile);
            }
            if (sortByName) {
                java.text.Collator collator = java.text.Collator.getInstance(Locale.CHINA);
                visible.sort((a, b) -> collator.compare(a.name, b.name));
            } else {
                // Running/launching environment floats to the top; the rest keep storage order.
                // Boolean.compare(true, false) is +1, so the active flag must be compared reversed.
                visible.sort((a, b) -> Boolean.compare(isActive(b), isActive(a)));
            }
            for (ProfileSpec profile : visible) { addCard(profileCard(profile, query), animate); shown++; }
        } else {
            List<ManagedProxy> visible = new ArrayList<>();
            for (ManagedProxy proxy : proxies) {
                if (matches(query, proxy.name, proxy.proxy.authority(), proxy.proxy.scheme.name())) visible.add(proxy);
            }
            if (sortByName) {
                java.text.Collator collator = java.text.Collator.getInstance(Locale.CHINA);
                visible.sort((a, b) -> collator.compare(a.name, b.name));
            }
            for (ManagedProxy proxy : visible) { addCard(proxyCard(proxy, query), animate); shown++; }
        }
        section.setText((selected == 0 ? "所有环境" : "代理资源") + "  ·  " + shown);
        sortToggle.setText(sortByName ? "按名称  ↓" : "智能排序  ↓");
        if (shown == 0) {
            LinearLayout empty = Ui.emptyState(this,
                    query.isEmpty() ? (selected == 0 ? "创建你的第一个环境" : "把代理集中管理") : "没有匹配结果",
                    query.isEmpty() ? (selected == 0
                            ? "环境拥有独立的时区、语言与站点数据，可选择直连或代理出口。"
                            : "添加一次代理，即可供多个环境复用。保存不代表出口实测通过。")
                            : "试试其他名称、地址或时区关键词。");
            if (!query.isEmpty()) {
                Button clear = wrapButton(Ui.ghost(this, "清空搜索", v -> search.setText("")));
                LinearLayout.LayoutParams clearLp = new LinearLayout.LayoutParams(-2, -2);
                clearLp.topMargin = dp(12);
                clearLp.gravity = Gravity.CENTER_HORIZONTAL;
                empty.addView(clear, clearLp);
            }
            addCard(empty, animate);
        }
        if (selected == 1 && shown > 0) {
            TextView note = Ui.caption(this,
                    "修改共享出口会同步更新引用它的环境；使用中的环境需先退出。不支持代理认证，不会自动直连回退。");
            note.setPadding(dp(2), dp(6), dp(2), dp(10));
            list.addView(note);
        }
    }

    private boolean isActive(ProfileSpec profile) {
        return active != null && active.state != BootstrapStore.State.EXIT_CONFIRMED
                && active.launch.profile.id.equals(profile.id);
    }

    /** Route labels never infer direct from a missing catalog reference. */
    private static String routeLabel(ProfileSpec profile) {
        return profile.isDirect() ? "不使用代理（直连）"
                : profile.proxy.scheme.name() + " · " + profile.proxy.authority();
    }

    /** Which non-name field matched, for a small reason chip on filtered results. */
    private String matchReason(String query, ProfileSpec profile) {
        if (profile.name.toLowerCase(Locale.ROOT).contains(query)) return null;
        if (routeLabel(profile).toLowerCase(Locale.ROOT).contains(query)) return "出口匹配";
        if (profile.timeZoneId.toLowerCase(Locale.ROOT).contains(query)) return "时区匹配";
        if (String.join(",", profile.languageTags).toLowerCase(Locale.ROOT).contains(query)) return "语言匹配";
        return null;
    }

    /** Accent-highlight the first matched substring of a card title. */
    private CharSequence highlighted(String text, String query) {
        if (query.isEmpty()) return text;
        String lowered = text.toLowerCase(Locale.ROOT);
        // A lowercase pass can change length (İ etc.); span only when offsets stay 1:1.
        if (lowered.length() != text.length()) return text;
        int index = lowered.indexOf(query);
        if (index < 0) return text;
        android.text.SpannableString span = new android.text.SpannableString(text);
        span.setSpan(new android.text.style.StyleSpan(android.graphics.Typeface.BOLD), index,
                index + query.length(), android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        span.setSpan(new android.text.style.ForegroundColorSpan(Ui.ACCENT), index,
                index + query.length(), android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return span;
    }

    private boolean matches(String query, String... values) {
        if (query.isEmpty()) return true;
        for (String value : values) if (value.toLowerCase(Locale.ROOT).contains(query)) return true;
        return false;
    }
    private void addCard(LinearLayout card, boolean animate) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(4);
        list.addView(card, params);
        if (animate) Ui.animateIn(card);
    }
    private LinearLayout listRow(boolean selectedRow) {
        LinearLayout row = Ui.column(this);
        row.setPadding(dp(12), dp(10), dp(8), dp(10));
        row.setMinimumHeight(dp(68));
        row.setBackground(new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(Ui.DARK ? 0x18FFFFFF : 0x10000000),
                Ui.shape(this, selectedRow ? Ui.SURFACE_SOFT : Ui.BG, 14), null));
        return row;
    }

    private TextView itemHeading(LinearLayout row, String name, String subtitle, boolean running, View.OnClickListener menu) {
        LinearLayout heading = Ui.row(this);
        View icon = Ui.icon(this, Ui.Glyph.FOLDER, Ui.INK_SOFT, 22);
        heading.addView(icon, new LinearLayout.LayoutParams(dp(22), dp(22)));
        LinearLayout title = Ui.column(this);
        title.setPadding(dp(12), 0, dp(4), 0);
        TextView titleText = Ui.body(this, name);
        titleText.setTextSize(16);
        titleText.setTextColor(Ui.INK);
        titleText.setMaxLines(2);
        titleText.setEllipsize(TextUtils.TruncateAt.END);
        title.addView(titleText);
        TextView detail = Ui.muted(this, (running ? "运行中  ·  " : "") + subtitle, 14);
        detail.setMaxLines(2);
        detail.setEllipsize(TextUtils.TruncateAt.END);
        detail.setPadding(0, dp(5), 0, 0);
        title.addView(detail);
        heading.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        FrameLayout more = Ui.iconButton(this, Ui.Glyph.MENU, name + " 更多操作", Ui.MUTED, menu);
        more.setMinimumWidth(dp(48));
        more.setMinimumHeight(dp(48));
        heading.addView(more, new LinearLayout.LayoutParams(-2, -2));
        row.addView(heading);
        row.setLongClickable(true);
        row.setOnLongClickListener(v -> { Ui.haptic(v); menu.onClick(v); return true; });
        return titleText;
    }

    private LinearLayout profileCard(ProfileSpec profile, String query) {
        boolean running = active != null && active.state == BootstrapStore.State.CLAIMED
                && active.launch.profile.id.equals(profile.id);
        boolean launching = active != null && active.state == BootstrapStore.State.PUBLISHED
                && active.launch.profile.id.equals(profile.id);
        boolean exiting = active != null && active.launch.profile.id.equals(profile.id)
                && (active.state == BootstrapStore.State.EXIT_UNCONFIRMED
                || active.state == BootstrapStore.State.REVOKED);
        String ownedSession = active == null ? null : active.launch.sessionId;
        LinearLayout card = listRow(running || exiting || launching);
        String proxyName = routeLabel(profile);
        for (ManagedProxy proxy : proxies) {
            if (proxy.id.equals(proxyLinks.get(profile.id))) { proxyName = proxy.name; break; }
        }
        String summary = proxyName + "  ·  " + profile.timeZoneId;
        if (exiting) summary = "退出待确认  ·  可重试退出";
        else if (launching) summary = "正在启动，请稍候";
        TextView titleText = itemHeading(card, profile.name, summary,
                running, v -> profileMenu(v, profile));
        titleText.setText(highlighted(profile.name, query));
        card.setOnClickListener(v -> {
            if (exiting) showRuntime(); else openProfile(profile);
        });
        String reason = query.isEmpty() ? null : matchReason(query, profile);
        if (reason != null) {
            TextView reasonText = Ui.caption(this, reason);
            reasonText.setPadding(dp(34), dp(4), 0, 0);
            card.addView(reasonText);
        }
        if (profile.deviceMode != ProfileSpec.DeviceMode.NATIVE) {
            TextView warning = Ui.caption(this, "声明型号未校准，无法作为完整设备模拟启动");
            warning.setTextColor(Ui.WARNING);
            warning.setPadding(0, dp(4), 0, 0);
            card.addView(warning);
        } else if (!android.os.Build.MODEL.equals(profile.deviceModel)) {
            TextView warning = Ui.caption(this, "该环境声明的型号与本机不一致，当前内核无法启动");
            warning.setTextColor(Ui.WARNING);
            warning.setPadding(0, dp(4), 0, 0);
            card.addView(warning);
        }
        if (running || exiting) {
            LinearLayout actions = Ui.row(this);
            boolean stacked = getResources().getConfiguration().screenWidthDp < 360
                    || getResources().getConfiguration().fontScale >= 1.3f;
            actions.setOrientation(stacked ? LinearLayout.VERTICAL : LinearLayout.HORIZONTAL);
            actions.setPadding(dp(24), dp(4), 0, 0);
            Button open = wrapButton(Ui.ghost(this, exiting ? "查看状态" : "继续浏览", v -> {
                if (exiting) showRuntime(); else openProfile(profile);
            }));
            actions.addView(open, new LinearLayout.LayoutParams(stacked ? -1 : 0, -2, stacked ? 0f : 1f));
            Button exit = wrapButton(Ui.ghost(this, exiting ? "重试退出" : "退出环境",
                    v -> confirmEnvironmentExit(ownedSession)));
            actions.addView(exit, new LinearLayout.LayoutParams(stacked ? -1 : 0, -2, stacked ? 0f : 1f));
            card.addView(actions);
        }
        return card;
    }

    private LinearLayout proxyCard(ManagedProxy proxy, String query) {
        Integer cachedUsage = proxyUsage.get(proxy.id);
        int usage = cachedUsage == null ? 0 : cachedUsage;
        LinearLayout card = listRow(false);
        String summary = proxy.proxy.scheme.name() + "  ·  " + proxy.proxy.authority()
                + (usage == 0 ? "  ·  未引用" : "  ·  " + usage + " 个环境");
        TextView proxyTitle = itemHeading(card, proxy.name, summary, false, v -> proxyMenu(v, proxy, usage));
        proxyTitle.setText(highlighted(proxy.name, query));
        card.setOnClickListener(v -> ProxyEditor.show(this, repository, proxy, this::reload));
        return card;
    }

    private void createItem() {
        if (repository == null || !runtimeKnown) return;
        if (selected == 1) ProxyEditor.show(this, repository, null, this::reload);
        else ProfileEditor.show(this, repository, null, this::reload);
    }

    private void openProfile(ProfileSpec profile) { openProfile(profile, null); }

    private void openProfile(ProfileSpec profile, WebApp app) {
        if (!runtimeKnown || !foreground) return;
        OpenTarget target = new OpenTarget(profile, app);
        // A PUBLISHED ticket is already in flight for this profile; the coordinator contract
        // forbids rebinding to it, so a second tap stops here with a plain status line.
        if (active != null && active.state == BootstrapStore.State.PUBLISHED
                && active.launch.profile.id.equals(profile.id)) {
            Ui.snackbar(this, "正在启动 “" + profile.name + "”，请稍候");
            return;
        }
        if (active == null || active.launch.profile.id.equals(profile.id)) {
            queuedOpen = null; launchGeneration++; dispatchOpen(target); return;
        }
        String expectedSession = active.launch.sessionId;
        long expectedGeneration = launchGeneration;
        Ui.Sheet sheet = Ui.Sheet.create(this, "切换到 “" + profile.name + "”",
                "将先退出 “" + active.launch.profile.name + "”。确认原进程退出后，再打开"
                        + (app == null ? "所选环境。" : "「" + app.name + "」。"));
        sheet.actions("取消", null, "切换环境", () -> {
            sheet.dialog().dismiss();
            try {
                BootstrapStore.ActiveLaunch observed = bootstrap.readActive();
                if (!foreground || expectedGeneration != launchGeneration || observed == null
                        || !expectedSession.equals(observed.launch.sessionId) || !webAppStillAvailable(target)) {
                    reload();
                    return;
                }
                launchGeneration++; queuedOpen = target; coordinator.stop();
            } catch (RuntimeException failure) { showError(failure); }
        }).show();
    }
    private boolean webAppStillAvailable(OpenTarget target) {
        if (target.app == null) return true;
        try (WebAppRegistry registry = new WebAppRegistry(this)) {
            ProfileSpec profile = repository.findProfile(target.profile.id);
            boolean ready = profile != null && target.profile.revision.equals(profile.revision)
                    && target.app.sameInstall(registry.get(target.app.shortcutId))
                    && WebAppShortcuts.pinState(this, target.app.shortcutId) == WebAppShortcuts.PinState.CONFIRMED;
            if (!ready) Ui.snackbar(this, "网页应用或所属环境已变化，请重新打开。");
            return ready;
        }
    }

    private void dispatchOpen(OpenTarget target) {
        try {
            if (!webAppStillAvailable(target)) return;
            if (target.app == null) coordinator.open(target.profile);
            else coordinator.openWebApp(target.profile, target.app);
        } catch (RuntimeException failure) { showError(failure); }
    }

    private static final class OpenTarget {
        final ProfileSpec profile;
        final WebApp app;
        OpenTarget(ProfileSpec profile, WebApp app) { this.profile = profile; this.app = app; }
    }

    private void profileMenu(View anchor, ProfileSpec profile) {
        boolean busy = active != null && active.launch.profile.id.equals(profile.id)
                && active.state != BootstrapStore.State.EXIT_CONFIRMED;
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add(!runtimeKnown ? "编辑环境（状态未知，请先核对）"
                : busy ? "编辑环境（使用中，请先退出）" : "编辑环境")
                .setEnabled(runtimeKnown && !busy).setOnMenuItemClickListener(item -> {
            reload();
            if (runtimeKnown && !isActive(profile)) {
                ProfileEditor.show(this, repository, profile, this::reload);
            }
            return true;
        });
        menu.getMenu().add("复制为新环境").setEnabled(runtimeKnown && !profile.hasProxyCredentials()).setOnMenuItemClickListener(item -> {
            duplicate(profile); return true;
        });
        menu.getMenu().add("查看配置摘要").setOnMenuItemClickListener(item -> {
            Ui.Sheet sheet = Ui.Sheet.create(this, profile.name, "环境配置摘要");
            sheet.text("名称：" + profile.name + "\n网络：" + (profile.isDirect()
                    ? "不使用代理（直连），使用设备当前网络（包括系统 VPN）的公网 IP" : profile.proxy.proxyRule())
                    + "\n时区：" + profile.timeZoneId + "\n语言：" + String.join(", ", profile.languageTags)
                    + "\n地区：" + (profile.countryCode.isEmpty() ? "未设置" : profile.countryCode + "（手动）")
                    + "\n型号：" + profile.deviceModel + "\n独立环境 ID：" + profile.id);
            sheet.actions(null, null, "知道了", null).show();
            return true;
        });
        menu.getMenu().add(busy ? "删除环境（运行中，请先退出）" : "删除环境")
                .setEnabled(runtimeKnown && !busy).setOnMenuItemClickListener(item -> {
            confirmDeleteProfile(profile); return true;
        });
        menu.show();
    }

    private void confirmDeleteProfile(ProfileSpec profile) {
        if (!runtimeKnown) return;
        Ui.Sheet sheet = Ui.Sheet.create(this, "删除这个环境？",
                profile.name + " · 删除后环境将从列表移除，代理引用释放，已保存的凭据一并清除；"
                        + "本机已生成的站点数据文件不会自动清理。此操作不可撤销。");
        sheet.dangerActions("取消", null, "删除", () -> {
            sheet.dialog().dismiss();
            try {
                repository.deleteProfile(profile.id);
                if (active != null && active.launch.profile.id.equals(profile.id)) active = null;
                Ui.snackbar(this, "已删除环境 “" + profile.name + "”");
                reload();
            } catch (RuntimeException failure) { showError(failure); }
        }).show();
    }
    private void duplicate(ProfileSpec original) {
        try {
            String name = original.name.substring(0, Math.min(68, original.name.length())) + " 副本";
            String base = name; int suffix = 2;
            while (nameExists(name)) name = base + " " + suffix++;
            ProfileSpec copy = new ProfileSpec(UUID.randomUUID().toString(), UUID.randomUUID().toString(), name,
                    original.proxy, original.countryCode, original.timeZoneId, original.languageTags,
                    original.deviceMode, original.deviceModel, "");
            if (copy.isDirect()) repository.saveProfileWithoutProxy(copy, null);
            else repository.saveProfileWithProxy(copy, null, repository.proxyIdForProfile(original.id));
            reload();
            Ui.snackbar(this, "已创建副本 “" + copy.name + "”");
        } catch (RuntimeException failure) { showError(failure); }
    }
    private boolean nameExists(String name) { for (ProfileSpec profile : profiles) if (profile.name.equalsIgnoreCase(name)) return true; return false; }
    private void proxyMenu(View anchor, ManagedProxy proxy, int usage) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add("查看代理详情").setOnMenuItemClickListener(item -> {
            Ui.Sheet sheet = Ui.Sheet.create(this, proxy.name, "代理配置详情");
            sheet.text("名称：" + proxy.name + "\n代理：" + proxy.proxy.proxyRule()
                    + "\n引用环境：" + usage + " 个\n代理 ID：" + proxy.id);
            sheet.actions(null, null, "知道了", null).show();
            return true;
        });
        menu.getMenu().add("查看引用环境").setOnMenuItemClickListener(item -> {
            List<String> names = new ArrayList<>();
            for (ProfileSpec profile : profiles) if (proxy.id.equals(proxyLinks.get(profile.id))) names.add(profile.name);
            Ui.Sheet sheet = Ui.Sheet.create(this, "引用 “" + proxy.name + "”", "当前使用该代理的环境");
            sheet.text(names.isEmpty() ? "暂未被任何环境引用。" : String.join("\n", names));
            sheet.actions(null, null, "知道了", null).show();
            return true;
        });
        menu.getMenu().add(usage == 0 ? "删除代理" : "删除代理（仍被引用）").setEnabled(usage == 0).setOnMenuItemClickListener(item -> {
            Ui.Sheet sheet = Ui.Sheet.create(this, "删除这个代理？", proxy.name + " · 此操作不会改动其他代理。");
            sheet.dangerActions("取消", null, "删除", () -> {
                sheet.dialog().dismiss();
                try { repository.deleteProxy(proxy.id, proxy.revision); Ui.snackbar(this, "已删除代理 “" + proxy.name + "”"); reload(); } catch (RuntimeException failure) { showError(failure); }
            }).show();
            return true;
        }); menu.show();
    }
    private void showMore(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add("运行状态").setOnMenuItemClickListener(item -> { showRuntime(); return true; });
        if (supportsWebApps()) {
            menu.getMenu().add("网页应用").setOnMenuItemClickListener(item -> { showWebApps(); return true; });
        }
        menu.getMenu().add("关于 ABS Browser").setOnMenuItemClickListener(item -> {
            Ui.Sheet sheet = Ui.Sheet.create(this, "ABS Browser · 预览版", null);
            sheet.text("Chromium 原生内核 · 单活动环境 · 多标签浏览\n\n环境隔离配置与代理资源分别管理。历史仅保存在对应环境中。\n\n当前仍是开发验证版，不代表完整指纹、网络泄漏或登录持久性验收已通过。");
            sheet.actions(null, null, "知道了", null).show();
            return true;
        }); menu.show();
    }
    private void showWebApps() {
        if (repository == null || !foreground) return;
        try (WebAppRegistry registry = new WebAppRegistry(this)) {
            Ui.Sheet sheet = Ui.Sheet.create(this, "网页应用", null);
            List<WebApp> apps = registry.list();
            if (apps.isEmpty()) sheet.text("暂无网页应用。请在符合条件的网站菜单中选择「安装网页应用」。");
            for (WebApp app : apps) {
                Button row = wrapButton(Ui.tonal(this, app.name + "\n" + app.origin, v -> {
                    sheet.dialog().dismiss();
                    showWebApp(app.shortcutId);
                }));
                row.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
                sheet.content(row);
            }
            sheet.actions("关闭", null, null, null).show();
        } catch (RuntimeException failure) { showError(failure); }
    }

    private void showWebApp(String id) {
        if (!foreground) return;
        try (WebAppRegistry registry = new WebAppRegistry(this)) {
            WebApp app = registry.get(id);
            if (app == null) return;
            ProfileSpec owner = repository.findProfile(app.profileId);
            WebAppShortcuts.PinState state = WebAppShortcuts.pinState(this, id);
            String status = owner == null ? "所属环境已删除，不能启动。"
                    : state == WebAppShortcuts.PinState.CONFIRMED ? "系统已确认桌面入口。"
                    : state == WebAppShortcuts.PinState.UNAVAILABLE ? "暂时无法核对桌面状态。"
                    : "系统未确认桌面入口。若之前没有确认，可重新申请。";
            Ui.Sheet sheet = Ui.Sheet.create(this, app.name, null);
            sheet.text(app.origin).text("环境：" + (owner == null ? "已删除" : owner.name)).text(status);
            sheet.content(wrapButton(Ui.ghost(this, "移除网页应用", v -> {
                sheet.dialog().dismiss();
                confirmRemoveWebApp(app);
            })));
            if (owner == null) sheet.actions("关闭", null, null, null);
            else if (state == WebAppShortcuts.PinState.CONFIRMED) {
                sheet.actions("关闭", null, "打开", () -> {
                    sheet.dialog().dismiss();
                    try { openInstalledWebApp(app); } catch (RuntimeException failure) { showError(failure); }
                });
            } else {
                sheet.actions("关闭", null, "添加到桌面", () -> {
                    sheet.dialog().dismiss();
                    if (!foreground) return;
                    try (WebAppRegistry current = new WebAppRegistry(this)) {
                        if (!app.sameInstall(current.get(id)) || repository.findProfile(app.profileId) == null) return;
                        Ui.snackbar(this, WebAppShortcuts.requestPin(this, app).message);
                    } catch (RuntimeException failure) { showError(failure); }
                });
            }
            sheet.show();
        } catch (RuntimeException failure) { showError(failure); }
    }

    private void confirmRemoveWebApp(WebApp app) {
        Ui.Sheet sheet = Ui.Sheet.create(this, "移除网页应用？", app.name + " · " + app.origin);
        sheet.text("桌面入口将失效，不会清除该网站在环境中的数据。");
        sheet.dangerActions("取消", null, "移除", () -> {
            sheet.dialog().dismiss();
            if (!foreground) return;
            try (WebAppRegistry registry = new WebAppRegistry(this)) {
                registry.remove(app.shortcutId);
                try { WebAppShortcuts.disable(this, app.shortcutId); }
                catch (RuntimeException ignored) { /* Registry removal still revokes activation. */ }
                Ui.snackbar(this, "已移除网页应用，网站数据保留。");
            } catch (RuntimeException failure) { showError(failure); }
        }).show();
    }

    private void showRuntime() {
        if (coordinator == null) return;
        if (runtimeSheet != null) return;
        Ui.Sheet sheet = Ui.Sheet.create(this, "运行状态", null);
        runtimeSheet = sheet;
        sheet.text("正在核对运行状态…");
        Button refresh = wrapButton(Ui.tonal(this, "核对状态", v -> {
            coordinator.reconcile();
            reload();
        }));
        sheet.content(refresh);
        LinearLayout.LayoutParams refreshParams = new LinearLayout.LayoutParams(-1, -2);
        refreshParams.topMargin = dp(14);
        refresh.setLayoutParams(refreshParams);
        runtimeExit = wrapButton(Ui.ghost(this, "退出当前环境", null));
        sheet.content(runtimeExit).actions("关闭", null, null, null);
        sheet.dialog().setOnDismissListener(dialog -> {
            if (runtimeSheet == sheet) {
                runtimeSheet = null;
                runtimeExit = null;
            }
        });
        updateRuntimeSheet();
        sheet.show();
    }

    private void updateRuntimeSheet() {
        if (runtimeSheet == null) return;
        runtimeSheet.updateText(runtimeSummary());
        boolean canExit = runtimeKnown && active != null
                && active.state != BootstrapStore.State.EXIT_CONFIRMED;
        String expectedSession = canExit ? active.launch.sessionId : null;
        boolean retry = canExit && (active.state == BootstrapStore.State.EXIT_UNCONFIRMED
                || active.state == BootstrapStore.State.REVOKED);
        runtimeExit.setText(!runtimeKnown ? "状态未知，请先核对"
                : !canExit ? "当前没有可退出的环境" : retry ? "重试退出" : "退出当前环境");
        Ui.applyEnabledLook(runtimeExit, canExit);
        Ui.Sheet sheet = runtimeSheet;
        runtimeExit.setOnClickListener(v -> {
            if (expectedSession == null) return;
            sheet.dialog().dismiss();
            confirmEnvironmentExit(expectedSession);
        });
    }

    private Button wrapButton(Button button) {
        button.setSingleLine(false);
        button.setMaxLines(Integer.MAX_VALUE);
        button.setEllipsize(null);
        button.setMinHeight(dp(48));
        button.setMinimumHeight(dp(48));
        button.setMinimumWidth(dp(48));
        return button;
    }

    private String runtimeSummary() {
        return (!runtimeKnown ? "当前环境状态未知，请核对后再操作"
                : active == null ? "当前没有打开的环境" : "当前环境：" + active.launch.profile.name)
                + "\n\n" + coordinator.status() + "\n\n同时仅运行一个环境；返回环境列表不等于结束浏览器进程。";
    }
    private void showError(RuntimeException failure) {
        Ui.Sheet sheet = Ui.Sheet.create(this, "未完成操作", null);
        sheet.text(Ui.friendlyError(failure));
        sheet.actions(null, null, "知道了", null).show();
    }
    @Override protected void onDestroy() {
        queuedOpen = null; launchGeneration++; main.removeCallbacksAndMessages(null);
        if (coordinator != null) coordinator.clearObserver(runtimeObserver);
        if (runtimeSheet != null) runtimeSheet.dialog().dismiss();
        runtimeSheet = null;
        runtimeExit = null;
        if (bootstrap != null) bootstrap.close();
        if (repository != null) repository.close(); super.onDestroy();
    }
}
