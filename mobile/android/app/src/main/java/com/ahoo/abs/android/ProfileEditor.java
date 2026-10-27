package com.ahoo.abs.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Build;
import android.text.InputType;
import android.widget.ArrayAdapter;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import com.ahoo.abs.android.data.CredentialUpdate;
import com.ahoo.abs.android.data.ProfileRepository;
import com.ahoo.abs.core.ProfileSpec;
import com.ahoo.abs.core.ProxySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;

/** Explicit edits only; this form never substitutes the phone's IP for a proxy observation. */
final class ProfileEditor {
    private ProfileEditor() { }

    static void show(Activity activity, ProfileRepository repository, ProfileSpec original, Runnable saved) {
        ScrollView scroll = new ScrollView(activity);
        LinearLayout form = Ui.column(activity);
        scroll.addView(form);
        form.addView(Ui.text(activity, "地区、时区与语言当前为手动配置，不是已检测的代理出口。", 14));
        EditText name = Ui.field(activity, form, "环境名称", original == null ? "" : original.name);
        form.addView(Ui.text(activity, "代理协议（必须指定，不允许直连回退）", 14));
        Spinner protocol = new Spinner(activity);
        protocol.setAdapter(new ArrayAdapter<>(activity, android.R.layout.simple_spinner_dropdown_item,
                new String[]{"HTTP", "HTTPS", "SOCKS5"}));
        if (original != null) protocol.setSelection(original.proxy.scheme.ordinal());
        form.addView(protocol);
        EditText host = Ui.field(activity, form, "代理主机（不含账号、路径或端口）", original == null ? "" : original.proxy.host);
        host.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        EditText port = Ui.field(activity, form, "代理端口（必填 1–65535）", original == null ? "" : Integer.toString(original.proxy.port));
        port.setInputType(InputType.TYPE_CLASS_NUMBER);
        CheckBox authentication = new CheckBox(activity);
        authentication.setText("代理需要用户名/密码（此内核尚不支持安全认证，将阻止启动）");
        authentication.setChecked(original != null && original.proxy.hasCredentials);
        form.addView(authentication);
        EditText username = Ui.field(activity, form, "代理用户名（旧凭据留空可保留）", "");
        username.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        EditText password = Ui.field(activity, form, "代理密码（不会回显已保存值）", "");
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        EditText country = Ui.field(activity, form, "地区代码（可空；手动，非出口实测）", original == null ? "" : original.countryCode);
        country.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS);
        EditText zone = Ui.field(activity, form, "时区（本机值仅为建议，请确认）",
                original == null ? TimeZone.getDefault().getID() : original.timeZoneId);
        EditText languages = Ui.field(activity, form, "语言标签（按顺序逗号分隔，最多 8 个）",
                original == null ? Locale.getDefault().toLanguageTag() : String.join(",", original.languageTags));
        CheckBox declaredModel = new CheckBox(activity);
        declaredModel.setText(R.string.declared_model_label);
        declaredModel.setChecked(original != null && original.deviceMode == ProfileSpec.DeviceMode.DECLARED_ANDROID);
        form.addView(declaredModel);
        EditText model = Ui.field(activity, form, "设备型号（默认保留本机真实身份）",
                original == null ? Build.MODEL : original.deviceModel);
        model.setEnabled(declaredModel.isChecked());
        declaredModel.setOnCheckedChangeListener((button, checked) -> {
            model.setEnabled(checked);
            if (!checked) model.setText(Build.MODEL);
        });
        form.addView(Ui.text(activity, "独立网站数据不代表硬件指纹不可关联。型号、网络与持久化未完成验收时，不开放普通浏览。", 14));
        TextView error = Ui.text(activity, "", 14);
        form.addView(error);
        java.util.concurrent.ExecutorService probes = java.util.concurrent.Executors.newSingleThreadExecutor();
        android.widget.Button detect = Ui.button(activity, "通过此 HTTP 代理获取地区/时区建议", null);
        form.addView(detect);
        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle(original == null ? "新建环境" : "编辑环境")
                .setView(scroll).setNegativeButton("取消", null).setPositiveButton("保存", null).create();
        detect.setOnClickListener(button -> {
            try {
                ProxySpec requested = new ProxySpec(ProxySpec.Scheme.values()[protocol.getSelectedItemPosition()],
                        host.getText().toString().trim(), Integer.parseInt(port.getText().toString()), authentication.isChecked());
                String oldCountry = country.getText().toString();
                String oldZone = zone.getText().toString();
                String oldLanguages = languages.getText().toString();
                detect.setEnabled(false);
                error.setText(R.string.geo_probe_running);
                probes.execute(() -> {
                    try {
                        ProxyGeoProbe.Observation observation = ProxyGeoProbe.fetch(activity.getApplicationContext(), requested);
                        activity.runOnUiThread(() -> {
                            if (!dialog.isShowing()) return;
                            detect.setEnabled(true);
                            boolean same = protocol.getSelectedItemPosition() == requested.scheme.ordinal()
                                    && host.getText().toString().trim().equals(requested.host)
                                    && port.getText().toString().equals(Integer.toString(requested.port))
                                    && authentication.isChecked() == requested.hasCredentials
                                    && country.getText().toString().equals(oldCountry)
                                    && zone.getText().toString().equals(oldZone)
                                    && languages.getText().toString().equals(oldLanguages);
                            if (!same) {
                                error.setText(R.string.geo_probe_stale);
                                return;
                            }
                            country.setText(observation.countryCode);
                            zone.setText(observation.timeZoneId);
                            String language = ProxyGeoProbe.suggestedLanguage(observation.countryCode);
                            if (language != null) languages.setText(language);
                            error.setText(activity.getString(R.string.geo_probe_suggestion,
                                    java.time.Instant.ofEpochMilli(observation.observedAtMillis).toString()));
                        });
                    } catch (ProxyGeoProbe.ProbeException failure) {
                        activity.runOnUiThread(() -> {
                            if (!dialog.isShowing()) return;
                            detect.setEnabled(true);
                            error.setText(activity.getString(R.string.geo_probe_failed, failure.code));
                        });
                    }
                });
            } catch (RuntimeException failure) {
                detect.setEnabled(true);
                error.setText(activity.getString(R.string.geo_probe_not_started, Ui.errorCode(failure)));
            }
        });
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(button -> {
            char[] secret = new char[password.length()];
            password.getText().getChars(0, password.length(), secret, 0);
            try {
                boolean hasCredentials = authentication.isChecked();
                boolean keep = hasCredentials && original != null && original.proxy.hasCredentials
                        && username.length() == 0 && secret.length == 0;
                String credentialRevision = hasCredentials
                        ? (keep ? original.credentialRevision : UUID.randomUUID().toString()) : "";
                List<String> tags = new ArrayList<>();
                for (String tag : languages.getText().toString().split(",", -1)) tags.add(tag.trim());
                if (tags.size() > 8) throw new IllegalArgumentException("LANGUAGE_LIMIT");
                ProfileSpec candidate = new ProfileSpec(original == null ? UUID.randomUUID().toString() : original.id,
                        UUID.randomUUID().toString(), name.getText().toString().trim(),
                        new ProxySpec(ProxySpec.Scheme.values()[protocol.getSelectedItemPosition()], host.getText().toString().trim(),
                                Integer.parseInt(port.getText().toString()), hasCredentials),
                        country.getText().toString().trim(), zone.getText().toString().trim(), tags,
                        declaredModel.isChecked() ? ProfileSpec.DeviceMode.DECLARED_ANDROID : ProfileSpec.DeviceMode.NATIVE,
                        model.getText().toString().trim(), credentialRevision);
                CredentialUpdate update = !hasCredentials ? CredentialUpdate.clear()
                        : keep ? CredentialUpdate.keep() : CredentialUpdate.replace(username.getText().toString(), secret);
                try (CredentialUpdate owned = update) {
                    repository.saveProfile(candidate, original == null ? null : original.revision, owned);
                }
                username.getText().clear();
                password.getText().clear();
                dialog.dismiss();
                saved.run();
            } catch (RuntimeException failure) {
                error.setText(activity.getString(R.string.profile_save_failed, Ui.errorCode(failure)));
            } finally {
                Arrays.fill(secret, '\0');
            }
        }));
        dialog.setOnDismissListener(ignored -> {
            probes.shutdownNow();
            username.getText().clear();
            password.getText().clear();
        });
        dialog.show();
    }
}
