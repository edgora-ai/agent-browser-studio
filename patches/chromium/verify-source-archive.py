#!/usr/bin/env python3
"""Authenticate a source tar without extracting it or changing a Git checkout.

Every regular-file byte, executable bit and symlink target is hashed as a Git
blob. Trees use Git's byte ordering and object encoding. Codeload omits gitlink
contents: only exact gitlinks from a tree authenticated by the pinned root may
be injected, and only where the archive contains no files. All other omissions,
extra entries, byte/mode changes and malformed archives fail closed. With the
explicit --allow-reviewed-git-archive-exports flag, one reviewed tracked EOL
export can be proven against its exact canonical attribute and blob hashes;
this is not blanket newline normalization. Both raw and canonical IDs are saved.

Raw canonical commit bytes must hash to the pinned Git commit, and its initial
root-tree header must match the reviewed pin below. Downloaded archive SHA-256
values are outputs, never trust anchors of this verifier. Evidence contains
public metadata and hashes, not source contents, and supports offline replay.
For example: python3 verify-source-archive.py SOURCE.tar.gz --evidence-dir PROOF
  --allow-reviewed-git-archive-exports --proxy http://PROXY:PORT
Replay with a new evidence directory and --metadata-dir PROOF/metadata.
"""

import argparse
import base64
import binascii
import bz2
import datetime
import gzip
import hashlib
import json
import lzma
import os
from pathlib import Path
import re
import stat
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request


ORIGIN = "https://chromium.googlesource.com/chromium/src"
PINNED_COMMIT = "026bb13a93d60e7adfefa2bbf58d6f57c2d335cc"
PINNED_TREES = {PINNED_COMMIT: "871b7886d768a863341e9212fe29548555137adc"}
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
GIT_MODES = {"40000": "tree", "100644": "blob", "100755": "blob",
             "120000": "blob", "160000": "commit"}
# git archive performs this tracked working-tree EOL export. This is NOT a
# wildcard CRLF exemption: both the exact leaf rule and the normalized bytes
# must independently hash to entries under the authenticated canonical root.
REVIEWED_EOL_EXPORTS = {
    "third_party/mako/mako/test/templates/crlf.html": (
        "third_party/mako/mako/test/templates/.gitattributes",
        b"crlf.html text eol=crlf\n"),
}
CAPTURE_PATHS = set(REVIEWED_EOL_EXPORTS) | {value[0] for value in REVIEWED_EOL_EXPORTS.values()}


class VerificationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def name_bytes(value):
    return value.encode("utf-8", "surrogateescape")


def git_object_id(kind, payload):
    return hashlib.sha1(kind.encode("ascii") + b" " +
                        str(len(payload)).encode("ascii") + b"\0" + payload).hexdigest()


def tree_id(entries):
    """entries maps name -> (canonical mode, object ID)."""
    ordered = sorted(entries, key=lambda n: name_bytes(n) +
                     (b"/" if entries[n][0] == "40000" else b""))
    payload = b"".join(mode.encode("ascii") + b" " + name_bytes(name) + b"\0" +
                       bytes.fromhex(oid) for name in ordered
                       for mode, oid in [entries[name]])
    return git_object_id("tree", payload)


class Directory:
    def __init__(self):
        self.children = {}

    def entries(self):
        return {name: ("40000", item.oid()) if isinstance(item, Directory) else item
                for name, item in self.children.items()}

    def oid(self):
        return tree_id(self.entries())


class HashingReader:
    def __init__(self, source):
        self.source = source
        self.sha256 = hashlib.sha256()
        self.bytes_read = 0

    def read(self, size=-1):
        data = self.source.read(size)
        self.sha256.update(data)
        self.bytes_read += len(data)
        return data

    def tell(self):
        return self.bytes_read


def archive_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def parse_member_path(name, prefix):
    require(isinstance(name, str) and name and "\0" not in name,
            "empty or NUL archive path")
    require(not name.startswith("/") and "\\" not in name,
            "absolute or backslash archive path: " + repr(name))
    clean = name[:-1] if name.endswith("/") else name
    parts = clean.split("/")
    require(all(part and part not in (".", "..") for part in parts),
            "non-canonical archive path: " + repr(name))
    require(parts[0] == prefix, "archive contains multiple/unexpected root prefixes")
    return parts[1:]


