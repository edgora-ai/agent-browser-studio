package com.ahoo.abs.android;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.ahoo.abs.android.data.StorageException;
import com.ahoo.abs.core.ValidationException;

public final class Ui {
    private Ui() { }

    public static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    public static LinearLayout column(Context context) {
        LinearLayout view = new LinearLayout(context);
        view.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(context, 12);
        view.setPadding(pad, pad, pad, pad);
        return view;
    }

    @SuppressWarnings("deprecation")
    public static LinearLayout root(Activity activity) {
        LinearLayout root = column(activity);
        int pad = dp(activity, 12);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int top;
            int bottom;
            int left;
            int right;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                top = bars.top; bottom = bars.bottom; left = bars.left; right = bars.right;
            } else {
                top = insets.getSystemWindowInsetTop(); bottom = insets.getSystemWindowInsetBottom();
                left = insets.getSystemWindowInsetLeft(); right = insets.getSystemWindowInsetRight();
            }
            view.setPadding(pad + left, pad + top, pad + right, pad + bottom);
            return insets;
        });
        activity.setContentView(root);
        root.requestApplyInsets();
        return root;
    }

    public static TextView text(Context context, String value, int size) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(Color.rgb(23, 32, 42));
        view.setPadding(0, dp(context, 6), 0, dp(context, 8));
        return view;
    }

    public static Button button(Context context, String label, View.OnClickListener action) {
        Button view = new Button(context);
        view.setText(label);
        view.setAllCaps(false);
        view.setMinHeight(dp(context, 48));
        view.setOnClickListener(action);
        return view;
    }

    public static EditText field(Context context, LinearLayout parent, String label, String value) {
        parent.addView(text(context, label, 14));
        EditText input = new EditText(context);
        input.setSingleLine(true);
        input.setText(value);
        input.setMinHeight(dp(context, 48));
        input.setSelectAllOnFocus(true);
        input.setContentDescription(label);
        parent.addView(input, new LinearLayout.LayoutParams(-1, -2));
        return input;
    }

    public static String errorCode(RuntimeException failure) {
        if (failure instanceof ValidationException) return ((ValidationException) failure).code;
        if (failure instanceof StorageException) return ((StorageException) failure).code.name();
        return failure.getClass().getSimpleName();
    }
}
