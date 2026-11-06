package com.ahoo.abs.android;

import android.app.Activity;
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
import com.ahoo.abs.core.ProfileSpec;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/** Exported launcher accepts no external profile, URL, identity or proxy extras. */
public final class MainActivity extends Activity {
    private ProfileRepository repository;
    private BootstrapStore bootstrap;
    private LaunchCoordinator coordinator;
    private LinearLayout list;
    private TextView runtime;
    private TextView section;
    private FrameLayout segmentControl;
    private EditText search;
    private Button create;
    private BootstrapStore.ActiveLaunch active;
    private boolean runtimeKnown;
    private int selected;
    private Runnable runtimeObserver;
    private ProfileSpec queuedOpen;
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
        LinearLayout mark = new LinearLayout(this);
        mark.setGravity(Gravity.CENTER);
        mark.setBackground(Ui.gradient(this, 16, Ui.ACCENT, Ui.ACCENT_2));
        mark.setElevation(dp(3));
        mark.addView(Ui.styled(this, "A", 22, Ui.WHITE,
                android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)));
        brand.addView(mark, new LinearLayout.LayoutParams(dp(46), dp(46)));
        LinearLayout heading = Ui.column(this);
        heading.setPadding(dp(14), 0, 0, 0);
        heading.addView(Ui.display(this, "ABS Browser"));
        TextView tagline = Ui.caption(this, "独立身份 · 从容切换");
        tagline.setPadding(0, dp(3), 0, 0);
        heading.addView(tagline);
        brand.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        FrameLayout more = Ui.iconButton(this, Ui.Glyph.MENU, "更多设置", Ui.MUTED, this::showMore);
        brand.addView(more);
        root.addView(brand, Ui.gap(this, 6));

        runtime = Ui.styled(this, "正在读取运行状态…", 12.5f, Ui.MUTED,
                android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.NORMAL));
        runtime.setBackground(Ui.shape(this, Ui.WHITE, 14, true));
        runtime.setElevation(dp(1));
        int padH = dp(14);
        int padV = dp(11);
        runtime.setPadding(padH, padV, padH, padV);
        runtime.setOnClickListener(v -> showRuntime());
        root.addView(runtime, Ui.gap(this, 18));

        String[] labels = {"环境", "代理"};
        segmentControl = Ui.segmented(this, labels, new int[]{-1, -1}, selected, index -> {
            if (selected != index) {
                selected = index;
                search.setText("");
                render();
            }
        });
        root.addView(segmentControl, Ui.gap(this, 18));

        search = Ui.searchField(this);
        search.setHint(selected == 0 ? "搜索环境名称、代理或时区" : "搜索代理名称、地址或协议");
        LinearLayout searchSurface = Ui.searchSurface(this, search);
        root.addView(searchSurface, Ui.gap(this, 14));

        LinearLayout sectionRow = Ui.row(this);
        section = Ui.heading(this, "所有环境");
        sectionRow.addView(section, new LinearLayout.LayoutParams(0, -2, 1));
        sortToggle = Ui.chip(this, "智能排序", false, v -> {
            Ui.haptic(v);
            sortByName = !sortByName;
            render(false);
        });
        sectionRow.addView(sortToggle);
        sectionRow.setPadding(dp(2), dp(20), dp(2), dp(10));
        root.addView(sectionRow);

        ScrollView scroll = new ScrollView(this);
        scroll.setClipToPadding(false);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setFillViewport(true);
        list = Ui.column(this);
        scroll.addView(list);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

        create = Ui.primary(this, "+  新建环境", v -> createItem());
        LinearLayout.LayoutParams footer = new LinearLayout.LayoutParams(-1, dp(54));
        footer.topMargin = dp(10);
        root.addView(create, footer);

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
        } catch (RuntimeException failure) {
            runtime.setText("配置存储不可用（" + Ui.errorCode(failure) + "）");
            create.setEnabled(false);
        }
    }

    private int dp(int value) { return Ui.dp(this, value); }

    @Override protected void onResume() {
        super.onResume(); foreground = true;
        if (repository != null && coordinator != null) { coordinator.reconcile(); reload(); }
    }
    @Override protected void onPause() {
        foreground = false; launchGeneration++;
        queuedOpen = null; // Do not launch a deferred environment after the manager loses foreground.
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
                ProfileSpec pending = queuedOpen; queuedOpen = null;
                long token = launchGeneration;
                main.post(() -> {
                    if (foreground && token == launchGeneration && !isFinishing() && !isDestroyed()) coordinator.open(pending);
                });
            }
            render();
        } catch (RuntimeException failure) {
            runtimeKnown = false; renderedSignature = null; queuedOpen = null; launchGeneration++;
            runtime.setText("读取失败（" + Ui.errorCode(failure) + "），未将现有配置视为空。" );
            list.removeAllViews(); list.addView(Ui.muted(this, "暂时无法显示配置，请在运行状态中重新核对。", 14));
        }
    }

    private final Runnable searchRender = () -> render(false);

    private void render() { render(true); }

    private void render(boolean animate) {
        if (list == null) return;
        Ui.selectSegment(segmentControl, selected, new int[]{profiles.size(), proxies.size()});
        search.setHint(selected == 0 ? "搜索环境名称、代理或时区" : "搜索代理名称、地址或协议");
        create.setText(selected == 0 ? "+  新建环境" : "+  新建代理");
        String query = search.getText().toString().trim().toLowerCase(Locale.ROOT);
        // Skip the whole rebuild when nothing visible changed (status ticks, reconcile calls).
        String activeKey = active == null ? "none"
                : active.state.name() + ":" + active.launch.profile.id + ":" + active.launch.profile.revision;
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
                if (matches(query, profile.name, profile.proxy.authority(), profile.timeZoneId,
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
        section.setText((selected == 0 ? "所有环境" : "代理资源") + "   ·   " + shown);
        sortToggle.setText(sortByName ? "按名称" : "智能排序");
        if (shown == 0) {
            LinearLayout empty = Ui.emptyState(this,
                    query.isEmpty() ? (selected == 0 ? "创建你的第一个环境" : "把代理集中管理") : "没有匹配结果",
                    query.isEmpty() ? (selected == 0
                            ? "环境拥有独立的时区、语言与站点数据。从选择一个代理开始。"
                            : "添加一次代理，即可供多个环境复用。保存不代表出口实测通过。")
                            : "试试其他名称、地址或时区关键词。");
            if (!query.isEmpty()) {
                Button clear = Ui.ghost(this, "清空搜索", v -> search.setText(""));
                LinearLayout.LayoutParams clearLp = new LinearLayout.LayoutParams(-2, dp(44));
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

    /** Which non-name field matched, for a small reason chip on filtered results. */
    private String matchReason(String query, ProfileSpec profile) {
        if (profile.name.toLowerCase(Locale.ROOT).contains(query)) return null;
        if (profile.proxy.authority().toLowerCase(Locale.ROOT).contains(query)) return "出口匹配";
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
        params.bottomMargin = dp(12);
        list.addView(card, params);
        if (animate) Ui.animateIn(card);
    }
    private TextView oneLine(String value, int size) {
        TextView view = Ui.bold(this, value, size); view.setSingleLine(true);
        view.setEllipsize(TextUtils.TruncateAt.END); return view;
    }
    private TextView itemHeading(LinearLayout card, String name, String initial, boolean running, View.OnClickListener menu) {
        LinearLayout heading = Ui.row(this);
        heading.addView(Ui.avatar(this, initial, Ui.ACCENT, 44));
        LinearLayout title = Ui.column(this);
        title.setPadding(dp(12), 0, 0, 0);
        TextView titleText = oneLine(name, 18);
        titleText.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 17.5f);
        titleText.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
        title.addView(titleText);
        if (running) {
            LinearLayout status = Ui.row(this);
            View dot = new View(this);
            dot.setBackground(Ui.shape(this, Ui.SUCCESS, 4));
            LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(dp(7), dp(7));
            status.addView(dot, dotParams);
            TextView badge = Ui.styled(this, "当前活动环境", 11.5f, Ui.SUCCESS,
                    android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
            LinearLayout.LayoutParams badgeParams = new LinearLayout.LayoutParams(-2, -2);
            badgeParams.leftMargin = dp(6);
            status.addView(badge, badgeParams);
            LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(-2, -2);
            statusParams.topMargin = dp(4);
            title.addView(status, statusParams);
        }
        heading.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        TextView more = Ui.styled(this, "⋯", 24, Ui.MUTED,
                android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.NORMAL));
        more.setGravity(Gravity.CENTER);
        more.setContentDescription(name + " 更多操作");
        more.setOnClickListener(v -> { Ui.haptic(v); menu.onClick(v); });
        Ui.pressable(more);
        heading.addView(more, new LinearLayout.LayoutParams(dp(44), dp(44)));
        card.addView(heading);
        // Long-press anywhere on the card opens the same menu (WeChat/Meituan convention).
        card.setLongClickable(true);
        card.setOnLongClickListener(v -> { Ui.haptic(v); menu.onClick(v); return true; });
        return titleText;
    }

    private TextView metaChip(String value) {
        TextView chip = Ui.chip(this, value, false, null);
        // Single line + capped width: a long timezone must ellipsize, not push its siblings
        // off the card edge (the old horizontal row clipped overflow entirely).
        chip.setSingleLine(true);
        chip.setEllipsize(TextUtils.TruncateAt.END);
        chip.setMaxWidth(dp(150));
        return chip;
    }

    /** Wrapping chip flow: long timezone/language tags wrap to the next line instead of clipping. */
    private Ui.FlowLayout chipFlow() {
        Ui.FlowLayout flow = new Ui.FlowLayout(this);
        flow.setPadding(0, dp(14), 0, dp(2));
        return flow;
    }

    private LinearLayout profileCard(ProfileSpec profile, String query) {
        boolean running = active != null && active.state == BootstrapStore.State.CLAIMED
                && active.launch.profile.id.equals(profile.id);
        boolean launching = active != null && active.state == BootstrapStore.State.PUBLISHED
                && active.launch.profile.id.equals(profile.id);
        LinearLayout card = Ui.card(this);
        TextView titleText = itemHeading(card, profile.name, profile.name.substring(0, 1).toUpperCase(Locale.ROOT),
                running, v -> profileMenu(v, profile));
        titleText.setText(highlighted(profile.name, query));
        String reason = query.isEmpty() ? null : matchReason(query, profile);
        if (reason != null) {
            TextView reasonChip = Ui.caption(this, "· " + reason);
            reasonChip.setTextColor(Ui.ACCENT);
            reasonChip.setPadding(0, dp(2), 0, 0);
            card.addView(reasonChip);
        }
        String proxyName = profile.proxy.scheme.name() + " · " + profile.proxy.authority();
        for (ManagedProxy proxy : proxies) {
            if (proxy.id.equals(proxyLinks.get(profile.id))) { proxyName = proxy.name; break; }
        }
        Ui.FlowLayout chips = chipFlow();
        chips.addView(metaChip(profile.timeZoneId), 0, 8, 0);
        chips.addView(metaChip(String.join(", ", profile.languageTags)), 0, 8, 0);
        card.addView(chips);
        TextView route = Ui.caption(this, "出口  " + proxyName
                + (profile.proxy.hasCredentials ? "  ·  旧认证配置" : ""));
        route.setPadding(0, dp(2), 0, dp(2));
        card.addView(route);
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
        LinearLayout actions = Ui.row(this); actions.setPadding(0, dp(16), 0, 0);
        Button open = Ui.primary(this, launching ? "启动中…" : (running ? "继续浏览" : "打开环境"),
                v -> openProfile(profile));
        Ui.applyEnabledLook(open, runtimeKnown && !launching);
        actions.addView(open, new LinearLayout.LayoutParams(0, dp(50), 2f));
        Button edit = Ui.tonal(this, "编辑", v -> {
            if (running || launching) { showRuntime(); return; }
            ProfileEditor.show(this, repository, profile, this::reload);
        });
        if (running || launching) {
            // The environment owns its live config; editing must wait until it exits.
            edit.setEnabled(false);
            edit.setAlpha(0.55f);
            edit.setContentDescription(running ? "环境运行中，退出后可编辑" : "正在启动，稍候可编辑");
        }
        LinearLayout.LayoutParams editParams = new LinearLayout.LayoutParams(0, dp(50), 1f);
        editParams.leftMargin = dp(8);
        actions.addView(edit, editParams);
        card.addView(actions);
        return card;
    }

    private LinearLayout proxyCard(ManagedProxy proxy, String query) {
        Integer cachedUsage = proxyUsage.get(proxy.id);
        int usage = cachedUsage == null ? 0 : cachedUsage;
        LinearLayout card = Ui.card(this);
        TextView proxyTitle = itemHeading(card, proxy.name, "P", false, v -> proxyMenu(v, proxy, usage));
        proxyTitle.setText(highlighted(proxy.name, query));
        Ui.FlowLayout chips = chipFlow();
        chips.addView(metaChip(proxy.proxy.scheme.name()), 0, 8, 0);
        card.addView(chips);
        TextView endpoint = Ui.caption(this, proxy.proxy.authority());
        endpoint.setPadding(0, dp(2), 0, dp(2));
        card.addView(endpoint);
        TextView usageLine = Ui.caption(this, usage == 0 ? "暂未被环境引用" : "被 " + usage + " 个环境引用");
        usageLine.setTextColor(usage == 0 ? Ui.MUTED : Ui.ACCENT);
        usageLine.setPadding(0, dp(4), 0, 0);
        card.addView(usageLine);
        Button edit = Ui.tonal(this, "编辑代理", v -> ProxyEditor.show(this, repository, proxy, this::reload));
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, dp(50));
        layout.topMargin = dp(16);
        card.addView(edit, layout);
        return card;
    }

    private void createItem() {
        if (repository == null || !runtimeKnown) return;
        if (selected == 1) ProxyEditor.show(this, repository, null, this::reload);
        else if (proxies.isEmpty()) {
            Ui.Sheet sheet = Ui.Sheet.create(this, "先添加一个代理",
                    "环境从代理资源中选择出口，添加后可供多个环境复用。");
            sheet.actions("取消", null, "添加代理", () -> {
                sheet.dialog().dismiss();
                selected = 1;
                render();
                ProxyEditor.show(this, repository, null, this::reload);
            }).show();
        } else ProfileEditor.show(this, repository, null, this::reload);
    }

    private void openProfile(ProfileSpec profile) {
        if (!runtimeKnown) return;
        // A PUBLISHED ticket is already in flight for this profile; the coordinator contract
        // forbids rebinding to it, so a second tap stops here with a plain status line.
        if (active != null && active.state == BootstrapStore.State.PUBLISHED
                && active.launch.profile.id.equals(profile.id)) {
            Ui.snackbar(this, "正在启动 “" + profile.name + "”，请稍候");
            return;
        }
        if (active == null || active.launch.profile.id.equals(profile.id)) {
            queuedOpen = null; launchGeneration++; coordinator.open(profile); return;
        }
        Ui.Sheet sheet = Ui.Sheet.create(this, "切换到 “" + profile.name + "”",
                "将先退出 “" + active.launch.profile.name + "”。确认原进程退出后，再打开所选环境。");
        sheet.actions("取消", null, "切换环境", () -> {
            sheet.dialog().dismiss();
            launchGeneration++; queuedOpen = profile; coordinator.stop();
        }).show();
    }
    private void profileMenu(View anchor, ProfileSpec profile) {
        boolean busy = active != null && active.launch.profile.id.equals(profile.id)
                && active.state != BootstrapStore.State.EXIT_CONFIRMED;
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add("复制为新环境").setEnabled(!profile.proxy.hasCredentials).setOnMenuItemClickListener(item -> {
            duplicate(profile); return true;
        });
        menu.getMenu().add("查看配置摘要").setOnMenuItemClickListener(item -> {
            Ui.Sheet sheet = Ui.Sheet.create(this, profile.name, "环境配置摘要");
            sheet.text("代理：" + profile.proxy.proxyRule()
                    + "\n时区：" + profile.timeZoneId + "\n语言：" + String.join(", ", profile.languageTags)
                    + "\n地区：" + (profile.countryCode.isEmpty() ? "未设置" : profile.countryCode + "（手动）")
                    + "\n型号：" + profile.deviceModel + "\n独立环境 ID：" + profile.id);
            sheet.actions(null, null, "知道了", null).show();
            return true;
        });
        menu.getMenu().add(busy ? "删除环境（运行中，请先退出）" : "删除环境")
                .setEnabled(!busy).setOnMenuItemClickListener(item -> {
            confirmDeleteProfile(profile); return true;
        });
        menu.show();
    }

    private void confirmDeleteProfile(ProfileSpec profile) {
        if (!runtimeKnown) return;
        Ui.Sheet sheet = Ui.Sheet.create(this, "删除这个环境？",
                profile.name + " · 删除后环境将从列表移除，代理引用释放，已保存的凭据一并清除；"
                        + "本机已生成的站点数据文件不会自动清理。此操作不可撤销。");
        sheet.actions("取消", null, "删除", () -> {
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
            repository.saveProfileWithProxy(copy, null, repository.proxyIdForProfile(original.id)); reload();
            Ui.snackbar(this, "已创建副本 “" + copy.name + "”");
        } catch (RuntimeException failure) { showError(failure); }
    }
    private boolean nameExists(String name) { for (ProfileSpec profile : profiles) if (profile.name.equalsIgnoreCase(name)) return true; return false; }
    private void proxyMenu(View anchor, ManagedProxy proxy, int usage) {
        PopupMenu menu = new PopupMenu(this, anchor);
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
            sheet.actions("取消", null, "删除", () -> {
                sheet.dialog().dismiss();
                try { repository.deleteProxy(proxy.id, proxy.revision); Ui.snackbar(this, "已删除代理 “" + proxy.name + "”"); reload(); } catch (RuntimeException failure) { showError(failure); }
            }).show();
            return true;
        }); menu.show();
    }
    private void showMore(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add("运行状态").setOnMenuItemClickListener(item -> { showRuntime(); return true; });
        menu.getMenu().add("关于 ABS Browser").setOnMenuItemClickListener(item -> {
            Ui.Sheet sheet = Ui.Sheet.create(this, "ABS Browser · 预览版", null);
            sheet.text("Chromium 原生内核 · 单活动环境 · 多标签浏览\n\n环境隔离配置与代理资源分别管理。历史仅保存在对应环境中。\n\n当前仍是开发验证版，不代表完整指纹、网络泄漏或登录持久性验收已通过。");
            sheet.actions(null, null, "知道了", null).show();
            return true;
        }); menu.show();
    }
    private void showRuntime() {
        if (coordinator == null) return;
        Ui.Sheet sheet = Ui.Sheet.create(this, "运行状态", null);
        sheet.text(runtimeSummary());
        Button refresh = Ui.tonal(this, "核对状态", v -> {
            coordinator.reconcile();
            sheet.updateText(runtimeSummary());
        });
        LinearLayout.LayoutParams refreshParams = new LinearLayout.LayoutParams(-1, dp(46));
        refreshParams.topMargin = dp(14);
        sheet.content(refresh).actions("关闭", null, "退出当前环境", () -> {
            sheet.dialog().dismiss();
            queuedOpen = null; launchGeneration++; coordinator.stop();
        });
        refresh.setMinimumHeight(dp(46));
        refresh.setLayoutParams(refreshParams);
        sheet.show();
    }

    private String runtimeSummary() {
        return (active == null ? "当前没有打开的环境" : "当前环境：" + active.launch.profile.name)
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
        if (bootstrap != null) bootstrap.close();
        if (repository != null) repository.close(); super.onDestroy();
    }
}
