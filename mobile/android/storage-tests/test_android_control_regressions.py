"""SQL order counterexamples and static Java guards, NOT Android execution proof."""
from pathlib import Path
import sqlite3

from storage_harness import ANDROID, FreshStorageCase, sql_transaction


def method(source, signature):
    start = source.index(signature)
    brace = source.index("{", start)
    depth = 1
    end = brace + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[brace:end]


def early_stop_intent(body):
    return body.index("stopping = true") < body.index("store.readActive()")


def rejected_unbind_first(body):
    start = body.index("ControlProtocol.EXIT_REJECTED")
    portion = body[start:]
    return portion.index("unbindControl()") < portion.index("endpoint.send(exit)")


class AtomicStopContracts(FreshStorageCase):
    def request_stop_sql_contract(self, session):
        # Same existing-table transition as the Java method; not an execution of it.
        with sql_transaction(self.db):
            row = self.row("launch_records", "session_id", session)
            state = "REVOKED" if row["state"] == "PUBLISHED" else "EXIT_UNCONFIRMED"
            updated = self.db.execute("UPDATE launch_records SET state=?,phase=90 "
                                      "WHERE session_id=? AND state=?", (state, session, row["state"]))
            self.assertEqual(updated.rowcount, 1)
            return self.row("launch_records", "session_id", session)

    def test_stop_wins_before_claim_and_does_not_unlock_slot(self):
        from storage_harness import publish_fixture
        profile = self.seed()
        session, _ = publish_fixture(self.db, profile)
        stopped = self.request_stop_sql_contract(session)
        self.assertEqual(stopped["state"], "REVOKED")
        self.assertIsNone(stopped["pid"])
        self.assertEqual(self.claim(session)[1], 0)
        with self.assertRaises(sqlite3.IntegrityError):
            publish_fixture(self.db, profile)

    def test_claim_wins_and_stop_retains_its_exact_identity(self):
        from storage_harness import publish_fixture
        session, _ = publish_fixture(self.db, self.seed())
        incarnation, count = self.claim(session)
        self.assertEqual(count, 1)
        before = self.row("launch_records", "session_id", session)
        stopped = self.request_stop_sql_contract(session)
        self.assertEqual(stopped["state"], "EXIT_UNCONFIRMED")
        self.assertEqual(stopped["incarnation_id"], incarnation)
        self.assertEqual(stopped["pid"], before["pid"])
        self.assertEqual(stopped["nonce"], before["nonce"])

    def test_repeated_stop_preserves_unconfirmed_identity(self):
        from storage_harness import publish_fixture
        session, _ = publish_fixture(self.db, self.seed())
        incarnation, _ = self.claim(session)
        self.request_stop_sql_contract(session)
        stopped = self.request_stop_sql_contract(session)
        self.assertEqual(stopped["state"], "EXIT_UNCONFIRMED")
        self.assertEqual(stopped["incarnation_id"], incarnation)


class AndroidControlSourceGuards(FreshStorageCase):
    def source(self, relative):
        return (ANDROID / "app/src/main/java/com/ahoo/abs/android" / relative).read_text()

    def test_stop_intent_precedes_db_read_and_transaction_returns_latest_owner(self):
        body = method(self.source("process/LaunchCoordinator.java"), "public void stop()")
        self.assertTrue(early_stop_intent(body))
        self.assertIn("active = store.requestStop(active.launch.sessionId)", body)
        data = method(self.source("data/BootstrapStore.java"), "public ActiveLaunch requestStop(")
        self.assertIn("database.transaction", data)
        self.assertIn("LaunchRecords.requireActive", data)
        self.assertIn("State.REVOKED : State.EXIT_UNCONFIRMED", data)
        self.assertIn("return LaunchRecords.requireActive", data)
        self.assertNotIn("recordConfirmedExit", data)

    def test_counterexample_late_stop_intent_flips_source_guard(self):
        body = method(self.source("process/LaunchCoordinator.java"), "public void stop()")
        self.assertTrue(early_stop_intent(body))
        planted = body.replace("stopping = true;", "", 1).replace(
            "BootstrapStore.ActiveLaunch active = store.readActive();",
            "BootstrapStore.ActiveLaunch active = store.readActive(); stopping = true;", 1)
        self.assertFalse(early_stop_intent(planted))

    def test_rejected_exit_unbinds_before_send_and_still_polls(self):
        body = method(self.source("process/LaunchCoordinator.java"), "private boolean receive(")
        self.assertTrue(rejected_unbind_first(body))
        self.assertIn("waitForExit(SystemClock.elapsedRealtime() + 5000)", body)
        planted = body.replace("unbindControl();\n                    try {\n                        endpoint.send(exit);",
                               "endpoint.send(exit);\n                    try {\n                        unbindControl();", 1)
        self.assertNotEqual(planted, body)
        self.assertFalse(rejected_unbind_first(planted))

    def test_polling_is_session_and_operation_bound(self):
        body = method(self.source("process/LaunchCoordinator.java"), "private void pollExit(")
        self.assertIn("generation != exitWaitGeneration", body)
        self.assertIn("!ownerSession.equals(current.sessionId)", body)
        self.assertIn("store.findLaunch(ownerSession)", body)
        self.assertIn("machine.sessionId.equals(ownerSession)", body)
        self.assertIn("pollExit(ownerSession, generation, deadline)", body)
        self.assertNotIn("store.readActive()", body)

    def test_full_gate_and_fresh_activation_are_not_removed(self):
        runtime = self.source("browser/BrowserRuntime.java")
        self.assertIn("networkConfinement = Proof.UNSUPPORTED", runtime)
        self.assertIn("storageLifecycle = Proof.UNVERIFIED", runtime)
        self.assertIn("application.requireBrowserActivation()", runtime)
        application = method(self.source("BrowserApplication.java"), "public void requireBrowserActivation()")
        self.assertIn("active.state != BootstrapStore.State.CLAIMED", application)
        self.assertIn("COORDINATOR_ACTIVATION_REVOKED", application)
