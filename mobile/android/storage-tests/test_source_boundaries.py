"""Static guardrails only; these assertions do not execute Android or encryption APIs."""
import os
from pathlib import Path
import re
import unittest

from storage_harness import DATA, SCHEMA, no_symlinks, original_schema, require_root


class SourceBoundaries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_root()
        cls.sources = {path.name: no_symlinks(path).read_text(encoding="utf-8")
                       for path in no_symlinks(DATA).glob("*.java")}
        cls.instrumentation_path = SCHEMA.parents[4] / (
            "app/src/androidTest/java/com/ahoo/abs/android/verification/OwnedInstrumentation.java")
        cls.instrumentation = no_symlinks(cls.instrumentation_path).read_text(encoding="utf-8")

    def test_explicit_root_is_mandatory_without_any_default(self):
        with self.assertRaisesRegex(RuntimeError, "ABS_STORAGE_TEST_ROOT is required"):
            require_root("")
        with self.assertRaisesRegex(RuntimeError, "absolute non-traversing"):
            require_root("relative/tests/storage")

    def test_data_sources_do_not_access_webkit_preferences_logs_export_or_key_deletion(self):
        forbidden = re.compile(r"android\.webkit|SharedPreferences|getSharedPreferences|"
                               r"\.getEncoded\s*\(|SecretKeySpec|deleteEntry\s*\(|"
                               r"android\.util\.Log|System\.out|printStackTrace|"
                               r"deleteDatabase\s*\(|127\.0\.0\.1|localhost")
        for filename, source in self.sources.items():
            with self.subTest(file=filename):
                self.assertIsNone(forbidden.search(source))
                self.assertIsNone(re.search(r"catch\s*\([^)]*\)\s*\{\s*\}", source))

    def test_cipher_source_uses_only_non_exported_android_handle_and_authenticated_gcm(self):
        source = self.sources["CredentialCipher.java"]
        for required in ['KeyStore.getInstance("AndroidKeyStore")',
                         '"AES/GCM/NoPadding"', "keyStore.getKey(alias, null)",
                         "setKeySize(256)", "setRandomizedEncryptionRequired(true)",
                         "cipher.updateAAD", "new GCMParameterSpec(128, envelope.iv)",
                         "Arrays.fill(plaintext, (byte) 0)"]:
            self.assertIn(required, source)
        self.assertNotIn("keyStore.aliases", source)
        self.assertNotIn("KeyStore.getDefaultType", source)

    def test_bootstrap_only_opens_existing_database_without_create_or_auto_rebuild(self):
        source = self.sources["StoreDatabase.java"]
        branch = source.split("if (existingOnly) {", 1)[1].split("} else {", 1)[0]
        self.assertIn("DATABASE_MISSING", branch)
        self.assertIn("SQLiteDatabase.OPEN_READWRITE", branch)
        self.assertIn("SQLiteDatabase.openDatabase(file, params)", branch)
        self.assertNotIn("CREATE_IF_NECESSARY", branch)
        self.assertNotIn("new Helper", branch)
        self.assertNotIn("getReadableDatabase", source)
        self.assertIn("getNoBackupFilesDir()", source)
        self.assertIn("ApplicationInfo.FLAG_ALLOW_BACKUP", source)
        self.assertIn("FAIL_CORRUPTION", source)
        self.assertIn("SCHEMA_ASSET_INVALID", self.sources["SchemaLoader.java"])
        self.assertIn('open("profile-schema.sql")', self.sources["SchemaLoader.java"])

    def test_returning_configuration_pragmas_use_strict_cursor_results_and_readback(self):
        source = self.sources["StoreDatabase.java"]
        for statement, expected in (("secure_delete=ON", 1), ("secure_delete", 1),
                                    ("busy_timeout=5000", 5000), ("busy_timeout", 5000)):
            self.assertIn(f'requirePragmaInteger(db, "PRAGMA {statement}", {expected})', source)
        self.assertNotRegex(source, r'(?i)execSQL\s*\(\s*"PRAGMA\s+(secure_delete|busy_timeout)')
        for required in ("try (Cursor cursor = db.rawQuery(sql, null))",
                         "!cursor.moveToFirst()", "cursor.getColumnCount() != 1",
                         "cursor.getType(0) != Cursor.FIELD_TYPE_INTEGER",
                         "cursor.getLong(0) != expected", "cursor.moveToNext()",
                         "db.setForeignKeyConstraintsEnabled(true)",
                         'db.execSQL("PRAGMA synchronous=FULL")'):
            self.assertIn(required, source)

    def test_persisted_profile_hash_is_not_confused_with_the_core_launch_envelope(self):
        bootstrap = self.sources["BootstrapStore.java"]
        records = self.sources["LaunchRecords.java"]
        self.assertIn('values.put("config_hash", profile.fingerprint());', bootstrap)
        self.assertNotIn('values.put("config_hash", launch.configHash());', bootstrap)
        self.assertIn("StoreChecks.same(launch.configHash(), readback.launch.configHash());", bootstrap)
        self.assertIn("StoreChecks.same(cursor.getString(5), profile.fingerprint());", records)
        self.assertNotIn("StoreChecks.same(cursor.getString(5), launch.configHash());", records)
        self.assertIn("StoreChecks.same(active.launch.profile.fingerprint(), current.fingerprint());", records)
        self.assertNotIn("StoreChecks.same(active.launch.configHash(), current.fingerprint());", records)

    def test_database_diagnostics_are_finite_enums_without_retained_exception_payloads(self):
        errors = self.sources["StorageException.java"]
        database = self.sources["StoreDatabase.java"]
        self.assertIn("public final Operation operation;", errors)
        self.assertIn("public final NativeExceptionClass nativeExceptionClass;", errors)
        self.assertIn('"android.database.sqlite." + candidate.className', errors)
        self.assertIn("new StorageException(Code.DATABASE_UNAVAILABLE, operation,", errors)
        self.assertNotRegex(errors, r"(?:public|private|protected)\s+(?:final\s+)?"
                            r"(?:Throwable|Exception|RuntimeException)\s+\w+\s*;")
        for forbidden in ("initCause(", "getMessage(", "getStackTrace(", "printStackTrace(", "getCause("):
            self.assertNotIn(forbidden, errors)
        for operation in ("OPEN_EXISTING", "OPEN_HELPER", "CONFIGURE", "CHECK_WAL",
                          "CHECK_VERSION", "READ_META", "READ", "TRANSACTION_BEGIN",
                          "TRANSACTION_BODY", "TRANSACTION_END"):
            self.assertIn("Operation." + operation, database)
        self.assertIn("storage.nativeExceptionClass.className", self.instrumentation)
        self.assertIn("storage.operation.name()", self.instrumentation)
        self.assertNotIn("getCause()", self.instrumentation)
        self.assertNotIn("getMessage()", self.instrumentation)
        self.assertNotIn("getStackTrace()", self.instrumentation)

    def test_native_instrumentation_splits_bootstrap_open_and_verifies_both_hash_domains(self):
        source = self.instrumentation
        opening = source.index("stage = Stage.BOOTSTRAP_OPEN;")
        constructor = source.index("new BootstrapStore(context, name)")
        publishing = source.index("stage = Stage.BOOTSTRAP_PUBLISH;")
        call = source.index("bootstrap.publish(saved.id, saved.revision, 120000)")
        self.assertLess(opening, constructor)
        self.assertLess(constructor, publishing)
        self.assertLess(publishing, call)
        for required in ("stage = Stage.BOOTSTRAP_HASH_READBACK;",
                         "SELECT config_hash,profile_id,profile_revision,session_id,nonce,",
                         "saved.fingerprint().equals(profileHash)",
                         "!published.configHash().equals(profileHash)",
                         "new LaunchSpec(saved, row.getString(3), row.getString(4), row.getLong(5), row.getLong(6))",
                         "published.configHash().equals(reconstructed.configHash())",
                         "reconstructed.configHash().equals(readback.launch.configHash())",
                         '"PROFILE_FINGERPRINT"', '"SESSION_NONCE_TIME_ENVELOPE"'):
            self.assertIn(required, source)

    def test_credentials_are_closeable_owned_arrays_and_errors_have_no_submitted_values(self):
        source = self.sources["Credentials.java"]
        self.assertIn("implements AutoCloseable", source)
        self.assertIn("char[] password", source)
        self.assertIn("Arrays.fill(password, '\\0')", source)
        self.assertIn("Arrays.fill(username, '\\0')", source)
        errors = self.sources["StorageException.java"]
        self.assertIn('super("ABS storage: " + code.name())', errors)
        self.assertNotIn("Throwable", errors)
        self.assertNotIn("getMessage()", "\n".join(self.sources.values()))

    def test_every_owned_source_file_is_under_400_lines(self):
        test_directory = Path(os.path.abspath(__file__)).parent
        paths = list(DATA.glob("*.java")) + [SCHEMA, self.instrumentation_path] + list(test_directory.glob("*.py"))
        for path in paths:
            with self.subTest(file=path.name):
                self.assertLess(len(no_symlinks(path).read_text(encoding="utf-8").splitlines()), 400)

    def test_schema_has_explicit_statement_markers_and_no_credential_plaintext_columns(self):
        sql = original_schema()
        statements = sql.split("-- @statement\n")[1:]
        self.assertGreater(len(statements), 20)
        self.assertTrue(all(statement.strip().endswith(";") for statement in statements))
        self.assertNotRegex(sql, r"(?im)^\s*(proxy_username|proxy_password|raw_key|key_bytes)\s+")
