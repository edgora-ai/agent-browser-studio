"""Local stdio-only test adapter: actual Python SQLite, not Android SQLite/KeyStore evidence."""
import base64
import os
from pathlib import Path
import sqlite3
import sys

# Parent admitted a fresh owned tests/storage evidence directory. Never accept arbitrary paths.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from storage_harness import no_symlinks, require_root
root = require_root()
path = Path(sys.argv[1])
no_symlinks(path.parent)
if not path.is_relative_to(root) or not path.name.endswith(".sqlite"):
    raise SystemExit("Database outside admitted synthetic storage root")
if not path.exists():
    os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600))
no_symlinks(path)
db = sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, isolation_level=None)
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA max_page_count=256")

def decode(value):
    kind, payload = value[:1], value[1:]
    if kind == "n": return None
    if kind == "i": return int(payload)
    if kind == "b": return base64.b64decode(payload)
    if kind == "s": return base64.b64decode(payload).decode("utf-8")
    raise ValueError("Unknown value type")

def encode(value):
    if value is None: return "n"
    if isinstance(value, int): return "i" + str(value)
    if isinstance(value, bytes): return "b" + base64.b64encode(value).decode()
    return "s" + base64.b64encode(str(value).encode()).decode()

try:
    for line in sys.stdin:
        fields = line.rstrip("\n").split("\t")
        if fields[0] == "C": break
        try:
            sql = base64.b64decode(fields[1]).decode()
            cursor = db.execute(sql, tuple(decode(value) for value in fields[2:]))
            rows = cursor.fetchall()
            print("O\t%d\t%d\t%d\t%d" % (cursor.lastrowid or 0, cursor.rowcount, len(cursor.description or ()), len(rows)))
            for row in rows: print("\t".join(encode(value) for value in row))
        except sqlite3.Error as error:
            print("E\t" + ("CONSTRAINT" if isinstance(error, sqlite3.IntegrityError) else "SQLITE"))
        sys.stdout.flush()
finally:
    db.close()
