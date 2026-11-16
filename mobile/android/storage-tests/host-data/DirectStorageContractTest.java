package com.ahoo.abs.android.data;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import com.ahoo.abs.core.LaunchSpec;
import com.ahoo.abs.core.ProfileSpec;
import com.ahoo.abs.core.ProxySpec;
import java.util.*;

/** Production Java executes against host JSON/API doubles and real Python SQLite, never Android. */
public final class DirectStorageContractTest {
    private static final Context CONTEXT = new Context();
    private static final String ID = "12345678-1234-4234-8234-123456789abc";
    private static final String REV = "22345678-1234-4234-8234-123456789abc";
    private static final String CRED = "52345678-1234-4234-8234-123456789abc";
    private static int checks;
    private DirectStorageContractTest() {}
    public static void main(String[] args) {
        codecs(); System.out.println("PASS codecs() [" + checks + " cumulative checks]");
        transitions(); System.out.println("PASS transitions() [" + checks + " cumulative checks]");
        credentialedLegacy(); System.out.println("PASS credentialedLegacy() [" + checks + " cumulative checks]");
        catalogUpdates(); System.out.println("PASS catalogUpdates() [" + checks + " cumulative checks]");
        associations(); System.out.println("PASS associations() [" + checks + " cumulative checks]");
        migrations(2); System.out.println("PASS migrations(2) [" + checks + " cumulative checks]");
        migrations(1); System.out.println("PASS migrations(1) [" + checks + " cumulative checks]");
        directClaim(); System.out.println("PASS directClaim() [" + checks + " cumulative checks]");
        System.out.println("DirectStorageContractTest: " + checks + " checks passed");
    }
    private static void codecs() {
        String[][] vectors = {
            {"563679edbc3c346bf087941752bdc00a65ba73d6f4b7ec7cd270826035f964f4", "957e20a67f919a6082ab14ed01df7ca3f31f7389a5c30a2c0337c08d5b3b033d"},
            {"fdca96694ac50e92b1d1c759dd09108df0e32508b83cc097bba46d32578a7ff5", "a8c30d54c49dd460d9de6104c161b4a279e36db4f80d20222a1d1ea81275fa5e"},
            {"23138daca1b07df4c533e9048fe22188d7291395eb09ebdf6e3f45e09dc2de0a", "9e13f3ae53428de6864348f928d36ec68f0c81d99758fb9d6f60f80d7bf6efca"}
        };
        for (ProxySpec.Scheme scheme : ProxySpec.Scheme.values()) for (int auth = 0; auth < 2; auth++) {
            String endpoint = "{\"scheme\":\"" + scheme.name() + "\",\"host\":\"proxy.example\",\"port\":8080,\"hasCredentials\":" + (auth != 0) + "}";
            String old = fixtureJson(endpoint, auth == 0 ? "" : CRED);
            ProfileSpec decoded = ProfileCodec.fromJson(old);
            check(old.equals(ProfileCodec.toJson(decoded)), "Old JSON byte shape changed");
            check(vectors[scheme.ordinal()][auth].equals(decoded.fingerprint()), "Old v1 stream changed");
            check(!ProfileCodec.freeze(decoded).isDirect(), "Old frozen proxy became direct");
        }
        String direct = fixtureJson("null", "");
        ProfileSpec decoded = ProfileCodec.fromJson(direct);
        check(decoded.isDirect() && !decoded.hasProxyCredentials(), "Explicit null not direct");
        check(direct.equals(ProfileCodec.toJson(decoded)), "Explicit null key removed");
        check("2f7cfccdddcacc4f12bd10f63780718ab29e32564ea2301c996abefd89a294d3".equals(decoded.fingerprint()), "Direct domain changed");
        check(ProfileCodec.freeze(decoded).isDirect(), "Freeze lost direct");
        invalid(direct.replace(",\"proxy\":null", ""));
        for (String malformed : Arrays.asList("false", "0", "\"\"", "[]", "{}",
                "{\"scheme\":\"DIRECT\",\"host\":\"proxy.example\",\"port\":8080,\"hasCredentials\":false}",
                "{\"scheme\":\"HTTP\",\"host\":\"\",\"port\":8080,\"hasCredentials\":false}")) {
            invalid(direct.replace("\"proxy\":null", "\"proxy\":" + malformed));
        }
        invalid(fixtureJson("null", CRED));
        invalid(direct.replace("\"name\":\"Legacy profile\"", "\"name\":\"Legacy profile\",\"networkMode\":\"direct\""));
        String proxy = fixtureJson("{\"scheme\":\"HTTP\",\"host\":\"proxy.example\",\"port\":8080,\"hasCredentials\":false}", "");
        for (String port : Arrays.asList("0", "65536", "8080.0", "\"8080\"", "null")) invalid(proxy.replace("\"port\":8080", "\"port\":" + port));
        invalid(proxy.replace("\"hasCredentials\":false", "\"hasCredentials\":\"false\""));
    }
    private static void transitions() {
        String name = "verification_transitions.sqlite";
        ProfileSpec direct = fresh("Direct profile", null);
        try (ProfileRepository repo = new ProfileRepository(CONTEXT, name)) {
            direct = repo.saveProfileWithoutProxy(direct, null);
            check(repo.proxyIdForProfile(direct.id) == null && repo.listProxies().isEmpty(), "Direct synthesized endpoint");
            ProfileSpec duplicate = repo.saveProfileWithoutProxy(fresh("Direct duplicate", direct.proxy), null);
            check(duplicate.isDirect() && !duplicate.id.equals(direct.id), "Direct duplicate");
            check(!duplicate.dataDirectorySuffix().equals(direct.dataDirectorySuffix()), "Duplicate reused directory");
            ManagedProxy managed = managed("Selected", 8080);
            repo.saveProxy(managed, null);
            ProfileSpec directInput = direct;
            expect(StorageException.Code.INVALID_ARGUMENT, () -> repo.saveProfileWithProxy(directInput, null, managed.id));
            ProfileSpec proxied = edit(direct, managed.proxy);
            expect(StorageException.Code.PROXY_NOT_FOUND, () -> repo.saveProfileWithProxy(proxied, directInput.revision, uuid()));
            ProfileSpec mismatched = edit(direct, new ProxySpec(ProxySpec.Scheme.HTTP, "wrong.example", 8080, false));
            expect(StorageException.Code.REVISION_CONFLICT, () -> repo.saveProfileWithProxy(mismatched, directInput.revision, managed.id));
            check(repo.findProfile(direct.id).isDirect() && repo.proxyUsageCount(managed.id) == 0, "Bad selection became an implicit mode change");
            expect(StorageException.Code.INVALID_ARGUMENT, () -> repo.saveProfileWithoutProxy(proxied, directInput.revision));
            ProfileSpec saved = repo.saveProfileWithProxy(proxied, direct.revision, managed.id);
            check(managed.id.equals(repo.proxyIdForProfile(saved.id)), "Selected link missing");
            check(repo.proxyUsageCount(managed.id) == 1, "Catalog usage");
            check(saved.dataDirectorySuffix().equals(direct.dataDirectorySuffix()), "Mode edit changed directory");
            ProfileSpec back = edit(saved, null);
            expect(StorageException.Code.REVISION_CONFLICT, () -> repo.saveProfileWithoutProxy(back, directInput.revision));
            check(repo.findProfile(saved.id).revision.equals(saved.revision), "Stale CAS changed row");
            ProfileSpec cleared = repo.saveProfileWithoutProxy(back, saved.revision);
            check(cleared.isDirect() && repo.proxyUsageCount(managed.id) == 0, "Proxy to direct failed unlink");
            check(repo.proxyIdForProfile(cleared.id) == null && repo.listProxies().size() == 1, "Direct edited catalog");
            expect(StorageException.Code.CREDENTIAL_UPDATE_INVALID, () -> repo.saveProfile(edit(cleared, null), cleared.revision,
                    CredentialUpdate.replace("synthetic-user", new char[]{'x'})));
            expect(StorageException.Code.INVALID_ARGUMENT, () -> repo.saveProfileWithoutProxy(edit(cleared, null), "bad-revision"));
        }
        try (ProfileRepository repo = new ProfileRepository(CONTEXT, name)) {
            check(repo.findProfile(direct.id).isDirect() && repo.listProfiles().size() == 2, "Reopened direct readback");
        }
    }
    private static void credentialedLegacy() {
        String name = "verification_credentials.sqlite";
        ProfileSpec auth = fresh("Legacy authentication", new ProxySpec(ProxySpec.Scheme.HTTP, "auth.example", 8123, true));
        try (StoreDatabase store = new StoreDatabase(CONTEXT, name, false)) { store.transaction(db -> { seed(db, auth); return null; }); }
        try (ProfileRepository repo = new ProfileRepository(CONTEXT, name)) {
            check(repo.findProfile(auth.id).hasProxyCredentials() && repo.proxyIdForProfile(auth.id) == null, "Legacy auth must remain unlinked");
            ProfileSpec kept = repo.saveProfileKeepingCredentials(edit(auth, auth.proxy), auth.revision);
            check(kept.credentialRevision.equals(auth.credentialRevision), "KEEP rotated credentials");
            ProfileSpec direct = edit(kept, null);
            expect(StorageException.Code.CREDENTIAL_UPDATE_INVALID, () -> repo.saveProfileKeepingCredentials(direct, kept.revision));
            try (StoreDatabase raw = new StoreDatabase(CONTEXT, name, true)) {
                raw.transaction(db -> { db.execSQL("CREATE TRIGGER verification_fail_clear BEFORE DELETE ON credential_envelopes BEGIN SELECT RAISE(ABORT,'synthetic clear denied'); END;"); return null; });
                String before = raw.read(DirectStorageContractTest::snapshot);
                expect(StorageException.Code.DATABASE_UNAVAILABLE, () -> repo.saveProfileWithoutProxy(direct, kept.revision));
                check(before.equals(raw.read(DirectStorageContractTest::snapshot)), "Failed CLEAR did not roll back all rows");
                raw.transaction(db -> { db.execSQL("DROP TRIGGER verification_fail_clear"); return null; });
            }
            ProfileSpec saved = repo.saveProfileWithoutProxy(direct, kept.revision);
            check(saved.isDirect() && saved.credentialRevision.isEmpty(), "Auth to direct metadata");
            try (StoreDatabase raw = new StoreDatabase(CONTEXT, name, true)) {
                check(raw.read(db -> !StoredProfiles.exists(db, "SELECT 1 FROM credential_envelopes WHERE profile_id=?", saved.id)), "Direct retained credential envelope");
            }
        }
    }
    private static void catalogUpdates() {
        String name = "verification_catalog_updates.sqlite";
        try (ProfileRepository repo = new ProfileRepository(CONTEXT, name)) {
            ManagedProxy old = repo.saveProxy(managed("Shared proxy", 8081), null);
            ProfileSpec first = repo.saveProfileWithProxy(fresh("First linked", old.proxy), null, old.id);
            ProfileSpec second = repo.saveProfileWithProxy(fresh("Second linked", old.proxy), null, old.id);
            ManagedProxy changed = new ManagedProxy(old.id, uuid(), old.name, new ProxySpec(ProxySpec.Scheme.HTTP, "proxy.example", 9090, false));
            repo.saveProxy(changed, old.revision);
            for (ProfileSpec previous : Arrays.asList(first, second)) {
                ProfileSpec saved = repo.findProfile(previous.id);
                check(saved.proxy.port == 9090 && !saved.revision.equals(previous.revision), "Catalog multi-profile refresh failed");
                check(old.id.equals(repo.proxyIdForProfile(saved.id)), "Catalog refresh changed association");
            }
            check(repo.listProxies().size() == 1 && repo.proxyUsageCount(old.id) == 2, "Catalog edit synthesized endpoint");
            try (BootstrapStore bootstrap = new BootstrapStore(CONTEXT, name);
                 StoreDatabase raw = new StoreDatabase(CONTEXT, name, true)) {
                ProfileSpec active = repo.findProfile(second.id);
                bootstrap.publish(active.id, active.revision, 120000);
                String before = raw.read(DirectStorageContractTest::snapshot);
                ManagedProxy denied = new ManagedProxy(changed.id, uuid(), changed.name,
                        new ProxySpec(ProxySpec.Scheme.HTTP, "proxy.example", 9091, false));
                expect(StorageException.Code.PROFILE_ACTIVE, () -> repo.saveProxy(denied, changed.revision));
                check(before.equals(raw.read(DirectStorageContractTest::snapshot)), "Active catalog edit partially updated linked profiles");
            }
        }
    }
    private static void associations() {
        String name = "verification_associations.sqlite";
        try (ProfileRepository repo = new ProfileRepository(CONTEXT, name);
             StoreDatabase raw = new StoreDatabase(CONTEXT, name, true)) {
            ManagedProxy selected = repo.saveProxy(managed("Expected", 8111), null);
            ManagedProxy other = repo.saveProxy(managed("Other", 8222), null);
            ProfileSpec proxy = repo.saveProfileWithProxy(fresh("Proxied", selected.proxy), null, selected.id);
            raw.transaction(db -> { db.delete("profile_proxy_links", "profile_id=?", new String[]{proxy.id}); return null; });
            expect(StorageException.Code.INTEGRITY_FAILURE, () -> repo.findProfile(proxy.id));
            expect(StorageException.Code.INTEGRITY_FAILURE, () -> repo.proxyIdForProfile(proxy.id));
            expect(StorageException.Code.INTEGRITY_FAILURE, repo::listProfiles);
            expect(StorageException.Code.INTEGRITY_FAILURE, () -> repo.saveProfileWithoutProxy(edit(proxy, null), proxy.revision));
            raw.transaction(db -> { StoredProxies.bind(db, proxy.id, other.id); return null; });
            expect(StorageException.Code.INTEGRITY_FAILURE, () -> repo.findProfile(proxy.id));
            raw.transaction(db -> { StoredProxies.bind(db, proxy.id, selected.id); return null; });
            ProfileSpec direct = repo.saveProfileWithoutProxy(fresh("Explicit direct", null), null);
            raw.transaction(db -> { StoredProxies.bind(db, direct.id, selected.id); return null; });
            expect(StorageException.Code.INTEGRITY_FAILURE, () -> repo.findProfile(direct.id));
            raw.transaction(db -> { db.delete("profile_proxy_links", "profile_id=?", new String[]{direct.id}); return null; });
            expect(StorageException.Code.DATABASE_UNAVAILABLE, () -> raw.transaction(db -> { seedEnvelope(db, direct.id, uuid()); return null; }));
            check(repo.findProfile(direct.id).isDirect(), "Rejected envelope corrupted direct profile");
        }
    }
    private static void migrations(int version) {
        String name = "verification_migration_v" + version + ".sqlite";
        ProfileSpec proxy = fresh("Migration proxy", new ProxySpec(ProxySpec.Scheme.HTTP, "old.example", 8089, false));
        ProfileSpec auth = fresh("Migration auth", new ProxySpec(ProxySpec.Scheme.SOCKS5, "auth.example", 1080, true));
        try (ProfileRepository repo = new ProfileRepository(CONTEXT, name)) { repo.saveProfileKeepingCredentials(proxy, null); }
        try (StoreDatabase raw = new StoreDatabase(CONTEXT, name, true)) { raw.transaction(db -> { seed(db, auth); return null; }); }
        try (BootstrapStore bootstrap = new BootstrapStore(CONTEXT, name)) { bootstrap.publish(proxy.id, proxy.revision, 120000); }
        String before;
        try (StoreDatabase raw = new StoreDatabase(CONTEXT, name, true)) {
            before = raw.read(db -> {
                if (version == 1) { db.execSQL("DROP TABLE profile_proxy_links"); db.execSQL("DROP TABLE proxy_catalog"); }
                db.execSQL("PRAGMA user_version=" + version);
                return snapshot(db);
            });
        }
        try (ProfileRepository repo = new ProfileRepository(CONTEXT, name);
             StoreDatabase raw = new StoreDatabase(CONTEXT, name, true)) {
            check(repo.findProfile(proxy.id).fingerprint().equals(proxy.fingerprint()), "Migration proxy hash rewritten");
            check(repo.findProfile(auth.id).hasProxyCredentials() && repo.proxyIdForProfile(auth.id) == null, "Migration legacy auth");
            check(repo.proxyIdForProfile(proxy.id) != null && repo.listProxies().size() == 1, "1->2 import chain missing");
            String after = raw.read(DirectStorageContractTest::snapshot);
            if (version == 1) check(before.equals(raw.read(db -> snapshotWithoutCatalog(db))), "v1 original rows rewritten");
            else check(before.equals(after), "2->3 fence rewrote rows/hashes/revisions/links/envelopes/launches");
            check(raw.read(SQLiteDatabase::getVersion) == 3, "Semantic version fence missing");
        }
    }
    private static void directClaim() {
        String name = "verification_direct_claim.sqlite";
        try (ProfileRepository repo = new ProfileRepository(CONTEXT, name)) {
            ProfileSpec direct = repo.saveProfileWithoutProxy(fresh("Direct launch", null), null);
            try (BootstrapStore bootstrap = new BootstrapStore(CONTEXT, name)) {
                LaunchSpec published = bootstrap.publish(direct.id, direct.revision, 120000);
                check(published.profile.isDirect() && bootstrap.readActive().launch.profile.isDirect(), "Published direct snapshot lost");
                expect(StorageException.Code.PROFILE_ACTIVE, () -> repo.saveProfileWithoutProxy(edit(direct, null), direct.revision));
                ManagedProxy endpoint = repo.saveProxy(managed("Launch edit", 8080), null);
                expect(StorageException.Code.PROFILE_ACTIVE, () -> repo.saveProfileWithProxy(edit(direct, endpoint.proxy), direct.revision, endpoint.id));
                String incarnation = uuid();
                LaunchSpec claimed = bootstrap.claim(incarnation);
                check(claimed.profile.isDirect() && claimed.configHash().equals(published.configHash()), "Direct claim readback changed");
                check(repo.getCredentials(claimed.profile.id, claimed.profile.revision) == null, "Direct queried credentials");
                expect(StorageException.Code.PROFILE_ACTIVE, () -> repo.saveProfileWithoutProxy(edit(direct, null), direct.revision));
            }
        }
    }
    private static String fixtureJson(String proxy, String credential) {
        return "{\"id\":\"" + ID + "\",\"revision\":\"" + REV + "\",\"name\":\"Legacy profile\",\"proxy\":" + proxy
                + ",\"countryCode\":\"US\",\"timeZoneId\":\"America/New_York\",\"languageTags\":[\"en-US\",\"en\"],\"deviceMode\":\"NATIVE\",\"deviceModel\":\"\",\"credentialRevision\":\"" + credential + "\"}";
    }
    private static ProfileSpec fresh(String name, ProxySpec proxy) { return profile(uuid(), uuid(), name, proxy); }
    private static ProfileSpec edit(ProfileSpec old, ProxySpec proxy) { return profile(old.id, uuid(), old.name, proxy); }
    private static ProfileSpec profile(String id, String revision, String name, ProxySpec proxy) {
        return new ProfileSpec(id, revision, name, proxy, "US", "America/New_York", Arrays.asList("en-US", "en"),
                ProfileSpec.DeviceMode.NATIVE, "", proxy != null && proxy.hasCredentials ? CRED : "");
    }
    private static ManagedProxy managed(String name, int port) { return new ManagedProxy(uuid(), uuid(), name, new ProxySpec(ProxySpec.Scheme.HTTP, "proxy.example", port, false)); }
    private static String uuid() { return UUID.randomUUID().toString(); }
    private static void seed(SQLiteDatabase db, ProfileSpec profile) {
        ContentValues identity = new ContentValues(); identity.put("id", profile.id); identity.put("directory_suffix", profile.dataDirectorySuffix());
        db.insertOrThrow("profile_ids", null, identity);
        ContentValues revision = new ContentValues(); revision.put("profile_id", profile.id); revision.put("revision", profile.revision);
        db.insertOrThrow("profile_revisions", null, revision);
        db.insertOrThrow("profiles", null, StoredProfiles.values(profile));
        if (profile.hasProxyCredentials()) seedEnvelope(db, profile.id, profile.credentialRevision);
    }
    private static void seedEnvelope(SQLiteDatabase db, String id, String revision) {
        ContentValues envelope = new ContentValues(); envelope.put("profile_id", id); envelope.put("credential_revision", revision);
        envelope.put("iv", new byte[12]); envelope.put("ciphertext", new byte[64]);
        db.insertOrThrow("credential_envelopes", null, envelope);
    }
    private static String snapshot(SQLiteDatabase db) { return snapshot(db, false); }
    private static String snapshotWithoutCatalog(SQLiteDatabase db) { return snapshot(db, true); }
    private static String snapshot(SQLiteDatabase db, boolean omitCatalog) {
        StringBuilder value = new StringBuilder();
        try (Cursor tables = db.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", null)) {
            while (tables.moveToNext()) {
                String table = tables.getString(0);
                if (omitCatalog && (table.equals("proxy_catalog") || table.equals("profile_proxy_links"))) continue;
                value.append(table).append(':');
                try (Cursor rows = db.rawQuery("SELECT * FROM " + table + " ORDER BY rowid", null)) {
                    while (rows.moveToNext()) for (int i = 0; i < rows.getColumnCount(); i++) {
                        if (rows.isNull(i)) value.append("NULL");
                        else if (rows.getType(i) == 1) value.append(rows.getLong(i));
                        else if (rows.getType(i) == 4) value.append(Arrays.toString(rows.getBlob(i)));
                        else value.append(rows.getString(i));
                        value.append('|');
                    }
                }
            }
        }
        return value.toString();
    }
    private static void invalid(String encoded) { expect(StorageException.Code.PROFILE_INVALID, () -> ProfileCodec.fromJson(encoded)); }
    private static void expect(StorageException.Code code, Runnable action) {
        try { action.run(); throw new AssertionError("Accepted " + code); }
        catch (StorageException expected) { check(expected.code == code, "Wrong rejection: " + expected.code + " != " + code); }
    }
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); checks++; }
}
