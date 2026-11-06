package com.ahoo.abs.android.browser;

public final class ControlProtocol {
    public static final int HELLO = 1;
    public static final int DRAIN = 2;
    public static final int EXIT_SELF = 3;
    public static final int EXIT_REJECTED = 4;
    public static final int HELLO_REPLY = 101;
    public static final int DRAIN_REPLY = 102;
    public static final int ERROR = 199;
    public static final String SESSION = "session";
    public static final String NONCE = "nonce";
    public static final String INCARNATION = "incarnation";
    public static final String PID = "pid";
    public static final String CODE = "code";
    public static final String COOKIE = "cookieFlush";

    private ControlProtocol() { }
}
