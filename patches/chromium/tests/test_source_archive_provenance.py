#!/usr/bin/env python3
"""Offline regression tests for source-archive Git-object authentication."""

import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock


PATCH_ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("source_archive", PATCH_ROOT / "verify-source-archive.py")
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


def blob(data):
    return VERIFIER.git_object_id("blob", data)


def commit_fixture(directory, root_tree):
    payload = ("tree " + root_tree + "\nauthor Test <test@example.invalid> 0 +0000\n"
               "committer Test <test@example.invalid> 0 +0000\n\nFixture\n").encode()
    commit = VERIFIER.git_object_id("commit", payload)
    (directory / "commit.text").write_bytes(base64.b64encode(payload))
    (directory / "commit.json").write_bytes(b")]}'\n" + json.dumps({
        "commit": commit, "tree": root_tree}).encode())
    return commit


def tree_document(entries):
    oid = VERIFIER.tree_id(entries)
    return {"id": oid, "entries": [
        {"name": name, "mode": int(mode, 8), "type": VERIFIER.GIT_MODES[mode], "id": value}
        for name, (mode, value) in entries.items()]}


class Metadata:
    def __init__(self, documents):
        self.documents = {document["id"]: document for document in documents}
        self.queries = []

    def tree(self, path, oid):
        self.queries.append(path)
        return VERIFIER.canonical_tree_entries(self.documents[oid], oid)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def archive(self, entries, compression="gz"):
        path = self.root / ("fixture.tar" + ("." + compression if compression else ""))
        with tarfile.open(path, "w:" + compression) as output:
            member = tarfile.TarInfo("source/")
            member.type = tarfile.DIRTYPE
            member.mode = 0o755
            output.addfile(member)
            for name, kind, content, mode in entries:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.mode = mode
                if kind == tarfile.REGTYPE:
                    member.size = len(content)
                    output.addfile(member, io.BytesIO(content))
                else:
                    if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                        member.linkname = content
                    output.addfile(member)
        return path

    def simple_archive(self, data=b"hello\n", mode=0o644):
        return self.archive([("source/file", tarfile.REGTYPE, data, mode)])

    def test_streaming_bytes_modes_symlinks_and_archive_digest(self):
        path = self.archive([
            ("source/bin", tarfile.DIRTYPE, b"", 0o755),
            ("source/bin/tool", tarfile.REGTYPE, b"#!/bin/sh\n", 0o775),
            ("source/plain", tarfile.REGTYPE, b"a\x00b", 0o664),
            ("source/link", tarfile.SYMTYPE, "bin/tool", 0o777),
        ])
        root, summary = VERIFIER.scan_archive(path, "source")
        subtree = VERIFIER.tree_id({"tool": ("100755", blob(b"#!/bin/sh\n"))})
        expected = VERIFIER.tree_id({"bin": ("40000", subtree),
                                    "plain": ("100644", blob(b"a\x00b")),
                                    "link": ("120000", blob(b"bin/tool"))})
        self.assertEqual(root.oid(), expected)
        self.assertEqual(summary["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(summary["bytes"], path.stat().st_size)
        self.assertEqual(summary["regular_files"], 2)
        self.assertEqual(summary["symlinks"], 1)

    def test_uncompressed_xz_and_bzip2(self):
        for compression in ("", "xz", "bz2"):
            with self.subTest(compression=compression):
                path = self.archive([("source/file", tarfile.REGTYPE, b"data", 0o644)], compression)
                root, summary = VERIFIER.scan_archive(path)
                self.assertEqual(root.oid(), VERIFIER.tree_id({"file": ("100644", blob(b"data"))}))
                self.assertEqual(summary["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())

    def test_git_object_encoding_and_directory_name_order_match_git(self):
        repository = self.root / "git"
        subprocess.run(["git", "init", "-q", str(repository)], check=True)
        empty = subprocess.check_output(["git", "-C", str(repository), "mktree"], input=b"").strip().decode()
        file_oid = subprocess.check_output(["git", "-C", str(repository), "hash-object", "-w", "--stdin"],
                                           input=b"bytes\x00\xff").strip().decode()
        entries = {"foo": ("40000", empty), "foo.bar": ("100644", file_oid),
                   "foo0": ("100755", file_oid), "é": ("120000", file_oid)}
        git_input = b"".join((mode + " " + VERIFIER.GIT_MODES[mode] + " " + oid + "\t" + name).encode()
                             + b"\0" for name, (mode, oid) in entries.items())
        expected = subprocess.check_output(["git", "-C", str(repository), "mktree", "-z"], input=git_input).strip().decode()
        self.assertEqual(VERIFIER.tree_id(entries), expected)
        self.assertEqual(blob(b"bytes\x00\xff"), file_oid)

    def test_gitlinks_reconstructed_only_from_authenticated_mismatched_trees(self):
        path = self.archive([
            ("source/same", tarfile.REGTYPE, b"safe", 0o644),
            ("source/third_party", tarfile.DIRTYPE, b"", 0o755),
            ("source/third_party/library", tarfile.DIRTYPE, b"", 0o755),
            ("source/third_party/own", tarfile.REGTYPE, b"owned", 0o644),
        ])
        root, _ = VERIFIER.scan_archive(path)
        child = tree_document({"own": ("100644", blob(b"owned")), "library": ("160000", "a" * 40),
                               "omitted": ("160000", "b" * 40)})
        canonical = tree_document({"same": ("100644", blob(b"safe")), "third_party": ("40000", child["id"])})
        metadata = Metadata([canonical, child])
        links = VERIFIER.reconcile_tree(root, canonical["id"], metadata)
        self.assertEqual(root.oid(), canonical["id"])
        self.assertEqual(metadata.queries, ["", "third_party"])
        self.assertEqual(links, [{"path": "third_party/library", "commit": "a" * 40},
                                 {"path": "third_party/omitted", "commit": "b" * 40}])

    def test_matching_subtree_needs_no_recursive_metadata(self):
        root, _ = VERIFIER.scan_archive(self.simple_archive())
        metadata = Metadata([])
        self.assertEqual(VERIFIER.reconcile_tree(root, root.oid(), metadata), [])
        self.assertEqual(metadata.queries, [])

    def test_archive_content_at_gitlink_is_rejected(self):
        for entries in ([ ("source/link", tarfile.REGTYPE, b"file", 0o644) ],
                        [ ("source/link/inside", tarfile.REGTYPE, b"file", 0o644) ],
                        [ ("source/link", tarfile.SYMTYPE, "other", 0o777) ]):
            with self.subTest(entries=entries):
                root, _ = VERIFIER.scan_archive(self.archive(entries))
                canonical = tree_document({"link": ("160000", "a" * 40)})
                with self.assertRaisesRegex(VERIFIER.VerificationError, "canonical gitlink"):
                    VERIFIER.reconcile_tree(root, canonical["id"], Metadata([canonical]))

    def test_changed_bytes_executable_bit_and_symlink_target_rejected(self):
        canonical = tree_document({"file": ("100644", blob(b"hello\n"))})
        for data, mode in ((b"altered", 0o644), (b"hello\n", 0o755)):
            with self.subTest(data=data, mode=mode):
                root, _ = VERIFIER.scan_archive(self.simple_archive(data, mode))
                with self.assertRaisesRegex(VERIFIER.VerificationError, "bytes/type/executable-bit"):
                    VERIFIER.reconcile_tree(root, canonical["id"], Metadata([canonical]))
        root, _ = VERIFIER.scan_archive(self.archive([("source/file", tarfile.SYMTYPE, "changed", 0o777)]))
        canonical = tree_document({"file": ("120000", blob(b"original"))})
        with self.assertRaises(VERIFIER.VerificationError):
            VERIFIER.reconcile_tree(root, canonical["id"], Metadata([canonical]))

    def test_missing_regular_file_never_injected(self):
        root, _ = VERIFIER.scan_archive(self.archive([]))
        canonical = tree_document({"file": ("100644", blob(b"hello"))})
        with self.assertRaisesRegex(VERIFIER.VerificationError, "bytes/type/executable-bit"):
            VERIFIER.reconcile_tree(root, canonical["id"], Metadata([canonical]))

    def test_extra_file_and_empty_directory_rejected(self):
        canonical = tree_document({})
        for kind, content in ((tarfile.REGTYPE, b"extra"), (tarfile.DIRTYPE, b"")):
            with self.subTest(kind=kind):
                root, _ = VERIFIER.scan_archive(self.archive([("source/extra", kind, content, 0o644)]))
                with self.assertRaisesRegex(VERIFIER.VerificationError, "unexpected archive entries"):
                    VERIFIER.reconcile_tree(root, canonical["id"], Metadata([canonical]))

    def test_missing_canonical_directory_rejected(self):
        root, _ = VERIFIER.scan_archive(self.archive([]))
        child = tree_document({"file": ("100644", blob(b"hello"))})
        canonical = tree_document({"directory": ("40000", child["id"])})
        with self.assertRaisesRegex(VERIFIER.VerificationError, "missing canonical directory"):
            VERIFIER.reconcile_tree(root, canonical["id"], Metadata([canonical, child]))

    def test_malformed_paths_duplicate_entries_hardlinks_and_special_modes(self):
        cases = [
            [("/source/absolute", tarfile.REGTYPE, b"", 0o644)],
            [("source/../escape", tarfile.REGTYPE, b"", 0o644)],
            [("source/./dot", tarfile.REGTYPE, b"", 0o644)],
            [("source//double", tarfile.REGTYPE, b"", 0o644)],
            [("source/back\\slash", tarfile.REGTYPE, b"", 0o644)],
            [("other/file", tarfile.REGTYPE, b"", 0o644)],
            [("source/file", tarfile.REGTYPE, b"a", 0o644), ("source/file", tarfile.REGTYPE, b"b", 0o644)],
            [("source/hard", tarfile.LNKTYPE, "source/file", 0o644)],
            [("source/fifo", tarfile.FIFOTYPE, b"", 0o644)],
            [("source/setuid", tarfile.REGTYPE, b"", 0o4755)],
            [("source/parent", tarfile.SYMTYPE, "somewhere", 0o777),
             ("source/parent/child", tarfile.REGTYPE, b"", 0o644)],
        ]
        for entries in cases:
            with self.subTest(entries=entries):
                with self.assertRaises(VERIFIER.VerificationError):
                    VERIFIER.scan_archive(self.archive(entries), "source")

    def test_truncated_gzip_rejected(self):
        path = self.simple_archive()
        path.write_bytes(path.read_bytes()[:-5])
        with self.assertRaises((EOFError, OSError, tarfile.TarError)):
            VERIFIER.scan_archive(path)

    def test_entries_after_tar_end_are_not_hidden(self):
        first = self.archive([], "").read_bytes()
        second = self.simple_archive().read_bytes()
        # A new compressed member must be checked too, not silently ignored.
        import gzip
        path = self.root / "appended.tar.gz"
        path.write_bytes(gzip.compress(first) + second)
        with self.assertRaisesRegex(VERIFIER.VerificationError, "duplicate archive entry"):
            VERIFIER.scan_archive(path)

    def test_archive_mutation_during_scan_rejected(self):
        path = self.simple_archive()
        original = VERIFIER.archive_identity
        calls = []
        def changed(info):
            calls.append(1)
            identity = original(info)
            return identity if len(calls) == 1 else identity[:-1] + (identity[-1] + 1,)
        with mock.patch.object(VERIFIER, "archive_identity", side_effect=changed):
            with self.assertRaisesRegex(VERIFIER.VerificationError, "changed during"):
                VERIFIER.scan_archive(path)

    def test_tree_metadata_wrong_hash_mode_type_and_duplicate_rejected(self):
        valid = tree_document({"file": ("100644", blob(b"hello"))})
        wrong_oid = copy.deepcopy(valid)
        wrong_oid["entries"][0]["id"] = "a" * 40
        wrong_mode = copy.deepcopy(valid)
        wrong_mode["entries"][0]["mode"] = 0o100600
        wrong_type = copy.deepcopy(valid)
        wrong_type["entries"][0]["type"] = "commit"
        duplicate = copy.deepcopy(valid)
        duplicate["entries"].append(duplicate["entries"][0])
        bad_name = copy.deepcopy(valid)
        bad_name["entries"][0]["name"] = "../outside"
        for document in (wrong_oid, wrong_mode, wrong_type, duplicate, bad_name):
            with self.subTest(document=document):
                with self.assertRaises(VERIFIER.VerificationError):
                    VERIFIER.canonical_tree_entries(document, valid["id"])

    def eol_fixture(self, exported=b"a\r\nb\r\n", attribute=None, mode=0o644, canonical_attribute=None):
        target, (attribute_path, rule) = next(iter(VERIFIER.REVIEWED_EOL_EXPORTS.items()))
        canonical, _ = VERIFIER.scan_archive(self.archive([
            ("source/" + attribute_path, tarfile.REGTYPE,
             rule if canonical_attribute is None else canonical_attribute, 0o644),
            ("source/" + target, tarfile.REGTYPE, b"a\nb\n", 0o644)]))
        documents = []
        def collect(directory):
            documents.append(tree_document(directory.entries()))
            for child in directory.children.values():
                if isinstance(child, VERIFIER.Directory):
                    collect(child)
        collect(canonical)
        archive, _ = VERIFIER.scan_archive(self.archive([
            ("source/" + attribute_path, tarfile.REGTYPE, rule if attribute is None else attribute, 0o644),
            ("source/" + target, tarfile.REGTYPE, exported, mode)]))
        return archive, canonical.oid(), Metadata(documents)

    def test_only_exact_root_authenticated_reviewed_eol_export_allowed(self):
        root, expected, metadata = self.eol_fixture()
        raw = root.oid()
        result = VERIFIER.authenticate_reviewed_exports(root, expected, metadata)
        self.assertNotEqual(raw, expected)
        self.assertEqual(root.oid(), expected)
        self.assertEqual(result[0]["archive_bytes"], 6)
        self.assertEqual(result[0]["canonical_bytes"], 4)
        self.assertEqual(result[0]["converted_newlines"], 2)
        self.assertEqual(result[0]["attribute_blob"], blob(b"crlf.html text eol=crlf\n"))
        self.assertEqual(VERIFIER.reconcile_tree(root, expected, metadata), [])

    def test_reviewed_eol_export_rejects_changes_mixed_newlines_mode_and_attribute(self):
        cases = [
            {"exported": b"changed\r\nb\r\n"},
            {"exported": b"a\r\nb\n"},
            {"exported": b"a\rb\r\n"},
            {"attribute": b"crlf.html text eol=lf\n"},
            {"attribute": b"* text eol=crlf\n"},
            {"canonical_attribute": b"crlf.html text eol=lf\n"},
            {"mode": 0o755},
        ]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                root, expected, metadata = self.eol_fixture(**arguments)
                with self.assertRaises(VERIFIER.VerificationError):
                    VERIFIER.authenticate_reviewed_exports(root, expected, metadata)

    def test_unknown_crlf_path_is_never_normalized(self):
        root, _ = VERIFIER.scan_archive(self.simple_archive(b"a\r\nb\r\n"))
        canonical = tree_document({"file": ("100644", blob(b"a\nb\n"))})
        metadata = Metadata([canonical])
        self.assertEqual(VERIFIER.authenticate_reviewed_exports(root, canonical["id"], metadata), [])
        with self.assertRaises(VERIFIER.VerificationError):
            VERIFIER.reconcile_tree(root, canonical["id"], metadata)

    def test_authenticated_cache_reuses_raw_commit_without_network(self):
        cache = self.root / "cache"
        cache.mkdir()
        commit = commit_fixture(cache, "b" * 40)
        evidence = self.root / "evidence"
        evidence.mkdir()
        with mock.patch.dict(VERIFIER.PINNED_TREES, {commit: "b" * 40}):
            metadata = VERIFIER.GitilesMetadata(commit, evidence, cache_dir=cache)
            with mock.patch.object(metadata.opener, "open", side_effect=AssertionError("network not allowed")):
                self.assertEqual(metadata.authenticate_commit(), "b" * 40)

    def test_gitiles_header_required(self):
        with self.assertRaises(VERIFIER.VerificationError):
            VERIFIER.decode_json(b'{"id":"untrusted"}')

    def test_raw_commit_hash_and_root_header_authentication(self):
        offline = self.root / "metadata"
        offline.mkdir()
        commit = commit_fixture(offline, "b" * 40)
        encoded = (offline / "commit.text").read_bytes()
        self.assertEqual(VERIFIER.authenticate_commit_object(encoded, commit), "b" * 40)
        with self.assertRaisesRegex(VERIFIER.VerificationError, "commit object hash"):
            VERIFIER.authenticate_commit_object(encoded, "a" * 40)
        with self.assertRaisesRegex(VERIFIER.VerificationError, "base64"):
            VERIFIER.authenticate_commit_object(b"not base64", commit)
        payload = b"not a tree header\n"
        with self.assertRaisesRegex(VERIFIER.VerificationError, "root-tree header"):
            VERIFIER.authenticate_commit_object(base64.b64encode(payload),
                                                VERIFIER.git_object_id("commit", payload))

    def test_pinned_commit_and_root_required_for_offline_metadata(self):
        offline = self.root / "metadata"
        offline.mkdir()
        commit = commit_fixture(offline, "b" * 40)
        evidence = self.root / "evidence"
        evidence.mkdir()
        with mock.patch.dict(VERIFIER.PINNED_TREES, {commit: "a" * 40}):
            metadata = VERIFIER.GitilesMetadata(commit, evidence, metadata_dir=offline)
            with self.assertRaisesRegex(VERIFIER.VerificationError, "commit-to-tree binding"):
                metadata.authenticate_commit()
        with self.assertRaisesRegex(VERIFIER.VerificationError, "reviewed canonical root-tree"):
            VERIFIER.GitilesMetadata("a" * 40, self.root)

    def test_cli_success_and_offline_replay_bind_complete_archive(self):
        path = self.simple_archive()
        root, _ = VERIFIER.scan_archive(path)
        offline = self.root / "metadata"
        offline.mkdir()
        commit = commit_fixture(offline, root.oid())
        evidence = self.root / "success"
        replay = self.root / "replay"
        with mock.patch.dict(VERIFIER.PINNED_TREES, {commit: root.oid()}):
            with contextlib.redirect_stdout(io.StringIO()):
                for output, metadata in ((evidence, offline), (replay, evidence / "metadata")):
                    self.assertEqual(VERIFIER.main([
                        str(path), "--commit", commit, "--evidence-dir", str(output),
                        "--metadata-dir", str(metadata)]), 0)
        proof = json.loads((evidence / "proof.json").read_text())
        repeated = json.loads((replay / "proof.json").read_text())
        self.assertEqual(proof["status"], "verified")
        self.assertEqual(proof["computed_root_tree"], root.oid())
        self.assertEqual(proof["archive"]["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(proof["archive"], repeated["archive"])
        self.assertEqual(proof["metadata"], repeated["metadata"])

    def test_cli_preserves_rejection_evidence_and_existing_evidence(self):
        path = self.simple_archive()
        offline = self.root / "metadata"
        offline.mkdir()
        commit_fixture(offline, "a" * 40)
        evidence = self.root / "evidence"
        args = [str(path), "--evidence-dir", str(evidence), "--metadata-dir", str(offline)]
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(VERIFIER.main(args), 1)
        proof = json.loads((evidence / "proof.json").read_text())
        self.assertEqual(proof["status"], "rejected")
        self.assertIn("commit object hash", proof["error"])
        with self.assertRaises(FileExistsError):
            VERIFIER.main(args)


class ProvenanceShellTests(unittest.TestCase):
    OLD_COMMIT = "fc4d67f1788019a27e32511137ceccbd2fafdaaa"
    OLD_ARCHIVE = "1a544857555a0c391753e7f9f3016cc07b0288d9da02260c451aa9082b305066"
    NEW_ARCHIVE = "478c17ee1c0021b22b9ff184ee416b19b35a9e141b2da1b8206074947414a45f"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def checkout(self, base=None, archive=None, target=None, bind=True):
        base = base or VERIFIER.PINNED_COMMIT
        archive = archive or self.NEW_ARCHIVE
        target = target or VERIFIER.PINNED_COMMIT
        source = self.root / "src"
        source.mkdir()
        subprocess.run(["git", "init", "-q", str(source)], check=True)
        tree = subprocess.check_output(["git", "-C", str(source), "mktree"], input=b"").strip().decode()
        # A deliberately synthetic fixture, never the real pinned Git HEAD.
        message = "Test-only synthetic archive seed\n\n"
        if bind:
            message += "Upstream-Commit: " + base + "\nArchive-SHA256: " + archive + "\n"
        commit = subprocess.check_output([
            "git", "-C", str(source), "-c", "user.name=Fixture", "-c",
            "user.email=fixture@example.invalid", "commit-tree", tree], input=message.encode()).strip().decode()
        self.assertNotEqual(commit, VERIFIER.PINNED_COMMIT)
        subprocess.run(["git", "-C", str(source), "update-ref", "refs/heads/fixture", commit], check=True)
        subprocess.run(["git", "-C", str(source), "symbolic-ref", "HEAD", "refs/heads/fixture"], check=True)
        for name, value in (("base-commit", base), ("commit", target), ("archive.sha256", archive)):
            (source / (".chromium-source-" + name)).write_text(value + "\n")
        return source

    def verify(self, source, expected=None):
        return subprocess.run(["bash", str(PATCH_ROOT / "verify-source-provenance.sh"), str(source),
                               expected or VERIFIER.PINNED_COMMIT], capture_output=True, text=True)

    def test_authenticated_72_archive_registered_without_faking_head(self):
        source = self.checkout()
        result = self.verify(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("trusted archive base " + VERIFIER.PINNED_COMMIT, result.stdout)
        self.assertNotEqual(subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"])
                            .strip().decode(), VERIFIER.PINNED_COMMIT)

    def test_existing_65_delta_chain_remains_supported(self):
        result = self.verify(self.checkout(self.OLD_COMMIT, self.OLD_ARCHIVE))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_unknown_base_and_wrong_archive_digest_rejected(self):
        source = self.checkout(archive="a" * 64)
        result = self.verify(source)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA-256", result.stderr)
        (source / ".chromium-source-base-commit").write_text("b" * 40 + "\n")
        result = self.verify(source)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("untrusted", result.stderr)

    def test_unbound_synthetic_commit_rejected(self):
        result = self.verify(self.checkout(bind=False))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not bind", result.stderr)

    def test_target_commit_mismatch_rejected(self):
        result = self.verify(self.checkout(target="a" * 40))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("target is", result.stderr)

    def seed(self, version, commit, digest):
        environment = dict(os.environ, CHROMIUM_ARCHIVE_VERSION=version,
                           CHROMIUM_ARCHIVE_COMMIT=commit, CHROMIUM_ARCHIVE_SHA256=digest)
        return subprocess.run(["bash", str(PATCH_ROOT / "seed-source-archive.sh"), str(self.root),
                               str(self.root / "does-not-exist.tar.gz")], env=environment,
                              capture_output=True, text=True)

    def test_seed_rejects_digest_override_for_both_registered_archives(self):
        for version, commit in (("152.0.7977.65", self.OLD_COMMIT),
                                ("152.0.7977.72", VERIFIER.PINNED_COMMIT)):
            with self.subTest(version=version):
                result = self.seed(version, commit, "a" * 64)
                self.assertEqual(result.returncode, 2)
                self.assertIn("configured SHA-256 does not match", result.stderr)

    def test_seed_rejects_unknown_commit_even_with_user_digest(self):
        for version, commit in (("152.0.7977.99", "b" * 40),
                                ("152.0.7977.72", self.OLD_COMMIT),
                                ("152.0.7977.65", VERIFIER.PINNED_COMMIT)):
            with self.subTest(version=version, commit=commit):
                result = self.seed(version, commit, "a" * 64)
                self.assertEqual(result.returncode, 2)
                self.assertIn("no authenticated archive", result.stderr)

    def test_seed_recognizes_only_registered_version_commit_digest_pairs(self):
        for version, commit, digest in (("152.0.7977.65", self.OLD_COMMIT, self.OLD_ARCHIVE),
                                        ("152.0.7977.72", VERIFIER.PINNED_COMMIT, self.NEW_ARCHIVE)):
            with self.subTest(version=version):
                result = self.seed(version, commit, digest)
                self.assertEqual(result.returncode, 2)
                # Registration succeeds, then the deliberately unconfigured test
                # directory stops the seeder before any checkout can be written.
                self.assertIn("gclient root is not configured", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
