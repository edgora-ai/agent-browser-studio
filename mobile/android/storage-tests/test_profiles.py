"""Original SQL storage contracts. No Java repository, AES or Android execution is claimed."""
import hashlib
import json
import os
import sqlite3
import stat
import uuid

from storage_harness import (FreshStorageCase, connect_existing, fixture, insert_fixture,
                             name_key, original_schema, sql_transaction)


def changed_fixture(original, *, name=None, credentials=None):
    value = dict(original)
    value["revision"] = str(uuid.uuid4())
    if name is not None:
        value["name"] = name
        value["name_key"] = name_key(name)
    if credentials is not None:
        value["has_credentials"] = int(credentials)
        value["credential_revision"] = str(uuid.uuid4()) if credentials else None
    spec = json.loads(value["spec_json"])
    spec.update(revision=value["revision"], name=value["name"],
                credentialRevision=value["credential_revision"] or "")
    spec["proxy"]["hasCredentials"] = bool(value["has_credentials"])
    value["spec_json"] = json.dumps(spec, separators=(",", ":"))
    value["config_hash"] = hashlib.sha256(value["spec_json"].encode()).hexdigest()
    return value


def cas_sql(connection, value, expected):
    """Explicit SQL contract input, not a substitute implementation of ProfileRepository."""
    connection.execute("INSERT INTO profile_revisions(profile_id,revision) VALUES (?,?)",
                       (value["id"], value["revision"]))
    fields = [key for key in value if key != "id"]
    assignments = ",".join(key + "=?" for key in fields)
    return connection.execute(f"UPDATE profiles SET {assignments} WHERE id=? AND revision=?",
                              tuple(value[key] for key in fields) + (value["id"], expected)).rowcount


