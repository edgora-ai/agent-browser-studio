package com.ahoo.abs.android;

import android.app.Dialog;
import android.app.Activity;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;
import com.ahoo.abs.android.data.ManagedProxy;
import com.ahoo.abs.android.data.ProfileRepository;
import com.ahoo.abs.core.ProxySpec;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * Managed proxy editor: named reusable endpoints only. Authentication and any network-based
 * GeoIP observation are deliberately out of scope; deletion lives with the manager, not here.
 */
public final class ProxyEditor {
    // UI order is explicit and does not depend on the enum's declaration order.
    private static final List<ProxySpec.Scheme> PROTOCOLS = Collections.unmodifiableList(Arrays.asList(
            ProxySpec.Scheme.HTTP, ProxySpec.Scheme.HTTPS, ProxySpec.Scheme.SOCKS5));
    private ProxyEditor() { }

    public static void show(Activity activity, ProfileRepository repository, ManagedProxy original, Runnable saved) {
        showWithResult(activity, repository, original, proxy -> saved.run());
    }

    static void showWithResult(Activity activity, ProfileRepository repository, ManagedProxy original,
            Consumer<ManagedProxy> saved) {
        try { showForm(activity, repository, original, saved); }
        catch (RuntimeException failure) { ProfileEditor.showFailure(activity, failure); }
    }