def scan_archive(filename, expected_prefix=None, progress=None):
    """Read once, hash compressed bytes and all Git blobs; never extract."""
    root = Directory()
    root.reviewed_export_payloads = {}
    seen = set()
    counts = {"regular_files": 0, "symlinks": 0, "directories": 0}
    prefix = expected_prefix
    with open(filename, "rb") as source:
        before = os.fstat(source.fileno())
        require(stat.S_ISREG(before.st_mode), "archive is not a regular file")
        magic = source.peek(6)[:6]
        hashed = HashingReader(source)
        if magic.startswith(b"\x1f\x8b"):
            decoded = gzip.GzipFile(fileobj=hashed, mode="rb")
        elif magic.startswith(b"\xfd7zXZ\x00"):
            decoded = lzma.LZMAFile(hashed, mode="rb")
        elif magic.startswith(b"BZh"):
            decoded = bz2.BZ2File(hashed, mode="rb")
        else:
            decoded = hashed
        # Continue past tar end markers: appended entries must not be hidden.
        with tarfile.open(fileobj=decoded, mode="r|", ignore_zeros=True,
                          encoding="utf-8", errors="surrogateescape") as archive:
            for member in archive:
                if prefix is None:
                    prefix = member.name.split("/", 1)[0]
                parts = parse_member_path(member.name, prefix)
                logical = "/".join(parts)
                require(logical not in seen, "duplicate archive entry: " + logical)
                seen.add(logical)
                require(not member.mode & 0o7000, "special permission bits: " + logical)
                if not parts:
                    require(member.isdir(), "archive root is not a directory")
                    counts["directories"] += 1
                    archive.members.clear()
                    continue
                parent = root
                for component in parts[:-1]:
                    item = parent.children.setdefault(component, Directory())
                    require(isinstance(item, Directory), "non-directory archive parent: " + logical)
                    parent = item
                name = parts[-1]
                if member.isdir():
                    item = parent.children.setdefault(name, Directory())
                    require(isinstance(item, Directory), "file/directory collision: " + logical)
                    counts["directories"] += 1
                elif member.isfile():
                    require(name not in parent.children, "archive entry collision: " + logical)
                    digest = hashlib.sha1(b"blob " + str(member.size).encode("ascii") + b"\0")
                    captured = [] if logical in CAPTURE_PATHS else None
                    require(captured is None or member.size <= 1024 * 1024,
                            "reviewed export candidate exceeds size bound: " + logical)
                    consumed = 0
                    with archive.extractfile(member) as contents:
                        while True:
                            chunk = contents.read(1024 * 1024)
                            if not chunk:
                                break
                            consumed += len(chunk)
                            digest.update(chunk)
                            if captured is not None:
                                captured.append(chunk)
                    if captured is not None:
                        root.reviewed_export_payloads[logical] = b"".join(captured)
                    require(consumed == member.size, "truncated archive member: " + logical)
                    mode = "100755" if member.mode & 0o111 else "100644"
                    parent.children[name] = (mode, digest.hexdigest())
                    counts["regular_files"] += 1
                elif member.issym():
                    require(name not in parent.children, "archive entry collision: " + logical)
                    require("\0" not in member.linkname, "NUL symlink target")
                    parent.children[name] = ("120000", git_object_id("blob", name_bytes(member.linkname)))
                    counts["symlinks"] += 1
                else:
                    raise VerificationError("unsupported archive member type (including hardlink): " + logical)
                archive.members.clear()
                if progress and (counts["regular_files"] + counts["symlinks"]) % 10000 == 0:
                    progress("archive-progress", dict(counts))
        # Complete decompression also validates compressed-stream checksums.
        while decoded.read(1024 * 1024):
            pass
        while hashed.read(1024 * 1024):
            pass
        after = os.fstat(source.fileno())
        named = os.stat(filename)
        require(archive_identity(before) == archive_identity(after) == archive_identity(named),
                "archive changed during verification")
        require(hashed.bytes_read == before.st_size, "archive byte count mismatch")
    return root, {"sha256": hashed.sha256.hexdigest(), "bytes": hashed.bytes_read,
                  "prefix": prefix, **counts}


def decode_json(raw):
    require(raw.startswith(b")]}'\n"), "canonical metadata lacks Gitiles XSSI header")
    try:
        return json.loads(raw[5:])
    except (ValueError, UnicodeError) as error:
        raise VerificationError("invalid canonical metadata JSON") from error


