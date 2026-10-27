package com.ahoo.abs.android.browser;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.inputmethod.EditorInfo;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.ahoo.abs.android.BrowserApplication;
import com.ahoo.abs.android.MainActivity;
import com.ahoo.abs.android.R;
import com.ahoo.abs.android.Ui;
import com.ahoo.abs.core.LaunchSpec;
import com.ahoo.abs.core.Ping0ObservationPolicy;
import com.ahoo.abs.core.ProfileSpec;

public final class BrowserActivity extends Activity implements BrowserRuntime.Listener {
    private BrowserRuntime runtime;
    private TextView status;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = Ui.root(this);
        status = Ui.text(this, "核对启动授权", 14);
        root.addView(status);
        root.addView(Ui.button(this, "返回环境列表（环境仍在运行）", view -> returnToList()));
        BrowserApplication application = (BrowserApplication) getApplication();
        LaunchSpec launch;
        try {
            launch = application.requireLaunch();
            application.requireBrowserActivation();
            if (application.isDraining() || !launch.sessionId.equals(getIntent().getStringExtra(ControlProtocol.SESSION))
                    || !launch.nonce.equals(getIntent().getStringExtra(ControlProtocol.NONCE))) {
                throw new IllegalStateException("STALE_ACTIVITY_SESSION");
            }
            if (state != null && !launch.sessionId.equals(state.getString(ControlProtocol.SESSION))) {
                throw new IllegalStateException("STALE_SAVED_STATE");
            }
            root.addView(Ui.text(this, launch.profile.name + " · 内核能力验证", 20), 0);
            if (launch.profile.proxy.hasCredentials || launch.profile.deviceMode != ProfileSpec.DeviceMode.NATIVE
                    || !launch.profile.deviceModel.equals(Build.MODEL)) {
                status.setText("此配置被阻止：代理认证或设备模拟尚无安全实现。未初始化网页，也没有去掉密码或改用本机配置。");
                return;
            }
            EditText address = Ui.field(this, root, "地址（完整门禁通过前不开放普通浏览）", "");
            address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
            address.setImeOptions(EditorInfo.IME_ACTION_GO);
            address.setOnEditorActionListener((input, action, event) -> {
                if (action == EditorInfo.IME_ACTION_GO && runtime != null) {
                    runtime.navigate(address.getText().toString());
                    return true;
                }
                return false;
            });
            LinearLayout controls = new LinearLayout(this);
            controls.addView(Ui.button(this, "前往", view -> navigate(address.getText().toString())), new LinearLayout.LayoutParams(0, -2, 1));
            controls.addView(Ui.button(this, "重新自检", view -> { if (runtime != null) runtime.reload(); }), new LinearLayout.LayoutParams(0, -2, 1));
            controls.addView(Ui.button(this, getString(R.string.ping0_observation_button), view -> confirmPing0Observation()),
                    new LinearLayout.LayoutParams(0, -2, 1));
            root.addView(controls);
            root.addView(Ui.button(this, getString(R.string.storage_probe_button), view -> confirmStorageProbe()));
            runtime = BrowserRuntime.get(application);
            WebView webView = runtime.acquireView(this);
            root.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1));
            runtime.attach(webView, this);
        } catch (RuntimeException failure) {
            status.setText(getString(com.ahoo.abs.android.R.string.startup_failure, Ui.errorCode(failure)));
        }
    }

    private void confirmStorageProbe() {
        if (runtime == null) return;
        new AlertDialog.Builder(this)
                .setTitle(R.string.storage_probe_button)
                .setMessage(R.string.storage_probe_confirm)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.storage_probe_start, (dialog, which) -> {
                    try {
                        runtime.openStorageProbe(this);
                    } catch (RuntimeException failure) {
                        status.setText(getString(R.string.storage_probe_failed, Ui.errorCode(failure)));
                    }
                }).show();
    }

    private void confirmPing0Observation() {
        if (runtime == null) return;
        new AlertDialog.Builder(this)
                .setTitle(R.string.ping0_observation_title)
                .setMessage(getString(R.string.ping0_observation_confirm, Ping0ObservationPolicy.DURATION_MILLIS / 1000))
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.ping0_observation_start, (dialog, which) -> {
                    try {
                        runtime.openPing0Observation(this);
                    } catch (RuntimeException failure) {
                        status.setText(getString(R.string.ping0_observation_banner) + "\n"
                                + getString(R.string.ping0_observation_failed, Ui.errorCode(failure)));
                    }
                }).show();
    }

    private void navigate(String value) {
        try {
            if (runtime != null) runtime.navigate(value);
        } catch (RuntimeException failure) {
            status.setText(getString(com.ahoo.abs.android.R.string.navigation_refused, Ui.errorCode(failure)));
        }
    }

    @Override
    public void onStatus(String value) {
        status.setText(value);
    }

    private void returnToList() {
        if (runtime != null) {
            runtime.cancelPing0Observation(this);
            runtime.cancelStorageProbe(this);
        }
        Intent home = new Intent(this, MainActivity.class);
        home.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        // Returning does not claim an exit; the list exposes an explicit stop action.
        startActivity(home);
        finish();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        returnToList();
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        BrowserApplication application = (BrowserApplication) getApplication();
        try {
            state.putString(ControlProtocol.SESSION, application.requireLaunch().sessionId);
        } catch (IllegalStateException rejected) {
            state.putString(ControlProtocol.SESSION, "rejected");
        }
        super.onSaveInstanceState(state);
    }

    @Override
    protected void onStop() {
        if (runtime != null) {
            runtime.cancelPing0Observation(this);
            runtime.cancelStorageProbe(this);
        }
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        if (runtime != null) {
            if (isFinishing()) {
                runtime.cancelPing0Observation(this);
                runtime.cancelStorageProbe(this);
            }
            runtime.detach(this);
        }
        super.onDestroy();
    }
}
