"""Real SQLite schema contracts; does not claim Java repository or Android execution."""
import sqlite3
import uuid

from storage_harness import (FreshStorageCase, original_schema, name_key,
                             publish_fixture, sql_transaction)


def proxy_values(name="Gateway", host="proxy-fixture.invalid", port=20080):
    return (str(uuid.uuid4()), str(uuid.uuid4()), name, name_key(name), "HTTP", host, port)


class ProxyCatalogContracts(FreshStorageCase):
    def insert_proxy(self, **kwargs):
        value = proxy_values(**kwargs)
        self.db.execute("INSERT INTO proxy_catalog VALUES (?,?,?,?,?,?,?)", value)
        return value

    def test_multiple_profiles_reference_one_proxy(self):
        first, second = self.seed(name="First"), self.seed(name="Second")
        proxy = self.insert_proxy()
        for profile in (first, second):
            self.db.execute("INSERT INTO profile_proxy_links VALUES (?,?)", (profile["id"], proxy[0]))
        self.assertEqual(self.db.execute("SELECT count(*) FROM proxy_catalog").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_proxy_links WHERE proxy_id=?",
                                         (proxy[0],)).fetchone()[0], 2)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_referenced_proxy_delete_is_restricted(self):
        profile, proxy = self.seed(), self.insert_proxy()
        self.db.execute("INSERT INTO profile_proxy_links VALUES (?,?)", (profile["id"], proxy[0]))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM proxy_catalog WHERE id=?", (proxy[0],))
        self.assertEqual(self.db.execute("SELECT revision FROM profiles WHERE id=?",
                                         (profile["id"],)).fetchone()[0], profile["revision"])

    def test_unreferenced_proxy_can_be_deleted_with_expected_revision(self):
        proxy = self.insert_proxy()
        self.assertEqual(self.db.execute("DELETE FROM proxy_catalog WHERE id=? AND revision=?",
                                         (proxy[0], str(uuid.uuid4()))).rowcount, 0)
        self.assertEqual(self.db.execute("DELETE FROM proxy_catalog WHERE id=? AND revision=?",
                                         (proxy[0], proxy[1])).rowcount, 1)

    def test_duplicate_endpoint_case_and_duplicate_folded_name_rejected(self):
        self.insert_proxy(host="Example.invalid")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_proxy(name="Other", host="example.invalid")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert_proxy(name="gATEWAY", port=20081)
        self.assertEqual(self.db.execute("SELECT count(*) FROM proxy_catalog").fetchone()[0], 1)

    def test_invalid_ports_and_direct_protocol_are_not_catalog_entries(self):
        for port in (0, 65536, -1, "not-a-port"):
            with self.subTest(port=port), self.assertRaises(sqlite3.IntegrityError):
                self.insert_proxy(port=port)
        value = list(proxy_values())
        value[4] = "DIRECT"
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO proxy_catalog VALUES (?,?,?,?,?,?,?)", value)

    def test_link_requires_existing_profile_and_proxy(self):
        proxy = self.insert_proxy()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO profile_proxy_links VALUES (?,?)", (str(uuid.uuid4()), proxy[0]))
        profile = self.seed()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO profile_proxy_links VALUES (?,?)", (profile["id"], str(uuid.uuid4())))

    def test_profile_delete_cascades_link_not_proxy_or_retired_identity(self):
        profile, proxy = self.seed(), self.insert_proxy()
        self.db.execute("INSERT INTO profile_proxy_links VALUES (?,?)", (profile["id"], proxy[0]))
        self.db.execute("DELETE FROM profiles WHERE id=?", (profile["id"],))
        self.assertEqual(self.db.execute("SELECT count(*) FROM profile_proxy_links").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM proxy_catalog").fetchone()[0], 1)
        self.assertIsNotNone(self.db.execute("SELECT id FROM profile_ids WHERE id=?", (profile["id"],)).fetchone())

    def test_v1_upgrade_ddl_does_not_rewrite_profile_credentials_or_frozen_launch(self):
        # Deliberately remove EMPTY v2 fixture tables, reconstructing a v1 database.
        # Only this test's fresh owned file is used, never an installed app database.
        self.db.execute("DROP TABLE profile_proxy_links")
        self.db.execute("DROP TABLE proxy_catalog")
        profile = self.seed(credentials=True)
        publish_fixture(self.db, profile)
        def snapshot():
            return {table: [tuple(row) for row in self.db.execute("SELECT * FROM " + table)]
                    for table in ("profiles", "profile_ids", "profile_revisions", "credential_envelopes", "launch_records", "store_meta")}
        before = snapshot()
        selected = [part.strip() for part in original_schema().split("-- @statement")[1:]
                    if part.strip().startswith(("CREATE TABLE proxy_catalog (", "CREATE TABLE profile_proxy_links ("))]
        self.assertEqual(len(selected), 2)
        with sql_transaction(self.db):
            for statement in selected:
                self.db.execute(statement)
        self.assertEqual(snapshot(), before)
        self.assertEqual(self.db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
