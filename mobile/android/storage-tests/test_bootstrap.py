"""Original SQL lease/nonce contracts, not browser, process-death or Android evidence."""
from concurrent.futures import ThreadPoolExecutor
import sqlite3
import threading
import uuid

from storage_harness import (FreshStorageCase, NOW, connect_existing, publish_fixture,
                             sql_transaction)


class BootstrapContracts(FreshStorageCase):
    def publish(self, profile=None, **options):
        profile = profile or self.seed()
        session, nonce = publish_fixture(self.db, profile, **options)
        return profile, session, nonce

    def stopped(self, session):
        self.db.execute("UPDATE launch_records SET state='EXIT_UNCONFIRMED',phase=90 "
                        "WHERE session_id=?", (session,))
        self.db.execute("UPDATE launch_records SET state='EXIT_CONFIRMED',phase=100 "
                        "WHERE session_id=?", (session,))

    def test_singleton_and_frozen_profile_snapshot(self):
        profile, session, nonce = self.publish()
        other = self.seed(name="Second profile")
        row = self.row("launch_records", "session_id", session)
        self.assertEqual(row["spec_json"], profile["spec_json"])
        self.assertEqual(row["config_hash"], profile["config_hash"])
        self.assertEqual(row["directory_suffix"], profile["directory_suffix"])
        self.assertEqual(row["nonce"], nonce)
        self.assertEqual(row["state"], "PUBLISHED")
        self.assertIsNone(row["incarnation_id"])
        with self.assertRaises(sqlite3.IntegrityError):
            publish_fixture(self.db, other)

    def test_ttl_is_positive_and_never_above_120_seconds(self):
        profile = self.seed()
        for ttl in (0, -1, 120001):
            with self.assertRaises(sqlite3.IntegrityError):
                publish_fixture(self.db, profile, ttl=ttl)
        _, session, _ = self.publish(profile, ttl=120000)
        row = self.row("launch_records", "session_id", session)
        self.assertEqual(row["expires_at_ms"] - row["issued_at_ms"], 120000)

    def test_stale_profile_snapshot_cannot_publish(self):
        profile = self.seed()
        for field, value in [("revision", str(uuid.uuid4())), ("spec_json", "{}"),
                             ("config_hash", "0" * 64), ("directory_suffix", "different")]:
            stale = dict(profile)
            stale[field] = value
            with self.assertRaises(sqlite3.IntegrityError):
                publish_fixture(self.db, stale)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM launch_records").fetchone()[0], 0)

    def test_claim_is_consumed_once_and_survives_close_reopen(self):
        _, session, _ = self.publish()
        with sql_transaction(self.db):
            incarnation, count = self.claim(session)
            self.assertEqual(count, 1)
            readback = self.row("launch_records", "session_id", session)
            self.assertEqual(readback["state"], "CLAIMED")
            self.assertEqual(readback["incarnation_id"], incarnation)
            self.assertEqual(readback["consumed_at_ms"], NOW + 1)
        self.db.close()
        self.db = connect_existing(self.path)
        self.assertEqual(self.row("launch_records", "session_id", session)["incarnation_id"], incarnation)
        with sql_transaction(self.db):
            self.assertEqual(self.claim(session)[1], 0)
        self.assertEqual(self.row("launch_records", "session_id", session)["state"], "CLAIMED")

    def test_two_connections_atomically_claim_only_one_nonce(self):
        _, session, _ = self.publish()
        barrier = threading.Barrier(2)

        def attempt(pid):
            connection = connect_existing(self.path)
            try:
                barrier.wait(timeout=5)
                with sql_transaction(connection):
                    # The session is selected from the store, not supplied by an Intent.
                    stored = connection.execute("SELECT session_id FROM launch_records "
                                                "WHERE state<>'EXIT_CONFIRMED'").fetchone()[0]
                    result = connection.execute("""UPDATE launch_records SET state='CLAIMED',
                        phase=10,incarnation_id=?,pid=?,consumed_at_ms=?
                        WHERE session_id=? AND state='PUBLISHED' AND consumed_at_ms IS NULL""",
                                                (str(uuid.uuid4()), pid, NOW + 1, stored))
                    return result.rowcount
            finally:
                connection.close()

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(attempt, pid) for pid in (32001, 32002)]
            results = [future.result(timeout=15) for future in futures]
        self.assertEqual(sorted(results), [0, 1])
        row = self.row("launch_records", "session_id", session)
        self.assertEqual(row["state"], "CLAIMED")
        self.assertIn(row["pid"], (32001, 32002))
        self.assertIsNotNone(row["consumed_at_ms"])

    def test_partial_null_claim_identity_cannot_bypass_checks(self):
        _, session, _ = self.publish()
        for incarnation, pid, consumed in [(str(uuid.uuid4()), None, NOW + 1),
                                            (None, 32001, NOW + 1),
                                            (str(uuid.uuid4()), 32001, None)]:
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("""UPDATE launch_records SET state='CLAIMED',phase=10,
                    incarnation_id=?,pid=?,consumed_at_ms=? WHERE session_id=?""",
                                (incarnation, pid, consumed, session))
        self.assertEqual(self.row("launch_records", "session_id", session)["state"], "PUBLISHED")

    def test_claim_timestamp_must_be_inside_frozen_ttl(self):
        _, session, _ = self.publish()
        for timestamp in (NOW - 1, NOW + 120000, NOW + 120001):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("""UPDATE launch_records SET state='CLAIMED',phase=10,
                    incarnation_id=?,pid=32001,consumed_at_ms=? WHERE session_id=?""",
                                (str(uuid.uuid4()), timestamp, session))

    def test_failed_claim_transaction_has_no_partial_consumption(self):
        _, session, _ = self.publish()
        with self.assertRaisesRegex(RuntimeError, "synthetic rollback"):
            with sql_transaction(self.db):
                self.assertEqual(self.claim(session)[1], 1)
                raise RuntimeError("synthetic rollback")
        row = self.row("launch_records", "session_id", session)
        self.assertEqual(row["state"], "PUBLISHED")
        self.assertIsNone(row["incarnation_id"])
        self.assertIsNone(row["consumed_at_ms"])
        with sql_transaction(self.db):
            self.assertEqual(self.claim(session)[1], 1)

    def test_consumed_ticket_cannot_be_republished_or_reclaimed(self):
        _, session, _ = self.publish()
        self.claim(session)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE launch_records SET state='PUBLISHED',phase=0,"
                            "incarnation_id=NULL,pid=NULL,consumed_at_ms=NULL WHERE session_id=?",
                            (session,))
        self.assertEqual(self.claim(session)[1], 0)

    def test_no_automatic_release_on_ttl_revocation_or_exit_unconfirmed(self):
        profile, session, _ = self.publish()
        other = self.seed(name="Another profile")
        for state in ("PUBLISHED", "REVOKED", "EXIT_UNCONFIRMED"):
            if state != "PUBLISHED":
                self.db.execute("UPDATE launch_records SET state=?,phase=90 WHERE session_id=?",
                                (state, session))
            with self.assertRaises(sqlite3.IntegrityError):
                publish_fixture(self.db, other, issued=NOW + 1_000_000)
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("DELETE FROM profiles WHERE id=?", (profile["id"],))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM launch_records "
                                        "WHERE state<>'EXIT_CONFIRMED'").fetchone()[0], 1)

    def test_all_unconfirmed_states_block_profile_and_ciphertext_modification(self):
        profile, session, _ = self.publish(self.seed(credentials=True))
        self.claim(session)
        for state in ("CLAIMED", "EXIT_UNCONFIRMED"):
            if state == "EXIT_UNCONFIRMED":
                self.db.execute("UPDATE launch_records SET state=?,phase=90 WHERE session_id=?",
                                (state, session))
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("UPDATE profiles SET revision=?,name='Blocked' WHERE id=?",
                                (str(uuid.uuid4()), profile["id"]))
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("DELETE FROM profiles WHERE id=?", (profile["id"],))
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("UPDATE credential_envelopes SET ciphertext=? WHERE profile_id=?",
                                (bytes(reversed(range(64))), profile["id"]))
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("DELETE FROM credential_envelopes WHERE profile_id=?", (profile["id"],))

    def test_wrong_session_or_incarnation_parameter_never_changes_matching_row(self):
        _, session, _ = self.publish()
        result = self.db.execute("UPDATE launch_records SET state='REVOKED',phase=90 "
                                 "WHERE session_id=? AND state='PUBLISHED'", (str(uuid.uuid4()),))
        self.assertEqual(result.rowcount, 0)
        incarnation, _ = self.claim(session)
        result = self.db.execute("UPDATE launch_records SET state='EXIT_UNCONFIRMED',phase=90 "
                                 "WHERE session_id=? AND incarnation_id=?",
                                 (session, str(uuid.uuid4())))
        self.assertEqual(result.rowcount, 0)
        self.assertEqual(self.row("launch_records", "session_id", session)["incarnation_id"], incarnation)
        self.assertEqual(self.row("launch_records", "session_id", session)["state"], "CLAIMED")

    def test_claimed_cannot_be_unclaimed_revoked_and_direct_confirmation_is_rejected(self):
        _, session, _ = self.publish()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE launch_records SET state='EXIT_CONFIRMED',phase=100 WHERE session_id=?",
                            (session,))
        self.claim(session)
        for state, phase in [("REVOKED", 90), ("EXIT_CONFIRMED", 100)]:
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("UPDATE launch_records SET state=?,phase=? WHERE session_id=?",
                                (state, phase, session))

    def test_snapshot_fields_cannot_be_replaced_after_publication(self):
        _, session, _ = self.publish()
        for field, value in [("session_id", str(uuid.uuid4())), ("nonce", str(uuid.uuid4())),
                             ("spec_json", "{}"), ("config_hash", "0" * 64),
                             ("directory_suffix", "different"), ("issued_at_ms", NOW - 1),
                             ("expires_at_ms", NOW + 1)]:
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(f"UPDATE launch_records SET {field}=? WHERE session_id=?", (value, session))

    def test_runtime_provider_identity_and_stage_are_monotonic(self):
        _, session, _ = self.publish()
        self.claim(session)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE launch_records SET phase=30 WHERE session_id=?", (session,))
        self.db.execute("UPDATE launch_records SET phase=30,provider='fixture.provider/1' WHERE session_id=?",
                        (session,))
        for field, value in [("phase", 20), ("provider", "changed.provider/2"), ("pid", 32002),
                             ("incarnation_id", str(uuid.uuid4())), ("consumed_at_ms", NOW + 2)]:
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(f"UPDATE launch_records SET {field}=? WHERE session_id=?", (value, session))

    def test_confirmed_history_is_immutable_and_does_not_pin_profile_configuration(self):
        profile, session, _ = self.publish()
        self.claim(session)
        self.stopped(session)  # SQL transition test only, NOT proof that any real PID died.
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM launch_records WHERE session_id=?", (session,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE launch_records SET state='EXIT_UNCONFIRMED',phase=90 WHERE session_id=?",
                            (session,))
        self.db.execute("DELETE FROM profiles WHERE id=?", (profile["id"],))
        self.assertEqual(self.row("launch_records", "session_id", session)["spec_json"], profile["spec_json"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM launch_records "
                                        "WHERE state<>'EXIT_CONFIRMED'").fetchone()[0], 0)

    def test_nonce_and_session_cannot_replay_after_confirmed_exit(self):
        profile, session, nonce = self.publish()
        self.stopped(session)
        with self.assertRaises(sqlite3.IntegrityError):
            publish_fixture(self.db, profile, nonce=nonce)
        with self.assertRaises(sqlite3.IntegrityError):
            publish_fixture(self.db, profile, session=session)
        _, new_session, _ = self.publish(profile)
        self.assertNotEqual(new_session, session)

    def test_process_incarnation_cannot_be_reused_for_a_later_ticket(self):
        profile, session, _ = self.publish()
        incarnation, _ = self.claim(session)
        self.stopped(session)
        _, next_session, _ = self.publish(profile)
        with self.assertRaises(sqlite3.IntegrityError):
            self.claim(next_session, incarnation=incarnation)
        self.assertEqual(self.row("launch_records", "session_id", next_session)["state"], "PUBLISHED")

    def test_session_nonce_and_incarnation_must_be_canonical_uuids(self):
        profile = self.seed()
        bad = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"
        for arguments in ({"session": bad}, {"nonce": bad}):
            with self.assertRaises(sqlite3.IntegrityError):
                publish_fixture(self.db, profile, **arguments)
        _, session, _ = self.publish(profile)
        with self.assertRaises(sqlite3.IntegrityError):
            self.claim(session, incarnation=bad)
        self.assertEqual(self.row("launch_records", "session_id", session)["state"], "PUBLISHED")