def authenticate_commit_object(encoded, expected_commit):
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise VerificationError("invalid canonical commit object base64") from error
    require(git_object_id("commit", payload) == expected_commit,
            "canonical commit object hash does not match pinned commit")
    first = payload.split(b"\n", 1)[0]
    require(re.fullmatch(b"tree [0-9a-f]{40}", first) is not None,
            "canonical commit lacks initial root-tree header")
    return first[5:].decode("ascii")


def canonical_tree_entries(document, expected_oid):
    require(isinstance(document, dict) and document.get("id") == expected_oid,
            "canonical tree identity mismatch")
    require(isinstance(document.get("entries"), list), "canonical tree entries missing")
    result = {}
    for item in document["entries"]:
        require(isinstance(item, dict), "invalid canonical tree entry")
        name, mode, oid = item.get("name"), item.get("mode"), item.get("id")
        require(isinstance(name, str) and name and name not in (".", "..") and
                "/" not in name and "\0" not in name, "invalid canonical tree name")
        require(type(mode) is int, "invalid canonical tree mode")
        mode = format(mode, "o")
        require(mode in GIT_MODES and item.get("type") == GIT_MODES[mode],
                "unsupported canonical tree mode/type")
        require(isinstance(oid, str) and HEX40.fullmatch(oid), "invalid canonical object ID")
        require(name not in result, "duplicate canonical tree name")
        result[name] = (mode, oid)
    require(tree_id(result) == expected_oid, "canonical tree metadata does not hash to authenticated tree")
    return result


class GitilesMetadata:
    def __init__(self, commit, evidence_dir, proxy=None, metadata_dir=None, event=None, cache_dir=None):
        require(commit in PINNED_TREES, "commit has no reviewed canonical root-tree pin")
        self.commit = commit
        self.expected_tree = PINNED_TREES[commit]
        self.directory = Path(evidence_dir) / "metadata"
        self.directory.mkdir()
        self.offline = Path(metadata_dir) if metadata_dir else None
        self.cache = Path(cache_dir) if cache_dir else None
        self.event = event or (lambda *args: None)
        self.records = []
        self.tree_cache = {}
        # With no explicit proxy, urllib retains ordinary host proxy settings.
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"https": proxy, "http": proxy}) if proxy
            else urllib.request.ProxyHandler())

    def get_raw(self, key, url):
        require(not (self.directory / key).exists(), "duplicate evidence metadata write")
        cached = self.offline / key if self.offline else self.cache / key if self.cache else None
        source_kind = "offline-replay" if self.offline else "authenticated-cache"
        if cached is not None and (self.offline or cached.is_file()):
            raw = cached.read_bytes()
        else:
            source_kind = "canonical-https"
            last_error = None
            for attempt in range(1, 5):
                try:
                    request = urllib.request.Request(url, headers={"User-Agent": "Chromium-source-provenance/1"})
                    with self.opener.open(request, timeout=90) as response:
                        require(response.url == url, "canonical metadata redirected unexpectedly")
                        raw = response.read(16 * 1024 * 1024 + 1)
                    require(len(raw) <= 16 * 1024 * 1024, "canonical metadata response too large")
                    break
                except (urllib.error.URLError, TimeoutError, OSError) as error:
                    last_error = error
                    self.event("metadata-retry", {"url": url, "attempt": attempt, "error": str(error)})
                    if attempt < 4:
                        time.sleep(attempt)
            else:
                raise VerificationError("canonical metadata fetch failed: " + url) from last_error
        (self.directory / key).write_bytes(raw)
        self.records.append({"file": key, "url": url, "bytes": len(raw),
                             "sha256": hashlib.sha256(raw).hexdigest()})
        self.event("metadata-recorded", {**self.records[-1], "source": source_kind})
        return raw

    def get(self, key, url):
        return decode_json(self.get_raw(key, url))

    def authenticate_commit(self):
        raw = self.get_raw("commit.text", ORIGIN + "/+/" + self.commit + "?format=TEXT")
        root_tree = authenticate_commit_object(raw, self.commit)
        require(root_tree == self.expected_tree, "raw canonical commit-to-tree binding mismatch")
        document = self.get("commit.json", ORIGIN + "/+/" + self.commit + "?format=JSON")
        require(isinstance(document, dict) and document.get("commit") == self.commit and
                document.get("tree") == self.expected_tree, "canonical commit-to-tree binding mismatch")
        return self.expected_tree

    def tree(self, path, expected_oid):
        if expected_oid not in self.tree_cache:
            url = ORIGIN + "/+/" + self.commit + "/"
            if path:
                url += urllib.parse.quote(path, safe="/") + "/"
            document = self.get("tree-" + expected_oid + ".json", url + "?format=JSON")
            self.tree_cache[expected_oid] = canonical_tree_entries(document, expected_oid)
        return self.tree_cache[expected_oid]


