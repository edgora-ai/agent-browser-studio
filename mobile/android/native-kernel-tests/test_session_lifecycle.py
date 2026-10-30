#!/usr/bin/env python3
"""Host lifecycle contracts, not Android/Chromium/native acceptance.

Fake listeners/writers never bind TCP/UDP sockets. asyncio may create its own
wakeup socketpair. One test starts a tiny, fresh Python child, normally sends
TERM to that exact Popen handle and actually waits; no ADB/VM/browser is run.
No temporary file, database, signing material or website data is accessed.
"""
import asyncio
import importlib.util
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import unittest

SPEC = importlib.util.spec_from_file_location('owned_session_lifecycle',
                                             Path(__file__).with_name('session_lifecycle.py'))
L = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = L
SPEC.loader.exec_module(L)


class Clock:
    def __init__(self):
        self.value = 100.0

    def __call__(self):
        return self.value


class Listener:
    def __init__(self, trace):
        self.trace = trace

    def close(self):
        self.trace.append('listener-close')

    async def wait_closed(self):
        self.trace.append('listener-waited')


class Writer:
    def __init__(self, trace, release=None):
        self.trace, self.release = trace, release

    def close(self):
        self.trace.append('writer-close')

    async def wait_closed(self):
        if self.release is not None:
            await self.release.wait()
        self.trace.append('writer-waited')


class Log:
    def __init__(self, trace, flush_error=False):
        self.trace, self.flush_error = trace, flush_error
        self.closed = False

    def flush(self):
        self.trace.append('log-flush')
        if self.flush_error:
            raise OSError('private fixture sentinel')

    def close(self):
        self.trace.append('log-close')
        self.closed = True


class Child:
    def __init__(self):
        self.returncode = None

    def poll(self):
        return self.returncode


