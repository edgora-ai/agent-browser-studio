"""Fresh synthetic SQLite fixtures only; never an Android/KeyStore execution or backend.

ABS_STORAGE_TEST_ROOT must explicitly name the coordinator's checked SSD tests/storage
(0700). No default, tempdir, symlink traversal, network, existing app DB or cleanup.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import unicodedata
import unittest
import uuid

ROOT_LIMIT = 64 * 1024 * 1024  # Part of, not additional to, the shared 1-GiB task budget.
ANDROID = Path(os.path.abspath(__file__)).parent.parent
SCHEMA = ANDROID / "app/src/main/assets/profile-schema.sql"
DATA = ANDROID / "app/src/main/java/com/ahoo/abs/android/data"
NOW = 1_800_000_000_000


def no_symlinks(path):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise RuntimeError("absolute non-traversing verification path required")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if stat.S_ISLNK(os.lstat(current).st_mode):
            raise RuntimeError("verification paths must not traverse symlinks")
    return path


def require_root(value=None):
    value = os.environ.get("ABS_STORAGE_TEST_ROOT") if value is None else value
    if not value:
        raise RuntimeError("ABS_STORAGE_TEST_ROOT is required; no fallback is permitted")
    path = no_symlinks(Path(value))
    info = os.lstat(path)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700
            or path.name != "storage" or path.parent.name != "tests"):
        raise RuntimeError("owned 0700 coordinator tests/storage directory required")
    used = 0
    for folder, directories, files in os.walk(path, followlinks=False):
        for name in directories + files:
            entry = os.lstat(Path(folder) / name)
            if stat.S_ISLNK(entry.st_mode):
                raise RuntimeError("verification evidence must not contain symlinks")
            if stat.S_ISREG(entry.st_mode):
                used += entry.st_size
    if used >= ROOT_LIMIT:
        raise RuntimeError("retained storage-test allowance exhausted; no cleanup or reset")
    return path


def original_schema():
    return no_symlinks(SCHEMA).read_text(encoding="utf-8")


def connect_existing(path, readonly=False):
    no_symlinks(path)
    uri = Path(path).as_uri() + ("?mode=ro" if readonly else "?mode=rw")
    connection = sqlite3.connect(uri, uri=True, timeout=5, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=5000")
    if not readonly:
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA wal_autocheckpoint=0")
    return connection


@contextlib.contextmanager
def sql_transaction(connection):
    connection.execute("BEGIN IMMEDIATE")
    try:
        yield connection
        connection.execute("COMMIT")
    except BaseException:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise


def name_key(value):
    normalized = unicodedata.normalize("NFKC", value)
    return unicodedata.normalize("NFKC", normalized.upper().lower())


def fixture(name="Synthetic profile", credentials=False):
    """Public metadata; hash is a schema fixture, NOT core.fingerprint() validation."""
    profile_id = str(uuid.uuid4())
    revision = str(uuid.uuid4())
    credential_revision = str(uuid.uuid4()) if credentials else ""
    spec = {
        "id": profile_id, "revision": revision, "name": name,
        "proxy": {"scheme": "HTTP", "host": "proxy-fixture.invalid",
                  "port": 10000 + int(uuid.UUID(profile_id).hex[:4], 16) % 50000,
                  "hasCredentials": credentials},
        "countryCode": "US", "timeZoneId": "America/New_York",
        "languageTags": ["en-US", "en"], "deviceMode": "NATIVE", "deviceModel": "",
        "credentialRevision": credential_revision,
    }
    encoded = json.dumps(spec, ensure_ascii=False, separators=(",", ":"))
    return {
        "id": profile_id, "revision": revision, "name": name, "name_key": name_key(name),
        "has_credentials": int(credentials),
        "credential_revision": credential_revision if credentials else None,
        "spec_json": encoded, "config_hash": hashlib.sha256(encoded.encode()).hexdigest(),
        "directory_suffix": "verification_" + uuid.UUID(profile_id).hex,
    }


def insert_fixture(connection, value):
    """Raw SQL inputs only. Caller holds a transaction; no app persistence substitute."""
    connection.execute("INSERT INTO profile_ids(id,directory_suffix) VALUES (?,?)",
                       (value["id"], value["directory_suffix"]))
    connection.execute("INSERT INTO profile_revisions(profile_id,revision) VALUES (?,?)",
                       (value["id"], value["revision"]))
    columns = ",".join(value)
    placeholders = ",".join("?" for _ in value)
    connection.execute(f"INSERT INTO profiles({columns}) VALUES ({placeholders})",
                       tuple(value.values()))
    if value["has_credentials"]:
        # Opaque BLOB constraint fixtures only; not encryption or an AES/KeyStore mock.
        connection.execute("INSERT INTO credential_envelopes VALUES (?,?,?,?)",
                           (value["id"], value["credential_revision"], bytes(range(12)),
                            bytes(range(64))))


def publish_fixture(connection, profile, *, session=None, nonce=None, issued=NOW, ttl=120000):
    session = session or str(uuid.uuid4())
    nonce = nonce or str(uuid.uuid4())
    connection.execute("""INSERT INTO launch_records(session_id,nonce,profile_id,
        profile_revision,spec_json,config_hash,directory_suffix,issued_at_ms,expires_at_ms,
        state,phase) VALUES (?,?,?,?,?,?,?,?,?,'PUBLISHED',0)""",
                       (session, nonce, profile["id"], profile["revision"], profile["spec_json"],
                        profile["config_hash"], profile["directory_suffix"], issued, issued + ttl))
    return session, nonce


class FreshStorageCase(unittest.TestCase):
    def setUp(self):
        root = require_root()
        self.case_directory = root / ("verification_" + uuid.uuid4().hex)
        os.mkdir(self.case_directory, 0o700)
        self.path = self.case_directory / "verification_profiles.sqlite"
        descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        self.db = connect_existing(self.path)
        mode = self.db.execute("PRAGMA journal_mode=WAL").fetchone()[0]
        self.assertEqual(mode, "wal")
        self.db.execute("PRAGMA max_page_count=256")
        self.db.execute("PRAGMA secure_delete=ON")
        self.db.executescript("BEGIN IMMEDIATE;\n" + original_schema() + "\nCOMMIT;")

    def tearDown(self):
        self.db.close()
        # Preserve both successful and failed evidence. No age-based or automatic deletion.
        require_root()

    def seed(self, *, credentials=False, name="Synthetic profile"):
        value = fixture(name, credentials)
        with sql_transaction(self.db):
            insert_fixture(self.db, value)
        return value

    def row(self, table, field, value):
        if (table, field) not in {("profiles", "id"), ("launch_records", "session_id"),
                                  ("credential_envelopes", "profile_id")}:
            raise ValueError("test projection is not whitelisted")
        return self.db.execute(f"SELECT * FROM {table} WHERE {field}=?", (value,)).fetchone()

    def claim(self, session, *, incarnation=None, pid=32001):
        incarnation = incarnation or str(uuid.uuid4())
        result = self.db.execute("""UPDATE launch_records SET state='CLAIMED',phase=10,
            incarnation_id=?,pid=?,consumed_at_ms=?
            WHERE session_id=? AND state='PUBLISHED' AND consumed_at_ms IS NULL""",
                                 (incarnation, pid, NOW + 1, session))
        return incarnation, result.rowcount
