package com.ahoo.abs.android.data;

import com.ahoo.abs.core.ProxySpec;

/** Named, reusable endpoint. Secret material and direct/system routes are deliberately unsupported. */
public final class ManagedProxy {
    public final String id;
    public final String revision;
    public final String name;
    public final ProxySpec proxy;

    public ManagedProxy(String id, String revision, String name, ProxySpec proxy) {
        this.id = StoreChecks.uuid(id);
        this.revision = StoreChecks.uuid(revision);
        if (name == null || name.trim().isEmpty() || name.length() > 80) throw StoreChecks.invalid();
        for (int i = 0; i < name.length(); i++) {
            if (Character.isISOControl(name.charAt(i))) throw StoreChecks.invalid();
        }
        if (proxy == null || proxy.hasCredentials) throw StoreChecks.invalid();
        this.name = name.trim();
        this.proxy = new ProxySpec(proxy.scheme, proxy.host, proxy.port, false);
    }
}