    private static void showForm(Activity activity, ProfileRepository repository, ManagedProxy original,
            Consumer<ManagedProxy> saved) {
        int usage = original == null ? 0 : repository.proxyUsageCount(original.id);
        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        if (usage > 0) {
            content.addView(ProfileEditor.hint(activity,
                    "此代理被 " + usage
                            + " 个环境使用：修改端点会同步到所有未启动的关联环境；正在运行的环境会拒绝此修改。"));
        }
        content.addView(ProfileEditor.hint(activity, "管理的代理不支持用户名/密码认证（内核限制）。"));

        LinearLayout nameCard = ProfileEditor.card(activity, content, "名称");
        EditText name = Ui.field(activity, nameCard, "代理名称（必填，最长 80 字符）", original == null ? "" : original.name);
        name.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(80)});
        TextView nameError = ProfileEditor.errorLine(activity, nameCard);

        LinearLayout endpointCard = ProfileEditor.card(activity, content, "端点");
        endpointCard.addView(Ui.text(activity, "协议", 14));
        Spinner protocol = new Spinner(activity);
        protocol.setBackground(ProfileEditor.rounded(activity, Ui.SURFACE_SOFT, 14, Ui.STROKE, 1));
        protocol.setPadding(Ui.dp(activity, 14), 0, Ui.dp(activity, 14), 0);
        protocol.setContentDescription("协议");
        protocol.setAdapter(new ArrayAdapter<ProxySpec.Scheme>(activity,
                android.R.layout.simple_spinner_dropdown_item, PROTOCOLS) {
            private TextView styled(int position) {
                TextView view = new TextView(activity);
                view.setText(PROTOCOLS.get(position).name());
                view.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 15);
                view.setTextColor(Ui.INK);
                view.setGravity(Gravity.CENTER_VERTICAL);
                view.setPadding(Ui.dp(activity, 16), 0, Ui.dp(activity, 16), 0);
                return view;
            }

            @Override public View getView(int position, View convert, ViewGroup parent) {
                return styled(position);
            }

            @Override public View getDropDownView(int position, View convert, ViewGroup parent) {
                TextView view = styled(position);
                view.setMinHeight(Ui.dp(activity, 48));
                return view;
            }
        });
        if (original != null) protocol.setSelection(PROTOCOLS.indexOf(original.proxy.scheme));
        endpointCard.addView(protocol, new LinearLayout.LayoutParams(-1, Ui.dp(activity, 48)));

        EditText paste = Ui.field(activity, endpointCard, "粘贴代理地址（可选：host:port 或 scheme://host:port）", "");
        Button parse = ProfileEditor.styledButton(activity, "解析并填充", false);
        endpointCard.addView(parse);
        TextView pasteError = ProfileEditor.errorLine(activity, endpointCard);
        TextView pasteOk = ProfileEditor.errorLine(activity, endpointCard);
        pasteOk.setTextColor(Ui.SUCCESS);
        EditText host = Ui.field(activity, endpointCard, "主机（域名或 IP，不含端口与凭据）",
                original == null ? "" : original.proxy.host);
        EditText port = Ui.field(activity, endpointCard, "端口（必填 1–65535）",
                original == null ? "" : Integer.toString(original.proxy.port));
        port.setInputType(InputType.TYPE_CLASS_NUMBER);
        port.setFilters(new android.text.InputFilter[]{
                android.text.method.DigitsKeyListener.getInstance("0123456789"),
                new android.text.InputFilter.LengthFilter(5)});
        TextView hostError = ProfileEditor.errorLine(activity, endpointCard);
        TextView portError = ProfileEditor.errorLine(activity, endpointCard);
        // Honest exit probe: reachable via the proxy only; browser routing stays UNVERIFIED.
        Button testExit = ProfileEditor.styledButton(activity, "测试出口", false);
        endpointCard.addView(testExit);
        TextView testResult = ProfileEditor.errorLine(activity, endpointCard);
        testResult.setTextColor(Ui.MUTED);
        parse.setOnClickListener(button -> { Ui.haptic(button); parseEndpoint(paste, protocol, host, port, pasteError); });
        paste.addTextChangedListener(new android.text.TextWatcher() {
            private String lastFilled;
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }
            @Override public void afterTextChanged(android.text.Editable value) {
                String text = value.toString().trim();
                ProfileEditor.setError(pasteOk, "");
                if (text.isEmpty() || text.equals(lastFilled)) return;
                try {
                    ProxySpec endpoint = ProxyEndpointInput.parse(text, (ProxySpec.Scheme) protocol.getSelectedItem());
                    lastFilled = text;
                    host.setText(endpoint.host);
                    port.setText(Integer.toString(endpoint.port));
                    protocol.setSelection(PROTOCOLS.indexOf(endpoint.scheme));
                    ProfileEditor.setError(pasteOk,
                            "已识别 " + endpoint.scheme.name() + " " + endpoint.host + ":" + endpoint.port);
                } catch (RuntimeException ignored) {
                    // Mid-typing or unsupported input stays silent; the explicit button reports errors.
                }
            }
        });

        String baselineName = name.getText().toString();
        String baselineHost = host.getText().toString();
        String baselinePort = port.getText().toString();
        int baselineProtocol = protocol.getSelectedItemPosition();
        BooleanSupplier dirty = () -> changed(name, baselineName) || changed(host, baselineHost)
                || changed(port, baselinePort) || protocol.getSelectedItemPosition() != baselineProtocol
                || !paste.getText().toString().trim().isEmpty();

        TextView formError = ProfileEditor.errorLine(activity, null);
        Dialog[] holder = new Dialog[1];
        final boolean[] saving = {false};
        final Button[] saveRef = {null};
        final java.util.concurrent.atomic.AtomicBoolean probing = new java.util.concurrent.atomic.AtomicBoolean();
        View.OnClickListener testAction = button -> {
            if (!probing.compareAndSet(false, true)) return;
            Ui.haptic(button);
            ProfileEditor.setError(testResult, "");
            String hostValue = host.getText().toString().trim();
            int portValue = 0;
            try { portValue = Integer.parseInt(port.getText().toString().trim()); } catch (NumberFormatException ignored) { }
            if (hostValue.isEmpty() || portValue < 1 || portValue > 65535) {
                probing.set(false);
                ProfileEditor.setError(testResult, "请先填写完整的主机与端口，再测试出口。");
                testResult.setTextColor(Ui.WARNING);
                return;
            }
            ProxySpec spec = new ProxySpec((ProxySpec.Scheme) protocol.getSelectedItem(), hostValue, portValue, false);
            Ui.setBusy(testExit, true);
            testResult.setText("正在通过代理探测出口…（最长约 15 秒）");
            testResult.setTextColor(Ui.MUTED);
            PROBE_EXECUTOR.execute(() -> {
                String message;
                int color;
                try {
                    ProxyGeoProbe.Observation observed = ProxyGeoProbe.fetch(activity, spec);
                    message = "代理可达 · 观测出口：" + observed.countryCode + " · " + observed.timeZoneId
                            + "\n仅验证代理可达，未验证浏览器流量走向。";
                    color = Ui.SUCCESS;
                } catch (ProxyGeoProbe.ProbeException failure) {
                    color = Ui.WARNING;
                    if ("GEO_TRANSPORT_UNSUPPORTED".equals(failure.code)) {
                        message = "该传输方式暂不支持探测（当前仅支持 HTTP 代理）。";
                    } else if ("GEO_AUTH_UNSUPPORTED".equals(failure.code)) {
                        message = "暂不支持带认证的代理探测。";
                    } else {
                        message = "探测失败（" + failure.code + "），请检查代理后重试。";
                    }
                } catch (RuntimeException failure) {
                    color = Ui.WARNING;
                    message = "探测失败，请检查代理后重试。";
                }
                final String line = message;
                final int lineColor = color;
                activity.runOnUiThread(() -> {
                    probing.set(false);
                    if (activity.isFinishing() || activity.isDestroyed()
                            || holder[0] == null || !holder[0].isShowing()) return;
                    Ui.setBusy(testExit, false);
                    testResult.setText(line);
                    testResult.setTextColor(lineColor);
                });
            });
        };
        testExit.setOnClickListener(button -> testAction.onClick(button));
        View.OnClickListener cancelAction = button -> {
            if (dirty.getAsBoolean()) ProfileEditor.confirmDiscard(activity, holder[0]);
            else holder[0].dismiss();
        };
        View.OnClickListener saveAction = button -> {
            if (saving[0]) return;
            ProfileEditor.setError(nameError, ""); ProfileEditor.setError(hostError, "");
            ProfileEditor.setError(portError, "");
            ProfileEditor.setError(formError, "");
            if (!paste.getText().toString().trim().isEmpty()
                    && !parseEndpoint(paste, protocol, host, port, pasteError)) return;
            boolean valid = true;
            String nameValue = name.getText().toString().trim();
            if (nameValue.isEmpty() || nameValue.length() > 80) {
                ProfileEditor.setError(nameError, "名称必填且不超过 80 字符");
                valid = false;
            }
            String hostValue = host.getText().toString().trim();
            if (hostValue.isEmpty() || hostValue.matches(".*\\s.*") || hostValue.contains("/")
                    || hostValue.contains("@") || hostValue.contains("://")) {
                ProfileEditor.setError(hostError, "主机不能为空，且不含路径、空格或凭据");
                valid = false;
            }
            int portValue = 0;
            try { portValue = Integer.parseInt(port.getText().toString().trim()); } catch (NumberFormatException ignored) { }
            if (portValue < 1 || portValue > 65535) {
                ProfileEditor.setError(portError, "端口需为 1–65535 的数字");
                valid = false;
            }
            if (!valid) return;
            saving[0] = true;
            if (saveRef[0] != null) Ui.setBusy(saveRef[0], true);
            try {
                ProxySpec endpoint = new ProxySpec((ProxySpec.Scheme) protocol.getSelectedItem(),
                        hostValue, portValue, false);
                String id = original == null ? UUID.randomUUID().toString() : original.id;
                ManagedProxy stored = repository.saveProxy(new ManagedProxy(id, UUID.randomUUID().toString(), nameValue, endpoint),
                        original == null ? null : original.revision);
                holder[0].dismiss();
                Ui.snackbar(activity, original == null ? "已添加代理 “" + nameValue + "”" : "已保存代理 “" + nameValue + "”");
                saved.accept(stored);
            } catch (RuntimeException failure) {
                saving[0] = false;
                if (saveRef[0] != null) Ui.setBusy(saveRef[0], false);
                ProfileEditor.setError(formError, Ui.friendlyError(failure));
            }
        };
        ProfileEditor.EditorShell chrome = ProfileEditor.shell(activity, original == null ? "新建代理" : "编辑代理", content,
                cancelAction, saveAction, formError);
        Dialog dialog = chrome.dialog;
        holder[0] = dialog;
        saveRef[0] = chrome.save;
        if (original != null) {
            name.setSelectAllOnFocus(false);
            host.setSelectAllOnFocus(false);
            port.setSelectAllOnFocus(false);
        }
        host.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_NEXT);
        port.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_DONE);
        port.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_DONE
                    || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                    && event.getAction() == KeyEvent.ACTION_UP)) {
                saveAction.onClick(view);
                return true;
            }
            return false;
        });
        dialog.setCancelable(false);
        dialog.setOnKeyListener((d, keyCode, event) -> {
            if (keyCode == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_UP) {
                if (dirty.getAsBoolean()) ProfileEditor.confirmDiscard(activity, dialog);
                else dialog.dismiss();
                return true;
            }
            return false;
        });
        dialog.show();
    }

    /** Single background worker for exit probes; probes are sequential by design. */
    private static final java.util.concurrent.ExecutorService PROBE_EXECUTOR =
            java.util.concurrent.Executors.newSingleThreadExecutor(runnable -> {
                Thread worker = new Thread(runnable, "abs-proxy-exit-probe");
                worker.setDaemon(true);
                return worker;
            });

    /** Validate completely before changing any form fields; never discard pasted credentials. */
    private static boolean parseEndpoint(EditText paste, Spinner protocol, EditText host, EditText port, TextView error) {
        ProfileEditor.setError(error, "");
        try {
            ProxySpec endpoint = ProxyEndpointInput.parse(paste.getText().toString(),
                    (ProxySpec.Scheme) protocol.getSelectedItem());
            host.setText(endpoint.host);
            port.setText(Integer.toString(endpoint.port));
            protocol.setSelection(PROTOCOLS.indexOf(endpoint.scheme));
            paste.setText("");
            return true;
        } catch (RuntimeException failure) {
            String code = Ui.errorCode(failure);
            ProfileEditor.setError(error, "PROXY_AUTH_UNSUPPORTED".equals(code)
                    ? "此内核不支持代理认证，请使用不带用户名/密码的端点。原端点未改动。"
                    : "请输入完整的 HTTP / HTTPS / SOCKS5 主机与端口，不含路径或凭据。原端点未改动。");
            return false;
        }
    }

    private static boolean changed(EditText field, String baseline) {
        return !field.getText().toString().equals(baseline);
    }
}