def authenticate_reviewed_exports(root, expected_oid, metadata, event=None):
    """Authenticate only reviewed, exact, root-bound Git working-tree exports.

    This changes the in-memory tree only. It never edits an archive or checkout.
    No arbitrary file, mixed newline conversion or unknown attribute is allowed.
    """
    event = event or (lambda *args: None)
    captures = root.reviewed_export_payloads
    results = []

    def canonical_entry(path):
        components = path.split("/")
        oid, parent = expected_oid, ""
        for index, name in enumerate(components):
            entries = metadata.tree(parent, oid)
            require(name in entries, "reviewed export path absent from canonical tree: " + path)
            mode, oid = entries[name]
            if index == len(components) - 1:
                return mode, oid
            require(mode == "40000", "reviewed export path has non-tree parent")
            parent = parent + "/" + name if parent else name

    def archive_parent(path):
        components = path.split("/")
        directory = root
        for name in components[:-1]:
            directory = directory.children.get(name)
            require(isinstance(directory, Directory), "reviewed export archive parent missing")
        return directory, components[-1]

    for path, (attribute_path, exact_rule) in REVIEWED_EOL_EXPORTS.items():
        if path not in captures:
            continue  # Ordinary strict reconciliation will reject omissions/types.
        expected_mode, expected_blob = canonical_entry(path)
        directory, name = archive_parent(path)
        archived = directory.children[name]
        if archived == (expected_mode, expected_blob):
            continue  # Raw canonical bytes need no export exception.
        require(expected_mode in ("100644", "100755") and
                archived[0] == expected_mode, "reviewed export executable-bit/type mismatch: " + path)
        require(captures.get(attribute_path) == exact_rule,
                "reviewed export lacks exact tracked EOL attribute rule: " + path)
        expected_attribute = canonical_entry(attribute_path)
        attribute_directory, attribute_name = archive_parent(attribute_path)
        require(expected_attribute == ("100644", git_object_id("blob", exact_rule)) and
                attribute_directory.children[attribute_name] == expected_attribute,
                "reviewed export EOL attribute is not canonical-root authenticated")
        exported = captures[path]
        canonical = exported.replace(b"\r\n", b"\n")
        require(b"\r" not in canonical and b"\n" in canonical and
                canonical.replace(b"\n", b"\r\n") == exported,
                "reviewed export is not an exact uniform LF-to-CRLF conversion: " + path)
        require(git_object_id("blob", canonical) == expected_blob,
                "reviewed EOL export normalized bytes do not match canonical blob: " + path)
        result = {"path": path, "conversion": "tracked text eol=crlf (LF -> CRLF)",
                  "mode": expected_mode, "attribute_path": attribute_path,
                  "attribute_blob": expected_attribute[1],
                  "archive_blob": archived[1], "archive_bytes": len(exported),
                  "canonical_blob": expected_blob, "canonical_bytes": len(canonical),
                  "converted_newlines": canonical.count(b"\n")}
        directory.children[name] = (expected_mode, expected_blob)
        results.append(result)
        event("authenticated-reviewed-git-archive-export", result)
    return results