class Lifecycle(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.trace = []
        self.clock = Clock()
        self.permitted = True
        self.permit_checks = 0

    def permit(self):
        self.permit_checks += 1
        if not self.permitted:
            raise RuntimeError('private permit sentinel')

    def scope(self, **kwargs):
        return L.OwnedSession(require_runtime_permit=self.permit,
                              stop_requested=lambda: False, now=self.clock,
                              seconds=10, tick_seconds=0.001, **kwargs)

    async def prepare(self, scope):
        return object()

    async def stop_ready(self, scope, _context):
        scope.request_stop()

    async def wait_forever(self):
        await asyncio.Future()

    def assert_confirmed(self, outcome):
        self.assertEqual(outcome.cleanup, 'CONFIRMED')
        self.assertEqual((outcome.pending_tasks, outcome.unconfirmed_writers,
                          outcome.unconfirmed_children, outcome.unconfirmed_listeners,
                          outcome.unconfirmed_logs), (0, 0, 0, 0, 0))

    async def test_constructor_has_no_effect_or_permit_call(self):
        scope = self.scope()
        self.assertEqual(self.permit_checks, 0)
        self.assertIsNone(scope.outcome)
        with self.assertRaisesRegex(L.SessionError, 'not-running'):
            scope.guard()

    async def test_actual_permit_precedes_prepare(self):
        self.permitted = False
        called = []
        async def prepare(_scope):
            called.append('effect')
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertEqual(called, [])
        self.assertEqual(outcome.reason, 'permit-unavailable')
        self.assertFalse(outcome.normal_stop)
        self.assert_confirmed(outcome)
        self.assertNotIn('sentinel', repr(outcome))

    async def test_returned_boolean_is_not_a_permit(self):
        scope = L.OwnedSession(require_runtime_permit=lambda: True,
                               stop_requested=lambda: False, seconds=0.1)
        outcome = await scope.run(self.prepare, self.stop_ready)
        self.assertEqual(outcome.reason, 'permit-unavailable')

    async def test_requested_stop_is_normal_only_after_cleanup(self):
        scope = self.scope()
        outcome = await scope.run(self.prepare, self.stop_ready)
        self.assertEqual(outcome.reason, 'requested-stop')
        self.assertTrue(outcome.normal_stop)
        self.assert_confirmed(outcome)
        with self.assertRaisesRegex(L.SessionError, 'not-running'):
            scope.guard()

    async def test_scope_is_single_use(self):
        scope = self.scope()
        await scope.run(self.prepare, self.stop_ready)
        with self.assertRaisesRegex(L.SessionError, 'already-run'):
            await scope.run(self.prepare, self.stop_ready)

    async def test_prepare_is_inside_original_deadline(self):
        cancelled = asyncio.Event()
        async def prepare(_scope):
            self.clock.value = 110.0
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
        scope = self.scope()
        outcome = await scope.run(prepare, self.stop_ready)
        self.assertEqual(scope.deadline, 110.0)
        self.assertEqual(outcome.reason, 'session-deadline')
        self.assertTrue(cancelled.is_set())
        self.assertFalse(outcome.ready_completed)
        self.assert_confirmed(outcome)

    async def test_on_ready_cannot_renew_deadline(self):
        cancelled = asyncio.Event()
        async def prepare(_scope):
            self.clock.value = 109.0
            return 'context'
        async def ready(scope, context):
            self.assertEqual(context, 'context')
            self.assertEqual(scope.deadline, 110.0)
            self.clock.value = 110.0
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
        outcome = await self.scope().run(prepare, ready)
        self.assertEqual(outcome.reason, 'session-deadline')
        self.assertTrue(cancelled.is_set())
        self.assert_confirmed(outcome)

    async def test_on_ready_return_keeps_bounded_owner_alive(self):
        scope = self.scope()
        async def ready(_scope, _context):
            asyncio.get_running_loop().call_later(0.002, scope.request_stop)
        outcome = await scope.run(self.prepare, ready)
        self.assertTrue(outcome.ready_completed)
        self.assertTrue(outcome.normal_stop)

    async def test_clock_regression_rejects(self):
        async def prepare(_scope):
            self.clock.value = 99.0
            return None
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertEqual(outcome.reason, 'clock-regressed')
        self.assertFalse(outcome.normal_stop)

    async def test_nonfinite_clock_rejects(self):
        async def prepare(_scope):
            self.clock.value = float('nan')
            return None
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertEqual(outcome.reason, 'invalid-clock')

    async def test_permit_revocation_cancels_on_ready(self):
        cancelled = asyncio.Event()
        async def ready(_scope, _context):
            self.permitted = False
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
        outcome = await self.scope().run(self.prepare, ready)
        self.assertEqual(outcome.reason, 'permit-unavailable')
        self.assertTrue(cancelled.is_set())

    async def test_late_listener_is_registered_before_rejection(self):
        listener = Listener(self.trace)
        async def factory():
            self.permitted = False
            return listener
        async def prepare(scope):
            await scope.create_listener(factory)
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertEqual(outcome.reason, 'permit-unavailable')
        self.assertEqual(self.trace, ['listener-close', 'listener-waited'])
        self.assert_confirmed(outcome)

    async def test_child_is_registered_before_post_spawn_deadline(self):
        child = Child()
        def launch():
            self.clock.value = 110.0
            return child
        async def stop(handle, deadline):
            self.assertIs(handle, child)
            self.assertGreater(deadline, asyncio.get_running_loop().time())
            self.trace.append('child-waited')
            return L.ChildStopResult(-signal.SIGTERM, ())
        async def prepare(scope):
            scope.spawn_child(launch, required=True, stop=stop)
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertEqual(outcome.reason, 'session-deadline')
        self.assertEqual(self.trace, ['child-waited'])
        self.assert_confirmed(outcome)

    async def test_required_child_exit_cancels_ready(self):
        child = Child()
        async def stop(_handle, _deadline):
            return L.ChildStopResult(7, ())
        async def prepare(scope):
            scope.spawn_child(lambda: child, required=True, stop=stop)
        async def ready(_scope, _context):
            child.returncode = 7
            await asyncio.Future()
        outcome = await self.scope().run(prepare, ready)
        self.assertEqual(outcome.reason, 'required-child-exited')
        self.assertFalse(outcome.normal_stop)

    async def test_owned_client_failure_is_not_normal_stop(self):
        async def failure():
            raise RuntimeError('private client sentinel')
        async def ready(scope, _context):
            scope.create_task(failure)
            await asyncio.Future()
        outcome = await self.scope().run(self.prepare, ready)
        self.assertEqual(outcome.reason, 'owned-task-failed')
        self.assertNotIn('sentinel', repr(outcome))

    async def test_stop_racing_with_failed_client_cannot_pass(self):
        async def failure():
            raise RuntimeError('private client sentinel')
        async def ready(scope, _context):
            task = scope.create_task(failure)
            await asyncio.wait({task})
            scope.request_stop()
        outcome = await self.scope().run(self.prepare, ready)
        self.assertEqual(outcome.reason, 'owned-task-failed')
        self.assertFalse(outcome.normal_stop)

    async def test_cleanup_order_is_accept_clients_writers_children_logs(self):
        scope = self.scope()
        client_started, relay_started = asyncio.Event(), asyncio.Event()
        async def client():
            client_started.set()
            try:
                await asyncio.Future()
            finally:
                self.trace.append('client-cancelled')
        async def relay():
            relay_started.set()
            try:
                await asyncio.Future()
            finally:
                self.trace.append('relay-cancelled')
        async def stop(_handle, _deadline):
            self.trace.extend(('child-term', 'child-actual-wait'))
            return L.ChildStopResult(-signal.SIGTERM, ())
        async def listener():
            return Listener(self.trace)
        async def prepare(owner):
            await owner.create_listener(listener)
            owner.open_log(lambda: Log(self.trace))
            owner.spawn_child(Child, required=True, stop=stop)
            owner.own_writer(Writer(self.trace))
            owner.create_task(client)
            owner.create_task(relay)
            await client_started.wait()
            await relay_started.wait()
        outcome = await scope.run(prepare, self.stop_ready)
        self.assert_confirmed(outcome)
        self.assertLess(self.trace.index('listener-close'), self.trace.index('client-cancelled'))
        for marker in ('client-cancelled', 'relay-cancelled', 'listener-waited', 'writer-waited'):
            self.assertLess(self.trace.index(marker), self.trace.index('child-term'))
        self.assertLess(self.trace.index('child-actual-wait'), self.trace.index('log-flush'))
        self.assertLess(self.trace.index('log-flush'), self.trace.index('log-close'))

    async def test_child_term_without_wait_is_unconfirmed(self):
        async def stop(_handle, _deadline):
            return L.ChildStopResult(None, ())
        async def prepare(scope):
            scope.spawn_child(Child, required=True, stop=stop)
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertEqual(outcome.unconfirmed_children, 1)
        self.assertEqual(outcome.cleanup, 'UNCONFIRMED')
        self.assertFalse(outcome.normal_stop)

    async def test_remaining_owned_group_is_unconfirmed(self):
        async def stop(_handle, _deadline):
            return L.ChildStopResult(0, (123,))
        async def prepare(scope):
            scope.spawn_child(Child, required=True, stop=stop)
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertEqual(outcome.unconfirmed_children, 1)
        self.assertFalse(outcome.normal_stop)

    async def test_sync_stop_callback_failure_does_not_abandon_logs(self):
        stream = Log(self.trace)
        def stop(_handle, _deadline):
            raise OSError('private child sentinel')
        async def prepare(scope):
            scope.open_log(lambda: stream)
            scope.spawn_child(Child, required=True, stop=stop)
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertEqual(outcome.unconfirmed_children, 1)
        self.assertTrue(stream.closed)
        self.assertFalse(outcome.normal_stop)

    async def test_sync_listener_wait_failure_does_not_abandon_children(self):
        class Broken(Listener):
            def wait_closed(self):
                raise OSError('private listener sentinel')
        async def listener():
            return Broken(self.trace)
        async def stop(_handle, _deadline):
            self.trace.append('child-waited')
            return L.ChildStopResult(0, ())
        async def prepare(scope):
            await scope.create_listener(listener)
            scope.spawn_child(Child, required=True, stop=stop)
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertGreater(outcome.unconfirmed_listeners, 0)
        self.assertIn('child-waited', self.trace)
        self.assertFalse(outcome.normal_stop)

    async def test_flush_failure_still_attempts_log_close(self):
        stream = Log(self.trace, flush_error=True)
        async def prepare(scope):
            scope.open_log(lambda: stream)
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertTrue(stream.closed)
        self.assertEqual(outcome.unconfirmed_logs, 1)
        self.assertFalse(outcome.normal_stop)

    async def test_external_cancel_waits_for_cleanup_and_propagates(self):
        started, stopped = asyncio.Event(), asyncio.Event()
        async def stop(_handle, _deadline):
            await asyncio.sleep(0)
            stopped.set()
            return L.ChildStopResult(-signal.SIGTERM, ())
        async def prepare(scope):
            scope.spawn_child(Child, required=True, stop=stop)
            started.set()
            await asyncio.Future()
        scope = self.scope()
        task = asyncio.create_task(scope.run(prepare, self.stop_ready))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(stopped.is_set())
        self.assertEqual(scope.outcome.reason, 'external-cancellation')
        self.assert_confirmed(scope.outcome)

    async def test_repeated_cancellation_cannot_abandon_child_wait(self):
        started, waiting, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def stop(_handle, _deadline):
            waiting.set()
            await release.wait()
            self.trace.append('child-actual-wait')
            return L.ChildStopResult(-signal.SIGTERM, ())
        async def prepare(scope):
            scope.spawn_child(Child, required=True, stop=stop)
            started.set()
            await asyncio.Future()
        scope = self.scope()
        task = asyncio.create_task(scope.run(prepare, self.stop_ready))
        await started.wait()
        task.cancel()
        await waiting.wait()
        task.cancel()
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertIn('child-actual-wait', self.trace)
        self.assert_confirmed(scope.outcome)

    async def test_cancel_suppressing_child_wait_cannot_extend_cleanup(self):
        release = asyncio.Event()
        async def stop(_handle, _deadline):
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()
            return L.ChildStopResult(0, ())
        async def prepare(scope):
            scope.spawn_child(Child, required=True, stop=stop)
        scope = self.scope(cleanup_seconds=0.02)
        try:
            async with asyncio.timeout(0.3):
                outcome = await scope.run(prepare, self.stop_ready)
            self.assertEqual(outcome.unconfirmed_children, 1)
            self.assertGreater(outcome.pending_tasks, 0)
            self.assertFalse(outcome.normal_stop)
        finally:
            release.set()
            await asyncio.gather(*scope._cleanup_tasks, return_exceptions=True)

    async def test_task_limit_rejects_before_creating_coroutine(self):
        called = []
        async def ready(scope, _context):
            for _ in range(L.MAX_TASKS):
                scope.create_task(self.wait_forever)
            with self.assertRaisesRegex(L.SessionError, 'resource-bound'):
                scope.create_task(lambda: called.append('not-a-coroutine'))
            scope.request_stop()
        outcome = await self.scope().run(self.prepare, ready)
        self.assertEqual(called, [])
        self.assert_confirmed(outcome)

    async def test_listener_limit_rejects_before_effect(self):
        called = []
        async def listener():
            called.append('new-listener')
            return Listener(self.trace)
        async def prepare(scope):
            for _ in range(L.MAX_LISTENERS):
                await scope.create_listener(listener)
            with self.assertRaisesRegex(L.SessionError, 'resource-bound'):
                await scope.create_listener(listener)
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertEqual(len(called), L.MAX_LISTENERS)
        self.assert_confirmed(outcome)

    async def test_writer_is_removed_only_after_actual_close_await(self):
        async def prepare(scope):
            writer = scope.own_writer(Writer(self.trace))
            self.assertIn(writer, scope._writers)
            await scope.close_writer(writer)
            self.assertNotIn(writer, scope._writers)
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertEqual(self.trace, ['writer-close', 'writer-waited'])
        self.assert_confirmed(outcome)

    async def test_unexpected_exception_is_fixed_failure_not_raw_text(self):
        async def ready(_scope, _context):
            raise RuntimeError('PRIVATE_REQUEST_AND_CREDENTIAL_SENTINEL')
        outcome = await self.scope().run(self.prepare, ready)
        self.assertEqual(outcome.reason, 'session-failed')
        self.assertNotIn('PRIVATE', repr(outcome))
        self.assertFalse(outcome.normal_stop)

    async def test_cleanup_expiry_does_not_start_late_child_stop(self):
        release = asyncio.Event()
        async def stalled(_handle, _deadline):
            self.trace.append('stalled-stop-started')
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()
            return L.ChildStopResult(0, ())
        async def late(_handle, _deadline):
            self.trace.append('late-stop-started')
            return L.ChildStopResult(0, ())
        async def prepare(scope):
            scope.spawn_child(Child, required=True, stop=late)
            scope.spawn_child(Child, required=True, stop=stalled)
        scope = self.scope(cleanup_seconds=0.02)
        try:
            outcome = await scope.run(prepare, self.stop_ready)
            self.assertNotIn('late-stop-started', self.trace)
            self.assertEqual(outcome.unconfirmed_children, 2)
            self.assertFalse(outcome.normal_stop)
        finally:
            release.set()
            await asyncio.gather(*scope._cleanup_tasks, return_exceptions=True)

    async def test_stop_does_not_hide_already_exited_required_child(self):
        child = Child()
        async def stop(_handle, _deadline):
            return L.ChildStopResult(7, ())
        async def prepare(scope):
            scope.spawn_child(lambda: child, required=True, stop=stop)
        async def ready(scope, _context):
            child.returncode = 7
            scope.request_stop()
        outcome = await self.scope().run(prepare, ready)
        self.assertEqual(outcome.reason, 'required-child-exited')
        self.assertFalse(outcome.normal_stop)

    async def test_writer_rejected_after_stop_is_closed_and_not_certified(self):
        writer = Writer(self.trace)
        async def ready(scope, _context):
            scope.request_stop()
            with self.assertRaisesRegex(L.SessionError, 'requested-stop'):
                scope.own_writer(writer)
        outcome = await self.scope().run(self.prepare, ready)
        self.assertIn('writer-close', self.trace)
        self.assertEqual(outcome.cleanup, 'UNCONFIRMED')
        self.assertGreater(outcome.unconfirmed_writers, 0)
        self.assertFalse(outcome.normal_stop)

    async def test_log_limit_refuses_before_open(self):
        called = []
        async def prepare(scope):
            for _ in range(L.MAX_LOGS):
                scope.open_log(lambda: Log(self.trace))
            with self.assertRaisesRegex(L.SessionError, 'resource-bound'):
                scope.open_log(lambda: called.append('effect'))
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertEqual(called, [])
        self.assert_confirmed(outcome)

    async def test_child_limit_refuses_before_spawn(self):
        called = []
        async def stop(_handle, _deadline):
            return L.ChildStopResult(-signal.SIGTERM, ())
        async def prepare(scope):
            for _ in range(L.MAX_CHILDREN):
                scope.spawn_child(Child, required=True, stop=stop)
            with self.assertRaisesRegex(L.SessionError, 'resource-bound'):
                scope.spawn_child(lambda: called.append('effect'), required=True, stop=stop)
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertEqual(called, [])
        self.assert_confirmed(outcome)

    async def test_cleanup_await_failure_remains_unconfirmed(self):
        class Broken(Writer):
            async def wait_closed(self):
                raise OSError('private writer sentinel')
        async def prepare(scope):
            scope.own_writer(Broken(self.trace))
        outcome = await self.scope().run(prepare, self.stop_ready)
        self.assertEqual(outcome.unconfirmed_writers, 1)
        self.assertFalse(outcome.normal_stop)

    async def test_ready_cleanup_exception_is_not_normal_stop(self):
        async def ready(scope, _context):
            scope.request_stop()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                raise OSError('private cancelled-ready sentinel') from None
        outcome = await self.scope().run(self.prepare, ready)
        self.assertEqual(outcome.reason, 'session-failed')
        self.assertFalse(outcome.normal_stop)
        self.assertNotIn('sentinel', repr(outcome))

    async def test_one_new_real_child_term_and_actual_wait(self):
        child = None
        async def stop(handle, _deadline):
            # This test child has no descendants; do not signal any unknown PID
            # or process group. Popen.poll/wait retains the exact parent handle.
            if handle.poll() is None:
                handle.terminate()
            code = await asyncio.to_thread(handle.wait, 2)
            self.trace.append(('actual-wait', code))
            return L.ChildStopResult(code, ())
        def launch():
            nonlocal child
            child = subprocess.Popen([sys.executable, '-I', '-B', '-c',
                                      'import signal; signal.pause()'],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, start_new_session=True,
                                     env={'PATH': os.defpath, 'PYTHONDONTWRITEBYTECODE': '1'})
            return child
        async def prepare(scope):
            scope.spawn_child(launch, required=True, stop=stop)
        try:
            outcome = await self.scope().run(prepare, self.stop_ready)
            self.assert_confirmed(outcome)
            self.assertEqual(self.trace, [('actual-wait', -signal.SIGTERM)])
            self.assertEqual(child.returncode, -signal.SIGTERM)
        finally:
            if child is not None:
                if child.poll() is None:
                    child.terminate()
                child.wait(timeout=2)


class Durations(unittest.TestCase):
    def test_invalid_session_durations(self):
        for value in (True, 0, -1, 3000.01, float('nan'), float('inf'), '3000'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                L.OwnedSession(require_runtime_permit=lambda: None,
                               stop_requested=lambda: False, seconds=value)

    def test_invalid_cleanup_durations(self):
        for value in (True, 0, -1, 45.01, float('nan'), float('inf')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                L.OwnedSession(require_runtime_permit=lambda: None,
                               stop_requested=lambda: False, cleanup_seconds=value)

    def test_child_stop_cannot_use_boolean_as_wait(self):
        self.assertFalse(L.ChildStopResult(True, ()).confirmed())
        self.assertFalse(L.ChildStopResult(None, ()).confirmed())
        self.assertFalse(L.ChildStopResult(0, []).confirmed())
        self.assertTrue(L.ChildStopResult(-signal.SIGTERM, ()).confirmed())


if __name__ == '__main__':
    unittest.main(verbosity=2)
