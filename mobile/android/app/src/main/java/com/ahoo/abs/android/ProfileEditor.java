package com.ahoo.abs.android;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ScrollView;
import android.widget.TextView;
import com.ahoo.abs.android.data.ManagedProxy;
import com.ahoo.abs.android.data.ProfileRepository;
import com.ahoo.abs.android.data.StorageException;
import com.ahoo.abs.core.ProfileSpec;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * Profile editor dialog. Explicit edits only; this form never substitutes the phone's IP for a
 * proxy observation and never renders inline proxy host/port fields — endpoints come from the
 * reusable managed proxy list. Legacy credentialed profiles keep their stored proxy and
 * credentials unless the user explicitly selects a managed proxy.
 */
final class ProfileEditor {
    private ProfileEditor() { }

    private static final String[] LANGUAGE_PRESETS = {
            "zh-CN 简体中文", "zh-TW 繁體中文", "en-US English (US)", "en-GB English (UK)",
            "ja-JP 日本語", "ko-KR 한국어", "de-DE Deutsch", "fr-FR Français", "es-ES Español",
            "pt-BR Português (Brasil)", "ru-RU Русский", "it-IT Italiano", "nl-NL Nederlands",
            "pl-PL Polski", "tr-TR Türkçe", "vi-VN Tiếng Việt", "th-TH ไทย", "id-ID Indonesia",
            "ar-SA العربية", "hi-IN हिन्दी"
    };

    private interface Pick { void onPick(int index, String value); }

    public static void show(Activity activity, ProfileRepository repository, ProfileSpec original, Runnable saved) {
        try { showForm(activity, repository, original, saved); }
        catch (RuntimeException failure) { showFailure(activity, failure); }
    }

