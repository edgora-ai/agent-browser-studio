package com.ahoo.abs.android;

import android.app.Activity;
import android.os.Bundle;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import com.ahoo.abs.android.data.ProfileRepository;
import com.ahoo.abs.android.process.LaunchCoordinator;
import com.ahoo.abs.core.ProfileSpec;
import java.util.List;

/** The exported launcher ignores external profile, URL, proxy and identity extras. */
public final class MainActivity extends Activity {
    private ProfileRepository repository;
    private LaunchCoordinator coordinator;
    private LinearLayout list;
    private TextView status;
    private Runnable runtimeObserver;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = Ui.root(this);
        root.addView(Ui.text(this, "独立环境", 26));
        root.addView(Ui.text(this, getString(R.string.preview_notice), 14));
        status = Ui.text(this, "正在读取配置", 14);
        root.addView(status);
        ScrollView scroll = new ScrollView(this);
        list = Ui.column(this);
        scroll.addView(list);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        try {
            repository = new ProfileRepository(this);
            coordinator = LaunchCoordinator.get(this);
            runtimeObserver = () -> { if (status != null) status.setText(coordinator.status()); };
            coordinator.observe(runtimeObserver);
            root.addView(Ui.button(this, "新建环境", view -> ProfileEditor.show(this, repository, null, this::reload)));
            root.addView(Ui.button(this, "请求退出当前环境", view -> coordinator.stop()));
            root.addView(Ui.button(this, "重新核对进程状态", view -> coordinator.reconcile()));
            reload();
        } catch (RuntimeException failure) {
            status.setText(getString(R.string.storage_unavailable, Ui.errorCode(failure)));
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (repository != null && coordinator != null) {
            coordinator.reconcile();
            reload();
        }
    }

    private void reload() {
        list.removeAllViews();
        try {
            List<ProfileSpec> profiles = repository.listProfiles();
            if (profiles.isEmpty()) list.addView(Ui.text(this, "尚无环境。每个环境使用自己的持久目录；本版本先验证内核能力。", 16));
            for (ProfileSpec profile : profiles) {
                LinearLayout card = Ui.column(this);
                card.setBackgroundColor(android.graphics.Color.WHITE);
                card.addView(Ui.text(this, profile.name, 20));
                card.addView(Ui.text(this, profile.proxy.scheme.name() + " · " + profile.proxy.authority()
                        + "\n地区：" + (profile.countryCode.isEmpty() ? "未知/未实测" : profile.countryCode + "（手动）")
                        + "\n" + profile.timeZoneId + " · " + String.join(", ", profile.languageTags)
                        + "\n型号：" + profile.deviceModel + (profile.deviceMode == ProfileSpec.DeviceMode.NATIVE ? "（本机）" : "（未校准声明）"), 14));
                card.addView(Ui.button(this, "打开能力验证环境", view -> coordinator.open(profile)));
                card.addView(Ui.button(this, "编辑设置", view -> ProfileEditor.show(this, repository, profile, this::reload)));
                LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2);
                layout.bottomMargin = Ui.dp(this, 12);
                list.addView(card, layout);
            }
            if (coordinator != null) status.setText(coordinator.status());
        } catch (RuntimeException failure) {
            status.setText(getString(R.string.profile_read_failed, Ui.errorCode(failure)));
        }
    }

    @Override
    protected void onDestroy() {
        if (coordinator != null) coordinator.clearObserver(runtimeObserver);
        if (repository != null) repository.close();
        super.onDestroy();
    }
}