class ProfileContracts(FreshStorageCase):
    def test_direct_rows_wal_close_reopen_and_id_name_search(self):
        marker = "Readback-" + uuid.uuid4().hex
        profile = self.seed(name=marker)
        self.assertEqual(dict(self.row("profiles", "id", profile["id"])), profile)
        wal = self.path.with_name(self.path.name + "-wal")
        self.assertGreater(wal.stat().st_size, 32)
        self.assertIn(marker.encode(), wal.read_bytes())
        reader = connect_existing(self.path, readonly=True)
        try:
            actual = reader.execute("SELECT * FROM profiles WHERE id=?", (profile["id"],)).fetchone()
            self.assertEqual(dict(actual), profile)
        finally:
            reader.close()
        self.db.close()
        self.db = connect_existing(self.path)
        result = self.db.execute("SELECT * FROM profiles WHERE id=? AND name_key=?",
                                 (profile["id"], name_key(marker))).fetchone()
        self.assertEqual(dict(result), profile)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(self.db.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_ascii_case_insensitive_names_and_failed_insert_rollback(self):
        first = self.seed(name="Profile Alpha")
        duplicate = fixture("pRoFiLe aLpHa")
        with self.assertRaises(sqlite3.IntegrityError):
            with sql_transaction(self.db):
                insert_fixture(self.db, duplicate)
        self.assertEqual(dict(self.row("profiles", "id", first["id"])), first)
        self.assertIsNone(self.row("profiles", "id", duplicate["id"]))
        self.assertIsNone(self.db.execute("SELECT 1 FROM profile_ids WHERE id=?",
                                         (duplicate["id"],)).fetchone())
        self.assertIsNone(self.db.execute("SELECT 1 FROM profile_revisions WHERE revision=?",
                                         (duplicate["revision"],)).fetchone())

    def test_unicode_folded_name_key_collision(self):
        self.seed(name="Straße")
        self.assertEqual(name_key("Straße"), name_key("STRASSE"))
        with self.assertRaises(sqlite3.IntegrityError):
            with sql_transaction(self.db):
                insert_fixture(self.db, fixture("STRASSE"))

    def test_cas_success_then_stale_writer_rollback(self):
        original = self.seed()
        updated = changed_fixture(original, name="Changed by first writer")
        with sql_transaction(self.db):
            self.assertEqual(cas_sql(self.db, updated, original["revision"]), 1)
        self.assertEqual(dict(self.row("profiles", "id", original["id"])), updated)
        stale = changed_fixture(original, name="Stale update must not appear")
        self.db.execute("BEGIN IMMEDIATE")
        self.assertEqual(cas_sql(self.db, stale, original["revision"]), 0)
        self.db.execute("ROLLBACK")
        self.assertEqual(dict(self.row("profiles", "id", original["id"])), updated)
        self.assertIsNone(self.db.execute("SELECT 1 FROM profile_revisions WHERE revision=?",
                                         (stale["revision"],)).fetchone())

    def test_same_revision_and_primary_identity_updates_rejected(self):
        original = self.seed()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE profiles SET name='Silent overwrite' WHERE id=?",
                            (original["id"],))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE profiles SET id=? WHERE id=?",
                            (str(uuid.uuid4()), original["id"]))
        self.assertEqual(dict(self.row("profiles", "id", original["id"])), original)

    def test_deferred_credential_reference_commit_failure_rolls_back_actual_rows(self):
        original = self.seed()
        updated = changed_fixture(original, credentials=True)
        with self.assertRaises(sqlite3.IntegrityError):
            with sql_transaction(self.db):
                self.assertEqual(cas_sql(self.db, updated, original["revision"]), 1)
                # Deliberately omit the envelope. COMMIT must fail, never save half a profile.
        self.db.close()
        self.db = connect_existing(self.path)
        self.assertEqual(dict(self.row("profiles", "id", original["id"])), original)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM credential_envelopes").fetchone()[0], 0)
        self.assertIsNone(self.db.execute("SELECT 1 FROM profile_revisions WHERE revision=?",
                                         (updated["revision"],)).fetchone())

    def test_null_cannot_bypass_credential_presence_check(self):
        profile = fixture(credentials=True)
        profile["credential_revision"] = None
        with self.assertRaises(sqlite3.IntegrityError):
            with sql_transaction(self.db):
                insert_fixture(self.db, profile)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM profiles").fetchone()[0], 0)

    def test_credential_envelope_is_binary_and_bound_to_revision(self):
        profile = self.seed(credentials=True)
        envelope = self.row("credential_envelopes", "profile_id", profile["id"])
        self.assertIsInstance(envelope["iv"], bytes)
        self.assertIsInstance(envelope["ciphertext"], bytes)
        self.assertEqual(envelope["credential_revision"], profile["credential_revision"])
        for bad_iv, bad_ciphertext in [(b"short", bytes(64)), (bytes(12), "not-a-blob"),
                                       (bytes(12), b"short")]:
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("UPDATE credential_envelopes SET iv=?,ciphertext=? WHERE profile_id=?",
                                (bad_iv, bad_ciphertext, profile["id"]))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE credential_envelopes SET credential_revision=? WHERE profile_id=?",
                            (str(uuid.uuid4()), profile["id"]))

    def test_keep_metadata_preserves_exact_opaque_envelope(self):
        original = self.seed(credentials=True)
        before = dict(self.row("credential_envelopes", "profile_id", original["id"]))
        changed = changed_fixture(original, name="Renamed without replacing credentials")
        with sql_transaction(self.db):
            self.assertEqual(cas_sql(self.db, changed, original["revision"]), 1)
        self.assertEqual(dict(self.row("credential_envelopes", "profile_id", original["id"])), before)
        self.assertEqual(dict(self.row("profiles", "id", original["id"])), changed)

    def test_explicit_clear_removes_envelope_in_same_transaction(self):
        original = self.seed(credentials=True)
        updated = changed_fixture(original, credentials=False)
        with sql_transaction(self.db):
            self.assertEqual(cas_sql(self.db, updated, original["revision"]), 1)
            self.assertEqual(self.db.execute("DELETE FROM credential_envelopes WHERE profile_id=?",
                                             (original["id"],)).rowcount, 1)
        self.assertEqual(dict(self.row("profiles", "id", original["id"])), updated)
        self.assertIsNone(self.row("credential_envelopes", "profile_id", original["id"]))
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_delete_only_configuration_retains_identity_revision_history(self):
        profile = self.seed(credentials=True)
        with sql_transaction(self.db):
            self.assertEqual(self.db.execute("DELETE FROM profiles WHERE id=?",
                                             (profile["id"],)).rowcount, 1)
        self.assertIsNone(self.row("profiles", "id", profile["id"]))
        self.assertIsNone(self.row("credential_envelopes", "profile_id", profile["id"]))
        self.assertEqual(self.db.execute("SELECT directory_suffix FROM profile_ids WHERE id=?",
                                         (profile["id"],)).fetchone()[0], profile["directory_suffix"])
        self.assertIsNotNone(self.db.execute("SELECT 1 FROM profile_revisions WHERE revision=?",
                                            (profile["revision"],)).fetchone())

    def test_identity_and_revision_registries_cannot_be_rewritten_or_removed(self):
        profile = self.seed()
        for statement, args in [
            ("DELETE FROM profile_ids WHERE id=?", (profile["id"],)),
            ("DELETE FROM profile_revisions WHERE revision=?", (profile["revision"],)),
            ("UPDATE profile_ids SET directory_suffix='different' WHERE id=?", (profile["id"],)),
            ("UPDATE profile_revisions SET revision=? WHERE revision=?",
             (str(uuid.uuid4()), profile["revision"]))]:
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(statement, args)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM store_meta")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE store_meta SET store_id=?", (uuid.uuid4().hex,))

    def test_only_metadata_and_ciphertext_columns_exist(self):
        expected = {"profile_id", "credential_revision", "iv", "ciphertext"}
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(credential_envelopes)")}
        self.assertEqual(columns, expected)
        tables = self.db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        for table in tables:
            names = {row[1].lower() for row in self.db.execute(f"PRAGMA table_info({table[0]})")}
            self.assertTrue(names.isdisjoint({"username", "password", "proxy_username",
                                             "proxy_password", "raw_key", "key_bytes"}))
        profile = self.seed(credentials=True)
        spec = json.loads(self.row("profiles", "id", profile["id"])["spec_json"])
        self.assertEqual(set(spec["proxy"]), {"scheme", "host", "port", "hasCredentials"})

    def test_artifacts_are_private_and_only_fresh_synthetic_files(self):
        self.seed()
        self.assertEqual(stat.S_IMODE(os.lstat(self.case_directory).st_mode), 0o700)
        for path in self.case_directory.iterdir():
            self.assertTrue(stat.S_ISREG(os.lstat(path).st_mode))
            self.assertEqual(stat.S_IMODE(os.lstat(path).st_mode), 0o600)

    def test_raw_schema_and_marker_statement_loading_have_identical_objects(self):
        alternate_path = self.case_directory / "verification_markers.sqlite"
        descriptor = os.open(alternate_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        alternate = connect_existing(alternate_path)
        try:
            with sql_transaction(alternate):
                for statement in original_schema().split("-- @statement\n")[1:]:
                    alternate.execute(statement.strip())
            query = "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
            self.assertEqual([tuple(row) for row in alternate.execute(query)],
                             [tuple(row) for row in self.db.execute(query)])
        finally:
            alternate.close()

    def test_uuid_columns_reject_noncanonical_case_shape_and_alphabet(self):
        for bad in ("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", "a" * 36,
                    "gggggggg-gggg-gggg-gggg-gggggggggggg"):
            for field in ("id", "revision", "credential_revision"):
                value = fixture(credentials=(field == "credential_revision"))
                value[field] = bad
                with self.subTest(field=field, malformed=bad):
                    with self.assertRaises(sqlite3.IntegrityError):
                        with sql_transaction(self.db):
                            insert_fixture(self.db, value)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM profiles").fetchone()[0], 0)