    private static void showForm(Activity activity, ProfileRepository repository, ProfileSpec original, Runnable saved) {
        String boundProxyId = original == null ? null : repository.proxyIdForProfile(original.id);
        ManagedProxy boundProxy = boundProxyId == null ? null : repository.findProxy(boundProxyId);
        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        content.addView(hint(activity, "地区、时区与语言均为手动配置，不是已检测的代理出口。"));

        LinearLayout nameCard = card(activity, content, "名称");
        EditText name = Ui.field(activity, nameCard, "环境名称（必填，最长 80 字符）", original == null ? "" : original.name);
        name.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(80)});
        TextView nameError = errorLine(activity, nameCard);

        LinearLayout proxyCard = card(activity, content, "代理");
        TextView proxySummary = new TextView(activity);
        proxySummary.setTextSize(14);
        proxySummary.setTextColor(Ui.INK);
        proxySummary.setPadding(0, 0, 0, Ui.dp(activity, 8));
        proxyCard.addView(proxySummary);
        LinearLayout proxyRow = new LinearLayout(activity);
        proxyRow.setOrientation(LinearLayout.HORIZONTAL);
        Button pickProxy = styledButton(activity, "选择管理的代理…", false);
        Button newProxy = styledButton(activity, "新建代理…", false);
        LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, -2, 1f);
        half.rightMargin = Ui.dp(activity, 8);
        proxyRow.addView(pickProxy, half);
        proxyRow.addView(newProxy, new LinearLayout.LayoutParams(0, -2, 1f));
        proxyCard.addView(proxyRow);
        Button revertProxy = styledButton(activity, "恢复使用当前代理", false);
        proxyCard.addView(revertProxy);
        revertProxy.setVisibility(View.GONE);
        TextView proxyError = errorLine(activity, proxyCard);
        TextView legacyNote = hint(activity, "");
        legacyNote.setVisibility(View.GONE);
        proxyCard.addView(legacyNote);

        LinearLayout zoneCard = card(activity, content, "时区");
        EditText zone = Ui.field(activity, zoneCard, "IANA 时区（搜索选择或手动输入，例如 Asia/Shanghai）",
                original == null ? TimeZone.getDefault().getID() : original.timeZoneId);
        Button zonePreset = styledButton(activity, "搜索时区…", false);
        zoneCard.addView(zonePreset);
        TextView zoneError = errorLine(activity, zoneCard);

        LinearLayout langCard = card(activity, content, "语言");
        EditText languages = Ui.field(activity, langCard, "BCP 47 标签（逗号分隔、最多 8 个，可手动输入）",
                original == null ? Locale.getDefault().toLanguageTag() : String.join(",", original.languageTags));
        Button langPreset = styledButton(activity, "搜索语言…", false);
        langCard.addView(langPreset);
        TextView langError = errorLine(activity, langCard);
        // Country → suggested language line lives below (after the country field exists).

        LinearLayout advancedCard = card(activity, content, "高级");
        advancedCard.addView(hint(activity, "地区代码为手动标注，不是代理出口的实测结果。"));
        EditText country = Ui.field(activity, advancedCard, "地区代码（可选，手动输入两位字母，如 CN）",
                original == null ? "" : original.countryCode);
        country.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.AllCaps(Locale.ROOT),
                new android.text.InputFilter.LengthFilter(2)});
        country.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_NEXT);
        TextView countryError = errorLine(activity, advancedCard);
        // Country → suggested language (a suggestion only, never an observation or a default).
        TextView languageSuggestion = hint(activity, "");
        languageSuggestion.setTextColor(Ui.ACCENT);
        languageSuggestion.setVisibility(View.GONE);
        langCard.addView(languageSuggestion);
        Runnable updateLanguageSuggestion = () -> {
            String code = country.getText().toString().trim().toUpperCase(Locale.ROOT);
            String suggestion = code.length() == 2 ? ProxyGeoProbe.suggestedLanguage(code) : null;
            if (suggestion == null) {
                languageSuggestion.setVisibility(View.GONE);
                return;
            }
            boolean already = false;
            for (String part : languages.getText().toString().split(",", -1)) {
                if (part.trim().equalsIgnoreCase(suggestion)) { already = true; break; }
            }
            if (already) {
                languageSuggestion.setVisibility(View.GONE);
                return;
            }
            languageSuggestion.setText("按地区推荐语言：" + suggestion + "（点击添加，仅建议）");
            languageSuggestion.setVisibility(View.VISIBLE);
        };
        languageSuggestion.setOnClickListener(view -> {
            String code = country.getText().toString().trim().toUpperCase(Locale.ROOT);
            String suggestion = ProxyGeoProbe.suggestedLanguage(code);
            if (suggestion == null) return;
            Ui.haptic(view);
            appendLanguage(languages, suggestion);
            updateLanguageSuggestion.run();
        });
        country.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }
            @Override public void afterTextChanged(Editable s) { updateLanguageSuggestion.run(); }
        });
        languages.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }
            @Override public void afterTextChanged(Editable s) { updateLanguageSuggestion.run(); }
        });
        CheckBox declaredModel = new CheckBox(activity);
        declaredModel.setText("声明型号模式（当前内核不支持启动，仅保留标注）");
        declaredModel.setTextColor(Ui.INK);
        declaredModel.setChecked(original != null && original.deviceMode == ProfileSpec.DeviceMode.DECLARED_ANDROID);
        advancedCard.addView(declaredModel);
        EditText model = Ui.field(activity, advancedCard, "设备型号（未勾选时使用本机真实型号）",
                original == null ? Build.MODEL : original.deviceModel);
        model.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(128)});
        model.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_DONE);
        model.setEnabled(declaredModel.isChecked());
        declaredModel.setOnCheckedChangeListener((button, checked) -> {
            model.setEnabled(checked);
            if (!checked) model.setText(Build.MODEL);
        });
        boolean wasDeclared = declaredModel.isChecked();
        advancedCard.addView(hint(activity, wasDeclared
                ? "此环境保持声明型号标注（不可启动）；只有手动取消勾选才会改回本机型号。" : ""));
        TextView coherenceWarning = hint(activity, "");
        coherenceWarning.setTextColor(Ui.WARNING);
        coherenceWarning.setVisibility(View.GONE);
        advancedCard.addView(coherenceWarning);
        if (original != null) {
            name.setSelectAllOnFocus(false); zone.setSelectAllOnFocus(false);
            languages.setSelectAllOnFocus(false); country.setSelectAllOnFocus(false);
            model.setSelectAllOnFocus(false);
        }
        name.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_NEXT);
        zone.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_NEXT);
        languages.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_NEXT);

        // Freeze the endpoint actually shown/chosen. Repository compares this snapshot against
        // the current catalog at save, allowing renames but rejecting endpoint changes.
        ManagedProxy[] selectedProxy = {null};
        Runnable updateProxySummary = () -> {
            ManagedProxy selected = selectedProxy[0];
            String text;
            String note = "";
            if (selected != null) {
                text = "已选择：" + selected.name + " · " + endpoint(selected);
                revertProxy.setVisibility(View.VISIBLE);
                if (original != null && original.proxy.hasCredentials && boundProxyId == null) {
                    note = "保存后将改用所选管理代理并清除已存凭据（内核不支持认证）。";
                }
            } else if (original == null) {
                text = "尚未选择代理（必填）";
                revertProxy.setVisibility(View.GONE);
            } else {
                text = boundProxy != null
                        ? "当前：" + boundProxy.name + " · " + original.proxy.scheme.name() + " " + original.proxy.authority()
                        : "当前：旧版内嵌代理 " + original.proxy.scheme.name() + " " + original.proxy.authority()
                                + (original.proxy.hasCredentials ? "（保存时保留已存凭据）" : "");
                revertProxy.setVisibility(View.GONE);
            }
            proxySummary.setText(text);
            legacyNote.setText(note);
            legacyNote.setVisibility(note.isEmpty() ? View.GONE : View.VISIBLE);
        };
        pickProxy.setOnClickListener(button -> {
            Ui.haptic(button);
            try {
                showProxyPicker(activity, repository,
                        proxy -> { selectedProxy[0] = proxy; updateProxySummary.run(); });
            } catch (RuntimeException failure) { showFailure(activity, failure); }
        });
        newProxy.setOnClickListener(button -> {
            Ui.haptic(button);
            ProxyEditor.showWithResult(activity, repository, null, proxy -> {
                selectedProxy[0] = proxy;
                updateProxySummary.run();
            });
        });
        revertProxy.setOnClickListener(button -> { Ui.haptic(button); selectedProxy[0] = null; updateProxySummary.run(); });
        zonePreset.setOnClickListener(button -> { Ui.haptic(button); showTimezonePicker(activity, id -> zone.setText(id)); });
        langPreset.setOnClickListener(button -> { Ui.haptic(button); showLanguagePicker(activity, tag -> appendLanguage(languages, tag)); });
        updateProxySummary.run();

        String baselineName = name.getText().toString();
        String baselineZone = zone.getText().toString();
        String baselineLanguages = languages.getText().toString();
        String baselineCountry = country.getText().toString();
        String baselineModel = model.getText().toString();
        boolean baselineDeclared = declaredModel.isChecked();
        BooleanSupplier dirty = () -> changed(name, baselineName) || changed(zone, baselineZone)
                || changed(languages, baselineLanguages) || changed(country, baselineCountry)
                || changed(model, baselineModel) || declaredModel.isChecked() != baselineDeclared
                || selectedProxy[0] != null;

        TextView formError = errorLine(activity, null);
        Dialog[] holder = new Dialog[1];
        final boolean[] saving = {false};
        final Button[] saveRef = {null};
        final android.widget.ScrollView[] scrollRef = {null};
        View.OnClickListener cancelAction = button -> {
            if (dirty.getAsBoolean()) confirmDiscard(activity, holder[0]);
            else holder[0].dismiss();
        };
        View.OnClickListener saveAction = button -> {
            if (saving[0]) return;
            setError(nameError, ""); setError(zoneError, ""); setError(langError, "");
            setError(countryError, ""); setError(proxyError, ""); setError(formError, "");
            coherenceWarning.setVisibility(View.GONE);
            boolean valid = true;
            String nameValue = name.getText().toString().trim();
            if (nameValue.isEmpty() || nameValue.length() > 80) {
                setError(nameError, "名称必填且不超过 80 字符");
                valid = false;
                focusError(scrollRef[0], name, nameCard);
            }
            String zoneValue = zone.getText().toString().trim();
            if (zoneValue.isEmpty()) {
                setError(zoneError, "时区必填");
                valid = false;
                focusError(scrollRef[0], zone, zoneCard);
            } else {
                try {
                    ZoneId.of(zoneValue);
                    if (!ZoneId.getAvailableZoneIds().contains(zoneValue) && !"UTC".equals(zoneValue)) {
                        throw new IllegalArgumentException("A named IANA timezone is required");
                    }
                } catch (RuntimeException failure) {
                    setError(zoneError, "无效的 IANA 时区，例如 Asia/Shanghai");
                    valid = false;
                    focusError(scrollRef[0], zone, zoneCard);
                }
            }
            List<String> tags = parseLanguages(languages.getText().toString(), langError);
            if (tags == null) { valid = false; focusError(scrollRef[0], languages, langCard); }
            String countryValue = country.getText().toString().trim().toUpperCase(Locale.ROOT);
            if (!countryValue.isEmpty() && (!countryValue.matches("[A-Z]{2}")
                    || !Arrays.asList(Locale.getISOCountries()).contains(countryValue))) {
                setError(countryError, "请输入有效的两位 ISO 地区代码，或留空");
                valid = false;
                focusError(scrollRef[0], country, advancedCard);
            }
            if (valid && original == null && selectedProxy[0] == null) {
                setError(proxyError, "请选择一个管理的代理");
                valid = false;
                focusError(scrollRef[0], null, proxyCard);
            }
            // Non-blocking coherence note: manual declarations are compared for plausibility.
            // This never claims any observation and never blocks the save.
            if (valid && !countryValue.isEmpty()) {
                String expected = ProxyGeoProbe.suggestedLanguage(countryValue);
                boolean regionMatched = expected == null;
                if (!regionMatched) {
                    String primary = expected.contains("-") ? expected.substring(0, expected.indexOf('-')) : expected;
                    for (String tag : tags) {
                        String region = tag.contains("-") ? tag.substring(tag.lastIndexOf('-') + 1) : "";
                        if (region.equalsIgnoreCase(countryValue)) { regionMatched = true; break; }
                        // Region-less or script-only tags (zh, zh-Hans) still plausibly match.
                        if (tag.equalsIgnoreCase(primary) || tag.toLowerCase(Locale.ROOT)
                                .startsWith(primary.toLowerCase(Locale.ROOT) + "-")) { regionMatched = true; break; }
                    }
                }
                if (!regionMatched) {
                    coherenceWarning.setText("地区 " + countryValue + " 通常搭配 " + expected
                            + "；当前语言列表没有该区域的标签。不影响启动，仅提醒一致性（均为手动配置）。");
                    coherenceWarning.setVisibility(View.VISIBLE);
                }
            }
            if (!valid) return;

            saving[0] = true;
            if (saveRef[0] != null) Ui.setBusy(saveRef[0], true);
            String revision = UUID.randomUUID().toString();
            ProfileSpec.DeviceMode mode = declaredModel.isChecked()
                    ? ProfileSpec.DeviceMode.DECLARED_ANDROID : ProfileSpec.DeviceMode.NATIVE;
            String modelValue = model.getText().toString().trim();
            try {
                if (original == null) {
                    ManagedProxy selected = selectedProxy[0];
                    ProfileSpec candidate = new ProfileSpec(UUID.randomUUID().toString(), revision, nameValue,
                            selected.proxy, countryValue, zoneValue, tags, mode, modelValue, "");
                    repository.saveProfileWithProxy(candidate, null, selected.id);
                } else {
                    ManagedProxy chosen = selectedProxy[0] != null ? selectedProxy[0] : boundProxy;
                    if (chosen == null && boundProxyId == null) {
                        // Legacy profile: keep its stored endpoint and credentials untouched.
                        ProfileSpec candidate = new ProfileSpec(original.id, revision, nameValue, original.proxy,
                                countryValue, zoneValue, tags, mode, modelValue, original.credentialRevision);
                        repository.saveProfileKeepingCredentials(candidate, original.revision);
                    } else {
                        if (chosen == null) throw new StorageException(StorageException.Code.PROXY_NOT_FOUND);
                        ManagedProxy selected = chosen;
                        ProfileSpec candidate = new ProfileSpec(original.id, revision, nameValue, selected.proxy,
                                countryValue, zoneValue, tags, mode, modelValue, "");
                        repository.saveProfileWithProxy(candidate, original.revision, selected.id);
                    }
                }
                holder[0].dismiss();
                Ui.snackbar(activity, original == null ? "已创建环境 “" + nameValue + "”" : "已保存环境 “" + nameValue + "”");
                saved.run();
            } catch (RuntimeException failure) {
                saving[0] = false;
                if (saveRef[0] != null) Ui.setBusy(saveRef[0], false);
                setError(formError, Ui.friendlyError(failure));
            }
        };
        EditorShell chrome = shell(activity, original == null ? "新建环境" : "编辑环境", content,
                cancelAction, saveAction, formError);
        Dialog dialog = chrome.dialog;
        holder[0] = dialog;
        saveRef[0] = chrome.save;
        scrollRef[0] = chrome.scroll;
        model.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_DONE
                    || (event != null && event.getKeyCode() == android.view.KeyEvent.KEYCODE_ENTER
                    && event.getAction() == KeyEvent.ACTION_UP)) {
                saveAction.onClick(view);
                return true;
            }
            return false;
        });
        dialog.setCancelable(false);
        dialog.setOnKeyListener((d, keyCode, event) -> {
            if (keyCode == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_UP) {
                if (dirty.getAsBoolean()) confirmDiscard(activity, dialog);
                else dialog.dismiss();
                return true;
            }
            return false;
        });
        dialog.show();
    }

    // ---- Managed proxy picker ---------------------------------------------------------------

    private static void showProxyPicker(Activity activity, ProfileRepository repository, Consumer<ManagedProxy> pick) {
        List<ManagedProxy> proxies = repository.listProxies();
        if (proxies.isEmpty()) {
            Ui.Sheet sheet = Ui.Sheet.create(activity, "选择管理的代理", "还没有管理代理，请先新建一个。");
            sheet.actions("取消", null, "新建代理", () -> {
                sheet.dialog().dismiss();
                ProxyEditor.showWithResult(activity, repository, null, pick);
            }).show();
            return;
        }
        List<String> options = new ArrayList<>();
        List<String> keys = new ArrayList<>();
        for (ManagedProxy proxy : proxies) {
            String line = proxy.name + " · " + endpoint(proxy) + "（" + repository.proxyUsageCount(proxy.id) + " 个环境使用）";
            options.add(line);
            keys.add((proxy.name + " " + line).toLowerCase(Locale.ROOT));
        }
        showPicker(activity, "选择管理的代理", options, keys,
                (index, line) -> pick.accept(proxies.get(index)));
    }

    private static String endpoint(ManagedProxy proxy) {
        return proxy.proxy.scheme.name() + " " + proxy.proxy.authority();
    }

    private static void showTimezonePicker(Activity activity, Consumer<String> pick) {
        String[] ids = ZoneId.getAvailableZoneIds().toArray(new String[0]);
        Arrays.sort(ids);
        List<String> options = new ArrayList<>(Arrays.asList(ids));
        showPicker(activity, "选择时区（IANA，可搜索）", options, new ArrayList<>(options),
                (index, id) -> pick.accept(id));
    }

    private static void showLanguagePicker(Activity activity, Consumer<String> pick) {
        List<String> options = new ArrayList<>(Arrays.asList(LANGUAGE_PRESETS));
        List<String> keys = new ArrayList<>();
        for (String option : options) keys.add(option.toLowerCase(Locale.ROOT));
        showPicker(activity, "选择语言（BCP 47，可搜索）", options, keys,
                (index, line) -> pick.accept(line.split(" ", 2)[0]));
    }

    /** Native searchable picker; `options` and `keys` stay index-aligned. */
    static void showPicker(Activity activity, String title, List<String> options, List<String> keys, Pick pick) {
        LinearLayout panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackground(rounded(activity, Ui.WHITE, 26, 0, 0));
        int pad = Ui.dp(activity, 20);
        panel.setPadding(pad, Ui.dp(activity, 18), pad, Ui.dp(activity, 16));
        TextView heading = new TextView(activity);
        heading.setText(title);
        heading.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 19);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setTextColor(Ui.INK);
        panel.addView(heading);
        EditText search = Ui.searchField(activity);
        search.setHint("搜索");
        search.setHintTextColor(Ui.FAINT);
        search.setSingleLine(true);
        search.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH);
        search.setBackground(rounded(activity, Ui.SURFACE_SOFT, 14, Ui.STROKE, 1));
        search.setTextColor(Ui.INK);
        search.setPadding(Ui.dp(activity, 16), Ui.dp(activity, 12), Ui.dp(activity, 16), Ui.dp(activity, 12));
        search.setMinHeight(Ui.dp(activity, 48));
        search.setContentDescription("搜索列表");
        LinearLayout.LayoutParams searchLp = new LinearLayout.LayoutParams(-1, -2);
        searchLp.topMargin = Ui.dp(activity, 12);
        panel.addView(search, searchLp);
        ListView list = new ListView(activity);
        list.setDivider(null);
        list.setVerticalScrollBarEnabled(false);
        LinearLayout.LayoutParams listLp = new LinearLayout.LayoutParams(-1, Ui.dp(activity, 360));
        listLp.topMargin = Ui.dp(activity, 8);
        panel.addView(list, listLp);
        Button close = Ui.tonal(activity, "关闭", null);
        LinearLayout.LayoutParams closeLp = new LinearLayout.LayoutParams(-1, Ui.dp(activity, 48));
        closeLp.topMargin = Ui.dp(activity, 10);
        panel.addView(close, closeLp);
        List<Integer> visible = new ArrayList<>();
        ArrayAdapter<String> adapter = new ArrayAdapter<String>(activity,
                android.R.layout.simple_list_item_1, new ArrayList<>()) {
            @Override public View getView(int position, View convert, android.view.ViewGroup parent) {
                TextView view = new TextView(activity);
                view.setText(getItem(position));
                view.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14.5f);
                view.setTextColor(Ui.INK);
                view.setPadding(Ui.dp(activity, 14), Ui.dp(activity, 14),
                        Ui.dp(activity, 14), Ui.dp(activity, 14));
                view.setBackground(rounded(activity, Ui.SURFACE_SOFT, 12, Ui.STROKE, 1));
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
                lp.bottomMargin = Ui.dp(activity, 6);
                view.setLayoutParams(lp);
                return view;
            }
        };
        list.setAdapter(adapter);
        Dialog dialog = new Dialog(activity);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setContentView(panel);
        dialog.getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        DisplayMetrics metrics = activity.getResources().getDisplayMetrics();
        dialog.getWindow().setLayout((int) (metrics.widthPixels * 0.94f),
                (int) (metrics.heightPixels * 0.78f));
        close.setOnClickListener(view -> dialog.dismiss());
        Runnable refilter = () -> {
            String query = search.getText().toString().trim().toLowerCase(Locale.ROOT);
            adapter.clear();
            visible.clear();
            for (int i = 0; i < options.size(); i++) {
                if (query.isEmpty() || keys.get(i).toLowerCase(Locale.ROOT).contains(query)) {
                    visible.add(i);
                    adapter.add(options.get(i));
                }
            }
        };
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }
            @Override public void afterTextChanged(Editable s) { refilter.run(); }
        });
        list.setOnItemClickListener((parent, view, position, id) -> {
            int index = visible.get(position);
            dialog.dismiss();
            pick.onPick(index, options.get(index));
        });
        refilter.run();
        dialog.show();
    }

    private static void appendLanguage(EditText languages, String tag) {
        String current = languages.getText().toString().trim();
        for (String part : current.split(",", -1)) {
            if (part.trim().equalsIgnoreCase(tag)) return;
        }
        languages.setText(current.isEmpty() ? tag : current + "," + tag);
    }

    private static List<String> parseLanguages(String raw, TextView error) {
        List<String> tags = new ArrayList<>();
        for (String part : raw.split(",", -1)) {
            String tag = part.trim();
            if (tag.isEmpty()) { setError(error, "语言标签不能包含空项"); return null; }
            if (tag.length() > 35 || !tag.matches("[A-Za-z0-9]{1,8}(-[A-Za-z0-9]{1,8})*")) {
                setError(error, "无效的 BCP 47 标签：" + tag);
                return null;
            }
            tags.add(tag);
        }
        if (tags.isEmpty()) { setError(error, "至少需要一个语言标签"); return null; }
        if (tags.size() > 8) { setError(error, "最多支持 8 个语言标签"); return null; }
        return tags;
    }

    // ---- Shared editor chrome (also used by ProxyEditor) -------------------------------------

    static GradientDrawable rounded(Context context, int color, int radiusDp, int strokeColor, int strokeDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(Ui.dp(context, radiusDp));
        if (strokeColor != 0) drawable.setStroke(Ui.dp(context, strokeDp), strokeColor);
        return drawable;
    }

    static LinearLayout card(Context context, LinearLayout parent, String title) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(rounded(context, Ui.WHITE, 20, Ui.STROKE, 1));
        card.setElevation(Ui.dp(context, 1.5f));
        int pad = Ui.dp(context, 18);
        card.setPadding(pad, pad, pad, pad);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = Ui.dp(context, 14);
        parent.addView(card, lp);
        if (title != null) {
            TextView heading = new TextView(context);
            heading.setText(title);
            heading.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12.5f);
            heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            heading.setLetterSpacing(0.06f);
            heading.setTextColor(Ui.FAINT);
            heading.setAllCaps(true);
            card.addView(heading);
            card.addView(new View(context), new LinearLayout.LayoutParams(-1, Ui.dp(context, 6)));
        }
        return card;
    }

    static TextView hint(Context context, String value) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12.5f);
        view.setTextColor(Ui.MUTED);
        view.setLineSpacing(Ui.dp(context, 2), 1f);
        view.setPadding(0, Ui.dp(context, 6), 0, Ui.dp(context, 6));
        return view;
    }

    static TextView errorLine(Context context, LinearLayout parent) {
        TextView view = new TextView(context);
        view.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12.5f);
        view.setTextColor(Ui.DANGER);
        view.setVisibility(View.GONE);
        view.setPadding(0, Ui.dp(context, 4), 0, 0);
        if (parent != null) parent.addView(view);
        return view;
    }

    static void setError(TextView view, String message) {
        view.setText(message);
        view.setVisibility(message == null || message.isEmpty() ? View.GONE : View.VISIBLE);
    }

    /** Bring the failed card into view and focus the offending field, so errors are findable. */
    private static void focusError(android.widget.ScrollView scroll, EditText field, LinearLayout card) {
        if (scroll == null || card == null) return;
        scroll.post(() -> scroll.smoothScrollTo(0, Math.max(0, card.getTop() - Ui.dp(scroll.getContext(), 8))));
        if (field != null && field.isEnabled()) field.requestFocus();
    }

    static Button styledButton(Context context, String label, boolean filled) {
        Button view = filled ? Ui.primary(context, label, null) : Ui.tonal(context, label, null);
        view.setMinHeight(Ui.dp(context, 48));
        view.setMinimumHeight(Ui.dp(context, 48));
        return view;
    }

    /** Editor chrome bundle: the dialog plus controls actions need to drive (busy state, scrolling). */
    static final class EditorShell {
        final Dialog dialog;
        final Button save;
        final ScrollView scroll;
        EditorShell(Dialog dialog, Button save, ScrollView scroll) {
            this.dialog = dialog; this.save = save; this.scroll = scroll;
        }
    }

    /** Full-height editor sheet: large title, scrollable floating cards and sticky actions. */
    static EditorShell shell(Activity activity, String title, LinearLayout content,
            View.OnClickListener cancelAction, View.OnClickListener saveAction, TextView formError) {
        Dialog dialog = new Dialog(activity);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackground(rounded(activity, Ui.WHITE, 26, 0, 0));
        int pad = Ui.dp(activity, 20);
        panel.setPadding(pad, Ui.dp(activity, 18), pad, Ui.dp(activity, 16));
        View handle = new View(activity);
        GradientDrawable handleBackground = new GradientDrawable();
        handleBackground.setColor(0xFFD8DCE6);
        handleBackground.setCornerRadius(Ui.dp(activity, 3));
        handle.setBackground(handleBackground);
        LinearLayout.LayoutParams handleLp = new LinearLayout.LayoutParams(Ui.dp(activity, 40), Ui.dp(activity, 4.5f));
        handleLp.gravity = Gravity.CENTER_HORIZONTAL;
        panel.addView(handle, handleLp);
        TextView heading = new TextView(activity);
        heading.setText(title);
        heading.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 21);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setLetterSpacing(-0.02f);
        heading.setTextColor(Ui.INK);
        LinearLayout.LayoutParams headingLp = new LinearLayout.LayoutParams(-1, -2);
        headingLp.topMargin = Ui.dp(activity, 14);
        panel.addView(heading, headingLp);

        LinearLayout canvas = new LinearLayout(activity);
        canvas.setOrientation(LinearLayout.VERTICAL);
        canvas.setBackgroundColor(Color.TRANSPARENT);
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.addView(content);
        canvas.addView(scroll, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams canvasLp = new LinearLayout.LayoutParams(-1, 0, 1f);
        canvasLp.topMargin = Ui.dp(activity, 6);
        panel.addView(canvas, canvasLp);

        LinearLayout footer = new LinearLayout(activity);
        footer.setOrientation(LinearLayout.HORIZONTAL);
        footer.setGravity(Gravity.CENTER_VERTICAL);
        Button cancel = Ui.ghost(activity, "取消", null);
        Button save = Ui.primary(activity, "保存", null);
        formError.setPadding(0, Ui.dp(activity, 2), Ui.dp(activity, 12), 0);
        LinearLayout.LayoutParams errorLp = new LinearLayout.LayoutParams(0, -2, 1f);
        footer.addView(formError, errorLp);
        LinearLayout.LayoutParams cancelLp = new LinearLayout.LayoutParams(0, Ui.dp(activity, 50), 1f);
        LinearLayout.LayoutParams saveLp = new LinearLayout.LayoutParams(0, Ui.dp(activity, 50), 1.25f);
        saveLp.leftMargin = Ui.dp(activity, 10);
        footer.addView(cancel, cancelLp);
        footer.addView(save, saveLp);
        LinearLayout.LayoutParams footerLp = new LinearLayout.LayoutParams(-1, -2);
        footerLp.topMargin = Ui.dp(activity, 14);
        panel.addView(footer, footerLp);
        cancel.setOnClickListener(view -> { Ui.haptic(view); cancelAction.onClick(view); });
        save.setOnClickListener(view -> { Ui.haptic(view); saveAction.onClick(view); });

        dialog.setContentView(panel);
        DisplayMetrics metrics = activity.getResources().getDisplayMetrics();
        dialog.getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        dialog.getWindow().setLayout((int) (metrics.widthPixels * 0.96f), (int) (metrics.heightPixels * 0.94f));
        return new EditorShell(dialog, save, scroll);
    }

    static void showFailure(Activity activity, RuntimeException failure) {
        Ui.Sheet sheet = Ui.Sheet.create(activity, "暂时无法完成操作", null);
        sheet.text(Ui.friendlyError(failure));
        sheet.actions(null, null, "知道了", null).show();
    }

    static void confirmDiscard(Activity activity, Dialog target) {
        Ui.Sheet sheet = Ui.Sheet.create(activity, "放弃未保存的更改？", "离开将丢失尚未保存的修改。");
        sheet.actions("继续编辑", null, "放弃", target::dismiss).show();
    }

    private static boolean changed(EditText field, String baseline) {
        return !field.getText().toString().equals(baseline);
    }
}