def reconcile_tree(root, expected_oid, metadata, event=None):
    """Only add authenticated absent/empty gitlink entries; never source files."""
    gitlinks = []
    event = event or (lambda *args: None)
    # Identical tree objects can occur at different paths; no duplicate fetches.
    tree_cache = {}

    def visit(directory, expected, path):
        actual = directory.oid()
        if actual == expected:
            return
        event("tree-mismatch-inspect", {"path": path, "archive_tree": actual, "expected_tree": expected})
        if expected not in tree_cache:
            tree_cache[expected] = metadata.tree(path, expected)
        canonical = tree_cache[expected]
        extras = set(directory.children) - set(canonical)
        require(not extras, "unexpected archive entries in " + (path or "/") + ": " + repr(sorted(extras)))
        for name, (mode, oid) in canonical.items():
            entry_path = path + "/" + name if path else name
            item = directory.children.get(name)
            if mode == "160000":
                require(item is None or isinstance(item, Directory) and not item.children,
                        "archive provides files/content at canonical gitlink: " + entry_path)
                directory.children[name] = (mode, oid)
                gitlinks.append({"path": entry_path, "commit": oid})
                event("authenticated-gitlink", gitlinks[-1])
            elif mode == "40000":
                require(isinstance(item, Directory), "archive missing canonical directory: " + entry_path)
                visit(item, oid, entry_path)
            else:
                require(item == (mode, oid), "archive bytes/type/executable-bit mismatch: " + entry_path)
        require(directory.oid() == expected, "reconstructed Git tree mismatch: " + (path or "/"))

    visit(root, expected_oid, "")
    return gitlinks


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--commit", default=PINNED_COMMIT)
    parser.add_argument("--evidence-dir", required=True, type=Path,
                        help="new directory; existing evidence is never overwritten")
    parser.add_argument("--proxy", help="explicit HTTP(S) proxy, e.g. http://192.168.4.100:7890")
    metadata_inputs = parser.add_mutually_exclusive_group()
    metadata_inputs.add_argument("--metadata-dir", type=Path, help="offline replay of previously saved metadata")
    metadata_inputs.add_argument("--metadata-cache", type=Path,
                                 help="rehash cached metadata; fetch only missing records from canonical HTTPS")
    parser.add_argument("--allow-reviewed-git-archive-exports", action="store_true",
                        help="also authenticate exact, reviewed, tracked EOL exports (no blanket normalization)")
    parser.add_argument("--prefix", help="required single top-level archive directory")
    arguments = parser.parse_args(argv)
    require(arguments.commit in PINNED_TREES, "commit has no reviewed canonical root-tree pin")
    arguments.evidence_dir.mkdir(parents=True, exist_ok=False)
    report = {"schema": 1, "status": "rejected", "commit": arguments.commit,
              "canonical_origin": ORIGIN, "expected_root_tree": PINNED_TREES[arguments.commit],
              "archive_path": str(arguments.archive),
              "verifier_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    with (arguments.evidence_dir / "events.jsonl").open("x", encoding="utf-8") as log:
        def event(kind, details):
            row = {"event": kind, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(), **details}
            line = json.dumps(row, sort_keys=True)
            log.write(line + "\n")
            log.flush()
            print(line, flush=True)
        metadata = None
        try:
            metadata = GitilesMetadata(arguments.commit, arguments.evidence_dir, arguments.proxy,
                                       arguments.metadata_dir, event, arguments.metadata_cache)
            expected = metadata.authenticate_commit()
            root, summary = scan_archive(arguments.archive, arguments.prefix, event)
            report["archive"] = summary
            report["archive_root_before_gitlinks"] = root.oid()
            event("archive-hashed", {**summary, "root_before_gitlinks": root.oid()})
            report["reviewed_git_archive_exports"] = (
                authenticate_reviewed_exports(root, expected, metadata, event)
                if arguments.allow_reviewed_git_archive_exports else [])
            report["archive_root_after_reviewed_exports"] = root.oid()
            report["authenticated_gitlinks"] = reconcile_tree(root, expected, metadata, event)
            report["computed_root_tree"] = root.oid()
            require(root.oid() == expected, "full archive root-tree mismatch")
            report["status"] = "verified"
            event("full-source-verified", {"commit": arguments.commit, "root_tree": expected,
                                          "archive_sha256": summary["sha256"],
                                          "gitlinks": len(report["authenticated_gitlinks"])})
        except Exception as error:
            report["error"] = str(error)
            event("verification-rejected", {"error": str(error)})
        finally:
            report["metadata"] = metadata.records if metadata else []
            report["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            (arguments.evidence_dir / "proof.json").write_text(
                json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0 if report["status"] == "verified" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VerificationError, OSError) as error:
        print("error: " + str(error), file=sys.stderr)
        sys.exit(2)
